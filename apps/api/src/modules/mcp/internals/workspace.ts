/**
 * Public-workspace gate for the MCP surface.
 *
 * POST /api/mcp is unauthenticated on purpose — an MCP client (Claude
 * Code, Cursor) carries no RepoBuddy session. That makes `isPublic` the
 * only access boundary the endpoint has, so every tool taking a
 * `workspaceId` resolves it through `loadPublicWorkspace` here rather
 * than querying `workspaces` itself. One lookup, one filter, nothing
 * for a future tool to forget.
 *
 * A private id and a non-existent id are deliberately indistinguishable
 * in the result (both → `null`): telling a caller "this exists but you
 * cannot see it" would turn the endpoint into a workspace-id oracle.
 */
import { and, desc, eq, ilike } from 'drizzle-orm'
import type { Database } from '#server/db/client'
import { workspaces } from '#server/db/schema'

/**
 * Postgres throws `invalid input syntax for type uuid` on a malformed
 * id rather than returning zero rows, which would surface to the client
 * as an opaque 500. We pre-filter instead.
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Projection of a public workspace — no owner id, no error text. */
export interface McpWorkspace {
  id: string
  name: string
  sourceUrl: string | null
  languages: string[]
  /**
   * Free-form jsonb, NOT a flat counter map: the indexer merges a
   * nested `gitInsights` object into it, and anything added there in
   * future lands here too. Typed as `unknown` on purpose so nobody
   * hands the whole blob to a caller believing it is only numbers —
   * see `publicStats`.
   */
  stats: Record<string, unknown> | null
  status: string
  lastIndexedAt: Date | null
}

/**
 * The only shape of `stats` that leaves this module.
 *
 * `workspaces.stats` is a jsonb blob the pipeline merges into, and one
 * of the things it merges is `gitInsights.topAuthors[]`, which carries
 * contributor e-mail addresses. Returning the blob verbatim from an
 * unauthenticated tool turned `list_workspaces` into a bulk address
 * harvester. Keeping only top-level numbers is an allowlist by
 * construction: a nested object added later cannot leak through it
 * without someone changing this function.
 */
export function publicStats(
  stats: Record<string, unknown> | null,
): Record<string, number> | null {
  if (!stats) return null
  const out: Record<string, number> = {}
  for (const [k, v] of Object.entries(stats)) {
    if (typeof v === 'number' && Number.isFinite(v)) out[k] = v
  }
  return out
}

const WORKSPACE_PROJECTION = {
  id: workspaces.id,
  name: workspaces.name,
  sourceUrl: workspaces.sourceUrl,
  languages: workspaces.languages,
  stats: workspaces.stats,
  status: workspaces.status,
  lastIndexedAt: workspaces.lastIndexedAt,
}

/**
 * Resolve a workspace the MCP endpoint is allowed to read. Returns
 * `null` for anything private, missing, or malformed — the caller turns
 * that into an `isError` tool result.
 *
 * Note this does NOT filter on `status`: a public-but-still-indexing
 * workspace comes back so the caller can say "indexing, try later"
 * instead of "not found", which is a materially different answer for
 * the client's LLM.
 */
export async function loadPublicWorkspace(
  db: Database,
  workspaceId: string,
): Promise<McpWorkspace | null> {
  if (typeof workspaceId !== 'string' || !UUID_RE.test(workspaceId)) return null
  const [row] = await db
    .select(WORKSPACE_PROJECTION)
    .from(workspaces)
    .where(and(eq(workspaces.id, workspaceId), eq(workspaces.isPublic, true)))
    .limit(1)
  if (!row) return null
  return { ...row, stats: (row.stats ?? null) as Record<string, unknown> | null }
}

/**
 * Discovery listing — public + fully indexed only. A half-indexed
 * workspace has no graph worth querying, so surfacing it would just
 * cost the client a round-trip of empty tool results.
 */
export async function listPublicWorkspaces(
  db: Database,
  opts: { query?: string; limit: number },
): Promise<McpWorkspace[]> {
  const conditions = [eq(workspaces.isPublic, true), eq(workspaces.status, 'ready')]
  const needle = opts.query?.trim()
  if (needle) {
    // `%` / `_` in the needle are literal wildcards to ILIKE; escaping
    // them keeps a search for "foo_bar" from matching "fooXbar".
    const escaped = needle.replace(/[\\%_]/g, (c) => `\\${c}`)
    conditions.push(ilike(workspaces.name, `%${escaped}%`))
  }
  const rows = await db
    .select(WORKSPACE_PROJECTION)
    .from(workspaces)
    .where(and(...conditions))
    .orderBy(desc(workspaces.lastIndexedAt))
    .limit(opts.limit)
  return rows.map((r) => ({ ...r, stats: (r.stats ?? null) as Record<string, unknown> | null }))
}
