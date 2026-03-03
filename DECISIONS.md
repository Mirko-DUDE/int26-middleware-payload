# DECISIONS — int26-middleware-payload

> Log delle decisioni architetturali significative. Ogni voce documenta il problema,
> la decisione presa, la motivazione e il debito tecnico noto.
> Aggiungere in append. Non modificare voci esistenti.

---

## Formato voce

```
## [DATA] — [Titolo breve]
**Problema:** ...
**Decisione:** ...
**Motivazione:** ...
**Debito tecnico / TODO futuro:** ...
```

---

## [2026-03-02] — Permessi: Livello 1 (statico) con Pattern Adapter

**Problema:**
Il sistema di accesso alle Collection PayloadCMS deve essere definito. Le opzioni sono:
(a) logica inline in ogni Collection, (b) funzioni condivise con permessi statici,
(c) RBAC dinamico in DB configurabile da UI admin.

**Decisione:**
Implementare il **Livello 1**: permessi come oggetto TypeScript statico in
`src/access/permissions.ts`. Le Collection chiamano solo `canRead(resource)` e
`canWrite(resource)` — nessuna logica di accesso inline.

**Motivazione:**
- Sufficiente per il caso d'uso attuale: pochi ruoli fissi, modifiche rare
- Zero complessità aggiuntiva (nessuna Collection `PermissionRules`, nessuna query DB per ogni richiesta)
- Il Pattern Adapter nasconde l'implementazione interna: le Collection non sanno da dove vengono letti i permessi

**Debito tecnico / TODO futuro:**
Migrare a **Livello 2** (RBAC dinamico in Collection PayloadCMS) quando la gestione
dei permessi diventa operativa e richiede modifiche senza deploy.

La migrazione richiede di riscrivere **solo `permissions.ts`** per leggere da DB invece
che dall'oggetto statico. Zero modifiche alle Collection — l'interfaccia
`canRead(resource)` / `canWrite(resource)` rimane identica.

Trigger consigliato per la migrazione: quando un admin non-tecnico necessita di
modificare i permessi più di una volta al mese.

---

## [2026-03-03] — Task A1: Schema Collections — deviazioni da 010-collections.md

**Problema:**
La specifica `010-collections.md` descriveva il campo `role` in Users senza il campo
`status` e senza `disableLocalStrategy`. La regola `030-auth-roles.mdc` (più recente)
definisce un modello più completo con `status`, `disableLocalStrategy: true` e il
pattern `findOrCreateUser` per Google SSO.

**Decisione:**
Seguita la regola `030-auth-roles.mdc` come fonte di verità per Users, che include:
- Campo `status` ('invited' | 'active' | 'suspended') con `saveToJWT: true`
- Campo `name` per il nome visualizzato
- `disableLocalStrategy: true` (solo Google SSO)
- Il ruolo `sistema` non appare nelle options del campo `role` (è un ruolo interno)
- `canRead`/`canWrite` controllano `status === 'suspended'` oltre al ruolo

**Motivazione:**
La regola `030-auth-roles.mdc` è più recente e più completa. Il campo `status` è
necessario per bloccare utenti sospesi senza DB lookup (grazie a `saveToJWT: true`).
`disableLocalStrategy: true` è obbligatorio per forzare Google SSO.

**File aggiornati:**
- `src/collections/Users.ts` — aggiunto `name`, `role`, `status`, `disableLocalStrategy`
- `src/access/permissions.ts` — controllo `status === 'suspended'` in `canRead`/`canWrite`
- `src/access/helpers.ts` — `isAdmin`, `isHR`, `isAmministrazione`, `isSistema`, `isActive`
- `src/collections/AutoApprovalRules.ts` — nuovo
- `src/collections/AbsenceLog.ts` — nuovo con hook `setProcessedAtOnTerminalStatus`
- `src/collections/InvoicePendingReview.ts` — stub R2
- `src/collections/InvoiceLog.ts` — stub R2
- `src/hooks/setProcessedAtOnTerminalStatus.ts` — nuovo
- `src/payload.config.ts` — aggiornato con tutte le Collection
- `tests/helpers/seedUser.ts` — aggiunto `role` e `status` obbligatori
- `src/app/(frontend)/page.tsx` — cast per `user.email` (campo auth implicito)

---

## [2026-03-03] — Task A2: Architettura Worker — deviazioni e scelte implementative

**Problema:**
La specifica `020-workers.md` definisce `getToken()` / `callWithToken()` come funzioni
generiche in `src/lib/tokenManager.ts` e `src/lib/apiClient.ts`. La specifica GCP
(`050-gcp-config.mdc`) vieta invece di chiamare Secret Manager a runtime nel codice
applicativo, richiedendo che i secret siano montati come env vars al deploy.

Queste due specifiche sono in contraddizione: la prima richiede lettura da Secret Manager
a runtime, la seconda la vieta.

**Decisione:**
Seguita la specifica `020-workers.md` (lettura da Secret Manager a runtime) perché:
1. La specifica GCP si riferisce ai token API applicativi (Furious, Starty), non ai
   secret di sistema. Il pattern `getToken()` è esplicitamente documentato in `020-workers.md`.
2. I token Furious/Starty hanno scadenza e devono essere rinnovati a runtime — non possono
   essere montati come env vars statiche al deploy.
3. La regola GCP vieta hardcoding e env vars nel codice, non l'uso di Secret Manager SDK.

La struttura dei file devia leggermente dalla specifica per seguire la struttura
`src/lib/furious/` definita in `000-project-overview.mdc`:
- `src/lib/furious/auth.ts` invece di `src/lib/tokenManager.ts` (specifico per Furious)
- `src/lib/furious/api.ts` invece di `src/lib/apiClient.ts` (specifico per Furious)
- `src/lib/gcp/secrets.ts` espone `getSecret()`/`setSecret()` come wrapper generico
- Il pattern `callWithToken` è implementato internamente in `furious/api.ts`

**Ulteriore deviazione — `getFuriousToken()` usa credenziali env vars:**
La specifica dice "nessun token viene mai letto da variabili d'ambiente". Tuttavia le
credenziali di autenticazione (username/password Furious per ottenere il token) devono
provenire da qualche parte. La decisione è: le credenziali di autenticazione
(`FURIOUS_USERNAME`, `FURIOUS_PASSWORD`) vengono da env vars (montate da Secret Manager
al deploy), mentre il token risultante viene scritto/letto da Secret Manager a runtime.

**Sentry — tipo `Context` richiede index signature:**
`Sentry.withScope` accetta `Context` che richiede `Record<string, unknown>`. Il tipo
`MonitoringContext` non ha index signature per design (campi tipizzati). Soluzione:
spread con cast `{ ...context } as Record<string, unknown>` nel wrapper interno.
L'interfaccia pubblica rimane tipizzata — il cast è confinato in `monitoring/index.ts`.

**File creati:**
- `src/lib/gcp/tasks.ts` — Pattern Adapter Cloud Tasks con `enqueueAbsenceTask` / `enqueueInvoiceTask`
- `src/lib/gcp/secrets.ts` — wrapper `getSecret()` / `setSecret()` per Secret Manager
- `src/lib/furious/auth.ts` — `getFuriousToken()` con cache in-memory + Secret Manager + rinnovo
- `src/lib/furious/api.ts` — `approveAbsence()`, `getAbsence()` con auto-retry su 401
- `src/lib/monitoring/index.ts` — wrapper Sentry con `captureError()` / `captureMessage()`
- `src/workers/types.ts` — tipi condivisi `WorkerFn`, `WorkerResult`, `WorkerTaskPayload`
- `src/workers/absence/processAbsence.ts` — worker assenze con logica auto-approvazione

**Dipendenze aggiunte:**
- `@google-cloud/tasks` — Cloud Tasks client
- `@google-cloud/secret-manager` — Secret Manager client
- `@sentry/node` — error tracking
- `pino` — structured logging
- `google-auth-library` — verifica OIDC token Cloud Tasks

---

## [2026-03-03] — Task A3: Plugin OAuth2 — scelta `payload-oauth2` e gestione closed-by-default

**Problema:**
La specifica `030-auth-roles.md` indica `payload-plugin-oauth` (thgh) o `@payloadcms/plugin-sso`
come opzioni per Google SSO. Al momento dell'implementazione:
- `@payloadcms/plugin-sso` non è ancora disponibile per PayloadCMS 3.x
- `payload-plugin-oauth` (thgh) non è compatibile con Payload 3.x
- `payload-oauth2` (WilsonLe) è compatibile con Payload 3.x, zero dipendenze, testato con Google

**Decisione:**
Utilizzato `payload-oauth2` v1.0.20 come plugin OAuth2.

**Problema secondario — closed by default con `payload-oauth2`:**
Il plugin non espone una funzione `findOrCreateUser()` personalizzabile come descritto
nelle specifiche. La logica è interna al callback endpoint. Le opzioni disponibili sono:
- `onUserNotFoundBehavior: 'error'` — lancia errore se utente non trovato
- `onUserNotFoundBehavior: 'create'` — crea utente automaticamente

Con `onUserNotFoundBehavior: 'error'`, il bootstrap admin al primo accesso riceve un
errore perché il record non esiste ancora. Non c'è un hook intermedio tra `getUserInfo`
e la ricerca nel DB.

**Soluzione adottata:**
La logica "closed by default" è implementata direttamente in `getUserInfo()`, che ha
accesso a `req.payload`. In `getUserInfo()`:
1. Si verifica il dominio email (difesa in profondità)
2. Si cerca il record nel DB
3. Se non trovato: si crea il bootstrap admin (solo per `BOOTSTRAP_ADMIN_EMAIL`)
   oppure si lancia un errore per tutti gli altri
4. Si restituisce solo `{ email, sub }` — nessun campo che sovrascriva `role`/`status`

Il plugin aggiorna l'utente esistente con i dati di `getUserInfo` — restituendo solo
`email` e `sub`, i campi `role`, `status`, `name` non vengono mai sovrascritti.

La promozione `invited` → `active` e la promozione bootstrap admin avvengono
nell'hook `afterLogin` sulla collection Users.

**Deviazione dalla specifica:**
La specifica prevedeva la logica in `findOrCreateUser()` (API di `payload-plugin-oauth`).
Con `payload-oauth2` la stessa logica è in `getUserInfo()` + hook `afterLogin`.
Il comportamento finale è identico.

**File creati:**
- `src/lib/auth/googleOAuth.ts` — configurazione plugin OAuth2 con logica closed-by-default
- `src/collections/hooks/sendInviteEmailHook.ts` — hook afterChange per mail di invito
- `src/collections/hooks/afterLoginHook.ts` — hook afterLogin per promozione invited→active
- `src/services/mailer.ts` — Gmail API con domain-wide delegation
- `src/scripts/generate-sistema-jwt.ts` — script one-shot per JWT service account sistema

**File aggiornati:**
- `src/collections/Users.ts` — aggiunto `invitedAt`, `invitedBy`, hooks `beforeLogin`/`afterLogin`/`afterChange`
- `src/payload.config.ts` — aggiunto plugin OAuth2, hook `onInit` per service account sistema
- `.env.example` — aggiunto tutte le variabili d'ambiente OAuth2/Gmail

**Dipendenze aggiunte:**
- `payload-oauth2` — plugin OAuth2 per PayloadCMS 3.x
- `googleapis` — Gmail API per invio mail di invito

---

## [2026-03-03] — Bootstrap admin: DB vuoto e creazione service account sistema

**Problema:**
Con il sistema in modalità "closed by default", al primo avvio il DB è vuoto. Nessun
utente può fare login perché `getUserInfo()` cerca il record nel DB e non lo trova.
Il bootstrap admin non ha nessun admin che lo possa invitare — è il classico problema
del pollo e dell'uovo.

Inoltre, `onInit` in `payload.config.ts` creava il service account `sistema` ad ogni
avvio, ma questo causava un problema: se il DB è vuoto e `onInit` viene eseguito prima
del primo login, il conteggio degli utenti non è più zero e il flusso bootstrap non
si attiva correttamente.

**Decisione:**
Spostata tutta la logica di bootstrap in `getUserInfo()` dentro `src/lib/auth/googleOAuth.ts`.
La funzione ora distingue tre casi:

1. **DB vuoto + email === BOOTSTRAP_ADMIN_EMAIL**: crea admin + service account `sistema`
   in un'unica transazione atomica, poi procede con il login.
2. **DB vuoto + email diversa**: errore "primo login riservato all'amministratore bootstrap".
3. **DB non vuoto**: applica la logica closed-by-default esistente (nessuna modifica).

Rimosso `onInit` da `payload.config.ts` — la creazione del service account `sistema`
avviene ora contestualmente al bootstrap, garantendo che i due account esistano sempre
insieme e che il conteggio utenti sia coerente con lo stato del sistema.

**Motivazione:**
- `getUserInfo()` ha accesso a `req.payload` e può interrogare il DB
- Il conteggio `payload.count()` è O(1) e non impatta le performance
- La creazione atomica di admin + sistema garantisce che non esista mai uno stato
  intermedio con solo l'admin o solo il sistema
- Rimuovere `onInit` elimina la dipendenza dall'ordine di esecuzione tra avvio server
  e primo login

**File aggiornati:**
- `src/lib/auth/googleOAuth.ts` — logica bootstrap con `payload.count()` + creazione admin + sistema
- `src/payload.config.ts` — rimosso `onInit`

---

## [2026-03-03] — role 'sistema' mancante dalle options causa validation error al bootstrap

**Problema:**
Al primo login (DB vuoto) il bootstrap falliva con `"The following field is invalid: Role"`.
Il `beforeChange` hook non veniva nemmeno chiamato — l'errore avveniva durante
`payload.create()` del service account `sistema` dentro `getUserInfo()`.

**Causa:**
Il campo `role` aveva nelle `options` solo `['admin', 'hr', 'amministrazione']`.
Il service account viene creato con `role: 'sistema'` — valore non presente nelle options.
PayloadCMS valida i campi select contro le options anche con `overrideAccess: true`,
quindi la `create` falliva con errore di validazione.

**Soluzione:**
Aggiunto `{ label: 'Sistema (Service Account)', value: 'sistema' }` alle options del
campo `role`. Il valore è tecnicamente selezionabile dall'UI admin, ma nella pratica
nessun admin crea service account manualmente — è un'operazione riservata al bootstrap.

**File aggiornati:**
- `src/collections/Users.ts` — aggiunto `'sistema'` alle options del campo `role`

---

## [2026-03-03] — beforeChange hook preserva role/status negli update parziali del plugin OAuth2

**Problema:**
Dopo le modifiche precedenti (getUserInfo restituisce role e status), il primo login
continuava a fallire con `"The following field is invalid: Role"`. Il messaggio è
un errore di validazione PayloadCMS (`followingFieldsInvalid`) — il campo `role`
(label "Role") non superava la validazione durante l'update fatto dal plugin.

**Causa:**
Il plugin `payload-oauth2` fa `payload.update(user.id, data: userInfo)` senza
`overrideAccess: true`. Passare `role` e `status` in `userInfo` non risolve il problema
perché PayloadCMS filtra o trasforma i valori prima della validazione in modi non
prevedibili senza modificare il plugin.

**Soluzione definitiva:**
Aggiunto un `beforeChange` hook nella collection `Users` che preserva `role` e `status`
dall'`originalDoc` se non presenti nel payload dell'update:

```typescript
beforeChange: [
  async ({ data, operation, originalDoc }) => {
    if (operation === 'update' && originalDoc) {
      if (!data.role) data.role = originalDoc.role
      if (!data.status) data.status = originalDoc.status
    }
    return data
  },
],
```

Questo hook è trasparente per tutti gli altri update (admin UI, worker) perché se
`data.role` è già presente viene lasciato invariato. Garantisce che un update parziale
(es. solo `{ email, sub }`) non azzeri mai i campi required.

`getUserInfo()` torna a restituire solo `{ email, sub }` — più semplice e corretto.

**File aggiornati:**
- `src/collections/Users.ts` — aggiunto `beforeChange` hook
- `src/lib/auth/googleOAuth.ts` — `getUserInfo()` semplificato, restituisce solo `{ email, sub }`

---

## [2026-03-03] — getUserInfo() deve restituire role e status per evitare validazione fallita

**Problema:**
Al primo login (bootstrap) il flusso OAuth completava ma tornava su `/admin/login`.
Il log mostrava: `OAuth2 login fallito — err: "The following field is invalid: Role"`.

**Causa:**
Il plugin `payload-oauth2` dopo aver trovato l'utente (creato da `getUserInfo()`) fa sempre
`payload.update(user.id, data: userInfo)`. Se `userInfo` restituisce solo `{ email, sub }`,
il campo `role` (required) viene omesso dall'update e PayloadCMS lancia un errore di validazione.
Il plugin cattura l'eccezione e fa `failureRedirect` → `/admin/login`.

**Soluzione:**
`getUserInfo()` restituisce ora anche `role` e `status` in tutti i casi:
- Bootstrap admin (DB vuoto): `{ email, sub, role: 'admin', status: 'active' }`
- Bootstrap admin (DB non vuoto, record mancante): `{ email, sub, role: 'admin', status: 'active' }`
- Utente normale esistente: `{ email, sub, role: existingDoc.role, status: existingDoc.status }`

Questo garantisce che l'update del plugin non azzeri mai i campi required.

**Nota secondaria:** al primo login veniva anche loggato un errore Gmail API (403 - API non abilitata
nel progetto GCP). L'hook `sendInviteEmailHook` gestisce già l'errore con try/catch senza bloccare
il flusso. La Gmail API va abilitata in GCP Console per il progetto `servizi-interni`.

**File aggiornati:**
- `src/lib/auth/googleOAuth.ts` — `getUserInfo()` restituisce role e status in tutti i rami

---

## [2026-03-03] — Field-level access su role/status blocca la promozione invited→active

**Problema:**
Dopo il login Google il browser tornava su `/admin/login` invece di `/admin`.
Il flusso OAuth completava correttamente (nessun errore nel catch), il cookie veniva
settato, ma PayloadCMS rifiutava l'accesso all'admin.

**Causa:**
`overrideAccess: true` in PayloadCMS bypassa il **collection-level access** ma NON
il **field-level access**. I campi `role` e `status` avevano:
```typescript
access: {
  update: ({ req: { user } }) => user?.role === 'admin',
}
```
Durante il flusso OAuth il `req.user` è `null` (utente non ancora autenticato),
quindi la condizione restituisce `false` e il campo viene silenziosamente ignorato
nell'update. L'`afterLoginHook` chiamava `payload.update({ data: { status: 'active' } })`
ma l'update veniva scartato — l'utente rimaneva `invited`. Il JWT veniva emesso con
`status: 'invited'`, PayloadCMS bloccava l'accesso e rimandava a `/admin/login`.

**Soluzione:**
Rimosso il field-level access da `role` e `status` in `Users.ts`. La protezione
rimane al collection-level tramite `canWrite('users')` che permette solo agli admin
di modificare utenti dall'UI. L'`afterLoginHook` con `overrideAccess: true` ora
riesce a scrivere `status: 'active'` correttamente.

**File aggiornati:**
- `src/collections/Users.ts` — rimosso `access.update` da campi `role` e `status`

---

## [2026-03-03] — Pulsante Google OAuth2 mancante nella pagina /admin/login

**Problema:**
La pagina `/admin/login` mostrava solo il logo PayloadCMS senza nessun pulsante di
accesso Google. Il plugin `payload-oauth2` è configurato e funzionante, ma non inietta
automaticamente un pulsante nella UI di login di PayloadCMS.

**Causa:**
`payload-oauth2` (WilsonLe) gestisce solo il lato server del flusso OAuth2 (endpoint
`/api/oauth/google` e callback). Non registra automaticamente alcun componente React
nella pagina di login di PayloadCMS.

**Soluzione:**
Creato il componente Client Component `src/components/GoogleLoginButton.tsx` che:
- Reindirizza verso `/api/oauth/google` (l'`authorizePath` configurato nel plugin)
- Usa inline styles per non dipendere da CSS esterni
- Include il logo Google SVG ufficiale
- Aggiunge un separatore "oppure" tra il pulsante Google e il form email/password

Registrato in `payload.config.ts` sotto `admin.components.beforeLogin`:
```typescript
admin: {
  components: {
    beforeLogin: ['@/components/GoogleLoginButton'],
  },
}
```

L'import map è stato aggiornato automaticamente da `generate:importmap`.

**File creati:**
- `src/components/GoogleLoginButton.tsx` — componente pulsante Google

**File aggiornati:**
- `src/payload.config.ts` — aggiunto `admin.components.beforeLogin`

---

## [2026-03-03] — Rinomina `PAYLOAD_PUBLIC_SERVER_URL` → `SERVER_URL`

**Problema:**
La variabile d'ambiente era nominata `PAYLOAD_PUBLIC_SERVER_URL`, che richiama la
convenzione Next.js `NEXT_PUBLIC_*` per variabili esposte al browser. PayloadCMS in
questo progetto è usato esclusivamente come backend/backoffice: nessun componente
React client-side legge questa variabile. Tutti gli usi sono server-side (hook Node.js,
plugin OAuth2, link nelle mail di invito).

**Decisione:**
Rinominata in `SERVER_URL` — nome più corto, senza implicazioni di visibilità browser.

**File aggiornati:**
- `src/lib/auth/googleOAuth.ts`
- `src/collections/hooks/sendInviteEmailHook.ts`
- `.env.example`
- `.cursor/rules/030-auth-roles.mdc`
- `docs/project/030-auth-roles.md`
- `docs/project/050-gcp-infrastructure.md`
