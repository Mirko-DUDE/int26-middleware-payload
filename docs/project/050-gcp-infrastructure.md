# 050 — Infrastruttura GCP — Specifiche di Provisioning

> **Fase:** Sottofase A — Fondamenta  
> **Stato:** ✅ Completato  
> **Autore:** Architettura di sistema  

---

## 1. Visione d'insieme

L'infrastruttura è interamente su **Google Cloud Platform** con approccio **serverless**: si paga solo per l'uso effettivo, nessun server da gestire, scala automaticamente a zero.

Componenti principali:
- **Cloud Run** — hosting dell'applicazione PayloadCMS containerizzata
- **Cloud SQL (PostgreSQL)** — database relazionale managed
- **Cloud Tasks** — coda asincrona per i webhook
- **Secret Manager** — storage sicuro di tutti i token API
- **Cloud Logging / Cloud Monitoring** — osservabilità (vedi doc 040)

---

## 2. Cloud Run

### 2.1 Configurazione servizio

| Parametro | Staging | Produzione |
|---|---|---|
| Nome servizio | `middleware-staging` | `middleware-prod` |
| Regione | `europe-west8` (Milano) | `europe-west8` (Milano) |
| Memoria min/max | 512Mi / 1Gi | 512Mi / 2Gi |
| CPU | 1 vCPU | 1 vCPU (auto-scaling) |
| Istanze minime | 0 (scala a zero) | 0 (scala a zero) |
| Istanze massime | 5 | 20 |
| Timeout richiesta | 60 secondi | 60 secondi |
| Concorrenza per istanza | 80 | 80 |
| Port | 3000 | 3000 |

### 2.2 Scala a zero — implicazioni

Con `min-instances: 0`, la prima richiesta dopo un periodo di inattività subisce un **cold start** di 2–5 secondi. Questo è accettabile perché:
- I webhook Furious vengono accodati su Cloud Tasks in meno di 200ms (l'endpoint di ricezione risponde prima del cold start completo)
- L'elaborazione asincrona non è time-sensitive al millisecondo

Se il cold start dovesse diventare un problema in produzione, aumentare `min-instances` a 1 (costo fisso ~25€/mese).

### 2.3 Variabili d'ambiente permesse

**Permesse come env vars (non sensibili):**
```
NODE_ENV=production          # o 'staging'
PORT=3000
LOG_LEVEL=info               # o 'warn' in produzione
DATABASE_URL=                # connection string Cloud SQL (via Cloud SQL Auth Proxy)
SERVER_URL=                  # URL pubblico del servizio Cloud Run
CLOUD_TASKS_QUEUE_ABSENCES=  # nome coda: 'queue-absences'
CLOUD_TASKS_QUEUE_INVOICES=  # nome coda: 'queue-invoices'
GCP_PROJECT_ID=              # ID progetto GCP
GCP_LOCATION=europe-west8
WORKER_BASE_URL=             # URL base per gli endpoint worker interni
SENTRY_DSN=                  # DSN Sentry (non è un segreto operativo)
```

**Vietate come env vars — vanno su Secret Manager:**
```
FURIOUS_AUTH_TOKEN           # ❌ mai come env var
FURIOUS_AUTH_TOKEN_EXPIRES   # ❌ mai come env var
STARTY_JWT_TOKEN             # ❌ mai come env var
STARTY_JWT_EXPIRES           # ❌ mai come env var
STARTY_WEBHOOK_SECRET        # ❌ mai come env var
```

### 2.4 Come i secret vengono montati

I secret di Secret Manager vengono montati come variabili d'ambiente al momento del deploy, non chiamati a runtime. Questo garantisce che ogni istanza abbia i valori corretti all'avvio senza latenze aggiuntive per le chiamate alle API GCP durante le richieste.

```bash
# Esempio comando deploy con secret montati
gcloud run deploy middleware-prod \
  --image gcr.io/PROJECT_ID/middleware:latest \
  --update-secrets=FURIOUS_AUTH_TOKEN=furious-auth-token:latest \
  --update-secrets=FURIOUS_AUTH_TOKEN_EXPIRES=furious-auth-token-expires:latest \
  --update-secrets=STARTY_JWT_TOKEN=starty-jwt-token:latest \
  --update-secrets=STARTY_JWT_EXPIRES=starty-jwt-expires:latest \
  --update-secrets=STARTY_WEBHOOK_SECRET=starty-webhook-secret:latest
```

---

## 3. Cloud SQL — PostgreSQL

### 3.1 Configurazione istanza

| Parametro | Staging | Produzione |
|---|---|---|
| Nome istanza | `middleware-db-staging` | `middleware-db-prod` |
| Versione PostgreSQL | 16 | 16 |
| Tier macchina | `db-f1-micro` (1 vCPU, 614MB RAM) | `db-g1-small` (1 vCPU, 1.7GB RAM) |
| Storage tipo | SSD | SSD |
| Storage iniziale | 10GB (auto-resize on) | 20GB (auto-resize on) |
| Storage massimo | 100GB | 500GB |
| Regione | `europe-west8` | `europe-west8` |
| Alta disponibilità | No | No (attivare se volume > 1000 webhook/giorno) |
| IP pubblico | No | No |
| IP privato | Sì (VPC nativo) | Sì (VPC nativo) |

### 3.2 Backup automatici

| Parametro | Valore |
|---|---|
| Backup automatici | Abilitati |
| Finestra backup | 03:00–04:00 (ora italiana) |
| Retention backup | 7 giorni (staging), 30 giorni (produzione) |
| Point-in-time recovery | Abilitato in produzione |
| Retention log transazionali | 7 giorni (per PITR) |

### 3.3 Connessioni e connection pooling

**Limiti connessioni:**
- Staging (`db-f1-micro`): max 25 connessioni PostgreSQL
- Produzione (`db-g1-small`): max 100 connessioni PostgreSQL

**Strategia connection pooling:**

Si usa **Cloud SQL Auth Proxy** in modalità Unix socket (non connessione diretta TCP). Il proxy viene eseguito come sidecar nel container Cloud Run.

```
Cloud Run Instance
├── PayloadCMS (porta 3000)
└── Cloud SQL Auth Proxy (socket: /cloudsql/PROJECT:REGION:INSTANCE)
    └── → Cloud SQL PostgreSQL
```

Il `DATABASE_URL` in questo setup usa il socket Unix:
```
postgresql://user:pass@localhost/dbname?host=/cloudsql/PROJECT:REGION:INSTANCE
```

**Perché Auth Proxy e non connessione diretta:**
- Non servono regole firewall IP — autenticazione tramite IAM GCP
- Il proxy gestisce automaticamente la rotazione dei certificati TLS
- Non esporre mai il database con IP pubblico

**Pool size per PayloadCMS (Drizzle ORM):**
```typescript
// drizzle.config.ts
pool: {
  max: 5,   // massimo 5 connessioni per istanza Cloud Run
  min: 1,
  idleTimeoutMillis: 30000,
}
// Con max 20 istanze Cloud Run → max 100 connessioni totali (entro il limite)
```

---

## 4. Cloud Tasks

### 4.1 Code configurate

Due code separate, una per flusso di business:

| Parametro | `queue-absences` | `queue-invoices` |
|---|---|---|
| Nome coda (staging) | `queue-absences-staging` | `queue-invoices-staging` |
| Nome coda (produzione) | `queue-absences-prod` | `queue-invoices-prod` |
| Regione | `europe-west8` | `europe-west8` |

### 4.2 Rate limiting

| Parametro | Valore | Motivazione |
|---|---|---|
| Max dispatches/secondo | 10 | Evita di saturare le API Furious |
| Max concurrent dispatches | 5 | Limita il carico su Cloud Run e il DB |
| Max task size | 100KB | Sufficiente per i payload Furious |

### 4.3 Retry configuration

Allineata con le decisioni prese in A2:

| Parametro | Valore |
|---|---|
| Max tentativi | 5 |
| Min backoff | 10 secondi |
| Max backoff | 3600 secondi (1 ora) |
| Max doublings | 5 (esponenziale: 10s → 20s → 40s → 80s → 160s → 1h cap) |
| Task retention dopo completamento | 24 ore |
| Task retention dopo fallimento | 168 ore (7 giorni) |

**Sequenza backoff effettiva:**
```
Tentativo 1: immediato
Tentativo 2: +10 secondi
Tentativo 3: +20 secondi
Tentativo 4: +40 secondi
Tentativo 5: +80 secondi
→ Dopo 5 fallimenti: task eliminato da Cloud Tasks, status 'dead-letter' su PostgreSQL
```

### 4.4 Dead Letter Queue

Cloud Tasks non ha una DLQ nativa come SQS. La gestione del "dead letter" è **applicativa**:

1. Il worker riceve il task al 5° tentativo (ultimo).
2. Se fallisce, aggiorna `webhook-logs.status = 'dead-letter'` su PostgreSQL.
3. Invia alert a Sentry e a Cloud Monitoring.
4. Cloud Tasks non riprova più il task (esauriti i tentativi).
5. Un operatore può vedere i task in dead-letter dall'interfaccia PayloadCMS e decidere se riprocessarli manualmente.

### 4.5 Autenticazione endpoint worker

Gli endpoint worker (chiamati da Cloud Tasks) devono essere protetti. Cloud Tasks può aggiungere un header OIDC token:

```typescript
// Configurazione task con OIDC token
const task = {
  httpRequest: {
    url: `${WORKER_BASE_URL}/api/workers/absence`,
    httpMethod: 'POST' as const,
    headers: { 'Content-Type': 'application/json' },
    body: Buffer.from(JSON.stringify(payload)).toString('base64'),
    oidcToken: {
      serviceAccountEmail: `middleware-sa@${GCP_PROJECT_ID}.iam.gserviceaccount.com`,
      audience: WORKER_BASE_URL,
    },
  },
  scheduleTime: { seconds: Date.now() / 1000 },
}
```

Il worker verifica il token OIDC in ingresso. Senza token valido: `401 Unauthorized`.

---

## 5. Secret Manager

### 5.1 Lista completa dei secret

| Nome secret | Contenuto | Rotazione |
|---|---|---|
| `furious-auth-token` | Bearer token autenticazione API Furious | Vedi §5.2 |
| `furious-auth-token-expires` | Timestamp scadenza token Furious (ISO 8601) | Insieme al token |
| `starty-jwt-token` | JWT di autenticazione API Starty | Vedi §5.2 |
| `starty-jwt-expires` | Timestamp scadenza JWT Starty (ISO 8601) | Insieme al token |
| `starty-webhook-secret` | Secret HMAC per verifica firma webhook Starty | Annuale |

### 5.2 Policy di rotazione

I token Furious e Starty hanno scadenza propria (dipende dalla configurazione dei rispettivi sistemi). La rotazione avviene in questo modo:

1. L'applicazione legge `furious-auth-token-expires` all'avvio (è montato come env var).
2. Se il token è scaduto o manca meno di 1 ora alla scadenza, il worker di refresh chiama l'API di autenticazione e ottiene un nuovo token.
3. Il nuovo token viene scritto su Secret Manager via API (`SecretManagerServiceClient.addSecretVersion()`).
4. Il servizio Cloud Run viene re-deployato con `--update-secrets` per montare la nuova versione. In alternativa, usare la funzionalità "latest" di Secret Manager (vedi nota sotto).

**Nota su versioni:** Montare sempre la versione `:latest` per ottenere automaticamente il secret aggiornato senza re-deploy:
```bash
--update-secrets=FURIOUS_AUTH_TOKEN=furious-auth-token:latest
```

### 5.3 Come Cloud Run accede ai secret

I secret vengono montati come variabili d'ambiente al deploy, non con chiamate runtime. Questo significa:
- Nessun import di `@google-cloud/secret-manager` nel codice applicativo.
- Nessuna latenza aggiuntiva per fetch dei secret durante le richieste.
- I secret sono disponibili come `process.env.FURIOUS_AUTH_TOKEN` nel codice.

**IAM necessaria per il service account di Cloud Run:**
```
roles/secretmanager.secretAccessor
```

---

## 6. Ambienti: Staging vs Produzione

### 6.1 Strategia: stesso progetto GCP con prefissi

Si usa un **singolo progetto GCP** con prefissi di ambiente nelle risorse. Questa scelta semplifica la gestione dei permessi e riduce l'overhead amministrativo, accettabile per un progetto di questa scala.

| Risorsa | Staging | Produzione |
|---|---|---|
| Cloud Run | `middleware-staging` | `middleware-prod` |
| Cloud SQL | `middleware-db-staging` | `middleware-db-prod` |
| Cloud Tasks (assenze) | `queue-absences-staging` | `queue-absences-prod` |
| Cloud Tasks (fatture) | `queue-invoices-staging` | `queue-invoices-prod` |
| Secret (token Furious) | `furious-auth-token-staging` | `furious-auth-token` |
| Secret (token Starty) | `starty-jwt-token-staging` | `starty-jwt-token` |
| Container image | `gcr.io/PROJECT/middleware:staging-SHA` | `gcr.io/PROJECT/middleware:prod-SHA` |

### 6.2 Strategia di promozione staging → produzione

```
1. Merge su branch `main` → build Docker automatica (CI/CD)
2. Deploy automatico su Cloud Run staging (tag: staging-<git-sha>)
3. Test E2E automatici + smoke test manuali su staging
4. Approvazione manuale (un secondo sviluppatore)
5. Deploy manuale su produzione con lo stesso image SHA già testato in staging
   (mai buildare una nuova image per il deploy in produzione)
```

### 6.3 Variabili che differiscono tra ambienti

```bash
# STAGING
NODE_ENV=staging
SERVER_URL=https://middleware-staging-xxx-ew.a.run.app
CLOUD_TASKS_QUEUE_ABSENCES=queue-absences-staging
CLOUD_TASKS_QUEUE_INVOICES=queue-invoices-staging
WORKER_BASE_URL=https://middleware-staging-xxx-ew.a.run.app

# PRODUZIONE
NODE_ENV=production
SERVER_URL=https://middleware-prod-xxx-ew.a.run.app  # o dominio custom
CLOUD_TASKS_QUEUE_ABSENCES=queue-absences-prod
CLOUD_TASKS_QUEUE_INVOICES=queue-invoices-prod
WORKER_BASE_URL=https://middleware-prod-xxx-ew.a.run.app
```

### 6.4 Webhook Furious per ambiente

- **Staging:** configurare in Furious un endpoint di test puntando all'URL staging.
- **Produzione:** solo dopo test E2E superati in staging, aggiornare l'URL in Furious.
- Non puntare mai il webhook di produzione Furious verso lo staging.

---

## 7. Checklist provisioning iniziale

Sequenza di operazioni per configurare l'infrastruttura da zero:

```
[ ] 1. Creare progetto GCP (o riusare esistente)
[ ] 2. Abilitare API: Cloud Run, Cloud SQL, Cloud Tasks, Secret Manager, Cloud Build
[ ] 3. Creare VPC e subnet privata per Cloud SQL
[ ] 4. Creare istanza Cloud SQL staging (db-f1-micro)
[ ] 5. Creare database e utente PostgreSQL
[ ] 6. Creare secret su Secret Manager (tutti e 5)
[ ] 7. Creare service account middleware-sa con permessi minimi
[ ] 8. Creare code Cloud Tasks staging (queue-absences-staging, queue-invoices-staging)
[ ] 9. Build Docker image e push su Container Registry
[ ] 10. Deploy Cloud Run staging con env vars e secret montati
[ ] 11. Verificare connessione DB tramite Auth Proxy
[ ] 12. Test webhook end-to-end in staging
[ ] 13. Replicare passi 4–11 per produzione
```
