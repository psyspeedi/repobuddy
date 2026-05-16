<script setup lang="ts">
import { Button } from '@/components/ui/button'

const route = useRoute()
const workspaceId = String(route.params.id)

const { data: wsData, refresh: refreshWs } = await useFetch(`/api/workspaces/${workspaceId}`, {
  key: `workspace-${workspaceId}`,
})

const { state, done } = useWorkspaceProgress(workspaceId)

watch(done, async (isDone) => {
  if (isDone) await refreshWs()
})

const phase = computed(() => state.value.progress?.phase ?? wsData.value?.workspace.status ?? 'pending')
const percent = computed(() => state.value.progress?.percent ?? 0)
const message = computed(() => state.value.progress?.message ?? '')
const isReady = computed(() => phase.value === 'ready')
const isFailed = computed(() => phase.value === 'failed')

useHead(() => ({ title: `${wsData.value?.workspace.name ?? 'Workspace'} — CodeGraph` }))
</script>

<template>
  <div v-if="wsData" class="space-y-6">
    <header class="space-y-1">
      <h1 class="text-2xl font-bold">
        {{ wsData.workspace.name }}
      </h1>
      <p class="text-sm text-muted-foreground">
        <a
          v-if="wsData.workspace.sourceUrl"
          :href="wsData.workspace.sourceUrl"
          target="_blank"
          class="underline-offset-2 hover:underline"
        >{{ wsData.workspace.sourceUrl }}</a>
        <span v-else>Uploaded archive</span>
      </p>
    </header>

    <section
      v-if="!isReady && !isFailed"
      class="space-y-3 rounded-lg border border-border bg-card p-6"
    >
      <div class="flex items-center justify-between">
        <h2 class="text-sm font-medium uppercase tracking-wide text-muted-foreground">
          Indexing
        </h2>
        <span class="text-sm font-mono">{{ phase }} · {{ percent }}%</span>
      </div>
      <div class="h-2 w-full overflow-hidden rounded-full bg-muted">
        <div
          class="h-full bg-primary transition-all duration-300"
          :style="{ width: `${percent}%` }"
        />
      </div>
      <p class="text-sm text-muted-foreground">
        {{ message || 'Waiting…' }}
      </p>
    </section>

    <section
      v-else-if="isReady"
      class="space-y-3 rounded-lg border border-border bg-card p-6"
    >
      <h2 class="text-lg font-semibold">
        Ready
      </h2>
      <pre class="overflow-x-auto rounded bg-muted p-3 text-xs">{{ JSON.stringify(wsData.workspace.stats, null, 2) }}</pre>
      <NuxtLink :to="`/w/${workspaceId}/graph`">
        <Button>Open graph</Button>
      </NuxtLink>
    </section>

    <section
      v-else-if="isFailed"
      class="space-y-2 rounded-lg border border-destructive bg-destructive/10 p-6"
    >
      <h2 class="text-lg font-semibold text-destructive">
        Indexing failed
      </h2>
      <p class="text-sm">
        {{ wsData.workspace.error ?? 'Unknown error' }}
      </p>
    </section>
  </div>
</template>
