<script setup lang="ts">
import { History } from 'lucide-vue-next'

// Guests need to reach the page; server-side readAccess decides whether
// the workspace is publicly visible. If not, the API returns 404 and
// useFetch surfaces it as an error.
definePageMeta({ auth: false })

const { t, te, locale } = useI18n()
const { loggedIn } = useAuth()
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
    useOwnerKeyForGuests: boolean
    languages: string[]
  }
  viewerIsOwner: boolean
}

interface WorkspaceStats {
  files?: number
  entities?: number
  filesTruncated?: number
  annotationBudgetHit?: number
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

const { data: wsData, refresh: refreshWs } = await useApiFetch<WorkspaceResponse>(
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
    await useApi()(`/api/workspaces/${workspaceId}/visibility`, {
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

// Raw pipeline phase names (cloning / parsing / extracting…) are engine
// jargon — map them to human labels, fall back to the raw name for
// anything unmapped so a new phase never renders as a blank.
const phaseLabel = computed(() => {
  const key = `workspace.phase.${phase.value}`
  return te(key) ? t(key) : phase.value
})

// Index freshness — how far the indexed commit lags behind the repo's
// HEAD. Loaded lazily once the workspace is ready; the API caches the
// GitHub round-trip in Redis so this stays cheap.
interface FreshnessResponse {
  indexedSha: string | null
  headSha: string | null
  behindBy: number | null
  checkedAt: string
}
const { data: freshness, execute: loadFreshness } = useApiFetch<FreshnessResponse>(
  `/api/workspaces/${workspaceId}/freshness`,
  { immediate: false, server: false, lazy: true },
)
onMounted(() => {
  if (isReady.value) void loadFreshness()
})
watch(isReady, (ready) => {
  if (ready) void loadFreshness()
})
const freshnessSha7 = computed(() => freshness.value?.indexedSha?.slice(0, 7) ?? '')

// Honest-coverage notices. `stats` lands on the workspace row after
// indexing; each flag maps to a quiet banner so the user knows what the
// index can and cannot answer for this repo.
const coverageNotices = computed(() => {
  const stats = wsData.value?.workspace.stats
  if (!stats || !isReady.value) return []
  const out: { key: string; tone: 'warning' | 'notice'; text: string }[] = []
  if (stats.entities === 0) {
    out.push({ key: 'noEntities', tone: 'warning', text: t('workspace.coverage.noEntities') })
  }
  if (stats.filesTruncated === 1) {
    out.push({
      key: 'filesTruncated',
      tone: 'notice',
      text: t('workspace.coverage.filesTruncated', { n: stats.files ?? 0 }),
    })
  }
  if (stats.annotationBudgetHit === 1) {
    out.push({ key: 'annotationBudget', tone: 'notice', text: t('workspace.coverage.annotationBudget') })
  }
  return out
})

// Chat
const chat = useChat(workspaceId)
const isMobile = useIsMobile()
const chatSessions = useChatSessions(workspaceId)
const inputText = ref('')
const openChunkId = ref<string | null>(null)
// Default panel is Source — showing where answers come from matters more
// to a newcomer than the engine's reasoning trace. Inspector stays one
// tab away.
const sidePanel = ref<'inspector' | 'viewer' | 'neighbours' | null>('viewer')
// On phones the side column renders inside a BottomSheet — keeping the
// default panel open would cover the chat on load, so drop the empty
// Source placeholder once the viewport is known to be mobile.
watch(isMobile, (mobile) => {
  if (mobile && sidePanel.value === 'viewer' && !openChunkId.value) sidePanel.value = null
})
// Mobile-only chat-history sheet (the sessions sidebar is hidden < lg).
const sessionsSheetOpen = ref(false)
// Panel ids differ from their i18n keys ('viewer' tab is labelled
// "Source") — map explicitly for the mobile sheet title.
const sidePanelTitle = computed(() => {
  if (!sidePanel.value) return ''
  const key =
    sidePanel.value === 'inspector' ? 'reasoning' : sidePanel.value === 'viewer' ? 'source' : 'neighbours'
  return t(`chat.panels.${key}`)
})
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
    await useApi()(`/api/workspaces/${workspaceId}`, { method: 'DELETE' })
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
    await useApi()(`/api/workspaces/${workspaceId}/reindex`, { method: 'POST' })
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
const apiBaseUrl = (runtimeCfg.public.apiBaseUrl as string | undefined)?.replace(/\/$/, '') ?? ''
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

// Contributor-invite snippet. The badge is what turns a one-off
// indexing job into a repeating flow: it sits in the maintainer's
// README and every newcomer who clicks it lands here as a guest.
// Owner-only — for a visitor the snippet is just noise.
//
// The two URLs come from different origins on purpose. /badge/* is
// served by the API (it only sits outside the /api prefix so the URL
// stays short), so it is built from apiBaseUrl — the same reason
// githubAuthUrl is. wsCanonical is a page, so it stays on appUrl.
// Behind Caddy the two collapse into one domain; split-origin
// deployments and the documented local setup (Nuxt :3000, API :3001)
// need them apart or the preview renders a broken image and the
// copied snippet ships a dead link.
const badgeUrl = computed(() => `${apiBaseUrl}/badge/${workspaceId}.svg`)
const badgeSnippet = computed(
  () => `[![Explore with RepoBuddy](${badgeUrl.value})](${wsCanonical.value})`,
)
const badgeCopied = ref(false)
async function copyBadgeSnippet(): Promise<void> {
  try {
    await navigator.clipboard.writeText(badgeSnippet.value)
    badgeCopied.value = true
    setTimeout(() => { badgeCopied.value = false }, 1500)
  } catch {
    // Clipboard access is denied on insecure origins and in some
    // browsers — say so instead of leaving the button inert.
    useToast().error(t('workspace.invite.copyFailed'))
  }
}

// "Power visitor chats with my key" — owner-only opt-in. Needs the owner
// to have a BYOK key set (fetched lazily, owner only); the toggle is
// disabled with a hint otherwise.
const { data: byokStatus, execute: loadByok } = useApiFetch<{ configured: boolean }>(
  '/api/me/byok',
  { server: false, lazy: true, immediate: false },
)
onMounted(() => { if (viewerIsOwner.value) void loadByok() })
const ownerHasByok = computed(() => byokStatus.value?.configured ?? false)
const ownerKeyOn = ref(false)
watch(
  () => wsData.value?.workspace.useOwnerKeyForGuests,
  (v) => { ownerKeyOn.value = Boolean(v) },
  { immediate: true },
)
const ownerKeySaving = ref(false)
async function toggleOwnerKey(): Promise<void> {
  if (ownerKeySaving.value) return
  const next = !ownerKeyOn.value
  ownerKeySaving.value = true
  try {
    await useApi()(`/api/workspaces/${workspaceId}/owner-key`, {
      method: 'PUT',
      body: { useOwnerKeyForGuests: next },
    })
    ownerKeyOn.value = next
  } catch (err) {
    useToast().error(err instanceof Error ? err.message : t('workspace.ownerKey.failed'))
  } finally {
    ownerKeySaving.value = false
  }
}
</script>

<template>
  <div v-if="wsData" class="flex flex-col gap-3">
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
        <!-- Wraps: with the freshness badge this cluster runs to seven
             children, and the Russian labels alone overflow a phone
             viewport. The page shell is overflow-hidden, so anything
             past the edge is clipped, not scrollable. -->
        <div class="flex flex-wrap items-center justify-end gap-2 gap-y-2">
          <span
            v-if="isPublic"
            class="rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2 py-0.5 text-[11px] font-medium text-emerald-700 dark:text-emerald-300"
            :title="t('workspace.publicHint')"
          >
            {{ t('workspace.publicBadge') }}
          </span>
          <!-- While the workspace is private the tooltip carries the
               badge hint, so the invite card below does not have to
               exist just to say "make it public first". -->
          <Button
            v-if="viewerIsOwner"
            variant="outline"
            size="sm"
            :title="isPublic ? t('workspace.publicHint') : t('workspace.invite.privateHint')"
            @click="togglePublic"
          >
            {{ isPublic ? t('workspace.makePrivate') : t('workspace.makePublic') }}
          </Button>
          <span
            v-if="isReady && freshness && freshness.behindBy === 0"
            class="rounded-full border border-border bg-muted/50 px-2 py-0.5 text-[11px] tabular-nums text-muted-foreground"
            :title="t('workspace.freshness.upToDateHint', { sha: freshnessSha7 })"
          >
            {{ t('workspace.freshness.upToDate', { sha: freshnessSha7 }) }}
          </span>
          <!-- Owners can click through to a re-index; for everyone else
               the same badge is a plain read-only signal. -->
          <component
            :is="viewerIsOwner ? 'button' : 'span'"
            v-else-if="isReady && freshness && (freshness.behindBy ?? 0) > 0"
            :type="viewerIsOwner ? 'button' : undefined"
            class="rounded-full border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 text-[11px] font-medium text-amber-700 dark:text-amber-300"
            :class="viewerIsOwner ? 'hover:bg-amber-500/20' : ''"
            :title="viewerIsOwner
              ? t('workspace.freshness.behindHint', { n: freshness.behindBy, sha: freshnessSha7 }, freshness.behindBy ?? 0)
              : t('workspace.freshness.behindHintGuest', { n: freshness.behindBy, sha: freshnessSha7 }, freshness.behindBy ?? 0)"
            @click="viewerIsOwner && reindex()"
          >
            {{ t('workspace.freshness.behind', { n: freshness.behindBy }, freshness.behindBy ?? 0) }}
          </component>
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
        <span class="text-sm tabular-nums">{{ phaseLabel }} · {{ percent }}%</span>
      </div>
      <div class="h-2 w-full overflow-hidden rounded-full bg-muted">
        <div
          class="h-full bg-primary transition-all duration-300"
          :style="{ width: `${percent}%` }"
        />
      </div>
      <!-- The backend's progress `message` is English-only prose built in
           pipeline.ts ("Walking files…", "Embedded 12/40 chunks"). Under
           a localized phase label it read as half-translated, and the
           phase + percent above already carry the information, so the
           raw string is kept for English only. -->
      <p class="text-sm text-muted-foreground">
        {{ (locale === 'en' && message) || t('workspace.waiting') }}
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
        {{ wsData.workspace.error ?? t('workspace.unknownError') }}
      </p>
    </section>

    <GitInsightsCard v-if="isReady && gitInsights" :insights="gitInsights" />

    <!-- Coverage / limitation notices — honest signals about what the
         index does and doesn't cover for this repo. -->
    <section v-if="isReady && coverageNotices.length > 0" class="space-y-2">
      <div
        v-for="notice in coverageNotices"
        :key="notice.key"
        class="rounded-lg border px-4 py-3 text-sm"
        :class="notice.tone === 'warning'
          ? 'border-amber-500/30 bg-amber-500/8 text-amber-700 dark:bg-amber-500/10 dark:text-amber-300'
          : 'border-border bg-muted/40 text-muted-foreground'"
      >
        {{ notice.text }}
      </div>
    </section>

    <!-- Invite contributors — owner-only, and only once the workspace
         is public. The badge is the maintainer's distribution channel:
         index once, then let the README bring newcomers in as guests.
         An owner who is keeping the workspace private has made that
         choice already; nagging them on every visit is exactly the
         noise this page has been shedding, so the hint lives on the
         "Make public" tooltip instead. -->
    <!-- Collapsed by default: this is a one-time setup action, and the
         page cannot scroll, so ~190px spent on it permanently is ~190px
         taken from the chat below. -->
    <details
      v-if="viewerIsOwner && isReady && isPublic"
      class="shrink-0 rounded-lg border border-border bg-card px-4 py-3"
    >
      <summary class="cursor-pointer text-sm font-medium marker:text-muted-foreground">
        {{ t('workspace.invite.title') }}
      </summary>
      <div class="mt-2 space-y-2">
        <p class="text-sm text-muted-foreground">
          {{ t('workspace.invite.body') }}
        </p>
        <div class="flex items-center gap-2">
          <code class="flex-1 overflow-x-auto whitespace-nowrap rounded-md border border-border bg-muted/50 px-2 py-1.5 text-xs">{{ badgeSnippet }}</code>
          <Button variant="outline" size="sm" class="shrink-0" @click="copyBadgeSnippet">
            {{ badgeCopied ? t('workspace.invite.copied') : t('workspace.invite.copy') }}
          </Button>
        </div>
        <div class="flex items-center gap-2 text-xs text-muted-foreground">
          <span>{{ t('workspace.invite.preview') }}</span>
          <img :src="badgeUrl" alt="Explore with RepoBuddy" height="20" class="h-5">
        </div>

        <!-- Who pays for the visitors you invite. Off = the server key
             (operator's budget); on = your own BYOK key. Visitor quotas
             and rate limits stay on either way. -->
        <div class="mt-1 border-t border-border pt-3">
          <label
            class="flex items-start gap-2"
            :class="ownerHasByok ? 'cursor-pointer' : 'cursor-not-allowed opacity-70'"
          >
            <input
              type="checkbox"
              class="mt-0.5 h-3.5 w-3.5 accent-primary"
              :checked="ownerKeyOn"
              :disabled="!ownerHasByok || ownerKeySaving"
              @change="toggleOwnerKey"
            >
            <span class="text-xs">
              <span class="font-medium text-foreground">{{ t('workspace.ownerKey.label') }}</span>
              <span class="mt-0.5 block text-muted-foreground">{{ t('workspace.ownerKey.hint') }}</span>
              <NuxtLink
                v-if="!ownerHasByok"
                to="/settings"
                class="mt-1 inline-block text-primary hover:underline"
              >
                {{ t('workspace.ownerKey.needByok') }}
              </NuxtLink>
            </span>
          </label>
        </div>
      </div>
    </details>

    <!-- The page scrolls normally now (no cg-no-scroll on the root), so
         the chat takes a comfortable bounded height instead of fighting
         the header, insights and invite card for a fixed viewport. 72vh
         reads well on a laptop and the message list scrolls inside it;
         min-h keeps the composer usable on very short windows. The three
         columns (sessions, chat, side panel) stretch to this height. -->
    <section
      v-if="isReady"
      class="flex h-[72vh] min-h-[460px] flex-col gap-3 lg:flex-row"
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
        <div class="flex items-center gap-2 border-b border-border px-3 py-1.5 text-xs text-muted-foreground">
          <!-- Mobile-only session controls — the sessions sidebar is
               hidden below lg, so "new chat" and the history sheet
               trigger live here instead. -->
          <div v-if="loggedIn" class="flex items-center gap-1 lg:hidden">
            <button
              type="button"
              class="rounded-md border border-border px-2 py-1 hover:bg-accent hover:text-foreground"
              @click="startNewChat"
            >
              {{ t('chat.newChat') }}
            </button>
            <button
              type="button"
              class="rounded-md border border-border p-1 hover:bg-accent hover:text-foreground"
              :title="t('chat.history')"
              :aria-label="t('chat.history')"
              @click="sessionsSheetOpen = true"
            >
              <History class="h-3.5 w-3.5" />
            </button>
          </div>
          <div class="ml-auto flex items-center gap-2">
            <span class="hidden tabular-nums sm:inline">⌘K · ⌘↵</span>
          </div>
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
            :workspace-id="workspaceId"
            :resolution="extractResolution(msg.trace)"
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

      <!-- Desktop (>= lg): side column. The same component renders inside
           the mobile bottom sheet below; the breakpoint switch is purely
           a layout concern. -->
      <div v-if="sidePanel" class="hidden w-[560px] shrink-0 flex-col gap-2 lg:flex">
        <SidePanelStack
          :side-panel="sidePanel"
          :workspace-id="workspaceId"
          :neighbour-entity-id="neighbourEntityId"
          :open-chunk-id="openChunkId"
          :plan="lastAssistant?.plan ?? null"
          :trace="lastAssistant?.trace ?? null"
          @update:side-panel="(v) => (sidePanel = v)"
          @focus-neighbour="openNeighbours"
        />
      </div>
    </section>

    <!-- Mobile (< lg): the same panels render in a bottom sheet. Open
         state is driven by sidePanel being set on viewports below the lg
         breakpoint; closing the sheet clears sidePanel so the next chat
         turn doesn't reopen it. -->
    <!-- Mobile (< lg): chat-history sessions in a sheet — the sidebar
         above is hidden on small screens. -->
    <BottomSheet
      :open="isMobile && sessionsSheetOpen"
      :title="t('chat.history')"
      @close="sessionsSheetOpen = false"
    >
      <div class="h-[60vh]">
        <ChatSessionsList
          :sessions="chatSessions.sessions.value"
          :loading="chatSessions.loading.value"
          :active-session-id="chat.sessionId.value"
          @new="() => { startNewChat(); sessionsSheetOpen = false }"
          @select="(id: string) => { void selectSession(id); sessionsSheetOpen = false }"
          @delete="deleteSession"
        />
      </div>
    </BottomSheet>

    <BottomSheet
      :open="isMobile && sidePanel !== null"
      :title="sidePanelTitle"
      @close="sidePanel = null"
    >
      <SidePanelStack
        v-if="sidePanel"
        :side-panel="sidePanel"
        :workspace-id="workspaceId"
        :neighbour-entity-id="neighbourEntityId"
        :open-chunk-id="openChunkId"
        :plan="lastAssistant?.plan ?? null"
        :trace="lastAssistant?.trace ?? null"
        @update:side-panel="(v) => (sidePanel = v)"
        @focus-neighbour="openNeighbours"
      />
    </BottomSheet>
  </div>
</template>
