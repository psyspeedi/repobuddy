/**
 * Paginated user list with workspace counts and a 30d activity column.
 */
import { sql } from 'drizzle-orm'
import { getDb } from '../../db/client'
import { requireAdmin } from '../../lib/admin-guard'

export default defineEventHandler(async (event) => {
  await requireAdmin(event)
  const config = useRuntimeConfig(event)
  const db = getDb(config.databaseUrl as string)
  const rows = await db.execute<{
    id: string
    github_login: string
    email: string | null
    avatar_url: string | null
    created_at: string
    workspace_count: number
    messages_30d: number
    has_byok: boolean
  }>(sql`
    SELECT
      u.id, u.github_login, u.email, u.avatar_url, u.created_at,
      (SELECT count(*)::int FROM workspaces w WHERE w.owner_user_id = u.id) AS workspace_count,
      (SELECT count(*)::int FROM chat_messages m
        JOIN chat_sessions s ON s.id = m.session_id
        WHERE s.user_id = u.id AND m.role = 'user'
        AND m.created_at > now() - interval '30 days') AS messages_30d,
      (u.encrypted_byok_api_key IS NOT NULL)            AS has_byok
    FROM users u
    ORDER BY u.created_at DESC
    LIMIT 200
  `)
  return { users: [...rows] }
})
