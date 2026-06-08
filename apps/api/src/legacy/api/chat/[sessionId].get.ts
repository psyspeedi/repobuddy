import { and, asc, eq } from 'drizzle-orm'
import { getDb } from '../../db/client'
import { chatMessages, chatSessions, users } from '../../db/schema'

/**
 * Fetch history for one chat session. Guests get an empty payload
 * (their chats are ephemeral — see [sessionId].post.ts).
 */
export default defineEventHandler(async (event) => {
  const sessionId = getRouterParam(event, 'sessionId')
  if (!sessionId) throw createError({ statusCode: 400, statusMessage: 'sessionId required' })

  const session = await getUserSession(event)
  const sessionUserId = session.user?.id as string | undefined
  if (!sessionUserId) return { session: null, messages: [] }

  const config = useRuntimeConfig(event)
  const db = getDb(config.databaseUrl as string)

  // requireValidUser-equivalent check inline (without throwing on guest).
  const [u] = await db.select().from(users).where(eq(users.id, sessionUserId)).limit(1)
  if (!u) return { session: null, messages: [] }

  const [row] = await db
    .select()
    .from(chatSessions)
    .where(and(eq(chatSessions.id, sessionId), eq(chatSessions.userId, u.id)))
    .limit(1)
  if (!row) return { session: null, messages: [] }

  const messages = await db
    .select()
    .from(chatMessages)
    .where(eq(chatMessages.sessionId, row.id))
    .orderBy(asc(chatMessages.createdAt))

  return { session: row, messages }
})
