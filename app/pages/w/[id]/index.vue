<script setup lang="ts">
import { Button } from '@/components/ui/button'

const { t } = useI18n()
const route = useRoute()
const workspaceId = String(route.params.id)

interface WorkspaceStats {
  gitInsights?: {
    lastCommitAt: string | null
    totalCommitsScanned: number
    commitsLast30d: number
    commitsLast90d: number
    activeMaintainers90d: number
    topAuthors: { name: string; email: string; commitCount: number }[]
    busFactor: number
    fixCount: number
    featCount: number
    fixVsFeatRatio: number | null
    breakingChangesLast90d: number
    commitFrequencyByMonth: { month: string; commits: number }[]
    windowDays: number
  }
}

const { data: wsData, refresh: refreshWs } = await useFetch<{
  workspace: {
    id: string
    name: string
    sourceUrl: string | null
    status: string
    error: string | null
    stats: WorkspaceStats | null
  }
}>(`/api/workspaces/${workspaceId}`, { key: `workspace-${workspaceId}` })

const gitInsights = computed(() => wsData.value?.workspace.stats?.gitInsights ?? null)

const progressApi = useWorkspaceProgress(workspaceId)
const { state, done } = progressApi

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
const chatSessions = useChatSessions(workspaceId)
const inputText = ref('')
const openChunkId = ref<string | null>(null)
const sidePanel = ref<'inspector' | 'viewer' | null>('inspector')
const scroller = ref<HTMLDivElement | null>(null)

const lastAssistant = computed(() =>
  [...chat.messages.value].reverse().find((m) => m.role === 'assistant') ?? null,
)

onMounted(async () => {
  await Promise.all([chat.loadHistory(), chatSessions.refresh()])
  scrollToBottom()

  // Honour ?ask=<prefilled question> — used by the graph detail panel's
  // "Ask AI" button to hand off the user mid-flow.
  const ask = route.query.ask
  if (typeof ask === 'string' && ask.trim()) {
    inputText.value = ask
    // Strip the query so a page refresh doesn't re-trigger.
    await navigateTo({ path: route.path }, { replace: true })
  }
})

function onOpenChunk(chunkId: string): void {
  openChunkId.value = chunkId
  sidePanel.value = 'viewer'
}

function startNewChat(): void {
  chat.newSession()
  openChunkId.value = null
  void chatSessions.refresh()
}

async function selectSession(id: string): Promise<void> {
  await chat.switchSession(id)
  openChunkId.value = null
  scrollToBottom()
}

async function deleteSession(id: string): Promise<void> {
  await chatSessions.remove(id)
  if (id === chat.sessionId.value) {
    chat.newSession()
  }
}

const reindexing = ref(false)
async function reindex(): Promise<void> {
  if (reindexing.value) return
  reindexing.value = true
  try {
    await $fetch(`/api/workspaces/${workspaceId}/reindex`, { method: 'POST' })
    done.value = false
    state.value = { status: 'pending', progress: null, stats: null, error: null }
    progressApi.start()
    await refreshWs()
  } catch (err) {
    alert(err instanceof Error ? err.message : 'Re-index failed')
  } finally {
    reindexing.value = false
  }
}

async function submit(): Promise<void> {
  if (chat.streaming.value || !inputText.value.trim()) return
  const q = inputText.value
  inputText.value = ''
  await chat.send(q)
  scrollToBottom()
  void chatSessions.refresh()
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
        <div class="flex items-center gap-2">
          <Button
            v-if="isReady || isFailed"
            variant="outline"
            size="sm"
            :disabled="reindexing"
            :title="t('workspace.reindexHint')"
            @click="reindex"
          >
            {{ reindexing ? t('workspace.reindexing') : t('workspace.reindex') }}
          </Button>
          <NuxtLink v-if="isReady" :to="`/w/${workspaceId}/graph`">
            <Button variant="outline" size="sm">
              {{ t('workspace.viewGraph') }}
            </Button>
          </NuxtLink>
        </div>
      </div>
    </header>

    <section
      v-if="!isReady && !isFailed"
      class="space-y-3 rounded-lg border border-border bg-card p-6"
    >
      <div class="flex items-center justify-between">
        <h2 class="text-sm font-medium uppercase tracking-wide text-muted-foreground">
          {{ t('workspace.indexing') }}
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
        {{ message || t('workspace.waiting') }}
      </p>
    </section>

    <section
      v-else-if="isFailed"
      class="space-y-2 rounded-lg border border-destructive bg-destructive/10 p-6"
    >
      <h2 class="text-lg font-semibold text-destructive">
        {{ t('workspace.indexingFailed') }}
      </h2>
      <p class="text-sm">
        {{ wsData.workspace.error ?? 'Unknown error' }}
      </p>
    </section>

    <GitInsightsCard v-if="isReady && gitInsights" :insights="gitInsights" />

    <section
      v-if="isReady"
      class="flex h-[calc(100vh-14rem)] gap-3"
    >
      <ChatSessionsList
        :sessions="chatSessions.sessions.value"
        :loading="chatSessions.loading.value"
        :active-session-id="chat.sessionId.value"
        @new="startNewChat"
        @select="selectSession"
        @delete="deleteSession"
      />
      <div class="flex flex-1 flex-col overflow-hidden rounded-lg border border-border bg-card">
        <div ref="scroller" class="flex-1 space-y-3 overflow-y-auto p-4">
          <p v-if="chat.messages.value.length === 0" class="text-center text-sm text-muted-foreground">
            {{ t('workspace.askPrompt') }}
          </p>
          <ChatMessage
            v-for="(msg, i) in chat.messages.value"
            :key="i"
            :role="msg.role"
            :content="msg.content"
            :pending="msg.pending"
            :invalid="msg.invalid"
            :citations="msg.citations"
            :workspace-id="workspaceId"
            @open-chunk="onOpenChunk"
          />
        </div>
        <form
          class="flex items-center gap-2 border-t border-border p-3"
          @submit.prevent="submit"
        >
          <input
            v-model="inputText"
            type="text"
            :placeholder="t('workspace.askPlaceholder')"
            class="flex-1 rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
            :disabled="chat.streaming.value"
          >
          <Button type="submit" :disabled="chat.streaming.value || !inputText.trim()">
            {{ t('workspace.send') }}
          </Button>
        </form>
      </div>

      <div v-if="sidePanel" class="flex w-[420px] shrink-0 flex-col gap-2">
        <div class="flex gap-1">
          <Button
            variant="outline"
            size="sm"
            :class="sidePanel === 'inspector' ? 'bg-accent' : ''"
            @click="sidePanel = 'inspector'"
          >
            {{ t('chat.panels.reasoning') }}
          </Button>
          <Button
            variant="outline"
            size="sm"
            :class="sidePanel === 'viewer' ? 'bg-accent' : ''"
            @click="sidePanel = 'viewer'"
          >
            {{ t('chat.panels.source') }}
          </Button>
        </div>
        <ReasoningInspector
          v-if="sidePanel === 'inspector'"
          :plan="lastAssistant?.plan ?? null"
          :trace="lastAssistant?.trace ?? null"
        />
        <SourceViewerDrawer
          v-else-if="sidePanel === 'viewer' && openChunkId"
          :workspace-id="workspaceId"
          :chunk-id="openChunkId"
          @close="sidePanel = 'inspector'"
        />
        <aside
          v-else-if="sidePanel === 'viewer' && !openChunkId"
          class="flex h-full w-full items-center justify-center rounded-lg border border-border bg-card p-6 text-center text-sm text-muted-foreground"
        >
          {{ t('chat.panels.sourcePlaceholder') }}
        </aside>
      </div>
    </section>
  </div>
</template>
