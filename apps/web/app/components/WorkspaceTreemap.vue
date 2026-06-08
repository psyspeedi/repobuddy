<script setup lang="ts">
/**
 * Treemap of files in a workspace. Replaces the global Sigma graph as
 * the canonical "show me what's in this repo" view.
 *
 * Three presets:
 *  - loc:      rectangle size = entity count, monochrome fill
 *  - hotness:  rectangle size = entity count, fill = orange→red by
 *              commits-in-last-90d
 *  - coverage: rectangle size = entity count, green if file has any
 *              inbound tested_by edge, red otherwise
 *
 * Clicking a leaf rectangle emits `focus` with the file's entity id —
 * the workspace page opens the Neighbour Graph drawer on that file.
 */
import { hierarchy, treemap, type HierarchyRectangularNode } from 'd3-hierarchy'
import { interpolateOrRd } from 'd3-scale-chromatic'

interface LeafMeta {
  entityCount: number
  hotness: number
  hasTests: boolean
  entityId: string
}
interface RawNode {
  name: string
  path: string
  value?: number
  children?: RawNode[]
  meta?: LeafMeta
}

interface Props {
  workspaceId: string
}
const props = defineProps<Props>()
const emit = defineEmits<{ (e: 'focus', entityId: string): void }>()

const { t } = useI18n()
const wrapper = ref<HTMLDivElement | null>(null)
const preset = ref<'loc' | 'hotness' | 'coverage'>('loc')

const { data, pending } = await useFetch<{ root: RawNode; totalFiles: number }>(
  `/api/workspaces/${props.workspaceId}/treemap`,
)

interface Rect {
  x0: number
  y0: number
  x1: number
  y1: number
  name: string
  path: string
  meta: LeafMeta | null
  fill: string
  isLeaf: boolean
}

// Render-loop state.
const rects = ref<Rect[]>([])
const hovered = ref<Rect | null>(null)
const containerWidth = ref(0)
const containerHeight = ref(0)

function fillFor(meta: LeafMeta | null): string {
  if (!meta) return 'hsl(var(--muted) / 0.5)'
  if (preset.value === 'hotness') {
    // Clamp hotness 0..20 → 0..1 for the OrRd scale; min floor so even
    // 1 commit shows pale color.
    const t = Math.min(1, Math.max(0.08, meta.hotness / 20))
    return interpolateOrRd(t)
  }
  if (preset.value === 'coverage') {
    return meta.hasTests
      ? 'hsl(156 70% 50% / 0.85)'
      : 'hsl(0 75% 60% / 0.7)'
  }
  // 'loc' — neutral; we'll layer a brightness from entityCount.
  const t = Math.min(1, Math.max(0.15, meta.entityCount / 40))
  return `hsl(var(--primary) / ${0.2 + 0.6 * t})`
}

function layout(): void {
  if (!wrapper.value || !data.value) return
  const w = wrapper.value.clientWidth
  const h = wrapper.value.clientHeight
  if (w === 0 || h === 0) return
  containerWidth.value = w
  containerHeight.value = h

  const root = hierarchy<RawNode>(data.value.root, (d) => d.children)
    .sum((d) => (d.children ? 0 : d.value ?? 1))
    .sort((a, b) => (b.value ?? 0) - (a.value ?? 0))

  const tm = treemap<RawNode>().size([w, h]).padding(1).round(true)
  tm(root)

  const collected: Rect[] = []
  // After tm(root) the hierarchy nodes are HierarchyRectangularNode
  // with x0/y0/x1/y1. The base type doesn't reflect that mutation, so
  // cast leaves() through it.
  const leaves = root.leaves() as HierarchyRectangularNode<RawNode>[]
  for (const leaf of leaves) {
    const { x0, x1, y0, y1 } = leaf
    if (x1 - x0 < 1 || y1 - y0 < 1) continue
    collected.push({
      x0, y0, x1, y1,
      name: leaf.data.name,
      path: leaf.data.path,
      meta: leaf.data.meta ?? null,
      fill: fillFor(leaf.data.meta ?? null),
      isLeaf: true,
    })
  }
  rects.value = collected
}

onMounted(() => {
  layout()
  const ro = new ResizeObserver(() => layout())
  if (wrapper.value) ro.observe(wrapper.value)
  onBeforeUnmount(() => ro.disconnect())
})
watch(() => preset.value, () => layout())
watch(() => data.value, () => nextTick(() => layout()))
</script>

<template>
  <section class="flex h-full flex-col gap-3">
    <header class="flex flex-wrap items-center justify-between gap-2">
      <div class="space-y-0.5">
        <h2 class="text-base font-semibold">
          {{ t('explore.title') }}
        </h2>
        <p class="text-xs text-muted-foreground">
          {{ t('explore.subtitle', { n: data?.totalFiles ?? 0 }) }}
        </p>
      </div>
      <div class="flex items-center gap-1">
        <button
          v-for="p in ['loc', 'hotness', 'coverage'] as const"
          :key="p"
          type="button"
          class="rounded-md px-3 py-1.5 text-xs font-medium transition"
          :class="preset === p ? 'bg-primary text-primary-foreground' : 'border border-border hover:bg-accent'"
          @click="preset = p"
        >
          {{ t(`explore.preset.${p}`) }}
        </button>
      </div>
    </header>

    <div ref="wrapper" class="relative flex-1 overflow-hidden rounded-lg border border-border bg-card">
      <div v-if="pending" class="absolute inset-0 grid place-items-center text-sm text-muted-foreground">
        {{ t('explore.loading') }}
      </div>
      <svg v-else :width="containerWidth" :height="containerHeight" class="block">
        <g v-for="r in rects" :key="r.path">
          <rect
            :x="r.x0"
            :y="r.y0"
            :width="r.x1 - r.x0"
            :height="r.y1 - r.y0"
            :fill="r.fill"
            stroke="hsl(var(--border))"
            stroke-width="0.5"
            class="cursor-pointer transition"
            :class="hovered?.path === r.path ? 'opacity-80' : ''"
            @mouseenter="hovered = r"
            @mouseleave="hovered = null"
            @click="r.meta && emit('focus', r.meta.entityId)"
          />
          <text
            v-if="r.x1 - r.x0 > 40 && r.y1 - r.y0 > 14"
            :x="r.x0 + 4"
            :y="r.y0 + 12"
            font-size="10"
            font-family="ui-monospace, monospace"
            fill="hsl(var(--foreground))"
            class="pointer-events-none select-none"
          >{{ r.name }}</text>
        </g>
      </svg>
      <!-- Hover tooltip -->
      <div
        v-if="hovered"
        class="pointer-events-none absolute rounded-md border border-border bg-card px-2.5 py-1.5 text-[11px] shadow-lg"
        :style="{
          left: `${Math.min(hovered.x1 + 6, containerWidth - 220)}px`,
          top: `${Math.min(hovered.y0, containerHeight - 80)}px`,
        }"
      >
        <p class="max-w-[200px] truncate font-mono font-medium">
          {{ hovered.path }}
        </p>
        <p v-if="hovered.meta" class="text-muted-foreground">
          {{ t('explore.tooltip.entities', { n: hovered.meta.entityCount }) }}
          <span class="mx-1">·</span>
          <span :class="hovered.meta.hotness > 0 ? 'text-amber-600 dark:text-amber-400' : ''">
            {{ t('explore.tooltip.hotness', { n: hovered.meta.hotness }) }}
          </span>
          <span class="mx-1">·</span>
          <span :class="hovered.meta.hasTests ? 'text-emerald-600 dark:text-emerald-400' : 'text-destructive'">
            {{ hovered.meta.hasTests ? t('explore.tooltip.tested') : t('explore.tooltip.untested') }}
          </span>
        </p>
      </div>
    </div>
  </section>
</template>
