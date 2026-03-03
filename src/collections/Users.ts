import type { CollectionConfig } from 'payload'
import { canRead, canWrite } from '../access/permissions'
import { sendInviteEmailHook } from './hooks/sendInviteEmailHook'
import { afterLoginHook } from './hooks/afterLoginHook'

export const Users: CollectionConfig = {
  slug: 'users',
  admin: {
    useAsTitle: 'email',
    group: 'Sistema',
    defaultColumns: ['email', 'role', 'status', 'updatedAt'],
  },
  access: {
    // Restituisce una query constraint che esclude il service account 'sistema'
    // dalla list view dell'admin UI. Il record esiste nel DB ed è accessibile
    // via Local API con overrideAccess: true, ma non appare nella lista utenti.
    read: ({ req }) => {
      const user = req.user as { role?: string; status?: string } | null
      if (!user) return false
      if (user.status === 'suspended') return false
      if (user.role === 'admin') return { role: { not_equals: 'sistema' } }
      return false
    },
    create: canWrite('users'),
    update: canWrite('users'),
    delete: () => false,
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
        // 'sistema' deve essere presente nelle options per passare la validazione
        // del campo select quando il service account viene creato via overrideAccess.
        // Non appare nell'UI grazie a admin.components o semplicemente perché
        // gli admin non creano service account manualmente.
        { label: 'Sistema (Service Account)', value: 'sistema' },
      ],
      // Nessun field-level access: la protezione è al collection-level (canWrite).
      // Il field-level access con req.user === null blocca silenziosamente
      // l'update di role/status anche con overrideAccess: true (che agisce solo
      // sul collection-level), impedendo la promozione invited→active nell'afterLoginHook.
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
      // Nessun field-level access: stessa motivazione di 'role' sopra.
      admin: {
        description: 'Stato account. Gli utenti sospesi non possono accedere.',
      },
    },
    {
      name: 'invitedAt',
      type: 'date',
      admin: {
        readOnly: true,
        description: 'Data di creazione del record di invito.',
      },
    },
    {
      name: 'invitedBy',
      type: 'relationship',
      relationTo: 'users',
      admin: {
        readOnly: true,
        description: 'Amministratore che ha creato l\'invito.',
      },
    },
  ],
  hooks: {
    beforeChange: [
      async ({ data, operation, originalDoc }) => {
        // Preserva role e status dal record esistente se non forniti nell'update.
        // Il plugin payload-oauth2 fa payload.update() con i dati di getUserInfo()
        // che potrebbero non includere role/status — questo hook garantisce che
        // i campi required non vengano mai azzerati da un update parziale.
        if (operation === 'update' && originalDoc) {
          if (!data.role) data.role = originalDoc.role
          if (!data.status) data.status = originalDoc.status
        }
        return data
      },
    ],
    afterChange: [sendInviteEmailHook],
    beforeLogin: [
      async ({ user }) => {
        // Blocca utenti sospesi — il JWT non viene emesso
        if ((user as { status?: string }).status === 'suspended') {
          throw new Error('Account sospeso. Contattare un amministratore.')
        }
        return user
      },
    ],
    afterLogin: [afterLoginHook],
  },
}
