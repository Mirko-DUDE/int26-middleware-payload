import { CloudTasksClient } from '@google-cloud/tasks'

const client = new CloudTasksClient()

export interface AbsenceTaskPayload {
  absenceLogId: string
  furiousAbsenceId: number
  pseudo: string
  attempt: number
}

export interface InvoiceTaskPayload {
  invoiceLogId: string
  startyInvoiceId: string
  attempt: number
}

type TaskPayload = AbsenceTaskPayload | InvoiceTaskPayload

function getProjectPath(queue: string): string {
  const project = process.env.GCP_PROJECT_ID
  const location = process.env.GCP_LOCATION ?? 'europe-west1'
  if (!project) throw new Error('GCP_PROJECT_ID non configurato')
  return `projects/${project}/locations/${location}/queues/${queue}`
}

async function enqueueTask(queue: string, workerPath: string, payload: TaskPayload): Promise<string> {
  const queuePath = getProjectPath(queue)
  const workerBaseUrl = process.env.WORKER_BASE_URL
  const serviceAccountEmail = process.env.CLOUD_TASKS_SERVICE_ACCOUNT

  if (!workerBaseUrl) throw new Error('WORKER_BASE_URL non configurato')
  if (!serviceAccountEmail) throw new Error('CLOUD_TASKS_SERVICE_ACCOUNT non configurato')

  const [task] = await client.createTask({
    parent: queuePath,
    task: {
      httpRequest: {
        url: `${workerBaseUrl}${workerPath}`,
        httpMethod: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: Buffer.from(JSON.stringify(payload)).toString('base64'),
        oidcToken: {
          serviceAccountEmail,
          audience: workerBaseUrl,
        },
      },
    },
  })

  return task.name ?? ''
}

export async function enqueueAbsenceTask(payload: AbsenceTaskPayload): Promise<string> {
  const queue = process.env.CLOUD_TASKS_QUEUE_ABSENCES
  if (!queue) throw new Error('CLOUD_TASKS_QUEUE_ABSENCES non configurato')
  return enqueueTask(queue, '/api/workers/absence', payload)
}

export async function enqueueInvoiceTask(payload: InvoiceTaskPayload): Promise<string> {
  const queue = process.env.CLOUD_TASKS_QUEUE_INVOICES
  if (!queue) throw new Error('CLOUD_TASKS_QUEUE_INVOICES non configurato')
  return enqueueTask(queue, '/api/workers/invoice', payload)
}
