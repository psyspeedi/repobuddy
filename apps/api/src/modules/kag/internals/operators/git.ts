import { DRIZZLE_DB, type DrizzleDb } from '#modules/drizzle/drizzle.tokens'
import type { Database } from '#server/db/client'
import { Inject, Injectable } from '@nestjs/common'
import { sql } from 'drizzle-orm'
import { entities, relations } from '#server/db/schema'
import type { KagOperator } from './_interface'
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
  db: Database,
): Promise<{ sha: string; message: string; author: string; date: string }[]> {
  const fileId = params.entity?.id
  if (!fileId) return []
  const limit = params.limit ?? 50
  const sinceClause = params.since
    ? sql`AND (c.metadata->>'date')::timestamptz >= ${params.since}::timestamptz`
    : sql``
  const rows = await db.execute<{
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

@Injectable()
export class GitHistoryOperator implements KagOperator<GitHistoryParams> {
  readonly name = 'git_history' as const
  constructor(@Inject(DRIZZLE_DB) private readonly db: DrizzleDb) {}
  execute(p: GitHistoryParams, c: OperatorContext) { return gitHistory(p, c, this.db) }
}
