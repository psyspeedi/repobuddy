import { and, desc, eq } from 'drizzle-orm'
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
import { hybridSearch } from '../../kag/operators/hybrid_search'
import { answer, extractCitations } from '../../kag/operators/answer'
import { getLogger } from '../../lib/logger'

const log = getLogger().child({ component: 'api/chat' })

const BodySchema = z.object({
  question: z.string().min(1).max(2000),
  workspaceId: z.string().uuid(),
})

export default defineEventHandler(async (event) => {
  const { user } = await requireUserSession(event)
  const sessionId = getRouterParam(event, 'sessionId')
  if (!sessionId) throw createError({ statusCode: 400, statusMessage: 'sessionId required' })

  const body = BodySchema.parse(await readBody(event))
  const config = useRuntimeConfig(event)
  const db = getDb(config.databaseUrl as string)

  // Verify ownership + session.
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

  // Record user message.
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

  // Kick off the answer pipeline in the background; the route returns the
  // SSE stream immediately so the client connects before we start emitting.
  ;(async () => {
    try {
      const embeddings = createEmbeddingsProvider({
        apiKey: config.openaiApiKey as string,
      })
      const llm = createLLMProvider({
        apiKey: config.openaiApiKey as string,
        model: config.openaiModelPlanning as string,
      })

      // 1) Retrieve.
      const results = await hybridSearch(db, embeddings, {
        workspaceId: body.workspaceId,
        query: body.question,
        limit: 8,
      })
      await stream.push({
        event: 'context',
        data: JSON.stringify(
          results.map((r) => ({
            chunkId: r.chunkId,
            filePath: r.filePath,
            startLine: r.startLine,
            endLine: r.endLine,
          })),
        ),
      })

      // 2) Past turns as history (last 6).
      const history = await db
        .select()
        .from(chatMessages)
        .where(eq(chatMessages.sessionId, session.id))
        .orderBy(desc(chatMessages.createdAt))
        .limit(6)
      const reversed = history.reverse().slice(0, -1) // drop the user msg we just inserted
      const historyMessages = reversed.map((m) => ({
        role: m.role as 'user' | 'assistant',
        content: m.content,
      }))

      // 3) Stream answer.
      let assembled = ''
      let inputTokens = 0
      let outputTokens = 0
      for await (const evt of answer(llm, {
        question: body.question,
        chunks: results.map((r) => ({
          id: r.chunkId,
          text: r.text,
          filePath: r.filePath,
          startLine: r.startLine,
          endLine: r.endLine,
        })),
        history: historyMessages,
      })) {
        if (evt.type === 'text' && evt.text) {
          assembled += evt.text
          await stream.push({ event: 'text', data: evt.text })
        } else if (evt.type === 'done') {
          inputTokens = evt.inputTokens ?? 0
          outputTokens = evt.outputTokens ?? 0
        }
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

      // 5) Persist assistant message.
      await db.insert(chatMessages).values({
        sessionId: session.id,
        role: 'assistant',
        content: assembled,
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
