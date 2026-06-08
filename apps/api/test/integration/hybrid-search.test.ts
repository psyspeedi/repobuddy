import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import postgres from 'postgres'
import { drizzle } from 'drizzle-orm/postgres-js'
import * as schema from '#server/db/schema'
import { hybridSearch } from '#server/kag/operators/hybrid_search'
import { MockEmbeddingsProvider } from '#server/providers/embeddings'
import { embedChunks } from '#server/indexer/embed'

import { TEST_DATABASE_URL as DATABASE_URL } from '../helpers/test-db'

let sqlClient: postgres.Sql
let db: ReturnType<typeof drizzle<typeof schema>>
const provider = new MockEmbeddingsProvider()

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

async function seedWorkspace(
  texts: string[],
): Promise<{ workspaceId: string; chunkIds: string[] }> {
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
  const rows = await db
    .insert(schema.chunks)
    .values(
      texts.map((t) => ({
        workspaceId: ws!.id,
        sourceType: 'code' as const,
        text: t,
      })),
    )
    .returning({ id: schema.chunks.id })
  const chunkIds = rows.map((r) => r.id)
  await embedChunks(db, ws!.id, chunkIds, provider)
  return { workspaceId: ws!.id, chunkIds }
}

describe('hybridSearch', () => {
  it('returns top-N chunks ordered by combined score', async () => {
    const { workspaceId } = await seedWorkspace([
      'process payment for order with amount and currency',
      'render dashboard widgets and charts',
      'handle user authentication via oauth providers',
      'compute discount applied to order total',
    ])

    const results = await hybridSearch(db, provider, {
      workspaceId,
      query: 'payment processing for orders',
      limit: 3,
    })

    expect(results.length).toBeGreaterThan(0)
    expect(results.length).toBeLessThanOrEqual(3)
    // The payment chunk should rank in the top result(s).
    expect(results[0]?.text).toContain('payment')
  })

  it('returns full-text match when vector ranking is weak', async () => {
    const { workspaceId } = await seedWorkspace([
      'foo',
      'bar baz quux',
      'OrderService.processPayment validates and charges',
      'totally unrelated content about cats and dogs',
    ])

    const results = await hybridSearch(db, provider, {
      workspaceId,
      query: 'processPayment',
      limit: 3,
    })
    expect(results.length).toBeGreaterThan(0)
    // RRF can place the full-text hit anywhere in the top-K — assert
    // its presence in the result set rather than at exact position 0.
    expect(results.some((r) => r.text.includes('processPayment'))).toBe(true)
  })

  it('handles empty workspace gracefully', async () => {
    const [user] = await db
      .insert(schema.users)
      .values({ githubId: 'gh-empty', githubLogin: 't' })
      .returning()
    const [ws] = await db
      .insert(schema.workspaces)
      .values({
        ownerUserId: user!.id,
        name: 'empty',
        sourceType: 'upload',
      })
      .returning()
    const results = await hybridSearch(db, provider, {
      workspaceId: ws!.id,
      query: 'anything',
      limit: 5,
    })
    expect(results).toEqual([])
  })

  it('survives queries with no full-text matches', async () => {
    const { workspaceId } = await seedWorkspace([
      'export class Foo {}',
      'export function bar() {}',
    ])
    const results = await hybridSearch(db, provider, {
      workspaceId,
      query: 'thisExactStringIsNotPresentInAnyChunk',
      limit: 5,
    })
    // Vector search should still return ranked results.
    expect(results.length).toBeGreaterThan(0)
  })
})
