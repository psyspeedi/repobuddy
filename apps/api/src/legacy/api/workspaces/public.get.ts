/**
 * Returns the list of workspaces flagged is_public — exposed without
 * authentication so the landing page can show guests what's available
 * to explore.
 */
import { and, desc, eq } from 'drizzle-orm'
import { getDb } from '../../db/client'
import { users, workspaces } from '../../db/schema'

export default defineEventHandler(async (event) => {
  const config = useRuntimeConfig(event)
  const db = getDb(config.databaseUrl as string)
  const rows = await db
    .select({
      id: workspaces.id,
      name: workspaces.name,
      sourceUrl: workspaces.sourceUrl,
      languages: workspaces.languages,
      stats: workspaces.stats,
      lastIndexedAt: workspaces.lastIndexedAt,
      ownerLogin: users.githubLogin,
    })
    .from(workspaces)
    .leftJoin(users, eq(users.id, workspaces.ownerUserId))
    .where(and(eq(workspaces.isPublic, true), eq(workspaces.status, 'ready')))
    .orderBy(desc(workspaces.lastIndexedAt))
    .limit(50)
  return { workspaces: rows }
})
