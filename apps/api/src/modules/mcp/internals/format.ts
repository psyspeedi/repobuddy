/**
 * Response shaping for MCP tool results.
 *
 * Every tool returns a single `text` block holding pretty-printed JSON.
 * JSON (rather than prose markdown) because the consumer is another
 * model that will chain calls: it needs to pull `entityId` / `chunkId` /
 * `path` back out verbatim, and quoting rules in prose make that lossy.
 *
 * The output caps here exist to protect the CLIENT's context window,
 * not ours. A repo-wide search can match thousands of chunks; dumping
 * them would evict whatever the user was actually working on from
 * Claude Code's context. Truncation is always announced — strings gain
 * a `… [truncated N chars]` marker, and a list that was cut is reported
 * alongside the total count of what was available — so the model knows
 * to narrow its query instead of assuming it saw everything.
 *
 * The input caps are a different job: they stop an oversized argument
 * from reaching a paid provider or GitHub at all. Zod rejects them
 * before the handler runs, so nothing is spent on a request we would
 * refuse anyway.
 */
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'

/** Hard cap on rows any single tool returns. */
export const MAX_RESULTS = 30

/** Cap on a single code/doc chunk's text, in characters. */
export const MAX_CHUNK_CHARS = 1200

/** Cap on free-form prose (issue bodies, commit messages, descriptions). */
export const MAX_PROSE_CHARS = 600

/**
 * Input caps. A query longer than this is not a query — it is a body
 * being pushed through to the embeddings API and to Postgres's tsquery
 * parser on our bill.
 */
export const MAX_QUERY_CHARS = 512
/** Longest repository-relative path we will look up. */
export const MAX_PATH_CHARS = 512
/** GitHub label filters are joined into a query string; keep it short. */
export const MAX_LABELS = 20
export const MAX_LABEL_CHARS = 64

/** Trim to `max` chars on a character boundary, flagging the cut. */
export function truncate(text: string | null | undefined, max: number): string {
  if (!text) return ''
  if (text.length <= max) return text
  return `${text.slice(0, max)}… [truncated ${text.length - max} chars]`
}

/** Clamp a client-supplied limit into [1, MAX_RESULTS]. */
export function clampLimit(limit: number | undefined, fallback: number): number {
  const n = Number.isFinite(limit) ? Number(limit) : fallback
  return Math.min(Math.max(Math.trunc(n), 1), MAX_RESULTS)
}

/** Successful tool result carrying a JSON payload. */
export function toolJson(payload: unknown): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] }
}

/**
 * Failed tool result. The message is always something we composed —
 * never a raw exception — so driver stack traces, connection strings
 * and disk paths cannot ride out to an unauthenticated caller.
 */
export function toolError(message: string): CallToolResult {
  return { content: [{ type: 'text', text: `Error: ${message}` }], isError: true }
}
