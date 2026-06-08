import { Injectable } from '@nestjs/common'
import { and, eq, or, sql } from 'drizzle-orm'
import { chunks, entities, relations } from '../../../../db/schema'
import { getProjectOverview, type ProjectOverview } from '../../../../lib/project-overview'
import { idsFromParam } from './_helpers'
import type { KagOperator } from './_interface'
import type { GraphEntity, OperatorContext } from './_types'

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

// ---------- @Injectable wrappers ----------

@Injectable()
export class TestsForOperator implements KagOperator<TestsForParams, GraphEntity[]> {
  readonly name = 'tests_for' as const
  execute(p: TestsForParams, c: OperatorContext) { return testsFor(p, c) }
}

@Injectable()
export class ListConceptsOperator implements KagOperator<ListConceptsParams, GraphEntity[]> {
  readonly name = 'list_concepts' as const
  execute(p: ListConceptsParams, c: OperatorContext) { return listConcepts(p, c) }
}

@Injectable()
export class ReadFileOperator implements KagOperator<ReadFileParams> {
  readonly name = 'read_file' as const
  execute(p: ReadFileParams, c: OperatorContext) { return readFileOp(p, c) }
}

@Injectable()
export class GetProjectOverviewOperator implements KagOperator<ProjectOverviewParams, ProjectOverview> {
  readonly name = 'get_project_overview' as const
  execute(p: ProjectOverviewParams, c: OperatorContext) { return getProjectOverviewOp(p, c) }
}
