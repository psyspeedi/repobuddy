/**
 * Lightweight liveness/readiness probe. Returns 200 with a JSON
 * snapshot of dependency state. Intended for UptimeRobot / k8s probes
 * / dashboard widgets.
 *
 * Aggregate `ok` is true only when every dependency reports healthy.
 */
import { sql } from 'drizzle-orm'
import { getDb } from '../db/client'
import { getQuotaRedis } from '../lib/quotas'
import { getIndexWorkspaceQueue } from '../queues'

export default defineEventHandler(async (event) => {
  const config = useRuntimeConfig(event)
  const db = getDb(config.databaseUrl as string)
  const startedAt = Date.now()

  const checks: Record<string, { ok: boolean; latencyMs?: number; detail?: string }> = {}

  // DB ping.
  try {
    const t0 = Date.now()
    await db.execute(sql`select 1`)
    checks.db = { ok: true, latencyMs: Date.now() - t0 }
  } catch (err) {
    checks.db = { ok: false, detail: err instanceof Error ? err.message : String(err) }
  }

  // Redis ping (via the quota client; same connection pool).
  try {
    const redis = getQuotaRedis()
    const t0 = Date.now()
    const pong = await redis.ping()
    checks.redis = { ok: pong === 'PONG', latencyMs: Date.now() - t0 }
  } catch (err) {
    checks.redis = { ok: false, detail: err instanceof Error ? err.message : String(err) }
  }

  // Queue depth / worker liveness.
  try {
    const queue = getIndexWorkspaceQueue(config.redisUrl as string)
    const [waiting, active, failed] = await Promise.all([
      queue.getWaitingCount(),
      queue.getActiveCount(),
      queue.getFailedCount(),
    ])
    checks.queue = {
      ok: true,
      detail: `waiting=${waiting} active=${active} failed=${failed}`,
    }
  } catch (err) {
    checks.queue = { ok: false, detail: err instanceof Error ? err.message : String(err) }
  }

  const ok = Object.values(checks).every((c) => c.ok)
  if (!ok) setResponseStatus(event, 503)
  return {
    ok,
    checks,
    totalMs: Date.now() - startedAt,
    uptime: Math.round(process.uptime()),
  }
})
