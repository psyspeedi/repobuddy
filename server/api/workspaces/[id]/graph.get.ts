import { and, eq, inArray, sql } from 'drizzle-orm'
import { getDb } from '../../../db/client'
import { entities, relations, workspaces } from '../../../db/schema'

const DEFAULT_LIMIT = 2000

export default defineEventHandler(async (event) => {
  const { user } = await requireUserSession(event)
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

  // Pull entities, optionally filtered by type/language.
  const entityRowsQuery = db
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
  const nodeRows = await entityRowsQuery

  const nodeIds = nodeRows.map((n) => n.id)
  let edgeRows: {
    id: string
    fromEntityId: string
    toEntityId: string
    type: string
  }[] = []
  if (nodeIds.length > 0) {
    edgeRows = await db
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
          inArray(relations.fromEntityId, nodeIds),
          inArray(relations.toEntityId, nodeIds),
        ),
      )
      .limit(limit * 4)
  }

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
    nodes: nodeRows,
    edges: edgeRows,
    truncated: nodeRows.length === limit,
    stats,
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
