import { DRIZZLE_DB, type DrizzleDb } from '#modules/drizzle/drizzle.tokens'
import type { Database } from '#server/db/client'
import { Inject, Injectable } from '@nestjs/common'
import { and, eq, ilike, inArray, or } from 'drizzle-orm'
import { entities, relations } from '#server/db/schema'
import { entityProjection, idsFromParam } from './_helpers'
import type { KagOperator } from './_interface'
import type { GraphEntity, OperatorContext } from './_types'

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
  db: Database,
): Promise<GraphEntity[]> {
  const limit = params.limit ?? 20
  // Planner sometimes calls find_symbol without a `name` for broad
  // questions ("what functions are there"). Treat empty/missing name as
  // "list by type" instead of crashing on .toLowerCase() of undefined.
  const rawName = typeof params.name === 'string' ? params.name.trim() : ''
  if (!rawName) {
    if (!params.type) return []
    return db
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

  const rows = await db
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
    return db
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
  db: Database,
): Promise<GraphEntity[]> {
  const limit = params.limit ?? 50
  const pattern = params.pathPattern.replace(/\*/g, '%')
  return db
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

// ---------- get_callers / get_callees / get_dependencies / get_dependents ----------
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
  db: Database,
): Promise<GraphEntity[]> {
  const ids = idsFromParam(params.target)
  if (ids.length === 0) return []
  return traverse(db, ctx, ids, 'calls', 'in', params)
}

export async function getCallees(
  params: TraversalParams,
  ctx: OperatorContext,
  db: Database,
): Promise<GraphEntity[]> {
  const ids = idsFromParam(params.source)
  if (ids.length === 0) return []
  return traverse(db, ctx, ids, 'calls', 'out', params)
}

export async function getDependencies(
  params: TraversalParams,
  ctx: OperatorContext,
  db: Database,
): Promise<GraphEntity[]> {
  const ids = idsFromParam(params.source ?? params.target)
  if (ids.length === 0) return []
  return traverse(db, ctx, ids, 'imports', 'out', params)
}

export async function getDependents(
  params: TraversalParams,
  ctx: OperatorContext,
  db: Database,
): Promise<GraphEntity[]> {
  const ids = idsFromParam(params.target ?? params.source)
  if (ids.length === 0) return []
  return traverse(db, ctx, ids, 'imports', 'in', params)
}

/** BFS over relations, used by callers/callees/dependencies/dependents + walkthrough. */
async function traverse(
  db: Database,
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
    const rows = await db
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
  return db
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
  db: Database,
): Promise<GraphEntity[]> {
  const targetId = params.interfaceOrType?.id
  if (!targetId) return []
  const limit = params.limit ?? 50
  const rows = await db
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

// ---------- get_summary ----------
export interface GetSummaryParams {
  entity: GraphEntity | GraphEntity[]
}

export async function getSummary(
  params: GetSummaryParams,
  ctx: OperatorContext,
  db: Database,
): Promise<{ id: string; name: string; type: string; description: string | null }[]> {
  const list = Array.isArray(params.entity) ? params.entity : [params.entity]
  const ids = list.map((e) => e?.id).filter((id): id is string => Boolean(id))
  if (ids.length === 0) return []
  return db
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
  db: Database,
): Promise<WalkthroughResult> {
  const list = Array.isArray(params.entity) ? params.entity : [params.entity]
  const targets = list.filter((e): e is GraphEntity => Boolean(e?.id))
  if (targets.length === 0) return { entities: [], mermaid: '' }
  const limit = params.limit ?? 20

  const seen = new Set<string>()
  const entitiesOut: GraphEntity[] = []
  const pushUnique = (e: GraphEntity | undefined): void => {
    if (!e?.id || seen.has(e.id)) return
    seen.add(e.id)
    entitiesOut.push(e)
  }
  // Build the diagram around the FIRST target. Multiple targets is
  // an edge case (planner usually find_symbol's a single name) — for
  // those we render one diagram and treat the rest as entity context.
  const primary = targets[0]
  if (!primary) return { entities: [], mermaid: '' }

  const [primaryCallees, primaryTests] = await Promise.all([
    traverse(db, ctx, [primary.id], 'calls', 'out', { limit }),
    traverse(db, ctx, [primary.id], 'tested_by', 'out', { limit }),
  ])
  pushUnique(primary)
  for (const e of primaryCallees) pushUnique(e)
  for (const e of primaryTests) pushUnique(e)
  const [primaryParents] = await Promise.all([
    traverse(db, ctx, [primary.id], 'contained_in', 'out', { limit: 3 }),
  ])
  for (const e of primaryParents) pushUnique(e)

  // Pull supporting graph for any other targets without rebuilding
  // their own diagrams — entities still go into context.
  for (const t of targets.slice(1)) {
    pushUnique(t)
    const [callees, tests, parents] = await Promise.all([
      traverse(db, ctx, [t.id], 'calls', 'out', { limit }),
      traverse(db, ctx, [t.id], 'tested_by', 'out', { limit }),
      traverse(db, ctx, [t.id], 'contained_in', 'out', { limit: 3 }),
    ])
    for (const e of callees) pushUnique(e)
    for (const e of tests) pushUnique(e)
    for (const e of parents) pushUnique(e)
  }

  return {
    entities: entitiesOut,
    mermaid: buildMermaidSequence(primary, primaryCallees, primaryTests),
  }
}

// ---------- @Injectable wrappers ----------
// Tiny adapters that satisfy KagOperator; the logic lives in the
// existing top-level functions so legacy callers + tests that import
// them directly keep working. Registered in KagModule under the
// KAG_OPERATOR multi-provider token; the executor talks to them
// through KagOperatorsRegistry.

@Injectable()
export class FindSymbolOperator implements KagOperator<FindSymbolParams, GraphEntity[]> {
  readonly name = 'find_symbol' as const
  constructor(@Inject(DRIZZLE_DB) private readonly db: DrizzleDb) {}
  execute(p: FindSymbolParams, c: OperatorContext) { return findSymbol(p, c, this.db) }
}

@Injectable()
export class FindFileOperator implements KagOperator<FindFileParams, GraphEntity[]> {
  readonly name = 'find_file' as const
  constructor(@Inject(DRIZZLE_DB) private readonly db: DrizzleDb) {}
  execute(p: FindFileParams, c: OperatorContext) { return findFile(p, c, this.db) }
}

@Injectable()
export class GetCallersOperator implements KagOperator {
  readonly name = 'get_callers' as const
  constructor(@Inject(DRIZZLE_DB) private readonly db: DrizzleDb) {}
  execute(p: never, c: OperatorContext) { return getCallers(p, c, this.db) }
}

@Injectable()
export class GetCalleesOperator implements KagOperator {
  readonly name = 'get_callees' as const
  constructor(@Inject(DRIZZLE_DB) private readonly db: DrizzleDb) {}
  execute(p: never, c: OperatorContext) { return getCallees(p, c, this.db) }
}

@Injectable()
export class GetDependenciesOperator implements KagOperator {
  readonly name = 'get_dependencies' as const
  constructor(@Inject(DRIZZLE_DB) private readonly db: DrizzleDb) {}
  execute(p: never, c: OperatorContext) { return getDependencies(p, c, this.db) }
}

@Injectable()
export class GetDependentsOperator implements KagOperator {
  readonly name = 'get_dependents' as const
  constructor(@Inject(DRIZZLE_DB) private readonly db: DrizzleDb) {}
  execute(p: never, c: OperatorContext) { return getDependents(p, c, this.db) }
}

@Injectable()
export class FindImplementationsOperator implements KagOperator<FindImplementationsParams, GraphEntity[]> {
  readonly name = 'find_implementations' as const
  constructor(@Inject(DRIZZLE_DB) private readonly db: DrizzleDb) {}
  execute(p: FindImplementationsParams, c: OperatorContext) { return findImplementations(p, c, this.db) }
}

@Injectable()
export class GetSummaryOperator implements KagOperator {
  readonly name = 'get_summary' as const
  constructor(@Inject(DRIZZLE_DB) private readonly db: DrizzleDb) {}
  execute(p: GetSummaryParams, c: OperatorContext) { return getSummary(p, c, this.db) }
}

@Injectable()
export class WalkthroughOperator implements KagOperator<WalkthroughParams, WalkthroughResult> {
  readonly name = 'walkthrough' as const
  constructor(@Inject(DRIZZLE_DB) private readonly db: DrizzleDb) {}
  execute(p: WalkthroughParams, c: OperatorContext) { return walkthrough(p, c, this.db) }
}
