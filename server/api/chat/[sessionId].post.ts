import { and, eq, inArray, sql } from 'drizzle-orm'
import { z } from 'zod'
import { getDb } from '../../db/client'
import {
  chatMessages,
  chatSessions,
  chunks as chunksTable,
  entities as entitiesTable,
  entityChunks,
} from '../../db/schema'
import { resolveProvidersByUserId } from '../../providers/resolve'
import { planQuestion } from '../../kag/planner'
import { executePlan } from '../../kag/executor'
import { extractCitations } from '../../kag/operators/answer'
import { runAgenticAnswer } from '../../kag/agentic'
import { readAccess } from '../../lib/workspace-access'
import { isAdminLogin } from '../../lib/admin'
import {
  assertCanSendMessage,
  consumeMessage,
  recordTokenUsage,
  type QuotaContext,
} from '../../lib/quotas'
import { recordCost, assertWithinDailyBudget } from '../../lib/cost-log'
import { rateLimitTake } from '../../lib/rate-limit'
import { getClientIp } from '../../lib/audit'
import { chatLatency, chatRequests } from '../../lib/metrics'
import { users } from '../../db/schema'
import { getLogger } from '../../lib/logger'

const log = getLogger().child({ component: 'api/chat' })

const BodySchema = z.object({
  question: z.string().min(1).max(2000),
  workspaceId: z.string().uuid(),
  locale: z.enum(['en', 'ru']).optional(),
  /**
   * 'planned' (default) — KAG planner produces a static multi-step
   *   plan, executor runs it, answer operator finalises.
   * 'agentic' — LLM gets KAG operators as function-calling tools and
   *   loops (max 8 iterations) until it can answer. More expensive,
   *   slower, more thorough. Opt-in per request.
   */
  mode: z.enum(['planned', 'agentic']).optional().default('planned'),
  /**
   * When true (agentic mode only) the agent runs one independent
   * self-critique pass before exiting. Adds ~1 LLM call. Useful for
   * hard / open-ended questions; skip for cheap factual ones.
   */
  selfCritique: z.boolean().optional().default(false),
  /**
   * Session focus — entities / files / issues the user has pinned for
   * this chat. Auto-loaded into pinnedEntities / pinnedChunks for
   * every turn so the model retains context across the conversation.
   * Caller is the client (useChat persists in localStorage).
   */
  focus: z.object({
    entityIds: z.array(z.string().uuid()).max(15).optional(),
    filePaths: z.array(z.string().min(1).max(300)).max(15).optional(),
    issueNumbers: z.array(z.number().int().min(1).max(1_000_000)).max(15).optional(),
  }).optional(),
})

export default defineEventHandler(async (event) => {
  const sessionId = getRouterParam(event, 'sessionId')
  if (!sessionId) throw createError({ statusCode: 400, statusMessage: 'sessionId required' })

  const body = BodySchema.parse(await readBody(event))
  const config = useRuntimeConfig(event)
  const db = getDb(config.databaseUrl as string)

  // readAccess gates by ownership / admin / public. Guests can use chat
  // on a public workspace; their session is ephemeral (not persisted).
  const { workspace: ws, viewer } = await readAccess(event, body.workspaceId)
  const isGuest = viewer.kind === 'guest'

  // Build the quota context and gate the request BEFORE we open the SSE
  // stream. Admin login bypasses; BYOK status is resolved later and used
  // only to skip the token-write at the end (the message-count check
  // still runs to deter abuse).
  let quotaCtx: QuotaContext
  if (isGuest) {
    quotaCtx = { kind: 'guest', id: (viewer as { guestId: string }).guestId }
  } else {
    const uid = (viewer as { userId: string }).userId
    // Re-check admin status by login (cheap join already done in readAccess
    // via users table; do a quick lookup since viewer doesn't carry it).
    const [u] = await db.select({ githubLogin: users.githubLogin })
      .from(users).where(eq(users.id, uid)).limit(1)
    quotaCtx = { kind: 'user', id: uid, bypass: isAdminLogin(u?.githubLogin) }
  }
  await assertCanSendMessage(quotaCtx)
  // Service-wide daily LLM budget. Admins / BYOK users skip it.
  await assertWithinDailyBudget({ bypass: quotaCtx.bypass })

  // Per-IP rate limit for guests only — defense against cookie-rotating
  // scrapers. 30 requests / hour per IP. Authenticated users already
  // ride the per-user quota gate above.
  if (isGuest) {
    const ip = getClientIp(event) ?? 'unknown'
    const result = await rateLimitTake(`cg:rl:chat:ip:${ip}`, 30, 60 * 60)
    if (!result.ok) {
      setHeader(event, 'Retry-After', result.retryAfterSec)
      throw createError({
        statusCode: 429,
        statusMessage: `Too many requests from this IP. Try again in ${Math.ceil(result.retryAfterSec / 60)} minute(s).`,
      })
    }
  }

  // For owners/admins we persist the session + messages so /api/chat/sessions
  // can show the history. For guests we skip persistence entirely — keeps
  // anonymous traffic out of the chat history list and limits abuse surface.
  let sessionRowId: string | null = null
  // Conversation history fed to the LLM so multi-turn flows keep their
  // thread ("issue #191" → "and the callers?" should resolve to issue
  // 191's callers, not generic ones). Loaded BEFORE we insert the new
  // user message so the current question isn't double-counted.
  let priorHistory: { role: 'user' | 'assistant' | 'system' | 'tool'; content: string }[] = []
  if (!isGuest) {
    const ownerId = (viewer as { userId: string }).userId
    let [session] = await db
      .select()
      .from(chatSessions)
      .where(and(eq(chatSessions.id, sessionId), eq(chatSessions.userId, ownerId)))
      .limit(1)
    if (!session) {
      ;[session] = await db
        .insert(chatSessions)
        .values({
          id: sessionId,
          workspaceId: body.workspaceId,
          userId: ownerId,
          title: body.question.slice(0, 80),
        })
        .returning()
    }
    if (!session) throw createError({ statusCode: 500, statusMessage: 'session insert failed' })
    sessionRowId = session.id

    // Pull the last 16 messages (= ~8 user/assistant pairs) ordered
    // chronologically. Cap each message at 3000 chars so a verbose
    // model reply doesn't bloat the prompt for the next turn. Assistant
    // turns are stored AFTER stream-completion (later in this handler),
    // so by the time the next turn lands they're available.
    const prior = await db
      .select({ role: chatMessages.role, content: chatMessages.content })
      .from(chatMessages)
      .where(eq(chatMessages.sessionId, session.id))
      .orderBy(chatMessages.createdAt)
      .limit(16)
    priorHistory = prior.map((m) => ({
      role: m.role as 'user' | 'assistant',
      content: m.content.length > 3000 ? m.content.slice(0, 3000) + '… [truncated]' : m.content,
    }))

    await db.insert(chatMessages).values({
      sessionId: session.id,
      role: 'user',
      content: body.question,
    })
  }

  setResponseHeaders(event, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  })
  const stream = createEventStream(event)
  const latencyTimer = chatLatency.startTimer()
  const viewerLabel = isGuest ? 'guest' : 'user'

  ;(async () => {
    try {
      // For owner/admin: pull BYOK config + fall back to server defaults.
      // For guests: server defaults only (no per-user BYOK).
      const ownerUserId = isGuest ? null : (viewer as { userId: string }).userId
      const { llm, embeddings, usesByok } = await resolveProvidersByUserId(
        db,
        ownerUserId,
        { llmModel: config.openaiModelPlanning as string | undefined },
      )
      void usesByok // reserved for quota bypass in a later commit

      // Pre-load any [entity:UUID] the user typed into the prompt. Plan
      // execution might never look at them (e.g. planner picks
      // hybrid_search), but we want the answer operator to always see the
      // entity row with full metadata. Critical for commit references —
      // their message/author/date/files all live in metadata.
      const citedIds = extractEntityIdsFromQuestion(body.question)
      const pinnedEntities = citedIds.length > 0 ? await loadPinnedEntities(db, body.workspaceId, citedIds) : []
      // Also pull chunks linked to those entities via entity_chunks. For a
      // commit this returns its per-file diff chunks; for a function/class,
      // its code chunk. Giving the model citable [chunk:UUID] anchors means
      // the answer ends with ↗ → source viewer, not ◆ → graph.
      const pinnedChunks = citedIds.length > 0 ? await loadPinnedChunks(db, body.workspaceId, citedIds) : []

      // If the user pasted a unified diff, pre-load the touched files'
      // chunks so the answer can analyse the change in context (callers,
      // tests, neighbouring entities). The answer-prompt instruction
      // tells the model to treat these as "the change set to evaluate"
      // rather than just background context.
      const diffPaths = extractDiffFilePaths(body.question)
      const userPastedDiff = diffPaths.length > 0 || questionContainsDiff(body.question)
      if (diffPaths.length > 0) {
        const diffChunks = await loadChunksByFilePaths(db, body.workspaceId, diffPaths)
        for (const c of diffChunks) {
          if (pinnedChunks.find((p) => p.id === c.id)) continue
          pinnedChunks.push(c)
        }
      }

      // Session focus — apply pinned entities / files / issues from
      // the client (persisted in localStorage). Same plumbing as the
      // [entity:UUID] citation auto-pin: load entities + their linked
      // chunks via entity_chunks, dedupe against what's already there.
      const focus = body.focus
      if (focus?.entityIds && focus.entityIds.length > 0) {
        const newIds = focus.entityIds.filter((id) => !citedIds.includes(id))
        if (newIds.length > 0) {
          const ents = await loadPinnedEntities(db, body.workspaceId, newIds)
          for (const e of ents) {
            if (pinnedEntities.find((p) => p.id === e.id)) continue
            pinnedEntities.push(e)
          }
          const focusChunks = await loadPinnedChunks(db, body.workspaceId, newIds)
          for (const c of focusChunks) {
            if (pinnedChunks.find((p) => p.id === c.id)) continue
            pinnedChunks.push(c)
          }
        }
      }
      if (focus?.filePaths && focus.filePaths.length > 0) {
        const fileChunks = await loadChunksByFilePaths(db, body.workspaceId, focus.filePaths)
        for (const c of fileChunks) {
          if (pinnedChunks.find((p) => p.id === c.id)) continue
          pinnedChunks.push(c)
        }
      }
      // issueNumbers — the agentic / planned answer operators will pick
      // them up via list_issues; we just stash them in the question
      // history so the model knows to call list_issues with that number.
      // No server-side pre-load to avoid burning GitHub anonymous rate
      // limit on every single chat turn.

      let assembled = ''
      let inputTokens = 0
      let outputTokens = 0
      // Planned-mode plan + trace, populated only in the planner branch.
      // Agentic mode produces a synthetic trace from tool steps.
      let savedPlan: unknown = null
      let savedTrace: unknown = null

      if (body.mode === 'agentic') {
        // Agentic loop — LLM gets KAG operators as tools, loops on its
        // own until it can compose an answer. trace is built from
        // tool_step events as they arrive.
        const ctx = {
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
          pinnedEntities,
          pinnedChunks,
          responseLocale: body.locale ?? 'en',
          userPastedDiff,
          history: priorHistory,
        }
        const toolSteps: unknown[] = []
        savedPlan = { mode: 'agentic' }
        for await (const evt of runAgenticAnswer(llm, ctx, body.question, {
          responseLocale: body.locale ?? 'en',
          history: priorHistory,
          selfCritique: body.selfCritique,
        })) {
          if (evt.type === 'text' && evt.text) {
            assembled += evt.text
            await stream.push({ event: 'text', data: evt.text })
          } else if (evt.type === 'tool_step' && evt.toolStep) {
            toolSteps.push(evt.toolStep)
            await stream.push({ event: 'tool_step', data: JSON.stringify(evt.toolStep) })
          } else if (evt.type === 'done') {
            inputTokens = evt.inputTokens ?? 0
            outputTokens = evt.outputTokens ?? 0
          }
        }
        savedTrace = { mode: 'agentic', steps: toolSteps }
        await stream.push({ event: 'trace', data: JSON.stringify(savedTrace) })
      } else {
        // 1) Plan.
        const plan = await planQuestion(llm, body.question, {
          workspaceName: ws.name,
          languages: ws.languages,
          stats: ws.stats as Record<string, number>,
        })
        await stream.push({ event: 'plan', data: JSON.stringify(plan) })
        savedPlan = plan

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
          pinnedEntities,
          pinnedChunks,
          responseLocale: body.locale ?? 'en',
          userPastedDiff,
          history: priorHistory,
        })
        savedTrace = result.trace

        // Emit trace early so the inspector can render even while the answer streams.
        await stream.push({ event: 'trace', data: JSON.stringify(result.trace) })

        // 3) Drain the final answer stream (if any).
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

      // 5) Persist assistant message with plan + trace (skip for guests).
      if (sessionRowId) {
        await db.insert(chatMessages).values({
          sessionId: sessionRowId,
          role: 'assistant',
          content: assembled,
          plan: savedPlan as never,
          trace: savedTrace as never,
          tokensUsed: inputTokens + outputTokens,
        })
      }

      // 6) Quota accounting — only after a successful generation so a
      // failed call doesn't burn the user's allotment. Skip when BYOK
      // is in effect since the user is paying their own bill.
      const skipTokens = usesByok
      await consumeMessage(quotaCtx)
      if (!skipTokens) {
        await recordTokenUsage(quotaCtx, inputTokens + outputTokens)
      }

      // 7) Cost ledger — write regardless of BYOK so /admin shows total
      // traffic. Operator can filter on phase to see only billable rows
      // (or join workspaces.users on byok status when reporting).
      await recordCost(db, {
        workspaceId: body.workspaceId,
        phase: 'answering',
        model: llm.model,
        inputTokens,
        outputTokens,
        costCentsPer1MInput: llm.costCentsPer1MInputTokens,
        costCentsPer1MOutput: llm.costCentsPer1MOutputTokens,
      })

      chatRequests.inc({ status: 'ok', viewer: viewerLabel })
      latencyTimer()

      await stream.push({
        event: 'done',
        data: JSON.stringify({ inputTokens, outputTokens }),
      })
    } catch (err) {
      log.error({ err }, 'chat stream failed')
      const msg = err instanceof Error ? err.message : String(err)
      await stream.push({ event: 'error', data: msg })
      chatRequests.inc({ status: 'error', viewer: viewerLabel })
      latencyTimer()
    } finally {
      await stream.close()
    }
  })().catch((err) => log.error({ err }, 'chat task crashed'))

  return stream.send()
})

const ENTITY_CITATION_RE = /\[entity:([0-9a-f-]{36})\]/gi

function extractEntityIdsFromQuestion(question: string): string[] {
  const ids = new Set<string>()
  for (const m of question.matchAll(ENTITY_CITATION_RE)) {
    if (m[1]) ids.add(m[1].toLowerCase())
  }
  return [...ids]
}

/**
 * Recognise a unified diff embedded in the user's question. Triggers
 * pre-loading the touched files' chunks as pinnedChunks so the answer
 * can reason about the change in context.
 *
 * Supports:
 *   `diff --git a/path/x b/path/x`
 *   `--- a/path/x` / `+++ b/path/x`
 *   `diff -u path/x path/x`
 * Stops at 12 paths to keep prompt budget under control.
 */
const DIFF_GIT_RE = /^diff --git a\/(.+?) b\/(.+?)\s*$/gm
const DIFF_MINUS_RE = /^---\s+(?:a\/)?(.+?)\s*$/gm
const DIFF_PLUS_RE = /^\+\+\+\s+(?:b\/)?(.+?)\s*$/gm
function extractDiffFilePaths(question: string): string[] {
  if (!/^diff --git|^---\s|^\+\+\+\s/m.test(question)) return []
  const paths = new Set<string>()
  for (const m of question.matchAll(DIFF_GIT_RE)) {
    if (m[2] && m[2] !== '/dev/null') paths.add(m[2])
  }
  for (const m of question.matchAll(DIFF_PLUS_RE)) {
    if (m[1] && m[1] !== '/dev/null' && !m[1].startsWith('+')) paths.add(m[1])
  }
  for (const m of question.matchAll(DIFF_MINUS_RE)) {
    if (m[1] && m[1] !== '/dev/null' && !m[1].startsWith('-')) paths.add(m[1])
  }
  return [...paths].slice(0, 12)
}

function questionContainsDiff(question: string): boolean {
  return /^diff --git|^---\s+(?:a\/)?[\w./-]+\s*\n\+\+\+|^\+\+\+\s+(?:b\/)?[\w./-]+\s*$/m.test(question)
}

async function loadChunksByFilePaths(
  db: ReturnType<typeof getDb>,
  workspaceId: string,
  paths: string[],
): Promise<
  {
    id: string
    text: string
    filePath: string | null
    startLine: number | null
    endLine: number | null
    sourceType: string
    metadata: Record<string, unknown> | null
  }[]
> {
  if (paths.length === 0) return []
  // Match each path by exact OR suffix. Cap 3 chunks per file so
  // a chunky file doesn't crowd out the rest of the change set.
  const out: {
    id: string
    text: string
    filePath: string | null
    startLine: number | null
    endLine: number | null
    sourceType: string
    metadata: Record<string, unknown> | null
  }[] = []
  for (const p of paths) {
    const normalized = p.replace(/^\.?\//, '')
    const rows = await db
      .select({
        id: chunksTable.id,
        text: chunksTable.text,
        filePath: chunksTable.filePath,
        startLine: chunksTable.startLine,
        endLine: chunksTable.endLine,
        sourceType: chunksTable.sourceType,
        metadata: chunksTable.metadata,
      })
      .from(chunksTable)
      .where(
        and(
          eq(chunksTable.workspaceId, workspaceId),
          inArray(
            chunksTable.filePath,
            // Match either the literal path the diff carries OR the
            // normalised form; SQL OR-of-LIKE is awkward via Drizzle
            // builder, so we widen with inArray on the common forms.
            [p, normalized, '/' + normalized],
          ),
        ),
      )
      .limit(3)
    if (rows.length > 0) {
      for (const r of rows) {
        out.push({
          id: r.id,
          text: r.text,
          filePath: r.filePath,
          startLine: r.startLine,
          endLine: r.endLine,
          sourceType: r.sourceType,
          metadata: r.metadata as Record<string, unknown> | null,
        })
      }
      continue
    }
    // Suffix fallback for deeper paths.
    const suffix = await db
      .select({
        id: chunksTable.id,
        text: chunksTable.text,
        filePath: chunksTable.filePath,
        startLine: chunksTable.startLine,
        endLine: chunksTable.endLine,
        sourceType: chunksTable.sourceType,
        metadata: chunksTable.metadata,
      })
      .from(chunksTable)
      .where(
        and(
          eq(chunksTable.workspaceId, workspaceId),
          sql`${chunksTable.filePath} LIKE ${'%/' + normalized}`,
        ),
      )
      .limit(3)
    for (const r of suffix) {
      out.push({
        id: r.id,
        text: r.text,
        filePath: r.filePath,
        startLine: r.startLine,
        endLine: r.endLine,
        sourceType: r.sourceType,
        metadata: r.metadata as Record<string, unknown> | null,
      })
    }
  }
  return out
}

async function loadPinnedEntities(
  db: ReturnType<typeof getDb>,
  workspaceId: string,
  ids: string[],
): Promise<
  {
    id: string
    name: string
    type: string
    qualifiedName: string | null
    description: string | null
    metadata: Record<string, unknown> | null
    filePath: string | null
    startLine: number | null
    endLine: number | null
    language: string | null
    signature: string | null
  }[]
> {
  if (ids.length === 0) return []
  const rows = await db
    .select({
      id: entitiesTable.id,
      name: entitiesTable.name,
      type: entitiesTable.type,
      qualifiedName: entitiesTable.qualifiedName,
      description: entitiesTable.description,
      metadata: entitiesTable.metadata,
      filePath: entitiesTable.filePath,
      startLine: entitiesTable.startLine,
      endLine: entitiesTable.endLine,
      language: entitiesTable.language,
      signature: entitiesTable.signature,
    })
    .from(entitiesTable)
    .where(
      and(
        eq(entitiesTable.workspaceId, workspaceId),
        inArray(entitiesTable.id, ids),
      ),
    )
  return rows.map((r) => ({
    ...r,
    metadata: (r.metadata as Record<string, unknown> | null) ?? null,
  }))
}

/**
 * Fetch chunks linked to the cited entities via the mutual index.
 * For a commit this returns its per-file diff chunks; for a class/function
 * this returns its source chunk. Capped at 12 to keep prompt bounded for
 * pathological hub entities.
 */
async function loadPinnedChunks(
  db: ReturnType<typeof getDb>,
  workspaceId: string,
  entityIds: string[],
): Promise<
  {
    id: string
    text: string
    filePath: string | null
    startLine: number | null
    endLine: number | null
    sourceType: string
    metadata: Record<string, unknown> | null
  }[]
> {
  if (entityIds.length === 0) return []
  const rows = await db
    .select({
      id: chunksTable.id,
      text: chunksTable.text,
      filePath: chunksTable.filePath,
      startLine: chunksTable.startLine,
      endLine: chunksTable.endLine,
      sourceType: chunksTable.sourceType,
      metadata: chunksTable.metadata,
    })
    .from(chunksTable)
    .innerJoin(entityChunks, eq(entityChunks.chunkId, chunksTable.id))
    .where(
      and(
        eq(chunksTable.workspaceId, workspaceId),
        inArray(entityChunks.entityId, entityIds),
      ),
    )
    .limit(12)
  return rows.map((r) => ({
    ...r,
    metadata: (r.metadata as Record<string, unknown> | null) ?? null,
  }))
}
