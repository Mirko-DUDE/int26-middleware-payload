# 040 — Sistema di Logging e Osservabilità

> **Fase:** Sottofase A — Fondamenta  
> **Stato:** ✅ Completato  
> **Autore:** Architettura di sistema  

---

## 1. Visione d'insieme

Il sistema adotta una **strategia di logging a due livelli** con responsabilità nettamente separate:

- **Livello 1 — Business Audit Log** su PostgreSQL: traccia ogni evento significativo per il business, visibile agli operatori dall'interfaccia PayloadCMS.
- **Livello 2 — System & Error Logs** su Google Cloud Logging + Sentry: cattura metriche tecniche, log di sistema e crash del codice. Non risiede mai su Postgres.

Questa separazione garantisce che il database operativo non venga intasato da log tecnici di basso livello, e che gli operatori HR/Amministrazione vedano solo informazioni rilevanti per loro.

---

## 2. Livello 1 — Business Audit Log su PostgreSQL

### 2.1 Scopo

Il business audit log è il "registro di bordo" di ogni operazione processata dal middleware. Ogni record rappresenta un webhook ricevuto o un'operazione avviata, con il suo stato corrente e la sua storia di elaborazione.

Gli operatori possono vedere da PayloadCMS:
- Se una richiesta di assenza è stata ricevuta, è in elaborazione o ha fallito.
- Quanti tentativi sono stati effettuati e qual è stato l'ultimo errore.
- Quando l'operazione è stata completata con successo.

### 2.2 Collection PayloadCMS: `webhook-logs`

La collection `webhook-logs` in PayloadCMS rappresenta il log di audit principale.

**Campi obbligatori:**

| Campo | Tipo | Descrizione |
|---|---|---|
| `id` | UUID | Identificatore univoco del log (generato da Payload) |
| `collection` | `enum` | La collection di business coinvolta: `absence-requests` \| `invoice-syncs` |
| `furiousId` | `string` | ID dell'entità su Furious (es. ID dell'assenza) |
| `startyId` | `string` | ID dell'entità nel gestionale Starty (quando applicabile) |
| `status` | `enum` | Stato corrente: `received` \| `queued` \| `processing` \| `completed` \| `failed` \| `dead-letter` |
| `rawPayload` | `jsonb` | Il payload grezzo del webhook originale (solo per Livello 1 — mai su Cloud Logging) |
| `attempts` | `integer` | Numero di tentativi di elaborazione effettuati (default: 0) |
| `lastError` | `text` | Messaggio dell'ultimo errore (null se nessun errore) |
| `processedAt` | `timestamp` | Timestamp di completamento con successo (null finché non completato) |
| `createdAt` | `timestamp` | Timestamp di creazione (gestito da Payload) |
| `updatedAt` | `timestamp` | Timestamp ultimo aggiornamento (gestito da Payload) |

**Campi opzionali ma raccomandati:**

| Campo | Tipo | Descrizione |
|---|---|---|
| `taskId` | `string` | ID del task su Google Cloud Tasks (per correlazione) |
| `errorHistory` | `jsonb` | Array degli errori precedenti `[{attempt, error, timestamp}]` |
| `workerDurationMs` | `integer` | Durata in ms dell'ultima elaborazione del worker |

### 2.3 Valori validi per `status`

```
received     → webhook ricevuto dall'endpoint, non ancora accodato
queued       → task inviato a Cloud Tasks con successo
processing   → worker sta elaborando il task (Cloud Tasks ha chiamato il worker)
completed    → operazione terminata con successo, processedAt valorizzato
failed       → tentativo fallito, verrà ritentato se attempts < maxAttempts
dead-letter  → tentativi esauriti, richiede intervento manuale
```

### 2.4 Retention Policy

- **Hot data (0–90 giorni):** tutti i record, nessun limite.
- **Warm data (91–365 giorni):** i record con `status = completed` vengono archiviati (colonna `archivedAt` valorizzata, esclusi dalle query default).
- **Cold data (> 365 giorni):** i record completati possono essere eliminati con job schedulato mensile. I record `dead-letter` vengono conservati **indefinitamente** per audit.
- Il campo `rawPayload` (JSONB) viene svuotato (`null`) dopo 90 giorni per ridurre l'occupazione su disco, conservando solo i metadati.

---

## 3. Livello 2 — System Logs su Google Cloud Logging

### 3.1 Cosa va su Cloud Logging

Cloud Logging cattura automaticamente tutto ciò che l'applicazione scrive su `stdout`/`stderr` in formato JSON strutturato. Non richiedere configurazione aggiuntiva su Cloud Run.

**Va su Cloud Logging:**
- Avvio/spegnimento dei worker
- Ogni step di elaborazione (con timing)
- Richieste HTTP in ingresso e uscita (senza body)
- Metriche operative (tentativi, latenze)
- Warning su comportamenti anomali non bloccanti

**Non va mai su Cloud Logging:**
- `rawPayload` dei webhook (contiene dati personali)
- Token, password, chiavi API
- Indirizzi email o dati anagrafici
- Dettagli finanziari identificativi

### 3.2 Libreria: Pino

Tutto il logging strutturato usa **Pino** (`pino`), che produce JSON compatibile con Google Cloud Logging.

**Configurazione base (`src/lib/logger.ts`):**

```typescript
import pino from 'pino'

export const logger = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  // In Cloud Run, non serve transport — stdout viene catturato da GCL
  ...(process.env.NODE_ENV === 'development' && {
    transport: {
      target: 'pino-pretty',
      options: { colorize: true },
    },
  }),
})
```

### 3.3 Campi obbligatori in ogni log entry

Ogni chiamata a `logger.info/warn/error` deve includere questi campi nel primo argomento (oggetto contesto):

```typescript
// OBBLIGATORI in ogni log entry
{
  taskId: string,       // ID Cloud Tasks o UUID generato localmente
  collection: string,   // 'absence-requests' | 'invoice-syncs'
  furiousId?: string,   // ID entità Furious (quando disponibile)
  startyId?: string,    // ID entità Starty (quando disponibile)
  attempt: number,      // numero tentativo corrente (1-based)
}
```

**Esempio corretto:**
```typescript
logger.info(
  { taskId, collection: 'absence-requests', furiousId: absence.id, attempt: 1 },
  'Worker avviato: elaborazione assenza'
)
```

**Esempio sbagliato (da evitare):**
```typescript
// ❌ Mancano i campi obbligatori
logger.info('Worker avviato')

// ❌ Non loggare payload completi
logger.info({ payload: req.body }, 'Webhook ricevuto')

// ❌ Non loggare dati sensibili
logger.info({ token: apiToken, email: user.email }, 'Auth')
```

### 3.4 Livelli di log

| Livello | Quando usarlo |
|---|---|
| `info` | Flusso normale: webhook ricevuto, task accodato, step completati, operazione riuscita |
| `warn` | Comportamento anomalo non bloccante: retry in corso, risposta API lenta, dati mancanti non critici |
| `error` | Errore che ha impedito il completamento: eccezione non gestita, API non raggiungibile, schema non valido |

---

## 4. Integrazione Sentry

### 4.1 Dove installare l'SDK

Sentry va installato nell'entry point principale dell'applicazione PayloadCMS, **prima** di qualsiasi altro middleware.

```bash
npm install @sentry/node
```

**`src/sentry.ts`** (da importare come primo import in `src/server.ts`):

```typescript
import * as Sentry from '@sentry/node'

Sentry.init({
  dsn: process.env.SENTRY_DSN,
  environment: process.env.NODE_ENV, // 'staging' | 'production'
  // Cattura il 100% degli errori, campiona il 10% delle transazioni (performance)
  tracesSampleRate: process.env.NODE_ENV === 'production' ? 0.1 : 1.0,
  // Non inviare a Sentry in sviluppo locale
  enabled: process.env.NODE_ENV !== 'development',
})
```

### 4.2 Cosa cattura automaticamente

Con `@sentry/node` inizializzato, Sentry cattura automaticamente:
- Eccezioni non gestite (uncaught exceptions)
- Promise rejection non gestite
- Errori HTTP Express/Next.js con stack trace completo
- Breadcrumb delle richieste HTTP effettuate (esclusi header sensibili)

### 4.3 Aggiungere contesto nei worker

Nei worker asincroni, aggiungere sempre il contesto di Sentry per correlare l'errore al task:

```typescript
import * as Sentry from '@sentry/node'

export async function processAbsenceWorker(taskPayload: AbsenceTaskPayload) {
  // Imposta il contesto per tutti gli errori in questo scope
  Sentry.setContext('task', {
    taskId: taskPayload.taskId,
    collection: 'absence-requests',
    furiousId: taskPayload.absenceId,
    attempt: taskPayload.attempt,
  })

  try {
    // ... logica del worker
  } catch (error) {
    // Cattura manualmente con contesto aggiuntivo
    Sentry.captureException(error, {
      tags: {
        collection: 'absence-requests',
        furiousId: taskPayload.absenceId,
      },
    })
    throw error // rilancia sempre per il retry di Cloud Tasks
  }
}
```

### 4.4 Configurazione ambienti

**Staging:**
- `SENTRY_DSN` valorizzato con il DSN del progetto
- `NODE_ENV=staging`
- Tutti gli errori inviati, nessun filtro
- Alert via email agli sviluppatori

**Produzione:**
- Stesso `SENTRY_DSN` (Sentry usa `environment` per separare)
- `NODE_ENV=production`
- Alert con soglie: >5 errori unici in 1h → Slack + email
- `tracesSampleRate: 0.1` per contenere i costi di performance monitoring

**Non configurare mai Sentry in sviluppo locale** (`NODE_ENV=development`): il flag `enabled: false` previene l'invio.

---

## 5. Metriche da monitorare su Cloud Logging

Le seguenti metriche vanno configurate come **Log-based Metrics** su Google Cloud Monitoring, usando i log JSON emessi da Pino.

### 5.1 Metriche operative core

| Metrica | Log da cercare | Alert se |
|---|---|---|
| `webhook_received_total` | `msg = "Webhook ricevuto"` | — |
| `task_queued_total` | `msg = "Task accodato su Cloud Tasks"` | Spike anomalo |
| `task_completed_total` | `msg = "Worker completato con successo"` | — |
| `task_failed_total` | `level = "error"` | > 5 in 10 minuti |
| `task_dead_letter_total` | `status = "dead-letter"` | Qualsiasi valore > 0 |
| `processing_latency_ms` | Campo `workerDurationMs` | P95 > 30.000ms |
| `retry_rate` | Campo `attempt > 1` | > 20% dei task |

### 5.2 Dashboard consigliata

Creare su Google Cloud Monitoring una dashboard "Middleware Health" con:
1. Grafico a linee: `webhook_received` vs `task_completed` (dovrebbero convergere)
2. Grafico a barre: distribuzione `task_failed` per `collection`
3. Percentile latenza: P50, P95, P99 di `processing_latency_ms`
4. Contatore: `task_dead_letter_total` (sempre visibile, deve essere 0)

---

## 6. Cosa NON loggare — Regole assolute

Queste regole si applicano a **tutti** i livelli di log e non hanno eccezioni:

**Non loggare MAI su Cloud Logging (Livello 2):**
- `rawPayload` completo dei webhook — va solo su PostgreSQL (Livello 1) dove l'accesso è controllato da PayloadCMS
- Token API (Furious, Starty, service account)
- Password o hash di password
- Indirizzi email degli utenti
- Dati anagrafici (nome, cognome, CF, P.IVA)
- Dettagli finanziari identificativi (importi fattura associati a persona fisica)

**Tecnica di sanitizzazione:**
```typescript
// Prima di loggare, usa sempre una funzione di sanitizzazione
function sanitizeForLog(obj: Record<string, unknown>): Record<string, unknown> {
  const SENSITIVE_KEYS = ['token', 'password', 'email', 'rawPayload', 'jwt', 'secret']
  return Object.fromEntries(
    Object.entries(obj).filter(([key]) => !SENSITIVE_KEYS.includes(key.toLowerCase()))
  )
}
```

---

## 7. Riassunto delle responsabilità

| Cosa | Dove | Accessibile da |
|---|---|---|
| Storia di ogni operazione | PostgreSQL (`webhook-logs`) | Operatori via PayloadCMS UI |
| Payload grezzo del webhook | PostgreSQL (`rawPayload`) | Solo sviluppatori (accesso DB diretto) |
| Log tecnici dei worker | Google Cloud Logging | Sviluppatori via GCP Console |
| Crash e eccezioni | Sentry | Sviluppatori via Sentry.io |
| Metriche aggregate | Google Cloud Monitoring | Sviluppatori + alert automatici |
