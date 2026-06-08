import { inArray, sql } from 'drizzle-orm'
import type { Database } from '../../../db/client'
import { chunks } from '../../../db/schema'
import type { EmbeddingsProvider } from '../../providers/internals/embeddings'
import { recordCost } from '../../../lib/cost-log'
import { getLogger } from '../../../lib/logger'

const log = getLogger().child({ component: 'indexer/embed' })

const BATCH_SIZE = 64

/**
 * Compute embeddings for every chunk in `chunkIds` that doesn't have one yet,
 * and write them back via UPDATE. Returns the count of newly embedded chunks.
 *
 * The provider is responsible for batching at API granularity; this function
 * handles DB-side batching and the "skip already embedded" filter.
 */
export async function embedChunks(
  db: Database,
  workspaceId: string,
  chunkIds: string[],
  provider: EmbeddingsProvider,
  onProgress?: (done: number, total: number) => void,
): Promise<number> {
  if (chunkIds.length === 0) return 0

  // Read chunks that still need embedding.
  const pending = await db
    .select({ id: chunks.id, text: chunks.text })
    .from(chunks)
    .where(
      sql`${chunks.id} IN (${sql.join(chunkIds.map((id) => sql`${id}`), sql`, `)})
          AND ${chunks.embedding} IS NULL
          AND ${chunks.workspaceId} = ${workspaceId}`,
    )

  if (pending.length === 0) return 0

  let processed = 0
  for (let start = 0; start < pending.length; start += BATCH_SIZE) {
    const batch = pending.slice(start, start + BATCH_SIZE)
    const vectors = await provider.embedBatch(batch.map((c) => c.text))
    // Update one-by-one — pgvector array literal makes a single UPDATE FROM
    // (VALUES …) painful with parameterised arrays in postgres-js. The
    // per-row UPDATE is fast enough for the chunk volumes we deal with.
    for (let i = 0; i < batch.length; i++) {
      const row = batch[i]
      const vec = vectors[i]
      if (!row || !vec) continue
      await db
        .update(chunks)
        .set({ embedding: vec })
        .where(sql`${chunks.id} = ${row.id}`)
    }
    processed += batch.length
    onProgress?.(processed, pending.length)
  }

  // Approximate token spend for cost logging. Embedding endpoints don't
  // return usage per-call, so we estimate ~text.length/4 (English-leaning
  // rule of thumb). Off by 2× for non-ASCII heavy content, but good
  // enough to spot runaway indexing costs.
  const approxTokens = pending.reduce(
    (s, c) => s + Math.ceil(c.text.length / 4),
    0,
  )
  await recordCost(db, {
    workspaceId,
    phase: 'embedding',
    model: provider.model,
    inputTokens: approxTokens,
    costCentsPer1MInput: provider.costCentsPer1MTokens,
  })

  log.info({ workspaceId, count: processed, model: provider.model }, 'embedded chunks')
  return processed
}

/**
 * Convenience: embed *all* chunks in a workspace that lack a vector.
 * Used by reruns where chunkIds wasn't preserved.
 */
export async function embedAllPendingChunks(
  db: Database,
  workspaceId: string,
  provider: EmbeddingsProvider,
): Promise<number> {
  const rows = await db
    .select({ id: chunks.id })
    .from(chunks)
    .where(sql`${chunks.workspaceId} = ${workspaceId} AND ${chunks.embedding} IS NULL`)
  if (rows.length === 0) return 0
  return embedChunks(db, workspaceId, rows.map((r) => r.id), provider)
}

// Re-export inArray for callers — avoids extra Drizzle imports in callsites.
export { inArray }
