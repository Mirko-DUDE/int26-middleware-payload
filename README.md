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
├── collections/     # Schema dati PayloadCMS
├── workers/         # Logic asincrona (assenze, fatture)
├── webhooks/        # Endpoint ricezione webhook
└── lib/             # Client Furious API, Starty API, GCP
```

## Link utili

- Furious: https://dude.furious-squad.com
- Starty: https://dude.startyerp.cloud
- PayloadCMS docs: https://payloadcms.com/docs
