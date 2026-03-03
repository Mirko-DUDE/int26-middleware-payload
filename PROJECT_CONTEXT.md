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

### Cosa deve essere fatto ora

**TASK CORRENTE: Sottofase A — Parte Comune**

Da completare in ordine, prima di qualsiasi cosa specifica al flusso assenze:

- [x] **A1 — Schema dati PayloadCMS** ✓ completato
- [ ] **A2 — Architettura dei Worker** ← PROSSIMO
- [ ] **A3 — Sistema autenticazione e ruoli**
- [ ] **A4 — Sistema logging e osservabilità**
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
| Secrets | Google Secret Manager | Token API, HMAC secrets — mai in env vars |
| Logging | Cloud Logging + Sentry | System logs + error tracking |
| Auth utenti | Google SSO (OAuth2) | Accesso solo utenti dominio aziendale |

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

**Livello 1 (attuale):** permessi come oggetto TypeScript statico in `permissions.ts`.
Modificare i permessi = modifica al codice + deploy.

**Livello 2 (futuro — debito tecnico):** riscrivere solo `permissions.ts` per leggere
da una Collection PayloadCMS (`PermissionRules`). Zero modifiche alle Collection.
Trigger consigliato: quando un admin non-tecnico necessita di modificare i permessi
più di una volta al mese. Voce registrata in `DECISIONS.md`.

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
Aggiungere una tipologia = aggiungere Collection slug + env var + voce in `gcsStorage`.

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
| `Users` | `Users.ts` | `Sistema` | esistente | estendere con `role` |
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
- `AutoApprovalRules` ha campo `flowType` per riutilizzo su flussi futuri (non solo assenze).
- Il sistema permessi usa Pattern Adapter: vedi §3 e `src/access/permissions.ts`.
- Indici su tutti i campi in `where`/`orderBy`: `pseudo`, `status`, `furiousAbsenceId`, `createdAt`.

### State machine AbsenceLog

```
received → processing → approved         (pseudo in AutoApprovalRules, PUT Furious ok)
                     → skipped           (pseudo non in AutoApprovalRules)
                     → failed_permanent  (5 tentativi o errore non-retriable)
```

### Estensione Users

Aggiungere campo `role` con `saveToJWT: true`. Valori: `admin` | `hr` |
`amministrazione` | `sistema`. Il ruolo è nel JWT — nessun lookup DB per ogni richiesta.

### Media GCS multi-bucket (progettato, implementare a richiesta)

Ogni tipologia di media = Collection dedicata + bucket GCS da env var.
Plugin `@payloadcms/storage-gcs` per-collection in `payload.config.ts`.
Tutte le Collection media usano `admin.group: 'Media'`.

---

## 7. Ruoli utente — da implementare in A3

| Ruolo | Descrizione | Accesso |
|-------|-------------|---------|
| `admin` | Amministratore sistema | Tutto, incluse AutoApprovalRules |
| `hr` | HR aziendale | AbsenceLog (read only) |
| `amministrazione` | Ufficio amministrativo | InvoicePendingReview (read/write), InvoiceLog (read) |
| `sistema` | Service account worker | Scrittura log, nessuna UI |

Autenticazione: Google SSO con OAuth2 — accesso solo utenti dominio aziendale.
I ruoli si salvano nel JWT (`saveToJWT: true`) per evitare lookup DB ad ogni richiesta.

---

## 8. Autenticazione API esterne — da implementare in A2

### Pattern comune (identico per entrambe le API)
```typescript
// Pattern getFuriousToken() / getStartyToken()
// 1. Legge token e timestamp da Secret Manager
// 2. Se valido (non scaduto): restituisce token
// 3. Se scaduto o assente: chiama endpoint auth, salva nuovo token in Secret Manager
// 4. Se chiamata riceve 401: forza rinnovo, riprova una volta sola
// 5. Se secondo tentativo fallisce: lancia errore non-retriable
```

### Furious Auth
- Endpoint: `POST /api/v2/auth/`
- Body: `{ "action": "auth", "data": { "email": "...", "password": "..." } }`
- Response header: `F-Auth-Token`
- Token storage: GCP Secret Manager key `furious-auth-token` + `furious-auth-token-expires`

### Starty Auth (3 step)
- Step 1: BasicAuth → ottieni token ruolo
- Step 2: token ruolo → seleziona organizzazione → ottieni token org
- Step 3: token org → JWT finale
- Token storage: GCP Secret Manager key `starty-jwt-token` + `starty-jwt-expires`

---

## 9. Struttura src/ attesa — da costruire

```
src/
├── app/
│   ├── (frontend)/          # UI operatori
│   └── (payload)/           # Admin PayloadCMS (già presente)
├── collections/
│   ├── Users.ts             # ← ESTENDERE con campo role
│   ├── Media.ts             # ← NON TOCCARE
│   ├── AutoApprovalRules.ts # ← CREARE [R1]
│   ├── AbsenceLog.ts        # ← CREARE [R1]
│   ├── InvoicePendingReview.ts # ← PROGETTARE [R2]
│   └── InvoiceLog.ts        # ← PROGETTARE [R2]
├── access/
│   └── permissions.ts       # ← CREARE — unica fonte di verità permessi
├── hooks/
│   └── setProcessedAtOnTerminalStatus.ts  # ← CREARE [R1] — hook audit log
├── workers/
│   ├── absence/
│   │   └── processAbsence.ts    # [R1]
│   └── invoice/
│       └── processInvoice.ts    # [R2]
├── webhooks/
│   ├── furious/
│   │   └── absence.ts           # endpoint ricezione [R1]
│   └── starty/
│       └── invoice.ts           # endpoint ricezione [R2]
├── lib/
│   ├── furious/
│   │   ├── auth.ts              # getFuriousToken()
│   │   └── api.ts               # chiamate API tipizzate
│   ├── starty/
│   │   ├── auth.ts              # getStartyToken()
│   │   └── api.ts
│   ├── gcp/
│   │   ├── tasks.ts             # enqueueTask() generico
│   │   └── secrets.ts           # getSecret(), setSecret()
│   └── hmac/
│       └── verify.ts            # verifyWebhookSignature() generico
└── payload.config.ts            # ← DA AGGIORNARE con nuove collection
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
| Furious API | `030-furious-api.md` | `030-furious-api.mdc` |
| Starty API | `040-starty-api.md` | `040-starty-api.mdc` |
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

## 13. Task corrente — A2: Architettura dei Worker

### Obiettivo
Progettare il layer di esecuzione asincrona: come i worker ricevono i task da
Cloud Tasks, come gestiscono il ciclo di vita (tentativi, backoff, dead letter),
come comunicano con le API esterne, e come aggiornano i log in PayloadCMS.

### Da produrre
1. Specifiche `src/workers/absence/processAbsence.ts` — interfaccia, input, output,
   gestione errori retriable vs non-retriable
2. Specifiche `src/lib/gcp/tasks.ts` — `enqueueTask()` generico con parametri
   queue, payload, delay, deduplication key
3. Pattern idempotency — come il worker verifica se un task è già stato processato
4. Pattern aggiornamento log — sequenza atomica status update in PayloadCMS
5. Documento `docs/project/020-workers.md`
6. Regola `.cursor/rules/020-worker-patterns.mdc`

### Vincoli
- Il worker deve essere stateless: tutto lo stato è in PayloadCMS DB
- Idempotency: doppia ricezione dello stesso task non deve causare doppia approvazione
- Il worker risponde 5xx per errori retriable, 200 per errori non-retriable (blocca retry)
- Backoff Cloud Tasks assenze: 30s → 2min → 8min → 30min → 1h (×4)
- Dead Letter Queue dopo 5 tentativi → notifica admin (meccanismo da definire in A4)


---

## 14. Come mantenere questo documento aggiornato

Questo file è la fonte di verità del progetto. Va aggiornato ogni volta che:

- Cambia lo stato di avanzamento (aggiornare le checkbox in §2)
- Si prende una decisione architetturale che non era prevista (aggiungere in §3)
- Si completa una sottofase A o B (aggiornare §2 e §13 con il task successivo)
- Si ricevono risposte dall'amministrazione sul flusso fatture (aggiornare §5)
- Cambia un pattern tecnico (worker, auth, error handling — aggiornare §4-§8)

**Non duplicare** informazioni già nei file `.cursor/rules/` o `docs/project/` —
questo documento dà il contesto e punta agli altri file per i dettagli.
