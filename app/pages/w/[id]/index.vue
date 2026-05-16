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

// Chat
const chat = useChat(workspaceId)
const inputText = ref('')
const openChunkId = ref<string | null>(null)
const scroller = ref<HTMLDivElement | null>(null)

async function submit(): Promise<void> {
  if (chat.streaming.value || !inputText.value.trim()) return
  const q = inputText.value
  inputText.value = ''
  await chat.send(q)
  scrollToBottom()
}

function scrollToBottom(): void {
  nextTick(() => {
    scroller.value?.scrollTo({ top: scroller.value.scrollHeight, behavior: 'smooth' })
  })
}

watch(
  () => chat.messages.value.length,
  () => scrollToBottom(),
)
watch(
  () => chat.messages.value.at(-1)?.content,
  () => scrollToBottom(),
)

useHead(() => ({ title: `${wsData.value?.workspace.name ?? 'Workspace'} — CodeGraph` }))
</script>

<template>
  <div v-if="wsData" class="space-y-4">
    <header class="space-y-1">
      <div class="flex items-center justify-between">
        <div>
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
        </div>
        <NuxtLink v-if="isReady" :to="`/w/${workspaceId}/graph`">
          <Button variant="outline" size="sm">
            View graph
          </Button>
        </NuxtLink>
      </div>
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

    <section
      v-else
      class="flex h-[calc(100vh-14rem)] gap-3"
    >
      <div class="flex flex-1 flex-col overflow-hidden rounded-lg border border-border bg-card">
        <div ref="scroller" class="flex-1 space-y-3 overflow-y-auto p-4">
          <p v-if="chat.messages.value.length === 0" class="text-center text-sm text-muted-foreground">
            Ask anything about this repository.
          </p>
          <ChatMessage
            v-for="(msg, i) in chat.messages.value"
            :key="i"
            :role="msg.role"
            :content="msg.content"
            :pending="msg.pending"
            :invalid="msg.invalid"
            @open-chunk="openChunkId = $event"
          />
        </div>
        <form
          class="flex items-center gap-2 border-t border-border p-3"
          @submit.prevent="submit"
        >
          <input
            v-model="inputText"
            type="text"
            placeholder="Ask about the repo…"
            class="flex-1 rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
            :disabled="chat.streaming.value"
          >
          <Button type="submit" :disabled="chat.streaming.value || !inputText.trim()">
            Send
          </Button>
        </form>
      </div>

      <div v-if="openChunkId" class="w-[420px] shrink-0">
        <SourceViewerDrawer
          :workspace-id="workspaceId"
          :chunk-id="openChunkId"
          @close="openChunkId = null"
        />
      </div>
    </section>
  </div>
</template>
