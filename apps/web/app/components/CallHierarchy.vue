<script setup lang="ts">
/**
 * Text-only call hierarchy tree. Lazy-expands one level at a time
 * via the same /neighbours endpoint as EntityNeighbourGraph, but
 * renders as an indented list instead of a force-graph — better for
 * scanning "who calls whom" and works on mobile where Sigma doesn't.
 *
 * Mode selector toggles which relation type to walk: callers (inbound
 * `calls`), callees (outbound `calls`), tests (`tested_by`),
 * contained_in (parent class/file).
 */
import { ChevronRight, ChevronDown, GitFork, Bug, FileCode, Layers } from 'lucide-vue-next'

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

interface Props {
  workspaceId: string
  entityId: string | null
}
const props = defineProps<Props>()
const emit = defineEmits<{
  (e: 'focus', id: string): void
  (e: 'close'): void
}>()

const { t } = useI18n()

type Mode = 'callers' | 'callees' | 'tests' | 'parents'
const mode = ref<Mode>('callees')
const MODES: { id: Mode; icon: typeof GitFork; labelKey: string }[] = [
  { id: 'callees', icon: GitFork, labelKey: 'callHierarchy.callees' },
  { id: 'callers', icon: GitFork, labelKey: 'callHierarchy.callers' },
  { id: 'tests', icon: Bug, labelKey: 'callHierarchy.tests' },
  { id: 'parents', icon: Layers, labelKey: 'callHierarchy.parents' },
]

// Tree state: per-node loaded children + expanded flag, keyed by
// "<parentId>:<mode>:<entityId>" so re-expanding a different mode
// re-fetches.
interface TreeChild {
  node: NodeRow
  loaded: boolean
  expanded: boolean
  children: TreeChild[]
  loading: boolean
}

const rootChildren = ref<TreeChild[]>([])
const rootMeta = ref<NodeRow | null>(null)
const rootLoading = ref(false)

/**
 * Filter the neighbours response down to the children that match the
 * current `mode` direction.
 *
 *   callees: edges where from = currentId and type = 'calls' → to
 *   callers: edges where to   = currentId and type = 'calls' → from
 *   tests:   edges where from = currentId and type = 'tested_by' → to
 *   parents: edges where from = currentId and type = 'contained_in' → to
 */
function filterChildren(
  currentId: string,
  resp: NeighboursResponse,
): NodeRow[] {
  const map = new Map<string, NodeRow>()
  for (const n of resp.nodes) map.set(n.id, n)
  const ids = new Set<string>()
  for (const e of resp.edges) {
    if (mode.value === 'callees' && e.from === currentId && e.type === 'calls') ids.add(e.to)
    else if (mode.value === 'callers' && e.to === currentId && e.type === 'calls') ids.add(e.from)
    else if (mode.value === 'tests' && e.from === currentId && e.type === 'tested_by') ids.add(e.to)
    else if (mode.value === 'parents' && e.from === currentId && e.type === 'contained_in') ids.add(e.to)
  }
  return [...ids].map((id) => map.get(id)).filter((n): n is NodeRow => n !== undefined)
}

async function fetchNeighbours(id: string): Promise<NeighboursResponse> {
  return useApi()<NeighboursResponse>(
    `/api/workspaces/${props.workspaceId}/entity/${id}/neighbours`,
    { query: { depth: 1, limit: 80 } },
  )
}

async function loadRoot(): Promise<void> {
  if (!props.entityId) return
  rootLoading.value = true
  rootChildren.value = []
  try {
    const resp = await fetchNeighbours(props.entityId)
    rootMeta.value = resp.center
    const children = filterChildren(props.entityId, resp)
    rootChildren.value = children.map((node) => ({
      node, loaded: false, expanded: false, children: [], loading: false,
    }))
  } finally {
    rootLoading.value = false
  }
}

async function expand(child: TreeChild): Promise<void> {
  if (child.expanded) {
    child.expanded = false
    return
  }
  child.expanded = true
  if (child.loaded) return
  child.loading = true
  try {
    const resp = await fetchNeighbours(child.node.id)
    const kids = filterChildren(child.node.id, resp)
    child.children = kids.map((node) => ({
      node, loaded: false, expanded: false, children: [], loading: false,
    }))
    child.loaded = true
  } finally {
    child.loading = false
  }
}

watch(() => [props.entityId, mode.value] as const, () => void loadRoot(), { immediate: true })

// Icon per entity type — gives the tree a tiny visual key.
function iconFor(type: string): typeof FileCode {
  if (type === 'function' || type === 'class' || type === 'type') return GitFork
  if (type === 'test') return Bug
  if (type === 'file') return FileCode
  return Layers
}
</script>

<template>
  <aside class="flex h-full w-full flex-col overflow-hidden rounded-lg border border-border bg-card">
    <header class="flex items-center gap-1.5 border-b border-border px-2.5 py-2 text-xs">
      <button
        v-for="m in MODES"
        :key="m.id"
        type="button"
        class="inline-flex items-center gap-1 rounded-md px-2 py-1 font-medium transition"
        :class="mode === m.id ? 'bg-primary text-primary-foreground' : 'hover:bg-accent'"
        @click="mode = m.id"
      >
        <component :is="m.icon" class="h-3 w-3" />
        {{ t(m.labelKey) }}
      </button>
      <span class="ml-auto" />
      <button
        type="button"
        class="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
        @click="$emit('close')"
      >
        ×
      </button>
    </header>
    <div class="flex-1 overflow-y-auto p-2 text-sm">
      <div v-if="rootLoading" class="px-2 py-3 text-xs text-muted-foreground">
        {{ t('callHierarchy.loading') }}
      </div>
      <div v-else-if="!rootMeta" class="px-2 py-3 text-xs text-muted-foreground">
        {{ t('callHierarchy.empty') }}
      </div>
      <div v-else>
        <div class="mb-2 flex items-center gap-2 rounded-md bg-muted/40 px-2 py-1.5">
          <component :is="iconFor(rootMeta.type)" class="h-3.5 w-3.5 text-primary" />
          <span class="truncate font-mono text-xs">{{ rootMeta.name }}</span>
          <span class="text-[10px] text-muted-foreground">{{ rootMeta.type }}</span>
        </div>
        <div v-if="rootChildren.length === 0" class="px-2 py-2 text-xs italic text-muted-foreground">
          {{ t(`callHierarchy.none.${mode}`) }}
        </div>
        <ul v-else class="space-y-0.5">
          <li v-for="c in rootChildren" :key="c.node.id">
            <CallHierarchyNode
              :child="c"
              :level="0"
              @expand="expand"
              @focus="(id) => emit('focus', id)"
            />
          </li>
        </ul>
      </div>
    </div>
  </aside>
</template>
