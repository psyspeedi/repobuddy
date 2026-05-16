<script setup lang="ts">
import { Button } from '@/components/ui/button'

interface Props {
  workspaceId: string
  entityId: string
}
const props = defineProps<Props>()
defineEmits<{
  (e: 'close'): void
  (e: 'focus', id: string): void
}>()

const router = useRouter()

async function askAboutEntity(): Promise<void> {
  const e = detail.value?.entity
  if (!e) return
  const ref = `[entity:${e.id}]`
  const subject = e.qualifiedName ?? e.name
  const question = `Расскажи подробно про ${subject} ${ref}.`
  await router.push({
    path: `/w/${props.workspaceId}`,
    query: { ask: question },
  })
}

interface NeighborEntity {
  id: string
  name: string
  type: string
  qualifiedName: string | null
  filePath: string | null
}

interface DetailResponse {
  entity: {
    id: string
    type: string
    name: string
    qualifiedName: string | null
    language: string | null
    filePath: string | null
    startLine: number | null
    endLine: number | null
    signature: string | null
    description: string | null
    metadata: Record<string, unknown> | null
  }
  incoming: { id: string; type: string; entity: NeighborEntity }[]
  outgoing: { id: string; type: string; entity: NeighborEntity }[]
  filesChanged: { id: string | null; path: string }[] | null
  linkedChunks: {
    id: string
    filePath: string | null
    startLine: number | null
    endLine: number | null
    sourceType: string
  }[]
  counts: { incoming: number; outgoing: number }
}

const detail = ref<DetailResponse | null>(null)
const loading = ref(false)
const error = ref<string | null>(null)

async function load(): Promise<void> {
  if (!props.entityId) return
  loading.value = true
  error.value = null
  try {
    detail.value = await $fetch<DetailResponse>(
      `/api/workspaces/${props.workspaceId}/entity/${props.entityId}`,
    )
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err)
  } finally {
    loading.value = false
  }
}

watch(() => props.entityId, () => void load(), { immediate: true })

function formatDate(iso: string): string {
  try {
    const d = new Date(iso)
    return d.toLocaleString()
  } catch {
    return iso
  }
}

const commitMeta = computed(() => {
  const e = detail.value?.entity
  if (!e || e.type !== 'commit') return null
  const m = (e.metadata ?? {}) as {
    sha?: string
    author?: string
    email?: string
    date?: string
    message?: string
  }
  return m
})
const hotness = computed(() => {
  const m = (detail.value?.entity.metadata ?? {}) as { hotness?: number }
  return typeof m.hotness === 'number' ? m.hotness : null
})
</script>

<template>
  <aside class="flex h-full w-80 shrink-0 flex-col overflow-hidden rounded-lg border border-border bg-card">
    <header class="flex items-start justify-between gap-2 border-b border-border p-3">
      <div class="min-w-0 flex-1">
        <p class="break-all text-sm font-semibold">
          {{ detail?.entity.name ?? 'Loading…' }}
        </p>
        <p v-if="detail?.entity.type" class="text-xs uppercase tracking-wide text-muted-foreground">
          {{ detail.entity.type }}
          <span v-if="detail.entity.language"> · {{ detail.entity.language }}</span>
        </p>
      </div>
      <div class="flex items-center gap-1">
        <Button
          v-if="detail?.entity"
          variant="outline"
          size="sm"
          title="Open the chat with a prefilled question about this entity"
          @click="askAboutEntity"
        >
          Ask AI
        </Button>
        <Button variant="ghost" size="sm" @click="$emit('close')">
          ×
        </Button>
      </div>
    </header>

    <div class="flex-1 space-y-3 overflow-y-auto p-3 text-xs">
      <div v-if="loading">
        Loading…
      </div>
      <p v-else-if="error" class="text-destructive">
        {{ error }}
      </p>

      <template v-else-if="detail">
        <!-- File path / location -->
        <section v-if="detail.entity.filePath">
          <p class="break-all font-mono">
            {{ detail.entity.filePath }}<span v-if="detail.entity.startLine">:{{ detail.entity.startLine }}-{{ detail.entity.endLine }}</span>
          </p>
        </section>
        <section v-if="detail.entity.qualifiedName" class="break-all text-muted-foreground">
          {{ detail.entity.qualifiedName }}
        </section>

        <!-- Description (LLM-generated) -->
        <section v-if="detail.entity.description">
          <h4 class="mb-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
            Description
          </h4>
          <p class="leading-relaxed">
            {{ detail.entity.description }}
          </p>
        </section>

        <!-- Signature for functions/classes -->
        <section v-if="detail.entity.signature">
          <h4 class="mb-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
            Signature
          </h4>
          <pre class="overflow-x-auto rounded bg-muted p-2 text-[11px]">{{ detail.entity.signature }}</pre>
        </section>

        <!-- Commit-specific block -->
        <section v-if="commitMeta">
          <h4 class="mb-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
            Commit
          </h4>
          <dl class="space-y-1">
            <div v-if="commitMeta.sha" class="flex gap-1">
              <dt class="text-muted-foreground">
                sha:
              </dt>
              <dd class="break-all font-mono">
                {{ commitMeta.sha.slice(0, 12) }}
              </dd>
            </div>
            <div v-if="commitMeta.author">
              <dt class="text-muted-foreground">
                author:
              </dt>
              <dd>{{ commitMeta.author }} <span v-if="commitMeta.email" class="text-muted-foreground">&lt;{{ commitMeta.email }}&gt;</span></dd>
            </div>
            <div v-if="commitMeta.date">
              <dt class="text-muted-foreground">
                date:
              </dt>
              <dd>{{ formatDate(commitMeta.date) }}</dd>
            </div>
            <div v-if="commitMeta.message">
              <dt class="text-muted-foreground">
                message:
              </dt>
              <dd class="whitespace-pre-wrap">
                {{ commitMeta.message }}
              </dd>
            </div>
          </dl>
        </section>

        <!-- Hotness for files -->
        <section v-if="hotness !== null">
          <h4 class="mb-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
            Hotness
          </h4>
          <p>{{ hotness }} modification(s) in the last 90 days</p>
        </section>

        <!-- Files changed list (commits) -->
        <section v-if="detail.filesChanged && detail.filesChanged.length > 0">
          <h4 class="mb-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
            Files changed ({{ detail.filesChanged.length }})
          </h4>
          <ul class="space-y-0.5">
            <li
              v-for="f in detail.filesChanged.slice(0, 30)"
              :key="f.path"
              class="break-all"
            >
              <button
                v-if="f.id"
                type="button"
                class="cursor-pointer text-left font-mono hover:text-primary hover:underline"
                @click="$emit('focus', f.id!)"
              >
                {{ f.path }}
              </button>
              <span v-else class="font-mono text-muted-foreground">{{ f.path }}</span>
            </li>
            <li v-if="detail.filesChanged.length > 30" class="text-muted-foreground">
              + {{ detail.filesChanged.length - 30 }} more
            </li>
          </ul>
        </section>

        <!-- Outgoing relations -->
        <section v-if="detail.outgoing.length > 0">
          <h4 class="mb-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
            → Outgoing ({{ detail.outgoing.length }})
          </h4>
          <ul class="space-y-0.5">
            <li v-for="rel in detail.outgoing.slice(0, 40)" :key="rel.id">
              <button
                type="button"
                class="block w-full cursor-pointer text-left hover:text-primary"
                @click="$emit('focus', rel.entity.id)"
              >
                <span class="text-muted-foreground">{{ rel.type }}</span>
                <span class="mx-1">→</span>
                <span class="font-medium">{{ rel.entity.name }}</span>
                <span class="ml-1 text-muted-foreground">({{ rel.entity.type }})</span>
              </button>
            </li>
            <li v-if="detail.outgoing.length > 40" class="text-muted-foreground">
              + {{ detail.outgoing.length - 40 }} more
            </li>
          </ul>
        </section>

        <!-- Incoming relations -->
        <section v-if="detail.incoming.length > 0">
          <h4 class="mb-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
            ← Incoming ({{ detail.incoming.length }})
          </h4>
          <ul class="space-y-0.5">
            <li v-for="rel in detail.incoming.slice(0, 40)" :key="rel.id">
              <button
                type="button"
                class="block w-full cursor-pointer text-left hover:text-primary"
                @click="$emit('focus', rel.entity.id)"
              >
                <span class="font-medium">{{ rel.entity.name }}</span>
                <span class="ml-1 text-muted-foreground">({{ rel.entity.type }})</span>
                <span class="mx-1">→</span>
                <span class="text-muted-foreground">{{ rel.type }}</span>
              </button>
            </li>
            <li v-if="detail.incoming.length > 40" class="text-muted-foreground">
              + {{ detail.incoming.length - 40 }} more
            </li>
          </ul>
        </section>
      </template>
    </div>
  </aside>
</template>
