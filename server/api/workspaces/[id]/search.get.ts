import { and, eq, ilike } from 'drizzle-orm'
import { getDb } from '../../../db/client'
import { entities, workspaces } from '../../../db/schema'
import { requireValidUser } from '../../../lib/auth'

const DEFAULT_LIMIT = 20

export default defineEventHandler(async (event) => {
  const user = await requireValidUser(event)
  const id = getRouterParam(event, 'id')
  if (!id) throw createError({ statusCode: 400, statusMessage: 'id required' })

  const config = useRuntimeConfig(event)
  const db = getDb(config.databaseUrl as string)

  const [ws] = await db
    .select({ id: workspaces.id })
    .from(workspaces)
    .where(and(eq(workspaces.id, id), eq(workspaces.ownerUserId, user.id)))
    .limit(1)
  if (!ws) throw createError({ statusCode: 404, statusMessage: 'workspace not found' })

  const query = getQuery(event)
  const q = typeof query.q === 'string' ? query.q.trim() : ''
  if (!q) return { results: [] }

  const limit = Math.min(Number(query.limit ?? DEFAULT_LIMIT), 50)

  // Substring match on normalized_name (case-insensitive). Order by
  // shortest-name first so exact-ish hits float to the top.
  const rows = await db
    .select({
      id: entities.id,
      type: entities.type,
      name: entities.name,
      qualifiedName: entities.qualifiedName,
      filePath: entities.filePath,
    })
    .from(entities)
    .where(
      and(
        eq(entities.workspaceId, id),
        ilike(entities.normalizedName, `%${q.toLowerCase()}%`),
      ),
    )
    .limit(limit * 2)

  // Re-rank: prefer exact matches and shorter names.
  const lowered = q.toLowerCase()
  rows.sort((a, b) => {
    const ax = a.name.toLowerCase() === lowered ? 0 : 1
    const bx = b.name.toLowerCase() === lowered ? 0 : 1
    if (ax !== bx) return ax - bx
    return a.name.length - b.name.length
  })

  return { results: rows.slice(0, limit) }
})
