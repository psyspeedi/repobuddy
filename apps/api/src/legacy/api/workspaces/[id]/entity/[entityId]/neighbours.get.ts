/**
 * Returns the local neighbourhood of an entity for the Neighbour
 * Graph drawer. Walks `relations` outward and inward up to `depth`,
 * caps the result so a hub entity can't pull thousands of nodes.
 *
 * Query:
 *   depth (1|2, default 1)
 *   limit (per-hop edge cap, default 60)
 *
 * Response:
 *   {
 *     center: Entity (with depth: 0),
 *     nodes:  Entity[] (each annotated with depth: hop distance),
 *     edges:  { id, from, to, type }[]
 *   }
 */
import { and, eq, inArray, or } from 'drizzle-orm'
import { getDb } from '../../../../../db/client'
import { entities, relations } from '../../../../../db/schema'
import { readAccess } from '../../../../../lib/workspace-access'

export default defineEventHandler(async (event) => {
  const workspaceId = getRouterParam(event, 'id')
  const entityId = getRouterParam(event, 'entityId')
  if (!workspaceId || !entityId) {
    throw createError({ statusCode: 400, statusMessage: 'id and entityId required' })
  }
  await readAccess(event, workspaceId)

  const q = getQuery(event)
  const depth = Math.min(Math.max(Number(q.depth ?? 1), 1), 2)
  const perDirLimit = Math.min(Math.max(Number(q.limit ?? 60), 10), 200)

  const config = useRuntimeConfig(event)
  const db = getDb(config.databaseUrl as string)

  // BFS over relations. ring is the set of node ids whose neighbours
  // we'll visit on this hop; visited captures everything we've ever
  // touched so we don't recurse forever.
  const visited = new Set<string>([entityId])
  let ring = new Set<string>([entityId])
  const edges: Array<{ id: string; from: string; to: string; type: string }> = []
  const distance = new Map<string, number>([[entityId, 0]])

  for (let d = 1; d <= depth && ring.size > 0; d++) {
    const ids = [...ring]
    const rows = await db
      .select({
        id: relations.id,
        from: relations.fromEntityId,
        to: relations.toEntityId,
        type: relations.type,
      })
      .from(relations)
      .where(
        and(
          eq(relations.workspaceId, workspaceId),
          or(inArray(relations.fromEntityId, ids), inArray(relations.toEntityId, ids))!,
        ),
      )
      .limit(perDirLimit * Math.max(1, ids.length))

    const nextRing = new Set<string>()
    for (const r of rows) {
      edges.push(r)
      for (const peer of [r.from, r.to]) {
        if (!visited.has(peer)) {
          visited.add(peer)
          distance.set(peer, d)
          nextRing.add(peer)
        }
      }
    }
    ring = nextRing
  }

  const nodeRows = await db
    .select({
      id: entities.id,
      type: entities.type,
      name: entities.name,
      qualifiedName: entities.qualifiedName,
      filePath: entities.filePath,
      startLine: entities.startLine,
      endLine: entities.endLine,
      language: entities.language,
    })
    .from(entities)
    .where(
      and(eq(entities.workspaceId, workspaceId), inArray(entities.id, [...visited])),
    )

  const center = nodeRows.find((n) => n.id === entityId)
  if (!center) {
    throw createError({ statusCode: 404, statusMessage: 'entity not found' })
  }

  return {
    center,
    nodes: nodeRows.map((n) => ({ ...n, depth: distance.get(n.id) ?? depth })),
    edges,
  }
})
