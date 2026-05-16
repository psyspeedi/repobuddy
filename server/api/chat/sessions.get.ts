import { sql } from 'drizzle-orm'
import { getDb } from '../../db/client'
import { chatMessages, chatSessions } from '../../db/schema'
import { requireValidUser } from '../../lib/auth'

interface SessionListItem {
  id: string
  title: string
  workspaceId: string
  createdAt: string
  updatedAt: string
  messageCount: number
  preview: string | null
}

export default defineEventHandler(async (event) => {
  const user = await requireValidUser(event)
  const query = getQuery(event)
  const workspaceId = typeof query.workspaceId === 'string' ? query.workspaceId : null
  if (!workspaceId) {
    throw createError({ statusCode: 400, statusMessage: 'workspaceId required' })
  }

  const config = useRuntimeConfig(event)
  const db = getDb(config.databaseUrl as string)

  // Pull sessions + a one-line preview from the latest assistant or user
  // message. We could project this in a single CTE; the JOIN with
  // distinct-on is succinct enough for this scale.
  const rows = await db.execute<{
    id: string
    title: string
    workspace_id: string
    created_at: string
    updated_at: string
    message_count: string
    preview: string | null
  }>(sql`
    SELECT
      s.id,
      s.title,
      s.workspace_id,
      s.created_at,
      s.updated_at,
      (SELECT COUNT(*) FROM ${chatMessages} m WHERE m.session_id = s.id) AS message_count,
      (
        SELECT m.content
        FROM ${chatMessages} m
        WHERE m.session_id = s.id
        ORDER BY m.created_at DESC
        LIMIT 1
      ) AS preview
    FROM ${chatSessions} s
    WHERE s.user_id = ${user.id} AND s.workspace_id = ${workspaceId}
    ORDER BY s.updated_at DESC
    LIMIT 50
  `)

  const sessions: SessionListItem[] = [...rows].map((r) => ({
    id: r.id,
    title: r.title,
    workspaceId: r.workspace_id,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    messageCount: Number(r.message_count),
    preview: r.preview ? r.preview.slice(0, 200) : null,
  }))

  return { sessions }
})
