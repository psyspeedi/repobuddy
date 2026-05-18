/**
 * Return current daily quota usage for the caller. Used by the layout
 * to show a compact "used / limit" pill next to the user avatar.
 * Guests fall back to their cookie-pinned guest counter.
 */
import { getDb } from '../../db/client'
import { users } from '../../db/schema'
import { eq } from 'drizzle-orm'
import { ensureGuestId } from '../../lib/workspace-access'
import { isAdminLogin } from '../../lib/admin'
import { getStatus, type QuotaContext } from '../../lib/quotas'

export default defineEventHandler(async (event) => {
  const session = await getUserSession(event)
  const sessionUserId = session.user?.id as string | undefined
  let ctx: QuotaContext
  let kind: 'user' | 'guest' | 'admin' = 'guest'
  if (sessionUserId) {
    const config = useRuntimeConfig(event)
    const db = getDb(config.databaseUrl as string)
    const [u] = await db
      .select({ id: users.id, githubLogin: users.githubLogin, encryptedByokApiKey: users.encryptedByokApiKey })
      .from(users)
      .where(eq(users.id, sessionUserId))
      .limit(1)
    if (u) {
      const admin = isAdminLogin(u.githubLogin)
      ctx = {
        kind: 'user',
        id: u.id,
        bypass: admin || Boolean(u.encryptedByokApiKey),
      }
      kind = admin ? 'admin' : 'user'
    } else {
      ctx = { kind: 'guest', id: ensureGuestId(event) }
    }
  } else {
    ctx = { kind: 'guest', id: ensureGuestId(event) }
  }
  const status = await getStatus(ctx)
  return { ...status, viewerKind: kind }
})
