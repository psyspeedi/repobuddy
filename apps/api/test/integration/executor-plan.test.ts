import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import postgres from 'postgres'
import { drizzle } from 'drizzle-orm/postgres-js'
import * as schema from '#server/db/schema'
import { executePlan } from '#server/kag/executor'
import { MockEmbeddingsProvider } from '#server/providers/embeddings'
import { MockLLMProvider } from '#server/providers/llm'
import type { OperatorContext } from '#server/kag/operators'
import type { Plan } from '#shared/schemas/plan'

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

async function seedFullGraph(): Promise<OperatorContext> {
  const [user] = await db
    .insert(schema.users)
    .values({ githubId: 'gh-' + Math.random(), githubLogin: 't' })
    .returning()
  const [ws] = await db
    .insert(schema.workspaces)
    .values({ ownerUserId: user!.id, name: 'r', sourceType: 'upload' })
    .returning()
  const workspaceId = ws!.id

  const [, fn] = await db
    .insert(schema.entities)
    .values([
      {
        workspaceId,
        type: 'file',
        name: 'orders.ts',
        qualifiedName: 'src/orders.ts',
        normalizedName: 'orders.ts',
        filePath: 'src/orders.ts',
        startLine: 1,
        endLine: 50,
      },
      {
        workspaceId,
        type: 'function',
        name: 'processPayment',
        qualifiedName: 'src/orders.ts::processPayment',
        normalizedName: 'processpayment',
        filePath: 'src/orders.ts',
        startLine: 10,
        endLine: 30,
      },
    ])
    .returning()

  await db.insert(schema.chunks).values({
    workspaceId,
    sourceType: 'code',
    filePath: 'src/orders.ts',
    startLine: 10,
    endLine: 30,
    text: 'function processPayment(orderId) { ... }',
    metadata: { qualifiedName: 'src/orders.ts::processPayment' },
  })
  return {
    workspaceId,
    db,
    embeddings: new MockEmbeddingsProvider(),
    llm: new MockLLMProvider(),
  }
}

describe('executePlan (integration)', () => {
  it('runs find_symbol → retrieve_code_chunks → answer with streaming', async () => {
    const ctx = await seedFullGraph()
    const llm = ctx.llm as MockLLMProvider
    llm.setNextText('processPayment lives in [chunk:abc01234-1234-1234-1234-1234567890ab].')

    const plan: Plan = {
      reasoning: 'Lookup symbol then summarise.',
      steps: [
        {
          id: 's1',
          op: 'find_symbol',
          params: { name: 'processPayment', type: 'function' },
        },
        {
          id: 's2',
          op: 'retrieve_code_chunks',
          params: { entities: '$s1' },
        },
        {
          id: 's3',
          op: 'answer',
          params: {
            question: 'Where is processPayment defined?',
            context: ['$s1', '$s2'],
          },
        },
      ],
    }
    const out = await executePlan(plan, ctx)
    expect(out.trace).toHaveLength(3)
    expect(out.trace.every((t) => t.ok)).toBe(true)

    expect(out.results.s1).toBeDefined()
    const entities = out.results.s1 as { id: string; name: string }[]
    expect(entities[0]?.name).toBe('processPayment')

    expect(out.finalStream).toBeDefined()
    let assembled = ''
    if (out.finalStream) {
      for await (const evt of out.finalStream as AsyncIterable<{ type: string; text?: string }>) {
        if (evt.type === 'text' && evt.text) assembled += evt.text
      }
    }
    expect(assembled).toContain('processPayment')
  })

  it('runs steps in dependency order regardless of array order', async () => {
    const ctx = await seedFullGraph()
    const plan: Plan = {
      reasoning: 'Out-of-order step list.',
      steps: [
        {
          id: 's3',
          op: 'get_summary',
          params: { entity: '$s2' },
        },
        {
          id: 's1',
          op: 'find_symbol',
          params: { name: 'processPayment', type: 'function' },
        },
        {
          id: 's2',
          op: 'retrieve_code_chunks',
          params: { entities: '$s1' },
        },
      ],
    }
    const out = await executePlan(plan, ctx)
    const order = out.trace.map((t) => t.stepId)
    // s1 must run before s2 (s2 depends on s1), s2 before s3 (s3 depends on s2).
    expect(order.indexOf('s1')).toBeLessThan(order.indexOf('s2'))
    expect(order.indexOf('s2')).toBeLessThan(order.indexOf('s3'))
  })

  it('throws on cycle in step references', async () => {
    const ctx = await seedFullGraph()
    const plan: Plan = {
      reasoning: 'Cycle.',
      steps: [
        { id: 's1', op: 'find_symbol', params: { name: '$s2.name' } },
        { id: 's2', op: 'find_symbol', params: { name: '$s1.name' } },
      ],
    }
    await expect(executePlan(plan, ctx)).rejects.toThrow(/cycle/i)
  })
})
