<script setup lang="ts">
import { marked } from 'marked'
import DOMPurify from 'isomorphic-dompurify'
import { Copy, Check } from 'lucide-vue-next'
import type { ResolutionEnvelope } from '#shared/schemas/resolution'

interface Citation {
  kind: 'chunk' | 'entity'
  id: string
}
interface Props {
  role: 'user' | 'assistant'
  content: string
  pending?: boolean
  invalid?: string[]
  citations?: Citation[]
  workspaceId?: string
  tokensPerSec?: number
  /**
   * If the assistant ran find_resolution and it returned a non-"none"
   * status, the page extracts that envelope from the trace and passes
   * it here. We render it as a banner above the message body — sets
   * the framing ("this is already fixed, here's where") before the
   * model's prose explains the details.
   */
  resolution?: ResolutionEnvelope | null
}
const props = defineProps<Props>()
const emit = defineEmits<{
  (e: 'open-chunk' | 'open-entity', id: string): void
}>()
const { t } = useI18n()

const html = computed(() => {
  if (props.role === 'user') {
    return escapeHtml(props.content)
  }
  // Replace [chunk:UUID] / [entity:UUID] markers with visible anchor badges.
  // We keep the glyph as direct text content rather than CSS ::before — the
  // pseudo-element approach broke for two reasons:
  // 1) v-html-injected nodes don't carry the [data-v-…] attribute Vue's
  //    scoped styles add, so the ::before rule didn't paint
  // 2) an anchor with zero rendered content has zero clickable hit area
  const invalidSet = new Set((props.invalid ?? []).map((s) => s.toLowerCase()))
  const withPlaceholders = props.content.replace(
    /\[(chunk|entity):([0-9a-f-]{36})\]/gi,
    (_, kind: string, id: string) => {
      const k = kind.toLowerCase()
      const lid = id.toLowerCase()
      const isInvalid = invalidSet.has(lid)
      const glyph = isInvalid ? '⚠' : k === 'chunk' ? '↗' : '◆'
      const label = isInvalid
        ? t('chat.citation.invalid')
        : k === 'chunk'
          ? t('chat.citation.openChunk')
          : t('chat.citation.showOnGraph')
      const invalidAttr = isInvalid ? ' data-invalid="true"' : ''
      return `<a class="cg-cite" data-kind="${k}" data-id="${lid}" title="${label}"${invalidAttr} href="#">${glyph}</a>`
    },
  )
  const rendered = marked.parse(withPlaceholders, { async: false }) as string
  return DOMPurify.sanitize(rendered, {
    ADD_ATTR: ['data-kind', 'data-id', 'data-invalid', 'title'],
  })
})

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

const messageRoot = ref<HTMLDivElement | null>(null)
let mermaidPromise: Promise<typeof import('mermaid').default> | null = null
let mermaidCounter = 0

// Languages we map from `language-X` markdown fences to a Shiki grammar.
// Unrecognised fences fall back to plaintext rather than blowing up.
// Aliases lump common variants onto canonical Shiki keys so the model
// can write ```ts or ```typescript and we render the same thing.
const SHIKI_LANG_ALIAS: Record<string, string> = {
  ts: 'typescript', typescript: 'typescript', tsx: 'tsx',
  js: 'javascript', javascript: 'javascript', jsx: 'jsx', mjs: 'javascript', cjs: 'javascript',
  py: 'python', python: 'python',
  go: 'go', golang: 'go',
  rs: 'rust', rust: 'rust',
  java: 'java', kt: 'kotlin', kotlin: 'kotlin',
  rb: 'ruby', ruby: 'ruby',
  sh: 'bash', bash: 'bash', shell: 'bash', zsh: 'bash',
  json: 'json', jsonc: 'json',
  yaml: 'yaml', yml: 'yaml',
  toml: 'toml',
  xml: 'xml', html: 'html', vue: 'vue', svelte: 'svelte',
  css: 'css', scss: 'scss', less: 'less',
  sql: 'sql',
  md: 'markdown', markdown: 'markdown', mdx: 'mdx',
  dockerfile: 'docker', docker: 'docker',
  diff: 'diff', patch: 'diff',
  c: 'c', 'c++': 'cpp', cpp: 'cpp', cs: 'csharp', csharp: 'csharp',
  php: 'php',
  graphql: 'graphql', gql: 'graphql',
  ini: 'ini', conf: 'ini',
  // Common edge cases that we still want highlighted reasonably.
  nginx: 'nginx',
  makefile: 'makefile', make: 'makefile',
}

async function highlightCodeBlocks(): Promise<void> {
  const root = messageRoot.value
  if (!root) return
  const blocks = root.querySelectorAll<HTMLElement>('pre > code[class*="language-"]')
  if (blocks.length === 0) return
  const { codeToHtml } = await import('shiki')
  for (const codeEl of Array.from(blocks)) {
    const pre = codeEl.closest('pre')
    if (!pre) continue
    if (pre.dataset.shikiHighlighted === '1') continue
    if (pre.dataset.mermaidRendered === '1') continue
    if (codeEl.classList.contains('language-mermaid')) continue
    const langClass = [...codeEl.classList].find((c) => c.startsWith('language-'))
    const rawLang = (langClass?.slice(9) ?? '').toLowerCase()
    const lang = SHIKI_LANG_ALIAS[rawLang] ?? 'plaintext'
    const source = codeEl.textContent ?? ''
    try {
      // Dual-theme: bakes light + dark token colours as CSS vars on
      // every span. A global rule in tailwind.css flips between them
      // based on the `.dark` class on <html>. No re-render needed on
      // theme switch — pure CSS.
      const rendered = await codeToHtml(source, {
        lang,
        themes: { light: 'github-light', dark: 'github-dark' },
        defaultColor: false,
      })
      const cleaned = DOMPurify.sanitize(rendered, {
        ADD_TAGS: ['span'],
        ADD_ATTR: ['style', 'class'],
      }) as unknown as string
      const wrapper = document.createElement('div')
      wrapper.innerHTML = cleaned
      const newPre = wrapper.querySelector('pre')
      if (!newPre) continue
      newPre.classList.add('cg-shiki')
      newPre.dataset.shikiHighlighted = '1'
      pre.replaceWith(newPre)
    } catch {
      pre.dataset.shikiHighlighted = 'error'
    }
  }
}

async function loadMermaid(): Promise<typeof import('mermaid').default> {
  if (!mermaidPromise) {
    mermaidPromise = import('mermaid').then((mod) => {
      const m = mod.default
      m.initialize({
        startOnLoad: false,
        theme: 'neutral',
        securityLevel: 'strict',
        fontFamily: 'Nunito, ui-sans-serif, system-ui, sans-serif',
      })
      return m
    })
  }
  return mermaidPromise
}

async function renderMermaidBlocks(): Promise<void> {
  if (props.pending) return
  const root = messageRoot.value
  if (!root) return
  const blocks = root.querySelectorAll<HTMLElement>('pre code.language-mermaid')
  if (blocks.length === 0) return
  const mermaid = await loadMermaid()
  for (const codeEl of Array.from(blocks)) {
    const pre = codeEl.closest('pre')
    if (!pre) continue
    if (pre.dataset.mermaidRendered === '1') continue
    const source = codeEl.textContent ?? ''
    if (!source.trim()) continue
    try {
      const { svg } = await mermaid.render(`mmd-${++mermaidCounter}`, source)
      // mermaid output is generated, but still feed it through DOMPurify
      // (svg profile) since the source text came from an LLM — we never
      // want untrusted text to escape into raw DOM.
      const cleanSvg = DOMPurify.sanitize(svg, {
        USE_PROFILES: { svg: true, svgFilters: true },
      }) as unknown as string
      const wrapper = document.createElement('div')
      wrapper.className = 'cg-mermaid'
      wrapper.innerHTML = cleanSvg
      wrapper.dataset.mermaidRendered = '1'
      pre.replaceWith(wrapper)
    } catch (err) {
      pre.dataset.mermaidRendered = 'error'
      const note = document.createElement('p')
      note.className = 'text-[10px] text-destructive mt-1'
      note.textContent = err instanceof Error ? `Mermaid: ${err.message}` : 'Mermaid render failed'
      pre.after(note)
    }
  }
}

watch(
  () => [props.content, props.pending] as const,
  () => void nextTick(() => {
    void highlightCodeBlocks()
    void renderMermaidBlocks()
  }),
  { immediate: true },
)
// Theme switching: with dual-theme Shiki + CSS-var flip, no re-render
// needed. Touching colorMode at this scope was the previous (single-
// theme) approach — removed.

// Copy raw markdown — useful when the user wants to paste a finding
// into an issue / PR. Citation markers stay as-is; downstream renderer
// can resolve them or leave them visible.
const copied = ref(false)
async function copyMarkdown(): Promise<void> {
  try {
    await navigator.clipboard.writeText(props.content)
    copied.value = true
    setTimeout(() => { copied.value = false }, 1500)
  } catch {
    // Clipboard API unavailable in some browsers / contexts.
  }
}

function onClick(e: MouseEvent): void {
  const target = e.target as HTMLElement | null
  if (!target) return
  const anchor = target.closest<HTMLAnchorElement>('a.cg-cite')
  if (!anchor) return
  e.preventDefault()
  const kind = anchor.getAttribute('data-kind')
  const id = anchor.getAttribute('data-id')
  if (!id) return
  if (kind === 'chunk') {
    emit('open-chunk', id)
  } else if (kind === 'entity') {
    // Entity citation → open the Neighbour Graph drawer on this node.
    // Replaces the old "navigate to /graph?highlight=…" redirect that
    // ripped the user out of the chat.
    emit('open-entity', id)
  }
}
</script>

<template>
  <div
    class="rounded-lg border px-4 py-3 transition"
    :class="
      role === 'user'
        ? 'border-border bg-secondary'
        : 'border-primary/20 bg-gradient-to-br from-primary/[0.04] to-fuchsia-500/[0.03]'
    "
  >
    <div class="mb-1 flex items-center justify-between text-xs uppercase tracking-wide text-muted-foreground">
      <span :class="role === 'assistant' ? 'font-semibold text-primary' : ''">
        {{ role === 'user' ? t('chat.you') : t('chat.assistant') }}
        <span v-if="pending" class="ml-2 animate-pulse text-primary">…</span>
      </span>
      <span class="flex items-center gap-2">
        <span
          v-if="role === 'assistant' && tokensPerSec && tokensPerSec > 0"
          class="text-[10px] tabular-nums text-muted-foreground"
          :title="t('chat.tokensPerSecTitle')"
        >{{ tokensPerSec }} {{ t('chat.tokensPerSec') }}</span>
        <button
          v-if="role === 'assistant' && !pending && content"
          type="button"
          class="flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] normal-case tracking-normal text-muted-foreground hover:bg-accent hover:text-foreground"
          :title="t('chat.copyMarkdown')"
          @click="copyMarkdown"
        >
          <Check v-if="copied" class="h-3 w-3 text-emerald-500" />
          <Copy v-else class="h-3 w-3" />
          {{ copied ? t('chat.copied') : t('chat.copy') }}
        </button>
      </span>
    </div>
    <ChatResolutionBanner v-if="role === 'assistant' && resolution" :resolution="resolution" />
    <div ref="messageRoot" class="cg-prose text-sm leading-relaxed" v-html="html" @click="onClick" />
  </div>
</template>

<style>
.cg-prose pre {
  background: hsl(var(--muted));
  border-radius: 0.375rem;
  padding: 0.75rem 1rem;
  overflow-x: auto;
  font-size: 0.8rem;
  margin: 0.5rem 0;
}
.cg-prose code {
  background: hsl(var(--muted));
  padding: 0 0.25rem;
  border-radius: 0.25rem;
  font-size: 0.85em;
}
.cg-prose pre code {
  background: transparent;
  padding: 0;
}
.cg-prose p {
  margin: 0.5rem 0;
}
.cg-prose ul {
  margin: 0.5rem 0;
  padding-left: 1.25rem;
  list-style: disc;
}
.cg-prose ol {
  margin: 0.5rem 0;
  padding-left: 1.25rem;
  list-style: decimal;
}
.cg-prose a.cg-cite {
  display: inline-block;
  font-size: 0.75em;
  line-height: 1;
  padding: 0.15em 0.35em;
  background: hsl(var(--primary) / 0.15);
  color: hsl(var(--primary));
  border-radius: 0.25rem;
  margin: 0 0.15em;
  cursor: pointer;
  text-decoration: none;
  vertical-align: baseline;
}
.cg-prose a.cg-cite:hover {
  background: hsl(var(--primary) / 0.3);
}
.cg-prose a.cg-cite[data-invalid="true"] {
  background: hsl(var(--destructive) / 0.15);
  color: hsl(var(--destructive));
}
.cg-mermaid {
  overflow-x: auto;
  padding: 0.75rem;
  margin: 0.75rem 0;
  background: hsl(var(--background));
  border: 1px solid hsl(var(--border));
  border-radius: 0.5rem;
}
/* Shiki paints its own background + token colours via inline styles.
   We override the .cg-prose default just enough that the highlighted
   <pre> renders with the Shiki theme palette intact. */
.cg-prose pre.cg-shiki {
  padding: 0.75rem 1rem;
  border-radius: 0.375rem;
  overflow-x: auto;
  font-size: 0.8rem;
  margin: 0.5rem 0;
}
.cg-prose pre.cg-shiki code {
  background: transparent !important;
  padding: 0;
  font-size: inherit;
}
.cg-mermaid svg {
  max-width: 100%;
  height: auto;
}
</style>
