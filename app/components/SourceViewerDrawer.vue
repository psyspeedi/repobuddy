<script setup lang="ts">
import { codeToHtml } from 'shiki'
import { marked } from 'marked'
import DOMPurify from 'isomorphic-dompurify'
import { Button } from '@/components/ui/button'

interface Props {
  workspaceId: string
  chunkId: string | null
}
const props = defineProps<Props>()
defineEmits<{ (e: 'close'): void }>()

const { t } = useI18n()
const colorMode = useColorMode()

interface ChunkResponse {
  chunk: {
    id: string
    text: string
    sourceType: string
    filePath: string | null
    startLine: number | null
    endLine: number | null
    metadata: { language?: string; kind?: string; sha?: string; shortSha?: string } | null
  }
}

type RenderMode = 'markdown' | 'code' | 'diff'

const data = ref<ChunkResponse | null>(null)
const html = ref<string>('')
const loading = ref(false)
const error = ref<string | null>(null)
const mode = ref<RenderMode>('code')

async function load(): Promise<void> {
  if (!props.chunkId) return
  loading.value = true
  error.value = null
  try {
    data.value = await $fetch<ChunkResponse>(
      `/api/workspaces/${props.workspaceId}/chunk/${props.chunkId}`,
    )
    mode.value = detectMode(data.value.chunk)
    html.value = await renderChunk(data.value.chunk, mode.value)
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err)
  } finally {
    loading.value = false
  }
}

function detectMode(chunk: ChunkResponse['chunk']): RenderMode {
  // Per-commit diff chunks are written with source_type='doc' (to ride the
  // tsvector index) but tagged metadata.kind='diff'. They're not markdown —
  // render them with Shiki's `diff` grammar for proper +/- coloring.
  if (chunk.metadata?.kind === 'diff') return 'diff'
  if (chunk.sourceType === 'doc') return 'markdown'
  if (chunk.filePath && /\.(md|mdx|markdown)$/i.test(chunk.filePath)) return 'markdown'
  return 'code'
}

async function renderChunk(
  chunk: ChunkResponse['chunk'],
  forMode: RenderMode,
): Promise<string> {
  if (forMode === 'markdown') {
    const rendered = marked.parse(chunk.text, { async: false }) as string
    return DOMPurify.sanitize(rendered)
  }
  if (forMode === 'diff') {
    return codeToHtml(chunk.text, {
      lang: 'diff',
      theme: colorMode.value === 'dark' ? 'github-dark' : 'github-light',
    })
  }
  const lang = chunk.metadata?.language ?? 'plaintext'
  return codeToHtml(chunk.text, {
    lang: shikiLang(lang),
    theme: colorMode.value === 'dark' ? 'github-dark' : 'github-light',
  })
}

async function toggleMode(): Promise<void> {
  if (!data.value) return
  // Cycle:
  //   diff → code (same text, no +/- syntax highlighting)
  //   code → diff if metadata.kind='diff', else code → markdown if doc-y
  //   markdown → code
  // Lets users escape diff view when they want to read the raw chunk
  // rather than the per-commit unified diff.
  const isDiffChunk = data.value.chunk.metadata?.kind === 'diff'
  if (mode.value === 'diff') {
    mode.value = 'code'
  } else if (mode.value === 'code' && isDiffChunk) {
    mode.value = 'diff'
  } else {
    mode.value = mode.value === 'markdown' ? 'code' : 'markdown'
  }
  html.value = await renderChunk(data.value.chunk, mode.value)
}

watch(() => props.chunkId, () => void load(), { immediate: true })
watch(() => colorMode.value, () => void load())

function shikiLang(lang: string): string {
  if (lang === 'typescript' || lang === 'javascript' || lang === 'python' || lang === 'go') {
    return lang
  }
  return 'plaintext'
}
</script>

<template>
  <aside class="flex h-full w-full flex-col overflow-hidden rounded-lg border border-border bg-card">
    <header class="flex items-center justify-between gap-2 border-b border-border px-3 py-2">
      <div class="min-w-0 flex-1 text-sm">
        <p v-if="data?.chunk && mode === 'diff'" class="truncate font-mono">
          <span class="rounded bg-pink-500/15 px-1 py-0.5 text-[10px] uppercase tracking-wide text-pink-700 dark:text-pink-300">diff</span>
          <span class="ml-1">{{ data.chunk.filePath }}</span>
          <span v-if="data.chunk.metadata?.shortSha" class="ml-1 text-muted-foreground">@ {{ data.chunk.metadata.shortSha }}</span>
        </p>
        <p v-else-if="data?.chunk" class="truncate font-mono">
          {{ data.chunk.filePath }}
          <span v-if="data.chunk.startLine" class="text-muted-foreground">
            :{{ data.chunk.startLine }}-{{ data.chunk.endLine }}
          </span>
        </p>
        <p v-else class="text-muted-foreground">
          {{ t('viewer.title') }}
        </p>
      </div>
      <Button
        v-if="data?.chunk"
        variant="ghost"
        size="sm"
        :title="
          mode === 'diff'
            ? t('viewer.showCode')
            : data.chunk.metadata?.kind === 'diff'
              ? t('viewer.showDiff')
              : mode === 'markdown'
                ? t('viewer.rawTitle')
                : t('viewer.renderTitle')
        "
        @click="toggleMode"
      >
        {{
          mode === 'diff'
            ? t('viewer.code')
            : data.chunk.metadata?.kind === 'diff'
              ? t('viewer.diff')
              : mode === 'markdown'
                ? t('viewer.raw')
                : t('viewer.render')
        }}
      </Button>
      <Button variant="ghost" size="sm" @click="$emit('close')">
        ×
      </Button>
    </header>
    <div class="flex-1 overflow-auto p-3" :class="mode === 'markdown' ? 'text-sm' : 'text-xs'">
      <div v-if="loading">
        {{ t('viewer.loading') }}
      </div>
      <p v-else-if="error" class="text-destructive">
        {{ error }}
      </p>
      <div
        v-else
        :class="mode === 'markdown' ? 'cg-prose' : ''"
        v-html="html"
      />
    </div>
  </aside>
</template>

<style>
.cg-prose h1 { font-size: 1.5rem; font-weight: 700; margin: 1rem 0 0.5rem; }
.cg-prose h2 { font-size: 1.25rem; font-weight: 700; margin: 1rem 0 0.5rem; }
.cg-prose h3 { font-size: 1.1rem; font-weight: 600; margin: 0.75rem 0 0.5rem; }
.cg-prose h4, .cg-prose h5, .cg-prose h6 { font-weight: 600; margin: 0.5rem 0 0.25rem; }
.cg-prose p { margin: 0.5rem 0; line-height: 1.55; }
.cg-prose ul { list-style: disc; padding-left: 1.25rem; margin: 0.5rem 0; }
.cg-prose ol { list-style: decimal; padding-left: 1.25rem; margin: 0.5rem 0; }
.cg-prose li { margin: 0.15rem 0; }
.cg-prose code {
  background: hsl(var(--muted));
  padding: 0 0.25rem;
  border-radius: 0.25rem;
  font-size: 0.85em;
}
.cg-prose pre {
  background: hsl(var(--muted));
  padding: 0.75rem 1rem;
  border-radius: 0.375rem;
  overflow-x: auto;
  font-size: 0.8rem;
  margin: 0.5rem 0;
}
.cg-prose pre code { background: transparent; padding: 0; }
.cg-prose a {
  color: hsl(var(--primary));
  text-decoration: underline;
  text-underline-offset: 2px;
}
.cg-prose blockquote {
  border-left: 3px solid hsl(var(--border));
  padding-left: 0.75rem;
  margin: 0.5rem 0;
  color: hsl(var(--muted-foreground));
}
.cg-prose table {
  border-collapse: collapse;
  margin: 0.5rem 0;
}
.cg-prose th, .cg-prose td {
  border: 1px solid hsl(var(--border));
  padding: 0.25rem 0.5rem;
}
.cg-prose hr {
  border: 0;
  border-top: 1px solid hsl(var(--border));
  margin: 1rem 0;
}
</style>
