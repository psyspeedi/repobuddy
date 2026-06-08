/**
 * All workspaces with owner, status, last-indexed, public flag.
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
    name: string
    source_url: string | null
    owner_login: string | null
    status: string
    is_public: boolean
    last_indexed_at: string | null
    created_at: string
    cost_cents: number
  }>(sql`
    SELECT
      w.id, w.name, w.source_url, u.github_login AS owner_login,
      w.status, w.is_public, w.last_indexed_at, w.created_at,
      coalesce((SELECT sum(usd_cents)::int FROM llm_cost_log c WHERE c.workspace_id = w.id), 0) AS cost_cents
    FROM workspaces w
    LEFT JOIN users u ON u.id = w.owner_user_id
    ORDER BY w.created_at DESC
    LIMIT 500
  `)
  return { workspaces: [...rows] }
})
