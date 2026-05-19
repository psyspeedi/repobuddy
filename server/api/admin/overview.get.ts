/**
 * Aggregate snapshot for the /admin dashboard header — counts +
 * today's spend + active maintainers. One round-trip to Postgres
 * and one Redis read.
 */
import { sql } from 'drizzle-orm'
import { getDb } from '../../db/client'
import { requireAdmin } from '../../lib/admin-guard'
import { getTodaySpendUsd } from '../../lib/cost-log'
import { loadEnv } from '../../lib/env'

export default defineEventHandler(async (event) => {
  await requireAdmin(event)
  const config = useRuntimeConfig(event)
  const db = getDb(config.databaseUrl as string)
  const [row] = await db.execute<{
    user_count: number
    workspace_count: number
    ready_count: number
    public_count: number
    active_30d: number
    cost_cents_today: number
    cost_cents_7d: number
  }>(sql`
    SELECT
      (SELECT count(*)::int FROM users)                            AS user_count,
      (SELECT count(*)::int FROM workspaces)                       AS workspace_count,
      (SELECT count(*)::int FROM workspaces WHERE status='ready')  AS ready_count,
      (SELECT count(*)::int FROM workspaces WHERE is_public=true)  AS public_count,
      (SELECT count(DISTINCT user_id)::int FROM chat_sessions
        WHERE updated_at > now() - interval '30 days')             AS active_30d,
      (SELECT coalesce(sum(usd_cents),0)::int FROM llm_cost_log
        WHERE created_at::date = current_date)                     AS cost_cents_today,
      (SELECT coalesce(sum(usd_cents),0)::int FROM llm_cost_log
        WHERE created_at > now() - interval '7 days')              AS cost_cents_7d
  `)
  const env = loadEnv()
  const liveSpend = await getTodaySpendUsd()
  return {
    counts: row ?? null,
    costToday: liveSpend,
    costCapUsd: env.COST_BUDGET_USD_PER_DAY,
  }
})
