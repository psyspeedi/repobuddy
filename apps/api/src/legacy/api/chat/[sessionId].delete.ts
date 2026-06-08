import { and, eq } from 'drizzle-orm'
import { getDb } from '../../db/client'
import { chatSessions } from '../../db/schema'
import { requireValidUser } from '../../lib/auth'

export default defineEventHandler(async (event) => {
  const user = await requireValidUser(event)
  const sessionId = getRouterParam(event, 'sessionId')
  if (!sessionId) {
    throw createError({ statusCode: 400, statusMessage: 'sessionId required' })
  }
  const config = useRuntimeConfig(event)
  const db = getDb(config.databaseUrl as string)

  // ON DELETE CASCADE on chat_messages.session_id cleans messages too.
  const deleted = await db
    .delete(chatSessions)
    .where(and(eq(chatSessions.id, sessionId), eq(chatSessions.userId, user.id)))
    .returning({ id: chatSessions.id })

  if (deleted.length === 0) {
    throw createError({ statusCode: 404, statusMessage: 'session not found' })
  }
  return { ok: true }
})
