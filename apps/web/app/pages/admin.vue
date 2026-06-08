<script setup lang="ts">
import { Users, FolderOpen, DollarSign, FileClock, Trash2 } from 'lucide-vue-next'

definePageMeta({ middleware: ['admin'] })

const { t } = useI18n()

interface Overview {
  counts: {
    user_count: number
    workspace_count: number
    ready_count: number
    public_count: number
    active_30d: number
    cost_cents_today: number
    cost_cents_7d: number
  } | null
  costToday: number
  costCapUsd: number
}
interface UserRow {
  id: string
  github_login: string
  email: string | null
  avatar_url: string | null
  created_at: string
  workspace_count: number
  messages_30d: number
  has_byok: boolean
}
interface WorkspaceRow {
  id: string
  name: string
  source_url: string | null
  owner_login: string | null
  status: string
  is_public: boolean
  last_indexed_at: string | null
  created_at: string
  cost_cents: number
}
interface AuditEvt {
  id: string
  userId: string | null
  actorLogin: string | null
  action: string
  targetType: string | null
  targetId: string | null
  metadata: Record<string, unknown>
  ip: string | null
  at: string
}
interface InterestRow {
  id: string
  kind: string
  message: string | null
  created_at: string
  github_login: string
  email: string | null
}

const tab = ref<'overview' | 'users' | 'workspaces' | 'audit' | 'interest'>('overview')

const { data: overview, refresh: refreshOverview } = await useApiFetch<Overview>('/api/admin/overview')
const { data: usersData } = await useApiFetch<{ users: UserRow[] }>('/api/admin/users')
const { data: wsData, refresh: refreshWs } = await useApiFetch<{ workspaces: WorkspaceRow[] }>('/api/admin/workspaces')
const { data: auditData } = await useApiFetch<{ events: AuditEvt[] }>('/api/admin/audit')
const { data: interestData } = await useApiFetch<{ pings: InterestRow[]; total: number }>('/api/admin/interest')

const selected = ref<Set<string>>(new Set())
function toggle(id: string): void {
  if (selected.value.has(id)) selected.value.delete(id)
  else selected.value.add(id)
  // Trigger reactivity via reassignment.
  selected.value = new Set(selected.value)
}

async function bulkDelete(): Promise<void> {
  if (selected.value.size === 0) return
  const ok = await useConfirm().ask({
    title: t('admin.bulkDeleteConfirm', { n: selected.value.size }),
    body: t('admin.bulkDeleteBody'),
    confirmLabel: t('admin.workspaces.bulkDelete', { n: selected.value.size }),
    destructive: true,
  })
  if (!ok) return
  try {
    await useApi()(
      '/api/admin/bulk-delete',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ids: [...selected.value] }),
      },
    )
    useToast().success(t('admin.bulkDeleteDone', { n: selected.value.size }))
    selected.value = new Set()
    await Promise.all([refreshWs(), refreshOverview()])
  } catch (err) {
    useToast().error(err instanceof Error ? err.message : 'Failed')
  }
}

const costRatio = computed(() => {
  if (!overview.value || overview.value.costCapUsd <= 0) return 0
  return Math.min(1, overview.value.costToday / overview.value.costCapUsd)
})

function formatDate(iso: string): string {
  try { return new Date(iso).toLocaleString() } catch { return iso }
}
function formatUsd(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`
}

useHead(() => ({
  title: () => `${t('admin.title')} — RepoBuddy`,
  meta: [{ name: 'robots', content: 'noindex, nofollow' }],
}))
</script>

<template>
  <div class="space-y-6">
    <header class="space-y-1">
      <h1 class="text-2xl font-bold">
        {{ t('admin.title') }}
      </h1>
      <p class="text-sm text-muted-foreground">
        {{ t('admin.subtitle') }}
      </p>
    </header>

    <!-- Overview cards -->
    <section v-if="overview?.counts" class="grid grid-cols-2 gap-3 sm:grid-cols-4">
      <div class="rounded-lg border border-violet-500/20 bg-violet-500/5 p-3">
        <div class="flex items-center gap-1.5 text-[11px] uppercase tracking-wide text-violet-700 dark:text-violet-300">
          <Users class="h-3 w-3" />
          {{ t('admin.cards.users') }}
        </div>
        <div class="text-2xl font-semibold text-violet-700 dark:text-violet-200">
          {{ overview.counts.user_count }}
        </div>
        <p class="text-[11px] text-muted-foreground">
          {{ t('admin.cards.active30d', { n: overview.counts.active_30d }) }}
        </p>
      </div>
      <div class="rounded-lg border border-sky-500/20 bg-sky-500/5 p-3">
        <div class="flex items-center gap-1.5 text-[11px] uppercase tracking-wide text-sky-700 dark:text-sky-300">
          <FolderOpen class="h-3 w-3" />
          {{ t('admin.cards.workspaces') }}
        </div>
        <div class="text-2xl font-semibold text-sky-700 dark:text-sky-200">
          {{ overview.counts.workspace_count }}
        </div>
        <p class="text-[11px] text-muted-foreground">
          {{ overview.counts.ready_count }} ready · {{ overview.counts.public_count }} public
        </p>
      </div>
      <div class="rounded-lg border border-amber-500/20 bg-amber-500/5 p-3">
        <div class="flex items-center gap-1.5 text-[11px] uppercase tracking-wide text-amber-700 dark:text-amber-300">
          <DollarSign class="h-3 w-3" />
          {{ t('admin.cards.todaySpend') }}
        </div>
        <div class="text-2xl font-semibold tabular-nums text-amber-700 dark:text-amber-200">
          ${{ overview.costToday.toFixed(2) }}
        </div>
        <div class="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-muted">
          <div
            class="h-full transition-all"
            :class="costRatio < 0.8 ? 'bg-emerald-500' : costRatio < 1 ? 'bg-amber-500' : 'bg-destructive'"
            :style="{ width: `${Math.round(costRatio * 100)}%` }"
          />
        </div>
        <p class="text-[11px] text-muted-foreground">
          {{ t('admin.cards.cap', { cap: overview.costCapUsd.toFixed(2) }) }}
        </p>
      </div>
      <div class="rounded-lg border border-emerald-500/20 bg-emerald-500/5 p-3">
        <div class="flex items-center gap-1.5 text-[11px] uppercase tracking-wide text-emerald-700 dark:text-emerald-300">
          <DollarSign class="h-3 w-3" />
          {{ t('admin.cards.weekSpend') }}
        </div>
        <div class="text-2xl font-semibold tabular-nums text-emerald-700 dark:text-emerald-200">
          {{ formatUsd(overview.counts.cost_cents_7d) }}
        </div>
        <p class="text-[11px] text-muted-foreground">
          {{ t('admin.cards.weekHint') }}
        </p>
      </div>
    </section>

    <!-- Tabs -->
    <div class="flex flex-wrap gap-1 border-b border-border">
      <button
        v-for="t_ in ['overview', 'users', 'workspaces', 'audit', 'interest'] as const"
        :key="t_"
        type="button"
        class="border-b-2 px-3 py-2 text-sm font-medium transition"
        :class="tab === t_ ? 'border-primary text-primary' : 'border-transparent text-muted-foreground hover:text-foreground'"
        @click="tab = t_"
      >
        {{ t(`admin.tabs.${t_}`) }}
        <span
          v-if="t_ === 'interest' && interestData?.total"
          class="ml-1 rounded-full bg-amber-500/20 px-1.5 py-0.5 text-[10px] font-semibold text-amber-700 dark:text-amber-300"
        >{{ interestData.total }}</span>
      </button>
    </div>

    <!-- Overview tab — links to dashboards -->
    <section v-if="tab === 'overview'" class="space-y-3 rounded-lg border border-border bg-card p-4 text-sm">
      <p>{{ t('admin.overview.intro') }}</p>
      <ul class="space-y-1 text-muted-foreground">
        <li>
          <a href="http://localhost:3301" target="_blank" class="text-primary underline-offset-2 hover:underline">
            Grafana →
          </a> {{ t('admin.overview.grafanaHint') }}
        </li>
        <li>
          <a href="/api/health" target="_blank" class="text-primary underline-offset-2 hover:underline">
            /api/health
          </a> · <a href="/api/metrics" target="_blank" class="text-primary underline-offset-2 hover:underline">/api/metrics</a>
        </li>
      </ul>
    </section>

    <!-- Users tab -->
    <section v-else-if="tab === 'users'" class="overflow-x-auto rounded-lg border border-border bg-card">
      <table class="w-full text-sm">
        <thead class="border-b border-border bg-muted/30 text-left text-xs uppercase tracking-wide text-muted-foreground">
          <tr>
            <th class="px-3 py-2">{{ t('admin.users.login') }}</th>
            <th class="px-3 py-2">{{ t('admin.users.email') }}</th>
            <th class="px-3 py-2 text-right">{{ t('admin.users.ws') }}</th>
            <th class="px-3 py-2 text-right">{{ t('admin.users.msgs30d') }}</th>
            <th class="px-3 py-2">{{ t('admin.users.byok') }}</th>
            <th class="px-3 py-2">{{ t('admin.users.created') }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="u in usersData?.users ?? []" :key="u.id" class="border-b border-border last:border-0 hover:bg-muted/20">
            <td class="px-3 py-2 font-medium">@{{ u.github_login }}</td>
            <td class="px-3 py-2 text-muted-foreground">{{ u.email ?? '—' }}</td>
            <td class="px-3 py-2 text-right tabular-nums">{{ u.workspace_count }}</td>
            <td class="px-3 py-2 text-right tabular-nums">{{ u.messages_30d }}</td>
            <td class="px-3 py-2">
              <span v-if="u.has_byok" class="rounded-full bg-emerald-500/15 px-2 py-0.5 text-[10px] font-medium text-emerald-700 dark:text-emerald-300">BYOK</span>
              <span v-else class="text-muted-foreground text-xs">—</span>
            </td>
            <td class="px-3 py-2 text-muted-foreground">{{ formatDate(u.created_at) }}</td>
          </tr>
        </tbody>
      </table>
    </section>

    <!-- Workspaces tab -->
    <section v-else-if="tab === 'workspaces'" class="space-y-2">
      <div class="flex items-center justify-between">
        <p class="text-xs text-muted-foreground">
          {{ t('admin.workspaces.selectedCount', { n: selected.size }) }}
        </p>
        <Button
          v-if="selected.size > 0"
          size="sm"
          variant="default"
          class="bg-destructive text-destructive-foreground hover:bg-destructive/90"
          @click="bulkDelete"
        >
          <Trash2 class="mr-1 h-3 w-3" />
          {{ t('admin.workspaces.bulkDelete', { n: selected.size }) }}
        </Button>
      </div>
      <div class="overflow-x-auto rounded-lg border border-border bg-card">
        <table class="w-full text-sm">
          <thead class="border-b border-border bg-muted/30 text-left text-xs uppercase tracking-wide text-muted-foreground">
            <tr>
              <th class="w-8 px-3 py-2" />
              <th class="px-3 py-2">{{ t('admin.workspaces.name') }}</th>
              <th class="px-3 py-2">{{ t('admin.workspaces.owner') }}</th>
              <th class="px-3 py-2">{{ t('admin.workspaces.status') }}</th>
              <th class="px-3 py-2 text-right">{{ t('admin.workspaces.cost') }}</th>
              <th class="px-3 py-2">{{ t('admin.workspaces.public') }}</th>
              <th class="px-3 py-2">{{ t('admin.workspaces.lastIndexed') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="w in wsData?.workspaces ?? []" :key="w.id" class="border-b border-border last:border-0 hover:bg-muted/20">
              <td class="px-3 py-2">
                <input type="checkbox" :checked="selected.has(w.id)" @change="toggle(w.id)">
              </td>
              <td class="px-3 py-2">
                <NuxtLink :to="`/w/${w.id}`" class="font-medium text-primary hover:underline">
                  {{ w.name }}
                </NuxtLink>
                <a v-if="w.source_url" :href="w.source_url" target="_blank" class="ml-1 text-xs text-muted-foreground hover:underline">↗</a>
              </td>
              <td class="px-3 py-2 text-muted-foreground">@{{ w.owner_login ?? '—' }}</td>
              <td class="px-3 py-2">
                <span
                  class="rounded-full px-2 py-0.5 text-[10px] font-medium"
                  :class="w.status === 'ready'
                    ? 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300'
                    : w.status === 'failed'
                      ? 'bg-destructive/15 text-destructive'
                      : 'bg-muted text-muted-foreground'"
                >
                  {{ w.status }}
                </span>
              </td>
              <td class="px-3 py-2 text-right tabular-nums">{{ formatUsd(w.cost_cents) }}</td>
              <td class="px-3 py-2">
                <span v-if="w.is_public" class="text-emerald-700 dark:text-emerald-300">✓</span>
                <span v-else class="text-muted-foreground">—</span>
              </td>
              <td class="px-3 py-2 text-muted-foreground">{{ w.last_indexed_at ? formatDate(w.last_indexed_at) : '—' }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>

    <!-- Interest tab -->
    <section v-else-if="tab === 'interest'" class="space-y-2">
      <p v-if="!interestData?.pings.length" class="rounded-lg border border-border bg-card p-4 text-sm text-muted-foreground">
        {{ t('admin.interest.empty') }}
      </p>
      <div v-else class="overflow-x-auto rounded-lg border border-border bg-card">
        <table class="w-full text-sm">
          <thead class="border-b border-border bg-muted/30 text-left text-xs uppercase tracking-wide text-muted-foreground">
            <tr>
              <th class="px-3 py-2">{{ t('admin.interest.when') }}</th>
              <th class="px-3 py-2">{{ t('admin.interest.user') }}</th>
              <th class="px-3 py-2">{{ t('admin.interest.kind') }}</th>
              <th class="px-3 py-2">{{ t('admin.interest.message') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="p in interestData.pings" :key="p.id" class="border-b border-border last:border-0 hover:bg-muted/20">
              <td class="px-3 py-2 text-muted-foreground tabular-nums">{{ formatDate(p.created_at) }}</td>
              <td class="px-3 py-2">
                @{{ p.github_login }}
                <span v-if="p.email" class="ml-1 text-xs text-muted-foreground">({{ p.email }})</span>
              </td>
              <td class="px-3 py-2">
                <code class="rounded bg-amber-500/15 px-1.5 py-0.5 text-[11px] text-amber-700 dark:text-amber-300">{{ p.kind }}</code>
              </td>
              <td class="max-w-md px-3 py-2 text-muted-foreground">
                {{ p.message || '—' }}
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>

    <!-- Audit tab -->
    <section v-else-if="tab === 'audit'" class="overflow-x-auto rounded-lg border border-border bg-card">
      <table class="w-full text-sm">
        <thead class="border-b border-border bg-muted/30 text-left text-xs uppercase tracking-wide text-muted-foreground">
          <tr>
            <th class="px-3 py-2">{{ t('admin.audit.when') }}</th>
            <th class="px-3 py-2">{{ t('admin.audit.actor') }}</th>
            <th class="px-3 py-2">{{ t('admin.audit.action') }}</th>
            <th class="px-3 py-2">{{ t('admin.audit.target') }}</th>
            <th class="px-3 py-2">{{ t('admin.audit.ip') }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="e in auditData?.events ?? []" :key="e.id" class="border-b border-border last:border-0 hover:bg-muted/20">
            <td class="px-3 py-2 text-muted-foreground tabular-nums">{{ formatDate(e.at) }}</td>
            <td class="px-3 py-2">{{ e.actorLogin ? '@' + e.actorLogin : '—' }}</td>
            <td class="px-3 py-2">
              <code class="rounded bg-muted px-1.5 py-0.5 text-[11px]">{{ e.action }}</code>
            </td>
            <td class="px-3 py-2 text-muted-foreground">
              <span v-if="e.targetType">{{ e.targetType }}:</span>
              <code v-if="e.targetId" class="ml-1 text-[10px]">{{ e.targetId.slice(0, 8) }}</code>
            </td>
            <td class="px-3 py-2 text-muted-foreground tabular-nums">{{ e.ip ?? '—' }}</td>
          </tr>
        </tbody>
      </table>
    </section>
    <FileClock v-if="false" />
  </div>
</template>
