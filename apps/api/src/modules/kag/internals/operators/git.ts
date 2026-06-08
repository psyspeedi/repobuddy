import { sql } from 'drizzle-orm'
import { entities, relations } from '../../../../db/schema'
import type { GraphEntity, OperatorContext } from './_types'

// ---------- git_history ----------
export interface GitHistoryParams {
  entity: GraphEntity
  since?: string
  limit?: number
}

export async function gitHistory(
  params: GitHistoryParams,
  ctx: OperatorContext,
): Promise<{ sha: string; message: string; author: string; date: string }[]> {
  const fileId = params.entity?.id
  if (!fileId) return []
  const limit = params.limit ?? 50
  const sinceClause = params.since
    ? sql`AND (c.metadata->>'date')::timestamptz >= ${params.since}::timestamptz`
    : sql``
  const rows = await ctx.db.execute<{
    sha: string
    message: string
    author: string
    date: string
  }>(sql`
    SELECT
      c.metadata->>'sha'      AS sha,
      c.metadata->>'message'  AS message,
      c.metadata->>'author'   AS author,
      c.metadata->>'date'     AS date
    FROM ${entities} c
    INNER JOIN ${relations} r
      ON r.from_entity_id = c.id
     AND r.type = 'modified_by'
     AND r.to_entity_id = ${fileId}
    WHERE c.workspace_id = ${ctx.workspaceId}
      AND c.type = 'commit'
      ${sinceClause}
    ORDER BY (c.metadata->>'date')::timestamptz DESC
    LIMIT ${limit}
  `)
  return [...rows]
}
