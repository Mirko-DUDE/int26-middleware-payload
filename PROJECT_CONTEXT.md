# PROJECT_CONTEXT — int26-middleware-payload

> Documento di riferimento permanente del progetto. Contiene tutto il contesto necessario
> per lavorare sul progetto. Leggere integralmente prima di qualsiasi azione.
> I PDF delle API (Furious, Starty, webhook) sono nel knowledge base del progetto. Aggiornare questo file ad ogni decisione strutturale.

---

## 1. Identità del progetto

**Repository:** https://github.com/Mirko-DUDE/int26-middleware-payload  
**Tipo:** Middleware PayloadCMS su Google Cloud Platform  
**Scopo:** Automatizzare due flussi di integrazione tra Furious ERP e Starty ERP

### I due sistemi esterni

| Sistema | URL | API |
|---------|-----|-----|
| Furious | `dude.furious-squad.com` | v2 — documentazione nel knowledge base |
| Starty | `dude.startyerp.cloud` | v3 — documentazione nel knowledge base |

---

## 2. Stato attuale del progetto

### Cosa è già stato fatto

**Fase 0 — Discovery (completata per flusso assenze):**
- Flusso assenze: completamente mappato, API studiate, logica definita
- Flusso fatture: in stand-by in attesa di risposte dall'amministrazione (campo PO non ancora chiarito)
- Creato documento domande per l'amministrazione (`Fase0_Momento2_Domande_Amministrazione.docx`)
- Schemi Figma creati: https://www.figma.com/board/lUdwg0DxIYcx6RWRskB0QA/FURIOUS-Integrazioni-esterne

**Setup documentazione (completato in Fase 1):**
- `.cursor/rules/000-project-overview.mdc` — contesto progetto per agenti AI
- `.cursor/rules/001-documentation-policy.mdc` — policy obbligatoria aggiornamento docs
- `docs/project/000-architecture.md` — architettura per sviluppatori
- `DECISIONS.md` — decision log
- `README.md` — aggiornato con contesto progetto

**Repository:**
- PayloadCMS già installato con Next.js App Router
- Database: PostgreSQL (adapter Drizzle)
- `.cursor/rules/` già popolata con regole PayloadCMS generiche (`.md`)
- `src/collections/` ha solo `Users.ts` e `Media.ts` — tutto da costruire
- `AGENTS.md` presente con regole PayloadCMS complete

### Avanzamento Sottofase A

- [x] **A1 — Schema dati PayloadCMS** ✓ completato
- [x] **A2 — Architettura dei Worker** ✓ completato
- [x] **A3 — Sistema autenticazione e ruoli** ✓ completato
- [ ] **A4 — Sistema logging e osservabilità** ← PROSSIMO
- [ ] **A5 — Infrastruttura GCP — specifiche**

Solo dopo A1-A5 si passa a:

**Sottofase B — Release Assenze**
- B1 — Specifiche endpoint webhook
- B2 — Specifiche Worker Assenze
- B3 — Specifiche Collection PayloadCMS (dettaglio operativo)
- B4 — Specifiche notifiche
- B5 — Test plan

---

## 3. Decisioni architetturali già prese — NON rimettere in discussione

### Principio obbligatorio: Estensibilità by design
Ogni decisione tecnica viene valutata non solo per il caso d'uso immediato ma per quanto
facilmente permette di aggiungere nuovi flussi, entità e sistemi. Se una soluzione è ottimale
per il caso corrente ma crea attrito per estensioni future, va scartata.

### Stack tecnologico — DEFINITIVO

| Componente | Scelta | Motivazione |
|-----------|--------|-------------|
| Framework | PayloadCMS (Next.js App Router) | Admin UI nativa + API + webhook in un solo processo |
| Database | PostgreSQL (Cloud SQL) | ACID, relazioni, JSONB per payload grezzi |
| ORM | Drizzle (incluso in Payload) | Già configurato nel repo |
| Queue | Google Cloud Tasks | Serverless, no Redis da gestire, retry automatico |
| Hosting | Google Cloud Run | Scalabilità automatica, pay-per-use |
| Secrets | Google Secret Manager | Token API, HMAC secrets, JWT sistema — mai in env vars |
| Logging | Cloud Logging + Sentry | System logs + error tracking |
| Auth utenti | Google SSO (OAuth2) | Accesso solo utenti dominio aziendale — closed by default |
| Email transazionali | Gmail API (Workspace Enterprise) | Inviti utenti — zero costi aggiuntivi, deliverability massima |

### Agente AI principale per Cursor
- **Claude Sonnet 4.6** — agente principale (veloce, economico, qualità alta su task ben specificati)
- **Claude Opus 4.6** — solo per decisioni architetturali critiche o bug complessi (dopo 2 risposte Sonnet insoddisfacenti)

### Pattern asincrono — DEFINITIVO
```
Webhook ricevuto → 200 OK immediato → salvataggio DB → accodamento Cloud Tasks
→ worker invocato in background → chiamata API esterna → aggiornamento log
```

### Gestione errori — DEFINITIVO
- **Retriable** (worker risponde 5xx → Cloud Tasks riprova): 429, 5xx, timeout, 401
- **Non-retriable** (worker risponde 200 → blocca retry): 400, 404, errori logica
- **Dead Letter Queue** dopo 5 tentativi → notifica admin
- **Backoff assenze**: 30s → 2min → 8min → 30min → 1h (moltiplicatore ×4)

### Sistema permessi — Pattern Adapter — DEFINITIVO

Il controllo accessi usa `src/access/permissions.ts` come **unica fonte di verità**.
Le Collection non contengono mai logica di accesso inline. Chiamano solo:

```typescript
import { canRead, canWrite } from '@/access/permissions'
access: {
  read:   canRead('absenceLog'),
  create: canWrite('absenceLog'),
  update: canWrite('absenceLog'),
  delete: () => false,
}
```

`canRead` e `canWrite` controllano trasversalmente anche `status === 'suspended'` — un utente sospeso non può operare anche se ha un JWT ancora valido.

**Livello 1 (attuale):** permessi come oggetto TypeScript statico in `permissions.ts`.
Modificare i permessi = modifica al codice + deploy.

**Livello 2 (futuro — debito tecnico DT-AUTH-001):** riscrivere solo `permissions.ts` per leggere
da una Collection PayloadCMS (`PermissionRules`). Zero modifiche alle Collection.
Trigger consigliato: quando un admin non-tecnico necessita di modificare i permessi
più di una volta al mese.

### Groups UI Admin — DEFINITIVI

Ogni Collection ha `admin.group` impostato. Struttura sidebar Admin UI:

| Gruppo | Collection |
|--------|-----------|
| `Assenze` | `AutoApprovalRules`, `AbsenceLog` |
| `Fatture` | `InvoicePendingReview`, `InvoiceLog` |
| `Sistema` | `Users` |
| `Media` | `Media` (e future Collection media GCS) |
| `Configurazione` | _(placeholder per Globals futuri)_ |

### Media — Storage GCS multi-bucket — PROGETTATO (implementare a richiesta)

Ogni tipologia di media ha una Collection dedicata con bucket GCS proprio.
Plugin: `@payloadcms/storage-gcs` configurato per-collection in `payload.config.ts`.
Il bucket viene **sempre** letto da env vars — mai hardcoded nel codice.

### Interfaccia standard Worker — DEFINITIVA (A2)

Ogni funzione worker rispetta il tipo `WorkerFn` definito in `src/workers/types.ts`.
Il worker non tocca mai `req`/`res` HTTP direttamente: riceve un `WorkerContext` e
restituisce un `WorkerResult`. La traduzione HTTP è delegata al runner generico.

```typescript
// Firma obbligatoria — non derogare
type WorkerFn = (ctx: WorkerContext) => Promise<WorkerResult>

interface WorkerResult {
  success: boolean
  message: string
  externalId?: string
  retriable: boolean   // false → rispondere 200 anche in caso di errore
}
```

Dettaglio completo in `docs/project/020-workers.md` e `.cursor/rules/020-worker-patterns.mdc`.

### Pattern `getToken()` / `callWithToken()` — DEFINITIVO (A2)

Tutti i token API (Furious, Starty, futuri) si leggono **esclusivamente** da Google Secret Manager
tramite `src/lib/tokenManager.ts`. Mai da variabili d'ambiente. La cache in memoria evita
round-trip ripetuti (TTL default 55 min). Il wrapper `callWithToken<T>()` gestisce
automaticamente l'invalidazione e il rinnovo su risposta `401`.

```typescript
// Unico pattern autorizzato per chiamate API esterne
const result = await callWithToken<T>('nome-secret', (token) => fetch(url, {
  headers: { 'F-Auth-Token': token }
}))
```

Nomi dei secret standard:

| Sistema | Secret Manager key |
|---------|-------------------|
| Furious API token | `furious-api-token` |
| Starty JWT | `starty-jwt-token` |

### Codici HTTP di risposta a Cloud Tasks — DEFINITIVO (A2)

```
HTTP 200  →  task completato O errore non-retriable (non rischedulare)
HTTP 5xx  →  errore retriable (Cloud Tasks riprova con backoff)
MAI 4xx   →  Cloud Tasks tratta i 4xx come 200 (completato), non usarli per segnalare errori
```

### Classificazione errori retriable vs non-retriable — DEFINITIVA (A2)

| Tipo errore | Retriable | Esempi |
|-------------|-----------|--------|
| Timeout di rete | ✅ | Sistema esterno non raggiungibile |
| HTTP 5xx sistema esterno | ✅ | Furious in manutenzione |
| HTTP 429 (rate limit) | ✅ | Troppi accessi API |
| HTTP 401 dopo rinnovo token | ✅ | Token revocato, Secret aggiornato |
| HTTP 404 (risorsa inesistente) | ❌ | Absence ID non trovato |
| HTTP 400 (payload malformato) | ❌ | Dati webhook corrotti |
| Validazione locale fallita | ❌ | Campo obbligatorio mancante |
| ID non in tabella transcodifica | ❌ | Progetto non mappato |

### Logging strutturato Worker — DEFINITIVO (A2)

I worker usano `ctx.logger` (mai `console.log` diretto). Il logger è un child Pino con
`taskId` e `taskType` come campi fissi, serializzato in JSON con campo `severity`
per compatibilità Cloud Logging.

Nomi degli eventi standardizzati:

| Livello | Evento |
|---------|--------|
| `info` | `worker_started`, `worker_completed`, `external_api_called` |
| `warn` | `worker_failed_retriable`, `worker_failed_non_retriable` |
| `error` | `worker_dead`, `token_fetch_error` |

### Dead letter e numero tentativi — DEFINITIVO (A2)

L'header Cloud Tasks `X-CloudTasks-TaskRetryCount` è **0-based**.
Convertire sempre: `attempt = parseInt(header) + 1`.
Dead letter scatta quando `attempt >= 5`. Lo stato del task diventa `dead` nel DB.

### Protezione endpoint worker — DEFINITIVO (A2)

Ogni endpoint worker chiama `verifyCloudTasksRequest()` come prima operazione,
prima di qualsiasi logica di business. La verifica usa OIDC token emesso da Cloud Tasks
e confronta il service account autorizzato.

---

## 4. Flusso Assenze — logica completa (Release 1)

### Trigger
Webhook Furious evento `conge_waiting` → endpoint `/webhooks/furious/absence`

### Logica decisionale
```
Webhook ricevuto con pseudo
→ Cerca pseudo in AutoApprovalRules
→ Se trovato: PUT /api/v2/absence/ con status: 1 (Confermare) → log "approved"
→ Se non trovato: log "skipped" — nessuna azione
→ In caso errore retriable: risponde 5xx → Cloud Tasks riprova
→ In caso errore permanente: log "failed_permanent" → notifica admin
```

### API Furious coinvolte
- `GET /api/v2/absence/` — legge dati completi assenza tramite id
- `PUT /api/v2/absence/` — aggiorna status (1=Confermare, 2=Annullare)
- Autenticazione: header `F-Auth-Token` generato da `POST /api/v2/auth/`

### Payload webhook Furious (struttura attesa)
Il webhook Furious invia un JSON con le variabili configurate. Le variabili rilevanti
per il flusso assenze sono: id assenza, pseudo, tipo assenza, date. Il payload esatto
va verificato nella documentazione webhook nel knowledge base.

---

## 5. Flusso Fatture — stato (Release 2, STAND-BY)

**Non sviluppare ancora.** In attesa di risposte dall'amministrazione su:
- Come arriva il Purchase Order (PO) su Starty
- Come mappare il PO al campo `bc_id` di Furious
- Chi sono gli pseudo manager per le fatture
- Flusso operativo attuale (chi fa cosa oggi manualmente)

Il documento con le domande è `Fase0_Momento2_Domande_Amministrazione.docx`.

---

## 6. Schema Collections PayloadCMS — A1 completato

Schema progettato e documentato. Dettaglio completo in `docs/project/010-collections.md`.
Regole per agenti in `.cursor/rules/010-payloadcms-collections.mdc`.

### Mappa Collection → Group UI → Release

| Collection | File | Group UI | Release | Stato |
|-----------|------|----------|---------|-------|
| `Users` | `Users.ts` | `Sistema` | esistente | estendere con `role` + `status` |
| `Media` | `Media.ts` | `Media` | esistente | non toccare |
| `AutoApprovalRules` | `AutoApprovalRules.ts` | `Assenze` | R1 | ← creare |
| `AbsenceLog` | `AbsenceLog.ts` | `Assenze` | R1 | ← creare |
| `InvoicePendingReview` | `InvoicePendingReview.ts` | `Fatture` | R2 | schema definito, impl. dopo |
| `InvoiceLog` | `InvoiceLog.ts` | `Fatture` | R2 | schema definito, impl. dopo |

### Principi di design — DEFINITIVI

- Ogni Collection di log ha obbligatoriamente: `rawPayload` (json), `status`, `attempts`,
  `lastError`, `processedAt`. Tutti i campi audit sono `readOnly` dall'UI e aggiornati
  solo dal sistema via hooks.
- Il `status` è una state machine esplicita (non testo libero). Hook `beforeChange`
  imposta `processedAt` automaticamente alla transizione verso uno stato terminale.
- `delete: () => false` su tutte le Collection di log — audit trail non cancellabile.
- `AutoApprovalRules` ha campo `flowType` per riutilizzo su flussi futuri.
- Indici su tutti i campi in `where`/`orderBy`: `pseudo`, `status`, `furiousAbsenceId`, `createdAt`.

### State machine AbsenceLog

```
received → processing → approved         (pseudo in AutoApprovalRules, PUT Furious ok)
                     → skipped           (pseudo non in AutoApprovalRules)
                     → failed_permanent  (5 tentativi o errore non-retriable)
```

---

## 7. Sistema autenticazione e ruoli — A3 completato

Documentazione completa in `docs/project/030-auth-roles.md`.
Regole per agenti in `.cursor/rules/030-auth-roles.mdc`.

### Modello di accesso: closed by default

Il dominio aziendale ha più di cento utenti. L'accesso è **invite-based**: nessun utente
può autenticarsi autonomamente anche con mail aziendale valida. L'admin crea il record
utente con ruolo assegnato, il sistema invia l'invito via Gmail API, l'utente accede
tramite Google SSO.

### I quattro ruoli

| Ruolo | Descrizione | Accesso |
|-------|-------------|---------|
| `admin` | Amministratore sistema | Tutto, incluse AutoApprovalRules e gestione utenti |
| `hr` | HR aziendale | AbsenceLog (read/write per approvazione) |
| `amministrazione` | Ufficio amministrativo | InvoicePendingReview (read/write), InvoiceLog (read) |
| `sistema` | Service account worker | Scrittura log e record operativi, nessuna UI |

### I tre stati utente

| Status | Significato | Accesso |
|--------|-------------|---------|
| `invited` | Invitato dall'admin, primo login non ancora effettuato | ✅ (al login diventa `active`) |
| `active` | Utente operativo | ✅ |
| `suspended` | Accesso revocato — dati e audit trail preservati | ❌ |

### Regole JWT — DEFINITIVE

- `role` e `status` hanno entrambi `saveToJWT: true` — zero DB lookup per ogni richiesta
- Il ruolo `sistema` non appare nelle options UI del campo `role` — creato via `onInit`
- La sospensione è effettiva a tre livelli: blocco al login in `findOrCreateUser()`,
  scadenza naturale del JWT, controllo trasversale in `canRead`/`canWrite`

### Bootstrap admin

L'unico admin che non richiede invito è definito da `BOOTSTRAP_ADMIN_EMAIL` (env var).
Al primo login viene creato/promosso automaticamente. Non fa mai downgrade:
rimuovere la variabile env non altera il ruolo già nel DB.
Tutti gli admin successivi vengono promossi da un admin esistente via UI Payload.

### Service account `sistema`

Creato automaticamente all'avvio via hook `onInit` se non esiste.
Si autentica verso PayloadCMS tramite JWT (non Google SSO).
Il JWT è generato da `src/scripts/generate-sistema-jwt.ts` e conservato in GCP Secret Manager.
Gli endpoint interni `/internal/*` verificano `isSistema(req.user)` come prima operazione.

### Invio mail via Gmail API

Le mail di invito sono inviate tramite **Gmail API** con domain-wide delegation.
Mittente: `noreply@dominio-azienda` (indirizzo reale Workspace).
Costo: zero — incluso nella licenza Workspace Enterprise.
Prerequisito operativo: configurazione domain-wide delegation richiede Super Admin Workspace.

### Variabili d'ambiente auth (tutte richieste)

| Variabile | Scope |
|-----------|-------|
| `GOOGLE_CLIENT_ID` | Runtime |
| `GOOGLE_CLIENT_SECRET` | Secret Manager |
| `PAYLOAD_PUBLIC_SERVER_URL` | Runtime |
| `ALLOWED_EMAIL_DOMAIN` | Runtime |
| `BOOTSTRAP_ADMIN_EMAIL` | Runtime |
| `SISTEMA_EMAIL` | Runtime |
| `SISTEMA_JWT` | Secret Manager |
| `PAYLOAD_INTERNAL_URL` | Runtime |
| `GMAIL_SENDER_ADDRESS` | Runtime |
| `GMAIL_DELEGATED_USER` | Runtime |
| `GOOGLE_SERVICE_ACCOUNT_KEY_JSON` | Secret Manager |

---

## 8. Autenticazione API esterne — implementata in A2

### Pattern comune (identico per entrambe le API)

Implementato in `src/lib/tokenManager.ts` e `src/lib/apiClient.ts`.

```typescript
// Pattern getToken() — cache in memoria + Secret Manager
// 1. Legge token da cache in-memory (TTL 55 min default)
// 2. Cache miss/scaduta: legge da Secret Manager
// 3. Se risposta 401: invalida cache, rilettua da Secret Manager, riprova una sola volta
// 4. Se secondo tentativo fallisce: lancia errore retriable
```

### Furious Auth
- Endpoint: `POST /api/v2/auth/`
- Body: `{ "action": "auth", "data": { "email": "...", "password": "..." } }`
- Response header: `F-Auth-Token`
- Token storage: GCP Secret Manager key `furious-api-token`

### Starty Auth (3 step)
- Step 1: BasicAuth → ottieni token ruolo
- Step 2: token ruolo → seleziona organizzazione → ottieni token org
- Step 3: token org → JWT finale
- Token storage: GCP Secret Manager key `starty-jwt-token`

---

## 9. Struttura src/ attesa — da costruire

```
src/
├── app/
│   ├── (frontend)/          # UI operatori
│   └── (payload)/           # Admin PayloadCMS (già presente)
├── collections/
│   ├── Users.ts             # ← ESTENDERE con campo role + status (A3)
│   ├── Media.ts             # ← NON TOCCARE
│   ├── AutoApprovalRules.ts # ← CREARE [R1]
│   ├── AbsenceLog.ts        # ← CREARE [R1]
│   ├── InvoicePendingReview.ts # ← PROGETTARE [R2]
│   └── InvoiceLog.ts        # ← PROGETTARE [R2]
│   └── hooks/
│       └── sendInviteEmailHook.ts  # ← CREARE (A3) — invio mail invito
├── access/
│   ├── permissions.ts       # ← CREARE (A3) — unica fonte di verità permessi
│   └── helpers.ts           # ← CREARE (A3) — isAdmin, isHR, isAmministrazione, isSistema, isActive
├── services/
│   └── mailer.ts            # ← CREARE (A3) — Gmail API con domain-wide delegation
├── hooks/
│   └── setProcessedAtOnTerminalStatus.ts  # ← CREARE [R1] — hook audit log
├── workers/
│   ├── types.ts             # WorkerFn, WorkerResult, WorkerContext, TaskStatus
│   ├── runner.ts            # Runner generico — non modificare per ogni worker
│   ├── absence/
│   │   └── processAbsence.ts    # [R1]
│   └── invoice/
│       └── processInvoice.ts    # [R2]
├── endpoints/
│   ├── workers/
│   │   ├── absence.ts       # endpoint HTTP worker → verifyCloudTasksRequest + runWorker
│   │   └── invoice.ts
│   └── internal/            # ← endpoint protetti da isSistema() — chiamati da worker
├── webhooks/
│   ├── furious/
│   │   └── absence.ts       # endpoint ricezione [R1]
│   └── starty/
│       └── invoice.ts       # endpoint ricezione [R2]
├── lib/
│   ├── furious/
│   │   ├── auth.ts          # getFuriousToken() — wrappa tokenManager
│   │   └── api.ts           # chiamate API tipizzate
│   ├── starty/
│   │   ├── auth.ts          # getStartyToken()
│   │   └── api.ts
│   ├── gcp/
│   │   ├── tasks.ts         # enqueueTask() generico
│   │   └── secrets.ts       # getSecret(), setSecret()
│   ├── tokenManager.ts      # getToken(), invalidateToken() — cache + Secret Manager
│   ├── apiClient.ts         # callWithToken<T>() — wrapper con retry su 401
│   ├── logger.ts            # createWorkerLogger() — Pino child con taskId/taskType
│   ├── taskLogs.ts          # updateTaskStatus() — aggiorna record TaskLogs in Payload
│   ├── cloudTasks.ts        # verifyCloudTasksRequest(), enqueueTask()
│   └── hmac/
│       └── verify.ts        # verifyWebhookSignature() generico
└── payload.config.ts        # ← DA AGGIORNARE con nuove collection e onInit hook
```

---

## 10. Sicurezza webhook

### Starty
- Header: `X-StartyHook-Signature` + `X-StartyHook-Timestamp`
- Algoritmo: HMAC-SHA256(payload_bytes + timestamp_bytes, secret)
- Secret da: GCP Secret Manager key `starty-webhook-secret`

### Furious
- Meccanismo da verificare durante sviluppo (API docs non specificano chiaramente)
- Aggiornare `DECISIONS.md` quando chiarito

---

## 11. Policy documentazione — OBBLIGATORIA per ogni azione

Dopo ogni modifica a codice, architettura o configurazione, l'agente DEVE:

1. Aggiornare `docs/project/[area].md` — documentazione per sviluppatori (italiano, narrativo)
2. Aggiornare `.cursor/rules/[area].mdc` — regole per agenti AI (tecnico, pattern codice)
3. Aggiungere voce in `DECISIONS.md` se si risolve un errore non banale o si devia dalle specifiche
4. Verificare che `tsc --noEmit` passi senza errori
5. Eseguire `generate:types` se cambia schema Collection

### Mappa aree → file

| Area | docs/project/ | .cursor/rules/ |
|------|---------------|----------------|
| Architettura | `000-architecture.md` | `000-project-overview.mdc` |
| Tech stack | `001-tech-stack.md` | `001-tech-stack.mdc` |
| Collections | `010-collections.md` | `010-payloadcms-collections.mdc` |
| Workers | `020-workers.md` | `020-worker-patterns.mdc` |
| Auth & Ruoli | `030-auth-roles.md` | `030-auth-roles.mdc` |
| Flusso Assenze | `050-absence-flow.md` | `050-absence-flow.mdc` |
| Flusso Fatture | `060-invoice-flow.md` | `060-invoice-flow.mdc` |
| GCP | `070-gcp-infrastructure.md` | `070-gcp-config.mdc` |
| Test | `080-testing.md` | `080-testing-patterns.mdc` |

---

## 12. File già presenti nel repository — non sovrascrivere

```
.cursor/rules/
  access-control-advanced.md   # regole PayloadCMS generiche — non toccare
  access-control.md
  adapters.md
  collections.md
  components.md
  endpoints.md
  field-type-guards.md
  fields.md
  hooks.md
  payload-overview.md
  plugin-development.md
  queries.md
  security-critical.mdc        # unico .mdc esistente — non toccare
AGENTS.md                      # regole PayloadCMS complete — non sovrascrivere, solo appendere
```

---

## 13. Debiti tecnici aperti

| ID | Area | Descrizione | Trigger migrazione |
|----|------|-------------|-------------------|
| DT-AUTH-001 | Permessi | Permessi statici hardcoded in `permissions.ts` | Permessi per-progetto o config da UI admin non tecnici |
| DT-AUTH-002 | Auth | JWT sistema a lunga scadenza | Migrazione a Workload Identity Federation |
| DT-AUTH-003 | UX | Reinvio invito manuale (update record) | Aggiungere Custom Action Payload sulla collection Users |

---

## 14. Task corrente — A4: Sistema logging e osservabilità

### Obiettivo
Definire l'architettura completa di logging: come i worker scrivono i log di business
su PostgreSQL (Collection `WebhookLogs`), come i log di sistema vengono inviati a
Cloud Logging, e come Sentry cattura gli errori non gestiti.

### Da produrre
1. `docs/project/040-logging.md` — documentazione narrativa per sviluppatori (italiano)
2. `.cursor/rules/040-logging.mdc` — regole e pattern TypeScript per agenti AI

### Il documento deve coprire
- Separazione log di business (PostgreSQL) vs log di sistema (Cloud Logging)
- Schema Collection `WebhookLogs` e state machine degli stati
- Configurazione Pino per Cloud Logging (campo `severity`, formato JSON)
- Configurazione Sentry SDK in PayloadCMS/Next.js
- Pattern `createWorkerLogger()` — child logger con `taskId` e `taskType` fissi
- Pattern `updateTaskStatus()` — aggiornamento record nel DB da worker
- Come distinguere errori retriable da non-retriable nel log

### Vincoli da rispettare (già decisi)
- Mai `console.log` diretto nei worker — sempre `ctx.logger`
- Log di business su Postgres (visibili in UI admin), log di sistema su Cloud Logging
- Sentry per error tracking — non duplicare su Cloud Error Reporting
- Nomi eventi standardizzati: `worker_started`, `worker_completed`, `external_api_called`,
  `worker_failed_retriable`, `worker_failed_non_retriable`, `worker_dead`, `token_fetch_error`

---

## 15. Come mantenere questo documento aggiornato

Questo file è la fonte di verità del progetto. Va aggiornato ogni volta che:

- Cambia lo stato di avanzamento (aggiornare le checkbox in §2)
- Si prende una decisione architetturale che non era prevista (aggiungere in §3)
- Si completa una sottofase A o B (aggiornare §2 e §14 con il task successivo)
- Si ricevono risposte dall'amministrazione sul flusso fatture (aggiornare §5)
- Cambia un pattern tecnico (worker, auth, error handling — aggiornare §3-§8)

**Non duplicare** informazioni già nei file `.cursor/rules/` o `docs/project/` —
questo documento dà il contesto e punta agli altri file per i dettagli.
