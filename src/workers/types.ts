export type TaskStatus =
  | 'received'
  | 'queued'
  | 'processing'
  | 'completed'
  | 'failed'
  | 'dead'

export interface WorkerTaskPayload {
  taskId: string
  taskType: string
  attempt: number
  enqueuedAt: string
  data: Record<string, unknown>
}

export interface WorkerResult {
  success: boolean
  message: string
  externalId?: string
  retriable: boolean
}

export interface WorkerLogger {
  info(event: string, data?: Record<string, unknown>): void
  warn(event: string, data?: Record<string, unknown>): void
  error(event: string, data?: Record<string, unknown>): void
}

export interface WorkerContext {
  payload: WorkerTaskPayload
  logger: WorkerLogger
}

export type WorkerFn = (ctx: WorkerContext) => Promise<WorkerResult>
