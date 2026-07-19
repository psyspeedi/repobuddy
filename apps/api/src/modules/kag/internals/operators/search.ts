import { DRIZZLE_DB, type DrizzleDb } from '#modules/drizzle/drizzle.tokens'
import type { Database } from '#server/db/client'
import { Inject, Injectable } from '@nestjs/common'
import { sql } from 'drizzle-orm'
import { chunks } from '#server/db/schema'
import { hybridSearch } from './hybrid_search'
import type { KagOperator } from './_interface'
import type { GraphEntity, OperatorContext } from './_types'

// ---------- hybrid_search wrapper ----------
export async function hybridSearchOp(
  params: { query: string; limit?: number },
  ctx: OperatorContext,
  db: Database,
) {
  return hybridSearch(db, ctx.embeddings, {
    workspaceId: ctx.workspaceId,
    query: params.query,
    limit: params.limit,
  })
}

// ---------- search_docs ----------
// Same retrieval mechanics as hybrid_search but restricted to chunks whose
// source_type is 'doc' (markdown / PR descriptions). Used by the planner for
// broad / architectural / "tell me about X" questions where README and design
// notes are likelier to ground a good answer than raw code.
export async function searchDocs(
  params: { query: string; limit?: number },
  ctx: OperatorContext,
  db: Database,
): Promise<
  {
    id: string
    text: string
    filePath: string | null
    startLine: number | null
    endLine: number | null
    score: number
  }[]
> {
  const limit = params.limit ?? 12
  const fetchLimit = limit * 4
  const [vec] = await ctx.embeddings.embedBatch([params.query])
  if (!vec) return []
  const vecLiteral = `[${vec.join(',')}]`

  const vectorRows = await db.execute<{
    id: string
    text: string
    file_path: string | null
    start_line: number | null
    end_line: number | null
    rank: number
  }>(sql`
    SELECT id, text, file_path, start_line, end_line,
           row_number() OVER (ORDER BY embedding <=> ${vecLiteral}::vector ASC) AS rank
    FROM ${chunks}
    WHERE workspace_id = ${ctx.workspaceId}
      AND source_type = 'doc'
      AND embedding IS NOT NULL
    ORDER BY embedding <=> ${vecLiteral}::vector ASC
    LIMIT ${fetchLimit}
  `)

  const textRows = await db.execute<{
    id: string
    text: string
    file_path: string | null
    start_line: number | null
    end_line: number | null
    rank: number
  }>(sql`
    SELECT id, text, file_path, start_line, end_line,
           row_number() OVER (
             ORDER BY ts_rank(text_tsv, websearch_to_tsquery('english', ${params.query})) DESC
           ) AS rank
    FROM ${chunks}
    WHERE workspace_id = ${ctx.workspaceId}
      AND source_type = 'doc'
      AND text_tsv @@ websearch_to_tsquery('english', ${params.query})
    ORDER BY ts_rank(text_tsv, websearch_to_tsquery('english', ${params.query})) DESC
    LIMIT ${fetchLimit}
  `)

  const RRF_K = 60
  const merged = new Map<string, {
    text: string
    filePath: string | null
    startLine: number | null
    endLine: number | null
    score: number
  }>()
  for (const row of vectorRows) {
    merged.set(row.id, {
      text: row.text,
      filePath: row.file_path,
      startLine: row.start_line,
      endLine: row.end_line,
      score: 1 / (RRF_K + Number(row.rank)),
    })
  }
  for (const row of textRows) {
    const rank = Number(row.rank)
    const existing = merged.get(row.id)
    if (existing) existing.score += 1 / (RRF_K + rank)
    else
      merged.set(row.id, {
        text: row.text,
        filePath: row.file_path,
        startLine: row.start_line,
        endLine: row.end_line,
        score: 1 / (RRF_K + rank),
      })
  }
  return [...merged.entries()]
    .map(([id, v]) => ({ id, ...v }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
}

// ---------- retrieve_code_chunks ----------
export interface RetrieveCodeChunksParams {
  entities: GraphEntity | GraphEntity[]
  limit?: number
}

export async function retrieveCodeChunks(
  params: RetrieveCodeChunksParams,
  ctx: OperatorContext,
  db: Database,
): Promise<{ id: string; text: string; filePath: string | null; startLine: number | null; endLine: number | null }[]> {
  const list = Array.isArray(params.entities) ? params.entities : [params.entities]
  const ids = list.map((e) => e?.id).filter((id): id is string => Boolean(id))
  if (ids.length === 0) return []
  const limit = params.limit ?? 50
  const rows = await db.execute<{
    id: string
    text: string
    file_path: string | null
    start_line: number | null
    end_line: number | null
  }>(sql`
    SELECT DISTINCT c.id, c.text, c.file_path, c.start_line, c.end_line
    FROM ${chunks} c
    INNER JOIN entity_chunks ec ON ec.chunk_id = c.id
    WHERE c.workspace_id = ${ctx.workspaceId}
      AND ec.entity_id = ANY (ARRAY[${sql.join(ids.map((id) => sql`${id}::uuid`), sql`, `)}])
    LIMIT ${limit}
  `)
  return rows.map((r) => ({
    id: r.id,
    text: r.text,
    filePath: r.file_path,
    startLine: r.start_line,
    endLine: r.end_line,
  }))
}

// ---------- @Injectable wrappers ----------

@Injectable()
export class HybridSearchOperator implements KagOperator {
  readonly name = 'hybrid_search' as const
  constructor(@Inject(DRIZZLE_DB) private readonly db: DrizzleDb) {}
  execute(p: { query: string; limit?: number }, c: OperatorContext) { return hybridSearchOp(p, c, this.db) }
}

@Injectable()
export class SearchDocsOperator implements KagOperator {
  readonly name = 'search_docs' as const
  constructor(@Inject(DRIZZLE_DB) private readonly db: DrizzleDb) {}
  execute(p: { query: string; limit?: number }, c: OperatorContext) { return searchDocs(p, c, this.db) }
}

@Injectable()
export class RetrieveCodeChunksOperator implements KagOperator<RetrieveCodeChunksParams> {
  readonly name = 'retrieve_code_chunks' as const
  constructor(@Inject(DRIZZLE_DB) private readonly db: DrizzleDb) {}
  execute(p: RetrieveCodeChunksParams, c: OperatorContext) { return retrieveCodeChunks(p, c, this.db) }
}
