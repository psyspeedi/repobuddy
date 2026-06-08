import { eq } from 'drizzle-orm'
import type { H3Event } from 'h3'
import { getDb } from '../db/client'
import { users, type User } from '../db/schema'

/**
 * Like `requireUserSession`, but additionally verifies the user row still
 * exists in the DB. Protects against stale sealed-cookie sessions surviving
 * a DB wipe / row deletion — without this check, downstream FK inserts on
 * tables referencing users.id will fail with 23503 and the request looks
 * like a 500 to the operator.
 *
 * Throws 401 + clears the session cookie when the user is gone.
 */
export async function requireValidUser(event: H3Event): Promise<User> {
  const session = await requireUserSession(event)
  const sessionUserId = session.user?.id
  if (!sessionUserId) {
    await clearUserSession(event)
    throw createError({ statusCode: 401, statusMessage: 'no user in session' })
  }

  const config = useRuntimeConfig(event)
  const db = getDb(config.databaseUrl as string)
  const [row] = await db
    .select()
    .from(users)
    .where(eq(users.id, sessionUserId))
    .limit(1)

  if (!row) {
    await clearUserSession(event)
    throw createError({
      statusCode: 401,
      statusMessage: 'session refers to a user that no longer exists',
    })
  }
  return row
}
