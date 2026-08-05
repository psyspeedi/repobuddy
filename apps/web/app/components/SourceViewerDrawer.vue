<script setup lang="ts">
import { codeToHtml } from 'shiki'
import { marked } from 'marked'
import DOMPurify from 'isomorphic-dompurify'

interface Props {
  workspaceId: string
  chunkId: string | null
}
const props = defineProps<Props>()
defineEmits<{ (e: 'close'): void }>()

const { t } = useI18n()

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
// When the originally-clicked citation resolved to a diff chunk, we
// try to swap it for the file's code chunk and remember the diff's
// id here so the "Diff" button can jump back to the original.
const originalDiffChunkId = ref<string | null>(null)

async function load(): Promise<void> {
  if (!props.chunkId) return
  loading.value = true
  error.value = null
  originalDiffChunkId.value = null
  try {
    let resp = await useApi()<ChunkResponse>(
      `/api/workspaces/${props.workspaceId}/chunk/${props.chunkId}`,
    )

    // If the clicked citation was a per-commit diff AND a source-code
    // chunk exists for the same path, prefer the code view by default.
    // Users complained that clicks-to-citations almost always landed
    // them on a diff when they wanted to read the file.
    if (resp.chunk.metadata?.kind === 'diff' && resp.chunk.filePath) {
      const sourceResp = await useApi()<ChunkResponse>(
        `/api/workspaces/${props.workspaceId}/chunk-by-path`,
        { query: { path: resp.chunk.filePath, excludeId: resp.chunk.id } },
      ).catch(() => ({ chunk: null }))
      if (sourceResp.chunk) {
        originalDiffChunkId.value = resp.chunk.id
        resp = sourceResp
      }
    }

    data.value = resp
    mode.value = detectMode(resp.chunk)
    html.value = await renderChunk(resp.chunk, mode.value)
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err)
  } finally {
    loading.value = false
  }
}

async function loadById(chunkId: string): Promise<void> {
  loading.value = true
  error.value = null
  try {
    const resp = await useApi()<ChunkResponse>(
      `/api/workspaces/${props.workspaceId}/chunk/${chunkId}`,
    )
    data.value = resp
    mode.value = detectMode(resp.chunk)
    html.value = await renderChunk(resp.chunk, mode.value)
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
  // Dual-theme bakes both palettes into CSS vars; the global rule in
  // tailwind.css flips them on .dark. No re-render on theme switch
  // (which is why this used to flash the wrong palette after toggling).
  const themes = { light: 'github-light', dark: 'github-dark' } as const
  if (forMode === 'diff') {
    return codeToHtml(chunk.text, { lang: 'diff', themes, defaultColor: false })
  }
  const lang = chunk.metadata?.language ?? 'plaintext'
  try {
    return await codeToHtml(chunk.text, {
      lang: shikiLang(lang, chunk.filePath),
      themes,
      defaultColor: false,
    })
  } catch {
    return await codeToHtml(chunk.text, { lang: 'plaintext', themes, defaultColor: false })
  }
}

async function toggleMode(): Promise<void> {
  if (!data.value) return

  // Case 1: currently showing the file's code, but the original
  // citation was a diff. Jump back to the diff chunk by id.
  if (originalDiffChunkId.value && data.value.chunk.metadata?.kind !== 'diff') {
    const id = originalDiffChunkId.value
    originalDiffChunkId.value = null
    await loadById(id)
    return
  }

  // Case 2: a markdown ↔ code toggle for doc-y chunks (READMEs etc).
  if (mode.value === 'markdown' || (mode.value === 'code' && data.value.chunk.sourceType === 'doc')) {
    mode.value = mode.value === 'markdown' ? 'code' : 'markdown'
    html.value = await renderChunk(data.value.chunk, mode.value)
    return
  }

  // Case 3: rendering a diff chunk directly (no parallel code chunk
  // existed). Allow flipping its visual mode between Shiki's diff
  // grammar and plain code rendering of the same text.
  const isDiffChunk = data.value.chunk.metadata?.kind === 'diff'
  if (mode.value === 'diff') mode.value = 'code'
  else if (mode.value === 'code' && isDiffChunk) mode.value = 'diff'
  html.value = await renderChunk(data.value.chunk, mode.value)
}

watch(() => props.chunkId, () => void load(), { immediate: true })

// Map (chunk.metadata.language, chunk.filePath) → Shiki grammar.
// `language` is set by the parser for AST-parseable files. For the
// fallback whole-file chunks added in the manifest / generic-text
// pipeline step, language is 'unknown' — infer from the file extension
// or known config-filename so common files (tsconfig.json, Dockerfile,
// yaml workflows, etc.) still get highlighted.
const EXT_LANG: Record<string, string> = {
  ts: 'typescript', tsx: 'tsx', mts: 'typescript', cts: 'typescript',
  js: 'javascript', jsx: 'jsx', mjs: 'javascript', cjs: 'javascript',
  vue: 'vue', svelte: 'svelte',
  py: 'python', pyi: 'python', go: 'go',
  rs: 'rust', java: 'java', kt: 'kotlin', rb: 'ruby',
  sh: 'bash', bash: 'bash',
  json: 'json', jsonc: 'json',
  yaml: 'yaml', yml: 'yaml', toml: 'toml',
  xml: 'xml', html: 'html', htm: 'html',
  css: 'css', scss: 'scss', less: 'less',
  sql: 'sql', md: 'markdown', mdx: 'mdx',
  graphql: 'graphql', gql: 'graphql',
  c: 'c', cpp: 'cpp', cc: 'cpp', h: 'c', hpp: 'cpp',
  cs: 'csharp', php: 'php',
  ini: 'ini', conf: 'ini',
}
const FILENAME_LANG: Record<string, string> = {
  dockerfile: 'docker',
  makefile: 'makefile',
  '.gitignore': 'gitignore',
  '.dockerignore': 'gitignore',
  '.env': 'dotenv',
  '.env.example': 'dotenv',
}
function shikiLang(lang: string, filePath: string | null | undefined): string {
  // 1. Honour the parser's signal first (typescript / javascript / python / go).
  if (lang === 'typescript' || lang === 'javascript' || lang === 'python' || lang === 'go') {
    return lang
  }
  if (!filePath) return 'plaintext'
  // 2. Filename overrides (Dockerfile, Makefile, dotenv, etc.).
  const base = filePath.split('/').pop()?.toLowerCase() ?? ''
  if (FILENAME_LANG[base]) return FILENAME_LANG[base] as string
  // Extension chain (handle .config.js style by walking right-to-left).
  const parts = base.split('.')
  for (let i = parts.length - 1; i >= 1; i--) {
    const ext = parts[i]
    if (ext && EXT_LANG[ext]) return EXT_LANG[ext] as string
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
          originalDiffChunkId
            ? t('viewer.showDiff')
            : mode === 'diff'
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
          originalDiffChunkId
            ? t('viewer.diff')
            : mode === 'diff'
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
    <div
      class="cg-source grid flex-1 overflow-auto"
      :class="mode === 'markdown' ? 'p-3 text-sm' : 'text-xs'"
    >
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
/* Source viewer: the Shiki <pre> otherwise shrinks to its content — as
 * wide as the longest line, as tall as the line count — so the panel's
 * own background shows through as a stripe on the right and a band below
 * a short file. The scroll container is a single-cell grid (its child
 * stretches to fill both axes); the <pre> fills that box but still grows
 * to max-content so a long line scrolls horizontally over code, not bare
 * background. Padding lives on the <pre> so its background reaches the
 * panel edges. */
.cg-source .shiki {
  width: max-content;
  min-width: 100%;
  min-height: 100%;
  box-sizing: border-box;
  padding: 0.75rem;
  margin: 0;
}
.cg-source .shiki code {
  display: block;
}

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
