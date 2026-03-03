import type { CollectionConfig } from 'payload'
import { canRead, canWrite } from '@/access/permissions'

export const AutoApprovalRules: CollectionConfig = {
  slug: 'auto-approval-rules',
  admin: {
    group: 'Assenze',
    useAsTitle: 'pseudo',
    defaultColumns: ['pseudo', 'flowType', 'note', 'updatedAt'],
    description: 'Regole di auto-approvazione per pseudo manager.',
  },
  access: {
    read: canRead('autoApprovalRules'),
    create: canWrite('autoApprovalRules'),
    update: canWrite('autoApprovalRules'),
    delete: canWrite('autoApprovalRules'),
  },
  fields: [
    {
      name: 'pseudo',
      type: 'text',
      required: true,
      unique: true,
      index: true,
      admin: {
        description: 'Pseudonimo su Furious (case-sensitive).',
      },
    },
    {
      name: 'flowType',
      type: 'select',
      required: true,
      defaultValue: 'absence',
      index: true,
      options: [
        { label: 'Assenze', value: 'absence' },
      ],
      admin: {
        description: 'Tipo di flusso a cui si applica la regola.',
      },
    },
    {
      name: 'note',
      type: 'textarea',
      admin: {
        description: 'Note operative opzionali (non usate dal sistema).',
      },
    },
  ],
  timestamps: true,
}
