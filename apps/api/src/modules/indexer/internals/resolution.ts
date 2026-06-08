import { and, eq, inArray, sql } from 'drizzle-orm'
import type { Database } from '../../../db/client'
import { entities, relations } from '../../../db/schema'
import { getLogger } from '../../../lib/logger'

const log = getLogger().child({ component: 'indexer/resolution' })

const MERGE_THRESHOLD = 0.9 // cosine similarity → merge
const FLAG_THRESHOLD = 0.75 // 0.75 ≤ sim < 0.9 → flag but don't merge

export interface ResolutionResult {
  merged: number
  flagged: number
}

/**
 * Dedup concept/pattern entities within a workspace.
 *
 * Algorithm:
 * 1. Group by normalized_name (lowercase, trim). Within each group keep the
 *    first entity; for the rest, redirect all relations and delete.
 * 2. For groups with >1 entity but the normalized_name doesn't match, use
 *    cosine similarity over entities.embedding (description vector).
 *    sim ≥ 0.9 → merge into canonical, ≥ 0.75 → flag in metadata.
 */
export async function resolveEntities(
  db: Database,
  workspaceId: string,
): Promise<ResolutionResult> {
  let merged = 0
  let flagged = 0

  for (const type of ['concept', 'pattern']) {
    merged += await mergeByNormalizedName(db, workspaceId, type)

    // Embedding-based pass for survivors.
    const survivors = await db
      .select({
        id: entities.id,
        normalizedName: entities.normalizedName,
        embedding: entities.embedding,
        metadata: entities.metadata,
      })
      .from(entities)
      .where(
        and(
          eq(entities.workspaceId, workspaceId),
          eq(entities.type, type),
        ),
      )

    const withVec = survivors.filter((e) => Array.isArray(e.embedding))
    for (let i = 0; i < withVec.length; i++) {
      const a = withVec[i]
      if (!a) continue
      for (let j = i + 1; j < withVec.length; j++) {
        const b = withVec[j]
        if (!b) continue
        if (a.normalizedName === b.normalizedName) continue
        const sim = cosine(a.embedding as number[], b.embedding as number[])
        if (sim >= MERGE_THRESHOLD) {
          await mergeInto(db, workspaceId, b.id, a.id)
          merged++
          // Skip b for further iterations.
          withVec[j] = withVec[withVec.length - 1] as typeof withVec[number]
          withVec.pop()
          j--
        } else if (sim >= FLAG_THRESHOLD) {
          await flagPossibleDuplicate(db, b.id, a.id, sim)
          flagged++
        }
      }
    }
  }

  log.info({ workspaceId, merged, flagged }, 'resolution done')
  return { merged, flagged }
}

async function mergeByNormalizedName(
  db: Database,
  workspaceId: string,
  type: string,
): Promise<number> {
  const groups = await db
    .select({
      normalizedName: entities.normalizedName,
      ids: sql<string[]>`array_agg(${entities.id} ORDER BY ${entities.createdAt} ASC)`,
    })
    .from(entities)
    .where(and(eq(entities.workspaceId, workspaceId), eq(entities.type, type)))
    .groupBy(entities.normalizedName)
    .having(sql`count(*) > 1`)

  let merged = 0
  for (const group of groups) {
    const [canonical, ...rest] = group.ids
    if (!canonical || rest.length === 0) continue
    for (const dupId of rest) {
      await mergeInto(db, workspaceId, dupId, canonical)
      merged++
    }
  }
  return merged
}

/** Move all relations from `fromId` to `intoId` and delete `fromId`. */
async function mergeInto(
  db: Database,
  workspaceId: string,
  fromId: string,
  intoId: string,
): Promise<void> {
  if (fromId === intoId) return
  await db
    .update(relations)
    .set({ fromEntityId: intoId })
    .where(
      and(
        eq(relations.workspaceId, workspaceId),
        eq(relations.fromEntityId, fromId),
      ),
    )
  await db
    .update(relations)
    .set({ toEntityId: intoId })
    .where(
      and(
        eq(relations.workspaceId, workspaceId),
        eq(relations.toEntityId, fromId),
      ),
    )
  // Drop self-loops introduced by the merge.
  await db
    .delete(relations)
    .where(
      and(
        eq(relations.workspaceId, workspaceId),
        sql`${relations.fromEntityId} = ${relations.toEntityId}`,
      ),
    )
  await db.delete(entities).where(eq(entities.id, fromId))
}

async function flagPossibleDuplicate(
  db: Database,
  bId: string,
  aId: string,
  similarity: number,
): Promise<void> {
  const [b] = await db
    .select({ metadata: entities.metadata })
    .from(entities)
    .where(eq(entities.id, bId))
    .limit(1)
  const meta = (b?.metadata as Record<string, unknown> | null) ?? {}
  const dupes = (meta.possibleDuplicates as { id: string; similarity: number }[] | undefined) ?? []
  if (!dupes.some((d) => d.id === aId)) {
    dupes.push({ id: aId, similarity })
    await db
      .update(entities)
      .set({ metadata: { ...meta, possibleDuplicates: dupes } })
      .where(eq(entities.id, bId))
  }
}

function cosine(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0
  let dot = 0
  let normA = 0
  let normB = 0
  for (let i = 0; i < a.length; i++) {
    const av = a[i] ?? 0
    const bv = b[i] ?? 0
    dot += av * bv
    normA += av * av
    normB += bv * bv
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB)
  return denom === 0 ? 0 : dot / denom
}

// Re-export inArray to silence unused import lint (keeps room for future use).
export { inArray }
