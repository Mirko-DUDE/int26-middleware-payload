# PROJECT_CONTEXT.md
*Documento di riferimento per agenti AI e sviluppatori — aggiornato al completamento di A4 e A5*

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
| Autenticazione | Google OAuth2 SSO (dominio aziendale) | |

**iPaaS (Make/n8n/Zapier): esclusi definitivamente.**
**MongoDB: escluso definitivamente.**

---

## §3. Decisioni architetturali rilevanti

### Sicurezza
- Tutti i token API (`furious-auth-token`, `starty-jwt-token`, ecc.) vanno **esclusivamente** su Secret Manager, montati come env vars al deploy. Mai hardcodati, mai nel Dockerfile.
- Gli endpoint worker (`/api/workers/*`) sono protetti da OIDC token di Cloud Tasks. Non accessibili pubblicamente.
- Webhook Starty verificati con firma HMAC tramite `starty-webhook-secret`.

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
├── 010-data-schema.md          (A1) Schema collezioni PayloadCMS
├── 020-security-auth.md        (A2) Autenticazione, permessi, HMAC
├── 030-queue-workers.md        (A3) Pattern worker, Cloud Tasks, retry
├── 040-logging.md              (A4) ✅ Business audit log, Pino, Sentry, metriche
└── 050-gcp-infrastructure.md   (A5) ✅ Cloud Run, SQL, Tasks, Secret Manager, ambienti

.cursor/rules/
├── 010-data-schema.mdc
├── 020-security.mdc
├── 030-queue-workers.mdc
├── 040-logging.mdc             (A4) ✅
└── 050-gcp-config.mdc          (A5) ✅
```

---

## §5. Checklist fasi di progetto

### Sottofase A — Fondamenta (progettazione)
- [x] A1 — Modellazione dati e schema collezioni
- [x] A2 — Sicurezza, autenticazione, HMAC webhook
- [x] A3 — Pattern worker, Cloud Tasks, gestione retry
- [x] A4 — Sistema di logging e osservabilità
- [x] A5 — Infrastruttura GCP — specifiche provisioning

### Sottofase B — Release Assenze ← **TASK CORRENTE**
- [ ] B1 — Endpoint ricezione webhook assenze (`POST /api/webhooks/furious/absence`)
- [ ] B2 — Worker elaborazione assenza (crea `AbsenceRequest` in Payload)
- [ ] B3 — UI approvazione in PayloadCMS (pulsanti Approva/Rifiuta)
- [ ] B4 — Chiamata API Furious `PUT /api/v2/absence/` per aggiornamento stato
- [ ] B5 — Test E2E in staging + configurazione webhook in Furious (staging)
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

**Autenticazione:** Bearer token via `POST /api/v2/auth/` → risposta con `token` + `expires`.
**Assenze:** `PUT /api/v2/absence/` con `{id, status}` — status 1=Confermare, 2=Annullare.
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
