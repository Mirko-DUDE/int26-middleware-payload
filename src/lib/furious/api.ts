import { getFuriousToken, invalidateFuriousToken } from './auth'

const FURIOUS_BASE_URL = process.env.FURIOUS_BASE_URL ?? 'https://dude.furious-squad.com'

export class FuriousApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message)
    this.name = 'FuriousApiError'
  }
}

export interface FuriousAbsence {
  id: number
  pseudo: string
  start_date: string
  end_date: string
  type: string
  half_day: 0 | 1 | 2
  status: number
}

export interface FuriousApproveAbsenceResponse {
  id: number
  status: number
}

async function furiousRequest<T>(
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  let token = await getFuriousToken()

  const doRequest = async (authToken: string): Promise<Response> =>
    fetch(`${FURIOUS_BASE_URL}${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        'F-Auth-Token': authToken,
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    })

  let response = await doRequest(token)

  if (response.status === 401) {
    invalidateFuriousToken()
    token = await getFuriousToken()
    response = await doRequest(token)

    if (response.status === 401) {
      throw new FuriousApiError(401, 'Furious: token non valido dopo rinnovo')
    }
  }

  if (!response.ok) {
    const text = await response.text()
    throw new FuriousApiError(response.status, `Furious API error ${response.status}: ${text}`)
  }

  return response.json() as Promise<T>
}

/**
 * Approva un'assenza su Furious (status 1 = confermata).
 * L'ID non va nell'URL ma nel body dentro data.id.
 */
export async function approveAbsence(absenceId: number): Promise<FuriousApproveAbsenceResponse> {
  return furiousRequest<FuriousApproveAbsenceResponse>('PUT', '/api/v2/absence/', {
    action: 'update',
    data: {
      id: absenceId,
      status: 1,
    },
  })
}

/**
 * Recupera i dettagli di un'assenza da Furious.
 * Usa GET su /api/v2/absence/ con id come query string.
 */
export async function getAbsence(absenceId: number): Promise<FuriousAbsence> {
  return furiousRequest<FuriousAbsence>('GET', `/api/v2/absence/?id=${absenceId}`)
}
