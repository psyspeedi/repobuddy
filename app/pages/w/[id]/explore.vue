<script setup lang="ts">
/**
 * Explore page — the canonical "what's in this repo" view. Replaces
 * the old /w/[id]/graph "Sigma soup" with a treemap that answers
 * three concrete questions:
 *   - what's big?         (loc preset)
 *   - what's hot?         (hotness preset, last 90d commits)
 *   - what isn't tested?  (coverage preset)
 *
 * Clicking a file rectangle opens its Neighbour Graph in a drawer
 * — the same drawer used from chat citations.
 */
definePageMeta({ auth: false })

const route = useRoute()
const { t } = useI18n()
const workspaceId = String(route.params.id)

const focusedEntityId = ref<string | null>(null)
const drawerOpen = computed(() => focusedEntityId.value !== null)

function onFocus(entityId: string): void {
  focusedEntityId.value = entityId
}

useHead(() => ({ title: () => `${t('explore.title')} — RepoBuddy` }))
</script>

<template>
  <div class="cg-no-scroll flex flex-1 flex-col gap-3 min-h-0">
    <div class="flex items-center gap-2">
      <NuxtLink :to="`/w/${workspaceId}`">
        <Button variant="ghost" size="sm">
          {{ t('graph.backToChat') }}
        </Button>
      </NuxtLink>
    </div>
    <div class="flex flex-1 gap-3 min-h-0">
      <div class="flex-1 min-w-0">
        <WorkspaceTreemap :workspace-id="workspaceId" @focus="onFocus" />
      </div>
      <div v-if="drawerOpen" class="hidden w-[480px] shrink-0 lg:block">
        <EntityNeighbourGraph
          :workspace-id="workspaceId"
          :entity-id="focusedEntityId"
          @close="focusedEntityId = null"
          @focus="onFocus"
        />
      </div>
    </div>
  </div>
</template>
