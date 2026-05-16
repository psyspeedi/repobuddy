import { and, eq } from 'drizzle-orm'
import { z } from 'zod'
import { getDb } from '../../db/client'
import {
  chatMessages,
  chatSessions,
  chunks as chunksTable,
  workspaces,
} from '../../db/schema'
import { createEmbeddingsProvider } from '../../providers/embeddings'
import { createLLMProvider } from '../../providers/llm'
import { planQuestion } from '../../kag/planner'
import { executePlan } from '../../kag/executor'
import { extractCitations } from '../../kag/operators/answer'
import { requireValidUser } from '../../lib/auth'
import { getLogger } from '../../lib/logger'

const log = getLogger().child({ component: 'api/chat' })

const BodySchema = z.object({
  question: z.string().min(1).max(2000),
  workspaceId: z.string().uuid(),
})

export default defineEventHandler(async (event) => {
  const user = await requireValidUser(event)
  const sessionId = getRouterParam(event, 'sessionId')
  if (!sessionId) throw createError({ statusCode: 400, statusMessage: 'sessionId required' })

  const body = BodySchema.parse(await readBody(event))
  const config = useRuntimeConfig(event)
  const db = getDb(config.databaseUrl as string)

  // Verify ownership.
  const [ws] = await db
    .select()
    .from(workspaces)
    .where(
      and(eq(workspaces.id, body.workspaceId), eq(workspaces.ownerUserId, user.id)),
    )
    .limit(1)
  if (!ws) throw createError({ statusCode: 404, statusMessage: 'workspace not found' })

  // Find or create session.
  let [session] = await db
    .select()
    .from(chatSessions)
    .where(and(eq(chatSessions.id, sessionId), eq(chatSessions.userId, user.id)))
    .limit(1)
  if (!session) {
    ;[session] = await db
      .insert(chatSessions)
      .values({
        id: sessionId,
        workspaceId: body.workspaceId,
        userId: user.id,
        title: body.question.slice(0, 80),
      })
      .returning()
  }
  if (!session) throw createError({ statusCode: 500, statusMessage: 'session insert failed' })

  await db.insert(chatMessages).values({
    sessionId: session.id,
    role: 'user',
    content: body.question,
  })

  setResponseHeaders(event, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  })
  const stream = createEventStream(event)

  ;(async () => {
    try {
      const embeddings = createEmbeddingsProvider({
        apiKey: config.openaiApiKey as string,
      })
      const llm = createLLMProvider({
        apiKey: config.openaiApiKey as string,
        model: config.openaiModelPlanning as string,
      })

      // 1) Plan.
      const plan = await planQuestion(llm, body.question, {
        workspaceName: ws.name,
        languages: ws.languages,
        stats: ws.stats as Record<string, number>,
      })
      await stream.push({ event: 'plan', data: JSON.stringify(plan) })

      // 2) Execute.
      const result = await executePlan(plan, {
        workspaceId: body.workspaceId,
        db,
        embeddings,
        workspace: {
          name: ws.name,
          sourceUrl: ws.sourceUrl,
          languages: ws.languages,
          stats: ws.stats as Record<string, number> | null,
        },
        llm,
      })

      // Emit trace early so the inspector can render even while the answer streams.
      await stream.push({ event: 'trace', data: JSON.stringify(result.trace) })

      // 3) Drain the final answer stream (if any).
      let assembled = ''
      let inputTokens = 0
      let outputTokens = 0
      if (result.finalStream) {
        for await (const evt of result.finalStream as AsyncIterable<{
          type: string
          text?: string
          inputTokens?: number
          outputTokens?: number
        }>) {
          if (evt.type === 'text' && evt.text) {
            assembled += evt.text
            await stream.push({ event: 'text', data: evt.text })
          } else if (evt.type === 'done') {
            inputTokens = evt.inputTokens ?? 0
            outputTokens = evt.outputTokens ?? 0
          }
        }
      } else {
        assembled = 'No answer was produced by the plan.'
        await stream.push({ event: 'text', data: assembled })
      }

      // 4) Verify citations.
      const citations = extractCitations(assembled)
      const chunkIds = citations.filter((c) => c.kind === 'chunk').map((c) => c.id)
      let validChunkIds = new Set<string>()
      if (chunkIds.length > 0) {
        const rows = await db
          .select({ id: chunksTable.id })
          .from(chunksTable)
          .where(eq(chunksTable.workspaceId, body.workspaceId))
        validChunkIds = new Set(
          rows.map((r) => r.id).filter((id) => chunkIds.includes(id)),
        )
      }
      const invalid = citations
        .filter((c) => c.kind === 'chunk' && !validChunkIds.has(c.id))
        .map((c) => c.id)

      await stream.push({
        event: 'citations',
        data: JSON.stringify({ citations, invalid }),
      })

      // 5) Persist assistant message with plan + trace.
      await db.insert(chatMessages).values({
        sessionId: session.id,
        role: 'assistant',
        content: assembled,
        plan,
        trace: result.trace,
        tokensUsed: inputTokens + outputTokens,
      })

      await stream.push({
        event: 'done',
        data: JSON.stringify({ inputTokens, outputTokens }),
      })
    } catch (err) {
      log.error({ err }, 'chat stream failed')
      const msg = err instanceof Error ? err.message : String(err)
      await stream.push({ event: 'error', data: msg })
    } finally {
      await stream.close()
    }
  })().catch((err) => log.error({ err }, 'chat task crashed'))

  return stream.send()
})
