<script setup lang="ts">
import { computed } from 'vue'
import { CheckCircle2, GitPullRequest, GitPullRequestDraft, AlertTriangle, Copy as CopyIcon, ExternalLink } from 'lucide-vue-next'
import type { ResolutionEnvelope } from '#shared/schemas/resolution'

interface Props {
  resolution: ResolutionEnvelope
}
const props = defineProps<Props>()
const { t, locale } = useI18n()

/**
 * Pick a single "primary" item to highlight: for merged → newest
 * commit; for *_pr → the relevant PR; for duplicate_closed / related
 * → the top-similarity duplicate. The full envelope is still
 * available below the headline (collapsible disabled — keep this
 * surface focused; details belong in the Reasoning Inspector).
 */
const primaryPr = computed(() => {
  const prs = props.resolution.linkedPullRequests
  const s = props.resolution.status
  if (s === 'open_pr') return prs.find((p) => p.state === 'open' && !p.draft && !p.stale && !p.merged) ?? prs[0] ?? null
  if (s === 'draft_pr') return prs.find((p) => p.draft && !p.merged) ?? prs[0] ?? null
  if (s === 'stale_pr') return prs.find((p) => p.stale && !p.merged) ?? prs[0] ?? null
  return prs[0] ?? null
})

const primaryCommit = computed(() => props.resolution.mergedByCommits[0] ?? null)

const primaryDuplicate = computed(() => {
  const dups = props.resolution.duplicateCandidates
  if (props.resolution.status === 'duplicate_closed') {
    return dups.find((d) => d.state === 'closed' && d.similarity >= 0.85) ?? dups[0] ?? null
  }
  return dups[0] ?? null
})

const tone = computed(() => {
  switch (props.resolution.status) {
    case 'merged':
      return 'emerald'
    case 'open_pr':
      return 'sky'
    case 'draft_pr':
      return 'fuchsia'
    case 'stale_pr':
      return 'amber'
    case 'duplicate_closed':
      return 'violet'
    case 'related':
      return 'slate'
    default:
      return 'slate'
  }
})

/**
 * Tailwind needs full class strings at build time — can't interpolate
 * dynamic colour fragments. Build a per-tone palette object so the
 * template references the literals directly via v-bind.
 */
const palette = computed(() => {
  const t = tone.value
  // Keep classes literal — Tailwind purge scans by string.
  if (t === 'emerald') return {
    bg: 'bg-emerald-500/8 dark:bg-emerald-500/10',
    border: 'border-emerald-500/30',
    accent: 'bg-emerald-500',
    text: 'text-emerald-700 dark:text-emerald-300',
    button: 'border-emerald-500/40 text-emerald-700 dark:text-emerald-300 hover:bg-emerald-500/15',
  }
  if (t === 'sky') return {
    bg: 'bg-sky-500/8 dark:bg-sky-500/10',
    border: 'border-sky-500/30',
    accent: 'bg-sky-500',
    text: 'text-sky-700 dark:text-sky-300',
    button: 'border-sky-500/40 text-sky-700 dark:text-sky-300 hover:bg-sky-500/15',
  }
  if (t === 'fuchsia') return {
    bg: 'bg-fuchsia-500/8 dark:bg-fuchsia-500/10',
    border: 'border-fuchsia-500/30',
    accent: 'bg-fuchsia-500',
    text: 'text-fuchsia-700 dark:text-fuchsia-300',
    button: 'border-fuchsia-500/40 text-fuchsia-700 dark:text-fuchsia-300 hover:bg-fuchsia-500/15',
  }
  if (t === 'amber') return {
    bg: 'bg-amber-500/8 dark:bg-amber-500/10',
    border: 'border-amber-500/30',
    accent: 'bg-amber-500',
    text: 'text-amber-700 dark:text-amber-300',
    button: 'border-amber-500/40 text-amber-700 dark:text-amber-300 hover:bg-amber-500/15',
  }
  if (t === 'violet') return {
    bg: 'bg-violet-500/8 dark:bg-violet-500/10',
    border: 'border-violet-500/30',
    accent: 'bg-violet-500',
    text: 'text-violet-700 dark:text-violet-300',
    button: 'border-violet-500/40 text-violet-700 dark:text-violet-300 hover:bg-violet-500/15',
  }
  return {
    bg: 'bg-slate-500/8 dark:bg-slate-500/10',
    border: 'border-slate-500/30',
    accent: 'bg-slate-500',
    text: 'text-slate-700 dark:text-slate-300',
    button: 'border-slate-500/40 text-slate-700 dark:text-slate-300 hover:bg-slate-500/15',
  }
})

function formatDate(iso: string | null): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleDateString(locale.value === 'ru' ? 'ru-RU' : 'en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  })
}

const headline = computed(() => {
  const s = props.resolution.status
  if (s === 'merged') return t('chat.resolution.mergedTitle')
  if (s === 'open_pr') return t('chat.resolution.openPrTitle')
  if (s === 'draft_pr') return t('chat.resolution.draftPrTitle')
  if (s === 'stale_pr') return t('chat.resolution.stalePrTitle')
  if (s === 'duplicate_closed') return t('chat.resolution.duplicateClosedTitle')
  if (s === 'related') return t('chat.resolution.relatedTitle')
  return ''
})

const detail = computed(() => {
  const s = props.resolution.status
  if (s === 'merged' && primaryCommit.value) {
    return t('chat.resolution.mergedDetail', {
      sha: primaryCommit.value.sha.slice(0, 7),
      author: primaryCommit.value.author,
      date: formatDate(primaryCommit.value.date),
    })
  }
  if ((s === 'open_pr' || s === 'draft_pr' || s === 'stale_pr') && primaryPr.value) {
    const key
      = s === 'open_pr' ? 'chat.resolution.openPrDetail'
      : s === 'draft_pr' ? 'chat.resolution.draftPrDetail'
      : 'chat.resolution.stalePrDetail'
    return t(key, {
      n: primaryPr.value.number,
      author: primaryPr.value.author ?? '—',
      date: formatDate(primaryPr.value.lastCommitAt),
    })
  }
  if ((s === 'duplicate_closed' || s === 'related') && primaryDuplicate.value) {
    const key = s === 'duplicate_closed'
      ? 'chat.resolution.duplicateClosedDetail'
      : 'chat.resolution.relatedDetail'
    return t(key, {
      n: primaryDuplicate.value.number,
      pct: Math.round(primaryDuplicate.value.similarity * 100),
    })
  }
  return ''
})

const ctaUrl = computed(() => {
  if (primaryCommit.value && props.resolution.status === 'merged') return null
  if (primaryPr.value && (props.resolution.status === 'open_pr' || props.resolution.status === 'draft_pr' || props.resolution.status === 'stale_pr')) {
    return primaryPr.value.url
  }
  if (primaryDuplicate.value && (props.resolution.status === 'duplicate_closed' || props.resolution.status === 'related')) {
    return primaryDuplicate.value.url
  }
  return null
})

const ctaLabel = computed(() => {
  const s = props.resolution.status
  if (s === 'open_pr' || s === 'draft_pr' || s === 'stale_pr') return t('chat.resolution.viewPr')
  if (s === 'duplicate_closed' || s === 'related') return t('chat.resolution.viewIssue')
  return t('chat.resolution.openOnGitHub')
})

const shouldRender = computed(() => {
  const s = props.resolution.status
  // 'none' = nothing useful detected — keep the chat surface clean.
  return s !== 'none'
})
</script>

<template>
  <div
    v-if="shouldRender"
    class="mb-2 flex items-stretch gap-0 overflow-hidden rounded-md border"
    :class="[palette.bg, palette.border]"
    role="note"
  >
    <div class="w-1 shrink-0" :class="palette.accent" />
    <div class="flex flex-1 items-start gap-3 px-3 py-2.5">
      <div class="mt-0.5 shrink-0" :class="palette.text">
        <CheckCircle2 v-if="resolution.status === 'merged'" class="h-5 w-5" />
        <GitPullRequest v-else-if="resolution.status === 'open_pr'" class="h-5 w-5" />
        <GitPullRequestDraft v-else-if="resolution.status === 'draft_pr'" class="h-5 w-5" />
        <AlertTriangle v-else-if="resolution.status === 'stale_pr'" class="h-5 w-5" />
        <CopyIcon v-else class="h-5 w-5" />
      </div>
      <div class="min-w-0 flex-1">
        <div class="text-sm font-semibold" :class="palette.text">
          {{ headline }}
        </div>
        <div class="mt-0.5 text-xs leading-relaxed text-foreground/80">
          {{ detail }}
        </div>
      </div>
      <a
        v-if="ctaUrl"
        :href="ctaUrl"
        target="_blank"
        rel="noopener noreferrer"
        class="mt-0.5 inline-flex shrink-0 items-center gap-1 rounded-md border px-2 py-1 text-xs font-medium transition"
        :class="palette.button"
      >
        {{ ctaLabel }}
        <ExternalLink class="h-3 w-3" />
      </a>
    </div>
  </div>
</template>
