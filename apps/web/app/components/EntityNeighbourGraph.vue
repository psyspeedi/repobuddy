<script setup lang="ts">
/**
 * Mini graph of a single entity + its 1-2 hop neighbours. Replaces
 * the old "open the whole repo as Sigma soup" with a focused, local
 * map. Concentric layout (center + rings) makes it readable at 20-30
 * nodes — the layout is deterministic so revisiting the same node
 * shows the same scene.
 *
 * Opens from:
 *   - chat citations that point at an entity
 *   - the workspace explore page (treemap → click a file)
 *   - the call-hierarchy panel (focus → graph)
 */
import { X, Sparkles, Network, List as ListIcon } from 'lucide-vue-next'

interface Props {
  workspaceId: string
  entityId: string | null
}
const props = defineProps<Props>()
defineEmits<{
  (e: 'close'): void
  (e: 'focus', id: string): void
}>()

const { t } = useI18n()
const colorMode = useColorMode()
const containerRef = ref<HTMLDivElement | null>(null)
const view = ref<'graph' | 'tree'>('graph')

interface NodeRow {
  id: string
  type: string
  name: string
  qualifiedName: string | null
  filePath: string | null
  startLine: number | null
  endLine: number | null
  language: string | null
  depth: number
}
interface EdgeRow {
  id: string
  from: string
  to: string
  type: string
}
interface NeighboursResponse {
  center: NodeRow
  nodes: NodeRow[]
  edges: EdgeRow[]
}

const data = ref<NeighboursResponse | null>(null)
const loading = ref(false)
const errorMessage = ref<string | null>(null)
const depth = ref<1 | 2>(1)

// Same palette as the legacy global graph so users get a consistent
// visual language for entity types across the app.
const typeColors: Record<string, string> = {
  file: '#64748b',
  module: '#7c8da3',
  class: '#3b82f6',
  function: '#10b981',
  type: '#a855f7',
  variable: '#9ca3af',
  component: '#0ea5e9',
  route: '#f59e0b',
  test: '#ef4444',
  concept: '#ec4899',
  pattern: '#f97316',
  decision: '#eab308',
  commit: '#64748b',
  pull_request: '#64748b',
  person: '#22c55e',
  document: '#71717a',
}
const edgeColors: Record<string, string> = {
  calls: '#10b981',
  imports: '#3b82f6',
  extends: '#a855f7',
  implements: '#a855f7',
  defined_in: '#94a3b8',
  contained_in: '#94a3b8',
  tested_by: '#ef4444',
  modified_by: '#ec4899',
  authored: '#22c55e',
}

let sigma: import('sigma').default | null = null
let graph: import('graphology').default | null = null

async function load(): Promise<void> {
  if (!props.entityId) {
    data.value = null
    return
  }
  loading.value = true
  errorMessage.value = null
  try {
    data.value = await $fetch<NeighboursResponse>(
      `/api/workspaces/${props.workspaceId}/entity/${props.entityId}/neighbours`,
      { query: { depth: depth.value } },
    )
  } catch (err) {
    errorMessage.value = err instanceof Error ? err.message : String(err)
    data.value = null
  } finally {
    loading.value = false
  }
}

async function rebuild(): Promise<void> {
  if (!containerRef.value || !data.value) return
  const [graphologyMod, sigmaMod] = await Promise.all([
    import('graphology'),
    import('sigma'),
  ])
  const Graph = graphologyMod.default as unknown as new (opts?: { multi?: boolean }) => import('graphology').default
  const Sigma = sigmaMod.default as unknown as new (
    g: import('graphology').default,
    c: HTMLElement,
    s?: Record<string, unknown>,
  ) => import('sigma').default

  if (sigma) {
    sigma.kill()
    sigma = null
  }
  graph = new Graph({ multi: true })

  // Concentric layout: center at origin, ring radius grows with hop
  // distance. Nodes at the same depth get spread evenly on a circle.
  const byDepth = new Map<number, NodeRow[]>()
  for (const n of data.value.nodes) {
    const arr = byDepth.get(n.depth) ?? []
    arr.push(n)
    byDepth.set(n.depth, arr)
  }
  const ringRadius = (d: number): number => (d === 0 ? 0 : 80 * d)
  for (const [d, nodes] of byDepth) {
    const count = nodes.length
    nodes.forEach((n, i) => {
      const angle = count > 0 ? (i / count) * Math.PI * 2 : 0
      const r = ringRadius(d)
      graph!.addNode(n.id, {
        label: n.name,
        size: n.depth === 0 ? 18 : n.depth === 1 ? 10 : 6,
        color: typeColors[n.type] ?? '#888',
        x: r * Math.cos(angle),
        y: r * Math.sin(angle),
        nodeType: n.type,
        depth: n.depth,
      })
    })
  }
  for (const e of data.value.edges) {
    if (!graph.hasNode(e.from) || !graph.hasNode(e.to)) continue
    try {
      graph.addEdgeWithKey(e.id, e.from, e.to, {
        type: 'arrow',
        size: 1,
        color: edgeColors[e.type] ?? '#cbd5e1',
        label: e.type,
        edgeType: e.type,
      })
    } catch { /* duplicate */ }
  }

  const isDark = colorMode.value === 'dark'
  sigma = new Sigma(graph, containerRef.value, {
    renderEdgeLabels: false,
    labelDensity: 0.7,
    labelColor: { color: isDark ? '#e2e8f0' : '#1e293b' },
    edgeLabelColor: { color: isDark ? '#94a3b8' : '#475569' },
    labelSize: 12,
    labelWeight: '600',
    defaultEdgeColor: isDark ? '#475569' : '#cbd5e1',
    minCameraRatio: 0.3,
    maxCameraRatio: 5,
  })
  sigma.on('clickNode', ({ node }) => {
    // Re-center the graph on the clicked node. The drawer parent
    // listens for `focus` so it can sync any external state.
    if (node === props.entityId) return
    void (async () => {
      const p = await $fetch<NeighboursResponse>(
        `/api/workspaces/${props.workspaceId}/entity/${node}/neighbours`,
        { query: { depth: depth.value } },
      )
      data.value = p
      await nextTick()
      await rebuild()
    })()
  })
  sigma.refresh()
}

watch(
  () => [props.entityId, depth.value] as const,
  () => void load(),
  { immediate: true },
)
watch(
  () => data.value,
  () => void nextTick(() => rebuild()),
)
watch(
  () => colorMode.value,
  () => {
    if (!sigma) return
    const isDark = colorMode.value === 'dark'
    sigma.setSetting('labelColor', { color: isDark ? '#e2e8f0' : '#1e293b' })
    sigma.setSetting('edgeLabelColor', { color: isDark ? '#94a3b8' : '#475569' })
    sigma.setSetting('defaultEdgeColor', isDark ? '#475569' : '#cbd5e1')
    sigma.refresh()
  },
)

onBeforeUnmount(() => {
  sigma?.kill()
  sigma = null
})
</script>

<template>
  <aside class="flex h-full w-full flex-col overflow-hidden rounded-lg border border-border bg-card">
    <header class="flex items-center justify-between gap-2 border-b border-border px-3 py-2">
      <div class="min-w-0 flex-1 text-sm">
        <p class="flex items-center gap-1.5 font-medium">
          <Sparkles class="h-3.5 w-3.5 text-primary" />
          {{ t('neighbours.title') }}
        </p>
        <p v-if="data?.center" class="truncate text-xs text-muted-foreground">
          {{ data.center.name }} <span class="opacity-70">({{ data.center.type }})</span>
        </p>
      </div>
      <div class="flex items-center gap-1">
        <button
          type="button"
          class="rounded-md p-1.5 transition"
          :class="view === 'graph' ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-accent'"
          :title="t('neighbours.graphView')"
          @click="view = 'graph'"
        >
          <Network class="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          class="rounded-md p-1.5 transition"
          :class="view === 'tree' ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-accent'"
          :title="t('neighbours.treeView')"
          @click="view = 'tree'"
        >
          <ListIcon class="h-3.5 w-3.5" />
        </button>
        <button
          v-if="view === 'graph'"
          type="button"
          class="rounded-md px-2 py-1 text-[11px] font-medium transition"
          :class="depth === 1 ? 'bg-primary text-primary-foreground' : 'hover:bg-accent'"
          @click="depth = 1"
        >
          1{{ t('neighbours.hop') }}
        </button>
        <button
          v-if="view === 'graph'"
          type="button"
          class="rounded-md px-2 py-1 text-[11px] font-medium transition"
          :class="depth === 2 ? 'bg-primary text-primary-foreground' : 'hover:bg-accent'"
          @click="depth = 2"
        >
          2{{ t('neighbours.hop') }}
        </button>
        <button
          type="button"
          class="rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
          @click="$emit('close')"
        >
          <X class="h-4 w-4" />
        </button>
      </div>
    </header>
    <CallHierarchy
      v-if="view === 'tree'"
      :workspace-id="workspaceId"
      :entity-id="entityId"
      class="flex-1"
      @focus="(id) => $emit('focus', id)"
      @close="$emit('close')"
    />
    <div v-else class="relative flex-1">
      <div v-if="loading" class="absolute inset-0 grid place-items-center text-sm text-muted-foreground">
        {{ t('neighbours.loading') }}
      </div>
      <div v-else-if="errorMessage" class="absolute inset-0 grid place-items-center text-sm text-destructive">
        {{ errorMessage }}
      </div>
      <div v-else-if="!data?.nodes.length" class="absolute inset-0 grid place-items-center text-sm text-muted-foreground">
        {{ t('neighbours.empty') }}
      </div>
      <ClientOnly>
        <div ref="containerRef" class="absolute inset-0" />
      </ClientOnly>
    </div>
    <footer class="border-t border-border px-3 py-1.5 text-[10px] text-muted-foreground">
      {{ t('neighbours.hint') }}
    </footer>
  </aside>
</template>
