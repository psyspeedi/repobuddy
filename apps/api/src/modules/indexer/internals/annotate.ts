import { and, eq, inArray, sql } from 'drizzle-orm'
import type { Database } from '#server/db/client'
import { chunks, entities, relations } from '#server/db/schema'
import type { LLMProvider } from '#server/providers/llm'
import type { EmbeddingsProvider } from '#server/providers/embeddings'
import {
  SemanticAnnotationSchema,
  type SemanticAnnotation,
} from '#shared/schemas/annotation'
import { getLogger } from '#server/lib/logger'
import { recordCost } from '#server/lib/cost-log'

const log = getLogger().child({ component: 'indexer/annotate' })

const ANNOTATABLE_TYPES = ['class', 'function', 'module'] as const
const MIN_LINES_FOR_ANNOTATION = 8

const SYSTEM_PROMPT = `You analyse a code entity (class, function, or module) and respond ONLY with a single JSON object matching this shape:
{
  "description": "1-3 sentences in plain English describing what the entity does",
  "concepts": [{ "name": "concept name", "evidenceQuote": "quote copied from the code" }],
  "patterns": [{ "name": "pattern name", "confidence": "low|medium|high", "evidenceQuote": "quote" }]
}

- concepts: business / domain concepts implemented (e.g. "order processing"). Each must include a short evidence quote copied verbatim from the source.
- patterns: architectural / design patterns observed (e.g. "Repository"). Each must include confidence (low/medium/high) and an evidence quote.

Be conservative — empty arrays for concepts/patterns are fine when nothing clear applies. Output ONLY the JSON object, no surrounding prose.`

export interface AnnotateOptions {
  /** Hard cap on number of entities to annotate (to control cost). */
  maxEntities?: number
}

/**
 * Phase 4.1: walk every annotatable entity (class/function/module above
 * size threshold) and produce a SemanticAnnotation via LLM with structured
 * output. Persists the description on the entity itself, then creates
 * concept/pattern entities + implements_concept/follows_pattern relations.
 *
 * Phase 4.2: embed each entity's description and update entities.embedding.
 */
export async function annotateAndEmbed(
  db: Database,
  workspaceId: string,
  llm: LLMProvider,
  embeddings: EmbeddingsProvider,
  options: AnnotateOptions = {},
  onProgress?: (done: number, total: number) => void,
): Promise<{ annotated: number; conceptsCreated: number; patternsCreated: number }> {
  const candidates = await db
    .select()
    .from(entities)
    .where(
      and(
        eq(entities.workspaceId, workspaceId),
        inArray(entities.type, [...ANNOTATABLE_TYPES]),
      ),
    )

  const filtered = candidates.filter(
    (e) =>
      e.endLine != null &&
      e.startLine != null &&
      e.endLine - e.startLine + 1 >= MIN_LINES_FOR_ANNOTATION,
  )
  const cap = options.maxEntities ?? filtered.length
  const subset = filtered.slice(0, cap)

  log.info(
    { workspaceId, candidates: filtered.length, cap: subset.length },
    'starting annotation',
  )

  let annotated = 0
  let conceptsCreated = 0
  let patternsCreated = 0
  // Parallelism cap: gpt-4o-mini sustains many concurrent requests, but we
  // also write to the DB on each completion. 8 is a safe default that cuts
  // a 500-entity run from ~15 min to ~2 min without tripping rate limits.
  const CONCURRENCY = Number(process.env.ANNOTATION_CONCURRENCY ?? 8)
  let cursor = 0

  const worker = async (): Promise<void> => {
    while (true) {
      const i = cursor++
      if (i >= subset.length) return
      const entity = subset[i]
      if (!entity) return

      const code = await fetchEntityCode(db, workspaceId, entity)
      if (!code) {
        annotated++
        onProgress?.(annotated, subset.length)
        continue
      }
      try {
        // Author-written JSDoc/docstring extracted by the parser — when
        // present, it's the source-of-truth description. We still ask the
        // LLM for concepts/patterns, but feed the JSDoc text as context so
        // it grounds on author intent rather than re-inferring meaning
        // from the code alone.
        const authorDocs = readAuthorDocs(entity)
        const userContent = authorDocs
          ? `Entity ${entity.qualifiedName} (${entity.type}, ${entity.language}):\n\nAuthor-written JSDoc:\n${authorDocs}\n\nCode:\n${code}`
          : `Entity ${entity.qualifiedName} (${entity.type}, ${entity.language}):\n\n${code}`

        const annotation = await llm.structured<SemanticAnnotation>(
          [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content: userContent },
          ],
          { schema: SemanticAnnotationSchema, schemaName: 'semantic_annotation' },
        )

        // Approximate cost: structured() doesn't surface usage, so we
        // estimate input from the prompt size. Output is bounded by the
        // schema — ~200 tokens upper bound for our SemanticAnnotation.
        const promptChars = SYSTEM_PROMPT.length + userContent.length
        await recordCost(db, {
          workspaceId,
          phase: 'annotation',
          model: llm.model,
          inputTokens: Math.ceil(promptChars / 4),
          outputTokens: 200,
          costCentsPer1MInput: llm.costCentsPer1MInputTokens,
          costCentsPer1MOutput: llm.costCentsPer1MOutputTokens,
        })

        await db
          .update(entities)
          .set({ description: annotation.description })
          .where(eq(entities.id, entity.id))

        for (const c of annotation.concepts) {
          const conceptId = await upsertSemanticEntity(db, workspaceId, {
            type: 'concept',
            name: c.name,
          })
          if (conceptId) {
            await db
              .insert(relations)
              .values({
                workspaceId,
                fromEntityId: entity.id,
                toEntityId: conceptId,
                type: 'implements_concept',
                evidenceQuote: c.evidenceQuote,
              })
              .onConflictDoNothing()
            conceptsCreated++
          }
        }
        for (const p of annotation.patterns) {
          const patternId = await upsertSemanticEntity(db, workspaceId, {
            type: 'pattern',
            name: p.name,
          })
          if (patternId) {
            await db
              .insert(relations)
              .values({
                workspaceId,
                fromEntityId: entity.id,
                toEntityId: patternId,
                type: 'follows_pattern',
                evidenceQuote: p.evidenceQuote,
                metadata: { confidence: p.confidence },
              })
              .onConflictDoNothing()
            patternsCreated++
          }
        }
      } catch (err) {
        log.warn(
          { err, qualifiedName: entity.qualifiedName },
          'annotation failed for entity',
        )
      } finally {
        annotated++
        onProgress?.(annotated, subset.length)
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, subset.length) }, () => worker()),
  )

  // Phase 4.2: embed descriptions.
  await embedEntityDescriptions(db, workspaceId, embeddings)

  return { annotated, conceptsCreated, patternsCreated }
}

function readAuthorDocs(entity: typeof entities.$inferSelect): string | null {
  const meta = entity.metadata as { docs?: {
    description?: string
    params?: { name: string; description: string }[]
    returns?: string
    examples?: string[]
    deprecated?: string | true
  } } | null
  const docs = meta?.docs
  if (!docs) return null
  const lines: string[] = []
  if (docs.description) lines.push(docs.description)
  if (docs.params && docs.params.length > 0) {
    lines.push('Parameters:')
    for (const p of docs.params) {
      lines.push(`  - ${p.name}: ${p.description}`)
    }
  }
  if (docs.returns) lines.push(`Returns: ${docs.returns}`)
  if (docs.deprecated) {
    lines.push(`Deprecated${typeof docs.deprecated === 'string' ? `: ${docs.deprecated}` : ''}`)
  }
  if (docs.examples && docs.examples.length > 0) {
    lines.push('Examples:')
    for (const ex of docs.examples) {
      lines.push('```')
      lines.push(ex)
      lines.push('```')
    }
  }
  return lines.length > 0 ? lines.join('\n') : null
}

async function fetchEntityCode(
  db: Database,
  workspaceId: string,
  entity: typeof entities.$inferSelect,
): Promise<string | null> {
  if (!entity.qualifiedName) return null
  // Try to find a chunk linked via metadata.qualifiedName === entity.qualifiedName.
  const [row] = await db
    .select({ text: chunks.text })
    .from(chunks)
    .where(
      sql`${chunks.workspaceId} = ${workspaceId}
          AND ${chunks.metadata}->>'qualifiedName' = ${entity.qualifiedName}`,
    )
    .limit(1)
  return row?.text?.slice(0, 6000) ?? null
}

async function upsertSemanticEntity(
  db: Database,
  workspaceId: string,
  payload: { type: 'concept' | 'pattern'; name: string },
): Promise<string | null> {
  const normalized = payload.name.toLowerCase().trim()
  const qualified = `${payload.type}::${normalized}`
  const [existing] = await db
    .select({ id: entities.id })
    .from(entities)
    .where(
      and(
        eq(entities.workspaceId, workspaceId),
        eq(entities.qualifiedName, qualified),
      ),
    )
    .limit(1)
  if (existing) return existing.id

  const [created] = await db
    .insert(entities)
    .values({
      workspaceId,
      type: payload.type,
      name: payload.name,
      qualifiedName: qualified,
      normalizedName: normalized,
    })
    .onConflictDoNothing()
    .returning({ id: entities.id })
  return created?.id ?? null
}

/**
 * Embed entities.description into entities.embedding. Skips entities that
 * have no description or already have an embedding.
 */
export async function embedEntityDescriptions(
  db: Database,
  workspaceId: string,
  embeddings: EmbeddingsProvider,
): Promise<number> {
  const rows = await db
    .select({ id: entities.id, description: entities.description })
    .from(entities)
    .where(
      sql`${entities.workspaceId} = ${workspaceId}
          AND ${entities.description} IS NOT NULL
          AND ${entities.embedding} IS NULL`,
    )
  if (rows.length === 0) return 0

  const BATCH = 64
  let done = 0
  for (let i = 0; i < rows.length; i += BATCH) {
    const batch = rows.slice(i, i + BATCH)
    const vectors = await embeddings.embedBatch(batch.map((r) => r.description ?? ''))
    for (let j = 0; j < batch.length; j++) {
      const row = batch[j]
      const vec = vectors[j]
      if (!row || !vec) continue
      await db.update(entities).set({ embedding: vec }).where(eq(entities.id, row.id))
      done++
    }
  }
  log.info({ workspaceId, count: done }, 'embedded entity descriptions')
  return done
}
