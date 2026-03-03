import type { CollectionConfig } from 'payload'
import { canRead, canWrite } from '@/access/permissions'
import { setProcessedAtOnTerminalStatus } from '@/hooks/setProcessedAtOnTerminalStatus'

// R2 — stub. Da completare insieme a InvoicePendingReview.
export const InvoiceLog: CollectionConfig = {
  slug: 'invoice-log',
  admin: {
    group: 'Fatture',
    useAsTitle: 'furiousInvoiceId',
    defaultColumns: ['furiousInvoiceId', 'startyInvoiceId', 'status', 'createdAt'],
    description: '[R2] Audit log completo di ogni evento fattura processato.',
  },
  access: {
    read: canRead('invoiceLog'),
    create: canWrite('invoiceLog'),
    update: canWrite('invoiceLog'),
    delete: () => false,
  },
  hooks: {
    beforeChange: [setProcessedAtOnTerminalStatus],
  },
  fields: [
    {
      name: 'furiousInvoiceId',
      type: 'number',
      required: true,
      index: true,
      admin: { description: 'ID fattura su Furious.' },
    },
    {
      name: 'startyInvoiceId',
      type: 'text',
      index: true,
      admin: { description: 'ID fattura su Starty.' },
    },
    {
      name: 'status',
      type: 'select',
      required: true,
      defaultValue: 'received',
      index: true,
      options: [
        { label: 'Ricevuto', value: 'received' },
        { label: 'In elaborazione', value: 'processing' },
        { label: 'Inviato', value: 'sent' },
        { label: 'Saltato', value: 'skipped' },
        { label: 'Fallito (permanente)', value: 'failed_permanent' },
      ],
      admin: { readOnly: true },
    },
    {
      name: 'attempts',
      type: 'number',
      defaultValue: 0,
      admin: { readOnly: true },
    },
    {
      name: 'lastError',
      type: 'textarea',
      admin: { readOnly: true },
    },
    {
      name: 'processedAt',
      type: 'date',
      admin: { readOnly: true },
    },
    {
      name: 'rawPayload',
      type: 'json',
      required: true,
      admin: { readOnly: true },
    },
  ],
  timestamps: true,
}
