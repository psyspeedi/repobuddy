/**
 * Hierarchical view of the workspace's files for the treemap on the
 * /w/[id]/explore page. Aggregates per-file metrics:
 *   - loc:      entity count attached to the file (a proxy for size)
 *   - hotness:  metadata.hotness from indexer/git/history (commits in
 *               last 90d touching the file)
 *   - coverage: boolean — does the file have any inbound `tested_by`
 *               relation?
 *
 * Folder structure is derived from file_path by splitting on '/'.
 * Returns a single root node with nested children. Leaves carry
 * { id, name, path, value, ...metrics }.
 */
import { and, eq, isNotNull, sql } from 'drizzle-orm'
import { getDb } from '../../../db/client'
import { entities, relations } from '../../../db/schema'
import { readAccess } from '../../../lib/workspace-access'

interface FileRow {
  id: string
  path: string
  entityCount: number
  hotness: number
  hasTests: boolean
}
interface Node {
  name: string
  path: string
  children?: Node[]
  value?: number
  meta?: {
    entityCount: number
    hotness: number
    hasTests: boolean
    entityId: string
  }
}

export default defineEventHandler(async (event) => {
  const workspaceId = getRouterParam(event, 'id')
  if (!workspaceId) throw createError({ statusCode: 400, statusMessage: 'id required' })
  await readAccess(event, workspaceId)

  const config = useRuntimeConfig(event)
  const db = getDb(config.databaseUrl as string)

  // Step 1: file entities + hotness.
  const fileRows = await db
    .select({
      id: entities.id,
      filePath: entities.filePath,
      metadata: entities.metadata,
    })
    .from(entities)
    .where(
      and(
        eq(entities.workspaceId, workspaceId),
        eq(entities.type, 'file'),
        isNotNull(entities.filePath),
      ),
    )

  if (fileRows.length === 0) {
    return { root: { name: 'root', path: '', children: [] }, totalFiles: 0 }
  }

  // Step 2: per-file entity counts (everything that defined_in this file).
  // We could compute this through relations, but a direct count of
  // entities sharing file_path is faster and gives roughly the same
  // signal — both class methods and orphan functions show up.
  const counts = await db.execute<{ file_path: string; n: number }>(sql`
    SELECT file_path, count(*)::int AS n
    FROM ${entities}
    WHERE workspace_id = ${workspaceId} AND file_path IS NOT NULL
    GROUP BY file_path
  `)
  const countByPath = new Map<string, number>()
  for (const r of counts) countByPath.set(r.file_path, Number(r.n))

  // Step 3: which file entities have an inbound `tested_by`?
  const tested = await db.execute<{ file_path: string }>(sql`
    SELECT DISTINCT e.file_path
    FROM ${entities} e
    INNER JOIN ${relations} r ON r.from_entity_id = e.id AND r.type = 'tested_by'
    WHERE e.workspace_id = ${workspaceId} AND e.file_path IS NOT NULL
  `)
  const coveredPaths = new Set<string>(tested.map((r) => r.file_path))

  const files: FileRow[] = fileRows
    .filter((f) => f.filePath != null)
    .map((f) => {
      const meta = (f.metadata as { hotness?: number } | null) ?? null
      return {
        id: f.id,
        path: f.filePath as string,
        entityCount: countByPath.get(f.filePath as string) ?? 1,
        hotness: meta?.hotness ?? 0,
        hasTests: coveredPaths.has(f.filePath as string),
      }
    })

  // Step 4: build the tree from path segments.
  const root: Node = { name: workspaceId.slice(0, 8), path: '', children: [] }
  for (const f of files) {
    const segments = f.path.split('/').filter(Boolean)
    let cursor = root
    for (let i = 0; i < segments.length - 1; i++) {
      const seg = segments[i] as string
      cursor.children = cursor.children ?? []
      let next = cursor.children.find((c) => c.name === seg && !c.value)
      if (!next) {
        next = { name: seg, path: segments.slice(0, i + 1).join('/'), children: [] }
        cursor.children.push(next)
      }
      cursor = next
    }
    cursor.children = cursor.children ?? []
    cursor.children.push({
      name: segments[segments.length - 1] ?? f.path,
      path: f.path,
      value: f.entityCount,
      meta: {
        entityCount: f.entityCount,
        hotness: f.hotness,
        hasTests: f.hasTests,
        entityId: f.id,
      },
    })
  }

  return { root, totalFiles: files.length }
})
