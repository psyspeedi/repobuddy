import { and, eq, inArray, or, sql } from 'drizzle-orm'
import { getDb } from '../../../db/client'
import { entities, relations, workspaces } from '../../../db/schema'
import { requireValidUser } from '../../../lib/auth'

const DEFAULT_LIMIT = 2000
const NEIGHBOR_LIMIT = 1500

export default defineEventHandler(async (event) => {
  const user = await requireValidUser(event)
  const id = getRouterParam(event, 'id')
  if (!id) throw createError({ statusCode: 400, statusMessage: 'id required' })

  const config = useRuntimeConfig(event)
  const db = getDb(config.databaseUrl as string)

  const [ws] = await db
    .select()
    .from(workspaces)
    .where(and(eq(workspaces.id, id), eq(workspaces.ownerUserId, user.id)))
    .limit(1)
  if (!ws) throw createError({ statusCode: 404, statusMessage: 'workspace not found' })

  const query = getQuery(event)
  const limit = Math.min(Number(query.limit ?? DEFAULT_LIMIT), 5000)
  const typeFilter = parseList(query.types)
  const langFilter = parseList(query.languages)
  const includeNeighbors = query.neighbors !== '0' && query.neighbors !== 'false'

  // Stage 1: primary nodes — entities that match user-selected filters.
  const primaryRows = await db
    .select({
      id: entities.id,
      type: entities.type,
      name: entities.name,
      qualifiedName: entities.qualifiedName,
      language: entities.language,
      filePath: entities.filePath,
      metadata: entities.metadata,
    })
    .from(entities)
    .where(
      and(
        eq(entities.workspaceId, id),
        typeFilter ? inArray(entities.type, typeFilter) : undefined,
        langFilter ? inArray(entities.language, langFilter) : undefined,
      ),
    )
    .limit(limit)

  const primaryIds = new Set(primaryRows.map((n) => n.id))
  const primaryIdsArr = [...primaryIds]

  // Stage 2: gather every relation that touches at least one primary node.
  // We do this even when neighbors=false so we can ALSO include the second
  // endpoint as a "context" node when neighbors=true (default).
  let allEdges: { id: string; fromEntityId: string; toEntityId: string; type: string }[] = []
  if (primaryIdsArr.length > 0) {
    allEdges = await db
      .select({
        id: relations.id,
        fromEntityId: relations.fromEntityId,
        toEntityId: relations.toEntityId,
        type: relations.type,
      })
      .from(relations)
      .where(
        and(
          eq(relations.workspaceId, id),
          or(
            inArray(relations.fromEntityId, primaryIdsArr),
            inArray(relations.toEntityId, primaryIdsArr),
          ),
        ),
      )
      .limit(limit * 4)
  }

  // Stage 3: collect context-node ids — the "other end" of each edge that
  // isn't already in the primary set. Capped at NEIGHBOR_LIMIT to keep
  // payload bounded for hub-heavy nodes (a single popular file can be
  // touched by thousands of commits).
  const contextIds = new Set<string>()
  if (includeNeighbors) {
    for (const e of allEdges) {
      if (!primaryIds.has(e.fromEntityId)) contextIds.add(e.fromEntityId)
      if (!primaryIds.has(e.toEntityId)) contextIds.add(e.toEntityId)
      if (contextIds.size >= NEIGHBOR_LIMIT) break
    }
  }

  const contextRows = contextIds.size === 0
    ? []
    : await db
        .select({
          id: entities.id,
          type: entities.type,
          name: entities.name,
          qualifiedName: entities.qualifiedName,
          language: entities.language,
          filePath: entities.filePath,
          metadata: entities.metadata,
        })
        .from(entities)
        .where(inArray(entities.id, [...contextIds]))

  const allNodes = [
    ...primaryRows.map((r) => ({ ...r, isContext: false })),
    ...contextRows.map((r) => ({ ...r, isContext: true })),
  ]
  const visibleIds = new Set(allNodes.map((n) => n.id))

  // Stage 4: keep only edges whose BOTH ends are in the visible set.
  // Without neighbors, this collapses back to the original behaviour
  // (edges only between primary nodes).
  const edgeRows = allEdges.filter(
    (e) => visibleIds.has(e.fromEntityId) && visibleIds.has(e.toEntityId),
  )

  // Cheap stats — counts by type — to populate the filter UI.
  const stats = await db
    .select({
      type: entities.type,
      count: sql<number>`count(*)::int`,
    })
    .from(entities)
    .where(eq(entities.workspaceId, id))
    .groupBy(entities.type)

  return {
    nodes: allNodes,
    edges: edgeRows,
    truncated: primaryRows.length === limit,
    stats,
    counts: {
      primary: primaryRows.length,
      context: contextRows.length,
      edges: edgeRows.length,
    },
  }
})

function parseList(value: unknown): string[] | undefined {
  if (!value) return undefined
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === 'string')
  if (typeof value === 'string')
    return value
      .split(',')
      .map((v) => v.trim())
      .filter(Boolean)
  return undefined
}
