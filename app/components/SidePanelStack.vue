<script setup lang="ts">
/**
 * Tabbed container for the three chat side-panels:
 *   Reasoning Inspector / Source Viewer / Neighbour Graph
 *
 * Extracted from /w/[id] so the same stack can render either as a
 * desktop side column (>= lg) or inside a BottomSheet (< lg) without
 * duplicating tab + content markup. Stateless — the parent owns the
 * active panel and the entity/chunk ids; this component just renders.
 */
import type { AnyTrace, PlanData } from '@/composables/useChat'

type Panel = 'inspector' | 'viewer' | 'neighbours'

interface Props {
  sidePanel: Panel
  workspaceId: string
  neighbourEntityId: string | null
  openChunkId: string | null
  plan?: PlanData | null
  trace?: AnyTrace | null
}
const props = defineProps<Props>()
const emit = defineEmits<{
  (e: 'update:sidePanel', v: Panel): void
  (e: 'focus-neighbour', id: string): void
}>()

const { t } = useI18n()

function select(panel: Panel): void {
  emit('update:sidePanel', panel)
}
</script>

<template>
  <div class="flex h-full min-h-0 flex-col gap-2">
    <div class="flex shrink-0 gap-1">
      <Button
        variant="outline"
        size="sm"
        :class="props.sidePanel === 'inspector' ? 'bg-accent' : ''"
        @click="select('inspector')"
      >
        {{ t('chat.panels.reasoning') }}
      </Button>
      <Button
        variant="outline"
        size="sm"
        :class="props.sidePanel === 'viewer' ? 'bg-accent' : ''"
        @click="select('viewer')"
      >
        {{ t('chat.panels.source') }}
      </Button>
      <Button
        v-if="neighbourEntityId"
        variant="outline"
        size="sm"
        :class="props.sidePanel === 'neighbours' ? 'bg-accent' : ''"
        @click="select('neighbours')"
      >
        {{ t('chat.panels.neighbours') }}
      </Button>
    </div>

    <div class="flex-1 min-h-0">
      <ReasoningInspector
        v-if="props.sidePanel === 'inspector'"
        :plan="props.plan ?? null"
        :trace="props.trace ?? null"
      />
      <SourceViewerDrawer
        v-else-if="props.sidePanel === 'viewer' && props.openChunkId"
        :workspace-id="props.workspaceId"
        :chunk-id="props.openChunkId"
        @close="select('inspector')"
      />
      <aside
        v-else-if="props.sidePanel === 'viewer' && !props.openChunkId"
        class="flex h-full w-full items-center justify-center rounded-lg border border-border bg-card p-6 text-center text-sm text-muted-foreground"
      >
        {{ t('chat.panels.sourcePlaceholder') }}
      </aside>
      <EntityNeighbourGraph
        v-else-if="props.sidePanel === 'neighbours' && props.neighbourEntityId"
        :workspace-id="props.workspaceId"
        :entity-id="props.neighbourEntityId"
        @close="select('inspector')"
        @focus="(id: string) => emit('focus-neighbour', id)"
      />
    </div>
  </div>
</template>
