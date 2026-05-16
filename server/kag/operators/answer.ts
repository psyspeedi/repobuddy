import type { LLMProvider, ChatMessage } from '../../providers/llm'

export interface AnswerContextChunk {
  id: string
  text: string
  filePath?: string | null
  startLine?: number | null
  endLine?: number | null
}

export interface AnswerContextEntity {
  id: string
  name: string
  type: string
  description?: string | null
  qualifiedName?: string | null
  /** Raw metadata jsonb — commits carry message/author/date/filesChanged here, files carry hotness, persons carry email/commitCount, etc. */
  metadata?: Record<string, unknown> | null
  filePath?: string | null
  startLine?: number | null
  endLine?: number | null
  language?: string | null
  signature?: string | null
}

export interface AnswerWorkspaceMeta {
  name: string
  sourceUrl?: string | null
  languages: string[]
  stats?: Record<string, number> | null
}

export interface AnswerParams {
  question: string
  chunks: AnswerContextChunk[]
  entities?: AnswerContextEntity[]
  style?: 'concise' | 'detailed'
  /** Optional history (previous user/assistant turns in the session). */
  history?: ChatMessage[]
  /**
   * Always-present grounding metadata about the workspace itself, so the
   * model can answer broad "tell me about this repo" questions even when
   * the planner couldn't retrieve any chunks.
   */
  workspace?: AnswerWorkspaceMeta
}

export interface AnswerStreamChunk {
  type: 'text' | 'done'
  text?: string
  inputTokens?: number
  outputTokens?: number
}

const SYSTEM_PROMPT = `You are CodeGraph, an assistant that answers questions about a codebase using ONLY the provided context.

Rules:
- After every factual claim, cite the source inline. Citations use the
  exact form [chunk:UUID] for code/doc snippets and [entity:UUID] for
  graph entities. UUIDs come from the context block; do not invent them.
- If the context is insufficient, say so plainly. Do not fabricate.
- Prefer concise prose; use bullet lists when comparing multiple items.
- Code blocks should be triple-fenced with the appropriate language tag.`

export async function* answer(
  llm: LLMProvider,
  params: AnswerParams,
): AsyncGenerator<AnswerStreamChunk> {
  const userMessage = renderUserMessage(params)

  const messages: ChatMessage[] = [
    { role: 'system', content: SYSTEM_PROMPT },
    ...(params.history ?? []),
    { role: 'user', content: userMessage },
  ]

  for await (const event of llm.stream(messages, { temperature: 0.2 })) {
    if (event.type === 'text') {
      yield { type: 'text', text: event.text }
    } else if (event.type === 'done') {
      yield {
        type: 'done',
        inputTokens: event.inputTokens,
        outputTokens: event.outputTokens,
      }
    }
  }
}

function renderUserMessage(params: AnswerParams): string {
  const lines: string[] = []
  lines.push(`Question: ${params.question}`)
  lines.push('')

  if (params.workspace) {
    const ws = params.workspace
    lines.push('## Workspace')
    lines.push(`- name: ${ws.name}`)
    if (ws.sourceUrl) lines.push(`- source: ${ws.sourceUrl}`)
    if (ws.languages.length > 0) {
      lines.push(`- languages: ${ws.languages.join(', ')}`)
    }
    if (ws.stats) {
      const interesting = ['files', 'entities', 'relations', 'chunks', 'commits', 'concepts', 'patterns']
        .filter((k) => typeof ws.stats?.[k] === 'number')
        .map((k) => `${k}=${ws.stats?.[k]}`)
      if (interesting.length > 0) lines.push(`- stats: ${interesting.join(', ')}`)
    }
    lines.push('')
  }

  if (params.entities && params.entities.length > 0) {
    lines.push('## Entities in scope')
    for (const e of params.entities) {
      lines.push(...renderEntity(e))
    }
    lines.push('')
  }

  if (params.chunks.length > 0) {
    lines.push('## Source chunks')
    for (const c of params.chunks) {
      const location = c.filePath
        ? `${c.filePath}${c.startLine ? `:${c.startLine}-${c.endLine ?? c.startLine}` : ''}`
        : 'unknown'
      lines.push(`### [chunk:${c.id}] ${location}`)
      lines.push('```')
      lines.push(c.text.slice(0, 3000))
      lines.push('```')
      lines.push('')
    }
  }

  if (params.style === 'detailed') {
    lines.push('Answer in detail with examples where appropriate.')
  } else {
    lines.push('Keep your answer focused and tight.')
  }
  return lines.join('\n')
}

/**
 * Render one entity into prompt lines. Type-specific metadata (commit
 * message, file hotness, person commit count, etc.) is unpacked here so
 * the model sees the actual content, not just a name + type. Without this
 * the answer for "tell me about this commit" said "context insufficient".
 */
function renderEntity(e: AnswerContextEntity): string[] {
  const out: string[] = []
  const header = `### [entity:${e.id}] ${e.name} (${e.type})`
  out.push(header)
  if (e.qualifiedName) out.push(`- qualified: \`${e.qualifiedName}\``)
  if (e.filePath) {
    const range = e.startLine ? `:${e.startLine}-${e.endLine ?? e.startLine}` : ''
    out.push(`- location: \`${e.filePath}${range}\``)
  }
  if (e.language) out.push(`- language: ${e.language}`)
  if (e.signature) out.push(`- signature: \`${e.signature.slice(0, 240)}\``)
  if (e.description) out.push(`- description: ${e.description}`)

  const meta = e.metadata
  if (meta && typeof meta === 'object') {
    if (e.type === 'commit') {
      const m = meta as {
        sha?: string
        author?: string
        email?: string
        date?: string
        message?: string
        filesChanged?: string[]
      }
      if (m.sha) out.push(`- sha: ${m.sha}`)
      if (m.author) out.push(`- author: ${m.author}${m.email ? ` <${m.email}>` : ''}`)
      if (m.date) out.push(`- date: ${m.date}`)
      if (m.message) {
        out.push(`- message:`)
        for (const line of m.message.split('\n')) out.push(`    ${line}`)
      }
      if (m.filesChanged && m.filesChanged.length > 0) {
        out.push(`- files changed (${m.filesChanged.length}):`)
        for (const f of m.filesChanged.slice(0, 30)) out.push(`    - ${f}`)
        if (m.filesChanged.length > 30) {
          out.push(`    - … and ${m.filesChanged.length - 30} more`)
        }
      }
    } else if (e.type === 'person') {
      const m = meta as { email?: string; commitCount?: number }
      if (m.email) out.push(`- email: ${m.email}`)
      if (typeof m.commitCount === 'number') out.push(`- commits: ${m.commitCount}`)
    } else if (e.type === 'file') {
      const m = meta as { hotness?: number }
      if (typeof m.hotness === 'number') {
        out.push(`- hotness: ${m.hotness} modification(s) in last 90 days`)
      }
    } else {
      // Generic fallback — dump non-trivial metadata.
      const entries = Object.entries(meta).filter(([, v]) => v !== null && v !== '')
      if (entries.length > 0 && entries.length <= 12) {
        out.push(`- metadata:`)
        for (const [k, v] of entries) {
          const repr = typeof v === 'string' ? v : JSON.stringify(v)
          out.push(`    - ${k}: ${repr.slice(0, 200)}`)
        }
      }
    }
  }
  return out
}

/**
 * Extract citation markers from generated text. Returns array of
 * { kind: 'chunk'|'entity', id: string } in order of first appearance.
 */
export function extractCitations(
  text: string,
): { kind: 'chunk' | 'entity'; id: string }[] {
  const re = /\[(chunk|entity):([0-9a-f-]{36})\]/gi
  const seen = new Set<string>()
  const out: { kind: 'chunk' | 'entity'; id: string }[] = []
  for (const match of text.matchAll(re)) {
    const kind = match[1]?.toLowerCase() as 'chunk' | 'entity' | undefined
    const id = match[2]?.toLowerCase()
    if (!kind || !id) continue
    const key = `${kind}:${id}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ kind, id })
  }
  return out
}
