import * as Sentry from '@sentry/node'

Sentry.init({
  dsn: process.env.SENTRY_DSN,
  environment: process.env.NODE_ENV,
  tracesSampleRate: process.env.NODE_ENV === 'production' ? 0.1 : 1.0,
  enabled: process.env.NODE_ENV !== 'development' && Boolean(process.env.SENTRY_DSN),
})

export interface MonitoringContext {
  taskId: string
  collection: 'absence-log' | 'invoice-log'
  attempt: number
  furiousId?: string
  startyId?: string
}

export function captureError(error: unknown, context: MonitoringContext): void {
  Sentry.withScope((scope) => {
    scope.setContext('task', { ...context } as Record<string, unknown>)
    scope.setTags({
      collection: context.collection,
      attempt: String(context.attempt),
      ...(context.furiousId && { furiousId: context.furiousId }),
      ...(context.startyId && { startyId: context.startyId }),
    })
    Sentry.captureException(error)
  })
}

export function captureMessage(message: string, context: MonitoringContext): void {
  Sentry.withScope((scope) => {
    scope.setContext('task', { ...context } as Record<string, unknown>)
    scope.setTags({
      collection: context.collection,
      attempt: String(context.attempt),
    })
    Sentry.captureMessage(message)
  })
}
