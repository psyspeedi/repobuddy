/**
 * Find a non-diff chunk by file path in this workspace.
 *
 * Used by the source viewer: when the user clicks a citation that
 * resolves to a per-commit diff chunk, the drawer probes this
 * endpoint to find the source file's chunk and opens that by default.
 * Diff stays one toggle away.
 *
 * Query: ?path=src/index.ts&excludeId=<chunkId-to-skip>
 *
 * Returns the most-recently-created code chunk for that path (the
 * latest indexed copy), or null if none.
 */
import { and, desc, eq, ne, not, sql } from 'drizzle-orm'
import { getDb } from '../../../db/client'
import { chunks } from '../../../db/schema'
import { readAccess } from '../../../lib/workspace-access'

export default defineEventHandler(async (event) => {
  const workspaceId = getRouterParam(event, 'id')
  if (!workspaceId) throw createError({ statusCode: 400, statusMessage: 'id required' })
  await readAccess(event, workspaceId)

  const query = getQuery(event)
  const path = typeof query.path === 'string' ? query.path : null
  const excludeId = typeof query.excludeId === 'string' ? query.excludeId : null
  if (!path) return { chunk: null }

  const config = useRuntimeConfig(event)
  const db = getDb(config.databaseUrl as string)

  // Pick the latest non-diff chunk for this file. We rely on
  // metadata.kind != 'diff' rather than source_type because diff
  // chunks live under source_type='doc' (they ride the tsvector index
  // — see indexer/persist.ts persistGitHistory).
  const conds = [
    eq(chunks.workspaceId, workspaceId),
    eq(chunks.filePath, path),
    not(sql`coalesce(${chunks.metadata}->>'kind','') = 'diff'`),
  ]
  if (excludeId) conds.push(ne(chunks.id, excludeId))

  const [row] = await db
    .select()
    .from(chunks)
    .where(and(...conds))
    .orderBy(desc(chunks.createdAt))
    .limit(1)

  return { chunk: row ?? null }
})
