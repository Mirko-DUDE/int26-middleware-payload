import type { PayloadRequest } from 'payload'
import pino from 'pino'
import { enqueueAbsenceTask } from '@/lib/gcp/tasks'

const logger = pino({ name: 'absenceWebhook' })

interface FuriousAbsenceWebhookPayload {
  id: number
  pseudo: string
  start_date?: string
  end_date?: string
  type?: string
  absenceType?: string
  half_day?: number
  [key: string]: unknown
}

function isValidAbsencePayload(body: unknown): body is FuriousAbsenceWebhookPayload {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return false
  const b = body as Record<string, unknown>
  if (typeof b['id'] !== 'number') return false
  if (typeof b['pseudo'] !== 'string' || b['pseudo'].trim() === '') return false
  return true
}

export async function absenceWebhookHandler(req: PayloadRequest): Promise<Response> {
  let body: unknown

  try {
    body = await (req as Request).json()
  } catch {
    logger.warn({ source: 'furious', event: 'absence', valid: false }, 'webhook_received')
    return new Response(JSON.stringify({ error: 'Body non valido: JSON malformato' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  if (!isValidAbsencePayload(body)) {
    logger.warn({ source: 'furious', event: 'absence', valid: false }, 'webhook_received')
    return new Response(
      JSON.stringify({ error: 'Body non valido: id (number) e pseudo (string) obbligatori' }),
      { status: 400, headers: { 'Content-Type': 'application/json' } },
    )
  }

  logger.info({ source: 'furious', event: 'absence', valid: true }, 'webhook_received')

  const { id: furiousAbsenceId, pseudo } = body

  // Crea il record AbsenceLog PRIMA dell'accodamento — se Cloud Tasks fallisce il payload non è perso
  let absenceLogId: string
  try {
    const absenceLog = await req.payload.create({
      collection: 'absence-log',
      data: {
        furiousAbsenceId,
        pseudo,
        startDate: typeof body.start_date === 'string' ? body.start_date : new Date().toISOString(),
        endDate: typeof body.end_date === 'string' ? body.end_date : new Date().toISOString(),
        absenceType: body.absenceType ?? (typeof body.type === 'string' ? body.type : null),
        halfDay:
          body.half_day === 0 || body.half_day === 1 || body.half_day === 2
            ? String(body.half_day) as '0' | '1' | '2'
            : undefined,
        status: 'received',
        rawPayload: body as Record<string, unknown>,
        attempts: 0,
      },
      overrideAccess: true,
    })
    absenceLogId = String(absenceLog.id)
  } catch (dbError) {
    // DB irraggiungibile: risponde 500 così Furious può ritentare senza creare duplicati
    logger.error(
      { source: 'furious', event: 'absence', valid: true, error: (dbError as Error).message },
      'webhook_received',
    )
    return new Response(JSON.stringify({ error: 'Errore interno' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  // Accoda il task su Cloud Tasks
  try {
    const taskName = await enqueueAbsenceTask({
      absenceLogId,
      furiousAbsenceId,
      pseudo,
      attempt: 1,
    })

    await req.payload.update({
      collection: 'absence-log',
      id: absenceLogId,
      data: {
        status: 'queued',
        taskName,
      },
      overrideAccess: true,
    })

    logger.info({ source: 'furious', event: 'absence', valid: true }, 'task_enqueued')
  } catch {
    // Accodamento fallito: il record rimane con status 'received' per riconciliazione futura.
    // Non rispondere 5xx — il payload è già su DB, far ritentare Furious creerebbe duplicati.
    logger.warn(
      { source: 'furious', event: 'absence', valid: true },
      'task_enqueued',
    )
  }

  return new Response(JSON.stringify({ received: true, id: absenceLogId }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}
