import { and, eq } from 'drizzle-orm'
import { getDb } from '../../../../db/client'
import { chunks } from '../../../../db/schema'
import { readAccess } from '../../../../lib/workspace-access'

export default defineEventHandler(async (event) => {
  const workspaceId = getRouterParam(event, 'id')
  const chunkId = getRouterParam(event, 'chunkId')
  if (!workspaceId || !chunkId) {
    throw createError({ statusCode: 400, statusMessage: 'id and chunkId required' })
  }
  await readAccess(event, workspaceId)
  const config = useRuntimeConfig(event)
  const db = getDb(config.databaseUrl as string)

  const [chunk] = await db
    .select()
    .from(chunks)
    .where(and(eq(chunks.id, chunkId), eq(chunks.workspaceId, workspaceId)))
    .limit(1)
  if (!chunk) throw createError({ statusCode: 404, statusMessage: 'chunk not found' })

  return { chunk }
})
