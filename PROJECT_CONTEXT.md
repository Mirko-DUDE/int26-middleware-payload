# PROJECT_CONTEXT.md
*Documento di riferimento per agenti AI e sviluppatori — aggiornato al completamento di A1–A5, autenticazione Google OAuth2, e Sottofase B (B1–B4)*

---

## §1. Obiettivo del progetto

Middleware custom su **PayloadCMS + PostgreSQL + GCP** per integrare **Furious** (ERP SaaS) con il gestionale interno **Starty**.

Due flussi di business principali:
1. **Approvazione Assenze** — ricezione webhook da Furious, approvazione umana in UI, aggiornamento stato su Furious via API.
2. **Sincronizzazione Fatture Passive** — lettura dati da Starty, transcodifica ID, creazione acquisti su Furious via `POST /api/v2/purchase/`.

---

## §2. Stack tecnologico (decisioni irrevocabili)

| Componente | Scelta | Motivazione |
|---|---|---|
| Backend/UI | PayloadCMS (Node.js/TypeScript) | UI approvazioni nativa, framework API solido |
| Database | Cloud SQL PostgreSQL 16 | ACID, relazionale, tabelle transcodifica |
| Hosting | Google Cloud Run | Serverless, scala a zero, pay-per-use |
| Code async | Google Cloud Tasks | Serverless, no Redis/BullMQ, push-based |
| Logging app | Pino → stdout → Cloud Logging | JSON strutturato, zero config su Cloud Run |
| Error tracking | Sentry | Stack trace, alert, correlazione per task |
| Secret storage | Secret Manager | Mai env vars per token API |
| ORM | Drizzle ORM (adapter ufficiale Payload per PG) | |
| Autenticazione | Google OAuth2 SSO via `payload-oauth2` (WilsonLe) | `@payloadcms/plugin-sso` non disponibile per Payload 3.x |

**iPaaS (Make/n8n/Zapier): esclusi definitivamente.**
**MongoDB: escluso definitivamente.**

---

## §3. Decisioni architetturali rilevanti

### Sicurezza
- Tutti i token API (`furious-auth-token`, `starty-jwt-token`, ecc.) vanno **esclusivamente** su Secret Manager, montati come env vars al deploy. Mai hardcodati, mai nel Dockerfile.
- Gli endpoint worker (`/api/workers/*`) sono protetti da OIDC token di Cloud Tasks. Non accessibili pubblicamente.
- Webhook Starty verificati con firma HMAC tramite `starty-webhook-secret`.

### Autenticazione (A3 — implementato)
- Plugin: **`payload-oauth2`** (WilsonLe) — unico compatibile con Payload 3.x al momento dell'implementazione.
- Endpoint OAuth registrati sulla collection `users`: `/api/users/oauth/google` (authorize) e `/api/users/oauth/google/callback`.
- Logica closed-by-default implementata in `getUserInfo()` — nessun utente entra senza invito esplicito.
- Bootstrap admin: al primo avvio (DB vuoto), `BOOTSTRAP_ADMIN_EMAIL` crea automaticamente admin + service account `sistema`.
- Pulsante login: Server Component `src/components/GoogleLoginButton.tsx` registrato in `admin.components.beforeLogin`.
- **`GMAIL_DELEGATED_USER` determina il mittente reale delle mail** — deve coincidere con `GMAIL_SENDER_ADDRESS`.

### Vincoli noti sul plugin `payload-oauth2`
- Il plugin fa sempre `payload.update(user.id, data: getUserInfo())` dopo il login. Se `getUserInfo()` restituisce campi incompleti, PayloadCMS valida e può lanciare errori.
- **Soluzione adottata:** `beforeChange` hook in `Users` che preserva `role` e `status` dall'`originalDoc` se assenti nel payload dell'update.
- `overrideAccess: true` bypassa solo il collection-level access, NON il field-level access — i campi `role` e `status` non hanno field-level access per questo motivo.
- Il valore `'sistema'` deve essere presente nelle `options` del campo `role` per superare la validazione PayloadCMS, anche se il service account viene creato con `overrideAccess: true`.

### Logging (A4)
- **Due livelli separati e non intercambiabili:**
  - Livello 1: Business audit log su PostgreSQL (`webhook-logs` collection) — visibile in UI agli operatori.
  - Livello 2: System logs su Cloud Logging via Pino stdout — solo per sviluppatori.
- Il `rawPayload` del webhook va **solo** su PostgreSQL (dati personali), mai su Cloud Logging.
- Campi obbligatori in ogni log entry Pino: `taskId`, `collection`, `furiousId`/`startyId`, `attempt`.
- Messaggi standardizzati per log-based metrics su Cloud Monitoring.
- Sentry cattura eccezioni nei worker con contesto `task` obbligatorio.
- Retention: rawPayload svuotato dopo 90gg; record completed archiviati dopo 365gg; dead-letter conservati a tempo indeterminato.

### Infrastruttura GCP (A5)
- **Cloud Run:** regione `europe-west8` (Milano), 0–20 istanze, 512Mi–2Gi RAM, timeout 60s, concorrenza 80.
- **Cloud SQL:** `db-g1-small` in produzione, `db-f1-micro` in staging; connessione via Cloud SQL Auth Proxy (Unix socket), mai TCP diretto; pool max 5 conn/istanza.
- **Cloud Tasks:** due code (`queue-absences`, `queue-invoices`); max 5 tentativi; backoff esponenziale 10s→cap 1h; rate 10 dispatch/s, 5 concurrent.
- **Dead-letter:** gestione applicativa (no DLQ nativa Cloud Tasks) — dopo 5 fallimenti, status `dead-letter` su PostgreSQL con alert Sentry.
- **Ambienti:** unico progetto GCP con prefissi (`-staging` / `-prod`). Promozione: stesso image SHA, approvazione manuale.
- **Pattern Adapter (irrevocabile):** tutte le chiamate Cloud Tasks isolate in `src/lib/gcp/tasks.ts`.

### Architettura flusso webhook
1. Endpoint Payload riceve webhook → risponde `200 OK` entro ~200ms.
2. Crea record `webhook-logs` con `status: received` + `rawPayload`.
3. Accoda su Cloud Tasks → aggiorna `status: queued`.
4. Cloud Tasks chiama worker → `status: processing`.
5. Worker chiama API Furious/Starty → `status: completed` o `failed`/`dead-letter`.

---

## §4. Struttura documentazione prodotta

```
docs/project/
├── 000-architecture.md
├── 010-collections.md          (A1) Schema collezioni PayloadCMS
├── 020-workers.md              (A2/A3) Pattern worker, Cloud Tasks, retry
├── 025-furious-api.md          ✅ Auth Furious, caching token, endpoint, ambienti
├── 030-auth-roles.md           (A3) ✅ Autenticazione, permessi, OAuth2, Gmail API
├── 040-logging.md              (A4) ✅ Business audit log, Pino, Sentry, metriche
└── 050-gcp-infrastructure.md   (A5) ✅ Cloud Run, SQL, Tasks, Secret Manager, ambienti

.cursor/rules/
├── 000-project-overview.mdc
├── 001-documentation-policy.mdc
├── 010-payloadcms-collections.mdc
├── 020-worker-patterns.mdc
├── 025-furious-api.mdc         ✅
├── 030-auth-roles.mdc          (A3) ✅
├── 040-logging.mdc             (A4) ✅
└── 050-gcp-config.mdc          (A5) ✅
```

---

## §5. Checklist fasi di progetto

### Sottofase A — Fondamenta (completata)
- [x] A1 — Modellazione dati e schema collezioni
- [x] A2 — Sicurezza, autenticazione, HMAC webhook
- [x] A3 — Pattern worker, Cloud Tasks, gestione retry + Google OAuth2 SSO funzionante
- [x] A4 — Sistema di logging e osservabilità
- [x] A5 — Infrastruttura GCP — specifiche provisioning

### Sottofase B — Release Assenze ← **TASK CORRENTE**
- [x] B1 — Endpoint ricezione webhook assenze (`src/endpoints/absenceWebhook.ts`)
- [x] B2 — Worker logica auto-approvazione (`src/workers/absence/processAbsence.ts`)
- [x] B3 — Endpoint worker interno Cloud Tasks (`src/endpoints/absenceWorkerEndpoint.ts`)
- [x] B4 — Notifica admin `failed_permanent` (`sendFailedTaskEmail` in `src/services/mailer.ts`)
- [x] B5 — Test locali completati: scenari approved, skipped,
      payload non valido verificati in locale con curl.
      Test E2E su staging da completare dopo il deploy.
- [ ] B6 — Deploy produzione + configurazione webhook Furious (produzione)

### Sottofase C — Release Fatture Passive
- [ ] C1 — Lettura fatture da Starty (API o DB diretto)
- [ ] C2 — Tabella transcodifica ID Starty ↔ ID Furious
- [ ] C3 — Worker creazione acquisti (`POST /api/v2/purchase/`)
- [ ] C4 — Gestione acquisti parziali (`POST /api/v2/purchase-partial/`)
- [ ] C5 — Test E2E + deploy

### Sottofase D — Hardening & Osservabilità
- [ ] D1 — Dashboard Cloud Monitoring "Middleware Health"
- [ ] D2 — Alert policy (dead-letter > 0, error rate > 5/10min, latenza P95 > 30s)
- [ ] D3 — Documentazione operativa per team HR/Amministrazione
- [ ] D4 — Runbook incident response

---

## §6. API Furious — riferimento rapido

**Autenticazione:** `POST /api/v2/auth/` con body `{ "action": "auth", "data": { "username": "...", "password": "..." } }` → risposta con `token`.
**Assenze:** `PUT /api/v2/absence/` con body `{ "action": "update", "data": { "id": <id>, "status": 1 } }` — status 1=Confermare, 2=Annullare. L'ID va nel body (`data.id`), non nell'URL.
**Lettura assenza:** `GET /api/v2/absence/?id=<id>` — ID come query string, non nel path.
**Acquisti:** `POST /api/v2/purchase/` con `{cost_name, amount_ht, vat, currency, project_id, ...}`.
**Pagamenti parziali:** `POST /api/v2/purchase-partial/`.
**Entità aziendali:** `dudemilano | dudeoriginals | dudesrl | dudethings`.

---

## §7. Regole per agenti AI

1. **Non rimettere in discussione** le decisioni marcate come irrevocabili in §2 e §3.
2. **Leggere sempre** il file `.cursor/rules/` specifico prima di lavorare su un'area.
3. **Non chiamare** Secret Manager a runtime — i secret sono già env vars.
4. **Non chiamare** Cloud Tasks direttamente — usare solo `src/lib/gcp/tasks.ts`.
5. **Non loggare** rawPayload, token, email su Cloud Logging (solo Livello 1 Postgres).
6. **Seguire** i messaggi standardizzati per le log-based metrics (vedi 040-logging.mdc).
7. **Usare sempre** Auth Proxy Unix socket per la connessione a Cloud SQL.
8. **Non aggiungere field-level access** su `role` e `status` in `Users.ts` — causa blocchi silenziosi nel flusso OAuth2 (vedi DECISIONS.md).
9. **Endpoint OAuth2** sono su `/api/users/oauth/google` (authorize) e `/api/users/oauth/google/callback` — non `/api/oauth/google`.
10. **`GMAIL_DELEGATED_USER`** deve coincidere con `GMAIL_SENDER_ADDRESS` — Gmail API usa sempre l'account impersonato come mittente reale.

---

## §8. Stato implementativo Sottofase A — file chiave

```
src/
├── collections/
│   ├── Users.ts                    ✅ auth OAuth2, ruoli, stati, beforeChange hook
│   ├── AutoApprovalRules.ts        ✅ regole auto-approvazione assenze
│   ├── AbsenceLog.ts               ✅ log assenze con state machine
│   ├── InvoicePendingReview.ts     ✅ stub R2
│   └── InvoiceLog.ts               ✅ stub R2
├── collections/hooks/
│   ├── sendInviteEmailHook.ts      ✅ mail invito via Gmail API
│   └── afterLoginHook.ts           ✅ promozione invited→active
├── access/
│   ├── permissions.ts              ✅ canRead/canWrite Pattern Adapter
│   └── helpers.ts                  ✅ isAdmin, isHR, isAmministrazione, isSistema, isActive
├── lib/
│   ├── auth/googleOAuth.ts         ✅ plugin OAuth2 + bootstrap + closed-by-default
│   ├── furious/auth.ts             ✅ getFuriousToken() con cache + Secret Manager
│   ├── furious/api.ts              ✅ approveAbsence(), getAbsence() con retry 401
│   ├── gcp/tasks.ts                ✅ enqueueAbsenceTask(), enqueueInvoiceTask()
│   ├── gcp/secrets.ts              ✅ getSecret(), setSecret()
│   ├── monitoring/index.ts         ✅ captureError(), captureMessage() wrapper Sentry
│   └── logger.ts                   ✅ singleton Pino
├── endpoints/
│   ├── absenceWebhook.ts           ✅ B1 — ricezione webhook, crea AbsenceLog, accoda task
│   └── absenceWorkerEndpoint.ts    ✅ B3 — endpoint interno Cloud Tasks, auth OIDC/dev, matrice retry
├── workers/
│   ├── types.ts                    ✅ WorkerFn, WorkerResult, WorkerTaskPayload
│   └── absence/processAbsence.ts  ✅ B2 — worker auto-approvazione assenze
├── services/
│   └── mailer.ts                   ✅ Gmail API domain-wide delegation + sendFailedTaskEmail()
├── components/
│   └── GoogleLoginButton.tsx       ✅ Server Component pulsante login Google
└── hooks/
    └── setProcessedAtOnTerminalStatus.ts  ✅ hook beforeChange per stati terminali
```

**Variabili d'ambiente richieste (tutte presenti in `.env.example`):**

| Variabile | Scope |
|---|---|
| `DATABASE_URL` | PostgreSQL connection string |
| `PAYLOAD_SECRET` | JWT signing secret |
| `SERVER_URL` | URL pubblico del server |
| `GOOGLE_CLIENT_ID` | OAuth2 app Google |
| `GOOGLE_CLIENT_SECRET` | OAuth2 secret |
| `ALLOWED_EMAIL_DOMAIN` | Es. `dude.it` |
| `BOOTSTRAP_ADMIN_EMAIL` | Email primo admin |
| `SISTEMA_EMAIL` | Email service account |
| `GMAIL_DELEGATED_USER` | Account impersonato Gmail API (= `GMAIL_SENDER_ADDRESS`) |
| `GMAIL_SENDER_ADDRESS` | Mittente mail inviti (= `GMAIL_DELEGATED_USER`) |
| `GOOGLE_SERVICE_ACCOUNT_KEY_JSON` | Chiave JSON Service Account GCP |
| `GCP_PROJECT_ID` | ID progetto GCP |
| `CLOUD_TASKS_QUEUE_ABSENCES` | Nome coda Cloud Tasks assenze |
| `CLOUD_TASKS_QUEUE_INVOICES` | Nome coda Cloud Tasks fatture |
| `CLOUD_TASKS_LOCATION` | Regione Cloud Tasks |
| `FURIOUS_BASE_URL` | URL base Furious (default prod, override per sandbox locale) |
| `FURIOUS_USERNAME` | Credenziali Furious API |
| `FURIOUS_PASSWORD` | Credenziali Furious API |
| `SENTRY_DSN` | DSN Sentry (opzionale in locale) |
