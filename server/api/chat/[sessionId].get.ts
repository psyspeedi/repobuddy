import { and, asc, eq } from 'drizzle-orm'
import { getDb } from '../../db/client'
import { chatMessages, chatSessions } from '../../db/schema'
import { requireValidUser } from '../../lib/auth'

export default defineEventHandler(async (event) => {
  const user = await requireValidUser(event)
  const sessionId = getRouterParam(event, 'sessionId')
  if (!sessionId) throw createError({ statusCode: 400, statusMessage: 'sessionId required' })

  const config = useRuntimeConfig(event)
  const db = getDb(config.databaseUrl as string)

  const [session] = await db
    .select()
    .from(chatSessions)
    .where(and(eq(chatSessions.id, sessionId), eq(chatSessions.userId, user.id)))
    .limit(1)
  if (!session) {
    return { session: null, messages: [] }
  }

  const messages = await db
    .select()
    .from(chatMessages)
    .where(eq(chatMessages.sessionId, session.id))
    .orderBy(asc(chatMessages.createdAt))

  return { session, messages }
})
