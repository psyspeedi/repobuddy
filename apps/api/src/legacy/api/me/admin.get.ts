/**
 * Lightweight "am I an admin?" probe. Used by the /admin page-level
 * middleware to decide whether to render the page or redirect.
 *
 * Returns 200 in all cases (auth'd or not). Caller branches on
 * `isAdmin`. Don't make this throw — middlewares that catch errors
 * hide the real cause (network vs. role) from the user.
 */
import { eq } from 'drizzle-orm'
import { getDb } from '../../db/client'
import { users } from '../../db/schema'
import { isAdminLogin } from '../../lib/admin'

export default defineEventHandler(async (event) => {
  const session = await getUserSession(event)
  const uid = session.user?.id as string | undefined
  if (!uid) return { isAdmin: false, reason: 'unauthenticated' }
  const config = useRuntimeConfig(event)
  const db = getDb(config.databaseUrl as string)
  const [u] = await db
    .select({ githubLogin: users.githubLogin })
    .from(users)
    .where(eq(users.id, uid))
    .limit(1)
  if (!u) return { isAdmin: false, reason: 'user not found' }
  return {
    isAdmin: isAdminLogin(u.githubLogin),
    login: u.githubLogin,
  }
})
