import type { CollectionBeforeChangeHook } from 'payload'

const TERMINAL_STATUSES = ['approved', 'skipped', 'failed_permanent', 'sent']

export const setProcessedAtOnTerminalStatus: CollectionBeforeChangeHook = ({ data, originalDoc }) => {
  if (TERMINAL_STATUSES.includes(data.status) && !originalDoc?.processedAt) {
    data.processedAt = new Date().toISOString()
  }
  return data
}
