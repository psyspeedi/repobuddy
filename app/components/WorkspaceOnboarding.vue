<script setup lang="ts">
import { Sparkles, X, Compass, Layers, GitBranch, ArrowRight, Github, Terminal, ExternalLink, Copy, Check, Pin, PinOff } from 'lucide-vue-next'

interface Entrypoint {
  entityId: string | null
  name: string
  filePath: string
  kind: 'main' | 'cli' | 'http_route' | 'python_main' | 'readme_quickstart'
  description: string
}
interface CoreAbstraction {
  entityId: string
  name: string
  type: string
  qualifiedName: string | null
  filePath: string | null
  inDegree: number
  description: string | null
}
interface FirstIssueZone {
  entityId: string
  filePath: string
  score: number
  reasons: string[]
  hotness: number
  entityCount: number
  hasTests: boolean
}
interface OnboardingPayload {
  entrypoints: Entrypoint[]
  coreAbstractions: CoreAbstraction[]
  goodFirstIssues: FirstIssueZone[]
}
interface LinkedEntity {
  entityId: string
  name: string
  type: string
  filePath: string | null
  inDegree: number
}
interface GithubIssue {
  number: number
  title: string
  url: string
  bodyExcerpt: string
  labels: string[]
  author: string | null
  updatedAt: string
  relatedEntities: LinkedEntity[]
  difficulty: 'easy' | 'medium' | 'hard'
  difficultyScore: number
}
interface IssuesPayload {
  issues: GithubIssue[]
  reason?: 'no_source_url' | 'not_github' | 'rate_limited' | 'repo_not_found' | 'fetch_failed'
}
interface SetupStep {
  kind: 'install' | 'env' | 'run' | 'test' | 'docker' | 'note'
  label: string
  command: string | null
  source: string
}
interface SetupGuidePayload {
  steps: SetupStep[]
  signals: {
    packageManager: 'pnpm' | 'yarn' | 'npm' | 'bun' | null
    hasDocker: boolean
    hasDockerCompose: boolean
    hasMakefile: boolean
    hasPyproject: boolean
    hasGoMod: boolean
    hasCargoToml: boolean
  }
  readmeQuickStart: string | null
}

const props = defineProps<{
  workspaceId: string
  /** Currently pinned entity IDs / file paths / issue numbers — passed
   * by the parent so the pin button can render as toggled. */
  pinnedEntities?: string[]
  pinnedFiles?: string[]
  pinnedIssues?: number[]
}>()
const emit = defineEmits<{
  (e: 'close'): void
  (e: 'walkthrough', payload: { entityId: string; name: string }): void
  (e: 'open-entity', entityId: string): void
  (e: 'ask', question: string): void
  (e: 'pin-entity', entityId: string): void
  (e: 'unpin-entity', entityId: string): void
  (e: 'pin-file', path: string): void
  (e: 'unpin-file', path: string): void
  (e: 'pin-issue', number: number): void
  (e: 'unpin-issue', number: number): void
}>()

function isPinnedEntity(id: string | null): boolean {
  return !!id && (props.pinnedEntities ?? []).includes(id)
}
function isPinnedFile(path: string): boolean {
  return (props.pinnedFiles ?? []).includes(path)
}
function isPinnedIssue(n: number): boolean {
  return (props.pinnedIssues ?? []).includes(n)
}
function toggleEntityPin(id: string | null): void {
  if (!id) return
  if (isPinnedEntity(id)) emit('unpin-entity', id)
  else emit('pin-entity', id)
}
function toggleFilePin(path: string): void {
  if (isPinnedFile(path)) emit('unpin-file', path)
  else emit('pin-file', path)
}
function toggleIssuePin(n: number): void {
  if (isPinnedIssue(n)) emit('unpin-issue', n)
  else emit('pin-issue', n)
}

const { t } = useI18n()

// Lazy SWR — only fetch when the overlay actually opens. The endpoint
// is read-only and the result is deterministic per workspace until
// re-index, so a fresh fetch per open is fine.
const { data, pending, error } = useFetch<OnboardingPayload>(
  `/api/workspaces/${props.workspaceId}/onboarding`,
  { key: `onboarding-${props.workspaceId}` },
)

// Issues + setup-guide are lazy — only fetched when the user actually
// scrolls to / opens their sections. Issues hits the GitHub API which
// can be slow or rate-limited, and the guide is a separate query.
const issuesLoaded = ref(false)
const issuesData = ref<IssuesPayload | null>(null)
const issuesPending = ref(false)
async function loadIssues(): Promise<void> {
  if (issuesLoaded.value || issuesPending.value) return
  issuesPending.value = true
  try {
    issuesData.value = await $fetch<IssuesPayload>(
      `/api/workspaces/${props.workspaceId}/github-issues`,
    )
  } catch {
    issuesData.value = { issues: [], reason: 'fetch_failed' }
  } finally {
    issuesPending.value = false
    issuesLoaded.value = true
  }
}

const setupLoaded = ref(false)
const setupData = ref<SetupGuidePayload | null>(null)
const setupPending = ref(false)
async function loadSetup(): Promise<void> {
  if (setupLoaded.value || setupPending.value) return
  setupPending.value = true
  try {
    setupData.value = await $fetch<SetupGuidePayload>(
      `/api/workspaces/${props.workspaceId}/setup-guide`,
    )
  } catch {
    setupData.value = null
  } finally {
    setupPending.value = false
    setupLoaded.value = true
  }
}
// Fire both immediately — they're cheap server-side. Issues will
// noop if loaded; setup is a single DB query.
onMounted(() => {
  void loadSetup()
  void loadIssues()
})

const copiedCmd = ref<string | null>(null)
async function copyCommand(cmd: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(cmd)
    copiedCmd.value = cmd
    setTimeout(() => { if (copiedCmd.value === cmd) copiedCmd.value = null }, 1200)
  } catch { /* clipboard unavailable */ }
}

function askAboutIssue(issue: GithubIssue): void {
  const ref = issue.relatedEntities[0]
  const refHint = ref ? ` Hint: look at \`${ref.name}\` (${ref.filePath ?? ref.type}).` : ''
  emit(
    'ask',
    t('onboardingPanel.issueAsk', { number: issue.number, title: issue.title }) + refHint,
  )
  emit('close')
}

function kindLabel(kind: Entrypoint['kind']): string {
  return t(`onboardingPanel.kind.${kind}`)
}

function startWalkthrough(ep: Entrypoint): void {
  if (!ep.entityId) return
  emit('walkthrough', { entityId: ep.entityId, name: ep.name })
  emit('close')
}

function openInDrawer(entityId: string | null): void {
  if (!entityId) return
  emit('open-entity', entityId)
  emit('close')
}

function askAboutFile(filePath: string): void {
  emit('ask', t('onboardingPanel.firstIssueAsk', { path: filePath }))
  emit('close')
}

function close(): void {
  emit('close')
}

function onKeydown(e: KeyboardEvent): void {
  if (e.key === 'Escape') close()
}
onMounted(() => window.addEventListener('keydown', onKeydown))
onUnmounted(() => window.removeEventListener('keydown', onKeydown))
</script>

<template>
  <div
    class="fixed inset-0 z-50 flex items-center justify-center bg-background/80 p-4 backdrop-blur"
    @click.self="close"
  >
    <div class="w-full max-w-3xl max-h-[88vh] overflow-y-auto rounded-xl border border-border bg-card p-6 shadow-2xl">
      <div class="mb-4 flex items-start justify-between gap-4">
        <div>
          <h2 class="flex items-center gap-2 text-xl font-semibold">
            <Sparkles class="h-5 w-5 text-primary" />
            {{ t('onboardingPanel.title') }}
          </h2>
          <p class="mt-1 text-sm text-muted-foreground">
            {{ t('onboardingPanel.subtitle') }}
          </p>
        </div>
        <button
          type="button"
          class="rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
          :title="t('onboardingPanel.close')"
          @click="close"
        >
          <X class="h-4 w-4" />
        </button>
      </div>

      <div v-if="pending" class="py-10 text-center text-sm text-muted-foreground">
        {{ t('onboardingPanel.loading') }}
      </div>
      <div v-else-if="error" class="py-10 text-center text-sm text-destructive">
        {{ t('onboardingPanel.error') }}
      </div>
      <div v-else-if="data" class="space-y-6">
        <!-- Entrypoints -->
        <section>
          <h3 class="mb-2 flex items-center gap-2 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
            <Compass class="h-4 w-4" />
            {{ t('onboardingPanel.entrypoints.title') }}
          </h3>
          <p class="mb-3 text-xs text-muted-foreground">
            {{ t('onboardingPanel.entrypoints.hint') }}
          </p>
          <div v-if="data.entrypoints.length === 0" class="rounded border border-dashed border-border px-3 py-4 text-center text-xs text-muted-foreground">
            {{ t('onboardingPanel.entrypoints.empty') }}
          </div>
          <ul v-else class="space-y-2">
            <li
              v-for="ep in data.entrypoints"
              :key="`${ep.kind}-${ep.filePath}`"
              class="flex items-center justify-between gap-2 rounded border border-border bg-background/50 px-3 py-2"
            >
              <div class="min-w-0 flex-1">
                <div class="flex items-center gap-2">
                  <span class="rounded bg-accent px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">
                    {{ kindLabel(ep.kind) }}
                  </span>
                  <span class="truncate font-mono text-xs">{{ ep.name }}</span>
                </div>
                <div class="truncate text-[11px] text-muted-foreground">
                  {{ ep.filePath }}
                </div>
              </div>
              <div class="flex shrink-0 items-center gap-1">
                <button
                  v-if="ep.entityId"
                  type="button"
                  class="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
                  :class="isPinnedEntity(ep.entityId) ? 'text-primary' : ''"
                  :title="isPinnedEntity(ep.entityId) ? t('onboardingPanel.unpin') : t('onboardingPanel.pin')"
                  @click.stop="toggleEntityPin(ep.entityId)"
                >
                  <PinOff v-if="isPinnedEntity(ep.entityId)" class="h-3.5 w-3.5" />
                  <Pin v-else class="h-3.5 w-3.5" />
                </button>
                <Button
                  v-if="ep.entityId"
                  variant="outline"
                  size="sm"
                  @click="startWalkthrough(ep)"
                >
                  {{ t('onboardingPanel.entrypoints.walkthrough') }}
                  <ArrowRight class="ml-1 h-3 w-3" />
                </Button>
              </div>
            </li>
          </ul>
        </section>

        <!-- Core abstractions -->
        <section>
          <h3 class="mb-2 flex items-center gap-2 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
            <Layers class="h-4 w-4" />
            {{ t('onboardingPanel.abstractions.title') }}
          </h3>
          <p class="mb-3 text-xs text-muted-foreground">
            {{ t('onboardingPanel.abstractions.hint') }}
          </p>
          <div v-if="data.coreAbstractions.length === 0" class="rounded border border-dashed border-border px-3 py-4 text-center text-xs text-muted-foreground">
            {{ t('onboardingPanel.abstractions.empty') }}
          </div>
          <ul v-else class="space-y-1">
            <li
              v-for="abs in data.coreAbstractions"
              :key="abs.entityId"
              class="flex items-center justify-between gap-2 rounded border border-border bg-background/50 px-3 py-2 hover:bg-accent/40 cursor-pointer"
              @click="openInDrawer(abs.entityId)"
            >
              <div class="min-w-0 flex-1">
                <div class="flex items-center gap-2">
                  <span class="rounded bg-accent px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">
                    {{ abs.type }}
                  </span>
                  <span class="truncate font-mono text-xs">{{ abs.name }}</span>
                </div>
                <div v-if="abs.qualifiedName || abs.filePath" class="truncate text-[11px] text-muted-foreground">
                  {{ abs.qualifiedName ?? abs.filePath }}
                </div>
              </div>
              <div class="flex shrink-0 items-center gap-2">
                <button
                  type="button"
                  class="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
                  :class="isPinnedEntity(abs.entityId) ? 'text-primary' : ''"
                  :title="isPinnedEntity(abs.entityId) ? t('onboardingPanel.unpin') : t('onboardingPanel.pin')"
                  @click.stop="toggleEntityPin(abs.entityId)"
                >
                  <PinOff v-if="isPinnedEntity(abs.entityId)" class="h-3.5 w-3.5" />
                  <Pin v-else class="h-3.5 w-3.5" />
                </button>
                <span class="text-[11px] tabular-nums text-muted-foreground">
                  ← {{ abs.inDegree }}
                </span>
              </div>
            </li>
          </ul>
        </section>

        <!-- Good first issue zones -->
        <section>
          <h3 class="mb-2 flex items-center gap-2 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
            <GitBranch class="h-4 w-4" />
            {{ t('onboardingPanel.firstIssue.title') }}
          </h3>
          <p class="mb-3 text-xs text-muted-foreground">
            {{ t('onboardingPanel.firstIssue.hint') }}
          </p>
          <div v-if="data.goodFirstIssues.length === 0" class="rounded border border-dashed border-border px-3 py-4 text-center text-xs text-muted-foreground">
            {{ t('onboardingPanel.firstIssue.empty') }}
          </div>
          <ul v-else class="space-y-2">
            <li
              v-for="zone in data.goodFirstIssues"
              :key="zone.entityId"
              class="rounded border border-border bg-background/50 px-3 py-2"
            >
              <div class="flex items-center justify-between gap-2">
                <div class="min-w-0 flex-1">
                  <div class="truncate font-mono text-xs">{{ zone.filePath }}</div>
                  <div class="mt-1 flex flex-wrap gap-1">
                    <span
                      v-for="r in zone.reasons"
                      :key="r"
                      class="rounded bg-emerald-500/10 px-1.5 py-0.5 text-[10px] text-emerald-700 dark:text-emerald-300"
                    >
                      {{ r }}
                    </span>
                  </div>
                </div>
                <div class="flex shrink-0 items-center gap-2">
                  <button
                    type="button"
                    class="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
                    :class="isPinnedFile(zone.filePath) ? 'text-primary' : ''"
                    :title="isPinnedFile(zone.filePath) ? t('onboardingPanel.unpin') : t('onboardingPanel.pin')"
                    @click.stop="toggleFilePin(zone.filePath)"
                  >
                    <PinOff v-if="isPinnedFile(zone.filePath)" class="h-3.5 w-3.5" />
                    <Pin v-else class="h-3.5 w-3.5" />
                  </button>
                  <Button variant="ghost" size="sm" @click="openInDrawer(zone.entityId)">
                    {{ t('onboardingPanel.firstIssue.open') }}
                  </Button>
                  <Button variant="outline" size="sm" @click="askAboutFile(zone.filePath)">
                    {{ t('onboardingPanel.firstIssue.ask') }}
                  </Button>
                </div>
              </div>
            </li>
          </ul>
        </section>

        <!-- Setup guide -->
        <section>
          <h3 class="mb-2 flex items-center gap-2 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
            <Terminal class="h-4 w-4" />
            {{ t('onboardingPanel.setup.title') }}
          </h3>
          <p class="mb-3 text-xs text-muted-foreground">
            {{ t('onboardingPanel.setup.hint') }}
          </p>
          <div v-if="setupPending" class="rounded border border-dashed border-border px-3 py-4 text-center text-xs text-muted-foreground">
            {{ t('onboardingPanel.setup.loading') }}
          </div>
          <div v-else-if="!setupData || setupData.steps.length === 0" class="rounded border border-dashed border-border px-3 py-4 text-center text-xs text-muted-foreground">
            {{ t('onboardingPanel.setup.empty') }}
          </div>
          <ol v-else class="space-y-2">
            <li
              v-for="(step, i) in setupData.steps"
              :key="step.label + i"
              class="rounded border border-border bg-background/50 px-3 py-2"
            >
              <div class="flex items-baseline justify-between gap-2">
                <span class="text-xs font-medium">
                  <span class="text-muted-foreground">{{ i + 1 }}.</span>
                  {{ step.label }}
                </span>
                <span class="font-mono text-[10px] text-muted-foreground">{{ step.source }}</span>
              </div>
              <div v-if="step.command" class="mt-1.5 flex items-center gap-2">
                <code class="flex-1 truncate rounded bg-muted px-2 py-1 font-mono text-xs">{{ step.command }}</code>
                <button
                  type="button"
                  class="shrink-0 rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
                  :title="t('onboardingPanel.setup.copy')"
                  @click="copyCommand(step.command)"
                >
                  <Check v-if="copiedCmd === step.command" class="h-3 w-3 text-emerald-500" />
                  <Copy v-else class="h-3 w-3" />
                </button>
              </div>
            </li>
          </ol>
          <details
            v-if="setupData && setupData.readmeQuickStart"
            class="mt-3 rounded border border-border bg-background/30 px-3 py-2 text-xs"
          >
            <summary class="cursor-pointer text-muted-foreground">
              {{ t('onboardingPanel.setup.readme') }}
            </summary>
            <pre class="mt-2 whitespace-pre-wrap text-[11px] leading-relaxed">{{ setupData.readmeQuickStart }}</pre>
          </details>
        </section>

        <!-- GitHub Issues -->
        <section>
          <h3 class="mb-2 flex items-center gap-2 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
            <Github class="h-4 w-4" />
            {{ t('onboardingPanel.issues.title') }}
          </h3>
          <p class="mb-3 text-xs text-muted-foreground">
            {{ t('onboardingPanel.issues.hint') }}
          </p>
          <div v-if="issuesPending" class="rounded border border-dashed border-border px-3 py-4 text-center text-xs text-muted-foreground">
            {{ t('onboardingPanel.issues.loading') }}
          </div>
          <div v-else-if="!issuesData || issuesData.issues.length === 0" class="rounded border border-dashed border-border px-3 py-4 text-center text-xs text-muted-foreground">
            <span v-if="issuesData?.reason === 'rate_limited'">{{ t('onboardingPanel.issues.rateLimited') }}</span>
            <span v-else-if="issuesData?.reason === 'not_github'">{{ t('onboardingPanel.issues.notGithub') }}</span>
            <span v-else-if="issuesData?.reason === 'repo_not_found'">{{ t('onboardingPanel.issues.notFound') }}</span>
            <span v-else-if="issuesData?.reason === 'fetch_failed'">{{ t('onboardingPanel.issues.error') }}</span>
            <span v-else>{{ t('onboardingPanel.issues.empty') }}</span>
          </div>
          <ul v-else class="space-y-2">
            <li
              v-for="issue in issuesData.issues"
              :key="issue.number"
              class="rounded border border-border bg-background/50 px-3 py-2"
            >
              <div class="flex items-start justify-between gap-2">
                <div class="min-w-0 flex-1">
                  <div class="flex items-center gap-2">
                    <span
                      class="rounded px-1.5 py-0.5 text-[10px] uppercase tracking-wide"
                      :class="{
                        'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300': issue.difficulty === 'easy',
                        'bg-amber-500/15 text-amber-700 dark:text-amber-300': issue.difficulty === 'medium',
                        'bg-rose-500/15 text-rose-700 dark:text-rose-300': issue.difficulty === 'hard',
                      }"
                    >
                      {{ t('onboardingPanel.issues.difficulty.' + issue.difficulty) }}
                    </span>
                    <a
                      :href="issue.url"
                      target="_blank"
                      rel="noopener"
                      class="truncate text-sm font-medium hover:underline"
                    >
                      #{{ issue.number }} {{ issue.title }}
                      <ExternalLink class="ml-0.5 inline h-3 w-3 text-muted-foreground" />
                    </a>
                  </div>
                  <p v-if="issue.bodyExcerpt" class="mt-1 line-clamp-2 text-[11px] text-muted-foreground">
                    {{ issue.bodyExcerpt }}
                  </p>
                  <div v-if="issue.relatedEntities.length" class="mt-1 flex flex-wrap gap-1">
                    <button
                      v-for="ent in issue.relatedEntities"
                      :key="ent.entityId"
                      type="button"
                      class="rounded bg-accent/60 px-1.5 py-0.5 font-mono text-[10px] hover:bg-accent"
                      :title="ent.filePath ?? ent.type"
                      @click="openInDrawer(ent.entityId)"
                    >
                      {{ ent.name }}
                    </button>
                  </div>
                </div>
                <div class="flex shrink-0 items-center gap-2">
                  <button
                    type="button"
                    class="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
                    :class="isPinnedIssue(issue.number) ? 'text-primary' : ''"
                    :title="isPinnedIssue(issue.number) ? t('onboardingPanel.unpin') : t('onboardingPanel.pin')"
                    @click.stop="toggleIssuePin(issue.number)"
                  >
                    <PinOff v-if="isPinnedIssue(issue.number)" class="h-3.5 w-3.5" />
                    <Pin v-else class="h-3.5 w-3.5" />
                  </button>
                  <Button variant="outline" size="sm" @click="askAboutIssue(issue)">
                    {{ t('onboardingPanel.issues.ask') }}
                  </Button>
                </div>
              </div>
            </li>
          </ul>
        </section>
      </div>

      <div class="mt-6 flex items-center justify-between text-xs text-muted-foreground">
        <span>{{ t('onboardingPanel.footer') }}</span>
        <Button variant="ghost" size="sm" @click="close">
          {{ t('onboardingPanel.dismiss') }}
        </Button>
      </div>
    </div>
  </div>
</template>
