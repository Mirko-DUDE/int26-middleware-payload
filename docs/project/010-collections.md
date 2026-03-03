# 010 — Schema Collections PayloadCMS

> Documento per sviluppatori. Descrive tutte le Collection del progetto, la loro struttura,
> le relazioni, i pattern di accesso e le decisioni di design.
> Aggiornare dopo ogni modifica allo schema o alle regole di accesso.

---

## Indice

1. [Principi di design](#1-principi-di-design)
2. [Sistema permessi — Pattern Adapter](#2-sistema-permessi--pattern-adapter)
3. [Groups UI Admin](#3-groups-ui-admin)
4. [Collection: Users](#4-collection-users)
5. [Collection: AutoApprovalRules](#5-collection-autoapprovalrules)
6. [Collection: AbsenceLog](#6-collection-absencelog)
7. [Collection: InvoicePendingReview](#7-collection-invoicependingreview-r2)
8. [Collection: InvoiceLog](#8-collection-invoicelog-r2)
9. [Media e storage GCS multi-bucket](#9-media-e-storage-gcs-multi-bucket)
10. [State machine dei log](#10-state-machine-dei-log)
11. [Indici e performance](#11-indici-e-performance)

---

## 1. Principi di design

Ogni Collection è progettata con **estensibilità by design**: le decisioni prese ora
devono ridurre l'attrito per l'aggiunta di nuovi flussi, entità e sistemi in futuro.

**Regole generali:**

- Ogni Collection di log ha sempre: `status`, `rawPayload` (JSONB), `attempts`,
  `lastError`, `processedAt`, più gli ID dei sistemi esterni coinvolti.
- I campi di audit (`createdAt`, `updatedAt`, chi ha fatto cosa) sono automatici
  via hooks PayloadCMS — mai editabili manualmente dall'UI.
- Il campo `status` è una state machine esplicita, non un testo libero.
- Gli indici coprono tutti i campi usati in query frequenti.
- Le Collection di configurazione (`AutoApprovalRules`) hanno il campo `flowType`
  per distinguere l'utilizzo tra flussi diversi in futuro.

---

## 2. Sistema permessi — Pattern Adapter

### Architettura

Il controllo accessi usa un **Pattern Adapter** con `src/access/permissions.ts`
come **unica fonte di verità** per tutti i permessi del progetto.

Le Collection non contengono logica di accesso inline. Chiamano esclusivamente:

```typescript
import { canRead, canWrite } from '@/access/permissions'

// Nella Collection:
access: {
  read: canRead('absenceLog'),
  create: canWrite('absenceLog'),
  update: canWrite('absenceLog'),
  delete: () => false,
}
```

### Livello 1 — Permessi statici (implementazione attuale)

`permissions.ts` implementa i permessi come oggetto TypeScript statico. Modificare
i permessi richiede una modifica al codice e un nuovo deploy.

```typescript
// src/access/permissions.ts — Livello 1 (attuale)

type Resource =
  | 'autoApprovalRules'
  | 'absenceLog'
  | 'invoicePendingReview'
  | 'invoiceLog'

type Role = 'admin' | 'hr' | 'amministrazione' | 'sistema'

const PERMISSIONS: Record<Resource, { read: Role[]; write: Role[] }> = {
  autoApprovalRules:    { read: ['admin'],                         write: ['admin'] },
  absenceLog:           { read: ['admin', 'hr'],                   write: ['admin', 'sistema'] },
  invoicePendingReview: { read: ['admin', 'amministrazione'],       write: ['admin', 'amministrazione'] },
  invoiceLog:           { read: ['admin', 'amministrazione'],       write: ['admin', 'sistema'] },
}

export function canRead(resource: Resource) {
  return ({ req }: { req: PayloadRequest }) => {
    const role = req.user?.role as Role | undefined
    return role ? PERMISSIONS[resource].read.includes(role) : false
  }
}

export function canWrite(resource: Resource) {
  return ({ req }: { req: PayloadRequest }) => {
    const role = req.user?.role as Role | undefined
    return role ? PERMISSIONS[resource].write.includes(role) : false
  }
}
```

### Livello 2 — RBAC dinamico (futuro, non implementato)

Quando la gestione dei permessi diventa operativa e richiede modifiche senza deploy,
si può riscrivere **solo `permissions.ts`** per leggere i permessi da una Collection
PayloadCMS (`PermissionRules`) invece che dall'oggetto statico.

**Zero modifiche alle Collection.** L'interfaccia `canRead(resource)` / `canWrite(resource)`
rimane identica. La migrazione è trasparente al resto del codice.

Vedere `DECISIONS.md` per la voce di debito tecnico su questa decisione.

---

## 3. Groups UI Admin

Ogni Collection appartiene a un gruppo nell'Admin UI di PayloadCMS. Questo organizza
la sidebar e separa visivamente le aree funzionali.

| Gruppo | Collection |
|--------|-----------|
| `Assenze` | `AutoApprovalRules`, `AbsenceLog` |
| `Fatture` | `InvoicePendingReview`, `InvoiceLog` |
| `Sistema` | `Users` |
| `Media` | `Media` (default PayloadCMS) |
| `Configurazione` | _(placeholder per Globals futuri)_ |

Configurazione in ogni Collection:

```typescript
admin: {
  group: 'Assenze', // o 'Fatture', 'Sistema', ecc.
  // ...altri admin config
}
```

---

## 4. Collection: Users

**File:** `src/collections/Users.ts`
**Scopo:** Utenti dell'Admin UI. Già presente — da estendere con il campo `role`.
**Group UI:** `Sistema`

### Campi aggiunti

```typescript
// Campo name — valorizzato al primo login Google
{ name: 'name', type: 'text' }

// Campo role — nel JWT per evitare DB lookup
{
  name: 'role',
  type: 'select',
  required: true,
  defaultValue: 'hr',
  saveToJWT: true,
  options: [
    { label: 'Admin',           value: 'admin' },
    { label: 'HR',              value: 'hr' },
    { label: 'Amministrazione', value: 'amministrazione' },
    // 'sistema' NON appare qui — è un ruolo interno non assegnabile da UI
  ],
  access: { update: ({ req: { user } }) => user?.role === 'admin' },
}

// Campo status — nel JWT per bloccare sospesi senza DB lookup
{
  name: 'status',
  type: 'select',
  required: true,
  defaultValue: 'invited',
  saveToJWT: true,
  options: [
    { label: 'Invitato',  value: 'invited' },
    { label: 'Attivo',    value: 'active' },
    { label: 'Sospeso',   value: 'suspended' },
  ],
  access: { update: ({ req: { user } }) => user?.role === 'admin' },
}
```

`saveToJWT: true` su entrambi `role` e `status` è critico: worker e API route leggono
il ruolo e lo stato direttamente dal token senza query aggiuntive al DB.

### Autenticazione

Google SSO (OAuth2) — `disableLocalStrategy: true`. Solo utenti del dominio aziendale.
Il service account dei worker usa il ruolo `sistema` con autenticazione via Cloud Tasks
OIDC token, non via UI login. Vedi `030-auth-roles.mdc` per il pattern completo.

---

## 5. Collection: AutoApprovalRules

**File:** `src/collections/AutoApprovalRules.ts`
**Scopo:** Lista dei pseudo manager che ricevono auto-approvazione automatica delle assenze.
Estensibile ad altri flussi tramite il campo `flowType`.
**Group UI:** `Assenze`
**Release:** R1

### Schema campi

```typescript
{
  slug: 'auto-approval-rules',
  admin: {
    group: 'Assenze',
    useAsTitle: 'pseudo',
    defaultColumns: ['pseudo', 'flowType', 'note', 'updatedAt'],
    description: 'Regole di auto-approvazione per pseudo manager.',
  },
  access: {
    read:   canRead('autoApprovalRules'),
    create: canWrite('autoApprovalRules'),
    update: canWrite('autoApprovalRules'),
    delete: canWrite('autoApprovalRules'),
  },
  fields: [
    {
      name: 'pseudo',
      type: 'text',
      required: true,
      unique: true,          // un pseudo ha una sola regola per flowType
      index: true,           // ricerca frequente nel worker assenze
      admin: {
        description: 'Pseudonimo su Furious (case-sensitive).',
      },
    },
    {
      name: 'flowType',
      type: 'select',
      required: true,
      defaultValue: 'absence',
      options: [
        { label: 'Assenze', value: 'absence' },
        // aggiungere valori qui per flussi futuri
      ],
      index: true,
      admin: {
        description: 'Tipo di flusso a cui si applica la regola.',
      },
    },
    {
      name: 'note',
      type: 'textarea',
      admin: {
        description: 'Note operative opzionali (non usate dal sistema).',
      },
    },
  ],
  timestamps: true,           // createdAt, updatedAt automatici
}
```

### Indici

| Campo | Tipo indice | Motivazione |
|-------|-------------|-------------|
| `pseudo` | `unique` (implicito) | lookup diretto nel worker |
| `pseudo` + `flowType` | compound | query `WHERE pseudo = ? AND flowType = ?` |
| `flowType` | semplice | filtro UI per tipo flusso |

### Note di design

Il campo `flowType` rende la Collection riutilizzabile. Se in futuro si aggiunge un
flusso fatture con logica di auto-approvazione per pseudo, basta aggiungere un valore
all'enum — nessuna nuova Collection necessaria.

---

## 6. Collection: AbsenceLog

**File:** `src/collections/AbsenceLog.ts`
**Scopo:** Audit log completo di ogni evento assenza ricevuto e processato.
Ogni webhook crea un record; il worker lo aggiorna durante il processing.
**Group UI:** `Assenze`
**Release:** R1

### Schema campi

```typescript
{
  slug: 'absence-log',
  admin: {
    group: 'Assenze',
    useAsTitle: 'furiousAbsenceId',
    defaultColumns: ['furiousAbsenceId', 'pseudo', 'status', 'createdAt'],
    description: 'Log di tutti gli eventi assenza ricevuti da Furious.',
  },
  access: {
    read:   canRead('absenceLog'),
    create: canWrite('absenceLog'),   // solo sistema (webhook handler)
    update: canWrite('absenceLog'),   // solo sistema (worker)
    delete: () => false,              // mai cancellare log — audit trail
  },
  fields: [
    // --- Identità evento ---
    {
      name: 'furiousAbsenceId',
      type: 'number',
      required: true,
      index: true,
      admin: { description: 'ID assenza su Furious (campo `id` del webhook).' },
    },
    {
      name: 'pseudo',
      type: 'text',
      required: true,
      index: true,
      admin: { description: 'Pseudonimo richiedente (campo `pseudo` del webhook).' },
    },
    // --- Dati assenza dal webhook ---
    {
      name: 'startDate',
      type: 'date',
      required: true,
      admin: { description: 'Data inizio assenza (campo `start_date`).' },
    },
    {
      name: 'endDate',
      type: 'date',
      required: true,
      admin: { description: 'Data fine assenza (campo `end_date`).' },
    },
    {
      name: 'absenceType',
      type: 'text',
      required: true,
      admin: { description: 'Tipo assenza (campo `type` — stringa completa da Furious).' },
    },
    {
      name: 'halfDay',
      type: 'select',
      options: [
        { label: 'Giornata intera', value: '0' },
        { label: 'Mattina',         value: '1' },
        { label: 'Pomeriggio',      value: '2' },
      ],
      admin: { description: 'Mezza giornata (campo `half_day`: 0=intera, 1=mattina, 2=pomeriggio).' },
    },
    // --- State machine ---
    {
      name: 'status',
      type: 'select',
      required: true,
      defaultValue: 'received',
      options: [
        { label: 'Ricevuto',           value: 'received' },
        { label: 'In elaborazione',    value: 'processing' },
        { label: 'Approvato',          value: 'approved' },
        { label: 'Saltato',            value: 'skipped' },
        { label: 'Fallito (permanente)', value: 'failed_permanent' },
      ],
      index: true,
      admin: {
        description: 'Stato del processing. Vedi state machine in 010-collections.md.',
        readOnly: true,     // solo il sistema aggiorna lo status
      },
    },
    // --- Audit processing ---
    {
      name: 'attempts',
      type: 'number',
      defaultValue: 0,
      admin: {
        description: 'Numero di tentativi di processing eseguiti dal worker.',
        readOnly: true,
      },
    },
    {
      name: 'lastError',
      type: 'textarea',
      admin: {
        description: 'Ultimo messaggio di errore (stringa o JSON serializzato).',
        readOnly: true,
      },
    },
    {
      name: 'processedAt',
      type: 'date',
      admin: {
        description: 'Timestamp del completamento del processing (approved/skipped/failed).',
        readOnly: true,
      },
    },
    // --- Payload grezzo ---
    {
      name: 'rawPayload',
      type: 'json',
      required: true,
      admin: {
        description: 'Payload originale del webhook Furious. Immutabile dopo creazione.',
        readOnly: true,
      },
    },
    // --- Cloud Tasks ---
    {
      name: 'taskName',
      type: 'text',
      admin: {
        description: 'Nome del task Cloud Tasks accodato (per debug e idempotency).',
        readOnly: true,
      },
    },
  ],
  timestamps: true,
  hooks: {
    beforeChange: [
      // hook che imposta processedAt automaticamente quando status → terminale
      setProcessedAtOnTerminalStatus,
    ],
  },
}
```

### Indici

| Campo | Tipo | Motivazione |
|-------|------|-------------|
| `furiousAbsenceId` | semplice | lookup per idempotency check nel webhook handler |
| `pseudo` | semplice | filtro UI HR per persona |
| `status` | semplice | filtro UI per stato, dashboard operativa |
| `createdAt` | semplice (automatico) | ordinamento cronologico |

---

## 7. Collection: InvoicePendingReview (R2)

**File:** `src/collections/InvoicePendingReview.ts`
**Scopo:** Coda di fatture che richiedono revisione manuale da parte dell'amministrazione.
**Group UI:** `Fatture`
**Release:** R2 — **non implementare ora, schema di riferimento per il futuro**

### Schema campi (struttura di base)

```typescript
{
  slug: 'invoice-pending-review',
  admin: {
    group: 'Fatture',
    useAsTitle: 'furiousInvoiceId',
    defaultColumns: ['furiousInvoiceId', 'status', 'createdAt'],
  },
  access: {
    read:   canRead('invoicePendingReview'),
    create: canWrite('invoicePendingReview'),
    update: canWrite('invoicePendingReview'),
    delete: () => false,
  },
  fields: [
    { name: 'furiousInvoiceId', type: 'number',   required: true, index: true },
    { name: 'startyInvoiceId',  type: 'text',      index: true },  // da definire in R2
    { name: 'purchaseOrder',    type: 'text' },                     // campo PO da chiarire
    { name: 'status',           type: 'select',    required: true, defaultValue: 'pending',
      options: [
        { label: 'In attesa',  value: 'pending' },
        { label: 'Revisionato', value: 'reviewed' },
        { label: 'Inviato',    value: 'sent' },
        { label: 'Fallito',    value: 'failed_permanent' },
      ],
      index: true,
    },
    { name: 'attempts',     type: 'number',   defaultValue: 0, admin: { readOnly: true } },
    { name: 'lastError',    type: 'textarea', admin: { readOnly: true } },
    { name: 'processedAt',  type: 'date',     admin: { readOnly: true } },
    { name: 'rawPayload',   type: 'json',     required: true, admin: { readOnly: true } },
    // campi specifici R2 da definire dopo risposte amministrazione
  ],
  timestamps: true,
}
```

---

## 8. Collection: InvoiceLog (R2)

**File:** `src/collections/InvoiceLog.ts`
**Scopo:** Audit log completo di ogni evento fattura processato.
**Group UI:** `Fatture`
**Release:** R2 — **non implementare ora**

### Schema campi (struttura di base)

Stesso pattern di `AbsenceLog` con i campi specifici fatture:

```typescript
fields: [
  { name: 'furiousInvoiceId', type: 'number', required: true, index: true },
  { name: 'startyInvoiceId',  type: 'text',   index: true },
  { name: 'status',           type: 'select', required: true, index: true,
    options: ['received', 'processing', 'sent', 'skipped', 'failed_permanent'],
  },
  { name: 'attempts',    type: 'number',   defaultValue: 0, admin: { readOnly: true } },
  { name: 'lastError',   type: 'textarea', admin: { readOnly: true } },
  { name: 'processedAt', type: 'date',     admin: { readOnly: true } },
  { name: 'rawPayload',  type: 'json',     required: true, admin: { readOnly: true } },
]
```

---

## 9. Media e storage GCS multi-bucket

**Progettato ora — implementato a richiesta.**

### Pattern

Ogni tipologia di media ha una Collection dedicata con il proprio bucket GCS.
Si usa `@payloadcms/storage-gcs` configurato per-collection.

```typescript
// payload.config.ts
import { gcsStorage } from '@payloadcms/storage-gcs'

export default buildConfig({
  plugins: [
    gcsStorage({
      collections: {
        'media-documents': {            // Collection slug
          bucket: process.env.GCS_BUCKET_DOCUMENTS!,   // mai hardcoded
        },
        'media-images': {
          bucket: process.env.GCS_BUCKET_IMAGES!,
        },
        // aggiungere collection/bucket a coppie
      },
    }),
  ],
})
```

### Regole

- Il bucket viene letto **sempre** da env vars — mai hardcoded nel codice.
- Ogni Collection media ha `admin.group: 'Media'`.
- La Collection `Media` default di PayloadCMS rimane invariata se non serve
  storage GCS per essa.
- Aggiungere una nuova tipologia = aggiungere una Collection + una env var + una voce
  in `gcsStorage({ collections: {...} })`.

### Env vars necessarie (una per bucket)

```bash
GCS_BUCKET_DOCUMENTS=int26-documents-prod
GCS_BUCKET_IMAGES=int26-images-prod
# aggiungere per ogni nuova tipologia
```

---

## 10. State machine dei log

### AbsenceLog

```
received ──► processing ──► approved
                       ├──► skipped
                       └──► failed_permanent
```

| Transizione | Chi la esegue | Quando |
|-------------|--------------|--------|
| `received` (stato iniziale) | Webhook handler | Al ricevimento del webhook |
| `received → processing` | Worker all'avvio | Prima di chiamare Furious API |
| `processing → approved` | Worker | PUT Furious API ok, pseudo in AutoApprovalRules |
| `processing → skipped` | Worker | Pseudo non in AutoApprovalRules |
| `processing → failed_permanent` | Worker | Dopo 5 tentativi falliti o errore non-retriable |

Gli stati `approved`, `skipped`, `failed_permanent` sono **terminali**: il campo
`processedAt` viene impostato automaticamente dall'hook `beforeChange` al momento
della transizione.

### InvoiceLog (R2 — da definire in dettaglio)

```
received ──► processing ──► sent
                       ├──► skipped
                       └──► failed_permanent
```

---

## 11. Indici e performance

Riepilogo di tutti gli indici definiti nelle Collection:

| Collection | Campo | Tipo indice |
|-----------|-------|-------------|
| `AutoApprovalRules` | `pseudo` | unique |
| `AutoApprovalRules` | `pseudo` + `flowType` | compound |
| `AutoApprovalRules` | `flowType` | semplice |
| `AbsenceLog` | `furiousAbsenceId` | semplice |
| `AbsenceLog` | `pseudo` | semplice |
| `AbsenceLog` | `status` | semplice |
| `AbsenceLog` | `createdAt` | semplice (automatico) |
| `InvoicePendingReview` | `furiousInvoiceId` | semplice |
| `InvoicePendingReview` | `startyInvoiceId` | semplice |
| `InvoicePendingReview` | `status` | semplice |
| `InvoiceLog` | `furiousInvoiceId` | semplice |
| `InvoiceLog` | `startyInvoiceId` | semplice |
| `InvoiceLog` | `status` | semplice |

Gli indici compound (`pseudo` + `flowType`) vanno definiti esplicitamente nello
schema Drizzle se non supportati nativamente da PayloadCMS per quel campo type.
