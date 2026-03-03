import type { PayloadRequest } from 'payload'

export type Resource =
  | 'autoApprovalRules'
  | 'absenceLog'
  | 'invoicePendingReview'
  | 'invoiceLog'
  | 'users'

export type UserRole = 'admin' | 'hr' | 'amministrazione' | 'sistema'

type UserStatus = 'invited' | 'active' | 'suspended'

interface PermissionProvider {
  canRead(role: UserRole, resource: Resource): boolean
  canWrite(role: UserRole, resource: Resource): boolean
}

const READ_PERMISSIONS: Record<Resource, UserRole[]> = {
  autoApprovalRules: ['admin'],
  absenceLog: ['admin', 'hr'],
  invoicePendingReview: ['admin', 'amministrazione'],
  invoiceLog: ['admin', 'amministrazione'],
  users: ['admin'],
}

const WRITE_PERMISSIONS: Record<Resource, UserRole[]> = {
  autoApprovalRules: ['admin'],
  absenceLog: ['admin', 'sistema'],
  invoicePendingReview: ['admin', 'amministrazione'],
  invoiceLog: ['admin', 'sistema'],
  users: ['admin'],
}

const staticProvider: PermissionProvider = {
  canRead: (role, resource) => READ_PERMISSIONS[resource].includes(role),
  canWrite: (role, resource) => WRITE_PERMISSIONS[resource].includes(role),
}

let activeProvider: PermissionProvider = staticProvider

export function _setPermissionProvider(provider: PermissionProvider): void {
  activeProvider = provider
}

export function canRead(resource: Resource) {
  return ({ req }: { req: PayloadRequest }): boolean => {
    const user = req.user as { role?: string; status?: string } | null
    if (!user) return false
    if ((user.status as UserStatus) === 'suspended') return false
    return activeProvider.canRead(user.role as UserRole, resource)
  }
}

export function canWrite(resource: Resource) {
  return ({ req }: { req: PayloadRequest }): boolean => {
    const user = req.user as { role?: string; status?: string } | null
    if (!user) return false
    if ((user.status as UserStatus) === 'suspended') return false
    return activeProvider.canWrite(user.role as UserRole, resource)
  }
}
