/**
 * Prometheus metrics registry. Singleton across the Nitro process —
 * the /api/metrics endpoint exposes `register.metrics()`.
 *
 * Counters defined here are bumped from the relevant code paths
 * (chat completion, queue handler, planner failures, etc) — see
 * grep for "metrics." in server/ for callers.
 */
import { collectDefaultMetrics, Counter, Gauge, Histogram, Registry } from 'prom-client'

export const register = new Registry()
register.setDefaultLabels({ app: 'codegraph' })
collectDefaultMetrics({ register, prefix: 'codegraph_' })

export const chatRequests = new Counter({
  name: 'codegraph_chat_requests_total',
  help: 'Total chat completions, labelled by status and viewer kind.',
  labelNames: ['status', 'viewer'] as const,
  registers: [register],
})

export const chatLatency = new Histogram({
  name: 'codegraph_chat_latency_seconds',
  help: 'End-to-end latency of a chat completion (planner + execute + answer stream).',
  buckets: [0.5, 1, 2, 5, 10, 20, 40, 80],
  registers: [register],
})

export const llmTokens = new Counter({
  name: 'codegraph_llm_tokens_total',
  help: 'LLM tokens consumed, labelled by phase and io direction.',
  labelNames: ['phase', 'direction', 'model'] as const,
  registers: [register],
})

export const llmCostCents = new Counter({
  name: 'codegraph_llm_cost_cents_total',
  help: 'Estimated USD cents spent on LLM calls.',
  labelNames: ['phase', 'model'] as const,
  registers: [register],
})

export const indexJobs = new Counter({
  name: 'codegraph_index_jobs_total',
  help: 'Index pipeline runs, labelled by outcome.',
  labelNames: ['outcome'] as const,
  registers: [register],
})

export const queueDepth = new Gauge({
  name: 'codegraph_queue_depth',
  help: 'BullMQ index-workspace queue depth, by state.',
  labelNames: ['state'] as const,
  registers: [register],
})

export const plannerFailures = new Counter({
  name: 'codegraph_planner_failures_total',
  help: 'Planner attempts that fell back to the deterministic plan.',
  registers: [register],
})

export const quotaBlocks = new Counter({
  name: 'codegraph_quota_blocks_total',
  help: '429 responses from quota gates, labelled by kind.',
  labelNames: ['kind', 'metric'] as const,
  registers: [register],
})

// Per-KAG-operator instrumentation. Each step in a plan goes through
// the executor with a known operator name; we record latency and
// outcome separately for every op so the "Performance" dashboard can
// spot a slow find_symbol vs. a flaky hybrid_search.
export const operatorRuns = new Counter({
  name: 'codegraph_kag_operator_runs_total',
  help: 'KAG operator invocations, labelled by op and outcome.',
  labelNames: ['op', 'outcome'] as const,
  registers: [register],
})

export const operatorLatency = new Histogram({
  name: 'codegraph_kag_operator_latency_seconds',
  help: 'Latency of a single KAG operator invocation.',
  labelNames: ['op'] as const,
  buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 20],
  registers: [register],
})
