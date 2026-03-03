import type { CollectionAfterLoginHook } from 'payload'

/**
 * Hook afterLogin sulla collection Users.
 *
 * Gestisce:
 * 1. Bootstrap admin: se l'email corrisponde a BOOTSTRAP_ADMIN_EMAIL e il ruolo
 *    non è 'admin', lo promuove. Non fa mai downgrade.
 * 2. Primo login: porta lo status da 'invited' ad 'active'.
 *
 * Nota: il blocco degli utenti 'suspended' avviene nel hook beforeLogin.
 */
export const afterLoginHook: CollectionAfterLoginHook = async ({ user, req }) => {
  const bootstrapAdminEmail = process.env.BOOTSTRAP_ADMIN_EMAIL
  const typedUser = user as { id: number; email?: string; role?: string; status?: string }

  const isBootstrapAdmin = bootstrapAdminEmail && typedUser.email === bootstrapAdminEmail

  // Promuove bootstrap admin se necessario — non fa mai downgrade
  if (isBootstrapAdmin && typedUser.role !== 'admin') {
    const updated = await req.payload.update({
      collection: 'users',
      id: typedUser.id,
      data: { role: 'admin', status: 'active' },
      overrideAccess: true,
      req,
    })
    return updated
  }

  // Primo login dopo invito: porta lo status da 'invited' ad 'active'
  if (typedUser.status === 'invited') {
    const updated = await req.payload.update({
      collection: 'users',
      id: typedUser.id,
      data: { status: 'active' },
      overrideAccess: true,
      req,
    })
    return updated
  }

  return user
}
