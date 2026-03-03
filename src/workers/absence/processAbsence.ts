import { getPayload } from 'payload'
import config from '@payload-config'
import { approveAbsence, FuriousApiError } from '@/lib/furious/api'
import { captureError } from '@/lib/monitoring'
import type { WorkerFn } from '@/workers/types'

export interface AbsenceWorkerData {
  absenceLogId: string
  furiousAbsenceId: number
  pseudo: string
}

/**
 * Worker assenze: verifica se il pseudo è in AutoApprovalRules e, se sì,
 * approva l'assenza su Furious e aggiorna AbsenceLog.
 */
export const processAbsence: WorkerFn = async (ctx) => {
  const { payload: taskPayload, logger } = ctx
  const data = taskPayload.data as unknown as AbsenceWorkerData

  const { absenceLogId, furiousAbsenceId, pseudo } = data

  if (!absenceLogId || !furiousAbsenceId || !pseudo) {
    return {
      success: false,
      message: 'Payload worker non valido: campi obbligatori mancanti',
      retriable: false,
    }
  }

  const payload = await getPayload({ config })

  const monitoringCtx = {
    taskId: taskPayload.taskId,
    collection: 'absence-log' as const,
    attempt: taskPayload.attempt,
    furiousId: String(furiousAbsenceId),
  }

  try {
    // Verifica se il pseudo è in AutoApprovalRules per il flusso assenze
    const rules = await payload.find({
      collection: 'auto-approval-rules',
      where: {
        and: [
          { pseudo: { equals: pseudo } },
          { flowType: { equals: 'absence' } },
        ],
      },
      limit: 1,
      overrideAccess: true,
    })

    if (rules.totalDocs === 0) {
      // Pseudo non in lista auto-approvazione: skip (non è un errore)
      await payload.update({
        collection: 'absence-log',
        id: absenceLogId,
        data: {
          status: 'skipped',
          attempts: taskPayload.attempt,
        },
        overrideAccess: true,
      })

      logger.info('worker_completed', {
        externalId: String(furiousAbsenceId),
        durationMs: 0,
        reason: 'pseudo non in AutoApprovalRules',
      })

      return {
        success: true,
        message: `Assenza #${furiousAbsenceId} saltata: pseudo "${pseudo}" non in lista auto-approvazione`,
        externalId: String(furiousAbsenceId),
        retriable: false,
      }
    }

    // Approva l'assenza su Furious
    logger.info('external_api_called', {
      endpoint: `/api/v2/conge/${furiousAbsenceId}/`,
      method: 'PUT',
      statusCode: 0,
    })

    await approveAbsence(furiousAbsenceId)

    logger.info('external_api_called', {
      endpoint: `/api/v2/conge/${furiousAbsenceId}/`,
      method: 'PUT',
      statusCode: 200,
    })

    // Aggiorna AbsenceLog → approved
    await payload.update({
      collection: 'absence-log',
      id: absenceLogId,
      data: {
        status: 'approved',
        attempts: taskPayload.attempt,
      },
      overrideAccess: true,
    })

    logger.info('worker_completed', {
      externalId: String(furiousAbsenceId),
      durationMs: 0,
    })

    return {
      success: true,
      message: `Assenza #${furiousAbsenceId} approvata su Furious`,
      externalId: String(furiousAbsenceId),
      retriable: false,
    }
  } catch (err: unknown) {
    const error = err instanceof Error ? err : new Error(String(err))

    if (err instanceof FuriousApiError) {
      // 404: assenza non trovata su Furious — errore definitivo
      if (err.status === 404) {
        await payload.update({
          collection: 'absence-log',
          id: absenceLogId,
          data: {
            status: 'failed_permanent',
            attempts: taskPayload.attempt,
            lastError: error.message,
          },
          overrideAccess: true,
        })

        logger.warn('worker_failed_non_retriable', {
          message: error.message,
          reason: 'assenza non trovata su Furious',
        })

        return {
          success: false,
          message: error.message,
          retriable: false,
        }
      }

      // 400: payload malformato — errore definitivo
      if (err.status === 400) {
        await payload.update({
          collection: 'absence-log',
          id: absenceLogId,
          data: {
            status: 'failed_permanent',
            attempts: taskPayload.attempt,
            lastError: error.message,
          },
          overrideAccess: true,
        })

        logger.warn('worker_failed_non_retriable', {
          message: error.message,
          reason: 'payload malformato',
        })

        return {
          success: false,
          message: error.message,
          retriable: false,
        }
      }

      // 5xx, 429, 401 dopo rinnovo: retriable
      captureError(error, monitoringCtx)

      await payload.update({
        collection: 'absence-log',
        id: absenceLogId,
        data: {
          attempts: taskPayload.attempt,
          lastError: error.message,
        },
        overrideAccess: true,
      })

      logger.warn('worker_failed_retriable', {
        message: error.message,
        attempt: taskPayload.attempt,
      })

      return {
        success: false,
        message: error.message,
        retriable: true,
      }
    }

    // Errore generico non classificato: retriable per sicurezza
    captureError(error, monitoringCtx)

    await payload.update({
      collection: 'absence-log',
      id: absenceLogId,
      data: {
        attempts: taskPayload.attempt,
        lastError: error.message,
      },
      overrideAccess: true,
    })

    logger.warn('worker_failed_retriable', {
      message: error.message,
      attempt: taskPayload.attempt,
    })

    return {
      success: false,
      message: error.message,
      retriable: true,
    }
  }
}
