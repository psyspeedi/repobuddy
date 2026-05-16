import { and, eq } from 'drizzle-orm'
import { getDb } from '../../../../db/client'
import { chunks, workspaces } from '../../../../db/schema'
import { requireValidUser } from '../../../../lib/auth'

export default defineEventHandler(async (event) => {
  const user = await requireValidUser(event)
  const workspaceId = getRouterParam(event, 'id')
  const chunkId = getRouterParam(event, 'chunkId')
  if (!workspaceId || !chunkId) {
    throw createError({ statusCode: 400, statusMessage: 'id and chunkId required' })
  }

  const config = useRuntimeConfig(event)
  const db = getDb(config.databaseUrl as string)

  const [ws] = await db
    .select()
    .from(workspaces)
    .where(
      and(eq(workspaces.id, workspaceId), eq(workspaces.ownerUserId, user.id)),
    )
    .limit(1)
  if (!ws) throw createError({ statusCode: 404, statusMessage: 'workspace not found' })

  const [chunk] = await db
    .select()
    .from(chunks)
    .where(and(eq(chunks.id, chunkId), eq(chunks.workspaceId, workspaceId)))
    .limit(1)
  if (!chunk) throw createError({ statusCode: 404, statusMessage: 'chunk not found' })

  return { chunk }
})
