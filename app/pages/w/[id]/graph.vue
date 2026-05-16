<script setup lang="ts">
import { Button } from '@/components/ui/button'
import Graph from 'graphology'
import Sigma from 'sigma'
import forceAtlas2 from 'graphology-layout-forceatlas2'

interface GraphNode {
  id: string
  type: string
  name: string
  qualifiedName: string | null
  language: string | null
  filePath: string | null
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

const selectedTypes = ref<string[]>(['file', 'class', 'function'])
const selectedNode = ref<GraphNode | null>(null)
const containerRef = ref<HTMLDivElement | null>(null)
let sigma: Sigma | null = null
let graph: Graph | null = null

const query = computed(() => ({
  types: selectedTypes.value.join(','),
  limit: 1500,
}))

const { data, refresh, pending } = await useFetch<GraphResponse>(
  `/api/workspaces/${workspaceId}/graph`,
  { query, key: `graph-${workspaceId}` },
)

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
      size: node.type === 'file' ? 6 : node.type === 'class' ? 8 : 4,
      color: typeColors[node.type] ?? '#888',
      x: Math.random(),
      y: Math.random(),
      nodeType: node.type,
      qualifiedName: node.qualifiedName,
    })
  }
  for (const edge of data.value.edges) {
    if (!graph.hasNode(edge.fromEntityId) || !graph.hasNode(edge.toEntityId)) continue
    try {
      graph.addEdgeWithKey(edge.id, edge.fromEntityId, edge.toEntityId, {
        type: 'arrow',
        size: 1,
        color: '#cbd5e1',
        label: edge.type,
      })
    } catch {
      // duplicate key from multi-graph constraints
    }
  }

  // Single-shot ForceAtlas2 layout.
  forceAtlas2.assign(graph, {
    iterations: 200,
    settings: {
      gravity: 1,
      scalingRatio: 10,
      slowDown: 5,
      barnesHutOptimize: true,
    },
  })

  sigma = new Sigma(graph, containerRef.value, {
    renderEdgeLabels: false,
    labelDensity: 0.5,
    labelGridCellSize: 60,
    minCameraRatio: 0.05,
    maxCameraRatio: 10,
  })

  sigma.on('clickNode', ({ node }) => {
    const attrs = graph!.getNodeAttributes(node)
    const original = data.value!.nodes.find((n) => n.id === node)
    if (original) selectedNode.value = original
    void attrs
  })
}

watch(data, () => rebuild(), { immediate: false })

onMounted(() => {
  if (data.value) rebuild()
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
  void refresh()
}

useHead({ title: 'Graph — CodeGraph' })
</script>

<template>
  <div class="flex h-[calc(100vh-12rem)] gap-4">
    <aside class="w-56 shrink-0 space-y-3 overflow-y-auto rounded-lg border border-border bg-card p-3">
      <h2 class="text-sm font-medium uppercase tracking-wide text-muted-foreground">
        Filters
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
      <div v-if="data?.truncated" class="rounded bg-yellow-500/10 p-2 text-xs text-yellow-700 dark:text-yellow-400">
        Graph truncated. Adjust filters to narrow.
      </div>
    </aside>

    <section class="relative flex-1 overflow-hidden rounded-lg border border-border bg-card">
      <div ref="containerRef" class="absolute inset-0" />
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

    <aside
      v-if="selectedNode"
      class="w-72 shrink-0 space-y-2 overflow-y-auto rounded-lg border border-border bg-card p-3"
    >
      <div class="flex items-start justify-between gap-2">
        <h3 class="text-sm font-semibold break-all">
          {{ selectedNode.name }}
        </h3>
        <Button variant="ghost" size="sm" @click="selectedNode = null">
          ×
        </Button>
      </div>
      <p class="text-xs text-muted-foreground">
        type: {{ selectedNode.type }}
      </p>
      <p v-if="selectedNode.language" class="text-xs text-muted-foreground">
        lang: {{ selectedNode.language }}
      </p>
      <p v-if="selectedNode.filePath" class="break-all text-xs text-muted-foreground">
        path: {{ selectedNode.filePath }}
      </p>
      <p v-if="selectedNode.qualifiedName" class="break-all text-xs">
        {{ selectedNode.qualifiedName }}
      </p>
    </aside>
  </div>
</template>
