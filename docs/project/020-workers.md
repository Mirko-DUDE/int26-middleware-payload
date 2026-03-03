# 020 — Architettura dei Worker

> **Sottofase A / Task A2** — Contratto tecnico riutilizzabile per tutti i worker del sistema.  
> Ogni worker futuro (assenze, fatture, sincronizzazioni) **deve** rispettare questo pattern senza eccezioni.

---

## 1. Cos'è un Worker

Un worker è una funzione TypeScript asincrona invocata da **Google Cloud Tasks** via HTTP POST su un endpoint interno protetto. Non risponde a utenti finali: risponde solo alla coda.

Il suo unico compito è:

1. Ricevere un payload strutturato dalla coda.
2. Eseguire una singola unità di lavoro (es. aggiornare un'assenza su Furious, creare un acquisto).
3. Aggiornare il log del task nel DB ad ogni transizione di stato.
4. Restituire il codice HTTP corretto affinché Cloud Tasks sappia se rischedulare o abbandonare.

---

## 2. Interfaccia Standard

Ogni worker espone un **endpoint HTTP** e internamente chiama una **funzione worker tipizzata**.

### 2.1 Tipi TypeScript condivisi

```typescript
// src/workers/types.ts

/** Stati possibili di un task nel suo ciclo di vita */
export type TaskStatus =
  | 'received'      // webhook ricevuto, record DB creato
  | 'queued'        // accodato su Cloud Tasks
  | 'processing'    // worker ha iniziato l'elaborazione
  | 'completed'     // elaborazione terminata con successo
  | 'failed'        // errore non-retriable, non si riprova
  | 'dead'          // esauriti tutti i tentativi (dead letter)

/** Payload che Cloud Tasks invia al worker via POST body */
export interface WorkerTaskPayload {
  taskId: string          // ID del record nella collection TaskLogs di Payload
  taskType: string        // es. 'absence-approval', 'invoice-sync'
  attempt: number         // numero di tentativo corrente (1-based)
  enqueuedAt: string      // ISO 8601 — quando è stato accodato
  data: Record<string, unknown>  // payload specifico del task
}

/** Risultato restituito dalla funzione worker */
export interface WorkerResult {
  success: boolean
  message: string
  externalId?: string     // ID creato/aggiornato nel sistema esterno (es. Furious)
  retriable: boolean      // se false → rispondere 200 anche in caso di errore
}

/** Contesto iniettato nel worker (payload + utilità) */
export interface WorkerContext {
  payload: WorkerTaskPayload
  logger: WorkerLogger
}

/** Firma standard di qualsiasi funzione worker */
export type WorkerFn = (ctx: WorkerContext) => Promise<WorkerResult>
```

### 2.2 Struttura dell'endpoint HTTP

```typescript
// src/endpoints/workers/[taskType].ts  (esempio)

import type { PayloadHandler } from 'payload/types'
import { verifyCloudTasksRequest } from '@/lib/cloudTasks'
import { runWorker } from '@/workers/runner'
import { absenceApprovalWorker } from '@/workers/absenceApproval'

export const absenceWorkerHandler: PayloadHandler = async (req, res) => {
  // 1. Verifica OIDC token di Cloud Tasks (middleware)
  const authError = await verifyCloudTasksRequest(req)
  if (authError) return res.status(403).json({ error: authError })

  // 2. Delega al runner generico
  return runWorker(req, res, absenceApprovalWorker)
}
```

---

## 3. Runner Generico

Il runner è il collante tra l'endpoint HTTP e la funzione worker. Gestisce ciclo di vita, logging e risposta HTTP in modo uniforme per tutti i worker.

```typescript
// src/workers/runner.ts

import type { Request, Response } from 'express'
import type { WorkerFn, WorkerTaskPayload } from './types'
import { updateTaskStatus } from '@/lib/taskLogs'
import { createWorkerLogger } from '@/lib/logger'

export async function runWorker(
  req: Request,
  res: Response,
  workerFn: WorkerFn
): Promise<void> {
  let taskPayload: WorkerTaskPayload | undefined

  try {
    taskPayload = req.body as WorkerTaskPayload
    const logger = createWorkerLogger(taskPayload.taskType, taskPayload.taskId)

    // Transizione → processing
    await updateTaskStatus(taskPayload.taskId, 'processing', {
      attempt: taskPayload.attempt,
      startedAt: new Date().toISOString(),
    })
    logger.info('worker_started', { attempt: taskPayload.attempt })

    const result = await workerFn({ payload: taskPayload, logger })

    if (result.success) {
      // Transizione → completed
      await updateTaskStatus(taskPayload.taskId, 'completed', {
        message: result.message,
        externalId: result.externalId,
        completedAt: new Date().toISOString(),
      })
      logger.info('worker_completed', { externalId: result.externalId })
      res.status(200).json({ ok: true })
    } else if (!result.retriable) {
      // Errore definitivo: non rischedulare
      await updateTaskStatus(taskPayload.taskId, 'failed', {
        message: result.message,
        failedAt: new Date().toISOString(),
      })
      logger.warn('worker_failed_non_retriable', { message: result.message })
      res.status(200).json({ ok: false, reason: result.message }) // 200 per bloccare retry
    } else {
      // Errore retriable: Cloud Tasks rischedulerà
      await updateTaskStatus(taskPayload.taskId, 'processing', {
        lastError: result.message,
        attempt: taskPayload.attempt,
      })
      logger.warn('worker_failed_retriable', { message: result.message })
      res.status(500).json({ error: result.message })
    }
  } catch (err: unknown) {
    const error = err instanceof Error ? err : new Error(String(err))

    if (taskPayload) {
      const isDead = taskPayload.attempt >= 5
      await updateTaskStatus(taskPayload.taskId, isDead ? 'dead' : 'processing', {
        lastError: error.message,
        stack: error.stack,
      })
    }

    // 5xx → Cloud Tasks rischedulerà con backoff
    res.status(500).json({ error: error.message })
  }
}
```

---

## 4. Ciclo di Vita del Task

Ogni task percorre questi stati, aggiornati nel DB ad ogni transizione:

```
received → queued → processing → completed
                              ↘ failed        (non-retriable, definitivo)
                              ↘ processing    (retriable, ritenta)
                                    ↘ dead    (dopo 5 tentativi)
```

### Backoff dei tentativi (configurato su Cloud Tasks)

| Tentativo | Attesa prima del retry |
|-----------|------------------------|
| 1 → 2     | 30 secondi             |
| 2 → 3     | 2 minuti               |
| 3 → 4     | 8 minuti               |
| 4 → 5     | 30 minuti              |
| 5 → dead  | 1 ora (poi abbandona)  |

Il moltiplicatore è ×4. Questi valori sono configurati **sulla coda Cloud Tasks**, non nel codice del worker.

---

## 5. Pattern `getToken()` — Autenticazione verso Sistemi Esterni

Tutti i token API (Furious, Starty, futuri) seguono lo stesso pattern: lettura da **Google Secret Manager**, cache in memoria con TTL, rinnovo automatico su risposta `401`.

> **Regola assoluta:** nessun token viene mai letto da variabili d'ambiente. L'unica sorgente autorizzata è Secret Manager.

```typescript
// src/lib/tokenManager.ts

import { SecretManagerServiceClient } from '@google-cloud/secret-manager'

interface TokenCache {
  value: string
  fetchedAt: number
  ttlMs: number
}

const cache = new Map<string, TokenCache>()
const client = new SecretManagerServiceClient()

/**
 * Legge un token da Secret Manager con cache in memoria.
 * @param secretName  Nome del secret (es. 'furious-api-token')
 * @param ttlMs       TTL della cache in ms (default: 55 minuti)
 */
export async function getToken(
  secretName: string,
  ttlMs = 55 * 60 * 1000
): Promise<string> {
  const cached = cache.get(secretName)
  const now = Date.now()

  if (cached && now - cached.fetchedAt < cached.ttlMs) {
    return cached.value
  }

  // Cache miss o scaduta: leggi da Secret Manager
  const [version] = await client.accessSecretVersion({
    name: `projects/${process.env.GCP_PROJECT_ID}/secrets/${secretName}/versions/latest`,
  })

  const token = version.payload?.data?.toString()
  if (!token) throw new Error(`Secret "${secretName}" vuoto o non trovato`)

  cache.set(secretName, { value: token, fetchedAt: now, ttlMs })
  return token
}

/** Invalida la cache per forzare un nuovo fetch (usato dopo 401) */
export function invalidateToken(secretName: string): void {
  cache.delete(secretName)
}
```

### Uso nei worker — wrapper con auto-retry su 401

```typescript
// src/lib/apiClient.ts

import { getToken, invalidateToken } from './tokenManager'

export async function callWithToken<T>(
  secretName: string,
  fn: (token: string) => Promise<Response>
): Promise<T> {
  let token = await getToken(secretName)
  let response = await fn(token)

  if (response.status === 401) {
    // Token scaduto: invalida cache e riprova una sola volta
    invalidateToken(secretName)
    token = await getToken(secretName)
    response = await fn(token)
  }

  if (!response.ok) {
    const body = await response.text()
    throw new Error(`API error ${response.status}: ${body}`)
  }

  return response.json() as Promise<T>
}
```

**Esempio d'uso in un worker Furious:**

```typescript
const result = await callWithToken<FuriousResponse>(
  'furious-api-token',
  (token) =>
    fetch('https://dude.furious-squad.com/api/v2/absence/', {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'F-Auth-Token': token,
      },
      body: JSON.stringify({ action: 'update', data: { id, status: 1 } }),
    })
)
```

---

## 6. Logging Strutturato

Il sistema usa **due livelli di log** con responsabilità distinte.

### 6.1 Log di sistema (Pino → Cloud Logging)

Ogni worker riceve nel contesto un `logger` già configurato con `taskId` e `taskType` come campi fissi.

```typescript
// src/lib/logger.ts

import pino from 'pino'

const base = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  formatters: {
    level: (label) => ({ severity: label.toUpperCase() }), // Cloud Logging usa "severity"
  },
})

export interface WorkerLogger {
  info(event: string, data?: Record<string, unknown>): void
  warn(event: string, data?: Record<string, unknown>): void
  error(event: string, data?: Record<string, unknown>): void
}

export function createWorkerLogger(taskType: string, taskId: string): WorkerLogger {
  const child = base.child({ taskType, taskId, service: 'worker' })
  return {
    info: (event, data) => child.info({ event, ...data }),
    warn: (event, data) => child.warn({ event, ...data }),
    error: (event, data) => child.error({ event, ...data }),
  }
}
```

### 6.2 Cosa loggare e a quale livello

| Livello | Evento | Campi obbligatori |
|---------|--------|-------------------|
| `info`  | `worker_started` | `taskId`, `taskType`, `attempt` |
| `info`  | `worker_completed` | `taskId`, `externalId`, `durationMs` |
| `warn`  | `worker_failed_retriable` | `taskId`, `attempt`, `message` |
| `warn`  | `worker_failed_non_retriable` | `taskId`, `message`, `reason` |
| `error` | `worker_dead` | `taskId`, `totalAttempts`, `lastError` |
| `error` | `token_fetch_error` | `secretName`, `message` |
| `info`  | `external_api_called` | `endpoint`, `method`, `statusCode` |

### 6.3 Log di business (PostgreSQL via Payload)

La collection `TaskLogs` tiene traccia degli eventi leggibili dagli operatori. Non duplicare qui i log tecnici: solo eventi significativi per HR o Amministrazione.

Esempio di record:
```json
{
  "taskId": "abc123",
  "taskType": "absence-approval",
  "status": "completed",
  "attempt": 2,
  "message": "Assenza #4521 approvata su Furious",
  "externalId": "4521",
  "createdAt": "2026-03-03T09:00:00Z",
  "updatedAt": "2026-03-03T09:00:45Z"
}
```

---

## 7. Gestione degli Errori

### 7.1 Distinzione retriable vs non-retriable

| Tipo di errore | Retriable | Esempio |
|----------------|-----------|---------|
| Timeout di rete | ✅ Sì | Furious non risponde |
| HTTP 5xx da sistema esterno | ✅ Sì | Furious in manutenzione |
| HTTP 429 (rate limit) | ✅ Sì | Troppi accessi API |
| HTTP 401 dopo rinnovo token | ✅ Sì (una volta) | Token revocato, Secret aggiornato |
| HTTP 404 (risorsa non trovata) | ❌ No | Absence ID inesistente |
| HTTP 400 (payload malformato) | ❌ No | Dati webhook corrotti |
| Errore di validazione locale | ❌ No | Campo obbligatorio mancante |
| Mapping ID non trovato | ❌ No | Progetto non in tabella transcodifica |

### 7.2 Come il worker comunica l'esito a Cloud Tasks

Il codice HTTP di risposta è il **segnale di controllo** per Cloud Tasks:

```
HTTP 200  →  "Ho finito, non richiamarmi"
             (sia successo che errore non-retriable)

HTTP 5xx  →  "Qualcosa è andato storto, riprova dopo il backoff"
             (errori retriable, eccezioni non catturate)
```

> **Attenzione:** restituire `4xx` è equivalente a `200` per Cloud Tasks — la coda lo considera completato. Usare sempre `5xx` per i retry.

### 7.3 Dead Letter Queue

Dopo 5 tentativi falliti, Cloud Tasks non rischedulerà più il task. Il sistema deve:

1. Rilevare che `attempt >= 5` (il campo `X-CloudTasks-TaskRetryCount` nell'header vale `4` al quinto tentativo, è 0-based).
2. Aggiornare lo stato del task a `dead` nel DB.
3. Loggare l'evento `worker_dead` a livello `error`.
4. Il task rimane visibile nella UI di Payload per intervento manuale.

```typescript
// Lettura del retry count dall'header Cloud Tasks
const retryCount = parseInt(req.headers['x-cloudtasks-taskretrycount'] as string ?? '0', 10)
const attempt = retryCount + 1 // converti in 1-based
```

---

## 8. Risposta a Cloud Tasks — Riepilogo

```typescript
// Pattern decisionale finale nel runner

if (success) {
  res.status(200).json({ ok: true })           // ✅ Completato

} else if (!retriable) {
  res.status(200).json({ ok: false, reason })  // ⛔ Fallito definitivo, non riprovare

} else {
  res.status(500).json({ error: message })     // 🔄 Errore transitorio, riprova con backoff
}
```

---

## 9. Protezione dell'Endpoint Worker

Gli endpoint worker devono essere raggiungibili **solo da Cloud Tasks**, non da internet.

```typescript
// src/lib/cloudTasks.ts

import { OAuth2Client } from 'google-auth-library'

const oauthClient = new OAuth2Client()

export async function verifyCloudTasksRequest(req: Request): Promise<string | null> {
  const authHeader = req.headers.authorization
  if (!authHeader?.startsWith('Bearer ')) return 'Missing auth header'

  const token = authHeader.slice(7)
  try {
    const ticket = await oauthClient.verifyIdToken({
      idToken: token,
      audience: process.env.WORKER_AUDIENCE_URL, // URL pubblico del worker
    })
    const payload = ticket.getPayload()
    if (payload?.email !== process.env.CLOUD_TASKS_SERVICE_ACCOUNT) {
      return 'Unauthorized service account'
    }
    return null // OK
  } catch {
    return 'Invalid OIDC token'
  }
}
```

---

## 10. Checklist per Implementare un Nuovo Worker

Prima di scrivere la prima riga di logica di business, verificare:

- [ ] La funzione rispetta la firma `WorkerFn`
- [ ] Usa `ctx.logger` per tutti i log (mai `console.log` diretti)
- [ ] Legge i token tramite `getToken()` / `callWithToken()`
- [ ] Distingue esplicitamente errori retriable da non-retriable nel `WorkerResult`
- [ ] Aggiorna lo stato del task via `updateTaskStatus()` nelle transizioni chiave
- [ ] L'endpoint chiama `verifyCloudTasksRequest()` prima di tutto il resto
- [ ] Il codice HTTP di risposta segue il contratto della sezione 8
