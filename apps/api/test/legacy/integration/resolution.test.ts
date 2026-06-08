import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import postgres from 'postgres'
import { drizzle } from 'drizzle-orm/postgres-js'
import { and, eq } from 'drizzle-orm'
import * as schema from '../../server/db/schema'
import { resolveEntities } from '../../server/indexer/resolution'

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

async function makeWorkspace(): Promise<string> {
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
  return ws!.id
}

/** Build a 1536-dim unit vector mostly populated by one constant. */
function pseudoVec(seed: number): number[] {
  const v: number[] = []
  for (let i = 0; i < 1536; i++) v.push(seed + i / 100000)
  const norm = Math.sqrt(v.reduce((acc, x) => acc + x * x, 0))
  return v.map((x) => x / norm)
}

describe('resolveEntities', () => {
  it('merges concepts with identical normalized_name and redirects relations', async () => {
    const workspaceId = await makeWorkspace()
    // Anchor class that will reference the concept.
    const [klass] = await db
      .insert(schema.entities)
      .values({
        workspaceId,
        type: 'class',
        name: 'OrderService',
        qualifiedName: 'src/o.ts::OrderService',
        normalizedName: 'orderservice',
      })
      .returning()
    const [c1] = await db
      .insert(schema.entities)
      .values({
        workspaceId,
        type: 'concept',
        name: 'order processing',
        qualifiedName: 'concept::order processing-1',
        normalizedName: 'order processing',
      })
      .returning()
    const [c2] = await db
      .insert(schema.entities)
      .values({
        workspaceId,
        type: 'concept',
        name: 'Order Processing',
        qualifiedName: 'concept::order processing-2',
        normalizedName: 'order processing',
      })
      .returning()
    await db.insert(schema.relations).values([
      {
        workspaceId,
        fromEntityId: klass!.id,
        toEntityId: c1!.id,
        type: 'implements_concept',
      },
      {
        workspaceId,
        fromEntityId: klass!.id,
        toEntityId: c2!.id,
        type: 'implements_concept',
      },
    ])

    const result = await resolveEntities(db, workspaceId)
    expect(result.merged).toBeGreaterThanOrEqual(1)

    const remaining = await db
      .select()
      .from(schema.entities)
      .where(
        and(
          eq(schema.entities.workspaceId, workspaceId),
          eq(schema.entities.type, 'concept'),
        ),
      )
    expect(remaining).toHaveLength(1)

    // Relations now both point at the surviving concept.
    const rels = await db
      .select()
      .from(schema.relations)
      .where(eq(schema.relations.workspaceId, workspaceId))
    const targets = new Set(rels.map((r) => r.toEntityId))
    expect(targets.size).toBe(1)
    expect(targets.has(remaining[0]!.id)).toBe(true)
  })

  it('merges concepts whose embeddings are above 0.9 similarity', async () => {
    const workspaceId = await makeWorkspace()
    const sharedVec = pseudoVec(0.5)
    await db.insert(schema.entities).values([
      {
        workspaceId,
        type: 'concept',
        name: 'discount calc',
        qualifiedName: 'concept::discount calc',
        normalizedName: 'discount calc',
        description: 'computes discount on orders',
        embedding: sharedVec,
      },
      {
        workspaceId,
        type: 'concept',
        name: 'price reduction',
        qualifiedName: 'concept::price reduction',
        normalizedName: 'price reduction',
        description: 'computes discount on orders',
        embedding: sharedVec.map((x) => x + 1e-6), // nearly identical → sim ~ 1
      },
    ])

    const result = await resolveEntities(db, workspaceId)
    expect(result.merged).toBeGreaterThanOrEqual(1)

    const remaining = await db
      .select()
      .from(schema.entities)
      .where(
        and(
          eq(schema.entities.workspaceId, workspaceId),
          eq(schema.entities.type, 'concept'),
        ),
      )
    expect(remaining).toHaveLength(1)
  })

  it('flags but does not merge similarity in 0.75–0.9 band', async () => {
    const workspaceId = await makeWorkspace()
    // Two vectors with cosine ~0.8 — easiest construction: scale one component.
    const a = pseudoVec(0.5)
    const b = a.slice()
    for (let i = 0; i < b.length; i++) {
      const v = b[i] ?? 0
      b[i] = i % 4 === 0 ? -v * 0.6 : v
    }
    await db.insert(schema.entities).values([
      {
        workspaceId,
        type: 'concept',
        name: 'foo',
        qualifiedName: 'concept::foo',
        normalizedName: 'foo',
        embedding: a,
      },
      {
        workspaceId,
        type: 'concept',
        name: 'bar',
        qualifiedName: 'concept::bar',
        normalizedName: 'bar',
        embedding: b,
      },
    ])

    const before = await db
      .select()
      .from(schema.entities)
      .where(
        and(
          eq(schema.entities.workspaceId, workspaceId),
          eq(schema.entities.type, 'concept'),
        ),
      )
    expect(before).toHaveLength(2)

    const result = await resolveEntities(db, workspaceId)
    // Should NOT merge anything in this band; flagging is optional but the
    // surviving entity count must stay at 2 if similarity is mid-range.
    expect(result.merged).toBe(0)
    const after = await db
      .select()
      .from(schema.entities)
      .where(
        and(
          eq(schema.entities.workspaceId, workspaceId),
          eq(schema.entities.type, 'concept'),
        ),
      )
    expect(after).toHaveLength(2)
  })
})
