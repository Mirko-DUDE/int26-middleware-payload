# 030 — Sistema di Autenticazione e Ruoli

**Sottofase A / Task A3**  
**Stato:** Definizione completata — pronto per implementazione  
**Ultimo aggiornamento:** 2026-03-03 (rev.2 — closed by default, invite-based provisioning, Gmail API)

---

## Indice

1. [Panoramica e decisioni architetturali](#1-panoramica-e-decisioni-architetturali)
2. [Flusso OAuth2 Google SSO in PayloadCMS](#2-flusso-oauth2-google-sso-in-payloadcms)
3. [Collection Users: schema completo](#3-collection-users-schema-completo)
4. [Sistema di invito utenti](#4-sistema-di-invito-utenti)
5. [Registro centrale permessi — `src/access/permissions.ts`](#5-registro-centrale-permessi--srcaccesspermissionsts)
6. [Funzioni helper — `src/access/helpers.ts`](#6-funzioni-helper--srcaccesshelpersts)
7. [Come le Collection usano le funzioni di accesso](#7-come-le-collection-usano-le-funzioni-di-accesso)
8. [Service account `sistema` e autenticazione worker](#8-service-account-sistema-e-autenticazione-worker)
9. [Debito tecnico documentato](#9-debito-tecnico-documentato)

---

## 1. Panoramica e decisioni architetturali

Il sistema di autenticazione si basa su **Google SSO OAuth2** come unico metodo di accesso per gli utenti umani. Non esiste autenticazione tramite password locale — questa decisione è definitiva e non va rimessa in discussione.

Le motivazioni principali sono: eliminare la gestione delle password (riduzione della superficie d'attacco), sfruttare la SSO aziendale già esistente su Google Workspace, e garantire che solo gli utenti con un account del dominio aziendale possano accedere.

### Provisioning: closed by default

Il dominio aziendale conta più di cento utenti. **Non tutti devono avere accesso al sistema.** Per questo motivo il modello adottato è **invite-based provisioning**: nessun utente può accedere autonomamente, anche se ha una mail aziendale valida. L'accesso è possibile solo dopo che un admin ha creato esplicitamente il record utente con il ruolo corretto e inviato un invito.

Questo è il modello standard nei sistemi enterprise e garantisce tre proprietà fondamentali: **least privilege** (il ruolo è assegnato prima dell'accesso, non dopo), **audit trail** (ogni utente ha un creatore e una data di invito tracciata), **no self-service** (nessuno entra senza approvazione esplicita).

### Ruoli e JWT

Il sistema prevede quattro ruoli: `admin`, `hr`, `amministrazione`, `sistema`. I ruoli sono **ortogonali** — non esiste gerarchia tra `hr` e `amministrazione`, che operano su domini di dati completamente separati.

Ruolo e stato utente viaggiano nel JWT (`saveToJWT: true`). Questo elimina qualsiasi lookup al database per ogni richiesta autenticata — la verifica avviene interamente in memoria leggendo il payload del token.

---

## 2. Flusso OAuth2 Google SSO in PayloadCMS

### Plugin da utilizzare

Utilizzare il plugin ufficiale `@payloadcms/plugin-sso` oppure, in alternativa, la libreria `payload-plugin-oauth` (più flessibile per restrizioni di dominio). Al momento della scrittura, il plugin ufficiale è in beta — verificare la versione disponibile e scegliere quello più maturo.

La configurazione si aggiunge in `payload.config.ts`:

```typescript
import { oauthPlugin } from 'payload-plugin-oauth'

export default buildConfig({
  plugins: [
    oauthPlugin({
      databaseUri: process.env.DATABASE_URL,
      clientID: process.env.GOOGLE_CLIENT_ID,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET,
      authorizationURL: 'https://accounts.google.com/o/oauth2/v2/auth',
      tokenURL: 'https://oauth2.googleapis.com/token',
      callbackURL: `${process.env.PAYLOAD_PUBLIC_SERVER_URL}/oauth2/callback`,
      scope: 'openid email profile',

      async userinfo(accessToken) {
        const res = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
          headers: { Authorization: `Bearer ${accessToken}` },
        })
        const profile = await res.json()

        // Difesa in profondità: blocco dominio a livello applicativo.
        // Il progetto GCP di tipo "Internal" blocca già a monte, ma questo
        // secondo controllo protegge da misconfiguration futura su GCP.
        const ALLOWED_DOMAIN = process.env.ALLOWED_EMAIL_DOMAIN
        if (!profile.email?.endsWith(`@${ALLOWED_DOMAIN}`)) {
          throw new Error(`Accesso negato: solo utenti @${ALLOWED_DOMAIN}`)
        }

        return {
          email: profile.email,
          name: profile.name,
          sub: profile.sub,
        }
      },

      async findOrCreateUser({ email, name }) {
        // ── CLOSED BY DEFAULT ──────────────────────────────────────────────
        // Cerca un record pre-esistente creato dall'admin (status: 'invited'
        // oppure 'active'). Se non esiste, blocca l'accesso — anche se la
        // mail è del dominio aziendale.
        //
        // Eccezione: l'admin di bootstrap (BOOTSTRAP_ADMIN_EMAIL) viene
        // creato automaticamente al primo login perché è il primo utente
        // e non ha ancora nessun admin che lo possa invitare.
        // ──────────────────────────────────────────────────────────────────

        const bootstrapAdminEmail = process.env.BOOTSTRAP_ADMIN_EMAIL
        const isBootstrapAdmin = email === bootstrapAdminEmail

        const existingUser = await payload.find({
          collection: 'users',
          where: { email: { equals: email } },
        })

        // ── Caso 1: utente già presente nel DB ─────────────────────────────
        if (existingUser.docs.length > 0) {
          const user = existingUser.docs[0]

          // Blocca utenti sospesi — il JWT non viene emesso
          if (user.status === 'suspended') {
            throw new Error('Account sospeso. Contattare un amministratore.')
          }

          // Promuove bootstrap admin se necessario — non fa mai downgrade
          if (isBootstrapAdmin && user.role !== 'admin') {
            return await payload.update({
              collection: 'users',
              id: user.id,
              data: { role: 'admin', status: 'active' },
              overrideAccess: true,
            })
          }

          // Primo login dopo invito: porta lo status da 'invited' ad 'active'
          if (user.status === 'invited') {
            return await payload.update({
              collection: 'users',
              id: user.id,
              data: { status: 'active', name },
              overrideAccess: true,
            })
          }

          return user
        }

        // ── Caso 2: utente non presente nel DB ─────────────────────────────
        // Solo il bootstrap admin può creare un record senza invito.
        if (isBootstrapAdmin) {
          return await payload.create({
            collection: 'users',
            data: {
              email,
              name,
              role: 'admin',
              status: 'active',
            },
            overrideAccess: true,
          })
        }

        // Tutti gli altri: accesso negato
        throw new Error(
          'Accesso non autorizzato. Richiedere un invito a un amministratore.'
        )
      },
    }),
  ],
})
```

### Variabili d'ambiente richieste

```env
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...
PAYLOAD_PUBLIC_SERVER_URL=https://middleware.azienda.it
ALLOWED_EMAIL_DOMAIN=azienda.it
BOOTSTRAP_ADMIN_EMAIL=mario@azienda.it
SISTEMA_EMAIL=sistema@azienda.it
GMAIL_SENDER_ADDRESS=noreply@azienda.it
GMAIL_DELEGATED_USER=noreply@azienda.it
GOOGLE_SERVICE_ACCOUNT_KEY_JSON='{...}'   # da GCP Secret Manager
```

> **Comportamento di `BOOTSTRAP_ADMIN_EMAIL`:**
> - Al primo login crea il record con `role: 'admin'` e `status: 'active'` — nessun invito necessario.
> - Se il record esiste già con ruolo non-admin, lo promuove automaticamente.
> - **Non fa mai downgrade:** rimuovere la variabile env non altera il ruolo già persistito nel DB.
> - Tutti gli admin successivi vengono promossi da un admin esistente tramite UI di Payload.

### Configurazione Google Cloud Console

1. Creare un progetto OAuth in [console.cloud.google.com](https://console.cloud.google.com)
2. Impostare il tipo applicazione su **Internal** (Google Workspace) — blocca automaticamente account esterni al dominio
3. Aggiungere come **Authorized redirect URI**: `https://middleware.azienda.it/oauth2/callback`
4. Scaricare le credenziali e inserirle nelle variabili d'ambiente

### Flusso completo step-by-step

```
Admin crea utente in Payload UI
    │  (email + ruolo → status: 'invited')
    ▼
Hook afterChange invia mail di invito via Gmail API
    │  (mittente: noreply@azienda.it — stesso dominio, zero spam)
    ▼
Utente riceve mail, clicca "Accedi con Google"
    │
    ▼
Browser → GET /oauth2/authorize
    │  (redirect a Google con client_id, scope, hd=dominio)
    ▼
Google Login Page — utente si autentica con credenziali aziendali
    │
    ▼
Google verifica dominio (progetto Internal) + callback
    │
    ▼
POST /oauth2/callback → exchange code → access_token
    │
    ▼
userinfo() — verifica dominio @azienda.it [difesa in profondità]
    │  (se dominio errato → errore)
    ▼
findOrCreateUser() — cerca record pre-esistente
    │  (se non trovato → errore "richiedere invito")
    │  (se status: 'suspended' → errore "account sospeso")
    │  (se status: 'invited' → aggiorna a 'active')
    ▼
PayloadCMS genera JWT firmato { role, status }
    │
    ▼
Cookie httpOnly impostato sul browser
    │
    ▼
Redirect → /admin (dashboard con permessi del ruolo assegnato)
```

---

## 3. Collection Users: schema completo

```typescript
// src/collections/Users.ts
import type { CollectionConfig } from 'payload'
import { sendInviteEmailHook } from './hooks/sendInviteEmailHook'

export const Users: CollectionConfig = {
  slug: 'users',
  auth: {
    disableLocalStrategy: true, // solo OAuth — nessuna password locale
  },
  admin: {
    useAsTitle: 'email',
  },
  fields: [
    {
      name: 'name',
      type: 'text',
      required: true,
    },
    {
      name: 'role',
      type: 'select',
      required: true,
      saveToJWT: true, // ← CRITICO: il ruolo viaggia nel JWT, zero DB lookup
      options: [
        { label: 'Admin',            value: 'admin' },
        { label: 'HR',               value: 'hr' },
        { label: 'Amministrazione',  value: 'amministrazione' },
        // 'sistema' NON appare qui — è un service account tecnico,
        // creato via onInit con overrideAccess: true
      ],
      access: {
        update: ({ req: { user } }) => user?.role === 'admin',
      },
    },
    {
      name: 'status',
      type: 'select',
      required: true,
      defaultValue: 'invited',
      saveToJWT: true, // ← viaggia nel JWT per bloccare 'suspended' senza DB lookup
      options: [
        { label: 'Invitato',  value: 'invited' },   // record creato, primo login non ancora effettuato
        { label: 'Attivo',    value: 'active' },    // ha completato il primo login
        { label: 'Sospeso',   value: 'suspended' }, // accesso revocato, dati e audit trail intatti
      ],
      access: {
        update: ({ req: { user } }) => user?.role === 'admin',
      },
    },
    {
      name: 'invitedAt',
      type: 'date',
      admin: { readOnly: true },
    },
    {
      name: 'invitedBy',
      type: 'relationship',
      relationTo: 'users',
      admin: { readOnly: true },
    },
  ],
  hooks: {
    afterChange: [sendInviteEmailHook],
  },
}
```

### I quattro ruoli e i loro domini operativi

| Ruolo             | Dominio operativo                                        | Appare in UI |
|-------------------|----------------------------------------------------------|:------------:|
| `admin`           | Tutto — configurazione, gestione utenti, monitoraggio    | ✅           |
| `hr`              | AbsenceRequests — approva/rifiuta richieste ferie        | ✅           |
| `amministrazione` | InvoiceMappings — associa fatture passive ai progetti    | ✅           |
| `sistema`         | Worker asincroni — scrive log, crea record in background | ❌           |

### I tre stati utente

| Status      | Significato                                                          | Può accedere |
|-------------|----------------------------------------------------------------------|:------------:|
| `invited`   | Record creato dall'admin, primo login non ancora effettuato          | ✅ (al login diventa `active`) |
| `active`    | Utente operativo                                                     | ✅           |
| `suspended` | Accesso revocato — dati e audit trail preservati                     | ❌           |

> **Perché `suspended` invece di eliminare il record:** cancellare un utente rompe l'audit trail (chi ha approvato quale assenza, chi ha modificato quale fattura). La sospensione disabilita l'accesso mantenendo la storia operativa intatta.

### Service account `sistema`: creazione via onInit

```typescript
// All'interno dell'hook onInit in payload.config.ts
async onInit(payload) {
  const sistemaEmail = process.env.SISTEMA_EMAIL

  const existing = await payload.find({
    collection: 'users',
    where: { email: { equals: sistemaEmail } },
  })

  if (existing.docs.length === 0) {
    await payload.create({
      collection: 'users',
      data: {
        email: sistemaEmail,
        name: 'Sistema (Service Account)',
        role: 'sistema',   // non è nelle options UI ma è valido nel DB
        status: 'active',  // non passa mai per il flusso di invito
      },
      overrideAccess: true,
    })
  }
}
```

---

## 4. Sistema di invito utenti

### Panoramica

Quando un admin crea un nuovo utente dalla UI di Payload, il sistema invia automaticamente una mail di invito. La mail contiene un link che avvia il flusso Google SSO. Al completamento dell'autenticazione, `findOrCreateUser()` trova il record `invited`, lo porta ad `active`, e l'utente accede con il ruolo già assegnato dall'admin.

### Servizio email: Gmail API con Google Workspace

L'azienda dispone di Google Workspace Enterprise. Le mail vengono inviate tramite **Gmail API** usando un Service Account GCP con **domain-wide delegation** configurata su Google Workspace Admin Console. Il mittente è `noreply@azienda.it` — un indirizzo reale del dominio aziendale.

Vantaggi rispetto a servizi esterni (SendGrid, Resend):

- **Costo zero** — incluso nella licenza Workspace Enterprise già posseduta
- **Deliverability massima** — mittente e destinatario sullo stesso dominio Google, zero rischio spam
- **Nessuna dipendenza esterna** — l'ecosistema rimane interamente Google/GCP
- **Audit nativo** — le mail inviate sono visibili in Gmail come qualsiasi altra mail aziendale

### Configurazione Gmail API (una volta sola, in fase di setup)

**Su GCP:**
1. Abilitare la **Gmail API** nel progetto GCP esistente
2. Creare un Service Account dedicato (es. `mailer@progetto.iam.gserviceaccount.com`)
3. Scaricare la chiave JSON e salvarla in GCP Secret Manager come `GOOGLE_SERVICE_ACCOUNT_KEY_JSON`

**Su Google Workspace Admin Console** (richiede Super Admin):
1. Andare in *Sicurezza → Accesso e controllo dati → Controllo API → Gestisci la delega a livello di dominio*
2. Aggiungere il Client ID del Service Account
3. Autorizzare lo scope: `https://www.googleapis.com/auth/gmail.send`

> **Prerequisito operativo:** verificare subito chi ha il ruolo Super Admin di Google Workspace in azienda — questo passaggio di configurazione è il potenziale blocco durante il setup e richiede un accesso che non è in carico agli sviluppatori.

### Implementazione del mailer

```typescript
// src/services/mailer.ts
import { google } from 'googleapis'

/**
 * Invia una mail tramite Gmail API usando domain-wide delegation.
 * Il Service Account impersona GMAIL_DELEGATED_USER per inviare
 * a nome di noreply@azienda.it.
 */
export async function sendMail({
  to,
  subject,
  html,
}: {
  to: string
  subject: string
  html: string
}): Promise<void> {
  const serviceAccountKey = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_KEY_JSON!)

  const auth = new google.auth.JWT({
    email: serviceAccountKey.client_email,
    key: serviceAccountKey.private_key,
    scopes: ['https://www.googleapis.com/auth/gmail.send'],
    subject: process.env.GMAIL_DELEGATED_USER, // impersona noreply@azienda.it
  })

  const gmail = google.gmail({ version: 'v1', auth })

  // Gmail API richiede il messaggio in formato RFC 2822 codificato base64url
  const message = [
    `From: ${process.env.GMAIL_SENDER_ADDRESS}`,
    `To: ${to}`,
    `Subject: ${subject}`,
    'MIME-Version: 1.0',
    'Content-Type: text/html; charset=utf-8',
    '',
    html,
  ].join('\n')

  const encodedMessage = Buffer.from(message)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')

  await gmail.users.messages.send({
    userId: 'me',
    requestBody: { raw: encodedMessage },
  })
}
```

### Hook afterChange sulla collection Users

```typescript
// src/collections/hooks/sendInviteEmailHook.ts
import type { CollectionAfterChangeHook } from 'payload'
import { sendMail } from '../../services/mailer'

export const sendInviteEmailHook: CollectionAfterChangeHook = async ({
  doc,
  operation,
}) => {
  // Invia solo alla creazione — non ri-invia a ogni update (es. cambio ruolo)
  if (operation !== 'create') return doc

  // Non invia invito al service account sistema
  if (doc.role === 'sistema') return doc

  const loginUrl = `${process.env.PAYLOAD_PUBLIC_SERVER_URL}/oauth2/authorize`

  await sendMail({
    to: doc.email,
    subject: 'Sei stato invitato ad accedere al sistema',
    html: `
      <p>Ciao ${doc.name || doc.email},</p>
      <p>
        Un amministratore ti ha assegnato accesso al sistema
        con ruolo <strong>${doc.role}</strong>.
      </p>
      <p>
        <a href="${loginUrl}">Accedi con il tuo account Google aziendale</a>
      </p>
      <p>Usa il tuo indirizzo <strong>${doc.email}</strong> per autenticarti.</p>
      <p>Se non ti aspettavi questa mail, ignorala.</p>
    `,
  })

  return doc
}
```

### Gestione dei casi edge

**Utente non ha ricevuto la mail:** l'admin aggiorna il record dalla UI (anche solo una nota) per ri-triggerare l'hook. In alternativa, si espone una Custom Action "Reinvia invito" nella UI di Payload (vedi DT-AUTH-003).

**Utente invitato per errore:** l'admin sospende il record (`status: 'suspended'`). L'accesso è bloccato immediatamente al prossimo tentativo di login. Il record rimane per audit trail.

**Cambio ruolo di un utente attivo:** il nuovo ruolo è operativo al successivo login, quando viene emesso un nuovo JWT. Il JWT corrente rimane valido fino alla sua scadenza naturale — configurare la scadenza del JWT di Payload a valori brevi (massimo 2 ore) per minimizzare la finestra di disallineamento.

---

## 5. Registro centrale permessi — `src/access/permissions.ts`

### Filosofia del Pattern Adapter

Oggi i permessi sono statici (hardcoded per ruolo). In futuro potrebbero diventare dinamici (RBAC configurabile da UI, permessi per singolo progetto, ecc.).

Il Pattern Adapter separa l'**interfaccia pubblica** (`canRead`, `canWrite`) dall'**implementazione** (oggi statica, domani dinamica). Chi consuma le funzioni di accesso nelle Collection non deve mai sapere come vengono calcolati i permessi internamente.

### Implementazione

```typescript
// src/access/permissions.ts

import type { PayloadRequest } from 'payload'

// ─── Tipo: risorse del sistema ─────────────────────────────────────────────
export type Resource =
  | 'absenceRequests'
  | 'invoiceMappings'
  | 'webhookLogs'
  | 'users'
  | 'systemLogs'

// ─── Tipo: ruoli ────────────────────────────────────────────────────────────
export type UserRole = 'admin' | 'hr' | 'amministrazione' | 'sistema'

// ─── Interfaccia del Provider (il "contratto" stabile) ──────────────────────
interface PermissionProvider {
  canRead(role: UserRole, resource: Resource): boolean
  canWrite(role: UserRole, resource: Resource): boolean
}

// ─── Implementazione Livello 1: statica ─────────────────────────────────────
// DEBITO TECNICO DT-AUTH-001: questa mappa sarà sostituita da query DB
// quando si migra al Livello 2 (RBAC dinamico). L'interfaccia pubblica
// canRead/canWrite non cambierà.

const READ_PERMISSIONS: Record<UserRole, Resource[]> = {
  admin:           ['absenceRequests', 'invoiceMappings', 'webhookLogs', 'users', 'systemLogs'],
  hr:              ['absenceRequests', 'webhookLogs'],
  amministrazione: ['invoiceMappings', 'webhookLogs'],
  sistema:         ['absenceRequests', 'invoiceMappings'],
}

const WRITE_PERMISSIONS: Record<UserRole, Resource[]> = {
  admin:           ['absenceRequests', 'invoiceMappings', 'webhookLogs', 'users', 'systemLogs'],
  hr:              ['absenceRequests'],
  amministrazione: ['invoiceMappings'],
  sistema:         ['absenceRequests', 'invoiceMappings', 'webhookLogs', 'systemLogs'],
}

const staticPermissionProvider: PermissionProvider = {
  canRead(role, resource) {
    return READ_PERMISSIONS[role]?.includes(resource) ?? false
  },
  canWrite(role, resource) {
    return WRITE_PERMISSIONS[role]?.includes(resource) ?? false
  },
}

let activeProvider: PermissionProvider = staticPermissionProvider

/** @internal — solo per test e migrazione futura */
export function _setPermissionProvider(provider: PermissionProvider): void {
  activeProvider = provider
}

// ─── API pubblica — queste firme NON cambieranno mai ────────────────────────

/**
 * Verifica se il ruolo dell'utente può leggere la risorsa.
 * Blocca trasversalmente gli utenti con status 'suspended'.
 *
 * @example
 * access: { read: canRead('absenceRequests') }
 */
export function canRead(resource: Resource) {
  return ({ req }: { req: PayloadRequest }): boolean => {
    const user = req.user
    if (!user) return false
    if (user.status === 'suspended') return false
    return activeProvider.canRead(user.role as UserRole, resource)
  }
}

/**
 * Verifica se il ruolo dell'utente può scrivere sulla risorsa.
 * Blocca trasversalmente gli utenti con status 'suspended'.
 *
 * @example
 * access: { create: canWrite('absenceRequests') }
 */
export function canWrite(resource: Resource) {
  return ({ req }: { req: PayloadRequest }): boolean => {
    const user = req.user
    if (!user) return false
    if (user.status === 'suspended') return false
    return activeProvider.canWrite(user.role as UserRole, resource)
  }
}
```

> **Nota:** il controllo `status === 'suspended'` in `canRead`/`canWrite` è la terza linea di difesa, dopo il blocco in `findOrCreateUser()` e la scadenza del JWT. Garantisce che anche un JWT ancora valido emesso prima della sospensione non possa operare.

---

## 6. Funzioni helper — `src/access/helpers.ts`

Le funzioni helper sono predicati puri che operano sull'oggetto `user` estratto dal JWT. Servono per logica condizionale inline (hook, guard API interne) — non per le `access` delle Collection, dove si usa il registro centrale.

```typescript
// src/access/helpers.ts

import type { User } from 'payload/types'
import type { UserRole } from './permissions'

type MaybeUser = Pick<User, 'role' | 'status'> | null | undefined

function hasRole(user: MaybeUser, role: UserRole): boolean {
  return user?.role === role
}

/** L'utente è un amministratore di sistema con accesso totale */
export const isAdmin = (user: MaybeUser): boolean =>
  hasRole(user, 'admin')

/** L'utente appartiene all'ufficio HR — gestisce le richieste di assenza */
export const isHR = (user: MaybeUser): boolean =>
  hasRole(user, 'hr')

/** L'utente appartiene all'ufficio Amministrazione — gestisce le fatture */
export const isAmministrazione = (user: MaybeUser): boolean =>
  hasRole(user, 'amministrazione')

/**
 * L'utente è il service account del sistema.
 * Usare per proteggere gli endpoint interni chiamati dai worker.
 */
export const isSistema = (user: MaybeUser): boolean =>
  hasRole(user, 'sistema')

/** L'utente è operativo (non sospeso, ha completato il primo login) */
export const isActive = (user: MaybeUser): boolean =>
  user?.status === 'active'
```

---

## 7. Come le Collection usano le funzioni di accesso

### Pattern standard

Ogni Collection importa esclusivamente le funzioni pubbliche del registro centrale. Non si definisce mai logica di permesso inline.

```typescript
// src/collections/AbsenceRequests.ts
import type { CollectionConfig } from 'payload'
import { canRead, canWrite } from '../access/permissions'

export const AbsenceRequests: CollectionConfig = {
  slug: 'absenceRequests',
  access: {
    read:   canRead('absenceRequests'),
    create: canWrite('absenceRequests'),
    update: canWrite('absenceRequests'),
    delete: ({ req }) => req.user?.role === 'admin',
  },
}
```

```typescript
// src/collections/InvoiceMappings.ts
import type { CollectionConfig } from 'payload'
import { canRead, canWrite } from '../access/permissions'

export const InvoiceMappings: CollectionConfig = {
  slug: 'invoiceMappings',
  access: {
    read:   canRead('invoiceMappings'),
    create: canWrite('invoiceMappings'),
    update: canWrite('invoiceMappings'),
    delete: ({ req }) => req.user?.role === 'admin',
  },
}
```

### Pattern per gli endpoint worker (`overrideAccess: true`)

```typescript
// src/workers/processAbsence.ts
export async function processAbsenceWebhook(payload: Payload, data: AbsenceWebhookData) {
  await payload.create({
    collection: 'absenceRequests',
    data: { ...data, status: 'pending' },
    overrideAccess: true, // ← obbligatorio nei worker
  })

  await payload.create({
    collection: 'webhookLogs',
    data: { event: 'absence.received', payload: data, timestamp: new Date() },
    overrideAccess: true,
  })
}
```

> **Regola:** `overrideAccess: true` è permesso **solo** nei file dentro `src/workers/`. Mai nelle Collection, mai negli endpoint pubblici, mai negli hook esposti all'utente.

---

## 8. Service account `sistema` e autenticazione worker

### Panoramica

Il worker (Cloud Tasks → endpoint interno PayloadCMS) si autentica come service account `sistema` tramite JWT generato da PayloadCMS — non tramite Google SSO, che è per utenti umani con browser.

### Generazione del JWT di sistema

```typescript
// src/scripts/generate-sistema-jwt.ts
// Da eseguire una sola volta — salvare il token in GCP Secret Manager

import payload from 'payload'
import config from '../payload.config'

async function generateSistemaJWT() {
  await payload.init({ config, local: true })

  const result = await payload.login({
    collection: 'users',
    data: { email: process.env.SISTEMA_EMAIL! },
    overrideAccess: true,
  })

  console.log('JWT Sistema:', result.token)
  console.log('Salva in GCP Secret Manager come SISTEMA_JWT')
  process.exit(0)
}

generateSistemaJWT()
```

### Uso del JWT nei worker

```typescript
// src/workers/base-worker.ts

const SISTEMA_JWT = process.env.SISTEMA_JWT // letto da GCP Secret Manager via env

export async function callPayloadInternal(endpoint: string, body: unknown): Promise<Response> {
  const response = await fetch(`${process.env.PAYLOAD_INTERNAL_URL}${endpoint}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `JWT ${SISTEMA_JWT}`,
    },
    body: JSON.stringify(body),
  })

  if (!response.ok) {
    throw new Error(`Worker call failed: ${response.status} ${endpoint}`)
  }

  return response
}
```

### Protezione degli endpoint interni

```typescript
// src/endpoints/internal/process-absence.ts
import { isSistema } from '../../access/helpers'

export const processAbsenceEndpoint = {
  path: '/internal/process-absence',
  method: 'post' as const,
  handler: async (req, res) => {
    if (!isSistema(req.user)) {
      return res.status(403).json({ error: 'Accesso riservato al service account sistema' })
    }
    // ... logica worker
  },
}
```

### Rotazione del JWT

1. Eseguire nuovamente `generate-sistema-jwt.ts`
2. Aggiornare il secret in GCP Secret Manager
3. Redeploy del servizio Cloud Run

> **Todo operativo:** Valutare migrazione a Workload Identity Federation per autenticazione zero-secret, eliminando la necessità di rotazione manuale.

---

## 9. Debito tecnico documentato

### DT-AUTH-001 — Permessi statici (Livello 1 → Livello 2)

**Stato:** Accettato consapevolmente  
**Descrizione:** La mappa `READ_PERMISSIONS` / `WRITE_PERMISSIONS` è hardcoded. Modificare i permessi richiede un deploy.  
**Impatto attuale:** Basso — i ruoli sono stabili e ben definiti nella fase attuale.  
**Trigger per la migrazione:** permessi per-progetto, più di 6 risorse con logiche differenziate, richiesta configurazione da UI admin non tecnici.  
**Piano di migrazione:** Creare Collection `RolePermissions`, implementare `DynamicPermissionProvider`, sostituire `activeProvider` via `_setPermissionProvider()`. L'interfaccia pubblica `canRead`/`canWrite` rimane invariata — zero impatto sulle Collection.

### DT-AUTH-002 — JWT sistema a lunga scadenza

**Stato:** Accettato con monitoraggio  
**Descrizione:** Il JWT del service account `sistema` ha scadenza lunga per evitare interruzioni operative dei worker.  
**Mitigazione attuale:** JWT conservato in GCP Secret Manager, accesso auditato.  
**Soluzione futura:** Workload Identity Federation o refresh automatico tramite API Payload.

### DT-AUTH-003 — Reinvio invito manuale

**Stato:** Accettato per la fase attuale  
**Descrizione:** Non esiste un pulsante "Reinvia invito" nativo. Il workaround è un update del record da parte dell'admin per ri-triggerare `sendInviteEmailHook`.  
**Soluzione futura:** Custom Action di Payload sulla collection Users che esegue il reinvio senza modificare il record.
