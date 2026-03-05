import type { CollectionConfig } from 'payload'
import { canRead, canWrite } from '@/access/permissions'
import { setProcessedAtOnTerminalStatus } from '@/hooks/setProcessedAtOnTerminalStatus'

export const AbsenceLog: CollectionConfig = {
  slug: 'absence-log',
  admin: {
    group: 'Assenze',
    useAsTitle: 'furiousAbsenceId',
    defaultColumns: ['furiousAbsenceId', 'pseudo', 'status', 'createdAt'],
    description: 'Log di tutti gli eventi assenza ricevuti da Furious.',
  },
  access: {
    read: canRead('absenceLog'),
    create: canWrite('absenceLog'),
    update: canWrite('absenceLog'),
    delete: () => false,
  },
  hooks: {
    beforeChange: [setProcessedAtOnTerminalStatus],
  },
  fields: [
    {
      name: 'furiousAbsenceId',
      type: 'number',
      required: true,
      index: true,
      admin: { description: 'ID assenza su Furious (campo `id` del webhook).' },
    },
    {
      name: 'pseudo',
      type: 'text',
      required: true,
      index: true,
      admin: { description: 'Pseudonimo richiedente (campo `pseudo` del webhook).' },
    },
    {
      name: 'startDate',
      type: 'date',
      required: true,
      admin: { description: 'Data inizio assenza (campo `start_date`).' },
    },
    {
      name: 'endDate',
      type: 'date',
      required: true,
      admin: { description: 'Data fine assenza (campo `end_date`).' },
    },
    {
      name: 'absenceType',
      type: 'text',
      required: true,
      admin: { description: 'Tipo assenza (campo `type` — stringa completa da Furious).' },
    },
    {
      name: 'halfDay',
      type: 'select',
      options: [
        { label: 'Giornata intera', value: '0' },
        { label: 'Mattina', value: '1' },
        { label: 'Pomeriggio', value: '2' },
      ],
      admin: {
        description: 'Mezza giornata (campo `half_day`: 0=intera, 1=mattina, 2=pomeriggio).',
      },
    },
    {
      name: 'status',
      type: 'select',
      required: true,
      defaultValue: 'received',
      index: true,
      options: [
        { label: 'Ricevuto', value: 'received' },
        { label: 'In coda', value: 'queued' },
        { label: 'In elaborazione', value: 'processing' },
        { label: 'Approvato', value: 'approved' },
        { label: 'Saltato', value: 'skipped' },
        { label: 'Fallito (permanente)', value: 'failed_permanent' },
      ],
      admin: {
        description: 'Stato del processing. Vedi state machine in 010-collections.md.',
        readOnly: true,
      },
    },
    {
      name: 'attempts',
      type: 'number',
      defaultValue: 0,
      admin: {
        description: 'Numero di tentativi di processing eseguiti dal worker.',
        readOnly: true,
      },
    },
    {
      name: 'lastError',
      type: 'textarea',
      admin: {
        description: 'Ultimo messaggio di errore (stringa o JSON serializzato).',
        readOnly: true,
      },
    },
    {
      name: 'processedAt',
      type: 'date',
      admin: {
        description: 'Timestamp del completamento del processing (approved/skipped/failed).',
        readOnly: true,
      },
    },
    {
      name: 'rawPayload',
      type: 'json',
      required: true,
      admin: {
        description: 'Payload originale del webhook Furious. Immutabile dopo creazione.',
        readOnly: true,
      },
    },
    {
      name: 'taskName',
      type: 'text',
      admin: {
        description: 'Nome del task Cloud Tasks accodato (per debug e idempotency).',
        readOnly: true,
      },
    },
  ],
  timestamps: true,
}
