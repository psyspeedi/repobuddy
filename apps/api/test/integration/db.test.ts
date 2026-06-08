import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import postgres from 'postgres'
import { drizzle } from 'drizzle-orm/postgres-js'
import { eq, sql } from 'drizzle-orm'
import * as schema from '#server/db/schema'

import { TEST_DATABASE_URL as DATABASE_URL } from '../helpers/test-db'

let sqlClient: postgres.Sql
let db: ReturnType<typeof drizzle<typeof schema>>

beforeAll(async () => {
  sqlClient = postgres(DATABASE_URL, { max: 2 })
  db = drizzle(sqlClient, { schema })
})

afterAll(async () => {
  if (sqlClient) {
    await sqlClient.end({ timeout: 2 })
  }
})

async function truncateAll(): Promise<void> {
  await sqlClient.unsafe(
    `TRUNCATE TABLE
      chat_messages, chat_sessions, query_cache, llm_cost_log,
      entity_chunks, relations, entities, chunks,
      oauth_tokens, workspaces, users
    RESTART IDENTITY CASCADE`,
  )
}

describe('db integration', () => {
  it('has required extensions installed', async () => {
    const extensions = await sqlClient<{ extname: string }[]>`
      SELECT extname FROM pg_extension ORDER BY extname
    `
    const names = extensions.map((e) => e.extname)
    expect(names).toContain('vector')
    expect(names).toContain('pg_trgm')
    expect(names).toContain('uuid-ossp')
  })

  it('creates user and workspace with cascading delete', async () => {
    await truncateAll()
    const [user] = await db
      .insert(schema.users)
      .values({
        githubId: 'gh-1',
        githubLogin: 'tester',
      })
      .returning()
    expect(user).toBeDefined()
    expect(user!.id).toMatch(/^[0-9a-f-]{36}$/)

    const [ws] = await db
      .insert(schema.workspaces)
      .values({
        ownerUserId: user!.id,
        name: 'My repo',
        sourceType: 'github',
        sourceUrl: 'https://github.com/sindresorhus/p-limit',
      })
      .returning()
    expect(ws!.status).toBe('pending')
    expect(ws!.languages).toEqual([])

    await db.delete(schema.users).where(eq(schema.users.id, user!.id))
    const remaining = await db.select().from(schema.workspaces)
    expect(remaining).toHaveLength(0)
  })

  it('stores and retrieves entity with vector embedding', async () => {
    await truncateAll()
    const [user] = await db
      .insert(schema.users)
      .values({ githubId: 'gh-2', githubLogin: 'tester' })
      .returning()
    const [ws] = await db
      .insert(schema.workspaces)
      .values({
        ownerUserId: user!.id,
        name: 'r',
        sourceType: 'upload',
      })
      .returning()

    const embedding = Array.from({ length: 1536 }, (_, i) => i / 1536)
    const [entity] = await db
      .insert(schema.entities)
      .values({
        workspaceId: ws!.id,
        type: 'function',
        name: 'processPayment',
        qualifiedName: 'src/orders.ts::processPayment',
        normalizedName: 'processpayment',
        language: 'typescript',
        filePath: 'src/orders.ts',
        startLine: 10,
        endLine: 30,
        embedding,
      })
      .returning()

    expect(entity!.embedding).toHaveLength(1536)
    expect(entity!.embedding![0]).toBeCloseTo(0, 5)
  })

  it('auto-populates tsvector for chunks (generated column)', async () => {
    await truncateAll()
    const [user] = await db
      .insert(schema.users)
      .values({ githubId: 'gh-3', githubLogin: 'tester' })
      .returning()
    const [ws] = await db
      .insert(schema.workspaces)
      .values({
        ownerUserId: user!.id,
        name: 'r',
        sourceType: 'upload',
      })
      .returning()

    const [chunk] = await db
      .insert(schema.chunks)
      .values({
        workspaceId: ws!.id,
        sourceType: 'code',
        filePath: 'src/index.ts',
        text: 'export function processPayment(order: Order) { /* logic */ }',
      })
      .returning()

    const [{ tsv }] = await sqlClient<{ tsv: string }[]>`
      SELECT text_tsv::text AS tsv FROM chunks WHERE id = ${chunk!.id}
    `
    expect(tsv).toContain('processpay')
    expect(tsv).toContain('order')
  })

  it('enforces unique workspace+qualified_name on entities', async () => {
    await truncateAll()
    const [user] = await db
      .insert(schema.users)
      .values({ githubId: 'gh-4', githubLogin: 'tester' })
      .returning()
    const [ws] = await db
      .insert(schema.workspaces)
      .values({
        ownerUserId: user!.id,
        name: 'r',
        sourceType: 'upload',
      })
      .returning()

    await db.insert(schema.entities).values({
      workspaceId: ws!.id,
      type: 'class',
      name: 'OrderService',
      qualifiedName: 'src/orders.ts::OrderService',
      normalizedName: 'orderservice',
    })

    await expect(
      db.insert(schema.entities).values({
        workspaceId: ws!.id,
        type: 'class',
        name: 'OrderService',
        qualifiedName: 'src/orders.ts::OrderService',
        normalizedName: 'orderservice',
      }),
    ).rejects.toThrow()
  })

  it('supports vector cosine similarity search', async () => {
    await truncateAll()
    const [user] = await db
      .insert(schema.users)
      .values({ githubId: 'gh-5', githubLogin: 'tester' })
      .returning()
    const [ws] = await db
      .insert(schema.workspaces)
      .values({
        ownerUserId: user!.id,
        name: 'r',
        sourceType: 'upload',
      })
      .returning()

    const target = Array.from({ length: 1536 }, () => 0.1)
    const far = Array.from({ length: 1536 }, () => 0.9)

    await db.insert(schema.chunks).values([
      {
        workspaceId: ws!.id,
        sourceType: 'code',
        text: 'near',
        embedding: target,
      },
      {
        workspaceId: ws!.id,
        sourceType: 'code',
        text: 'far',
        embedding: far,
      },
    ])

    const results = await sqlClient<{ text: string; distance: number }[]>`
      SELECT text, embedding <=> ${JSON.stringify(target)}::vector AS distance
      FROM chunks WHERE workspace_id = ${ws!.id}
      ORDER BY distance ASC
    `
    expect(results[0]!.text).toBe('near')
    expect(results[1]!.text).toBe('far')
  })
})
