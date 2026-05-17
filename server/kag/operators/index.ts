/**
 * KAG operator library. Each operator is an async function over a typed
 * parameter object; the executor (kag/executor.ts) dispatches them by name
 * with substituted params and stores the result.
 *
 * Operators are pure with respect to the database — they read graph state
 * but never mutate it.
 */
import { and, eq, ilike, inArray, or, sql } from 'drizzle-orm'
import type { Database } from '../../db/client'
import { chunks, entities, relations } from '../../db/schema'
import type { EmbeddingsProvider } from '../../providers/embeddings'
import type { LLMProvider } from '../../providers/llm'
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
  const needle = params.name.toLowerCase()

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

export async function walkthrough(
  params: WalkthroughParams,
  ctx: OperatorContext,
): Promise<GraphEntity[]> {
  const list = Array.isArray(params.entity) ? params.entity : [params.entity]
  const targets = list.filter((e): e is GraphEntity => Boolean(e?.id))
  if (targets.length === 0) return []
  const limit = params.limit ?? 20

  const seen = new Set<string>()
  const out: GraphEntity[] = []
  const pushUnique = (e: GraphEntity | undefined): void => {
    if (!e?.id || seen.has(e.id)) return
    seen.add(e.id)
    out.push(e)
  }
  for (const target of targets) {
    pushUnique(target)
    const [callees, tests, parents] = await Promise.all([
      traverse(ctx, [target.id], 'calls', 'out', { limit }),
      traverse(ctx, [target.id], 'tested_by', 'out', { limit }),
      traverse(ctx, [target.id], 'contained_in', 'out', { limit: 3 }),
    ])
    for (const e of callees) pushUnique(e)
    for (const e of tests) pushUnique(e)
    for (const e of parents) pushUnique(e)
  }
  return out
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
  answer: answerOp as never,
}
