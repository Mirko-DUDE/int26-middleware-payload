import { OAuth2Plugin } from 'payload-oauth2'
import type { PayloadRequest } from 'payload'

/**
 * Configurazione Google OAuth2 per PayloadCMS.
 *
 * Flusso normale (DB non vuoto):
 * 1. getUserInfo() verifica il dominio aziendale
 * 2. getUserInfo() applica closed-by-default: blocca utenti non invitati
 * 3. onUserNotFoundBehavior: 'error' è il backstop per utenti non trovati
 * 4. beforeLogin hook blocca utenti suspended
 * 5. afterLogin hook promuove invited → active e gestisce bootstrap admin
 *
 * Flusso bootstrap (DB vuoto, primo avvio):
 * 1. getUserInfo() rileva che il DB è vuoto
 * 2. Se email === BOOTSTRAP_ADMIN_EMAIL: crea admin + service account sistema
 * 3. Se email diversa: errore "primo login riservato all'amministratore"
 */
export const googleOAuthPlugin = OAuth2Plugin({
  enabled:
    typeof process.env.GOOGLE_CLIENT_ID === 'string' &&
    typeof process.env.GOOGLE_CLIENT_SECRET === 'string',

  strategyName: 'google',
  useEmailAsIdentity: true,
  serverURL: process.env.SERVER_URL || 'http://localhost:3000',
  clientId: process.env.GOOGLE_CLIENT_ID || '',
  clientSecret: process.env.GOOGLE_CLIENT_SECRET || '',
  authorizePath: '/oauth/google',
  callbackPath: '/oauth/google/callback',
  authCollection: 'users',

  // Blocca utenti non presenti nel DB (closed by default).
  // La logica principale è in getUserInfo() — questo è il backstop.
  onUserNotFoundBehavior: 'error',

  tokenEndpoint: 'https://oauth2.googleapis.com/token',
  scopes: [
    'openid',
    'https://www.googleapis.com/auth/userinfo.email',
    'https://www.googleapis.com/auth/userinfo.profile',
  ],
  providerAuthorizationUrl: 'https://accounts.google.com/o/oauth2/v2/auth',

  getUserInfo: async (accessToken: string, req: PayloadRequest) => {
    const response = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
      headers: { Authorization: `Bearer ${accessToken}` },
    })

    if (!response.ok) {
      throw new Error(`Errore Google userinfo: ${response.status}`)
    }

    const profile = (await response.json()) as {
      email?: string
      name?: string
      sub?: string
    }

    const email = profile.email || ''
    const sub = profile.sub || ''

    // Difesa in profondità: blocco dominio a livello applicativo.
    // Il progetto GCP di tipo "Internal" blocca già a monte, ma questo
    // secondo controllo protegge da misconfiguration futura su GCP.
    const allowedDomain = process.env.ALLOWED_EMAIL_DOMAIN
    if (allowedDomain && !email.endsWith(`@${allowedDomain}`)) {
      throw new Error(`Accesso negato: solo utenti @${allowedDomain}`)
    }

    const bootstrapAdminEmail = process.env.BOOTSTRAP_ADMIN_EMAIL
    const isBootstrapAdmin = email === bootstrapAdminEmail

    // ── Conta gli utenti nel DB ───────────────────────────────────────────────
    // Distingue tra "DB vuoto (primo avvio)" e "DB non vuoto (regime normale)".
    const totalUsers = await req.payload.count({
      collection: 'users',
    })

    // ── Caso A: DB vuoto — primo avvio ────────────────────────────────────────
    if (totalUsers.totalDocs === 0) {
      if (!isBootstrapAdmin) {
        throw new Error(
          'Accesso negato: il sistema non è ancora configurato. ' +
            'Il primo login è riservato all\'amministratore bootstrap.',
        )
      }

      // Crea il bootstrap admin
      await req.payload.create({
        collection: 'users',
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        data: {
          email,
          name: profile.name || email,
          role: 'admin',
          status: 'active',
          sub,
        } as any,
        overrideAccess: true,
      })

      // Crea il service account sistema contestualmente al bootstrap
      const sistemaEmail = process.env.SISTEMA_EMAIL
      if (sistemaEmail) {
        await req.payload.create({
          collection: 'users',
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          data: {
            email: sistemaEmail,
            name: 'Sistema (Service Account)',
            role: 'sistema',
            status: 'active',
          } as any,
          overrideAccess: true,
        })
        req.payload.logger.info({ email: sistemaEmail }, 'Service account sistema creato durante bootstrap')
      }

      req.payload.logger.info({ email }, 'Bootstrap admin creato al primo avvio')
      return { email, sub }
    }

    // ── Caso B: DB non vuoto — regime normale (closed by default) ─────────────
    const existingUser = await req.payload.find({
      collection: 'users',
      where: { email: { equals: email } },
      limit: 1,
    })

    if (existingUser.docs.length === 0) {
      if (isBootstrapAdmin) {
        // Il bootstrap admin è già nel DB ma con email diversa dal record trovato —
        // non dovrebbe accadere, ma per sicurezza lo creiamo se mancante.
        await req.payload.create({
          collection: 'users',
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          data: {
            email,
            name: profile.name || email,
            role: 'admin',
            status: 'active',
            sub,
          } as any,
          overrideAccess: true,
        })
        return { email, sub }
      }

      // Tutti gli altri: accesso negato anche se hanno mail aziendale valida
      throw new Error('Accesso non autorizzato. Richiedere un invito a un amministratore.')
    }

    // Non restituire campi che sovrascriverebbero role/status nel record esistente
    return { email, sub }
  },

  successRedirect: (_req: PayloadRequest) => {
    return '/admin'
  },

  failureRedirect: (req: PayloadRequest, err?: unknown) => {
    if (err instanceof Error) {
      req.payload.logger.error({ err: err.message }, 'OAuth2 login fallito')
    }
    return '/admin/login'
  },
})
