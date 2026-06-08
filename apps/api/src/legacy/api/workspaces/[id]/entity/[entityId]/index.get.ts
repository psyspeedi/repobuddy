import { and, eq, inArray } from 'drizzle-orm'
import { getDb } from '../../../../../db/client'
import {
  chunks as chunksTable,
  entities,
  entityChunks,
  relations,
} from '../../../../../db/schema'
import { readAccess } from '../../../../../lib/workspace-access'

export default defineEventHandler(async (event) => {
  const workspaceId = getRouterParam(event, 'id')
  const entityId = getRouterParam(event, 'entityId')
  if (!workspaceId || !entityId) {
    throw createError({ statusCode: 400, statusMessage: 'id and entityId required' })
  }
  await readAccess(event, workspaceId)
  const config = useRuntimeConfig(event)
  const db = getDb(config.databaseUrl as string)

  // Entity row.
  const [entity] = await db
    .select()
    .from(entities)
    .where(
      and(
        eq(entities.workspaceId, workspaceId),
        eq(entities.id, entityId),
      ),
    )
    .limit(1)
  if (!entity) throw createError({ statusCode: 404, statusMessage: 'entity not found' })

  // First-degree neighbours: every relation touching this entity, plus the
  // counterpart entity row, so the panel can show "calls these N functions"
  // / "modified by these N commits" without an extra round-trip.
  const incomingRows = await db
    .select({
      id: relations.id,
      type: relations.type,
      entity: {
        id: entities.id,
        name: entities.name,
        type: entities.type,
        qualifiedName: entities.qualifiedName,
        filePath: entities.filePath,
      },
    })
    .from(relations)
    .innerJoin(entities, eq(entities.id, relations.fromEntityId))
    .where(
      and(
        eq(relations.workspaceId, workspaceId),
        eq(relations.toEntityId, entityId),
      ),
    )
    .limit(200)

  const outgoingRows = await db
    .select({
      id: relations.id,
      type: relations.type,
      entity: {
        id: entities.id,
        name: entities.name,
        type: entities.type,
        qualifiedName: entities.qualifiedName,
        filePath: entities.filePath,
      },
    })
    .from(relations)
    .innerJoin(entities, eq(entities.id, relations.toEntityId))
    .where(
      and(
        eq(relations.workspaceId, workspaceId),
        eq(relations.fromEntityId, entityId),
      ),
    )
    .limit(200)

  // For commit entities, attach files in the order they appear in the
  // commit's metadata.filesChanged array — that's the canonical ordering
  // shown in `git show`.
  const filesChanged =
    entity.type === 'commit'
      ? await resolveFilesChanged(db, workspaceId, entity)
      : null

  // Linked chunks (preview only, no body).
  const linkedChunks = await db
    .select({
      id: chunksTable.id,
      filePath: chunksTable.filePath,
      startLine: chunksTable.startLine,
      endLine: chunksTable.endLine,
      sourceType: chunksTable.sourceType,
    })
    .from(chunksTable)
    .innerJoin(entityChunks, eq(entityChunks.chunkId, chunksTable.id))
    .where(eq(entityChunks.entityId, entityId))
    .limit(20)

  return {
    entity,
    incoming: incomingRows,
    outgoing: outgoingRows,
    filesChanged,
    linkedChunks,
    counts: {
      incoming: incomingRows.length,
      outgoing: outgoingRows.length,
    },
  }
})

async function resolveFilesChanged(
  db: ReturnType<typeof getDb>,
  workspaceId: string,
  commitEntity: typeof entities.$inferSelect,
): Promise<{ id: string | null; path: string }[]> {
  const meta = commitEntity.metadata as { filesChanged?: string[] } | null
  const paths = Array.isArray(meta?.filesChanged) ? meta!.filesChanged : []
  if (paths.length === 0) return []
  const fileRows = await db
    .select({
      id: entities.id,
      filePath: entities.filePath,
    })
    .from(entities)
    .where(
      and(
        eq(entities.workspaceId, workspaceId),
        eq(entities.type, 'file'),
        inArray(entities.filePath, paths),
      ),
    )
  const byPath = new Map<string, string>()
  for (const r of fileRows) {
    if (r.filePath) byPath.set(r.filePath, r.id)
  }
  return paths.map((p) => ({ id: byPath.get(p) ?? null, path: p }))
}
