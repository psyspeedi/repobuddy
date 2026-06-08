import type { LLMProvider, ChatMessage } from '../../../providers/internals/llm'
import type { ProjectOverview } from '../../../../lib/project-overview'

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
  /** UI locale — instruct the model to reply in this language. */
  responseLocale?: 'en' | 'ru'
  /**
   * Mermaid diagrams built by upstream operators (walkthrough). The
   * user prompt asks the model to include them verbatim in the answer
   * — the ChatMessage component then lazy-loads mermaid and renders
   * each block on the client.
   */
  mermaidDiagrams?: string[]
  /**
   * Open GitHub issues collected by the list_issues operator. Rendered
   * as a dedicated section in the user prompt; the model is asked to
   * cite issue numbers (#42) and link out to the actual URL when
   * recommending which to pick up.
   */
  /**
   * Project overview snapshot from get_project_overview. When present,
   * an "Orientation" section is added to the user prompt so the model
   * can summarise the codebase confidently for broad / first-time
   * questions ("tell me about this project", "where do I start").
   */
  overview?: ProjectOverview | null
  /**
   * The user's question carries an embedded unified diff. Triggers an
   * extra instruction in the user prompt asking the model to analyse
   * the change set (callers / tests / breakage) rather than just
   * answering generically.
   */
  userPastedDiff?: boolean
  issues?: {
    number: number
    title: string
    url: string
    labels: string[]
    bodyExcerpt: string
    updatedAt: string
    relatedEntities?: {
      entityId: string
      name: string
      type: string
      filePath: string | null
      qualifiedName: string | null
      description: string | null
      inDegree: number
    }[]
  }[]
}

export interface AnswerStreamChunk {
  type: 'text' | 'done'
  text?: string
  inputTokens?: number
  outputTokens?: number
}

const LOCALE_NAMES: Record<string, string> = {
  en: 'English',
  ru: 'Russian (русский)',
}

function buildSystemPrompt(locale: string | undefined): string {
  const langName = LOCALE_NAMES[locale ?? 'en'] ?? 'English'
  return `You are RepoBuddy, an assistant that answers questions about a codebase using ONLY the provided context.

Language rule:
- ALWAYS respond in ${langName}, regardless of the question's language. This is the user's interface language and must be respected.

Citation rules:
- After every factual claim, cite the source inline. Citations use the
  exact form [chunk:UUID] for code/doc snippets and [entity:UUID] for
  graph entities. UUIDs come from the context block; do not invent them.
- GitHub issues are NOT entities and NOT chunks. Cite issue numbers
  as plain text "#42" together with a markdown link [#42](issue-url).
  Never wrap an issue number in [entity:...] or [chunk:...] — those
  carry UUIDs only.
- If the context is insufficient, say so plainly. Do not fabricate.

Style:
- Prefer concise prose; use bullet lists when comparing multiple items.
- Code blocks should be triple-fenced with the appropriate language tag.`
}

export async function* answer(
  llm: LLMProvider,
  params: AnswerParams,
): AsyncGenerator<AnswerStreamChunk> {
  const userMessage = renderUserMessage(params)

  const messages: ChatMessage[] = [
    { role: 'system', content: buildSystemPrompt(params.responseLocale) },
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

  if (params.userPastedDiff) {
    lines.push('## Diff analysis mode')
    lines.push(
      'The user pasted a unified diff inside their question. Treat that diff as'
      + ' the change-set under review. The touched files are pre-loaded in the'
      + ' Source chunks section below (look for their paths in the diff +/-+++'
      + ' headers). Your answer MUST:'
      + '\n  1. Summarise what the diff does in one sentence.'
      + '\n  2. List which existing callers / tests / sibling entities are affected'
      + ' (use the chunks + entities below for evidence; cite [chunk:UUID]).'
      + '\n  3. Flag risks: missing tests, missed callers that need updating,'
      + ' API-shape changes that would break consumers.'
      + '\n  4. Suggest a follow-up step (e.g. "run npm test packages/x", "update'
      + ' README example block", "add a CHANGELOG entry").',
    )
    lines.push('')
  }

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

  if (params.overview) {
    const ov = params.overview
    lines.push('## Orientation (project overview)')
    if (ov.entrypoints.length > 0) {
      lines.push('### Entrypoints')
      for (const e of ov.entrypoints.slice(0, 6)) {
        const id = e.id ? ` [entity:${e.id}]` : ''
        lines.push(`- (${e.kind}) ${e.name} — \`${e.filePath}\`${id}`)
      }
    }
    if (ov.coreAbstractions.length > 0) {
      lines.push('### Core abstractions (top by in-degree)')
      for (const a of ov.coreAbstractions.slice(0, 8)) {
        const where = a.filePath ? ` in \`${a.filePath}\`` : ''
        const desc = a.description ? ` — ${a.description.slice(0, 120)}` : ''
        lines.push(`- ${a.type} \`${a.name}\` [entity:${a.id}] (←${a.inDegree})${where}${desc}`)
      }
    }
    if (ov.hotFiles.length > 0) {
      lines.push('### Hot files (most changed in 90d)')
      for (const h of ov.hotFiles.slice(0, 6)) {
        lines.push(`- \`${h.filePath}\` [entity:${h.id}] (${h.hotness} commits)`)
      }
    }
    if (ov.goodFirstIssues.length > 0) {
      lines.push('### Safe first-PR zones')
      for (const z of ov.goodFirstIssues.slice(0, 4)) {
        lines.push(`- \`${z.filePath}\` [entity:${z.id}] — ${z.reasons.join(', ')}`)
      }
    }
    if (ov.architectureMermaid) {
      lines.push('### Architecture (auto-generated)')
      lines.push('Folder-level imports between the top folders. Sized by entity count, edges labelled with import counts. Include this block VERBATIM in your answer when the user asks "what does this project look like" / "explain the architecture":')
      lines.push('```mermaid')
      lines.push(ov.architectureMermaid)
      lines.push('```')
    }
    if (ov.contribGuide && ov.contribGuide.length > 0) {
      lines.push('### Contribution conventions')
      lines.push('Surface these rules to the user when they ask about contributing — every OSS project has specific norms (signing, conventional commits, test policy, etc.).')
      for (const g of ov.contribGuide.slice(0, 4)) {
        lines.push(`- (${g.kind}) \`${g.filePath}\`:`)
        for (const line of g.excerpt.split('\n').slice(0, 12)) lines.push(`    ${line}`)
      }
    }
    const tot = ov.stats.totalEntities
    const byType = Object.entries(ov.stats.entitiesByType)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 6)
      .map(([t, n]) => `${t}=${n}`)
      .join(', ')
    lines.push(`### Stats`)
    lines.push(`- ${tot} entities total (${byType})`)
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

  if (params.issues && params.issues.length > 0) {
    lines.push('')
    lines.push('## GitHub issues')
    lines.push(
      'Each issue below carries pre-linked `relatedEntities` — these are real'
      + ' classes/functions/files in the indexed graph that the issue text'
      + ' references. The "Source chunks" / "Entities in scope" sections later'
      + ' in this prompt CONTAIN their code. When the user asks "where do I'
      + ' start" or "how should I fix this issue", ground your recommendation'
      + ' in those entities and cite [chunk:UUID] / [entity:UUID] from the'
      + ' context — DO NOT just point the user back to GitHub. Cite the issue'
      + ' itself as [#N](url) (plain markdown link).',
    )
    for (const i of params.issues) {
      const labels = i.labels.length > 0 ? ` [${i.labels.join(', ')}]` : ''
      lines.push(`- [#${i.number}](${i.url})${labels}: ${i.title}`)
      if (i.bodyExcerpt) lines.push(`  > ${i.bodyExcerpt}`)
      if (i.relatedEntities && i.relatedEntities.length > 0) {
        const refs = i.relatedEntities.map((e) => {
          const where = e.filePath ? ` (${e.filePath})` : ''
          return `${e.name}${where}`
        }).join(', ')
        lines.push(`  Related code: ${refs}`)
      }
    }
    lines.push('')
  }

  if (params.mermaidDiagrams && params.mermaidDiagrams.length > 0) {
    lines.push('')
    lines.push('## Sequence diagram')
    lines.push(
      'Include the following mermaid diagram verbatim in your answer'
      + ' inside a triple-backtick fence with `mermaid` as the language tag.'
      + ' The UI renders it as an interactive diagram next to your prose.',
    )
    for (const block of params.mermaidDiagrams) {
      lines.push('```mermaid')
      lines.push(block)
      lines.push('```')
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
        diff?: string
        diffTruncated?: boolean
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
      if (m.diff) {
        out.push(`- diff${m.diffTruncated ? ' (truncated)' : ''}:`)
        out.push('  ```diff')
        for (const line of m.diff.split('\n')) out.push(`  ${line}`)
        out.push('  ```')
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
    } else if (
      // Functions/classes/types may carry author-written JSDoc/docstring
      // extracted by the parser. Surface it verbatim so the model can
      // ground on author intent.
      (e.type === 'function' || e.type === 'class' || e.type === 'type')
      && 'docs' in meta
    ) {
      const m = meta as {
        docs?: {
          description?: string
          params?: { name: string; description: string }[]
          returns?: string
          examples?: string[]
          deprecated?: string | true
        }
      }
      const d = m.docs
      if (d) {
        if (d.description) out.push(`- jsdoc: ${d.description}`)
        if (d.params && d.params.length > 0) {
          out.push(`- jsdoc params:`)
          for (const p of d.params) out.push(`    - ${p.name}: ${p.description}`)
        }
        if (d.returns) out.push(`- jsdoc returns: ${d.returns}`)
        if (d.deprecated) {
          out.push(`- deprecated${typeof d.deprecated === 'string' ? `: ${d.deprecated}` : ''}`)
        }
        if (d.examples && d.examples.length > 0) {
          out.push(`- jsdoc examples:`)
          for (const ex of d.examples) {
            out.push('  ```')
            for (const line of ex.split('\n')) out.push(`  ${line}`)
            out.push('  ```')
          }
        }
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
