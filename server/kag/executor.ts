import { OPERATORS, type OperatorContext, type OperatorName } from './operators'
import type { Plan, PlanStep } from '#shared/schemas/plan'
import { getLogger } from '../lib/logger'

const log = getLogger().child({ component: 'kag/executor' })

const REFERENCE_RE = /^\$(s\d+)((?:\.[\w]+|\[\d+\])*)$/
const NESTED_REFERENCE_RE = /\$(s\d+)((?:\.[\w]+|\[\d+\])*)/g

export interface ExecutorTraceEntry {
  stepId: string
  op: OperatorName
  ok: boolean
  durationMs: number
  /** Compact summary of the result (length / preview). */
  summary?: string
  error?: string
}

export interface ExecutorResult {
  results: Record<string, unknown>
  trace: ExecutorTraceEntry[]
  /** Stream emitted by the final `answer` step, if present. */
  finalStream?: AsyncIterable<unknown>
}

export class PlanExecutionError extends Error {
  constructor(
    readonly stepId: string,
    readonly op: string,
    readonly cause: unknown,
  ) {
    const msg = cause instanceof Error ? cause.message : String(cause)
    super(`[${stepId} ${op}] ${msg}`)
  }
}

/**
 * Execute a plan: resolve $sN.path references, topo-sort steps, dispatch
 * each operator. The final step's result is stored in `results[step.id]`
 * unless the step's operator returns an AsyncGenerator (e.g. `answer`),
 * in which case the stream is exposed via `finalStream`.
 */
export async function executePlan(
  plan: Plan,
  ctx: OperatorContext,
): Promise<ExecutorResult> {
  const sorted = topoSort(plan.steps)
  const results: Record<string, unknown> = {}
  const trace: ExecutorTraceEntry[] = []
  let finalStream: AsyncIterable<unknown> | undefined

  for (const step of sorted) {
    const op = OPERATORS[step.op as OperatorName]
    if (!op) throw new PlanExecutionError(step.id, step.op, `unknown operator: ${step.op}`)
    const params = resolveReferences(step.params, results)
    const start = Date.now()
    try {
      const out = op(params as never, ctx)
      // Detect async generator (streaming) vs promise.
      if (out && typeof (out as AsyncGenerator).next === 'function') {
        finalStream = out as AsyncIterable<unknown>
        trace.push({
          stepId: step.id,
          op: step.op as OperatorName,
          ok: true,
          durationMs: Date.now() - start,
          summary: '<stream>',
        })
        // We don't drain the stream here — the caller will iterate it.
        // No further steps should depend on the stream's value.
        continue
      }
      const result = await out
      results[step.id] = result
      trace.push({
        stepId: step.id,
        op: step.op as OperatorName,
        ok: true,
        durationMs: Date.now() - start,
        summary: summarise(result),
      })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      trace.push({
        stepId: step.id,
        op: step.op as OperatorName,
        ok: false,
        durationMs: Date.now() - start,
        error: msg,
      })
      log.warn({ step: step.id, op: step.op, err: msg }, 'step failed')
      throw new PlanExecutionError(step.id, step.op, err)
    }
  }

  return { results, trace, finalStream }
}

/**
 * Topological sort steps by their $sN dependencies. Detects cycles.
 * Steps without dependencies preserve their original order.
 */
function topoSort(steps: PlanStep[]): PlanStep[] {
  const byId = new Map<string, PlanStep>()
  const deps = new Map<string, Set<string>>()
  for (const s of steps) {
    byId.set(s.id, s)
    deps.set(s.id, collectDependencies(s.params))
  }
  const sorted: PlanStep[] = []
  const visited = new Set<string>()
  const visiting = new Set<string>()

  const visit = (id: string): void => {
    if (visited.has(id)) return
    if (visiting.has(id)) throw new Error(`cycle detected at step ${id}`)
    const step = byId.get(id)
    if (!step) throw new Error(`reference to unknown step ${id}`)
    visiting.add(id)
    for (const depId of deps.get(id) ?? []) {
      if (!byId.has(depId)) {
        throw new Error(`step ${id} references unknown step ${depId}`)
      }
      visit(depId)
    }
    visiting.delete(id)
    visited.add(id)
    sorted.push(step)
  }

  for (const s of steps) visit(s.id)
  return sorted
}

function collectDependencies(value: unknown): Set<string> {
  const deps = new Set<string>()
  walk(value, (v) => {
    if (typeof v !== 'string') return
    for (const match of v.matchAll(NESTED_REFERENCE_RE)) {
      const ref = match[1]
      if (ref) deps.add(ref)
    }
  })
  return deps
}

function walk(value: unknown, visit: (v: unknown) => void): void {
  visit(value)
  if (Array.isArray(value)) {
    for (const v of value) walk(v, visit)
  } else if (value && typeof value === 'object') {
    for (const v of Object.values(value)) walk(v, visit)
  }
}

export function resolveReferences(
  params: unknown,
  results: Record<string, unknown>,
): unknown {
  if (typeof params === 'string') {
    const match = params.match(REFERENCE_RE)
    if (!match) return params
    const ref = match[1]
    const path = match[2]
    if (!ref) return params
    const base = results[ref]
    return resolvePath(base, path ?? '')
  }
  if (Array.isArray(params)) return params.map((p) => resolveReferences(p, results))
  if (params && typeof params === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(params)) {
      out[k] = resolveReferences(v, results)
    }
    return out
  }
  return params
}

/** Apply dot/index path to a value: ".field" or "[0]" sequences. */
function resolvePath(value: unknown, path: string): unknown {
  if (!path) return value
  let cursor: unknown = value
  const segments = path.match(/\.[\w]+|\[\d+\]/g) ?? []
  for (const seg of segments) {
    if (cursor == null) return undefined
    if (seg.startsWith('.')) {
      const key = seg.slice(1)
      cursor = (cursor as Record<string, unknown>)[key]
    } else {
      const idx = Number(seg.slice(1, -1))
      cursor = (cursor as unknown[])[idx]
    }
  }
  return cursor
}

function summarise(value: unknown): string {
  if (Array.isArray(value)) {
    return `array(${value.length})`
  }
  if (value && typeof value === 'object') {
    const keys = Object.keys(value as Record<string, unknown>)
    return `object{${keys.slice(0, 5).join(',')}${keys.length > 5 ? ',…' : ''}}`
  }
  if (typeof value === 'string') {
    return `"${value.slice(0, 80)}${value.length > 80 ? '…' : ''}"`
  }
  return String(value)
}
