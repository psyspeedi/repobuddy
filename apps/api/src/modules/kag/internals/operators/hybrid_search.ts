import { sql } from 'drizzle-orm'
import type { Database } from '../../../../db/client'
import type { EmbeddingsProvider } from '../../../providers/internals/embeddings'

export interface HybridSearchResult {
  chunkId: string
  text: string
  filePath: string | null
  startLine: number | null
  endLine: number | null
  vectorRank: number
  textRank: number
  combinedScore: number
}

export interface HybridSearchParams {
  workspaceId: string
  query: string
  limit?: number
}

const RRF_K = 60

/**
 * Hybrid search combining vector cosine similarity and Postgres
 * full-text rank via Reciprocal Rank Fusion (RRF).
 *
 * RRF: score = sum(1 / (k + rank_i)) across each ranking. k=60 is the
 * commonly cited starting point (Cormack et al. 2009).
 *
 * Falls back to whichever search returned results if the other side
 * is empty (e.g. workspace not yet embedded, or query has no
 * tsquery-valid terms).
 */
export async function hybridSearch(
  db: Database,
  embeddings: EmbeddingsProvider,
  params: HybridSearchParams,
): Promise<HybridSearchResult[]> {
  const limit = params.limit ?? 10
  const fetchLimit = limit * 4

  const [queryVec] = await embeddings.embedBatch([params.query])
  if (!queryVec) return []
  const vecLiteral = `[${queryVec.join(',')}]`

  // Vector ranks (cosine distance ASC = most similar first).
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
    FROM chunks
    WHERE workspace_id = ${params.workspaceId}
      AND embedding IS NOT NULL
    ORDER BY embedding <=> ${vecLiteral}::vector ASC
    LIMIT ${fetchLimit}
  `)

  // Text ranks (ts_rank DESC = best match first).
  // websearch_to_tsquery handles spaces, OR, quotes gracefully — robust
  // against user input that breaks tsquery.
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
    FROM chunks
    WHERE workspace_id = ${params.workspaceId}
      AND text_tsv @@ websearch_to_tsquery('english', ${params.query})
    ORDER BY ts_rank(text_tsv, websearch_to_tsquery('english', ${params.query})) DESC
    LIMIT ${fetchLimit}
  `)

  // Merge.
  const merged = new Map<
    string,
    {
      text: string
      filePath: string | null
      startLine: number | null
      endLine: number | null
      vectorRank: number
      textRank: number
      score: number
    }
  >()

  for (const row of vectorRows) {
    const rank = Number(row.rank)
    merged.set(row.id, {
      text: row.text,
      filePath: row.file_path,
      startLine: row.start_line,
      endLine: row.end_line,
      vectorRank: rank,
      textRank: Number.POSITIVE_INFINITY,
      score: 1 / (RRF_K + rank),
    })
  }
  for (const row of textRows) {
    const rank = Number(row.rank)
    const existing = merged.get(row.id)
    if (existing) {
      existing.textRank = rank
      existing.score += 1 / (RRF_K + rank)
    } else {
      merged.set(row.id, {
        text: row.text,
        filePath: row.file_path,
        startLine: row.start_line,
        endLine: row.end_line,
        vectorRank: Number.POSITIVE_INFINITY,
        textRank: rank,
        score: 1 / (RRF_K + rank),
      })
    }
  }

  return [...merged.entries()]
    .map(([id, v]) => ({
      chunkId: id,
      text: v.text,
      filePath: v.filePath,
      startLine: v.startLine,
      endLine: v.endLine,
      vectorRank: v.vectorRank,
      textRank: v.textRank,
      combinedScore: v.score,
    }))
    .sort((a, b) => b.combinedScore - a.combinedScore)
    .slice(0, limit)
}
