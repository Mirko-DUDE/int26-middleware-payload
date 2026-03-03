import type { CollectionConfig } from 'payload'
import { canRead, canWrite } from '@/access/permissions'

// R2 — stub. Schema da completare dopo risposte amministrazione su campo PO.
export const InvoicePendingReview: CollectionConfig = {
  slug: 'invoice-pending-review',
  admin: {
    group: 'Fatture',
    useAsTitle: 'furiousInvoiceId',
    defaultColumns: ['furiousInvoiceId', 'status', 'createdAt'],
    description: '[R2] Coda fatture in attesa di revisione manuale.',
  },
  access: {
    read: canRead('invoicePendingReview'),
    create: canWrite('invoicePendingReview'),
    update: canWrite('invoicePendingReview'),
    delete: () => false,
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
      admin: { description: 'ID fattura su Starty (da definire in R2).' },
    },
    {
      name: 'purchaseOrder',
      type: 'text',
      admin: { description: 'Numero PO (campo da chiarire con amministrazione).' },
    },
    {
      name: 'status',
      type: 'select',
      required: true,
      defaultValue: 'pending',
      index: true,
      options: [
        { label: 'In attesa', value: 'pending' },
        { label: 'Revisionato', value: 'reviewed' },
        { label: 'Inviato', value: 'sent' },
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
