<script setup lang="ts">
import Graph from 'graphology'
import Sigma from 'sigma'
import forceAtlas2 from 'graphology-layout-forceatlas2'
import { circular } from 'graphology-layout'

interface GraphNode {
  id: string
  type: string
  name: string
  qualifiedName: string | null
  language: string | null
  filePath: string | null
  isContext?: boolean
}

interface GraphEdge {
  id: string
  fromEntityId: string
  toEntityId: string
  type: string
}

interface GraphResponse {
  nodes: GraphNode[]
  edges: GraphEdge[]
  truncated: boolean
  stats: { type: string; count: number }[]
  counts: { primary: number; context: number; edges: number }
}

const route = useRoute()
const workspaceId = String(route.params.id)

const typeColors: Record<string, string> = {
  file: '#6b7280',
  module: '#94a3b8',
  class: '#3b82f6',
  function: '#10b981',
  type: '#a855f7',
  variable: '#d1d5db',
  component: '#0ea5e9',
  route: '#f59e0b',
  test: '#ef4444',
  concept: '#ec4899',
  pattern: '#f97316',
  decision: '#facc15',
  commit: '#475569',
  pull_request: '#475569',
  person: '#22c55e',
  document: '#71717a',
}

// Edge colour palette. Picked to be distinguishable on both light and
// dark backgrounds without being garish. Unknown relation types fall back
// to the neutral grey.
const edgeColors: Record<string, string> = {
  calls: '#10b981',         // green — control flow
  imports: '#3b82f6',       // blue — module deps
  extends: '#a855f7',       // purple — class inheritance
  implements: '#a855f7',
  uses_type: '#7c3aed',
  defined_in: '#94a3b8',
  contained_in: '#94a3b8',
  renders: '#0ea5e9',
  handles: '#0ea5e9',
  tested_by: '#ef4444',
  implements_concept: '#facc15',
  follows_pattern: '#f59e0b',
  mentioned_in: '#cbd5e1',
  modified_by: '#ec4899',   // pink — git
  authored: '#22c55e',
  introduced_in: '#22c55e',
  relates_to: '#cbd5e1',
}
const DEFAULT_EDGE_COLOR = '#cbd5e1'

// Threshold above which we engage degree-based level-of-detail culling.
// Below this, every node renders unconditionally — Sigma handles it.
const LOD_THRESHOLD = 800

// View presets — one click swaps the type filter to a curated set.
interface ViewPreset {
  id: string
  label: string
  types: string[]
  description: string
}

const VIEW_PRESETS: ViewPreset[] = [
  {
    id: 'code',
    label: 'Code',
    types: ['file', 'module', 'class', 'function', 'type'],
    description: 'Files, classes, functions, types — and edges between them',
  },
  {
    id: 'git',
    label: 'Git',
    types: ['commit', 'person', 'file'],
    description: 'Commits, authors, modified files',
  },
  {
    id: 'semantic',
    label: 'Semantic',
    types: ['class', 'function', 'module', 'concept', 'pattern'],
    description: 'Domain concepts and architectural patterns over code',
  },
]

const activePreset = ref<string | null>('code')

// When arriving with ?highlight=<csv>, we have to know the types of those
// entities BEFORE the first /graph fetch fires — otherwise the default
// preset (Code) doesn't include commits/persons/concepts, the initial
// payload is missing them, and the user sees an "empty" highlighted set.
// Detect the types synchronously up-front and union them into selectedTypes.
const initialHighlightIds =
  typeof route.query.highlight === 'string'
    ? route.query.highlight.split(',').map((s) => s.trim()).filter(Boolean)
    : []

const initialTypes = new Set<string>(VIEW_PRESETS[0]?.types ?? [])
if (initialHighlightIds.length > 0) {
  const detected = await Promise.all(
    initialHighlightIds.map(async (id) => {
      try {
        const res = await $fetch<{ entity: { type: string } }>(
          `/api/workspaces/${workspaceId}/entity/${id}`,
        )
        return res.entity.type
      } catch {
        return null
      }
    }),
  )
  for (const t of detected) {
    if (t) initialTypes.add(t)
  }
  // Once the user filters away from the highlight, drop "code"-only mindset.
  activePreset.value = null
}

const selectedTypes = ref<string[]>([...initialTypes])
const selectedNodeId = ref<string | null>(null)
const hoveredEdgeId = ref<string | null>(null)
const containerRef = ref<HTMLDivElement | null>(null)
let sigma: Sigma | null = null
let graph: Graph | null = null

const visibleEdgeTypes = computed(() => {
  if (!data.value) return new Set<string>()
  return new Set(data.value.edges.map((e) => e.type))
})

const fetchLimit = ref(800)

const query = computed(() => ({
  types: selectedTypes.value.join(','),
  limit: fetchLimit.value,
  neighbors: '1',
}))

function loadMore(): void {
  fetchLimit.value = Math.min(fetchLimit.value + 1000, 5000)
  void refresh()
}

const { data, refresh, pending } = await useFetch<GraphResponse>(
  `/api/workspaces/${workspaceId}/graph`,
  { query, key: `graph-${workspaceId}` },
)

function nodeColor(node: GraphNode): string {
  const base = typeColors[node.type] ?? '#888'
  // Fade non-highlighted nodes only when the highlight set is a real
  // reasoning trace (≥ 2 nodes) so the eye can follow it. For a single
  // highlight (clicking one citation), we keep neighbours fully visible
  // so the user actually sees what the entity connects to.
  if (highlightSet.value.size >= 2) {
    if (highlightSet.value.has(node.id)) return base
    return base + '30' // ~19% alpha
  }
  // Context nodes (pulled in only because a primary node touches them) get
  // a desaturated colour so the eye locks on the user-requested set.
  if (node.isContext) return base + '70' // ~44% alpha in hex
  return base
}

function nodeSize(node: GraphNode): number {
  if (highlightSet.value.has(node.id)) return 12
  if (node.isContext) return 3
  if (node.type === 'class') return 8
  if (node.type === 'file') return 6
  if (node.type === 'commit') return 5
  return 4
}

// Reasoning-subgraph highlight: ids passed via ?highlight=<csv> from a chat
// message's citations. Highlighted nodes get a halo + bigger size, every
// other node fades so the eye picks up the path the planner used.
const highlightSet = computed(() => {
  const raw = route.query.highlight
  if (typeof raw !== 'string') return new Set<string>()
  return new Set(raw.split(',').map((s) => s.trim()).filter(Boolean))
})

function rebuild(): void {
  if (!data.value || !containerRef.value) return
  if (sigma) {
    sigma.kill()
    sigma = null
  }
  graph = new Graph({ multi: true })
  const seenIds = new Set<string>()
  for (const node of data.value.nodes) {
    if (seenIds.has(node.id)) continue
    seenIds.add(node.id)
    graph.addNode(node.id, {
      label: node.name,
      size: nodeSize(node),
      color: nodeColor(node),
      x: Math.random(),
      y: Math.random(),
      nodeType: node.type,
      qualifiedName: node.qualifiedName,
      isContext: !!node.isContext,
    })
  }
  for (const edge of data.value.edges) {
    if (!graph.hasNode(edge.fromEntityId) || !graph.hasNode(edge.toEntityId)) continue
    try {
      graph.addEdgeWithKey(edge.id, edge.fromEntityId, edge.toEntityId, {
        type: 'arrow',
        size: 1,
        color: edgeColors[edge.type] ?? DEFAULT_EDGE_COLOR,
        label: edge.type,
        edgeType: edge.type,
      })
    } catch {
      // duplicate key from multi-graph constraints
    }
  }

  // ForceAtlas2 with very few nodes tends to collapse them near the origin,
  // which makes the rendered graph look empty. Use a deterministic circular
  // layout for tiny graphs; FA2 for everything else.
  if (graph.order <= 10) {
    circular.assign(graph, { scale: 100 })
  } else {
    forceAtlas2.assign(graph, {
      iterations: 200,
      settings: {
        gravity: 1,
        scalingRatio: 10,
        slowDown: 5,
        barnesHutOptimize: true,
      },
    })
  }

  sigma = new Sigma(graph, containerRef.value, {
    // Edge labels are rendered globally only for hovered edge — see
    // edgeReducer below. Setting renderEdgeLabels: true is required for
    // the reducer's `label` field to actually paint.
    renderEdgeLabels: true,
    labelDensity: 0.5,
    labelGridCellSize: 60,
    minCameraRatio: 0.05,
    maxCameraRatio: 10,
  })

  // Level-of-detail (LOD): when the graph is dense (> LOD_THRESHOLD nodes),
  // hide low-degree nodes when zoomed out and progressively reveal them as
  // the camera zooms in. Highlighted and selected nodes always visible.
  if (graph.order > LOD_THRESHOLD) {
    const degreeByNode = new Map<string, number>()
    graph.forEachNode((n) => degreeByNode.set(n, graph!.degree(n)))

    sigma.setSetting('nodeReducer', (node, attrs) => {
      if (highlightSet.value.has(node) || node === selectedNodeId.value) {
        return attrs
      }
      const ratio = sigma!.getCamera().ratio
      const degreeFloor = Math.max(1, Math.round(ratio * 5))
      const deg = degreeByNode.get(node) ?? 0
      if (deg < degreeFloor) return { ...attrs, hidden: true }
      return attrs
    })
    sigma.getCamera().on('updated', () => sigma?.refresh())
  }

  // By default hide every edge label; only paint the one Sigma is hovering.
  sigma.setSetting('edgeReducer', (edge, attrs) => {
    const hovered = hoveredEdgeId.value === edge
    return {
      ...attrs,
      label: hovered ? attrs.label : '',
      size: hovered ? 2 : attrs.size,
      color: hovered ? attrs.color : attrs.color,
    }
  })

  sigma.on('enterEdge', ({ edge }) => {
    hoveredEdgeId.value = edge
    sigma?.refresh()
  })
  sigma.on('leaveEdge', () => {
    hoveredEdgeId.value = null
    sigma?.refresh()
  })

  sigma.on('clickNode', ({ node }) => {
    selectedNodeId.value = node
  })
}

watch(data, () => rebuild(), { immediate: false })
watch(highlightSet, () => rebuild())
watch(selectedNodeId, () => {
  // LOD nodeReducer reads selectedNodeId.value via closure — Sigma doesn't
  // know the ref changed. Force re-evaluation so the newly selected node
  // becomes visible (and the previously selected one fades back into
  // degree-gated visibility).
  sigma?.refresh()
})

onMounted(async () => {
  if (data.value) rebuild()
  // If we arrived with ?highlight=…, focus the first highlighted node once
  // the graph is laid out. This makes the chat → graph hand-off feel
  // intentional rather than dropping the user at a random viewport.
  await nextTick()
  const first = [...highlightSet.value][0]
  if (first) await focusEntity(first)
})

onBeforeUnmount(() => {
  sigma?.kill()
  sigma = null
})

const stats = computed(() => data.value?.stats ?? [])
const allTypes = computed(() => stats.value.map((s) => s.type))

function toggleType(t: string): void {
  const i = selectedTypes.value.indexOf(t)
  if (i === -1) selectedTypes.value = [...selectedTypes.value, t]
  else selectedTypes.value = selectedTypes.value.filter((x) => x !== t)
  // Manual checkbox edit means we're no longer matching any preset exactly.
  activePreset.value = matchPreset(selectedTypes.value)
  void refresh()
}

function applyPreset(p: ViewPreset): void {
  selectedTypes.value = [...p.types]
  activePreset.value = p.id
  void refresh()
}

function matchPreset(types: string[]): string | null {
  const sorted = [...types].sort().join(',')
  for (const p of VIEW_PRESETS) {
    if ([...p.types].sort().join(',') === sorted) return p.id
  }
  return null
}

/**
 * Focus an entity in the graph: pan + zoom + select.
 * If the node isn't currently in the rendered subgraph, refresh and try
 * again once the new payload arrives.
 */
async function focusEntity(id: string): Promise<void> {
  selectedNodeId.value = id
  if (!graph || !sigma || !graph.hasNode(id)) {
    // Node isn't in the current view. We don't know its type yet, so pull
    // it from the search endpoint to learn what filter would have to include
    // it, then ensure that type is selected before refetching.
    const hit = await fetchEntityType(id)
    if (hit?.type && !selectedTypes.value.includes(hit.type)) {
      selectedTypes.value = [...selectedTypes.value, hit.type]
      activePreset.value = matchPreset(selectedTypes.value)
    }
    await refresh()
    await nextTick()
    // wait one more frame so the watcher's rebuild() has actually run
    await nextTick()
    if (!graph || !sigma || !graph.hasNode(id)) return
  }
  panTo(id)
  // The LOD reducer reads selectedNodeId.value via closure; Sigma doesn't
  // know the value changed, so re-evaluate visibility explicitly.
  sigma.refresh()
}

async function fetchEntityType(
  id: string,
): Promise<{ type: string } | null> {
  try {
    const res = await $fetch<{ entity: { type: string } }>(
      `/api/workspaces/${workspaceId}/entity/${id}`,
    )
    return res.entity
  } catch {
    return null
  }
}

function panTo(id: string): void {
  if (!graph || !sigma) return
  const display = sigma.getNodeDisplayData(id)
  if (!display) return
  // ratio scales with graph size: tiny subgraphs (e.g. one commit + one
  // file) place every node near the origin, and a ratio of 0.3 zooms past
  // the whole layout. For small graphs we use a wider ratio; for very small
  // (≤ 3 nodes) we just reset to fit everything.
  const total = graph.order
  if (total <= 3) {
    sigma.getCamera().animatedReset({ duration: 400 })
    return
  }
  const ratio = total < 20 ? 1.0 : total < 100 ? 0.6 : 0.3
  sigma.getCamera().animate(
    { x: display.x, y: display.y, ratio },
    { duration: 400 },
  )
}

// Search.
interface SearchHit {
  id: string
  type: string
  name: string
  qualifiedName: string | null
  filePath: string | null
}
const searchQuery = ref('')
const searchResults = ref<SearchHit[]>([])
const searchOpen = ref(false)
let searchTimer: ReturnType<typeof setTimeout> | null = null

watch(searchQuery, (q) => {
  if (searchTimer) clearTimeout(searchTimer)
  if (!q.trim()) {
    searchResults.value = []
    searchOpen.value = false
    return
  }
  searchTimer = setTimeout(() => {
    void runSearch(q.trim())
  }, 200)
})

async function runSearch(q: string): Promise<void> {
  try {
    const res = await $fetch<{ results: SearchHit[] }>(
      `/api/workspaces/${workspaceId}/search`,
      { query: { q, limit: 15 } },
    )
    searchResults.value = res.results
    searchOpen.value = res.results.length > 0
  } catch {
    searchResults.value = []
    searchOpen.value = false
  }
}

async function pickSearchResult(hit: SearchHit): Promise<void> {
  searchOpen.value = false
  searchQuery.value = ''
  await focusEntity(hit.id)
}

useHead({ title: 'Graph — CodeGraph' })
</script>

<template>
  <div class="flex h-[calc(100vh-12rem)] gap-4">
    <aside class="w-56 shrink-0 space-y-3 overflow-y-auto rounded-lg border border-border bg-card p-3">
      <div class="space-y-1">
        <h2 class="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          View
        </h2>
        <div class="flex flex-wrap gap-1">
          <button
            v-for="p in VIEW_PRESETS"
            :key="p.id"
            type="button"
            class="rounded-md border px-2 py-1 text-xs transition"
            :class="
              activePreset === p.id
                ? 'border-primary bg-primary/10 text-primary'
                : 'border-border hover:bg-accent'
            "
            :title="p.description"
            @click="applyPreset(p)"
          >
            {{ p.label }}
          </button>
        </div>
      </div>

      <h2 class="text-xs font-medium uppercase tracking-wide text-muted-foreground">
        Types
      </h2>
      <ul class="space-y-1 text-sm">
        <li v-for="s in stats" :key="s.type">
          <label class="flex cursor-pointer items-center gap-2">
            <input
              type="checkbox"
              :checked="selectedTypes.includes(s.type)"
              class="accent-primary"
              @change="toggleType(s.type)"
            >
            <span
              class="inline-block h-2 w-2 rounded-full"
              :style="{ backgroundColor: typeColors[s.type] ?? '#888' }"
            />
            <span class="grow">{{ s.type }}</span>
            <span class="text-xs text-muted-foreground">{{ s.count }}</span>
          </label>
        </li>
      </ul>
      <div v-if="data?.counts" class="text-[10px] text-muted-foreground">
        {{ data.counts.primary }} primary, {{ data.counts.context }} context, {{ data.counts.edges }} edges
      </div>

      <details v-if="visibleEdgeTypes.size > 0" class="pt-1">
        <summary class="cursor-pointer text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Edges
        </summary>
        <ul class="mt-2 space-y-1 text-xs">
          <li v-for="t in [...visibleEdgeTypes].sort()" :key="t" class="flex items-center gap-2">
            <span class="inline-block h-2 w-6 rounded" :style="{ backgroundColor: edgeColors[t] ?? '#cbd5e1' }" />
            <span>{{ t }}</span>
          </li>
        </ul>
      </details>
      <div v-if="data?.truncated" class="space-y-1 rounded bg-yellow-500/10 p-2 text-xs text-yellow-700 dark:text-yellow-400">
        <p>Graph truncated at {{ fetchLimit }} nodes.</p>
        <button
          v-if="fetchLimit < 5000"
          type="button"
          class="text-yellow-700 underline underline-offset-2 hover:text-yellow-900 dark:text-yellow-300 dark:hover:text-yellow-100"
          @click="loadMore"
        >
          Load more →
        </button>
      </div>
    </aside>

    <section class="relative flex-1 overflow-hidden rounded-lg border border-border bg-card">
      <div ref="containerRef" class="absolute inset-0" />

      <div class="absolute left-3 right-3 top-3 z-10 max-w-md">
        <input
          v-model="searchQuery"
          type="text"
          placeholder="Search entities by name…"
          class="w-full rounded-md border border-border bg-background/95 px-3 py-1.5 text-sm shadow-sm backdrop-blur focus:outline-none focus:ring-2 focus:ring-ring"
          @focus="searchOpen = searchResults.length > 0"
        >
        <ul
          v-if="searchOpen"
          class="mt-1 max-h-72 overflow-y-auto rounded-md border border-border bg-card text-sm shadow-lg"
        >
          <li
            v-for="hit in searchResults"
            :key="hit.id"
            class="cursor-pointer border-b border-border px-3 py-2 last:border-0 hover:bg-accent"
            @click="pickSearchResult(hit)"
          >
            <div class="flex items-center gap-2">
              <span class="inline-block h-2 w-2 rounded-full" :style="{ backgroundColor: typeColors[hit.type] ?? '#888' }" />
              <span class="font-medium">{{ hit.name }}</span>
              <span class="text-xs text-muted-foreground">{{ hit.type }}</span>
            </div>
            <p v-if="hit.qualifiedName" class="break-all text-xs text-muted-foreground">
              {{ hit.qualifiedName }}
            </p>
          </li>
        </ul>
      </div>

      <div v-if="pending" class="absolute inset-0 grid place-items-center bg-card/60">
        Loading graph…
      </div>
      <div
        v-if="!pending && allTypes.length === 0"
        class="absolute inset-0 grid place-items-center text-sm text-muted-foreground"
      >
        Workspace has no entities yet — indexing may still be running.
      </div>
    </section>

    <GraphNodeDetail
      v-if="selectedNodeId"
      :workspace-id="workspaceId"
      :entity-id="selectedNodeId"
      @close="selectedNodeId = null"
      @focus="focusEntity"
    />
  </div>
</template>
