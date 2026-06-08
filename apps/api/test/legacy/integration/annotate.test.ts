import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import postgres from 'postgres'
import { drizzle } from 'drizzle-orm/postgres-js'
import { and, eq, inArray } from 'drizzle-orm'
import * as schema from '../../server/db/schema'
import { MockEmbeddingsProvider } from '../../server/providers/embeddings'
import { MockLLMProvider } from '../../server/providers/llm'
import { annotateAndEmbed } from '../../server/indexer/annotate'

import { TEST_DATABASE_URL as DATABASE_URL } from '../helpers/test-db'

let sqlClient: postgres.Sql
let db: ReturnType<typeof drizzle<typeof schema>>

beforeAll(async () => {
  sqlClient = postgres(DATABASE_URL, { max: 2 })
  db = drizzle(sqlClient, { schema })
})

afterAll(async () => {
  await sqlClient.end({ timeout: 2 })
})

beforeEach(async () => {
  await sqlClient.unsafe(
    `TRUNCATE TABLE
      entity_chunks, relations, entities, chunks,
      oauth_tokens, workspaces, users
    RESTART IDENTITY CASCADE`,
  )
})

async function seed(): Promise<{ workspaceId: string; classId: string; classQualified: string }> {
  const [user] = await db
    .insert(schema.users)
    .values({ githubId: 'gh-' + Math.random(), githubLogin: 't' })
    .returning()
  const [ws] = await db
    .insert(schema.workspaces)
    .values({
      ownerUserId: user!.id,
      name: 'r',
      sourceType: 'upload',
    })
    .returning()
  const qualifiedName = 'src/orders.ts::OrderService'
  const [cls] = await db
    .insert(schema.entities)
    .values({
      workspaceId: ws!.id,
      type: 'class',
      name: 'OrderService',
      qualifiedName,
      normalizedName: 'orderservice',
      language: 'typescript',
      filePath: 'src/orders.ts',
      startLine: 10,
      endLine: 50,
    })
    .returning()
  await db.insert(schema.chunks).values({
    workspaceId: ws!.id,
    sourceType: 'code',
    filePath: 'src/orders.ts',
    startLine: 10,
    endLine: 50,
    text: 'export class OrderService { create() {} processPayment() {} }',
    metadata: { qualifiedName },
  })
  return { workspaceId: ws!.id, classId: cls!.id, classQualified: qualifiedName }
}

describe('annotateAndEmbed', () => {
  it('writes description, creates concept/pattern entities, persists relations', async () => {
    const { workspaceId, classId } = await seed()

    const llm = new MockLLMProvider()
    llm.setNextStructured({
      description: 'Manages order lifecycle: create and process payment.',
      concepts: [{ name: 'order processing', evidenceQuote: 'class OrderService' }],
      patterns: [
        {
          name: 'Service Layer',
          confidence: 'high',
          evidenceQuote: 'export class OrderService',
        },
      ],
    })
    const embeddings = new MockEmbeddingsProvider()

    const result = await annotateAndEmbed(db, workspaceId, llm, embeddings)
    expect(result.annotated).toBe(1)
    expect(result.conceptsCreated).toBe(1)
    expect(result.patternsCreated).toBe(1)

    const [updated] = await db
      .select()
      .from(schema.entities)
      .where(eq(schema.entities.id, classId))
      .limit(1)
    expect(updated!.description).toContain('Manages order lifecycle')
    expect(updated!.embedding).toBeTruthy()
    expect(updated!.embedding!.length).toBe(1536)

    const concepts = await db
      .select()
      .from(schema.entities)
      .where(
        and(
          eq(schema.entities.workspaceId, workspaceId),
          eq(schema.entities.type, 'concept'),
        ),
      )
    expect(concepts).toHaveLength(1)
    expect(concepts[0]?.name).toBe('order processing')

    const semanticRelations = await db
      .select()
      .from(schema.relations)
      .where(
        and(
          eq(schema.relations.workspaceId, workspaceId),
          inArray(schema.relations.type, ['implements_concept', 'follows_pattern']),
        ),
      )
    const relTypes = semanticRelations.map((r) => r.type).sort()
    expect(relTypes).toEqual(['follows_pattern', 'implements_concept'])
  })

  it('skips entities below MIN_LINES_FOR_ANNOTATION', async () => {
    const { workspaceId } = await seed()
    await db
      .insert(schema.entities)
      .values({
        workspaceId,
        type: 'function',
        name: 'tinyHelper',
        qualifiedName: 'src/u.ts::tinyHelper',
        normalizedName: 'tinyhelper',
        startLine: 1,
        endLine: 3,
      })
    const llm = new MockLLMProvider()
    llm.setNextStructured({
      description: 'd',
      concepts: [],
      patterns: [],
    })
    const result = await annotateAndEmbed(db, workspaceId, llm, new MockEmbeddingsProvider())
    expect(result.annotated).toBe(1) // only OrderService above threshold
  })

  it('survives LLM parse failure gracefully', async () => {
    const { workspaceId } = await seed()
    const llm = new MockLLMProvider()
    // Not calling setNextStructured → will throw inside structured()
    const result = await annotateAndEmbed(db, workspaceId, llm, new MockEmbeddingsProvider())
    expect(result.annotated).toBe(1)
    expect(result.conceptsCreated).toBe(0)
    expect(result.patternsCreated).toBe(0)
  })
})
