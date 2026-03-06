import { getSecret, setSecret } from '@/lib/gcp/secrets'

const FURIOUS_BASE_URL = process.env.FURIOUS_BASE_URL ?? 'https://dude.furious-squad.com'
const TOKEN_SECRET = 'furious-auth-token'
const TOKEN_EXPIRES_SECRET = 'furious-auth-token-expires'

/** TTL sicuro: 55 minuti (i token Furious durano 60 min) */
const TOKEN_TTL_MS = 55 * 60 * 1000

interface TokenCache {
  token: string
  expiresAt: number
}

let cache: TokenCache | null = null

function isCacheValid(): boolean {
  if (!cache) return false
  return Date.now() < cache.expiresAt
}

async function fetchNewToken(): Promise<string> {
  const username = process.env.FURIOUS_USERNAME
  const password = process.env.FURIOUS_PASSWORD

  if (!username || !password) {
    throw new Error('FURIOUS_USERNAME o FURIOUS_PASSWORD non configurati')
  }

  const response = await fetch(`${FURIOUS_BASE_URL}/api/v2/auth/`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'auth', data: { username, password } }),
  })

  if (!response.ok) {
    throw new Error(`Furious auth fallita: HTTP ${response.status}`)
  }

  const data = (await response.json()) as { token?: string }
  if (!data.token) throw new Error('Furious auth: token mancante nella risposta')

  const expiresAt = Date.now() + TOKEN_TTL_MS

  cache = { token: data.token, expiresAt }

  if (process.env.NODE_ENV === 'production') {
    await setSecret(TOKEN_SECRET, data.token)
    await setSecret(TOKEN_EXPIRES_SECRET, String(expiresAt))
  }

  return data.token
}

/**
 * Restituisce un token Furious valido.
 * Priorità: cache in-memory → Secret Manager → nuova autenticazione.
 * Invalida automaticamente la cache se viene ricevuto un 401.
 */
export async function getFuriousToken(): Promise<string> {
  if (isCacheValid()) {
    return cache!.token
  }

  if (process.env.NODE_ENV === 'production') {
    try {
      const [storedToken, storedExpires] = await Promise.all([
        getSecret(TOKEN_SECRET),
        getSecret(TOKEN_EXPIRES_SECRET),
      ])

      const expiresAt = parseInt(storedExpires, 10)
      if (!isNaN(expiresAt) && Date.now() < expiresAt) {
        cache = { token: storedToken, expiresAt }
        return storedToken
      }
    } catch {
      // Secret non ancora popolato o scaduto — prosegui con nuovo fetch
    }
  }

  return fetchNewToken()
}

/**
 * Invalida la cache in-memory e forza il rinnovo del token al prossimo utilizzo.
 * Chiamare dopo aver ricevuto HTTP 401 da Furious.
 */
export function invalidateFuriousToken(): void {
  cache = null
}
