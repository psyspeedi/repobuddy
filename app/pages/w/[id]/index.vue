<script setup lang="ts">

// Guests need to reach the page; server-side readAccess decides whether
// the workspace is publicly visible. If not, the API returns 404 and
// useFetch surfaces it as an error.
definePageMeta({ auth: false })

const { t } = useI18n()
const { loggedIn } = useUserSession()
const route = useRoute()
const workspaceId = String(route.params.id)

interface WorkspaceResponse {
  workspace: {
    id: string
    name: string
    sourceUrl: string | null
    status: string
    error: string | null
    stats: WorkspaceStats | null
    isPublic: boolean
    languages: string[]
  }
  viewerIsOwner: boolean
}

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

const { data: wsData, refresh: refreshWs } = await useFetch<WorkspaceResponse>(
  `/api/workspaces/${workspaceId}`,
  { key: `workspace-${workspaceId}` },
)

const gitInsights = computed(() => wsData.value?.workspace.stats?.gitInsights ?? null)
const viewerIsOwner = computed(() => wsData.value?.viewerIsOwner ?? false)
const isPublic = computed(() => wsData.value?.workspace.isPublic ?? false)

async function togglePublic(): Promise<void> {
  if (!wsData.value) return
  const next = !isPublic.value
  try {
    await $fetch(`/api/workspaces/${workspaceId}/visibility`, {
      method: 'PUT',
      body: { isPublic: next },
    })
    await refreshWs()
  } catch (err) {
    useToast().error(err instanceof Error ? err.message : t('workspace.visibilityFailed'))
  }
}

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
const sidePanel = ref<'inspector' | 'viewer' | 'neighbours' | null>('inspector')
const neighbourEntityId = ref<string | null>(null)
function openNeighbours(entityId: string): void {
  neighbourEntityId.value = entityId
  sidePanel.value = 'neighbours'
}
const scroller = ref<HTMLDivElement | null>(null)

const lastAssistant = computed(() =>
  [...chat.messages.value].reverse().find((m) => m.role === 'assistant') ?? null,
)

// Keyboard shortcuts:
//   Cmd/Ctrl + Enter — submit (works from anywhere on the page).
//   Cmd/Ctrl + K     — focus the chat input.
//   Esc              — close any open side panel (viewer/inspector
//                      stays, but the modal dismisses).
const chatInput = ref<HTMLInputElement | null>(null)
function onKeydown(e: KeyboardEvent): void {
  const meta = e.metaKey || e.ctrlKey
  if (meta && e.key === 'Enter') {
    e.preventDefault()
    if (!chat.streaming.value && inputText.value.trim()) void submit()
    return
  }
  if (meta && (e.key === 'k' || e.key === 'K')) {
    e.preventDefault()
    chatInput.value?.focus()
    return
  }
  if (e.key === 'Escape') {
    if (deleteOpen.value) deleteOpen.value = false
    else if (chat.streaming.value) chat.cancel()
  }
}

onMounted(async () => {
  // Skip the chat-history fetch for guests — they have no persisted
  // sessions, so /api/chat/sessions would just return an empty list.
  const tasks: Promise<unknown>[] = [chat.loadHistory()]
  if (loggedIn.value) tasks.push(chatSessions.refresh())
  await Promise.all(tasks)
  scrollToBottom()
  window.addEventListener('keydown', onKeydown)

  // Honour ?session=<uuid> — share link target. Switches the chat
  // to the referenced session (loads its history if persisted).
  const sessionQ = route.query.session
  if (typeof sessionQ === 'string' && /^[0-9a-f-]{36}$/i.test(sessionQ)) {
    await chat.switchSession(sessionQ)
    scrollToBottom()
  }

  // Honour ?ask=<prefilled question> — used by the graph detail panel's
  // "Ask AI" button to hand off the user mid-flow.
  const ask = route.query.ask
  if (typeof ask === 'string' && ask.trim()) {
    inputText.value = ask
    // Strip the query so a page refresh doesn't re-trigger.
    await navigateTo({ path: route.path }, { replace: true })
  }
})

onUnmounted(() => {
  if (typeof window !== 'undefined') window.removeEventListener('keydown', onKeydown)
})

// Share-chat URL — copies a deep link to the current session. Works
// for owners (history persisted) and for guests on public workspaces
// (the link will simply land on an empty chat for the reader).
const shareCopied = ref(false)
async function shareChat(): Promise<void> {
  const url = `${window.location.origin}/w/${workspaceId}?session=${chat.sessionId.value}`
  try {
    await navigator.clipboard.writeText(url)
    shareCopied.value = true
    setTimeout(() => { shareCopied.value = false }, 1500)
  } catch {
    // ignore
  }
}

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

// Suggested questions — surfaced when the chat is empty. The list is
// localised; keep it short (5 items) so the page doesn't feel like a
// menu. Guest-friendly: nothing here requires an account.
const suggestedQuestions = computed(() => [
  t('workspace.suggest.q1'),
  t('workspace.suggest.q2'),
  t('workspace.suggest.q3'),
  t('workspace.suggest.q4'),
  t('workspace.suggest.q5'),
])
function usePrompt(q: string): void {
  inputText.value = q
  void submit()
}

// Delete flow — typed-confirmation modal.
const deleteOpen = ref(false)
const deleteName = ref('')
const deleting = ref(false)
async function confirmDelete(): Promise<void> {
  if (deleting.value) return
  deleting.value = true
  try {
    // Cast to any: Nuxt's typed-routes generator narrows method by route
    // pattern and rejects DELETE here even though the endpoint exists.
    await ($fetch as unknown as (url: string, init: RequestInit) => Promise<unknown>)(
      `/api/workspaces/${workspaceId}`,
      { method: 'DELETE' },
    )
    await navigateTo('/')
  } catch (err) {
    useToast().error(err instanceof Error ? err.message : t('workspace.deleteFailed'))
    deleting.value = false
  }
}

// Welcome overlay — shown automatically the first time a user lands on
// a ready workspace, then on demand via the "Tour" button. The seen
// flag is per-(workspace, browser) and is read synchronously on mount
// to avoid the modal flashing in after the page is interactive.
const showOnboarding = ref(false)
const ONBOARDING_KEY = `cg-onb-seen-${workspaceId}`
function openOnboarding(): void {
  showOnboarding.value = true
}
function closeOnboarding(): void {
  showOnboarding.value = false
  try { localStorage.setItem(ONBOARDING_KEY, '1') } catch { /* private mode */ }
}
function onOnboardWalkthrough(payload: { entityId: string; name: string }): void {
  inputText.value = t('workspace.askWalkthrough', { name: payload.name })
  void submit()
}
function onOnboardAsk(question: string): void {
  inputText.value = question
  void submit()
}
watch(isReady, (ready) => {
  if (!ready) return
  let seen = '1'
  try { seen = localStorage.getItem(ONBOARDING_KEY) ?? '' } catch { /* private mode */ }
  if (!seen) showOnboarding.value = true
}, { immediate: true })

const reindexing = ref(false)
async function reindex(): Promise<void> {
  if (reindexing.value) return
  // Re-indexing re-walks the repo, re-runs LLM annotation and re-embeds
  // chunks → real token spend. Confirm so an accidental click on a
  // ready workspace doesn't burn the daily budget.
  const ok = await useConfirm().ask({
    title: t('workspace.reindexConfirmTitle'),
    body: t('workspace.reindexConfirmBody'),
    confirmLabel: t('workspace.reindex'),
  })
  if (!ok) return
  reindexing.value = true
  try {
    await $fetch(`/api/workspaces/${workspaceId}/reindex`, { method: 'POST' })
    done.value = false
    state.value = { status: 'pending', progress: null, stats: null, error: null }
    progressApi.start()
    await refreshWs()
  } catch (err) {
    useToast().error(err instanceof Error ? err.message : t('workspace.reindexFailed'))
  } finally {
    reindexing.value = false
  }
}

// Auto-explore = agentic mode. Persisted in localStorage so a user
// who turned it on once doesn't have to re-flip it every session.
const autoExplore = ref(false)
if (import.meta.client) {
  try { autoExplore.value = localStorage.getItem('cg-auto-explore') === '1' } catch { /* private mode */ }
}
watch(autoExplore, (v) => {
  try { localStorage.setItem('cg-auto-explore', v ? '1' : '0') } catch { /* private mode */ }
})

async function submit(): Promise<void> {
  if (chat.streaming.value || !inputText.value.trim()) return
  const q = inputText.value
  inputText.value = ''
  await chat.send(q, { mode: autoExplore.value ? 'agentic' : 'planned' })
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

// Per-workspace head — gives each public workspace its own SERP card.
// Private workspaces opt out of indexing here so even if robots.txt
// is ignored, the meta `robots` directive keeps them out.
const runtimeCfg = useRuntimeConfig()
const appUrl = (runtimeCfg.public.appUrl as string | undefined)?.replace(/\/$/, '') ?? ''
const wsCanonical = computed(() => `${appUrl}/w/${workspaceId}`)
const wsDescription = computed(() => {
  const ws = wsData.value?.workspace
  if (!ws) return ''
  const langs = ws.languages?.length ? ` Languages: ${ws.languages.join(', ')}.` : ''
  const src = ws.sourceUrl ? ` Source: ${ws.sourceUrl}.` : ''
  return `Explore ${ws.name} on RepoBuddy — ask questions about the codebase, see the knowledge graph, get cited answers.${langs}${src}`.slice(0, 280)
})
const wsJsonLd = computed(() => {
  const ws = wsData.value?.workspace
  if (!ws || !isPublic.value) return null
  return JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'SoftwareSourceCode',
    name: ws.name,
    url: wsCanonical.value,
    codeRepository: ws.sourceUrl ?? undefined,
    programmingLanguage: ws.languages ?? [],
    isAccessibleForFree: true,
  })
})
useHead(() => {
  const ws = wsData.value?.workspace
  const indexable = isPublic.value && !!ws
  return {
    title: `${ws?.name ?? 'Workspace'} — RepoBuddy`,
    meta: [
      { name: 'description', content: wsDescription.value },
      { property: 'og:title', content: `${ws?.name ?? 'Workspace'} — RepoBuddy` },
      { property: 'og:description', content: wsDescription.value },
      { property: 'og:url', content: wsCanonical.value },
      // Private / failed / pending workspaces stay out of search engines.
      indexable
        ? { name: 'robots', content: 'index, follow' }
        : { name: 'robots', content: 'noindex, nofollow' },
    ],
    link: [{ rel: 'canonical', href: wsCanonical.value }],
    script: wsJsonLd.value
      ? [{ type: 'application/ld+json', innerHTML: wsJsonLd.value }]
      : [],
  }
})
</script>

<template>
  <div v-if="wsData" class="cg-no-scroll flex flex-1 flex-col gap-4 min-h-0">
    <header class="space-y-2">
      <NuxtLink
        v-if="loggedIn"
        to="/"
        class="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
      >
        <span aria-hidden="true">←</span>
        {{ t('workspace.backToList') }}
      </NuxtLink>
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
          <span
            v-if="isPublic"
            class="rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2 py-0.5 text-[11px] font-medium text-emerald-700 dark:text-emerald-300"
            :title="t('workspace.publicHint')"
          >
            {{ t('workspace.publicBadge') }}
          </span>
          <Button
            v-if="viewerIsOwner"
            variant="outline"
            size="sm"
            :title="t('workspace.publicHint')"
            @click="togglePublic"
          >
            {{ isPublic ? t('workspace.makePrivate') : t('workspace.makePublic') }}
          </Button>
          <Button
            v-if="viewerIsOwner && (isReady || isFailed)"
            variant="outline"
            size="sm"
            :disabled="reindexing"
            :title="t('workspace.reindexHint')"
            @click="reindex"
          >
            {{ reindexing ? t('workspace.reindexing') : t('workspace.reindex') }}
          </Button>
          <Button
            v-if="isReady"
            variant="outline"
            size="sm"
            :title="t('workspace.tourHint')"
            @click="openOnboarding"
          >
            {{ t('workspace.tour') }}
          </Button>
          <NuxtLink v-if="isReady" :to="`/w/${workspaceId}/explore`">
            <Button variant="outline" size="sm">
              {{ t('workspace.explore') }}
            </Button>
          </NuxtLink>
          <Button
            v-if="viewerIsOwner"
            variant="ghost"
            size="sm"
            class="text-destructive hover:bg-destructive/10 hover:text-destructive"
            :title="t('workspace.deleteTitle')"
            @click="deleteOpen = true"
          >
            {{ t('workspace.delete') }}
          </Button>
        </div>
      </div>
    </header>

    <WorkspaceOnboarding
      v-if="showOnboarding"
      :workspace-id="workspaceId"
      @close="closeOnboarding"
      @walkthrough="onOnboardWalkthrough"
      @open-entity="openNeighbours"
      @ask="onOnboardAsk"
    />

    <!-- Delete confirmation modal -->
    <div
      v-if="deleteOpen"
      class="fixed inset-0 z-50 flex items-center justify-center bg-background/80 p-4 backdrop-blur"
      @click.self="deleteOpen = false"
    >
      <div class="w-full max-w-md space-y-4 rounded-xl border border-destructive/30 bg-card p-5 shadow-xl">
        <div class="space-y-1">
          <h3 class="text-lg font-semibold text-destructive">
            {{ t('workspace.deleteConfirmTitle') }}
          </h3>
          <p class="text-sm text-muted-foreground">
            {{ t('workspace.deleteConfirmBody', { name: wsData.workspace.name }) }}
          </p>
        </div>
        <input
          v-model="deleteName"
          type="text"
          autocomplete="off"
          :placeholder="wsData.workspace.name"
          class="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-destructive"
        >
        <div class="flex items-center justify-end gap-2">
          <Button variant="ghost" size="sm" :disabled="deleting" @click="deleteOpen = false">
            {{ t('workspace.deleteCancel') }}
          </Button>
          <Button
            variant="default"
            size="sm"
            class="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            :disabled="deleting || deleteName !== wsData.workspace.name"
            @click="confirmDelete"
          >
            {{ deleting ? t('workspace.deleting') : t('workspace.deleteConfirm') }}
          </Button>
        </div>
      </div>
    </div>

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
      class="flex flex-1 flex-col gap-3 min-h-[400px] lg:flex-row"
    >
      <!-- Hide the chat history sidebar for guests — their sessions are
           ephemeral, so the list would always be empty and useless.
           On small screens hide too — full-width chat reads better than
           a cramped column. -->
      <ChatSessionsList
        v-if="loggedIn"
        class="hidden lg:flex"
        :sessions="chatSessions.sessions.value"
        :loading="chatSessions.loading.value"
        :active-session-id="chat.sessionId.value"
        @new="startNewChat"
        @select="selectSession"
        @delete="deleteSession"
      />
      <div class="flex flex-1 flex-col overflow-hidden rounded-lg border border-border bg-card min-h-0">
        <div class="flex items-center justify-end gap-2 border-b border-border px-3 py-1.5 text-xs text-muted-foreground">
          <button
            type="button"
            class="hover:text-foreground"
            :title="t('workspace.shareTitle')"
            @click="shareChat"
          >
            {{ shareCopied ? t('workspace.shareCopied') : t('workspace.share') }}
          </button>
          <span class="hidden tabular-nums sm:inline">⌘K · ⌘↵</span>
        </div>
        <div ref="scroller" class="flex-1 space-y-3 overflow-y-auto p-4 min-h-0">
          <div v-if="chat.messages.value.length === 0" class="space-y-4">
            <p class="text-center text-sm text-muted-foreground">
              {{ t('workspace.askPrompt') }}
            </p>
            <!-- Suggested questions — lowers the barrier for first-time
                 visitors (especially guests on public workspaces). -->
            <div class="mx-auto flex max-w-2xl flex-wrap justify-center gap-2">
              <button
                v-for="(q, i) in suggestedQuestions"
                :key="i"
                type="button"
                class="rounded-full border border-primary/30 bg-primary/5 px-3 py-1.5 text-sm text-primary transition hover:bg-primary/15"
                @click="usePrompt(q)"
              >
                {{ q }}
              </button>
            </div>
          </div>
          <ChatMessage
            v-for="(msg, i) in chat.messages.value"
            :key="i"
            :role="msg.role"
            :content="msg.content"
            :pending="msg.pending"
            :invalid="msg.invalid"
            :citations="msg.citations"
            :tokens-per-sec="msg.tokensPerSec"
            :workspace-id="workspaceId"
            @open-chunk="onOpenChunk"
            @open-entity="openNeighbours"
          />
        </div>
        <form
          class="flex items-center gap-2 border-t border-border p-3"
          @submit.prevent="submit"
        >
          <label
            class="flex shrink-0 items-center gap-1.5 rounded-md border border-border bg-background px-2 py-1 text-[11px] text-muted-foreground hover:text-foreground cursor-pointer"
            :class="autoExplore ? 'border-primary/40 bg-primary/10 text-primary' : ''"
            :title="t('workspace.autoExploreHint')"
          >
            <input v-model="autoExplore" type="checkbox" class="h-3 w-3 accent-primary">
            {{ t('workspace.autoExplore') }}
          </label>
          <input
            ref="chatInput"
            v-model="inputText"
            type="text"
            :placeholder="t('workspace.askPlaceholder')"
            class="flex-1 rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
            :disabled="chat.streaming.value"
          >
          <Button
            v-if="chat.streaming.value"
            type="button"
            variant="outline"
            class="border-destructive/40 text-destructive hover:bg-destructive/10"
            @click="chat.cancel"
          >
            {{ t('workspace.stop') }}
          </Button>
          <Button v-else type="submit" :disabled="!inputText.trim()">
            {{ t('workspace.send') }}
          </Button>
        </form>
      </div>

      <div v-if="sidePanel" class="hidden w-[560px] shrink-0 flex-col gap-2 lg:flex">
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
          <Button
            v-if="neighbourEntityId"
            variant="outline"
            size="sm"
            :class="sidePanel === 'neighbours' ? 'bg-accent' : ''"
            @click="sidePanel = 'neighbours'"
          >
            {{ t('chat.panels.neighbours') }}
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
        <EntityNeighbourGraph
          v-else-if="sidePanel === 'neighbours' && neighbourEntityId"
          :workspace-id="workspaceId"
          :entity-id="neighbourEntityId"
          @close="sidePanel = 'inspector'"
          @focus="openNeighbours"
        />
      </div>
    </section>
  </div>
</template>
