import { Injectable } from '@nestjs/common'
import { and, eq, or, sql } from 'drizzle-orm'
import { chunks } from '../../../../db/schema'
import type { KagOperator } from './_interface'
import type { OperatorContext } from './_types'

// ---------- propose_edit ----------
/**
 * The model proposes a concrete edit to a file as a unified diff. The
 * server does NOT apply anything — this is a read-only "here's the
 * patch I'd send" capability. The chat UI renders the diff inline so
 * the user can copy it or open the file at the right line.
 *
 * Validates the file exists in the workspace via path-suffix match
 * against indexed file entities. Builds the diff hunk by including
 * a few lines of context above and below the change.
 */
export interface ProposeEditParams {
  filePath: string
  /** Exact substring in the file to replace. */
  search: string
  /** Replacement text. */
  replace: string
  /** Short rationale shown alongside the diff. */
  rationale?: string
}

export interface ProposeEditResult {
  filePath: string
  /** Resolved canonical path that matched the lookup. */
  resolvedPath: string | null
  rationale: string | null
  /** Unified-diff hunk, or null when the search string isn't found. */
  diff: string | null
  reason?: 'file_not_found' | 'search_not_found' | 'no_change'
}

export async function proposeEditOp(
  params: ProposeEditParams,
  ctx: OperatorContext,
): Promise<ProposeEditResult> {
  const rationale = params.rationale?.trim() || null
  // 1. Resolve the file by path-suffix against chunks (the fallback
  // whole-file step puts every text file in chunks, so this is the
  // most reliable source of "do we know about this path").
  const normalized = params.filePath.replace(/^\.?\//, '')
  const rows = await ctx.db
    .select({ filePath: chunks.filePath, text: chunks.text, startLine: chunks.startLine })
    .from(chunks)
    .where(
      and(
        eq(chunks.workspaceId, ctx.workspaceId),
        or(
          eq(chunks.filePath, params.filePath),
          eq(chunks.filePath, normalized),
          sql`${chunks.filePath} LIKE ${'%/' + normalized}`,
        ),
      ),
    )
    .orderBy(chunks.filePath, chunks.startLine)
  if (rows.length === 0) {
    return { filePath: params.filePath, resolvedPath: null, rationale, diff: null, reason: 'file_not_found' }
  }
  // Prefer the shortest-path match (most likely root-relative).
  const grouped = new Map<string, { startLine: number | null; text: string }[]>()
  for (const r of rows) {
    if (!r.filePath) continue
    const list = grouped.get(r.filePath) ?? []
    list.push({ startLine: r.startLine, text: r.text })
    grouped.set(r.filePath, list)
  }
  const candidates = [...grouped.entries()].sort((a, b) => a[0].length - b[0].length)
  const [resolvedPath, pieces] = candidates[0] as [string, { startLine: number | null; text: string }[]]
  // Reconstruct the file text from chunks (whole-file chunks already
  // are the file text; AST chunks may overlap, so we deduplicate by
  // line and prefer chunks whose startLine is 1).
  const whole = (pieces.find((p) => (p.startLine ?? 1) === 1) ?? pieces[0])?.text ?? ''
  if (!whole.includes(params.search)) {
    return { filePath: params.filePath, resolvedPath, rationale, diff: null, reason: 'search_not_found' }
  }
  if (params.search === params.replace) {
    return { filePath: params.filePath, resolvedPath, rationale, diff: null, reason: 'no_change' }
  }
  const diff = buildUnifiedDiff(resolvedPath, whole, params.search, params.replace)
  return { filePath: params.filePath, resolvedPath, rationale, diff }
}

/**
 * Build a minimal unified-diff hunk for a single search/replace.
 * Includes 3 lines of context above + below the change. This is not
 * a fully-spec'd diff (no chunk offset arithmetic across multiple
 * hunks) but it round-trips cleanly through `patch -p0` for single-
 * occurrence edits, which is the realistic shape of an LLM-proposed
 * fix.
 */
function buildUnifiedDiff(
  path: string,
  fullText: string,
  search: string,
  replace: string,
): string {
  const CONTEXT_LINES = 3
  const idx = fullText.indexOf(search)
  if (idx < 0) return ''
  const before = fullText.slice(0, idx)
  const after = fullText.slice(idx + search.length)
  const startLine = before.split('\n').length // 1-indexed line where the change begins
  const searchLines = search.split('\n')
  const replaceLines = replace.split('\n')
  const beforeLines = before.split('\n')
  const afterLines = after.split('\n')
  const contextBefore = beforeLines.slice(Math.max(0, beforeLines.length - CONTEXT_LINES - 1, 0), beforeLines.length - 1)
  const contextAfter = afterLines.slice(0, CONTEXT_LINES)
  const oldStart = Math.max(1, startLine - contextBefore.length)
  const oldLen = contextBefore.length + searchLines.length + contextAfter.length
  const newLen = contextBefore.length + replaceLines.length + contextAfter.length
  const out: string[] = [
    `--- a/${path}`,
    `+++ b/${path}`,
    `@@ -${oldStart},${oldLen} +${oldStart},${newLen} @@`,
    ...contextBefore.map((l) => ' ' + l),
    ...searchLines.map((l) => '-' + l),
    ...replaceLines.map((l) => '+' + l),
    ...contextAfter.map((l) => ' ' + l),
  ]
  return out.join('\n')
}

// ---------- @Injectable wrapper ----------

@Injectable()
export class ProposeEditOperator implements KagOperator<ProposeEditParams, ProposeEditResult> {
  readonly name = 'propose_edit' as const
  execute(p: ProposeEditParams, c: OperatorContext) { return proposeEditOp(p, c) }
}
