/**
 * 401/403 gate for /api/admin/*. Returns the user row on success so
 * handlers can log who did what.
 */
import { eq } from 'drizzle-orm'
import type { H3Event } from 'h3'
import { getDb } from '../db/client'
import { users, type User } from '../db/schema'
import { isAdminLogin } from './admin'

export async function requireAdmin(event: H3Event): Promise<User> {
  const session = await getUserSession(event)
  const uid = session.user?.id as string | undefined
  if (!uid) {
    throw createError({ statusCode: 401, statusMessage: 'authentication required' })
  }
  const config = useRuntimeConfig(event)
  const db = getDb(config.databaseUrl as string)
  const [u] = await db.select().from(users).where(eq(users.id, uid)).limit(1)
  if (!u) throw createError({ statusCode: 401, statusMessage: 'user not found' })
  if (!isAdminLogin(u.githubLogin)) {
    throw createError({ statusCode: 403, statusMessage: 'admin only' })
  }
  return u
}
