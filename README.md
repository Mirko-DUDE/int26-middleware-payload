# int26-middleware-payload

Middleware PayloadCMS per l'integrazione tra **Furious ERP** e **Starty ERP**.

## Cosa fa

Questo sistema automatizza due flussi di integrazione tra i sistemi ERP aziendali:

**Release 1 — Auto-approvazione Assenze** (in sviluppo)
Quando un manager richiede un'assenza su Furious, il middleware la approva automaticamente
senza richiedere intervento manuale, tramite le API Furious.

**Release 2 — Sincronizzazione Fatture Passive** (stand-by)
Quando una fattura passiva viene confermata su Starty, il middleware crea una scheda
di revisione per l'amministrazione che, dopo verifica, può inviarla a Furious con un click.

## Stack

- **PayloadCMS** (Next.js App Router) — framework principale e admin UI
- **PostgreSQL** (Google Cloud SQL) — database
- **Google Cloud Tasks** — code asincrone per i worker
- **Google Cloud Run** — hosting containerizzato
- **Google Secret Manager** — gestione sicura dei token API

## Documentazione

| Documento | Destinatario |
|-----------|--------------|
| `docs/project/` | Sviluppatori — documentazione completa in italiano |
| `docs/project/060-absence-flow.md` | Sviluppatori — flusso assenze completo, state machine, scenari di test |
| `.cursor/rules/` | Agenti AI — regole e pattern tecnici per Cursor |
| `DECISIONS.md` | Tutti — log decisioni architetturali e bug risolti |
| `AGENTS.md` | Agenti AI — regole PayloadCMS + contesto progetto |

## Avvio in locale

```bash
pnpm install
cp .env.example .env
# Configurare le variabili in .env
pnpm dev
```

## Struttura principale

```
src/
├── collections/     # Schema dati PayloadCMS (AbsenceLog, AutoApprovalRules, Users, ...)
├── endpoints/       # Endpoint webhook pubblici e worker interni
├── workers/         # Logica asincrona dei worker (processAbsence, ...)
├── services/        # Servizi trasversali (mailer, ...)
└── lib/             # Client Furious API, GCP Tasks, Secret Manager, monitoring
```

## Test in locale

> In locale **Cloud Tasks non è attivo**: il webhook crea il record su DB ma non chiama il worker automaticamente.
> Il secondo `curl` in ogni scenario simula la chiamata che Cloud Tasks farebbe in produzione.

**Prerequisiti:**

1. Avere almeno un record in `AutoApprovalRules` con il pseudo da testare.
   Creabile da PayloadCMS admin → `/admin/collections/auto-approval-rules`
2. Variabile `WORKER_DEV_SECRET` impostata in `.env`

```bash
SERVER=http://localhost:3000
SECRET=$WORKER_DEV_SECRET
```

---

### Scenario 1 — Pseudo presente in AutoApprovalRules → `approved`

```bash
# 1. Invia il webhook
curl -s -X POST "$SERVER/api/webhooks/furious/absence" \
  -H "Content-Type: application/json" \
  -d '{"id": 12345, "pseudo": "mario.rossi"}'

# 2. Chiama il worker (simula Cloud Tasks)
curl -s -X POST "$SERVER/api/workers/absence" \
  -H "Content-Type: application/json" \
  -H "x-worker-dev-secret: $SECRET" \
  -d '{"absenceLogId": "<id-dal-passo-1>", "furiousAbsenceId": 12345, "pseudo": "mario.rossi", "attempt": 1}'
```

**Stato finale atteso:** `approved`
**Verifica:** `/admin/collections/absence-log`

---

### Scenario 2 — Pseudo assente → `skipped`

```bash
# 1. Invia il webhook
curl -s -X POST "$SERVER/api/webhooks/furious/absence" \
  -H "Content-Type: application/json" \
  -d '{"id": 99999, "pseudo": "pseudo.non.in.lista"}'

# 2. Chiama il worker
curl -s -X POST "$SERVER/api/workers/absence" \
  -H "Content-Type: application/json" \
  -H "x-worker-dev-secret: $SECRET" \
  -d '{"absenceLogId": "<id-dal-passo-1>", "furiousAbsenceId": 99999, "pseudo": "pseudo.non.in.lista", "attempt": 1}'
```

**Stato finale atteso:** `skipped`
**Verifica:** `/admin/collections/absence-log`

---

### Scenario 3 — Payload non valido → `400`, nessun record creato

```bash
curl -s -X POST "$SERVER/api/webhooks/furious/absence" \
  -H "Content-Type: application/json" \
  -d '{"foo": "bar"}'
```

**Risposta attesa:** HTTP `400`
**Verifica:** nessun nuovo record in `/admin/collections/absence-log`

---

### Scenario 4 — Errore Furious simulato → `failed_permanent` dopo 5 tentativi

Imposta credenziali Furious errate in `.env` (`FURIOUS_EMAIL` o `FURIOUS_PASSWORD` sbagliati), poi:

```bash
# 1. Invia il webhook
curl -s -X POST "$SERVER/api/webhooks/furious/absence" \
  -H "Content-Type: application/json" \
  -d '{"id": 11111, "pseudo": "mario.rossi"}'

# 2. Chiama il worker 5 volte con attempt crescente
for ATTEMPT in 1 2 3 4 5; do
  curl -s -X POST "$SERVER/api/workers/absence" \
    -H "Content-Type: application/json" \
    -H "x-worker-dev-secret: $SECRET" \
    -d "{\"absenceLogId\": \"<id-dal-passo-1>\", \"furiousAbsenceId\": 11111, \"pseudo\": \"mario.rossi\", \"attempt\": $ATTEMPT}"
  echo "--- attempt $ATTEMPT completato ---"
done
```

**Stato finale atteso:** `failed_permanent` (con `attempts: 5` e `lastError` valorizzato)
**Verifica:** `/admin/collections/absence-log` — controllare anche che sia arrivata l'email di notifica a `BOOTSTRAP_ADMIN_EMAIL`

---

## Link utili

- Furious: https://dude.furious-squad.com
- Starty: https://dude.startyerp.cloud
- PayloadCMS docs: https://payloadcms.com/docs
