import type { User } from '@/payload-types'

type UserLike = Pick<User, 'role' | 'status'> | { role: 'sistema'; status: User['status'] } | null | undefined

export function isAdmin(user: UserLike): boolean {
  return user?.role === 'admin'
}

export function isHR(user: UserLike): boolean {
  return user?.role === 'hr'
}

export function isAmministrazione(user: UserLike): boolean {
  return user?.role === 'amministrazione'
}

export function isSistema(user: UserLike): boolean {
  return user?.role === 'sistema'
}

export function isActive(user: UserLike): boolean {
  return user?.status === 'active'
}
