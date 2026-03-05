# 060 — Flusso Assenze: Ricezione, Auto-Approvazione e Notifiche

> **Sottofase:** B — Release Assenze  
> **Stato:** ✅ Implementato (B1–B4)  
> **Dipendenze:** `010-collections.md`, `020-workers.md`, `040-logging.md`, `050-gcp-infrastructure.md`

---

## 1. Panoramica

Il flusso assenze gestisce il ciclo di vita completo di una richiesta di assenza ricevuta da Furious: dalla ricezione del webhook fino all'approvazione automatica su Furious (o allo skip se il dipendente non è in lista) e alla notifica in caso di fallimento definitivo.

Il flusso è **asincrono per design**: l'endpoint webhook risponde a Furious entro ~200ms senza eseguire alcuna logica di business. Il lavoro reale è delegato a Cloud Tasks, che chiama il worker interno in modo affidabile con retry automatico.

---

## 2. Attori e componenti coinvolti

| Componente | Ruolo |
|---|---|
| **Furious** | Sorgente — invia il webhook quando un dipendente crea un'assenza |
| `POST /api/webhooks/furious/absence` | Endpoint pubblico di ricezione — valida, salva, accoda |
| `AbsenceLog` (collection) | Registro persistente dello stato di ogni assenza ricevuta |
| `AutoApprovalRules` (collection) | Tabella di configurazione: quali pseudo vengono approvati automaticamente |
| `Google Cloud Tasks` | Coda asincrona — gestisce il dispatch al worker con retry esponenziale |
| `POST /api/workers/absence` | Endpoint interno — chiamato da Cloud Tasks, esegue la logica di business |
| `processAbsence()` | Funzione worker pura — contiene tutta la logica di approvazione |
| `approveAbsence()` | Wrapper API Furious — chiama `PUT /api/v2/absence/` con `{id, status: 1}` |
| `sendFailedTaskEmail()` | Notifica admin via Gmail quando il task fallisce definitivamente |

---

## 3. State machine di `AbsenceLog`

Ogni record `AbsenceLog` percorre una sequenza di stati. Le transizioni sono **unidirezionali** — uno stato terminale non può essere sovrascritto.

```
received
    │
    ▼
 queued ──────────────────────────────────────────┐
    │                                             │ (accodamento fallito:
    ▼                                             │  rimane received)
processing
    │
    ├──► approved          ← Furious ha confermato l'approvazione
    │
    ├──► skipped           ← pseudo non in AutoApprovalRules
    │
    ├──► failed_permanent  ← errore non-retriable (404/400 da Furious)
    │                         oppure tentativi esauriti (attempt ≥ 5)
    │
    └──► (processing)      ← errore retriable: Cloud Tasks riprova
```

**Stati terminali:** `approved`, `skipped`, `failed_permanent`  
**Hook automatico:** `setProcessedAtOnTerminalStatus` in `AbsenceLog` setta `processedAt` al momento della transizione in stato terminale.

---

## 4. Flusso dettagliato — passo per passo

### 4.1 Ricezione webhook (`POST /api/webhooks/furious/absence`)

Furious invia un `POST` JSON con almeno:
```json
{ "id": 12345, "pseudo": "mario.rossi", ... }
```

L'endpoint (`src/endpoints/absenceWebhook.ts`) esegue nell'ordine:

1. **Parsing body** — se il body non è JSON valido, risponde `400`.
2. **Validazione** — verifica che `id` sia `number` e `pseudo` sia una stringa non vuota. Se manca uno dei due, risponde `400`. Gli altri campi del payload sono accettati senza validazione e salvati come `rawPayload`.
3. **Creazione `AbsenceLog`** — crea il record con `status: 'received'`, `rawPayload: body`, `attempts: 0`. Il campo `absenceType` viene salvato se presente nel payload (`body.absenceType` o `body.type`); se assente rimane `null` — nessun fallback artificiale. Se il DB è irraggiungibile, risponde `500` così Furious può ritentare. **Il record viene creato prima dell'accodamento** — se Cloud Tasks fallisce, il payload non è perso.
4. **Accodamento su Cloud Tasks** — chiama `enqueueAbsenceTask()` con `{ absenceLogId, furiousAbsenceId, pseudo, attempt: 1 }`. Se l'accodamento ha successo, aggiorna il record a `status: 'queued'` e salva il `taskName` restituito da Cloud Tasks.
5. **Risposta `200 OK`** — restituita sempre, anche se l'accodamento fallisce. Se l'accodamento fallisce, il record rimane con `status: 'received'` come segnale per future riconciliazioni.

> **Motivo del 200 anche su fallimento accodamento:** il payload è già salvato su Postgres. Il problema di accodamento è nostro, non di Furious. Far ritentare Furious creerebbe duplicati nel DB.

### 4.2 Elaborazione worker (`POST /api/workers/absence`)

Cloud Tasks chiama questo endpoint interno (`src/endpoints/absenceWorkerEndpoint.ts`) con il payload del task nel body.

**Autenticazione:**
- In **produzione**: verifica il Bearer token OIDC nel header `Authorization`. Il token deve essere emesso dal service account `CLOUD_TASKS_SERVICE_ACCOUNT` con audience `WORKER_BASE_URL`.
- In **locale/sviluppo** (`NODE_ENV !== 'production'`): verifica l'header `x-worker-dev-secret` contro `WORKER_DEV_SECRET`.

**Flusso dell'endpoint:**

1. Aggiorna `AbsenceLog` a `status: 'processing'`. Se il DB non risponde, risponde `503` — Cloud Tasks riproverà.
2. Chiama `processAbsence(ctx)` — vedi §4.3.
3. Gestisce il risultato:
   - `success: true` → risponde `200`
   - `retriable: false` → risponde `200` (Cloud Tasks non deve riprovare — il worker ha già gestito lo stato nel DB)
   - `retriable: true` e `attempt < MAX_ATTEMPTS` → risponde `503` — Cloud Tasks riprova con backoff esponenziale
   - `retriable: true` e `attempt >= MAX_ATTEMPTS` → scrive `failed_permanent`, invia notifica admin, risponde `200`

> **Perché `failed_permanent` risponde 200 e non 5xx?** Perché vogliamo che Cloud Tasks si fermi. Rispondendo 5xx continuerebbe a ritentare. La gestione del dead-letter è applicativa (su Postgres), non delegata alla coda.

### 4.3 Logica di business (`processAbsence()`)

La funzione worker pura in `src/workers/absence/processAbsence.ts` riceve un `WorkerContext` e restituisce un `WorkerResult`.

**Algoritmo:**

1. **Valida il payload** — se `absenceLogId`, `furiousAbsenceId` o `pseudo` sono assenti, restituisce `{ success: false, retriable: false }`.
2. **Cerca il pseudo in `AutoApprovalRules`** — query su `collection: 'auto-approval-rules'` con `{ pseudo: { equals: pseudo }, flowType: { equals: 'absence' } }`.
3. **Se non trovato** — aggiorna `AbsenceLog` a `status: 'skipped'`, restituisce `{ success: true, retriable: false }`. Non è un errore: il dipendente semplicemente non è in lista.
4. **Se trovato** — chiama `approveAbsence(furiousAbsenceId)` che esegue `PUT https://dude.furious-squad.com/api/v2/absence/` con `{ id, status: 1 }`.
5. **Gestione errori Furious:**
   - `FuriousApiError` con `status 404` → assenza non trovata → `{ success: false, retriable: false }` + `status: 'failed_permanent'`
   - `FuriousApiError` con `status 400` → payload malformato → `{ success: false, retriable: false }` + `status: 'failed_permanent'`
   - `FuriousApiError` con `status 5xx`, `429`, `401` dopo rinnovo token → `{ success: false, retriable: true }` + aggiorna `attempts` e `lastError`
   - Qualsiasi altro errore non classificato → `{ success: false, retriable: true }` (fail-safe conservativo)

**Gestione del token Furious:** `approveAbsence()` usa `getFuriousToken()` che mantiene una cache in-memory con refresh automatico. Su risposta `401`, tenta il rinnovo del token una volta e riprova. Se il rinnovo fallisce, lancia `FuriousApiError` con `status: 401`.

---

## 5. Gestione retry e limiti

| Parametro | Valore | Dove configurato |
|---|---|---|
| Tentativi massimi | 5 | `MAX_ATTEMPTS` in `absenceWorkerEndpoint.ts` |
| Backoff iniziale | 10s | Cloud Tasks queue config (`050-gcp-infrastructure.md`) |
| Backoff cap | 1h | Cloud Tasks queue config |
| Rate massimo | 10 dispatch/s | Cloud Tasks queue config |
| Concorrenza | 5 task simultanei | Cloud Tasks queue config |

Il contatore `attempt` nel payload del task è **immutabile** — Cloud Tasks non lo incrementa automaticamente. È responsabilità dell'endpoint worker passare `attempt + 1` se volesse riaccodare manualmente (ma non lo fa: il retry è gestito da Cloud Tasks via risposta 5xx).

---

## 6. Notifiche admin (`B4`)

Quando un record raggiunge `failed_permanent`, l'endpoint worker chiama `sendFailedTaskEmail()` in `src/services/mailer.ts`.

L'email contiene:
- `collection` + `recordId` con link diretto al record in PayloadCMS admin
- `furiousAbsenceId`, `pseudo`
- `attempts` (numero di tentativi effettuati)
- `lastError` (messaggio dell'ultimo errore)

Il destinatario è `BOOTSTRAP_ADMIN_EMAIL`. L'invio usa il client Gmail con domain-wide delegation già configurato in `mailer.ts`.

> **Il fallimento dell'invio email non è bloccante.** L'errore viene catturato e inviato a Sentry, ma il record `failed_permanent` è già scritto su DB. L'admin può comunque vedere il record in PayloadCMS admin filtrando per `status: failed_permanent`.

---

## 7. Logging e osservabilità

Ogni transizione di stato emette un log Pino su stdout (→ Cloud Logging). I messaggi sono standardizzati per le log-based metrics:

| Evento | Messaggio Pino | Livello |
|---|---|---|
| Webhook ricevuto (valido) | `webhook_received` | `info` |
| Webhook ricevuto (non valido) | `webhook_received` | `warn` |
| Task accodato | `task_enqueued` | `info` |
| API Furious chiamata | `external_api_called` | `info` |
| Worker completato con successo | `worker_completed` | `info` |
| Errore retriable | `worker_failed_retriable` | `warn` |
| Errore non-retriable | `worker_failed_non_retriable` | `warn` |

Il `rawPayload` del webhook viene salvato **solo** su `AbsenceLog` (Postgres). Non viene mai loggato su Cloud Logging — contiene dati personali del dipendente.

Gli errori nei catch block dei worker chiamano `captureError()` da `src/lib/monitoring/index.ts`, che invia l'eccezione a Sentry con il contesto `{ taskId, collection, attempt, furiousId }`.

---

## 8. Variabili d'ambiente richieste

| Variabile | Utilizzo |
|---|---|
| `CLOUD_TASKS_QUEUE_ABSENCES` | Nome della coda Cloud Tasks |
| `CLOUD_TASKS_LOCATION` | Regione GCP (es. `europe-west8`) |
| `GCP_PROJECT_ID` | ID progetto GCP |
| `WORKER_BASE_URL` | URL base del server (es. `https://middleware-staging-xxx.run.app`) |
| `CLOUD_TASKS_SERVICE_ACCOUNT` | Email service account per OIDC |
| `WORKER_DEV_SECRET` | Secret per autenticazione worker in locale (solo sviluppo) |
| `FURIOUS_EMAIL` | Credenziali Furious per `getFuriousToken()` |
| `FURIOUS_PASSWORD` | Credenziali Furious per `getFuriousToken()` |
| `BOOTSTRAP_ADMIN_EMAIL` | Destinatario notifiche `failed_permanent` |

---

## 9. File chiave

```
src/
├── endpoints/
│   ├── absenceWebhook.ts           Endpoint B1 — ricezione webhook
│   └── absenceWorkerEndpoint.ts    Endpoint B3 — worker interno
├── workers/
│   └── absence/
│       └── processAbsence.ts       Logica B2 — auto-approvazione
├── lib/
│   ├── furious/api.ts              approveAbsence(), getAbsence()
│   └── gcp/tasks.ts                enqueueAbsenceTask()
├── services/
│   └── mailer.ts                   sendFailedTaskEmail() — notifica B4
└── collections/
    ├── AbsenceLog.ts               State machine + rawPayload
    └── AutoApprovalRules.ts        Tabella pseudo → auto-approvazione
```

---

## 10. Scenari di test (B5)

Per la procedura di test completa con comandi curl, vedere il file `README_sottofaseB.md` generato durante l'implementazione.

Scenari da verificare prima di considerare B completo:

1. **Pseudo presente in `AutoApprovalRules`** → status finale `approved`
2. **Pseudo assente** → status finale `skipped`
3. **Errore Furious retriable (simulato)** → status intermedio `processing`, poi `failed_permanent` dopo 5 tentativi + email admin ricevuta
4. **Errore Furious non-retriable (404)** → status immediato `failed_permanent`
5. **Payload non valido** → risposta `400`, nessun record creato
6. **Verifica in PayloadCMS admin** — per ogni scenario, controllare il record `AbsenceLog` con `status`, `attempts`, `lastError`, `processedAt` coerenti
