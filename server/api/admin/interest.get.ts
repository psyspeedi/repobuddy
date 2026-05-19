/**
 * Aggregated interest pings for the /admin Interest tab. Joins to
 * users so admin sees @login + email next to the message.
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
    kind: string
    message: string | null
    created_at: string
    github_login: string
    email: string | null
  }>(sql`
    SELECT i.id, i.kind, i.message, i.created_at, u.github_login, u.email
    FROM interest_pings i
    JOIN users u ON u.id = i.user_id
    ORDER BY i.created_at DESC
    LIMIT 500
  `)
  const [{ total = 0 } = {}] = await db.execute<{ total: number }>(sql`
    SELECT count(*)::int AS total FROM interest_pings
  `)
  return { pings: [...rows], total }
})
