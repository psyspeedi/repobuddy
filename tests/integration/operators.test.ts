import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import postgres from 'postgres'
import { drizzle } from 'drizzle-orm/postgres-js'
import * as schema from '../../server/db/schema'
import {
  findFile,
  findSymbol,
  getCallees,
  getCallers,
  getSummary,
  retrieveCodeChunks,
  type OperatorContext,
} from '../../server/kag/operators'
import { MockEmbeddingsProvider } from '../../server/providers/embeddings'
import { MockLLMProvider } from '../../server/providers/llm'

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

async function seedTinyGraph(): Promise<{
  ctx: OperatorContext
  ids: Record<string, string>
}> {
  const [user] = await db
    .insert(schema.users)
    .values({ githubId: 'gh-' + Math.random(), githubLogin: 't' })
    .returning()
  const [ws] = await db
    .insert(schema.workspaces)
    .values({ ownerUserId: user!.id, name: 'r', sourceType: 'upload' })
    .returning()
  const workspaceId = ws!.id

  const [orderFile, orderClass, processPaymentFn, telemetryFile, logEventFn] =
    await db
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
          endLine: 40,
          language: 'typescript',
        },
        {
          workspaceId,
          type: 'class',
          name: 'OrderService',
          qualifiedName: 'src/orders.ts::OrderService',
          normalizedName: 'orderservice',
          filePath: 'src/orders.ts',
          startLine: 5,
          endLine: 35,
          language: 'typescript',
        },
        {
          workspaceId,
          type: 'function',
          name: 'processPayment',
          qualifiedName: 'src/orders.ts::OrderService::processPayment',
          normalizedName: 'processpayment',
          filePath: 'src/orders.ts',
          startLine: 20,
          endLine: 30,
          language: 'typescript',
        },
        {
          workspaceId,
          type: 'file',
          name: 'telemetry.ts',
          qualifiedName: 'src/telemetry.ts',
          normalizedName: 'telemetry.ts',
          filePath: 'src/telemetry.ts',
          startLine: 1,
          endLine: 15,
          language: 'typescript',
        },
        {
          workspaceId,
          type: 'function',
          name: 'logEvent',
          qualifiedName: 'src/telemetry.ts::logEvent',
          normalizedName: 'logevent',
          filePath: 'src/telemetry.ts',
          startLine: 4,
          endLine: 10,
          language: 'typescript',
        },
      ])
      .returning()

  await db.insert(schema.relations).values([
    {
      workspaceId,
      fromEntityId: processPaymentFn!.id,
      toEntityId: logEventFn!.id,
      type: 'calls',
    },
    {
      workspaceId,
      fromEntityId: orderFile!.id,
      toEntityId: telemetryFile!.id,
      type: 'imports',
    },
  ])

  // Chunk linked to processPayment via mutual index.
  const [chunk] = await db
    .insert(schema.chunks)
    .values({
      workspaceId,
      sourceType: 'code',
      filePath: 'src/orders.ts',
      startLine: 20,
      endLine: 30,
      text: 'processPayment(orderId: string) { logEvent("payment", {}) }',
      metadata: { qualifiedName: 'src/orders.ts::OrderService::processPayment' },
    })
    .returning()
  await db.insert(schema.entityChunks).values({
    entityId: processPaymentFn!.id,
    chunkId: chunk!.id,
  })

  const ctx: OperatorContext = {
    workspaceId,
    db,
    embeddings: new MockEmbeddingsProvider(),
    llm: new MockLLMProvider(),
  }

  return {
    ctx,
    ids: {
      orderFile: orderFile!.id,
      orderClass: orderClass!.id,
      processPayment: processPaymentFn!.id,
      telemetryFile: telemetryFile!.id,
      logEvent: logEventFn!.id,
    },
  }
}

describe('operators', () => {
  it('find_symbol returns exact normalized match by default', async () => {
    const { ctx, ids } = await seedTinyGraph()
    const result = await findSymbol({ name: 'OrderService' }, ctx)
    expect(result).toHaveLength(1)
    expect(result[0]?.id).toBe(ids.orderClass)
  })

  it('find_symbol with fuzzy=true returns partial matches', async () => {
    const { ctx } = await seedTinyGraph()
    const result = await findSymbol({ name: 'order', fuzzy: true }, ctx)
    expect(result.length).toBeGreaterThanOrEqual(2) // orders.ts + OrderService
  })

  it('find_symbol with type filter narrows', async () => {
    const { ctx, ids } = await seedTinyGraph()
    const result = await findSymbol({ name: 'processPayment', type: 'function' }, ctx)
    expect(result).toHaveLength(1)
    expect(result[0]?.id).toBe(ids.processPayment)
  })

  it('find_symbol auto-falls-back to fuzzy when exact match is empty', async () => {
    const { ctx, ids } = await seedTinyGraph()
    // No entity is literally named "Order" — but OrderService, OrderRepository,
    // and orders.ts all contain it. Exact match would return [].
    const result = await findSymbol({ name: 'Order' }, ctx)
    const ids_returned = new Set(result.map((r) => r.id))
    expect(ids_returned.has(ids.orderClass!)).toBe(true)
    expect(result.length).toBeGreaterThan(1)
  })

  it('find_file resolves glob-like patterns', async () => {
    const { ctx } = await seedTinyGraph()
    const result = await findFile({ pathPattern: 'src/*.ts' }, ctx)
    expect(result.map((f) => f.name).sort()).toEqual(['orders.ts', 'telemetry.ts'])
  })

  it('get_callers returns immediate parents', async () => {
    const { ctx, ids } = await seedTinyGraph()
    const logEvent = await findSymbol({ name: 'logEvent' }, ctx)
    expect(logEvent[0]?.id).toBe(ids.logEvent)
    const callers = await getCallers({ target: logEvent[0]! }, ctx)
    expect(callers.map((c) => c.id)).toContain(ids.processPayment)
  })

  it('get_callees returns immediate children', async () => {
    const { ctx, ids } = await seedTinyGraph()
    const pp = await findSymbol({ name: 'processPayment' }, ctx)
    const callees = await getCallees({ source: pp[0]! }, ctx)
    expect(callees.map((c) => c.id)).toContain(ids.logEvent)
  })

  it('retrieve_code_chunks fetches via mutual index', async () => {
    const { ctx, ids } = await seedTinyGraph()
    const result = await retrieveCodeChunks(
      {
        entities: {
          id: ids.processPayment as string,
          type: 'function',
          name: 'processPayment',
          qualifiedName: null,
          filePath: null,
          startLine: null,
          endLine: null,
          language: null,
          description: null,
        },
      },
      ctx,
    )
    expect(result).toHaveLength(1)
    expect(result[0]?.text).toContain('processPayment')
  })

  it('get_summary returns name/type/description triples', async () => {
    const { ctx, ids } = await seedTinyGraph()
    await sqlClient`UPDATE entities SET description = 'Handles payment.' WHERE id = ${ids.processPayment}`

    const result = await getSummary(
      {
        entity: {
          id: ids.processPayment as string,
          type: 'function',
          name: 'processPayment',
          qualifiedName: null,
          filePath: null,
          startLine: null,
          endLine: null,
          language: null,
          description: null,
        },
      },
      ctx,
    )
    expect(result[0]?.description).toContain('Handles payment')
  })
})
