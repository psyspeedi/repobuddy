/**
 * Cost ledger writer. One row per LLM call so /admin can show real
 * spend per workspace, per phase, per model.
 *
 * Conversion to USD cents uses the provider's quoted price-per-1M
 * tokens; for non-OpenAI providers (Groq, Ollama, …) the figure is an
 * upper-bound estimate keyed to the OpenAI model family. Operator should
 * treat it as a budget signal, not an invoice.
 */
import type { Database } from '../db/client'
import { llmCostLog } from '../db/schema'
import { llmCostCents, llmTokens } from './metrics'
import { getQuotaRedis } from './quotas'
import { sendAlert } from './alerts'
import { loadEnv } from './env'
import { getLogger } from './logger'

const log = getLogger().child({ component: 'cost-log' })

export type CostPhase = 'planning' | 'answering' | 'embedding' | 'annotation'

export interface CostInput {
  workspaceId: string
  phase: CostPhase
  model: string
  inputTokens?: number
  outputTokens?: number
  /** Cents per 1M input tokens. Pass from provider.costCentsPer1M*. */
  costCentsPer1MInput?: number
  costCentsPer1MOutput?: number
}

export async function recordCost(db: Database, input: CostInput): Promise<void> {
  const inTok = Math.max(0, input.inputTokens ?? 0)
  const outTok = Math.max(0, input.outputTokens ?? 0)
  if (inTok === 0 && outTok === 0) return

  const cents =
    Math.ceil((inTok * (input.costCentsPer1MInput ?? 0)) / 1_000_000) +
    Math.ceil((outTok * (input.costCentsPer1MOutput ?? 0)) / 1_000_000)

  try {
    await db.insert(llmCostLog).values({
      workspaceId: input.workspaceId,
      phase: input.phase,
      model: input.model,
      inputTokens: inTok,
      outputTokens: outTok,
      usdCents: cents,
    })
    // Mirror into Prometheus counters so Grafana can graph trends
    // without round-tripping the DB.
    if (inTok > 0) llmTokens.inc({ phase: input.phase, direction: 'in', model: input.model }, inTok)
    if (outTok > 0) llmTokens.inc({ phase: input.phase, direction: 'out', model: input.model }, outTok)
    if (cents > 0) llmCostCents.inc({ phase: input.phase, model: input.model }, cents)
    if (cents > 0) await trackGlobalDailySpend(cents)
  } catch (err) {
    // Cost logging is best-effort. A DB error here must never block the
    // user-facing operation that triggered it.
    log.warn({ err, input }, 'failed to record cost')
  }
}

/**
 * Maintain a Redis counter for today's total spend across the whole
 * service. Used by /api/chat/* to soft-block non-admin traffic when the
 * daily cap is reached, and fires Telegram alerts at 80% / 100%.
 */
async function trackGlobalDailySpend(cents: number): Promise<void> {
  const env = loadEnv()
  if (env.COST_BUDGET_USD_PER_DAY <= 0) return
  const day = new Date().toISOString().slice(0, 10)
  const key = `cg:cost:day:${day}`
  const redis = getQuotaRedis()
  const res = await redis
    .multi()
    .incrby(key, cents)
    .expire(key, 60 * 60 * 48)
    .exec()
  const after = Number(res?.[0]?.[1] ?? 0)
  const usd = after / 100
  const cap = env.COST_BUDGET_USD_PER_DAY
  if (usd >= cap) {
    await sendAlert(
      `Daily cost cap hit: $${usd.toFixed(2)} / $${cap.toFixed(2)}. Non-admin traffic is now soft-blocked until UTC midnight.`,
      { severity: 'critical', key: `cost-cap-${day}` },
    )
  } else if (usd >= cap * 0.8) {
    await sendAlert(
      `Daily cost at 80% of cap: $${usd.toFixed(2)} / $${cap.toFixed(2)}.`,
      { severity: 'warn', key: `cost-80-${day}` },
    )
  }
}

/** Read today's accumulated spend (USD). Used by chat gate + admin UI. */
export async function getTodaySpendUsd(): Promise<number> {
  const day = new Date().toISOString().slice(0, 10)
  try {
    const v = await getQuotaRedis().get(`cg:cost:day:${day}`)
    return v ? Number(v) / 100 : 0
  } catch {
    return 0
  }
}

/**
 * Throws 503 when non-admin traffic should be blocked because the daily
 * cap is reached. Admins / BYOK users skip the check (callers pass
 * `bypass: true`).
 */
export async function assertWithinDailyBudget(
  opts: { bypass?: boolean } = {},
): Promise<void> {
  if (opts.bypass) return
  const env = loadEnv()
  if (env.COST_BUDGET_USD_PER_DAY <= 0) return
  const usd = await getTodaySpendUsd()
  if (usd >= env.COST_BUDGET_USD_PER_DAY) {
    throw createError({
      statusCode: 503,
      statusMessage: `Service-wide daily LLM budget exhausted ($${usd.toFixed(2)} / $${env.COST_BUDGET_USD_PER_DAY}). Resets at UTC midnight.`,
    })
  }
}
