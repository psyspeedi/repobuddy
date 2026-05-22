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
  | 'get_project_overview'
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
  get_project_overview: getProjectOverviewOp as never,
  answer: answerOp as never,
}
