<script setup lang="ts">
import type Graph from 'graphology'
import type Sigma from 'sigma'
import { Button } from '@/components/ui/button'

// ---------- Constants ----------
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
const edgeColors: Record<string, string> = {
  calls: '#10b981',
  imports: '#3b82f6',
  extends: '#a855f7',
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
  modified_by: '#ec4899',
  authored: '#22c55e',
  introduced_in: '#22c55e',
  relates_to: '#cbd5e1',
}
const DEFAULT_EDGE_COLOR = '#cbd5e1'
const LOD_THRESHOLD = 800

interface ViewPreset {
  id: string
  label: string
  types: string[]
  description: string
}
const VIEW_PRESETS: ViewPreset[] = [
  { id: 'code', label: 'Code', types: ['file', 'module', 'class', 'function', 'type'], description: 'Files, classes, functions, types' },
  { id: 'git', label: 'Git', types: ['commit', 'person', 'file'], description: 'Commits, authors, modified files' },
  { id: 'semantic', label: 'Semantic', types: ['class', 'function', 'module', 'concept', 'pattern'], description: 'Domain concepts and patterns over code' },
]

// ---------- Types ----------
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

// ---------- Route + state ----------
const route = useRoute()
const workspaceId = String(route.params.id)

const selectedTypes = ref<string[]>([...(VIEW_PRESETS[0]?.types ?? [])])
const activePreset = ref<string | null>('code')
const selectedNodeId = ref<string | null>(null)
const hoveredEdgeId = ref<string | null>(null)
const fetchLimit = ref(800)
const containerRef = ref<HTMLDivElement | null>(null)

const highlightSet = computed(() => {
  const raw = route.query.highlight
  if (typeof raw !== 'string') return new Set<string>()
  return new Set(raw.split(',').map((s) => s.trim()).filter(Boolean))
})

const query = computed(() => ({
  types: selectedTypes.value.join(','),
  limit: fetchLimit.value,
  neighbors: '1',
}))

// `watch: false` disables Nuxt's automatic refetch on reactive query
// changes. We only refetch on EXPLICIT refresh() calls (toggleType,
// applyPreset, loadMore, onMounted highlight expansion). Without this,
// mutating selectedTypes triggered an auto-refetch in parallel with our
// explicit refresh — two responses, two data mutations, two rebuilds,
// camera fight, "graph flashes then disappears".
const { data, refresh, pending } = await useFetch<GraphResponse>(
  `/api/workspaces/${workspaceId}/graph`,
  { query, key: `graph-${workspaceId}`, watch: false },
)

// ---------- Diagnostic state (visible in dev) ----------
const diag = reactive({
  libsLoaded: false,
  rebuildCount: 0,
  lastError: '' as string,
  graphOrder: 0,
  graphSize: 0,
  sigmaPresent: false,
  containerWidth: 0,
  containerHeight: 0,
})

// ---------- Runtime lib refs (filled in onMounted) ----------
type GraphCtor = new (opts?: { multi?: boolean }) => Graph
type SigmaCtor = new (g: Graph, c: HTMLElement, s?: Record<string, unknown>) => Sigma
let GraphCtor: GraphCtor | null = null
let SigmaCtor: SigmaCtor | null = null
let fa2: { assign(g: Graph, opts: { iterations: number; settings: Record<string, unknown> }): void } | null = null
let circularLayout: { assign(g: Graph, opts?: { scale?: number }): void } | null = null
let sigma: Sigma | null = null
let graph: Graph | null = null

// ---------- Helpers ----------
// Highlighted nodes use this colour regardless of their type so the eye
// catches them immediately. Bright orange contrasts well with every
// type palette colour and against both light and dark canvas.
const HIGHLIGHT_COLOR = '#f97316'
const HIGHLIGHT_SIZE = 16

// Base (un-highlighted) color/size by node type. The reducer below
// applies the highlight overlay on top of these so the original look
// is preserved exactly when the highlight is cleared.
function baseNodeColor(node: GraphNode): string {
  const base = typeColors[node.type] ?? '#888'
  if (node.isContext) return base + '70'
  return base
}
function baseNodeSize(node: GraphNode): number {
  if (node.isContext) return 3
  if (node.type === 'class') return 8
  if (node.type === 'file') return 6
  if (node.type === 'commit') return 5
  return 4
}

// ---------- Core rebuild ----------
function rebuild(): void {
  try {
    if (!data.value) {
      diag.lastError = 'data.value is null'
      return
    }
    if (!containerRef.value) {
      diag.lastError = 'containerRef is null'
      return
    }
    if (!GraphCtor || !SigmaCtor || !fa2 || !circularLayout) {
      diag.lastError = 'libs not loaded yet'
      return
    }

    const rect = containerRef.value.getBoundingClientRect()
    diag.containerWidth = rect.width
    diag.containerHeight = rect.height
    if (rect.width === 0 || rect.height === 0) {
      diag.lastError = `container has zero size (${rect.width}x${rect.height})`
      // Don't abort — Sigma can still init; we just won't see anything.
    }

    if (sigma) {
      sigma.kill()
      sigma = null
    }

    graph = new GraphCtor({ multi: true })
    const seenIds = new Set<string>()
    for (const node of data.value.nodes) {
      if (seenIds.has(node.id)) continue
      seenIds.add(node.id)
      const c = baseNodeColor(node)
      const s = baseNodeSize(node)
      graph.addNode(node.id, {
        label: node.name,
        size: s,
        color: c,
        // Store the base look so the reducer can revert when highlight clears.
        baseColor: c,
        baseSize: s,
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
        /* dup */
      }
    }

    diag.graphOrder = graph.order
    diag.graphSize = graph.size

    if (graph.order === 0) {
      diag.lastError = 'graph has 0 nodes after build — payload has none for selected filters'
      return
    }

    if (graph.order <= 10) {
      circularLayout.assign(graph, { scale: 100 })
    } else {
      fa2.assign(graph, {
        iterations: 200,
        settings: { gravity: 1, scalingRatio: 10, slowDown: 5, barnesHutOptimize: true },
      })
    }

    sigma = new SigmaCtor(graph, containerRef.value, {
      renderEdgeLabels: true,
      labelDensity: 0.5,
      labelGridCellSize: 60,
      minCameraRatio: 0.05,
      maxCameraRatio: 10,
    })
    diag.sigmaPresent = true

    // Universal node reducer: applies highlight overlay AND optional LOD
    // culling. Runs on every refresh, so reverting the highlight is just
    // a sigma.refresh() away — no rebuild needed.
    const lodActive = graph.order > LOD_THRESHOLD
    const degreeByNode = new Map<string, number>()
    if (lodActive) {
      graph.forEachNode((n) => degreeByNode.set(n, graph!.degree(n)))
    }
    sigma.setSetting('nodeReducer', (node, attrs) => {
      const hl = highlightSet.value
      const isHighlighted = hl.has(node)
      const isSelected = node === selectedNodeId.value

      // Always start from the stored base color/size so the node returns
      // to its original look the moment highlight clears.
      const baseColor = (attrs.baseColor as string | undefined) ?? attrs.color
      const baseSize = (attrs.baseSize as number | undefined) ?? attrs.size

      let color: string = baseColor
      let size: number = baseSize
      if (isHighlighted) {
        color = HIGHLIGHT_COLOR
        size = HIGHLIGHT_SIZE
      } else if (hl.size >= 2) {
        // Faded — part of a multi-node reasoning trace but not THIS node.
        color = baseColor + '30'
      }

      let hidden = false
      if (lodActive && !isHighlighted && !isSelected) {
        const ratio = sigma!.getCamera().ratio
        const degreeFloor = Math.max(1, Math.round(ratio * 5))
        const deg = degreeByNode.get(node) ?? 0
        if (deg < degreeFloor) hidden = true
      }

      return { ...attrs, color, size, hidden }
    })
    if (lodActive) {
      sigma.getCamera().on('updated', () => sigma?.refresh())
    }

    sigma.setSetting('edgeReducer', (edge, attrs) => {
      const hovered = hoveredEdgeId.value === edge
      return { ...attrs, label: hovered ? attrs.label : '', size: hovered ? 2 : attrs.size }
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

    // Force a paint on the next frame. We do NOT touch the camera here —
    // any positioning is the caller's job (panTo or fit-on-mount). This
    // avoids racing with a subsequent panTo when both rebuild and panTo
    // try to animate the camera within a few ms of each other.
    requestAnimationFrame(() => sigma?.refresh())

    diag.rebuildCount++
    diag.lastError = ''
  } catch (err) {
    diag.lastError = `rebuild threw: ${err instanceof Error ? err.message : String(err)}`
    console.error('graph rebuild error', err)
  }
}

// ---------- Lifecycle ----------
onMounted(async () => {
  try {
    const [graphologyMod, sigmaMod, fa2Mod, layoutMod] = await Promise.all([
      import('graphology'),
      import('sigma'),
      import('graphology-layout-forceatlas2'),
      import('graphology-layout'),
    ])
    GraphCtor = graphologyMod.default as unknown as GraphCtor
    SigmaCtor = sigmaMod.default as unknown as SigmaCtor
    fa2 = fa2Mod.default as unknown as typeof fa2
    circularLayout = { assign: layoutMod.circular.assign } as unknown as typeof circularLayout

    // If we arrived with ?highlight, expand selectedTypes BEFORE flipping
    // libsLoaded — that way the data watcher won't fire on stale data,
    // and the refresh() that follows will trigger exactly one rebuild.
    const ids = [...highlightSet.value]
    let willRefresh = false
    if (ids.length > 0) {
      const types = await Promise.all(
        ids.map(async (id) => {
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
      for (const t of types) {
        if (t && !selectedTypes.value.includes(t)) {
          selectedTypes.value = [...selectedTypes.value, t]
          willRefresh = true
        }
      }
      if (willRefresh) activePreset.value = null
    }

    diag.libsLoaded = true

    if (willRefresh) {
      // Trigger refresh; the data watcher will rebuild on response.
      await refresh()
      await nextTick()
      await nextTick()
    } else if (data.value) {
      // No refresh needed — watcher won't fire because data didn't change.
      // Build once manually.
      rebuild()
      await nextTick()
    }

    // Now the canvas has the right scene; position the camera.
    const first = ids[0]
    if (first && graph?.hasNode(first)) {
      panTo(first)
    } else if (!first) {
      // No highlight — fit the whole graph.
      sigma?.getCamera().animatedReset({ duration: 0 })
    }
  } catch (err) {
    diag.lastError = `onMounted: ${err instanceof Error ? err.message : String(err)}`
  }
})

onBeforeUnmount(() => {
  sigma?.kill()
  sigma = null
})

// Single watcher that rebuilds when data changes after libs are loaded.
// Don't rebuild for highlight set changes alone (no need — same nodes,
// just different colors); a sigma.refresh handles colour re-evaluation.
watch(
  () => data.value,
  () => {
    if (diag.libsLoaded && data.value) rebuild()
  },
)
watch(highlightSet, () => sigma?.refresh())
watch(selectedNodeId, () => sigma?.refresh())

// ---------- Filters / search / actions ----------
const stats = computed(() => data.value?.stats ?? [])
const allTypes = computed(() => stats.value.map((s) => s.type))
const visibleEdgeTypes = computed(() => {
  if (!data.value) return new Set<string>()
  return new Set(data.value.edges.map((e) => e.type))
})

function toggleType(t: string): void {
  const i = selectedTypes.value.indexOf(t)
  if (i === -1) selectedTypes.value = [...selectedTypes.value, t]
  else selectedTypes.value = selectedTypes.value.filter((x) => x !== t)
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
function loadMore(): void {
  fetchLimit.value = Math.min(fetchLimit.value + 1000, 5000)
  void refresh()
}

async function focusEntity(id: string): Promise<void> {
  selectedNodeId.value = id
  if (!graph || !sigma || !graph.hasNode(id)) {
    const hit = await fetchEntityType(id)
    if (hit?.type && !selectedTypes.value.includes(hit.type)) {
      selectedTypes.value = [...selectedTypes.value, hit.type]
      activePreset.value = matchPreset(selectedTypes.value)
    }
    await refresh()
    await nextTick()
    await nextTick()
  }
  if (graph?.hasNode(id)) panTo(id)
  sigma?.refresh()
}

async function fetchEntityType(id: string): Promise<{ type: string } | null> {
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
  if (!graph.hasNode(id)) return
  // Earlier versions of this fed graph-space coordinates from
  // sigma.getNodeDisplayData() straight into camera.animate(). That
  // sent the camera to (100, 0) when the layout used scale=100 and
  // produced the "flash then fly to corner" bug.
  //
  // Sigma's animatedReset uses the renderer's internal bbox to compute
  // a camera state that frames the whole graph — always sane. The
  // highlight banner + bright-orange node colour are enough to draw
  // the eye to the target without centring on it.
  sigma.getCamera().animatedReset({ duration: 400 })
}

// Search
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
  searchTimer = setTimeout(() => void runSearch(q.trim()), 200)
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

const showDebug = ref(false)

// Resolve highlighted entity names for an explanatory banner over the canvas.
const highlightedNodes = computed(() => {
  if (!data.value) return []
  const set = highlightSet.value
  if (set.size === 0) return []
  return data.value.nodes
    .filter((n) => set.has(n.id))
    .map((n) => ({ id: n.id, name: n.name, type: n.type }))
})

function clearHighlight(): void {
  const q = { ...route.query }
  delete q.highlight
  void navigateTo({ path: route.path, query: q }, { replace: true })
  // The watch(highlightSet) handler triggers sigma.refresh, which re-runs
  // the nodeReducer with an empty highlight set → nodes revert to baseColor.
  // We also re-fit the camera since the user wanted a "clear" view.
  sigma?.getCamera().animatedReset({ duration: 300 })
}

useHead({ title: 'Graph — CodeGraph' })
</script>

<template>
  <div class="space-y-3">
    <div class="flex items-center gap-2">
      <NuxtLink :to="`/w/${workspaceId}`">
        <Button variant="ghost" size="sm">
          ← Back to chat
        </Button>
      </NuxtLink>
      <span class="text-sm text-muted-foreground">Graph view</span>
    </div>
    <div class="flex h-[calc(100vh-14rem)] gap-4">
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
            <span class="inline-block h-2 w-2 rounded-full" :style="{ backgroundColor: typeColors[s.type] ?? '#888' }" />
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
        <button v-if="fetchLimit < 5000" type="button" class="underline" @click="loadMore">
          Load more →
        </button>
      </div>
    </aside>

    <section class="relative flex-1 overflow-hidden rounded-lg border border-border bg-card">
      <ClientOnly>
        <div ref="containerRef" class="absolute inset-0" />
      </ClientOnly>

      <!-- Highlight banner: shows the entity(ies) the user is centring on -->
      <div
        v-if="highlightedNodes.length > 0"
        class="absolute left-3 top-14 z-10 flex max-w-md items-center gap-2 rounded-md border border-orange-500/40 bg-orange-500/10 px-3 py-1.5 text-xs shadow-sm backdrop-blur"
      >
        <span class="inline-block h-2 w-2 rounded-full bg-orange-500" />
        <span class="font-medium">
          Highlighted: {{ highlightedNodes.map((n) => `${n.name} (${n.type})`).join(', ') }}
        </span>
        <button
          type="button"
          class="ml-auto text-muted-foreground hover:text-foreground"
          title="Clear highlight"
          @click="clearHighlight"
        >
          ×
        </button>
      </div>

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

      <!-- Diagnostic widget — hidden via showDebug toggle. -->
      <div
        v-if="showDebug"
        class="absolute bottom-3 right-3 z-10 max-w-sm rounded-md border border-border bg-card/95 p-2 text-[11px] font-mono shadow-lg backdrop-blur"
      >
        <div class="mb-1 flex items-center justify-between text-muted-foreground">
          <span>diagnostic</span>
          <button class="hover:text-foreground" @click="showDebug = false">
            ×
          </button>
        </div>
        <div>libs loaded: {{ diag.libsLoaded }}</div>
        <div>data: {{ data ? `${data.nodes?.length ?? 0} nodes / ${data.edges?.length ?? 0} edges` : 'null' }}</div>
        <div>graph: order={{ diag.graphOrder }} size={{ diag.graphSize }}</div>
        <div>sigma: {{ diag.sigmaPresent }}</div>
        <div>container: {{ Math.round(diag.containerWidth) }}×{{ Math.round(diag.containerHeight) }}</div>
        <div>rebuilds: {{ diag.rebuildCount }}</div>
        <div>pending: {{ pending }}</div>
        <div>highlight: {{ [...highlightSet].length }}</div>
        <div v-if="diag.lastError" class="mt-1 text-destructive">
          ⚠ {{ diag.lastError }}
        </div>
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
  </div>
</template>
