<script setup lang="ts">
import { marked } from 'marked'
import DOMPurify from 'isomorphic-dompurify'

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
}
const props = defineProps<Props>()
const emit = defineEmits<{ (e: 'open-chunk', chunkId: string): void }>()
const { t } = useI18n()

const entityCitations = computed(() =>
  (props.citations ?? []).filter((c) => c.kind === 'entity'),
)
const graphHighlightUrl = computed(() => {
  if (!props.workspaceId || entityCitations.value.length === 0) return null
  const ids = entityCitations.value.map((c) => c.id).join(',')
  return `/w/${props.workspaceId}/graph?highlight=${encodeURIComponent(ids)}`
})

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
  } else if (kind === 'entity' && props.workspaceId) {
    // Entity citation → jump to graph with this node highlighted.
    void navigateTo(
      `/w/${props.workspaceId}/graph?highlight=${encodeURIComponent(id)}`,
    )
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
      <NuxtLink
        v-if="graphHighlightUrl"
        :to="graphHighlightUrl"
        class="rounded bg-accent/40 px-2 py-0.5 text-[10px] normal-case tracking-normal hover:bg-accent"
        :title="t('chat.showOnGraphTitle')"
      >
        {{ t('chat.showOnGraph') }}
      </NuxtLink>
    </div>
    <div class="cg-prose text-sm leading-relaxed" v-html="html" @click="onClick" />
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
</style>
