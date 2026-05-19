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
  } catch (err) {
    // Cost logging is best-effort. A DB error here must never block the
    // user-facing operation that triggered it.
    log.warn({ err, input }, 'failed to record cost')
  }
}
