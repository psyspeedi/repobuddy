<script setup lang="ts">
import { Button } from '@/components/ui/button'

useHead({ title: 'CodeGraph — Workspaces' })

interface Workspace {
  id: string
  name: string
  sourceType: string
  sourceUrl: string | null
  status: string
  languages: string[]
  createdAt: string
  lastIndexedAt: string | null
}

const { data, refresh, pending } = await useFetch<{ workspaces: Workspace[] }>(
  '/api/workspaces',
  { key: 'workspaces-list' },
)

const showCreate = ref(false)
const githubUrl = ref('')
const error = ref<string | null>(null)
const submitting = ref(false)

async function createFromGithub(): Promise<void> {
  error.value = null
  submitting.value = true
  try {
    const res = await $fetch<{ workspace: Workspace }>('/api/workspaces', {
      method: 'POST',
      body: { source: { type: 'github', url: githubUrl.value } },
    })
    showCreate.value = false
    githubUrl.value = ''
    await refresh()
    await navigateTo(`/w/${res.workspace.id}`)
  } catch (e) {
    error.value = e instanceof Error ? e.message : 'Failed to create workspace'
  } finally {
    submitting.value = false
  }
}
</script>

<template>
  <div class="space-y-6">
    <div class="flex items-center justify-between">
      <h1 class="text-2xl font-bold">
        Workspaces
      </h1>
      <Button @click="showCreate = !showCreate">
        {{ showCreate ? 'Cancel' : 'New workspace' }}
      </Button>
    </div>

    <section
      v-if="showCreate"
      class="space-y-3 rounded-lg border border-border bg-card p-6"
    >
      <h2 class="text-sm font-medium uppercase tracking-wide text-muted-foreground">
        From GitHub URL
      </h2>
      <input
        v-model="githubUrl"
        type="url"
        placeholder="https://github.com/owner/repo"
        class="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
        @keyup.enter="createFromGithub"
      >
      <p v-if="error" class="text-sm text-destructive">
        {{ error }}
      </p>
      <Button :disabled="submitting || !githubUrl" @click="createFromGithub">
        {{ submitting ? 'Creating…' : 'Index repository' }}
      </Button>
    </section>

    <div v-if="pending" class="text-sm text-muted-foreground">
      Loading…
    </div>

    <div
      v-else-if="!data?.workspaces.length"
      class="rounded-lg border border-dashed border-border bg-card p-6 text-center"
    >
      <p class="text-sm text-muted-foreground">
        No workspaces yet. Create one from a public GitHub URL above.
      </p>
    </div>

    <ul v-else class="grid gap-3 sm:grid-cols-2">
      <li
        v-for="ws in data.workspaces"
        :key="ws.id"
        class="rounded-lg border border-border bg-card p-4 transition hover:border-primary/50"
      >
        <NuxtLink :to="`/w/${ws.id}`" class="block space-y-1">
          <div class="flex items-center justify-between">
            <h3 class="font-semibold">
              {{ ws.name }}
            </h3>
            <span
              class="rounded-full px-2 py-0.5 text-xs"
              :class="{
                'bg-green-500/15 text-green-700 dark:text-green-400': ws.status === 'ready',
                'bg-yellow-500/15 text-yellow-700 dark:text-yellow-400':
                  ws.status !== 'ready' && ws.status !== 'failed',
                'bg-destructive/15 text-destructive': ws.status === 'failed',
              }"
            >
              {{ ws.status }}
            </span>
          </div>
          <p class="text-xs text-muted-foreground">
            {{ ws.sourceUrl ?? 'uploaded' }}
          </p>
        </NuxtLink>
      </li>
    </ul>
  </div>
</template>
