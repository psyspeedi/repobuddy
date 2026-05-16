import { and, eq } from 'drizzle-orm'
import { getDb } from '../../../db/client'
import { workspaces } from '../../../db/schema'
import { requireValidUser } from '../../../lib/auth'

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
  return { workspace: ws }
})
