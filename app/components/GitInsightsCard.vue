<script setup lang="ts">
import { GitCommit, Users, Activity, AlertTriangle, Bug, Sparkles } from 'lucide-vue-next'

interface GitInsights {
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

const props = defineProps<{ insights: GitInsights }>()
const { t, locale } = useI18n()

const relativeLastCommit = computed(() => {
  if (!props.insights.lastCommitAt) return null
  const diff = Date.now() - new Date(props.insights.lastCommitAt).getTime()
  const d = Math.floor(diff / 86_400_000)
  if (d < 1) return t('time.justNow')
  if (d < 30) return t('time.daysAgo', { n: d })
  const months = Math.floor(d / 30)
  if (months < 12) return t('insights.monthsAgo', { n: months })
  const years = Math.floor(d / 365)
  return t('insights.yearsAgo', { n: years })
})

const monthLabelFormatter = computed(() =>
  new Intl.DateTimeFormat(locale.value === 'ru' ? 'ru-RU' : 'en-US', {
    month: 'short',
    year: 'numeric',
  }),
)
function formatMonthLabel(ym: string): string {
  // ym is 'YYYY-MM' (UTC) — render as e.g. "Apr 2026" in the active locale.
  const [y, m] = ym.split('-')
  if (!y || !m) return ym
  const d = new Date(Date.UTC(Number(y), Number(m) - 1, 1))
  return monthLabelFormatter.value.format(d)
}

const sparkline = computed(() => {
  const data = props.insights.commitFrequencyByMonth.slice(-12)
  if (data.length === 0) return []
  const max = Math.max(1, ...data.map((d) => d.commits))
  return data.map((d) => ({
    month: d.month,
    label: formatMonthLabel(d.month),
    commits: d.commits,
    heightPct: Math.max(4, Math.round((d.commits / max) * 100)),
  }))
})

const hoveredBar = ref<number | null>(null)

const fixVsFeatPretty = computed(() => {
  const r = props.insights.fixVsFeatRatio
  if (r === null) return '—'
  return r.toFixed(2)
})

const dateFormatter = computed(() =>
  new Intl.DateTimeFormat(locale.value === 'ru' ? 'ru-RU' : 'en-US', {
    dateStyle: 'medium',
  }),
)
const formattedLastCommit = computed(() => {
  if (!props.insights.lastCommitAt) return ''
  return dateFormatter.value.format(new Date(props.insights.lastCommitAt))
})

const showAll = ref(false)
</script>

<template>
  <section class="space-y-3 rounded-lg border border-border bg-card p-4">
    <header class="flex items-center justify-between">
      <h2 class="text-sm font-medium uppercase tracking-wide text-muted-foreground">
        {{ t('insights.title') }}
      </h2>
      <button
        type="button"
        class="text-xs text-muted-foreground hover:text-foreground"
        @click="showAll = !showAll"
      >
        {{ showAll ? t('insights.showLess') : t('insights.showMore') }}
      </button>
    </header>
    <div v-if="insights.totalCommitsScanned === 0" class="text-sm text-muted-foreground">
      {{ t('insights.noHistory') }}
    </div>
    <div v-else class="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
      <div class="space-y-1 rounded-lg border border-violet-500/20 bg-violet-500/5 p-2.5">
        <div class="flex items-center gap-1.5 text-[10px] uppercase tracking-wide text-violet-700 dark:text-violet-300">
          <GitCommit class="h-3 w-3" />
          {{ t('insights.activity') }}
        </div>
        <div class="text-lg font-semibold leading-none text-violet-700 dark:text-violet-200">
          {{ insights.commitsLast90d }}
        </div>
        <p class="text-[11px] text-muted-foreground">
          {{ t('insights.activityDetail', { n90: insights.commitsLast90d, n30: insights.commitsLast30d }) }}
        </p>
      </div>

      <div class="space-y-1 rounded-lg border border-sky-500/20 bg-sky-500/5 p-2.5">
        <div class="flex items-center gap-1.5 text-[10px] uppercase tracking-wide text-sky-700 dark:text-sky-300">
          <Activity class="h-3 w-3" />
          {{ t('insights.lastCommit') }}
        </div>
        <div class="text-lg font-semibold leading-none text-sky-700 dark:text-sky-200">
          {{ relativeLastCommit ?? '—' }}
        </div>
        <p class="text-[11px] text-muted-foreground" :title="insights.lastCommitAt ?? ''">
          {{ formattedLastCommit }}
        </p>
      </div>

      <div class="space-y-1 rounded-lg border border-emerald-500/20 bg-emerald-500/5 p-2.5">
        <div class="flex items-center gap-1.5 text-[10px] uppercase tracking-wide text-emerald-700 dark:text-emerald-300">
          <Users class="h-3 w-3" />
          {{ t('insights.maintainers') }}
        </div>
        <div class="text-lg font-semibold leading-none text-emerald-700 dark:text-emerald-200">
          {{ insights.activeMaintainers90d }}
        </div>
        <p class="text-[11px] text-muted-foreground">
          {{ t('insights.maintainersDetail', { n: insights.windowDays }) }}
        </p>
      </div>

      <div class="space-y-1 rounded-lg border border-amber-500/20 bg-amber-500/5 p-2.5">
        <div class="flex items-center gap-1.5 text-[10px] uppercase tracking-wide text-amber-700 dark:text-amber-300">
          <AlertTriangle class="h-3 w-3" />
          {{ t('insights.busFactor') }}
        </div>
        <div class="text-lg font-semibold leading-none text-amber-700 dark:text-amber-200">
          {{ insights.busFactor }}
        </div>
        <p class="text-[11px] text-muted-foreground">
          {{ t('insights.busFactorDetail') }}
        </p>
      </div>

      <div class="space-y-1 rounded-lg border border-rose-500/20 bg-rose-500/5 p-2.5">
        <div class="flex items-center gap-1.5 text-[10px] uppercase tracking-wide text-rose-700 dark:text-rose-300">
          <Bug class="h-3 w-3" />
          {{ t('insights.fixFeat') }}
        </div>
        <div class="text-lg font-semibold leading-none text-rose-700 dark:text-rose-200">
          {{ fixVsFeatPretty }}
        </div>
        <p class="text-[11px] text-muted-foreground">
          {{ t('insights.fixFeatDetail', { fix: insights.fixCount, feat: insights.featCount }) }}
        </p>
      </div>

      <div class="space-y-1 rounded-lg border border-fuchsia-500/20 bg-fuchsia-500/5 p-2.5">
        <div class="flex items-center gap-1.5 text-[10px] uppercase tracking-wide text-fuchsia-700 dark:text-fuchsia-300">
          <Sparkles class="h-3 w-3" />
          {{ t('insights.breaking') }}
        </div>
        <div class="text-lg font-semibold leading-none text-fuchsia-700 dark:text-fuchsia-200">
          {{ insights.breakingChangesLast90d }}
        </div>
        <p class="text-[11px] text-muted-foreground">
          {{ t('insights.breakingDetail', { n: insights.windowDays }) }}
        </p>
      </div>
    </div>

    <div v-if="showAll && insights.totalCommitsScanned > 0" class="space-y-3 pt-1">
      <div v-if="sparkline.length > 0" class="space-y-2">
        <div class="flex items-baseline justify-between">
          <div class="text-[10px] uppercase tracking-wide text-muted-foreground">
            {{ t('insights.frequency') }}
          </div>
          <div v-if="hoveredBar !== null && sparkline[hoveredBar]" class="text-[11px] tabular-nums">
            <span class="font-medium">{{ sparkline[hoveredBar]?.label }}</span>
            <span class="text-muted-foreground"> · </span>
            <span class="text-primary">{{ sparkline[hoveredBar]?.commits }} {{ t('insights.commitsShort') }}</span>
          </div>
        </div>
        <div
          class="relative flex h-20 items-end gap-1 rounded-md border border-border/60 bg-background/40 px-2 py-2"
          @mouseleave="hoveredBar = null"
        >
          <div
            v-for="(bar, i) in sparkline"
            :key="i"
            class="group relative flex flex-1 cursor-pointer items-end justify-center"
            @mouseenter="hoveredBar = i"
          >
            <div
              class="w-full rounded-sm bg-gradient-to-t from-primary to-fuchsia-500/70 transition-all duration-150"
              :class="hoveredBar === i ? 'opacity-100 shadow-md shadow-primary/30' : hoveredBar === null ? 'opacity-90' : 'opacity-40'"
              :style="{ height: `${bar.heightPct}%` }"
            />
            <!-- Tooltip — anchored above the bar, follows hoveredBar via the parent's data. -->
            <div
              v-if="hoveredBar === i"
              class="pointer-events-none absolute -top-9 left-1/2 z-10 -translate-x-1/2 whitespace-nowrap rounded-md border border-border bg-card px-2 py-1 text-[10px] shadow-lg"
            >
              <div class="font-medium">
                {{ bar.label }}
              </div>
              <div class="text-muted-foreground">
                {{ bar.commits }} {{ t('insights.commits') }}
              </div>
            </div>
          </div>
        </div>
        <div class="flex justify-between text-[10px] text-muted-foreground">
          <span>{{ sparkline[0]?.label }}</span>
          <span>{{ sparkline[sparkline.length - 1]?.label }}</span>
        </div>
      </div>
      <div v-if="insights.topAuthors.length > 0" class="space-y-1.5">
        <div class="text-[10px] uppercase tracking-wide text-muted-foreground">
          {{ t('insights.topAuthors') }}
        </div>
        <ul class="space-y-0.5 text-xs">
          <li
            v-for="(a, i) in insights.topAuthors"
            :key="a.email + a.name + i"
            class="flex items-center justify-between gap-2"
          >
            <span class="truncate">{{ a.name }}</span>
            <span class="text-muted-foreground">{{ a.commitCount }}</span>
          </li>
        </ul>
      </div>
    </div>
  </section>
</template>
