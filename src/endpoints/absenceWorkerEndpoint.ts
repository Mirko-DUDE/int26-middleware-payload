import type { PayloadRequest } from 'payload'
import { OAuth2Client } from 'google-auth-library'
import pino from 'pino'
import { processAbsence } from '@/workers/absence/processAbsence'
import { captureError } from '@/lib/monitoring'
import { sendFailedTaskEmail } from '@/services/mailer'
import type { AbsenceTaskPayload } from '@/lib/gcp/tasks'

const logger = pino({ name: 'absenceWorker' })

const MAX_ATTEMPTS = 5

const authClient = new OAuth2Client()

async function verifyAuth(req: PayloadRequest): Promise<boolean> {
  if (process.env.NODE_ENV !== 'production') {
    const devSecret = req.headers.get('x-worker-dev-secret')
    return devSecret === process.env.WORKER_DEV_SECRET
  }

  const authHeader = req.headers.get('authorization')
  if (!authHeader?.startsWith('Bearer ')) return false

  const token = authHeader.slice(7)
  try {
    const ticket = await authClient.verifyIdToken({
      idToken: token,
      audience: process.env.WORKER_BASE_URL,
    })
    const payload = ticket.getPayload()
    return payload?.email === process.env.CLOUD_TASKS_SERVICE_ACCOUNT
  } catch {
    return false
  }
}

export async function absenceWorkerHandler(req: PayloadRequest): Promise<Response> {
  const authenticated = await verifyAuth(req)
  if (!authenticated) {
    return new Response(JSON.stringify({ error: 'Non autorizzato' }), {
      status: 403,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  let taskPayload: AbsenceTaskPayload
  try {
    taskPayload = (await (req as Request).json()) as AbsenceTaskPayload
  } catch {
    return new Response(JSON.stringify({ error: 'Body non valido' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  const { absenceLogId, furiousAbsenceId, pseudo, attempt } = taskPayload

  const monitoringCtx = {
    taskId: absenceLogId,
    collection: 'absence-log' as const,
    attempt,
    furiousId: String(furiousAbsenceId),
  }

  // Aggiorna AbsenceLog a 'processing' prima di chiamare il worker
  try {
    await req.payload.update({
      collection: 'absence-log',
      id: absenceLogId,
      data: {
        status: 'processing',
        attempts: attempt,
      },
      overrideAccess: true,
    })
  } catch (dbError) {
    // DB non disponibile: Cloud Tasks riproverà
    logger.error(
      { taskId: absenceLogId, collection: 'absence-log', attempt, error: (dbError as Error).message },
      'Worker fallito',
    )
    return new Response(JSON.stringify({ error: 'DB non disponibile' }), {
      status: 503,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  // Costruisce il WorkerContext compatibile con WorkerFn
  const workerCtx = {
    payload: {
      taskId: absenceLogId,
      taskType: 'absence',
      attempt,
      enqueuedAt: new Date().toISOString(),
      data: {
        absenceLogId,
        furiousAbsenceId,
        pseudo,
      },
    },
    logger: {
      info: (event: string, data?: Record<string, unknown>) =>
        logger.info({ taskId: absenceLogId, collection: 'absence-log', attempt, ...data }, event),
      warn: (event: string, data?: Record<string, unknown>) =>
        logger.warn({ taskId: absenceLogId, collection: 'absence-log', attempt, ...data }, event),
      error: (event: string, data?: Record<string, unknown>) =>
        logger.error({ taskId: absenceLogId, collection: 'absence-log', attempt, ...data }, event),
    },
  }

  let result: Awaited<ReturnType<typeof processAbsence>>
  try {
    result = await processAbsence(workerCtx)
  } catch (unexpectedError) {
    captureError(unexpectedError, monitoringCtx)
    logger.error(
      { taskId: absenceLogId, collection: 'absence-log', attempt, error: (unexpectedError as Error).message },
      'Worker fallito',
    )
    return new Response(JSON.stringify({ error: 'Errore interno worker' }), {
      status: 503,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  // Matrice risposta HTTP secondo le regole 060-absence-flow.mdc
  if (result.success) {
    return new Response(JSON.stringify({ ok: true, message: result.message }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  if (!result.retriable) {
    // Errore definitivo non-retriable: Cloud Tasks non deve riprovare
    return new Response(JSON.stringify({ ok: false, message: result.message }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  // Errore retriable
  if (attempt >= MAX_ATTEMPTS) {
    // Tentativi esauriti: scrive failed_permanent, notifica admin, risponde 200
    try {
      await req.payload.update({
        collection: 'absence-log',
        id: absenceLogId,
        data: {
          status: 'failed_permanent',
          attempts: attempt,
          lastError: result.message,
        },
        overrideAccess: true,
      })
    } catch (dbError) {
      captureError(dbError, monitoringCtx)
    }

    try {
      await sendFailedTaskEmail({
        collection: 'absence-log',
        recordId: absenceLogId,
        furiousAbsenceId,
        pseudo,
        attempts: attempt,
        lastError: result.message ?? 'Errore sconosciuto',
      })
    } catch (mailErr) {
      // La mail non è bloccante — il record failed_permanent su DB è la fonte di verità
      captureError(mailErr, monitoringCtx)
    }

    logger.warn(
      { taskId: absenceLogId, collection: 'absence-log', attempt },
      'Task in dead-letter',
    )

    return new Response(JSON.stringify({ ok: false, message: result.message, permanent: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  // Errore retriable con tentativi rimanenti: Cloud Tasks riprova con backoff esponenziale
  return new Response(JSON.stringify({ ok: false, message: result.message, retriable: true }), {
    status: 503,
    headers: { 'Content-Type': 'application/json' },
  })
}
