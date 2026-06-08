import type { Database } from '../../../../db/client'
import type { EmbeddingsProvider } from '../../../providers/internals/embeddings'
import type { LLMProvider } from '../../../providers/internals/llm'

export interface OperatorContext {
  workspaceId: string
  db: Database
  embeddings: EmbeddingsProvider
  llm: LLMProvider
  /** Always-present workspace metadata passed to the answer operator. */
  workspace?: {
    name: string
    sourceUrl?: string | null
    languages: string[]
    stats?: Record<string, number> | null
  }
  /**
   * Entities the user explicitly referenced via [entity:UUID] in the
   * question. The answer operator always includes them in its context
   * regardless of what the plan retrieved, with full metadata.
   */
  pinnedEntities?: {
    id: string
    name: string
    type: string
    qualifiedName: string | null
    description: string | null
    metadata: Record<string, unknown> | null
    filePath: string | null
    startLine: number | null
    endLine: number | null
    language: string | null
    signature: string | null
  }[]
  /**
   * Chunks linked to pinned entities via entity_chunks. Loaded by the chat
   * endpoint so the model cites the per-file diff / code chunk (↗ → opens
   * source viewer) instead of falling back to the entity (◆ → jumps to graph).
   */
  pinnedChunks?: {
    id: string
    text: string
    filePath: string | null
    startLine: number | null
    endLine: number | null
    sourceType?: string
    metadata?: Record<string, unknown> | null
  }[]
  /** UI locale — the answer operator instructs the model to reply in this language. */
  responseLocale?: 'en' | 'ru'
  /**
   * The user's question carries an embedded unified diff. Tells the
   * answer / agentic prompt to treat the question as a change-set
   * evaluation, not just a question about existing code.
   */
  userPastedDiff?: boolean
  /**
   * Prior conversation turns so multi-turn flows keep their context
   * (e.g. "issue #191" → "and the callers?" resolves to 191's callers).
   * Passed through to answer() and runAgenticAnswer.
   */
  history?: { role: 'user' | 'assistant' | 'system' | 'tool'; content: string }[]
}

/** Entity shape exposed to ops — projection of the entities table. */
export type GraphEntity = {
  id: string
  type: string
  name: string
  qualifiedName: string | null
  filePath: string | null
  startLine: number | null
  endLine: number | null
  language: string | null
  description: string | null
}
