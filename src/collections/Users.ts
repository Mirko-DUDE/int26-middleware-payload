import type { CollectionConfig } from 'payload'

export const Users: CollectionConfig = {
  slug: 'users',
  admin: {
    useAsTitle: 'email',
    group: 'Sistema',
    defaultColumns: ['email', 'role', 'status', 'updatedAt'],
  },
  auth: {
    disableLocalStrategy: true,
  },
  fields: [
    {
      name: 'name',
      type: 'text',
      admin: {
        description: 'Nome visualizzato (valorizzato al primo login Google).',
      },
    },
    {
      name: 'role',
      type: 'select',
      required: true,
      defaultValue: 'hr',
      saveToJWT: true,
      options: [
        { label: 'Admin', value: 'admin' },
        { label: 'HR', value: 'hr' },
        { label: 'Amministrazione', value: 'amministrazione' },
      ],
      access: {
        update: ({ req: { user } }) => (user as { role?: string } | null)?.role === 'admin',
      },
      admin: {
        description: 'Ruolo operativo. Determina le aree visibili e le azioni permesse.',
      },
    },
    {
      name: 'status',
      type: 'select',
      required: true,
      defaultValue: 'invited',
      saveToJWT: true,
      options: [
        { label: 'Invitato', value: 'invited' },
        { label: 'Attivo', value: 'active' },
        { label: 'Sospeso', value: 'suspended' },
      ],
      access: {
        update: ({ req: { user } }) => (user as { role?: string } | null)?.role === 'admin',
      },
      admin: {
        description: 'Stato account. Gli utenti sospesi non possono accedere.',
      },
    },
  ],
}
