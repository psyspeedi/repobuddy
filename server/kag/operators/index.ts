/**
 * KAG operator library. Each operator is an async function over a typed
 * parameter object; the executor (kag/executor.ts) dispatches them by name
 * with substituted params and stores the result.
 *
 * Operators are pure with respect to the database — they read graph state
 * but never mutate it.
 */
import { Octokit } from '@octokit/rest'
import { and, eq, ilike, inArray, or, sql } from 'drizzle-orm'
import type { Database } from '../../db/client'
import { chunks, entities, relations } from '../../db/schema'
import type { EmbeddingsProvider } from '../../providers/embeddings'
import type { LLMProvider } from '../../providers/llm'
import {
  excerptIssueBody,
  extractRefs,
  fetchChunksForEntities,
  lookupEntitiesByRefs,
  type LinkedChunk,
  type LinkedEntity,
} from '../../lib/github-issue-linking'
import { getProjectOverview, type ProjectOverview } from '../../lib/project-overview'
import { hybridSearch } from './hybrid_search'
import { answer, type AnswerStreamChunk } from './answer'

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
}

// ---------- Entity shape exposed to ops ----------
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

// ---------- find_symbol ----------
export interface FindSymbolParams {
  name: string
  type?: string
  fuzzy?: boolean
  limit?: number
}

export async function findSymbol(
  params: FindSymbolParams,
  ctx: OperatorContext,
): Promise<GraphEntity[]> {
  const limit = params.limit ?? 20
  // Planner sometimes calls find_symbol without a `name` for broad
  // questions ("what functions are there"). Treat empty/missing name as
  // "list by type" instead of crashing on .toLowerCase() of undefined.
  const rawName = typeof params.name === 'string' ? params.name.trim() : ''
  if (!rawName) {
    if (!params.type) return []
    return ctx.db
      .select(entityProjection())
      .from(entities)
      .where(
        and(
          eq(entities.workspaceId, ctx.workspaceId),
          eq(entities.type, params.type),
        ),
      )
      .limit(limit)
  }
  const needle = rawName.toLowerCase()

  // Phase 1: exact match (unless caller already requested fuzzy).
  const exactConditions = [
    eq(entities.workspaceId, ctx.workspaceId),
    params.fuzzy
      ? ilike(entities.normalizedName, `%${needle}%`)
      : eq(entities.normalizedName, needle),
  ]
  if (params.type) exactConditions.push(eq(entities.type, params.type))

  const rows = await ctx.db
    .select(entityProjection())
    .from(entities)
    .where(and(...exactConditions))
    .limit(limit)

  // Phase 2: auto-fuzzy fallback. If the planner asked for an exact match
  // and we found nothing, retry with substring match before giving up. This
  // covers TypeScript declaration merging ("ZodBigInt" vs "ZodBigIntDef"),
  // namespaced symbols, and minor casing/transliteration drift in user
  // queries.
  if (rows.length === 0 && !params.fuzzy) {
    const fuzzyConditions = [
      eq(entities.workspaceId, ctx.workspaceId),
      ilike(entities.normalizedName, `%${needle}%`),
    ]
    if (params.type) fuzzyConditions.push(eq(entities.type, params.type))
    return ctx.db
      .select(entityProjection())
      .from(entities)
      .where(and(...fuzzyConditions))
      .limit(limit)
  }
  return rows
}

// ---------- find_file ----------
export interface FindFileParams {
  pathPattern: string
  limit?: number
}

export async function findFile(
  params: FindFileParams,
  ctx: OperatorContext,
): Promise<GraphEntity[]> {
  const limit = params.limit ?? 50
  const pattern = params.pathPattern.replace(/\*/g, '%')
  return ctx.db
    .select(entityProjection())
    .from(entities)
    .where(
      and(
        eq(entities.workspaceId, ctx.workspaceId),
        eq(entities.type, 'file'),
        ilike(entities.filePath, pattern),
      ),
    )
    .limit(limit)
}

// ---------- get_callers / get_callees ----------
interface TraversalParams {
  target?: GraphEntity | GraphEntity[]
  source?: GraphEntity | GraphEntity[]
  transitive?: boolean
  maxDepth?: number
  limit?: number
}

export async function getCallers(
  params: TraversalParams,
  ctx: OperatorContext,
): Promise<GraphEntity[]> {
  const ids = idsFromParam(params.target)
  if (ids.length === 0) return []
  return traverse(ctx, ids, 'calls', 'in', params)
}

export async function getCallees(
  params: TraversalParams,
  ctx: OperatorContext,
): Promise<GraphEntity[]> {
  const ids = idsFromParam(params.source)
  if (ids.length === 0) return []
  return traverse(ctx, ids, 'calls', 'out', params)
}

export async function getDependencies(
  params: TraversalParams,
  ctx: OperatorContext,
): Promise<GraphEntity[]> {
  const ids = idsFromParam(params.source ?? params.target)
  if (ids.length === 0) return []
  return traverse(ctx, ids, 'imports', 'out', params)
}

export async function getDependents(
  params: TraversalParams,
  ctx: OperatorContext,
): Promise<GraphEntity[]> {
  const ids = idsFromParam(params.target ?? params.source)
  if (ids.length === 0) return []
  return traverse(ctx, ids, 'imports', 'in', params)
}

async function traverse(
  ctx: OperatorContext,
  startIds: string[],
  edgeType: string,
  direction: 'in' | 'out',
  params: TraversalParams,
): Promise<GraphEntity[]> {
  const maxDepth = params.transitive ? params.maxDepth ?? 5 : 1
  const limit = params.limit ?? 200
  const visited = new Set<string>()
  let frontier = startIds
  const reached: string[] = []

  for (let depth = 0; depth < maxDepth && frontier.length > 0; depth++) {
    const fromCol = direction === 'in' ? relations.toEntityId : relations.fromEntityId
    const toCol = direction === 'in' ? relations.fromEntityId : relations.toEntityId
    const rows = await ctx.db
      .select({ id: toCol })
      .from(relations)
      .where(
        and(
          eq(relations.workspaceId, ctx.workspaceId),
          eq(relations.type, edgeType),
          inArray(fromCol, frontier),
        ),
      )
      .limit(limit * 2)
    const next: string[] = []
    for (const row of rows) {
      if (visited.has(row.id) || startIds.includes(row.id)) continue
      visited.add(row.id)
      next.push(row.id)
      reached.push(row.id)
      if (reached.length >= limit) break
    }
    frontier = next
    if (reached.length >= limit) break
  }
  if (reached.length === 0) return []
  return ctx.db
    .select(entityProjection())
    .from(entities)
    .where(inArray(entities.id, reached))
    .limit(limit)
}

// ---------- find_implementations ----------
export interface FindImplementationsParams {
  interfaceOrType: GraphEntity
  limit?: number
}

export async function findImplementations(
  params: FindImplementationsParams,
  ctx: OperatorContext,
): Promise<GraphEntity[]> {
  const targetId = params.interfaceOrType?.id
  if (!targetId) return []
  const limit = params.limit ?? 50
  const rows = await ctx.db
    .select(entityProjection())
    .from(entities)
    .innerJoin(relations, eq(relations.fromEntityId, entities.id))
    .where(
      and(
        eq(relations.workspaceId, ctx.workspaceId),
        eq(relations.toEntityId, targetId),
        or(eq(relations.type, 'implements'), eq(relations.type, 'extends'))!,
      ),
    )
    .limit(limit)
  return rows
}

// ---------- git_history ----------
export interface GitHistoryParams {
  entity: GraphEntity
  since?: string
  limit?: number
}

export async function gitHistory(
  params: GitHistoryParams,
  ctx: OperatorContext,
): Promise<{ sha: string; message: string; author: string; date: string }[]> {
  const fileId = params.entity?.id
  if (!fileId) return []
  const limit = params.limit ?? 50
  const sinceClause = params.since
    ? sql`AND (c.metadata->>'date')::timestamptz >= ${params.since}::timestamptz`
    : sql``
  const rows = await ctx.db.execute<{
    sha: string
    message: string
    author: string
    date: string
  }>(sql`
    SELECT
      c.metadata->>'sha'      AS sha,
      c.metadata->>'message'  AS message,
      c.metadata->>'author'   AS author,
      c.metadata->>'date'     AS date
    FROM ${entities} c
    INNER JOIN ${relations} r
      ON r.from_entity_id = c.id
     AND r.type = 'modified_by'
     AND r.to_entity_id = ${fileId}
    WHERE c.workspace_id = ${ctx.workspaceId}
      AND c.type = 'commit'
      ${sinceClause}
    ORDER BY (c.metadata->>'date')::timestamptz DESC
    LIMIT ${limit}
  `)
  return [...rows]
}

// ---------- find_by_concept ----------
export interface FindByConceptParams {
  query: string
  limit?: number
}

export async function findByConcept(
  params: FindByConceptParams,
  ctx: OperatorContext,
): Promise<GraphEntity[]> {
  const limit = params.limit ?? 10
  const [vec] = await ctx.embeddings.embedBatch([params.query])
  if (!vec) return []
  const literal = `[${vec.join(',')}]`
  return ctx.db.execute<GraphEntity>(sql`
    SELECT id, type, name, qualified_name AS "qualifiedName",
           file_path AS "filePath", start_line AS "startLine",
           end_line AS "endLine", language, description
    FROM ${entities}
    WHERE workspace_id = ${ctx.workspaceId}
      AND embedding IS NOT NULL
    ORDER BY embedding <=> ${literal}::vector ASC
    LIMIT ${limit}
  `) as unknown as Promise<GraphEntity[]>
}

// ---------- vector_search_chunks ----------
export interface VectorSearchParams {
  query: string
  limit?: number
}

export async function vectorSearchChunks(
  params: VectorSearchParams,
  ctx: OperatorContext,
): Promise<{ id: string; text: string; filePath: string | null; startLine: number | null; endLine: number | null }[]> {
  const limit = params.limit ?? 10
  const [vec] = await ctx.embeddings.embedBatch([params.query])
  if (!vec) return []
  const literal = `[${vec.join(',')}]`
  const rows = await ctx.db.execute<{
    id: string
    text: string
    file_path: string | null
    start_line: number | null
    end_line: number | null
  }>(sql`
    SELECT id, text, file_path, start_line, end_line
    FROM ${chunks}
    WHERE workspace_id = ${ctx.workspaceId} AND embedding IS NOT NULL
    ORDER BY embedding <=> ${literal}::vector ASC
    LIMIT ${limit}
  `)
  return rows.map((r) => ({
    id: r.id,
    text: r.text,
    filePath: r.file_path,
    startLine: r.start_line,
    endLine: r.end_line,
  }))
}

// ---------- hybrid_search wrapper ----------
export async function hybridSearchOp(
  params: { query: string; limit?: number },
  ctx: OperatorContext,
) {
  return hybridSearch(ctx.db, ctx.embeddings, {
    workspaceId: ctx.workspaceId,
    query: params.query,
    limit: params.limit,
  })
}

// ---------- search_docs ----------
// Same retrieval mechanics as hybrid_search but restricted to chunks whose
// source_type is 'doc' (markdown / PR descriptions). Used by the planner for
// broad / architectural / "tell me about X" questions where README and design
// notes are likelier to ground a good answer than raw code.
export async function searchDocs(
  params: { query: string; limit?: number },
  ctx: OperatorContext,
): Promise<
  {
    id: string
    text: string
    filePath: string | null
    startLine: number | null
    endLine: number | null
    score: number
  }[]
> {
  const limit = params.limit ?? 12
  const fetchLimit = limit * 4
  const [vec] = await ctx.embeddings.embedBatch([params.query])
  if (!vec) return []
  const vecLiteral = `[${vec.join(',')}]`

  const vectorRows = await ctx.db.execute<{
    id: string
    text: string
    file_path: string | null
    start_line: number | null
    end_line: number | null
    rank: number
  }>(sql`
    SELECT id, text, file_path, start_line, end_line,
           row_number() OVER (ORDER BY embedding <=> ${vecLiteral}::vector ASC) AS rank
    FROM ${chunks}
    WHERE workspace_id = ${ctx.workspaceId}
      AND source_type = 'doc'
      AND embedding IS NOT NULL
    ORDER BY embedding <=> ${vecLiteral}::vector ASC
    LIMIT ${fetchLimit}
  `)

  const textRows = await ctx.db.execute<{
    id: string
    text: string
    file_path: string | null
    start_line: number | null
    end_line: number | null
    rank: number
  }>(sql`
    SELECT id, text, file_path, start_line, end_line,
           row_number() OVER (
             ORDER BY ts_rank(text_tsv, websearch_to_tsquery('english', ${params.query})) DESC
           ) AS rank
    FROM ${chunks}
    WHERE workspace_id = ${ctx.workspaceId}
      AND source_type = 'doc'
      AND text_tsv @@ websearch_to_tsquery('english', ${params.query})
    ORDER BY ts_rank(text_tsv, websearch_to_tsquery('english', ${params.query})) DESC
    LIMIT ${fetchLimit}
  `)

  const RRF_K = 60
  const merged = new Map<string, {
    text: string
    filePath: string | null
    startLine: number | null
    endLine: number | null
    score: number
  }>()
  for (const row of vectorRows) {
    merged.set(row.id, {
      text: row.text,
      filePath: row.file_path,
      startLine: row.start_line,
      endLine: row.end_line,
      score: 1 / (RRF_K + Number(row.rank)),
    })
  }
  for (const row of textRows) {
    const rank = Number(row.rank)
    const existing = merged.get(row.id)
    if (existing) existing.score += 1 / (RRF_K + rank)
    else
      merged.set(row.id, {
        text: row.text,
        filePath: row.file_path,
        startLine: row.start_line,
        endLine: row.end_line,
        score: 1 / (RRF_K + rank),
      })
  }
  return [...merged.entries()]
    .map(([id, v]) => ({ id, ...v }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
}

// ---------- retrieve_code_chunks ----------
export interface RetrieveCodeChunksParams {
  entities: GraphEntity | GraphEntity[]
  limit?: number
}

export async function retrieveCodeChunks(
  params: RetrieveCodeChunksParams,
  ctx: OperatorContext,
): Promise<{ id: string; text: string; filePath: string | null; startLine: number | null; endLine: number | null }[]> {
  const list = Array.isArray(params.entities) ? params.entities : [params.entities]
  const ids = list.map((e) => e?.id).filter((id): id is string => Boolean(id))
  if (ids.length === 0) return []
  const limit = params.limit ?? 50
  const rows = await ctx.db.execute<{
    id: string
    text: string
    file_path: string | null
    start_line: number | null
    end_line: number | null
  }>(sql`
    SELECT DISTINCT c.id, c.text, c.file_path, c.start_line, c.end_line
    FROM ${chunks} c
    INNER JOIN entity_chunks ec ON ec.chunk_id = c.id
    WHERE c.workspace_id = ${ctx.workspaceId}
      AND ec.entity_id = ANY (ARRAY[${sql.join(ids.map((id) => sql`${id}::uuid`), sql`, `)}])
    LIMIT ${limit}
  `)
  return rows.map((r) => ({
    id: r.id,
    text: r.text,
    filePath: r.file_path,
    startLine: r.start_line,
    endLine: r.end_line,
  }))
}

// ---------- get_summary ----------
export interface GetSummaryParams {
  entity: GraphEntity | GraphEntity[]
}

export async function getSummary(
  params: GetSummaryParams,
  ctx: OperatorContext,
): Promise<{ id: string; name: string; type: string; description: string | null }[]> {
  const list = Array.isArray(params.entity) ? params.entity : [params.entity]
  const ids = list.map((e) => e?.id).filter((id): id is string => Boolean(id))
  if (ids.length === 0) return []
  return ctx.db
    .select({
      id: entities.id,
      name: entities.name,
      type: entities.type,
      description: entities.description,
    })
    .from(entities)
    .where(and(eq(entities.workspaceId, ctx.workspaceId), inArray(entities.id, ids)))
}

// ---------- walkthrough ----------
/**
 * Single-target operator that gathers everything needed for a "walk me
 * through how X works" answer: the entity itself, its direct callees,
 * its tests (incoming `tested_by`), and its inbound `defined_in` /
 * `contained_in` parent for context. The planner pairs this with
 * retrieve_code_chunks → answer for a structured tour.
 */
export interface WalkthroughParams {
  entity: GraphEntity | GraphEntity[]
  /** Cap on neighbours returned per side (callees, tests, parents). */
  limit?: number
}

export interface WalkthroughResult {
  /**
   * Flat de-duped list of every entity touched by the walkthrough
   * (target + callees + tests + parents). Kept as a top-level field
   * so answer's context.flat(2) loop still sees them as entities
   * after a passing flatten.
   */
  entities: GraphEntity[]
  /**
   * Mermaid sequence diagram in source form. The answer operator
   * inlines it into the user prompt with an instruction for the model
   * to include the fenced block verbatim. The ChatMessage component
   * lazy-loads mermaid to render it on the client.
   */
  mermaid: string
}

function sanitiseMermaidLabel(s: string): string {
  // Mermaid actor / participant names can't contain spaces or quotes
  // without aliasing — and aliasing every label noise-bloats the
  // diagram. Strip everything that isn't alphanumeric/underscore.
  return s.replace(/[^A-Za-z0-9_]/g, '_').slice(0, 48) || 'unknown'
}

function buildMermaidSequence(
  target: GraphEntity,
  callees: GraphEntity[],
  tests: GraphEntity[],
): string {
  const lines: string[] = ['sequenceDiagram']
  const root = sanitiseMermaidLabel(target.name)
  lines.push(`    participant Caller`)
  lines.push(`    participant ${root}`)
  lines.push(`    Caller->>+${root}: invoke`)
  for (const c of callees.slice(0, 8)) {
    const label = sanitiseMermaidLabel(c.name)
    lines.push(`    ${root}->>+${label}: ${c.type === 'function' ? 'call' : 'use'}`)
    lines.push(`    ${label}-->>-${root}: ok`)
  }
  lines.push(`    ${root}-->>-Caller: return`)
  for (const t of tests.slice(0, 4)) {
    const label = sanitiseMermaidLabel(t.name)
    lines.push(`    Note over ${root}: covered by ${label}`)
  }
  return lines.join('\n')
}

export async function walkthrough(
  params: WalkthroughParams,
  ctx: OperatorContext,
): Promise<WalkthroughResult> {
  const list = Array.isArray(params.entity) ? params.entity : [params.entity]
  const targets = list.filter((e): e is GraphEntity => Boolean(e?.id))
  if (targets.length === 0) return { entities: [], mermaid: '' }
  const limit = params.limit ?? 20

  const seen = new Set<string>()
  const entities: GraphEntity[] = []
  const pushUnique = (e: GraphEntity | undefined): void => {
    if (!e?.id || seen.has(e.id)) return
    seen.add(e.id)
    entities.push(e)
  }
  // Build the diagram around the FIRST target. Multiple targets is
  // an edge case (planner usually find_symbol's a single name) — for
  // those we render one diagram and treat the rest as entity context.
  const primary = targets[0]
  if (!primary) return { entities: [], mermaid: '' }

  const [primaryCallees, primaryTests] = await Promise.all([
    traverse(ctx, [primary.id], 'calls', 'out', { limit }),
    traverse(ctx, [primary.id], 'tested_by', 'out', { limit }),
  ])
  pushUnique(primary)
  for (const e of primaryCallees) pushUnique(e)
  for (const e of primaryTests) pushUnique(e)
  const [primaryParents] = await Promise.all([
    traverse(ctx, [primary.id], 'contained_in', 'out', { limit: 3 }),
  ])
  for (const e of primaryParents) pushUnique(e)

  // Pull supporting graph for any other targets without rebuilding
  // their own diagrams — entities still go into context.
  for (const t of targets.slice(1)) {
    pushUnique(t)
    const [callees, tests, parents] = await Promise.all([
      traverse(ctx, [t.id], 'calls', 'out', { limit }),
      traverse(ctx, [t.id], 'tested_by', 'out', { limit }),
      traverse(ctx, [t.id], 'contained_in', 'out', { limit: 3 }),
    ])
    for (const e of callees) pushUnique(e)
    for (const e of tests) pushUnique(e)
    for (const e of parents) pushUnique(e)
  }

  return {
    entities,
    mermaid: buildMermaidSequence(primary, primaryCallees, primaryTests),
  }
}

// ---------- list_issues ----------
/**
 * Fetch GitHub issues for the workspace's source repo and link them
 * back to indexed code. The envelope returned here travels into
 * answerOp, which renders:
 *   - the issue list with #N / labels / URL / body excerpt,
 *   - the matched code entities + their chunks so the model can
 *     ground its answer in real source.
 *
 * Two modes:
 *   - issueNumber set: fetch that single issue (octokit.issues.get)
 *   - otherwise: list open issues, optionally filtered by labels
 *
 * Anonymous Octokit (60 req/h per IP).
 */
export interface ListIssuesParams {
  /** Optional label filter. Defaults to a broad open-issue scan. */
  labels?: string[]
  state?: 'open' | 'closed' | 'all'
  /** Cap on results. Default 15, max 30. Ignored when issueNumber set. */
  limit?: number
  /** Focus a single issue by number — answers "tell me about #42". */
  issueNumber?: number
}

export interface IssueResult {
  number: number
  title: string
  url: string
  labels: string[]
  bodyExcerpt: string
  updatedAt: string
  /** Entities the issue text mentions that exist in the graph. */
  relatedEntities: LinkedEntity[]
}

export interface IssuesEnvelope {
  /** Marker for answerOp's context loop. */
  issues: IssueResult[]
  /**
   * De-duped chunks linked to every issue's relatedEntities. answerOp
   * lifts them into the main `chunks` list so [chunk:UUID] citations
   * work in the answer.
   */
  relatedChunks: LinkedChunk[]
  /** Diagnostic — surfaced in trace, never goes into the LLM prompt. */
  reason?: 'no_source_url' | 'not_github' | 'rate_limited' | 'repo_not_found' | 'fetch_failed'
}

const KAG_GH_URL_RE = /github\.com\/([^/]+)\/([^/.]+)/

export async function listIssues(
  params: ListIssuesParams,
  ctx: OperatorContext,
): Promise<IssuesEnvelope> {
  const sourceUrl = ctx.workspace?.sourceUrl ?? null
  if (!sourceUrl) return { issues: [], relatedChunks: [], reason: 'no_source_url' }
  const match = sourceUrl.match(KAG_GH_URL_RE)
  if (!match) return { issues: [], relatedChunks: [], reason: 'not_github' }
  const owner = match[1] as string
  const repo = match[2] as string
  const limit = Math.min(Math.max(params.limit ?? 15, 1), 30)
  const labels = params.labels && params.labels.length > 0
    ? params.labels.join(',')
    : undefined

  const octokit = new Octokit()
  let rawIssues: Awaited<ReturnType<typeof octokit.rest.issues.listForRepo>>['data']
  try {
    if (params.issueNumber) {
      const single = await octokit.rest.issues.get({
        owner,
        repo,
        issue_number: params.issueNumber,
      })
      // Single-issue fetch returns one object — wrap to keep the same
      // downstream pipeline.
      rawIssues = [single.data] as typeof rawIssues
    } else {
      let res = await octokit.rest.issues.listForRepo({
        owner,
        repo,
        state: params.state ?? 'open',
        labels,
        per_page: limit,
        sort: 'updated',
        direction: 'desc',
      })
      // Many repos don't use canonical contributor labels; fall back
      // to ALL open issues so we surface something.
      if (res.data.length === 0 && labels) {
        res = await octokit.rest.issues.listForRepo({
          owner,
          repo,
          state: params.state ?? 'open',
          per_page: limit,
          sort: 'updated',
          direction: 'desc',
        })
      }
      rawIssues = res.data
    }
  } catch (err) {
    const status = (err as { status?: number }).status ?? 0
    return {
      issues: [],
      relatedChunks: [],
      reason: status === 403 ? 'rate_limited' : status === 404 ? 'repo_not_found' : 'fetch_failed',
    }
  }

  // Drop PRs from list mode (the issues endpoint returns both).
  const issuesOnly = rawIssues.filter((i) => !('pull_request' in i && i.pull_request))
  if (issuesOnly.length === 0) return { issues: [], relatedChunks: [] }

  // Collect refs across all issues so we lookup entities once.
  const allRefs = new Set<string>()
  const refsPerIssue = new Map<number, Set<string>>()
  for (const i of issuesOnly) {
    const text = `${i.title}\n${i.body ?? ''}`
    const refs = extractRefs(text)
    refsPerIssue.set(i.number, refs)
    for (const r of refs) allRefs.add(r)
  }
  const entityMatches = allRefs.size > 0
    ? await lookupEntitiesByRefs(ctx.db, ctx.workspaceId, [...allRefs])
    : new Map<string, LinkedEntity[]>()

  // Build per-issue relatedEntities by walking that issue's refs.
  const allRelatedEntityIds = new Set<string>()
  const finalIssues: IssueResult[] = issuesOnly.slice(0, limit).map((i) => {
    const refs = refsPerIssue.get(i.number) ?? new Set<string>()
    const linked = new Map<string, LinkedEntity>()
    for (const r of refs) {
      const hits = entityMatches.get(r.toLowerCase()) ?? []
      for (const e of hits) linked.set(e.entityId, e)
    }
    const related = [...linked.values()].slice(0, 8)
    for (const e of related) allRelatedEntityIds.add(e.entityId)
    return {
      number: i.number,
      title: i.title,
      url: i.html_url,
      labels: (i.labels ?? [])
        .map((l) => (typeof l === 'string' ? l : (l.name ?? '')))
        .filter(Boolean),
      bodyExcerpt: excerptIssueBody(i.body ?? ''),
      updatedAt: i.updated_at,
      relatedEntities: related,
    }
  })

  const relatedChunks = allRelatedEntityIds.size > 0
    ? await fetchChunksForEntities(ctx.db, ctx.workspaceId, [...allRelatedEntityIds])
    : []

  return { issues: finalIssues, relatedChunks }
}

// ---------- list_prs ----------
/**
 * Open / merged GitHub pull requests from the workspace repo. Same
 * Octokit-anonymous budget as list_issues. Lives outside the graph
 * (no schema for PR entities yet) — fetched on demand.
 *
 * Two modes:
 *   - prNumber set: fetch single PR (with linked issue refs from body)
 *   - otherwise: list PRs filtered by state / labels
 *
 * Use cases:
 *   - "how was a similar issue fixed?" → list_prs({state:'closed'}) then
 *     scan titles / linked issues for the same area
 *   - "what's the recent work in module X?" → list_prs + filter client-
 *     side by mentioned file paths
 *   - "show me PR #42" → list_prs({prNumber:42})
 */
export interface ListPrsParams {
  state?: 'open' | 'closed' | 'all'
  labels?: string[]
  limit?: number
  prNumber?: number
}

export interface PrResult {
  number: number
  title: string
  url: string
  state: 'open' | 'closed'
  merged: boolean
  mergedAt: string | null
  author: string | null
  bodyExcerpt: string
  labels: string[]
  /** Issue numbers the PR body references via `fixes #N` / `closes #N`. */
  referencedIssues: number[]
  updatedAt: string
}

export interface PrsEnvelope {
  prs: PrResult[]
  reason?: 'no_source_url' | 'not_github' | 'rate_limited' | 'repo_not_found' | 'fetch_failed'
}

const FIX_REF_RE = /(?:fix(?:es|ed)?|close[sd]?|resolve[sd]?)\s+#(\d{1,7})/gi

export async function listPrs(
  params: ListPrsParams,
  ctx: OperatorContext,
): Promise<PrsEnvelope> {
  const sourceUrl = ctx.workspace?.sourceUrl ?? null
  if (!sourceUrl) return { prs: [], reason: 'no_source_url' }
  const match = sourceUrl.match(KAG_GH_URL_RE)
  if (!match) return { prs: [], reason: 'not_github' }
  const owner = match[1] as string
  const repo = match[2] as string
  const limit = Math.min(Math.max(params.limit ?? 15, 1), 30)

  const octokit = new Octokit()
  try {
    if (params.prNumber) {
      const single = await octokit.rest.pulls.get({
        owner,
        repo,
        pull_number: params.prNumber,
      })
      return { prs: [normalisePr(single.data)] }
    }
    const res = await octokit.rest.pulls.list({
      owner,
      repo,
      state: params.state ?? 'all',
      per_page: limit,
      sort: 'updated',
      direction: 'desc',
    })
    // Octokit's list endpoint returns leaner shape (no body for closed
    // ones in some cases); still has the fields we need.
    return { prs: res.data.map(normalisePr) }
  } catch (err) {
    const status = (err as { status?: number }).status ?? 0
    return {
      prs: [],
      reason: status === 403 ? 'rate_limited' : status === 404 ? 'repo_not_found' : 'fetch_failed',
    }
  }
}

function normalisePr(p: Record<string, unknown>): PrResult {
  const body = typeof p.body === 'string' ? p.body : ''
  const refs = new Set<number>()
  for (const m of body.matchAll(FIX_REF_RE)) {
    const n = Number(m[1])
    if (Number.isFinite(n)) refs.add(n)
  }
  const labels = Array.isArray(p.labels)
    ? p.labels.map((l: unknown) => (typeof l === 'string' ? l : (l as { name?: string }).name ?? '')).filter(Boolean)
    : []
  return {
    number: p.number as number,
    title: p.title as string,
    url: p.html_url as string,
    state: p.state as 'open' | 'closed',
    merged: Boolean(p.merged_at),
    mergedAt: (p.merged_at as string | null) ?? null,
    author: ((p.user as { login?: string } | null)?.login) ?? null,
    bodyExcerpt: excerptIssueBody(body),
    labels,
    referencedIssues: [...refs],
    updatedAt: p.updated_at as string,
  }
}

// ---------- find_similar_issues ----------
/**
 * Given a target issue (by number) or free-text query, find the most
 * similar issues from the repo by embedding cosine similarity over
 * title + body excerpt.
 *
 * On-the-fly: each call fetches up to 60 open+closed issues from
 * GitHub, embeds them in one batch via the workspace's configured
 * embeddings provider, picks top-K. Cost: ~$0.003 per call on
 * text-embedding-3-small. No persistence yet — cache later if usage
 * picks up.
 */
export interface FindSimilarIssuesParams {
  issueNumber?: number
  query?: string
  /** Max results. Default 5, max 10. */
  limit?: number
}

export interface SimilarIssueResult {
  number: number
  title: string
  url: string
  similarity: number
  state: 'open' | 'closed'
  bodyExcerpt: string
  labels: string[]
}

export async function findSimilarIssues(
  params: FindSimilarIssuesParams,
  ctx: OperatorContext,
): Promise<{ similar: SimilarIssueResult[]; reason?: string }> {
  const sourceUrl = ctx.workspace?.sourceUrl ?? null
  if (!sourceUrl) return { similar: [], reason: 'no_source_url' }
  const match = sourceUrl.match(KAG_GH_URL_RE)
  if (!match) return { similar: [], reason: 'not_github' }
  const owner = match[1] as string
  const repo = match[2] as string
  const limit = Math.min(Math.max(params.limit ?? 5, 1), 10)
  const octokit = new Octokit()

  // 1. Resolve target text.
  let targetText: string
  let targetNumber: number | null = null
  if (params.issueNumber) {
    try {
      const single = await octokit.rest.issues.get({
        owner, repo, issue_number: params.issueNumber,
      })
      targetText = `${single.data.title}\n\n${single.data.body ?? ''}`
      targetNumber = params.issueNumber
    } catch {
      return { similar: [], reason: 'fetch_failed' }
    }
  } else if (params.query && params.query.trim().length > 0) {
    targetText = params.query.trim()
  } else {
    return { similar: [], reason: 'no_target' }
  }

  // 2. Fetch a pool of candidate issues. Open + closed, recent activity.
  let pool: Awaited<ReturnType<typeof octokit.rest.issues.listForRepo>>['data']
  try {
    const res = await octokit.rest.issues.listForRepo({
      owner, repo, state: 'all', per_page: 60, sort: 'updated', direction: 'desc',
    })
    pool = res.data.filter((i) => !('pull_request' in i && i.pull_request))
    if (targetNumber !== null) pool = pool.filter((i) => i.number !== targetNumber)
  } catch (err) {
    const status = (err as { status?: number }).status ?? 0
    return { similar: [], reason: status === 403 ? 'rate_limited' : 'fetch_failed' }
  }
  if (pool.length === 0) return { similar: [] }

  // 3. Embed in one batch. Most providers accept arrays; ours does.
  const texts = [targetText, ...pool.map((i) => `${i.title}\n\n${i.body ?? ''}`.slice(0, 4000))]
  const embeddings = await ctx.embeddings.embedBatch(texts)
  const targetVec = embeddings[0]
  if (!targetVec) return { similar: [] }
  const candidateVecs = embeddings.slice(1)

  // 4. Cosine similarity, top-K. We assume the provider returns
  // already-normalised vectors; if not, dot-product still ranks
  // consistently within one batch (norm cancels in ordering).
  const scored = pool.map((i, idx) => {
    const v = candidateVecs[idx]
    return {
      issue: i,
      score: v ? cosine(targetVec, v) : 0,
    }
  })
  scored.sort((a, b) => b.score - a.score)
  return {
    similar: scored.slice(0, limit).map(({ issue, score }) => ({
      number: issue.number,
      title: issue.title,
      url: issue.html_url,
      similarity: Math.round(score * 1000) / 1000,
      state: issue.state as 'open' | 'closed',
      bodyExcerpt: excerptIssueBody(issue.body ?? ''),
      labels: (issue.labels ?? [])
        .map((l) => (typeof l === 'string' ? l : (l.name ?? '')))
        .filter(Boolean),
    })),
  }
}

function cosine(a: number[], b: number[]): number {
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < a.length; i++) {
    const av = a[i] ?? 0
    const bv = b[i] ?? 0
    dot += av * bv
    na += av * av
    nb += bv * bv
  }
  if (na === 0 || nb === 0) return 0
  return dot / (Math.sqrt(na) * Math.sqrt(nb))
}

// ---------- tests_for ----------
/**
 * Given one or more entities (functions, classes, files), return the
 * test entities that cover them via `tested_by` relations the indexer
 * derives during phase 2. Answers "if I change X, which tests should
 * I run?" — a daily question for contributors. Cheap (one SQL on an
 * indexed column), no LLM cost.
 */
export interface TestsForParams {
  /** Entity or array of entities returned by find_symbol / walkthrough. */
  entity?: GraphEntity | GraphEntity[]
  /** Alias for `entity` — some planners say `target`. */
  target?: GraphEntity | GraphEntity[]
  /** Max test entities to return. Default 20. */
  limit?: number
}

export async function testsFor(
  params: TestsForParams,
  ctx: OperatorContext,
): Promise<GraphEntity[]> {
  const ids = idsFromParam(params.entity ?? params.target)
  if (ids.length === 0) return []
  const limit = Math.min(Math.max(params.limit ?? 20, 1), 50)
  // `tested_by` is emitted by deriveTestedByRelations: from = test
  // file entity, to = covered entity. So for a given covered entity
  // we follow the inbound edge.
  const idsArray = sql`ARRAY[${sql.join(ids.map((id) => sql`${id}`), sql`, `)}]::uuid[]`
  const rows = await ctx.db.execute<{
    id: string
    type: string
    name: string
    qualified_name: string | null
    file_path: string | null
    start_line: number | null
    end_line: number | null
    language: string | null
    description: string | null
  }>(sql`
    SELECT DISTINCT e.id, e.type, e.name, e.qualified_name, e.file_path,
           e.start_line, e.end_line, e.language, e.description
    FROM ${relations} r
    INNER JOIN ${entities} e ON e.id = r.from_entity_id
    WHERE r.workspace_id = ${ctx.workspaceId}
      AND r.type = 'tested_by'
      AND r.to_entity_id = ANY(${idsArray})
    LIMIT ${limit}
  `)
  return rows.map((r) => ({
    id: r.id,
    type: r.type,
    name: r.name,
    qualifiedName: r.qualified_name,
    filePath: r.file_path,
    startLine: r.start_line,
    endLine: r.end_line,
    language: r.language,
    description: r.description,
  }))
}

// ---------- list_concepts ----------
/**
 * Surface the project's domain glossary — concept entities created
 * by the LLM annotation step during indexing (e.g. "Realm", "Hub",
 * "Workspace", project-specific jargon). Without these a newcomer
 * can't parse issues. Ordered by how many other entities link to
 * each concept (proxy for "how central is this term").
 */
export interface ListConceptsParams {
  /** Optional substring filter applied to name / description. */
  query?: string
  /** Max concepts to return. Default 20. */
  limit?: number
}

export async function listConcepts(
  params: ListConceptsParams,
  ctx: OperatorContext,
): Promise<GraphEntity[]> {
  const limit = Math.min(Math.max(params.limit ?? 20, 1), 50)
  const filter = params.query?.trim() ?? ''
  const filterExpr = filter
    ? sql`AND (lower(e.name) LIKE ${'%' + filter.toLowerCase() + '%'} OR lower(coalesce(e.description, '')) LIKE ${'%' + filter.toLowerCase() + '%'})`
    : sql``
  const rows = await ctx.db.execute<{
    id: string
    type: string
    name: string
    qualified_name: string | null
    description: string | null
    in_degree: number
  }>(sql`
    SELECT e.id, e.type, e.name, e.qualified_name, e.description,
           coalesce((SELECT count(*) FROM ${relations} r WHERE r.to_entity_id = e.id AND r.workspace_id = e.workspace_id), 0)::int AS in_degree
    FROM ${entities} e
    WHERE e.workspace_id = ${ctx.workspaceId}
      AND e.type IN ('concept', 'pattern', 'decision')
      ${filterExpr}
    ORDER BY in_degree DESC, e.name ASC
    LIMIT ${limit}
  `)
  return rows.map((r) => ({
    id: r.id,
    type: r.type,
    name: r.name,
    qualifiedName: r.qualified_name,
    filePath: null,
    startLine: null,
    endLine: null,
    language: null,
    description: r.description,
  }))
}

// ---------- read_file ----------
/**
 * Return all chunks for a given file path. Matches by exact path OR
 * by path-suffix when no exact hit (so the LLM can say "tsconfig.json"
 * without the full prefix). Lets the agentic loop literally open a
 * file when it knows what it wants, without going through entity
 * lookup → entity_chunks resolution.
 */
export interface ReadFileParams {
  path: string
  /** Limit number of returned chunks. Default 6 (= ~6×~5KB sections). */
  limit?: number
}

export async function readFileOp(
  params: ReadFileParams,
  ctx: OperatorContext,
): Promise<{ filePath: string; chunks: { id: string; text: string; startLine: number | null; endLine: number | null }[] }[]> {
  if (!params.path || typeof params.path !== 'string') return []
  const limit = Math.min(Math.max(params.limit ?? 6, 1), 20)
  const normalized = params.path.replace(/^\.?\//, '')
  // Try exact match first, then suffix fall-back. Group results by
  // file_path so the LLM sees coherent file content even when chunks
  // got split.
  const rows = await ctx.db
    .select({
      id: chunks.id,
      filePath: chunks.filePath,
      text: chunks.text,
      startLine: chunks.startLine,
      endLine: chunks.endLine,
    })
    .from(chunks)
    .where(
      and(
        eq(chunks.workspaceId, ctx.workspaceId),
        or(
          eq(chunks.filePath, params.path),
          eq(chunks.filePath, normalized),
          sql`${chunks.filePath} LIKE ${'%/' + normalized}`,
          sql`${chunks.filePath} LIKE ${'%' + normalized}`,
        ),
      ),
    )
    .orderBy(chunks.filePath, chunks.startLine)
    .limit(limit * 4)
  // Group by filePath and cap per file.
  const grouped = new Map<string, { id: string; text: string; startLine: number | null; endLine: number | null }[]>()
  for (const r of rows) {
    if (!r.filePath) continue
    const list = grouped.get(r.filePath) ?? []
    if (list.length >= limit) continue
    list.push({ id: r.id, text: r.text, startLine: r.startLine, endLine: r.endLine })
    grouped.set(r.filePath, list)
  }
  // Prefer files whose path matches more closely (shorter = more
  // likely to be the root-relative target the user named).
  return [...grouped.entries()]
    .sort((a, b) => a[0].length - b[0].length)
    .slice(0, 5)
    .map(([filePath, list]) => ({ filePath, chunks: list }))
}

// ---------- get_project_overview ----------
/**
 * Returns a structured snapshot of the workspace — entrypoints, core
 * abstractions (top by in-degree), safe-first-PR zones, hot files, and
 * entity-type stats. The planner uses this for broad "tell me about
 * this project / where do I start" questions and as grounding for
 * answers that need a sense of scale before diving deeper.
 *
 * Same helper that powers the Tour overlay — single source of truth.
 */
export interface ProjectOverviewParams {
  /** No params yet — the operator is intentionally parameterless so
   * the planner can call it unconditionally for orientation. */
  _?: never
}

export async function getProjectOverviewOp(
  _params: ProjectOverviewParams,
  ctx: OperatorContext,
): Promise<ProjectOverview> {
  return getProjectOverview(ctx.db, ctx.workspaceId)
}

// ---------- answer wrapper for plan executor ----------
export async function* answerOp(
  params: {
    question: string
    context: unknown[]
    style?: 'concise' | 'detailed'
  },
  ctx: OperatorContext,
): AsyncGenerator<AnswerStreamChunk> {
  const chunks: { id: string; text: string; filePath?: string | null; startLine?: number | null; endLine?: number | null }[] = []
  const entitiesContext: {
    id: string
    name: string
    type: string
    description?: string | null
    qualifiedName?: string | null
    metadata?: Record<string, unknown> | null
    filePath?: string | null
    startLine?: number | null
    endLine?: number | null
    language?: string | null
    signature?: string | null
  }[] = []

  const seenEntityIds = new Set<string>()
  const seenChunkIds = new Set<string>()
  // Mermaid blocks contributed by walkthrough operator runs. Inlined
  // into the user prompt with an instruction to include them verbatim.
  const mermaidBlocks: string[] = []
  // GitHub issues collected from list_issues envelopes. Rendered as a
  // dedicated section in the user prompt; the model is asked to cite
  // issue numbers (#42) in its answer.
  const issueResults: IssueResult[] = []
  // Project overview from get_project_overview operator. Surfaced in
  // the prompt with entrypoints + core abstractions + stats so the
  // model can ground broad/orientation questions.
  let overview: ProjectOverview | null = null

  // 1a) Pinned entities from the user's [entity:UUID] citations always go
  //     in first — they're the most likely thing the user wants summarised.
  //     We strip metadata.diff because the per-file content is also coming
  //     in as pinned chunks below; duplicating it would inflate the prompt
  //     and bias the model to cite the entity (◆) instead of the chunks (↗).
  for (const pinned of ctx.pinnedEntities ?? []) {
    seenEntityIds.add(pinned.id)
    const cleanedMeta = pinned.metadata
      ? stripInlineDiff(pinned.metadata)
      : pinned.metadata
    entitiesContext.push({ ...pinned, metadata: cleanedMeta })
  }

  // 1b) Pinned chunks (those linked to pinned entities via entity_chunks).
  //     These give the model citable [chunk:UUID] anchors that resolve to
  //     the source viewer rather than the graph.
  for (const pc of ctx.pinnedChunks ?? []) {
    if (seenChunkIds.has(pc.id)) continue
    seenChunkIds.add(pc.id)
    chunks.push({
      id: pc.id,
      text: pc.text,
      filePath: pc.filePath,
      startLine: pc.startLine,
      endLine: pc.endLine,
    })
  }

  for (const item of params.context.flat(2)) {
    if (!item || typeof item !== 'object') continue
    const obj = item as Record<string, unknown>
    // get_project_overview envelope: detected by the presence of
    // entrypoints + coreAbstractions + stats keys together (other
    // envelopes carry one or two but never this combo).
    if (
      Array.isArray(obj.entrypoints)
      && Array.isArray(obj.coreAbstractions)
      && obj.stats && typeof obj.stats === 'object'
    ) {
      overview = obj as unknown as ProjectOverview
      // Lift abstraction entities into the entity context so the model
      // can cite [entity:UUID] when summarising what depends on what.
      for (const e of overview.coreAbstractions ?? []) {
        if (seenEntityIds.has(e.id)) continue
        seenEntityIds.add(e.id)
        entitiesContext.push({
          id: e.id,
          name: e.name,
          type: e.type,
          description: e.description,
          qualifiedName: e.qualifiedName,
          metadata: null,
          filePath: e.filePath,
          startLine: null,
          endLine: null,
          language: null,
          signature: null,
        })
      }
      continue
    }
    // list_issues envelope { issues, relatedChunks }: collect issues
    // for prompt injection AND lift linked code into the main entity /
    // chunk context so [chunk:UUID] / [entity:UUID] citations work.
    if (Array.isArray(obj.issues) && obj.issues.every((it) => it && typeof it === 'object' && typeof (it as { number?: unknown }).number === 'number')) {
      for (const it of obj.issues as IssueResult[]) {
        issueResults.push(it)
        for (const e of it.relatedEntities ?? []) {
          if (seenEntityIds.has(e.entityId)) continue
          seenEntityIds.add(e.entityId)
          entitiesContext.push({
            id: e.entityId,
            name: e.name,
            type: e.type,
            description: e.description,
            qualifiedName: e.qualifiedName,
            metadata: null,
            filePath: e.filePath,
            startLine: null,
            endLine: null,
            language: null,
            signature: null,
          })
        }
      }
      const relatedChunks = (obj.relatedChunks as LinkedChunk[] | undefined) ?? []
      for (const c of relatedChunks) {
        if (seenChunkIds.has(c.id)) continue
        seenChunkIds.add(c.id)
        chunks.push({
          id: c.id,
          text: c.text,
          filePath: c.filePath,
          startLine: c.startLine,
          endLine: c.endLine,
        })
      }
      continue
    }
    // Walkthrough envelope { entities, mermaid }: unwrap entities and
    // collect the mermaid block for later prompt injection. Skip the
    // chunk/entity detection below for this object — it's a container,
    // not a leaf.
    if (Array.isArray(obj.entities) && typeof obj.mermaid === 'string') {
      if (obj.mermaid.trim().length > 0) mermaidBlocks.push(obj.mermaid)
      for (const inner of obj.entities) {
        if (!inner || typeof inner !== 'object') continue
        const e = inner as Record<string, unknown>
        if (typeof e.name !== 'string' || typeof e.id !== 'string') continue
        if (seenEntityIds.has(e.id as string)) continue
        seenEntityIds.add(e.id as string)
        entitiesContext.push({
          id: e.id as string,
          name: e.name as string,
          type: (e.type as string | undefined) ?? 'entity',
          description: (e.description as string | null | undefined) ?? null,
          qualifiedName: (e.qualifiedName as string | null | undefined) ?? null,
          metadata: (e.metadata as Record<string, unknown> | null | undefined) ?? null,
          filePath: (e.filePath as string | null | undefined) ?? null,
          startLine: (e.startLine as number | null | undefined) ?? null,
          endLine: (e.endLine as number | null | undefined) ?? null,
          language: (e.language as string | null | undefined) ?? null,
          signature: (e.signature as string | null | undefined) ?? null,
        })
      }
      continue
    }
    // Chunks come back with either `id` (search_docs, vector_search_chunks,
    // retrieve_code_chunks) or `chunkId` (hybrid_search) — accept both.
    const chunkId =
      typeof obj.id === 'string'
        ? obj.id
        : typeof obj.chunkId === 'string'
          ? obj.chunkId
          : null
    if (typeof obj.text === 'string' && chunkId) {
      if (seenChunkIds.has(chunkId)) continue
      seenChunkIds.add(chunkId)
      chunks.push({
        id: chunkId,
        text: obj.text as string,
        filePath: (obj.filePath as string | null) ?? null,
        startLine: (obj.startLine as number | null) ?? null,
        endLine: (obj.endLine as number | null) ?? null,
      })
    } else if (typeof obj.name === 'string' && typeof obj.id === 'string' && typeof obj.type === 'string') {
      const id = obj.id as string
      if (seenEntityIds.has(id)) continue
      seenEntityIds.add(id)
      entitiesContext.push({
        id,
        name: obj.name as string,
        type: obj.type as string,
        description: (obj.description as string | null) ?? null,
        qualifiedName: (obj.qualifiedName as string | null) ?? null,
        metadata: (obj.metadata as Record<string, unknown> | null) ?? null,
        filePath: (obj.filePath as string | null) ?? null,
        startLine: (obj.startLine as number | null) ?? null,
        endLine: (obj.endLine as number | null) ?? null,
        language: (obj.language as string | null) ?? null,
        signature: (obj.signature as string | null) ?? null,
      })
    }
  }

  // Safety net: if the planner produced no chunks at all, fall back to
  // hybrid_search on the question itself so the model always has something
  // concrete to ground in. Workspace meta below covers the "no chunks AND
  // no entities" case for broad questions.
  if (chunks.length === 0) {
    try {
      const results = await hybridSearch(ctx.db, ctx.embeddings, {
        workspaceId: ctx.workspaceId,
        query: params.question,
        limit: 8,
      })
      for (const r of results) {
        chunks.push({
          id: r.chunkId,
          text: r.text,
          filePath: r.filePath,
          startLine: r.startLine,
          endLine: r.endLine,
        })
      }
    } catch {
      // ignore — answer still works with workspace meta only
    }
  }

  for await (const evt of answer(ctx.llm, {
    question: params.question,
    chunks,
    entities: entitiesContext,
    style: params.style,
    workspace: ctx.workspace,
    responseLocale: ctx.responseLocale,
    mermaidDiagrams: mermaidBlocks,
    issues: issueResults,
    overview,
    userPastedDiff: ctx.userPastedDiff,
  })) {
    yield evt
  }
}

/**
 * Drop the inline `diff` field (and `diffTruncated` flag) from a commit's
 * metadata when we're also passing the same content as separate chunks.
 * Keeps message/sha/author/date/filesChanged so the entity card still has
 * its identifying info.
 */
function stripInlineDiff(
  metadata: Record<string, unknown>,
): Record<string, unknown> {
  if (!('diff' in metadata)) return metadata
  const { diff, diffTruncated, ...rest } = metadata
  void diff
  void diffTruncated
  return rest
}

// ---------- helpers ----------
function idsFromParam(param: GraphEntity | GraphEntity[] | undefined): string[] {
  if (!param) return []
  const list = Array.isArray(param) ? param : [param]
  return list.map((e) => e?.id).filter((id): id is string => Boolean(id))
}

function entityProjection() {
  return {
    id: entities.id,
    type: entities.type,
    name: entities.name,
    qualifiedName: entities.qualifiedName,
    filePath: entities.filePath,
    startLine: entities.startLine,
    endLine: entities.endLine,
    language: entities.language,
    description: entities.description,
  }
}

// ---------- Operator registry ----------
export type OperatorName =
  | 'find_symbol'
  | 'find_file'
  | 'get_callers'
  | 'get_callees'
  | 'get_dependencies'
  | 'get_dependents'
  | 'find_implementations'
  | 'git_history'
  | 'find_by_concept'
  | 'vector_search_chunks'
  | 'hybrid_search'
  | 'search_docs'
  | 'retrieve_code_chunks'
  | 'get_summary'
  | 'walkthrough'
  | 'list_issues'
  | 'list_prs'
  | 'find_similar_issues'
  | 'get_project_overview'
  | 'read_file'
  | 'tests_for'
  | 'list_concepts'
  | 'answer'

export const OPERATORS: Record<
  OperatorName,
  (params: never, ctx: OperatorContext) => Promise<unknown> | AsyncGenerator<unknown>
> = {
  find_symbol: findSymbol as never,
  find_file: findFile as never,
  get_callers: getCallers as never,
  get_callees: getCallees as never,
  get_dependencies: getDependencies as never,
  get_dependents: getDependents as never,
  find_implementations: findImplementations as never,
  git_history: gitHistory as never,
  find_by_concept: findByConcept as never,
  vector_search_chunks: vectorSearchChunks as never,
  hybrid_search: hybridSearchOp as never,
  search_docs: searchDocs as never,
  retrieve_code_chunks: retrieveCodeChunks as never,
  get_summary: getSummary as never,
  walkthrough: walkthrough as never,
  list_issues: listIssues as never,
  list_prs: listPrs as never,
  find_similar_issues: findSimilarIssues as never,
  get_project_overview: getProjectOverviewOp as never,
  read_file: readFileOp as never,
  tests_for: testsFor as never,
  list_concepts: listConcepts as never,
  answer: answerOp as never,
}
