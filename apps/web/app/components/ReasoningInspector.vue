<script setup lang="ts">
/**
 * Reasoning panel. Two render modes:
 *   - flow (default): SVG flowchart of plan steps. Edges drawn from
 *     each step to whichever earlier steps it references via $sN in
 *     its params. Nodes coloured by trace outcome (ok / error /
 *     stream / pending).
 *   - list: the old compact accordion. Same content, vertical.
 *
 * The flow view answers "how did the LLM solve this?" at a glance —
 * the list view is for digging into params + raw results.
 */
import { LayoutGrid, List as ListIcon, Sparkles } from 'lucide-vue-next'
import type { AgenticStep, AgenticTrace, AnyTrace, PlanData, TraceEntry } from '@/composables/useChat'

interface Props {
  plan: PlanData | null | undefined
  trace: AnyTrace | null | undefined
}
const props = defineProps<Props>()
const { t } = useI18n()

const mode = ref<'flow' | 'list'>('flow')
const expanded = ref<Record<string, boolean>>({})
const selectedStepId = ref<string | null>(null)

// Discriminator: agentic traces are objects with mode='agentic', planned
// traces are arrays of TraceEntry. The chat endpoint emits one or the
// other but never both per turn.
const agenticTrace = computed<AgenticTrace | null>(() => {
  const t = props.trace
  if (t && !Array.isArray(t) && (t as AgenticTrace).mode === 'agentic') {
    return t as AgenticTrace
  }
  return null
})
const plannedTrace = computed<TraceEntry[] | null>(() => {
  const t = props.trace
  return Array.isArray(t) ? t : null
})

const expandedAgentic = ref<Record<number, boolean>>({})
function toggleAgentic(i: number): void {
  expandedAgentic.value[i] = !expandedAgentic.value[i]
}

// Group agentic steps by iteration. The LLM can dispatch multiple
// tool calls in a single round-trip (OpenAI parallel tools), so a
// single iteration may carry 1-N steps.
const agenticByIteration = computed<{ iteration: number; steps: AgenticStep[] }[]>(() => {
  const trace = agenticTrace.value
  if (!trace) return []
  const byIter = new Map<number, AgenticStep[]>()
  for (const s of trace.steps) {
    const arr = byIter.get(s.iteration) ?? []
    arr.push(s)
    byIter.set(s.iteration, arr)
  }
  return [...byIter.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([iteration, steps]) => ({ iteration, steps }))
})

// Color hint per operator family — helps the eye spot what kind of
// work happened (search vs traversal vs git vs answer-grounding).
const OP_FAMILY: Record<string, string> = {
  find_symbol: 'lookup',
  find_file: 'lookup',
  get_project_overview: 'lookup',
  list_concepts: 'lookup',
  get_callers: 'traversal',
  get_callees: 'traversal',
  get_dependencies: 'traversal',
  get_dependents: 'traversal',
  find_implementations: 'traversal',
  walkthrough: 'traversal',
  hybrid_search: 'search',
  vector_search_chunks: 'search',
  search_docs: 'search',
  find_by_concept: 'search',
  retrieve_code_chunks: 'retrieve',
  get_summary: 'retrieve',
  read_file: 'retrieve',
  tests_for: 'analysis',
  list_issues: 'external',
  list_prs: 'external',
  find_similar_issues: 'external',
  find_prs_for_issue: 'external',
  find_resolution: 'external',
  git_history: 'external',
  web_search: 'research',
  web_fetch: 'research',
  propose_edit: 'edit',
}
const FAMILY_TINT: Record<string, string> = {
  lookup: 'bg-sky-500/15 text-sky-700 dark:text-sky-300 ring-sky-500/30',
  traversal: 'bg-violet-500/15 text-violet-700 dark:text-violet-300 ring-violet-500/30',
  search: 'bg-amber-500/15 text-amber-700 dark:text-amber-300 ring-amber-500/30',
  retrieve: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 ring-emerald-500/30',
  analysis: 'bg-cyan-500/15 text-cyan-700 dark:text-cyan-300 ring-cyan-500/30',
  external: 'bg-rose-500/15 text-rose-700 dark:text-rose-300 ring-rose-500/30',
  research: 'bg-fuchsia-500/15 text-fuchsia-700 dark:text-fuchsia-300 ring-fuchsia-500/30',
  edit: 'bg-orange-500/15 text-orange-700 dark:text-orange-300 ring-orange-500/30',
  other: 'bg-muted text-muted-foreground ring-border',
}
function opTint(op: string): string {
  return FAMILY_TINT[OP_FAMILY[op] ?? 'other'] ?? FAMILY_TINT.other!
}

function toggle(id: string): void {
  expanded.value[id] = !expanded.value[id]
}

interface IndexedStep {
  step: PlanData['steps'][number]
  trace: TraceEntry | null
}

const indexedSteps = computed<IndexedStep[]>(() => {
  if (!props.plan) return []
  const arr = plannedTrace.value ?? []
  return props.plan.steps.map((step) => ({
    step,
    trace: arr.find((t) => t.stepId === step.id) ?? null,
  }))
})

// Parse the $sN references out of a step's params object. We only look
// at the top-level values — that's where the planner places references
// according to the schema (`{ context: ['$s1', '$s2'] }`,
// `{ entity: '$s2' }`, etc).
const REF_RE = /\$([a-zA-Z]+\d+)/g
function refsOf(params: Record<string, unknown>): string[] {
  const seen = new Set<string>()
  for (const v of Object.values(params)) {
    if (typeof v === 'string') {
      for (const m of v.matchAll(REF_RE)) if (m[1]) seen.add(m[1])
    } else if (Array.isArray(v)) {
      for (const item of v) {
        if (typeof item === 'string') {
          for (const m of item.matchAll(REF_RE)) if (m[1]) seen.add(m[1])
        }
      }
    }
  }
  return [...seen]
}

interface FlowNode {
  id: string
  op: string
  index: number
  level: number
  x: number
  y: number
  outcome: 'ok' | 'error' | 'stream' | 'pending'
  durationMs: number | null
  summary: string | null
  errorMessage: string | null
  refs: string[]
}
interface FlowEdge { from: string; to: string }

// Compute flowchart layout: levels via simple topo (a node sits one
// level deeper than the max of its references). Steps are stacked
// vertically within a level; the column is offset by level so the
// data flow reads top→bottom and slightly right.
const flow = computed<{ nodes: FlowNode[]; edges: FlowEdge[]; height: number; width: number }>(() => {
  if (!indexedSteps.value.length) return { nodes: [], edges: [], height: 0, width: 0 }

  const stepById = new Map<string, IndexedStep>()
  for (const e of indexedSteps.value) stepById.set(e.step.id, e)

  // Outcome classifier for colour + status pip.
  function classify(entry: IndexedStep): FlowNode['outcome'] {
    if (!entry.trace) return 'pending'
    if (!entry.trace.ok) return 'error'
    if (entry.trace.summary === '<stream>') return 'stream'
    return 'ok'
  }

  // Topo levels.
  const level = new Map<string, number>()
  const refsByStep = new Map<string, string[]>()
  for (const e of indexedSteps.value) {
    refsByStep.set(e.step.id, refsOf(e.step.params))
  }
  for (const e of indexedSteps.value) {
    const ownRefs = (refsByStep.get(e.step.id) ?? []).filter((r) => stepById.has(r))
    const lvl = ownRefs.length === 0
      ? 0
      : 1 + Math.max(...ownRefs.map((r) => level.get(r) ?? 0))
    level.set(e.step.id, lvl)
  }

  // Per-level vertical stack.
  const STEP_W = 180
  const STEP_H = 56
  const ROW_GAP = 18
  const COL_GAP = 60
  const PAD = 16

  const inLevel = new Map<number, string[]>()
  for (const e of indexedSteps.value) {
    const lvl = level.get(e.step.id) ?? 0
    const arr = inLevel.get(lvl) ?? []
    arr.push(e.step.id)
    inLevel.set(lvl, arr)
  }

  const nodes: FlowNode[] = []
  for (const e of indexedSteps.value) {
    const lvl = level.get(e.step.id) ?? 0
    const stack = inLevel.get(lvl) ?? []
    const indexInLevel = stack.indexOf(e.step.id)
    nodes.push({
      id: e.step.id,
      op: e.step.op,
      index: indexedSteps.value.indexOf(e) + 1,
      level: lvl,
      x: PAD + lvl * (STEP_W + COL_GAP),
      y: PAD + indexInLevel * (STEP_H + ROW_GAP),
      outcome: classify(e),
      durationMs: e.trace?.durationMs ?? null,
      summary: e.trace?.summary ?? null,
      errorMessage: e.trace?.error ?? null,
      refs: refsByStep.get(e.step.id) ?? [],
    })
  }

  const edges: FlowEdge[] = []
  for (const n of nodes) {
    for (const r of n.refs) if (nodes.find((x) => x.id === r)) edges.push({ from: r, to: n.id })
  }

  const maxLvl = Math.max(0, ...nodes.map((n) => n.level))
  const maxRow = Math.max(0, ...nodes.map((n) => {
    const stack = inLevel.get(n.level) ?? []
    return stack.length - 1
  }))
  const width = PAD * 2 + (maxLvl + 1) * STEP_W + maxLvl * COL_GAP
  const height = PAD * 2 + (maxRow + 1) * STEP_H + maxRow * ROW_GAP

  return { nodes, edges, height, width }
})

function nodeFill(n: FlowNode, selected: boolean): string {
  if (selected) return 'hsl(var(--primary) / 0.18)'
  switch (n.outcome) {
    case 'ok': return 'hsl(156 70% 48% / 0.15)'
    case 'error': return 'hsl(var(--destructive) / 0.18)'
    case 'stream': return 'hsl(252 75% 60% / 0.18)'
    default: return 'hsl(var(--muted) / 0.5)'
  }
}
function nodeStroke(n: FlowNode, selected: boolean): string {
  if (selected) return 'hsl(var(--primary))'
  switch (n.outcome) {
    case 'ok': return 'hsl(156 70% 40%)'
    case 'error': return 'hsl(var(--destructive))'
    case 'stream': return 'hsl(252 75% 58%)'
    default: return 'hsl(var(--border))'
  }
}

// Bezier path from one node's right edge to another node's left edge.
function edgePath(from: FlowNode, to: FlowNode): string {
  const STEP_W = 180
  const STEP_H = 56
  const x1 = from.x + STEP_W
  const y1 = from.y + STEP_H / 2
  const x2 = to.x
  const y2 = to.y + STEP_H / 2
  const mid = (x1 + x2) / 2
  return `M ${x1} ${y1} C ${mid} ${y1}, ${mid} ${y2}, ${x2} ${y2}`
}

const selectedDetails = computed(() => {
  const id = selectedStepId.value
  if (!id) return null
  return indexedSteps.value.find((e) => e.step.id === id) ?? null
})
</script>

<template>
  <aside class="flex h-full w-full flex-col gap-3 overflow-hidden rounded-lg border border-border bg-card p-3">
    <header class="flex items-center justify-between gap-2">
      <div class="min-w-0 flex-1 space-y-1">
        <h2 class="flex items-center gap-1.5 text-sm font-medium uppercase tracking-wide text-muted-foreground">
          {{ t('reasoning.title') }}
          <span
            v-if="agenticTrace"
            class="inline-flex items-center gap-1 rounded-full bg-primary/15 px-1.5 py-0.5 text-[10px] font-semibold tracking-wide text-primary"
            :title="t('reasoning.agenticBadgeHint')"
          >
            <Sparkles class="h-3 w-3" />
            {{ t('reasoning.agenticBadge') }}
          </span>
        </h2>
        <p v-if="plan && !agenticTrace" class="line-clamp-2 text-xs text-muted-foreground">
          {{ plan.reasoning }}
        </p>
        <p v-else-if="agenticTrace" class="text-xs text-muted-foreground">
          {{ t('reasoning.agenticSummary', {
            calls: agenticTrace.steps.length,
            iterations: agenticByIteration.length,
          }) }}
        </p>
      </div>
      <div v-if="!agenticTrace" class="flex items-center gap-1">
        <button
          type="button"
          class="rounded-md p-1.5 transition"
          :class="mode === 'flow' ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-accent'"
          :title="t('reasoning.viewFlow')"
          @click="mode = 'flow'"
        >
          <LayoutGrid class="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          class="rounded-md p-1.5 transition"
          :class="mode === 'list' ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-accent'"
          :title="t('reasoning.viewList')"
          @click="mode = 'list'"
        >
          <ListIcon class="h-3.5 w-3.5" />
        </button>
      </div>
    </header>

    <!-- Agentic mode — flat timeline grouped by iteration -->
    <div v-if="agenticTrace" class="flex-1 space-y-3 overflow-y-auto pr-1">
      <div
        v-if="agenticTrace.steps.length === 0"
        class="rounded border border-dashed border-border px-3 py-4 text-center text-xs text-muted-foreground"
      >
        {{ t('reasoning.agenticEmpty') }}
      </div>
      <div
        v-for="group in agenticByIteration"
        :key="group.iteration"
        class="space-y-1.5"
      >
        <div class="flex items-center gap-2 text-[10px] uppercase tracking-wide text-muted-foreground">
          <span class="rounded-full bg-muted px-1.5 py-0.5 font-semibold">
            {{ t('reasoning.iteration') }} {{ group.iteration }}
          </span>
          <span v-if="group.steps.length > 1" class="opacity-60">
            {{ t('reasoning.parallelCalls', { n: group.steps.length }) }}
          </span>
        </div>
        <div
          v-for="(step, i) in group.steps"
          :key="`${group.iteration}-${i}`"
          class="rounded-md border border-border"
        >
          <button
            type="button"
            class="flex w-full items-center justify-between gap-2 px-3 py-2 text-left hover:bg-accent/40"
            @click="toggleAgentic(group.iteration * 100 + i)"
          >
            <span class="flex min-w-0 items-center gap-2">
              <span
                class="inline-flex h-5 w-5 items-center justify-center rounded-full text-[10px] font-semibold"
                :class="step.error
                  ? 'bg-destructive/15 text-destructive'
                  : 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300'"
              >{{ step.error ? '!' : '✓' }}</span>
              <span
                class="rounded px-1.5 py-0.5 text-[10px] font-mono ring-1"
                :class="opTint(step.name)"
              >{{ step.name }}</span>
              <span class="truncate text-xs text-muted-foreground">{{ step.summary }}</span>
            </span>
            <span class="shrink-0 text-[10px] tabular-nums text-muted-foreground">
              {{ step.durationMs }}ms
            </span>
          </button>
          <div
            v-if="expandedAgentic[group.iteration * 100 + i]"
            class="border-t border-border bg-muted/30 px-3 py-2 text-xs space-y-2"
          >
            <details>
              <summary class="cursor-pointer select-none text-muted-foreground">
                {{ t('reasoning.args') }}
              </summary>
              <pre class="mt-1 whitespace-pre-wrap break-all">{{ JSON.stringify(step.args, null, 2) }}</pre>
            </details>
            <p v-if="step.summary" class="text-muted-foreground">
              <span class="font-medium">{{ t('reasoning.result') }}:</span>
              <code class="ml-1">{{ step.summary }}</code>
            </p>
            <p v-if="step.error" class="text-destructive">
              {{ t('reasoning.error') }}: {{ step.error }}
            </p>
          </div>
        </div>
      </div>
    </div>

    <!-- Flow mode (planned only) -->
    <div v-else-if="plan && mode === 'flow'" class="flex flex-1 flex-col gap-3 overflow-hidden">
      <div class="flex-1 overflow-auto rounded-md border border-border bg-background/40">
        <svg :width="flow.width" :height="flow.height" class="block">
          <g v-for="e in flow.edges" :key="`${e.from}->${e.to}`">
            <path
              :d="edgePath(
                flow.nodes.find((n) => n.id === e.from)!,
                flow.nodes.find((n) => n.id === e.to)!
              )"
              fill="none"
              stroke="hsl(var(--muted-foreground) / 0.5)"
              stroke-width="1.5"
            />
          </g>
          <g
            v-for="n in flow.nodes"
            :key="n.id"
            class="cursor-pointer"
            @click="selectedStepId = selectedStepId === n.id ? null : n.id"
          >
            <rect
              :x="n.x"
              :y="n.y"
              width="180"
              height="56"
              rx="8"
              :fill="nodeFill(n, selectedStepId === n.id)"
              :stroke="nodeStroke(n, selectedStepId === n.id)"
              stroke-width="1.5"
            />
            <text
              :x="n.x + 12"
              :y="n.y + 22"
              font-size="12"
              font-family="ui-monospace, monospace"
              font-weight="600"
              fill="hsl(var(--foreground))"
            >{{ n.op }}</text>
            <text
              :x="n.x + 12"
              :y="n.y + 40"
              font-size="10"
              fill="hsl(var(--muted-foreground))"
            >
              {{ n.id }}{{ n.durationMs != null ? ` · ${n.durationMs}ms` : '' }}
            </text>
          </g>
        </svg>
      </div>
      <div v-if="selectedDetails" class="rounded-md border border-border bg-muted/30 p-3 text-xs">
        <p class="mb-1 font-semibold">
          {{ selectedDetails.step.op }}
          <span class="ml-1 text-muted-foreground">({{ selectedDetails.step.id }})</span>
        </p>
        <p v-if="selectedDetails.step.comment" class="mb-1 italic text-muted-foreground">
          {{ selectedDetails.step.comment }}
        </p>
        <details class="mb-2">
          <summary class="cursor-pointer select-none text-muted-foreground">
            {{ t('reasoning.params') }}
          </summary>
          <pre class="mt-1 whitespace-pre-wrap break-all">{{ JSON.stringify(selectedDetails.step.params, null, 2) }}</pre>
        </details>
        <p v-if="selectedDetails.trace?.summary" class="text-muted-foreground">
          <span class="font-medium">{{ t('reasoning.result') }}:</span>
          <code class="ml-1">{{ selectedDetails.trace.summary }}</code>
        </p>
        <p v-if="selectedDetails.trace?.error" class="text-destructive">
          {{ t('reasoning.error') }}: {{ selectedDetails.trace.error }}
        </p>
      </div>
      <p v-else class="text-[11px] italic text-muted-foreground">
        {{ t('reasoning.flowHint') }}
      </p>
    </div>

    <!-- List mode (legacy) -->
    <ul v-else-if="plan && mode === 'list'" class="flex-1 space-y-1 overflow-y-auto pr-1">
      <li
        v-for="(entry, i) in indexedSteps"
        :key="entry.step.id"
        class="rounded-md border border-border"
      >
        <button
          type="button"
          class="flex w-full items-center justify-between gap-2 px-3 py-2 text-left hover:bg-accent"
          @click="toggle(entry.step.id)"
        >
          <span class="flex items-center gap-2">
            <span
              class="inline-flex h-5 w-5 items-center justify-center rounded-full text-xs"
              :class="
                entry.trace
                  ? entry.trace.ok
                    ? 'bg-green-500/15 text-green-700 dark:text-green-400'
                    : 'bg-destructive/15 text-destructive'
                  : 'bg-muted text-muted-foreground'
              "
            >{{ i + 1 }}</span>
            <code class="text-sm">{{ entry.step.op }}</code>
            <span class="text-xs text-muted-foreground">{{ entry.step.id }}</span>
          </span>
          <span class="text-xs text-muted-foreground">
            {{ entry.trace?.durationMs != null ? entry.trace.durationMs + 'ms' : '—' }}
          </span>
        </button>
        <div v-if="expanded[entry.step.id]" class="border-t border-border bg-muted/30 px-3 py-2 text-xs">
          <p v-if="entry.step.comment" class="mb-1 italic text-muted-foreground">
            {{ entry.step.comment }}
          </p>
          <details class="mb-2">
            <summary class="cursor-pointer select-none text-muted-foreground">
              {{ t('reasoning.params') }}
            </summary>
            <pre class="mt-1 whitespace-pre-wrap break-all">{{ JSON.stringify(entry.step.params, null, 2) }}</pre>
          </details>
          <p v-if="entry.trace?.summary" class="text-muted-foreground">
            <span class="font-medium">{{ t('reasoning.result') }}:</span> <code>{{ entry.trace.summary }}</code>
          </p>
          <p v-if="entry.trace?.error" class="text-destructive">
            {{ t('reasoning.error') }}: {{ entry.trace.error }}
          </p>
        </div>
      </li>
    </ul>

    <p v-else class="text-sm text-muted-foreground">
      {{ t('reasoning.noPlanYet') }}
    </p>
  </aside>
</template>
