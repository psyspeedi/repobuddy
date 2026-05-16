import { desc, eq } from 'drizzle-orm'
import { getDb } from '../../db/client'
import { workspaces } from '../../db/schema'

export default defineEventHandler(async (event) => {
  const { user } = await requireUserSession(event)
  const config = useRuntimeConfig(event)
  const db = getDb(config.databaseUrl as string)

  const rows = await db
    .select()
    .from(workspaces)
    .where(eq(workspaces.ownerUserId, user.id))
    .orderBy(desc(workspaces.createdAt))
    .limit(100)

  return { workspaces: rows }
})
