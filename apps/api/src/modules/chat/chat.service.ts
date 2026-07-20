import {
  BadRequestException,
  ForbiddenException,
  HttpException,
  Inject,
  Injectable,
  Logger,
} from '@nestjs/common'
import { Observable } from 'rxjs'
import type { MessageEvent } from '@nestjs/common'
import { and, asc, eq, inArray, sql } from 'drizzle-orm'
import type { Request } from 'express'
import {
  chatMessages,
  chatSessions,
  chunks as chunksTable,
  entities as entitiesTable,
  entityChunks,
  users,
} from '#server/db/schema'
import { extractCitations } from '#server/kag/operators/answer'
import {
  assertCanSendMessage,
  consumeMessage,
  recordTokenUsage,
  type QuotaContext,
} from '#server/lib/quotas'
import { recordCost, assertWithinDailyBudget } from '#server/lib/cost-log'
import { rateLimitTake } from '#server/lib/rate-limit'
import { chatLatency, chatRequests } from '#server/lib/metrics'
import { TypedConfigService } from '../config/typed-config.service'
import { DRIZZLE_DB, type DrizzleDb } from '../drizzle/drizzle.tokens'
import { AgenticService } from '../kag/agentic.service'
import { ExecutorService } from '../kag/executor.service'
import { PlannerService } from '../kag/planner.service'
import { ProviderResolverService } from '../providers/provider-resolver.service'
import { AuthService } from '../auth/auth.service'
import { WorkspaceAccessService } from '../workspaces/workspace-access.service'
import type { ChatBody } from './chat.types'

const ENTITY_CITATION_RE = /\[entity:([0-9a-f-]{36})\]/gi
const DIFF_GIT_RE = /^diff --git a\/(.+?) b\/(.+?)\s*$/gm
const DIFF_MINUS_RE = /^---\s+(?:a\/)?(.+?)\s*$/gm
const DIFF_PLUS_RE = /^\+\+\+\s+(?:b\/)?(.+?)\s*$/gm

@Injectable()
export class ChatService {
  private readonly log = new Logger(ChatService.name)

  constructor(
    @Inject(DRIZZLE_DB) private readonly db: DrizzleDb,
    @Inject(TypedConfigService) private readonly config: TypedConfigService,
    @Inject(AuthService) private readonly auth: AuthService,
    @Inject(WorkspaceAccessService) private readonly access: WorkspaceAccessService,
    @Inject(ProviderResolverService) private readonly providers: ProviderResolverService,
    @Inject(PlannerService) private readonly planner: PlannerService,
    @Inject(ExecutorService) private readonly executor: ExecutorService,
    @Inject(AgenticService) private readonly agentic: AgenticService,
  ) {}

  async listSessions(req: Request, workspaceId: string | null) {
    if (!workspaceId) throw new BadRequestException('workspaceId required')
    if (!req.isAuthenticated?.() || !req.user?.id) return { sessions: [] }

    const [u] = await this.db.select().from(users).where(eq(users.id, req.user.id)).limit(1)
    if (!u) return { sessions: [] }

    const rows = await this.db.execute<{
      id: string
      title: string
      workspace_id: string
      created_at: string
      updated_at: string
      message_count: string
      preview: string | null
    }>(sql`
      SELECT s.id, s.title, s.workspace_id, s.created_at, s.updated_at,
        (SELECT COUNT(*) FROM ${chatMessages} m WHERE m.session_id = s.id) AS message_count,
        (SELECT m.content FROM ${chatMessages} m WHERE m.session_id = s.id ORDER BY m.created_at DESC LIMIT 1) AS preview
      FROM ${chatSessions} s
      WHERE s.user_id = ${u.id} AND s.workspace_id = ${workspaceId}
      ORDER BY s.updated_at DESC
      LIMIT 50
    `)
    return {
      sessions: [...rows].map((r) => ({
        id: r.id,
        title: r.title,
        workspaceId: r.workspace_id,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
        messageCount: Number(r.message_count),
        preview: r.preview ? r.preview.slice(0, 200) : null,
      })),
    }
  }

  async getHistory(req: Request, sessionId: string) {
    if (!req.isAuthenticated?.() || !req.user?.id) return { session: null, messages: [] }
    const [u] = await this.db.select().from(users).where(eq(users.id, req.user.id)).limit(1)
    if (!u) return { session: null, messages: [] }
    const [row] = await this.db
      .select()
      .from(chatSessions)
      .where(and(eq(chatSessions.id, sessionId), eq(chatSessions.userId, u.id)))
      .limit(1)
    if (!row) return { session: null, messages: [] }
    const messages = await this.db
      .select()
      .from(chatMessages)
      .where(eq(chatMessages.sessionId, row.id))
      .orderBy(asc(chatMessages.createdAt))
    return { session: row, messages }
  }

  async deleteSession(req: Request, sessionId: string) {
    const user = await this.access.requireValidUser(req)
    const deleted = await this.db
      .delete(chatSessions)
      .where(and(eq(chatSessions.id, sessionId), eq(chatSessions.userId, user.id)))
      .returning({ id: chatSessions.id })
    if (deleted.length === 0) throw new HttpException('session not found', 404)
    return { ok: true }
  }

  /**
   * Main SSE entrypoint. Returns an Observable<MessageEvent> the @Sse()
   * decorator wires to the response. Emits the same event names the
   * legacy endpoint did: plan / trace / tool_step / text / citations /
   * done / error.
   */
  chatStream(req: Request, sessionId: string, body: ChatBody): Observable<MessageEvent> {
    return new Observable<MessageEvent>((subscriber) => {
      let closed = false
      req.on('close', () => {
        closed = true
        subscriber.complete()
      })

      const emit = (event: string, data: unknown) => {
        if (closed) return
        subscriber.next({ type: event, data: typeof data === 'string' ? data : JSON.stringify(data) })
      }

      this.runChat(req, sessionId, body, emit, () => closed)
        .then(() => {
          if (!closed) subscriber.complete()
        })
        .catch((err) => {
          this.log.error({ err }, 'chat stream failed')
          const msg = err instanceof Error ? err.message : String(err)
          // The stream is already open with a 200, so the HTTP status
          // can't carry this. Forward the code the thrower attached
          // (quotas.ts sets 429) so the client can render a localized
          // message instead of leaking English backend prose into the
          // transcript.
          const statusCode = (err as { statusCode?: number }).statusCode ?? null
          if (!closed) {
            subscriber.next({ type: 'error', data: JSON.stringify({ message: msg, statusCode }) })
            subscriber.complete()
          }
        })
    })
  }

  private async runChat(
    req: Request,
    sessionId: string,
    body: ChatBody,
    emit: (event: string, data: unknown) => void,
    isClosed: () => boolean,
  ): Promise<void> {
    const { workspace: ws, viewer } = await this.access.read(req, body.workspaceId)
    const isGuest = viewer.kind === 'guest'

    let quotaCtx: QuotaContext
    if (isGuest) {
      quotaCtx = { kind: 'guest', id: (viewer as { guestId: string }).guestId }
    } else {
      const uid = (viewer as { userId: string }).userId
      const [u] = await this.db
        .select({ githubLogin: users.githubLogin })
        .from(users)
        .where(eq(users.id, uid))
        .limit(1)
      quotaCtx = { kind: 'user', id: uid, bypass: this.auth.isAdmin(u?.githubLogin) }
    }
    await assertCanSendMessage(quotaCtx)
    await assertWithinDailyBudget({ bypass: quotaCtx.bypass })

    if (isGuest) {
      const ip = req.ip ?? 'unknown'
      const result = await rateLimitTake(`cg:rl:chat:ip:${ip}`, 30, 60 * 60)
      if (!result.ok) {
        throw new ForbiddenException(
          `Too many requests from this IP. Try again in ${Math.ceil(result.retryAfterSec / 60)} minute(s).`,
        )
      }
    }

    let sessionRowId: string | null = null
    let priorHistory: { role: 'user' | 'assistant' | 'system' | 'tool'; content: string }[] = []
    if (!isGuest) {
      const ownerId = (viewer as { userId: string }).userId
      let [session] = await this.db
        .select()
        .from(chatSessions)
        .where(and(eq(chatSessions.id, sessionId), eq(chatSessions.userId, ownerId)))
        .limit(1)
      if (!session) {
        ;[session] = await this.db
          .insert(chatSessions)
          .values({
            id: sessionId,
            workspaceId: body.workspaceId,
            userId: ownerId,
            title: body.question.slice(0, 80),
          })
          .returning()
      }
      if (!session) throw new Error('session insert failed')
      sessionRowId = session.id

      const prior = await this.db
        .select({ role: chatMessages.role, content: chatMessages.content })
        .from(chatMessages)
        .where(eq(chatMessages.sessionId, session.id))
        .orderBy(chatMessages.createdAt)
        .limit(16)
      priorHistory = prior.map((m) => ({
        role: m.role as 'user' | 'assistant',
        content: m.content.length > 3000 ? m.content.slice(0, 3000) + '… [truncated]' : m.content,
      }))
      await this.db.insert(chatMessages).values({
        sessionId: session.id,
        role: 'user',
        content: body.question,
      })
    }

    const latencyTimer = chatLatency.startTimer()
    const viewerLabel = isGuest ? 'guest' : 'user'

    try {
      const ownerUserId = isGuest ? null : (viewer as { userId: string }).userId
      const { llm, embeddings, usesByok } = await this.providers.resolveForUserId(ownerUserId, {
        llmModel: this.config.get('OPENAI_MODEL_PLANNING'),
      })

      const citedIds = extractEntityIdsFromQuestion(body.question)
      const pinnedEntities =
        citedIds.length > 0 ? await loadPinnedEntities(this.db, body.workspaceId, citedIds) : []
      const pinnedChunks =
        citedIds.length > 0 ? await loadPinnedChunks(this.db, body.workspaceId, citedIds) : []

      const diffPaths = extractDiffFilePaths(body.question)
      const userPastedDiff = diffPaths.length > 0 || questionContainsDiff(body.question)
      if (diffPaths.length > 0) {
        const diffChunks = await loadChunksByFilePaths(this.db, body.workspaceId, diffPaths)
        for (const c of diffChunks) {
          if (pinnedChunks.find((p) => p.id === c.id)) continue
          pinnedChunks.push(c)
        }
      }

      let assembled = ''
      let inputTokens = 0
      let outputTokens = 0
      let savedPlan: unknown = null
      let savedTrace: unknown = null

      if (body.mode === 'agentic') {
        const ctx = {
          workspaceId: body.workspaceId,
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
        for await (const evt of this.agentic.run(llm, ctx, body.question, {
          responseLocale: body.locale ?? 'en',
          history: priorHistory,
        })) {
          if (isClosed()) return
          if (evt.type === 'text' && evt.text) {
            assembled += evt.text
            emit('text', evt.text)
          } else if (evt.type === 'tool_step' && evt.toolStep) {
            toolSteps.push(evt.toolStep)
            emit('tool_step', evt.toolStep)
          } else if (evt.type === 'done') {
            inputTokens = evt.inputTokens ?? 0
            outputTokens = evt.outputTokens ?? 0
          }
        }
        savedTrace = { mode: 'agentic', steps: toolSteps }
        emit('trace', savedTrace)
      } else {
        const plan = await this.planner.plan(llm, body.question, {
          workspaceName: ws.name,
          languages: ws.languages,
          stats: ws.stats as Record<string, number>,
          history: priorHistory,
        })
        emit('plan', plan)
        savedPlan = plan

        const result = await this.executor.run(plan, {
          workspaceId: body.workspaceId,
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

        // Surface find_resolution envelopes with the same tool_step
        // event agentic mode emits — that's what feeds the resolution
        // banner (useChat → ChatResolutionBanner). The trace entry also
        // carries `result` (see ExecutorTraceEntry), so the persisted
        // trace re-hydrates the banner when the session is reopened.
        let surfacedSteps = 0
        for (const entry of result.trace) {
          if (entry.op !== 'find_resolution' || entry.result === undefined) continue
          const step = plan.steps.find((s) => s.id === entry.stepId)
          emit('tool_step', {
            iteration: ++surfacedSteps,
            name: entry.op,
            args: (step?.params ?? {}) as Record<string, unknown>,
            summary: entry.summary ?? '',
            durationMs: entry.durationMs,
            result: entry.result,
          })
        }
        emit('trace', result.trace)

        if (result.finalStream) {
          for await (const evt of result.finalStream as AsyncIterable<{
            type: string
            text?: string
            inputTokens?: number
            outputTokens?: number
          }>) {
            if (isClosed()) return
            if (evt.type === 'text' && evt.text) {
              assembled += evt.text
              emit('text', evt.text)
            } else if (evt.type === 'done') {
              inputTokens = evt.inputTokens ?? 0
              outputTokens = evt.outputTokens ?? 0
            }
          }
        } else {
          assembled = 'No answer was produced by the plan.'
          emit('text', assembled)
        }
      }

      const citations = extractCitations(assembled)
      const chunkIds = citations.filter((c) => c.kind === 'chunk').map((c) => c.id)
      let validChunkIds = new Set<string>()
      if (chunkIds.length > 0) {
        const rows = await this.db
          .select({ id: chunksTable.id })
          .from(chunksTable)
          .where(eq(chunksTable.workspaceId, body.workspaceId))
        validChunkIds = new Set(rows.map((r) => r.id).filter((id) => chunkIds.includes(id)))
      }
      const invalid = citations
        .filter((c) => c.kind === 'chunk' && !validChunkIds.has(c.id))
        .map((c) => c.id)
      emit('citations', { citations, invalid })

      if (sessionRowId) {
        await this.db.insert(chatMessages).values({
          sessionId: sessionRowId,
          role: 'assistant',
          content: assembled,
          plan: savedPlan as never,
          trace: savedTrace as never,
          tokensUsed: inputTokens + outputTokens,
        })
      }

      await consumeMessage(quotaCtx)
      if (!usesByok) {
        await recordTokenUsage(quotaCtx, inputTokens + outputTokens)
      }

      await recordCost(this.db, {
        workspaceId: body.workspaceId,
        phase: 'answering',
        model: llm.model,
        inputTokens,
        outputTokens,
        costCentsPer1MInput: llm.costCentsPer1MInputTokens,
        costCentsPer1MOutput: llm.costCentsPer1MOutputTokens,
        byok: usesByok,
      })

      chatRequests.inc({ status: 'ok', viewer: viewerLabel })
      latencyTimer()
      emit('done', { inputTokens, outputTokens })
    } catch (err) {
      chatRequests.inc({ status: 'error', viewer: viewerLabel })
      latencyTimer()
      throw err
    }
  }
}

function extractEntityIdsFromQuestion(question: string): string[] {
  const ids = new Set<string>()
  for (const m of question.matchAll(ENTITY_CITATION_RE)) {
    if (m[1]) ids.add(m[1].toLowerCase())
  }
  return [...ids]
}

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

async function loadChunksByFilePaths(db: DrizzleDb, workspaceId: string, paths: string[]) {
  if (paths.length === 0) return []
  const out: Array<{
    id: string
    text: string
    filePath: string | null
    startLine: number | null
    endLine: number | null
    sourceType: string
    metadata: Record<string, unknown> | null
  }> = []
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
          inArray(chunksTable.filePath, [p, normalized, '/' + normalized]),
        ),
      )
      .limit(3)
    if (rows.length > 0) {
      for (const r of rows) out.push({ ...r, metadata: (r.metadata as Record<string, unknown> | null) ?? null })
      continue
    }
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
    for (const r of suffix) out.push({ ...r, metadata: (r.metadata as Record<string, unknown> | null) ?? null })
  }
  return out
}

async function loadPinnedEntities(db: DrizzleDb, workspaceId: string, ids: string[]) {
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
    .where(and(eq(entitiesTable.workspaceId, workspaceId), inArray(entitiesTable.id, ids)))
  return rows.map((r) => ({ ...r, metadata: (r.metadata as Record<string, unknown> | null) ?? null }))
}

async function loadPinnedChunks(db: DrizzleDb, workspaceId: string, entityIds: string[]) {
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
      and(eq(chunksTable.workspaceId, workspaceId), inArray(entityChunks.entityId, entityIds)),
    )
    .limit(12)
  return rows.map((r) => ({ ...r, metadata: (r.metadata as Record<string, unknown> | null) ?? null }))
}
