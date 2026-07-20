/**
 * The nine MCP tools RepoBuddy exposes to external agents.
 *
 * Every one of them is a thin projection over an existing KAG operator
 * pulled from `KagOperatorsRegistry` — no query logic is reimplemented
 * here. This file only does the three things the operators do not:
 * enforce the public-workspace boundary, translate the client's flat
 * scalar arguments (an `entityId` string) into the entity-shaped params
 * the operators take, and cap payload sizes.
 *
 * `answer` is deliberately absent from the catalogue. The whole point
 * of the MCP surface is that the caller — Claude Code, Cursor — already
 * has a model. Shipping them a second one would burn our tokens to
 * produce prose they did not ask for and cannot cite into. We hand over
 * the graph and the source; the client reasons.
 */
import { Inject, Injectable, Logger } from '@nestjs/common'
import { and, eq } from 'drizzle-orm'
import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { entities } from '#server/db/schema'
import { assertWithinDailyBudget, recordCost } from '#server/lib/cost-log'
import { DRIZZLE_DB, type DrizzleDb } from '#modules/drizzle/drizzle.tokens'
import { KagOperatorsRegistry } from '#server/kag/operators/index'
import type { GraphEntity, OperatorContext } from '#server/kag/operators/index'
import type { OperatorName } from '#shared/schemas/plan'
import type { EmbeddingsProvider } from '#server/providers/embeddings'
import type { LLMProvider } from '#server/providers/llm'
import type { ProjectOverview } from '#server/lib/project-overview'
import type { ResolutionEnvelope } from '#shared/schemas/resolution'
import { ProviderResolverService } from '#modules/providers/provider-resolver.service'
import {
  MAX_CHUNK_CHARS,
  MAX_LABELS,
  MAX_LABEL_CHARS,
  MAX_PATH_CHARS,
  MAX_PROSE_CHARS,
  MAX_QUERY_CHARS,
  clampLimit,
  toolError,
  toolJson,
  truncate,
} from './format'
import {
  listPublicWorkspaces,
  loadPublicWorkspace,
  publicStats,
  type McpWorkspace,
} from './workspace'

/**
 * Canonical tool catalogue. `registerAll` walks this order, and
 * test/unit/mcp.test.ts asserts the registered set matches it exactly —
 * so adding a tool without listing it (or vice versa) fails CI rather
 * than silently changing the public protocol surface.
 */
export const MCP_TOOL_NAMES = [
  'list_workspaces',
  'search_code',
  'find_symbol',
  'get_callers',
  'walkthrough',
  'read_file',
  'get_project_overview',
  'list_issues',
  'find_resolution',
] as const

export type McpToolName = (typeof MCP_TOOL_NAMES)[number]

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Shape returned by the hybrid_search operator. */
interface SearchHit {
  chunkId: string
  text: string
  filePath: string | null
  startLine: number | null
  endLine: number | null
  combinedScore: number
}

interface WalkthroughEnvelope {
  entities: GraphEntity[]
  mermaid: string
}

interface ReadFileGroup {
  filePath: string
  chunks: { id: string; text: string; startLine: number | null; endLine: number | null }[]
}

interface IssueEnvelope {
  issues: {
    number: number
    title: string
    url: string
    labels: string[]
    bodyExcerpt: string
    updatedAt: string
    relatedEntities: { entityId: string; name: string; type: string; filePath: string | null }[]
  }[]
  reason?: string
}

@Injectable()
export class McpToolsService {
  private readonly log = new Logger(McpToolsService.name)

  /**
   * Provider construction opens an OpenAI client and reads env, so we
   * do it on first use rather than per request. Only `search_code`
   * needs embeddings; nothing on this surface needs the LLM, but
   * OperatorContext requires the field (see `contextFor`).
   */
  private embeddingsCache: EmbeddingsProvider | null = null
  private llmCache: LLMProvider | null = null

  constructor(
    @Inject(DRIZZLE_DB) private readonly db: DrizzleDb,
    @Inject(KagOperatorsRegistry) private readonly operators: KagOperatorsRegistry,
    @Inject(ProviderResolverService) private readonly providers: ProviderResolverService,
  ) {}

  /** Register the full catalogue onto a per-request McpServer. */
  registerAll(server: McpServer): void {
    this.registerListWorkspaces(server)
    this.registerSearchCode(server)
    this.registerFindSymbol(server)
    this.registerGetCallers(server)
    this.registerWalkthrough(server)
    this.registerReadFile(server)
    this.registerProjectOverview(server)
    this.registerListIssues(server)
    this.registerFindResolution(server)
  }

  // ---------- shared plumbing ----------

  private get embeddings(): EmbeddingsProvider {
    this.embeddingsCache ??= this.providers.serverEmbeddings()
    return this.embeddingsCache
  }

  private get llm(): LLMProvider {
    this.llmCache ??= this.providers.serverLlm()
    return this.llmCache
  }

  private contextFor(ws: McpWorkspace): OperatorContext {
    return {
      workspaceId: ws.id,
      // Metered, not raw: everything an operator embeds on this path is
      // billed to the same daily ledger chat and indexing use.
      embeddings: new MeteredEmbeddings(this.embeddings, this.db, ws.id),
      llm: this.llm,
      workspace: {
        name: ws.name,
        sourceUrl: ws.sourceUrl,
        languages: ws.languages,
        stats: publicStats(ws.stats),
      },
    }
  }

  /**
   * Service-wide daily cost cap, checked before a tool that spends the
   * provider budget runs.
   *
   * MCP is unauthenticated, so there is no per-user quota to lean on —
   * this global cap is the only automatic brake between a scripted
   * caller and the OpenAI bill. Returns a tool result to hand back, or
   * `null` when there is budget left.
   */
  private async budgetBlocked(): Promise<CallToolResult | null> {
    try {
      await assertWithinDailyBudget({})
      return null
    } catch {
      return toolError(
        'RepoBuddy has reached its service-wide daily budget for paid operations. Search is unavailable until UTC midnight; graph tools (find_symbol, get_callers, walkthrough, read_file) still work.',
      )
    }
  }

  /** Dispatch a registry operator, rejecting the streaming (`answer`) shape. */
  private async runOperator<R>(name: OperatorName, params: unknown, ws: McpWorkspace): Promise<R> {
    const op = this.operators.get(name)
    if (!op) throw new Error(`KAG operator "${name}" is not registered`)
    const out = op.execute(params as never, this.contextFor(ws))
    if (typeof (out as AsyncGenerator<unknown>).next === 'function') {
      throw new Error(`KAG operator "${name}" streams; not usable over MCP`)
    }
    return (await out) as R
  }

  /**
   * Wraps a handler that needs a workspace. Resolving through
   * `loadPublicWorkspace` is the ONLY way to reach `ws`, so a tool
   * physically cannot run against a private or unknown workspace —
   * the check is a precondition of getting the argument, not a line
   * someone has to remember to write.
   *
   * Doubles as the error funnel: unexpected throws are logged server
   * side and returned to the client as a flat sentence, never as a
   * stack trace.
   */
  private guarded<A extends { workspaceId: string }>(
    tool: McpToolName,
    fn: (args: A, ws: McpWorkspace) => Promise<CallToolResult>,
  ): (args: A) => Promise<CallToolResult> {
    return async (args: A): Promise<CallToolResult> => {
      try {
        const ws = await loadPublicWorkspace(this.db, args.workspaceId)
        if (!ws) {
          return toolError(
            `No public workspace with id "${args.workspaceId}". Only public, indexed workspaces are reachable over MCP — call list_workspaces to discover them.`,
          )
        }
        if (ws.status !== 'ready') {
          return toolError(
            `Workspace "${ws.name}" is not finished indexing (status: ${ws.status}). Try again once it is ready.`,
          )
        }
        return await fn(args, ws)
      } catch (err) {
        this.log.error({ err, tool, workspaceId: args.workspaceId }, 'mcp tool failed')
        return toolError(`Tool "${tool}" failed while querying the knowledge graph.`)
      }
    }
  }

  /** Error funnel for the one tool that takes no workspaceId. */
  private safe<A>(
    tool: McpToolName,
    fn: (args: A) => Promise<CallToolResult>,
  ): (args: A) => Promise<CallToolResult> {
    return async (args: A): Promise<CallToolResult> => {
      try {
        return await fn(args)
      } catch (err) {
        this.log.error({ err, tool }, 'mcp tool failed')
        return toolError(`Tool "${tool}" failed.`)
      }
    }
  }

  /**
   * Operators traverse by entity object, MCP clients hold an id string.
   * Loading the row here also scopes the id to the workspace, so an
   * entity id harvested from a private workspace resolves to nothing.
   */
  private async loadEntity(ws: McpWorkspace, entityId: string): Promise<GraphEntity | null> {
    if (typeof entityId !== 'string' || !UUID_RE.test(entityId)) return null
    const [row] = await this.db
      .select({
        id: entities.id,
        type: entities.type,
        name: entities.name,
        qualifiedName: entities.qualifiedName,
        filePath: entities.filePath,
        startLine: entities.startLine,
        endLine: entities.endLine,
        language: entities.language,
        description: entities.description,
      })
      .from(entities)
      .where(and(eq(entities.workspaceId, ws.id), eq(entities.id, entityId)))
      .limit(1)
    return row ?? null
  }

  private static entityView(e: GraphEntity) {
    return {
      entityId: e.id,
      name: e.name,
      type: e.type,
      qualifiedName: e.qualifiedName,
      filePath: e.filePath,
      startLine: e.startLine,
      endLine: e.endLine,
      language: e.language,
      description: truncate(e.description, MAX_PROSE_CHARS) || null,
    }
  }

  private static workspaceView(ws: McpWorkspace) {
    return {
      workspaceId: ws.id,
      name: ws.name,
      sourceUrl: ws.sourceUrl,
      languages: ws.languages,
      stats: publicStats(ws.stats),
      lastIndexedAt: ws.lastIndexedAt?.toISOString() ?? null,
    }
  }

  // ---------- 1. list_workspaces ----------

  private registerListWorkspaces(server: McpServer): void {
    server.registerTool(
      'list_workspaces',
      {
        title: 'List indexed repositories',
        description:
          'List the public repositories RepoBuddy has indexed into a knowledge graph. Start here: every other tool needs a workspaceId from this list. Optionally filter by name substring.',
        inputSchema: {
          query: z
            .string()
            .max(MAX_QUERY_CHARS)
            .optional()
            .describe('Case-insensitive substring filter on repository name.'),
          limit: z.number().int().optional().describe('Max repositories to return (1-30, default 30).'),
        },
      },
      this.safe<{ query?: string; limit?: number }>('list_workspaces', async (args) => {
        const rows = await listPublicWorkspaces(this.db, {
          query: args.query,
          limit: clampLimit(args.limit, 30),
        })
        return toolJson({
          count: rows.length,
          workspaces: rows.map((ws) => McpToolsService.workspaceView(ws)),
        })
      }),
    )
  }

  // ---------- 2. search_code ----------

  private registerSearchCode(server: McpServer): void {
    server.registerTool(
      'search_code',
      {
        title: 'Search code and docs',
        description:
          'Hybrid semantic + keyword search over an indexed repository. Returns matching code/doc chunks with file paths and line ranges. Use for "where is X handled?" questions when you do not know the symbol name.',
        inputSchema: {
          workspaceId: z.string().describe('Workspace id from list_workspaces.'),
          query: z.string().max(MAX_QUERY_CHARS).describe('Natural-language or keyword query.'),
          limit: z.number().int().optional().describe('Max chunks to return (1-30, default 10).'),
        },
        annotations: { readOnlyHint: true },
      },
      this.guarded<{ workspaceId: string; query: string; limit?: number }>(
        'search_code',
        async (args, ws) => {
          const blocked = await this.budgetBlocked()
          if (blocked) return blocked
          const limit = clampLimit(args.limit, 10)
          const hits = await this.runOperator<SearchHit[]>(
            'hybrid_search',
            { query: args.query, limit },
            ws,
          )
          return toolJson({
            query: args.query,
            count: hits.length,
            results: hits.map((h) => ({
              chunkId: h.chunkId,
              filePath: h.filePath,
              startLine: h.startLine,
              endLine: h.endLine,
              score: Number(h.combinedScore?.toFixed?.(5) ?? h.combinedScore),
              text: truncate(h.text, MAX_CHUNK_CHARS),
            })),
          })
        },
      ),
    )
  }

  // ---------- 3. find_symbol ----------

  private registerFindSymbol(server: McpServer): void {
    server.registerTool(
      'find_symbol',
      {
        title: 'Find a symbol in the graph',
        description:
          'Look up a function, class, method, or file by name. Falls back to substring matching when there is no exact hit. Returns entityIds you can feed to get_callers or walkthrough.',
        inputSchema: {
          workspaceId: z.string().describe('Workspace id from list_workspaces.'),
          name: z
            .string()
            .max(MAX_QUERY_CHARS)
            .describe('Symbol name, e.g. "executePlan" or "UserService".'),
          kind: z
            .string()
            .optional()
            .describe('Optional entity-type filter, e.g. "function", "class", "file", "method".'),
          limit: z.number().int().optional().describe('Max entities to return (1-30, default 20).'),
        },
        annotations: { readOnlyHint: true },
      },
      this.guarded<{ workspaceId: string; name: string; kind?: string; limit?: number }>(
        'find_symbol',
        async (args, ws) => {
          const found = await this.runOperator<GraphEntity[]>(
            'find_symbol',
            { name: args.name, type: args.kind, limit: clampLimit(args.limit, 20) },
            ws,
          )
          return toolJson({
            name: args.name,
            count: found.length,
            entities: found.map((e) => McpToolsService.entityView(e)),
          })
        },
      ),
    )
  }

  // ---------- 4. get_callers ----------

  private registerGetCallers(server: McpServer): void {
    server.registerTool(
      'get_callers',
      {
        title: 'Find callers of a symbol',
        description:
          'Return the entities that call the given symbol — the blast radius of changing it. depth=1 is direct callers; depth>1 walks the call graph transitively.',
        inputSchema: {
          workspaceId: z.string().describe('Workspace id from list_workspaces.'),
          entityId: z.string().describe('Entity id from find_symbol or search results.'),
          depth: z
            .number()
            .int()
            .optional()
            .describe('Call-graph hops to traverse (1-5, default 1).'),
          limit: z.number().int().optional().describe('Max callers to return (1-30, default 30).'),
        },
        annotations: { readOnlyHint: true },
      },
      this.guarded<{ workspaceId: string; entityId: string; depth?: number; limit?: number }>(
        'get_callers',
        async (args, ws) => {
          const target = await this.loadEntity(ws, args.entityId)
          if (!target) {
            return toolError(
              `No entity "${args.entityId}" in workspace "${ws.name}". Use find_symbol to get a valid entityId.`,
            )
          }
          const depth = Math.min(Math.max(Math.trunc(Number(args.depth ?? 1)) || 1, 1), 5)
          const callers = await this.runOperator<GraphEntity[]>(
            'get_callers',
            {
              target,
              transitive: depth > 1,
              maxDepth: depth,
              limit: clampLimit(args.limit, 30),
            },
            ws,
          )
          return toolJson({
            target: McpToolsService.entityView(target),
            depth,
            count: callers.length,
            callers: callers.map((e) => McpToolsService.entityView(e)),
          })
        },
      ),
    )
  }

  // ---------- 5. walkthrough ----------

  private registerWalkthrough(server: McpServer): void {
    server.registerTool(
      'walkthrough',
      {
        title: 'Trace how a symbol works',
        description:
          'Gather everything needed to explain a symbol: what it calls, which tests cover it, its enclosing scope, plus a mermaid sequence diagram of the call chain. Use to answer "walk me through how X works".',
        inputSchema: {
          workspaceId: z.string().describe('Workspace id from list_workspaces.'),
          entityId: z.string().describe('Entity id from find_symbol or search results.'),
        },
        annotations: { readOnlyHint: true },
      },
      this.guarded<{ workspaceId: string; entityId: string }>('walkthrough', async (args, ws) => {
        const target = await this.loadEntity(ws, args.entityId)
        if (!target) {
          return toolError(
            `No entity "${args.entityId}" in workspace "${ws.name}". Use find_symbol to get a valid entityId.`,
          )
        }
        const result = await this.runOperator<WalkthroughEnvelope>(
          'walkthrough',
          { entity: target, limit: 20 },
          ws,
        )
        return toolJson({
          target: McpToolsService.entityView(target),
          mermaid: result.mermaid || null,
          relatedCount: result.entities.length,
          related: result.entities.slice(0, 30).map((e) => McpToolsService.entityView(e)),
        })
      }),
    )
  }

  // ---------- 6. read_file ----------

  private registerReadFile(server: McpServer): void {
    server.registerTool(
      'read_file',
      {
        title: 'Read an indexed file',
        description:
          'Return the indexed content of a file by repository-relative path (suffix matches work, e.g. "chat.service.ts"). Optionally narrow to a line range. Only content captured at index time is available.',
        inputSchema: {
          workspaceId: z.string().describe('Workspace id from list_workspaces.'),
          path: z
            .string()
            .max(MAX_PATH_CHARS)
            .describe('Repository-relative path or path suffix.'),
          startLine: z.number().int().optional().describe('Only return content overlapping at/after this line.'),
          endLine: z.number().int().optional().describe('Only return content overlapping at/before this line.'),
        },
        annotations: { readOnlyHint: true },
      },
      this.guarded<{ workspaceId: string; path: string; startLine?: number; endLine?: number }>(
        'read_file',
        async (args, ws) => {
          const groups = await this.runOperator<ReadFileGroup[]>(
            'read_file',
            { path: args.path, limit: 12 },
            ws,
          )
          if (groups.length === 0) {
            return toolError(
              `No indexed file matching "${args.path}" in workspace "${ws.name}". Try search_code to locate it.`,
            )
          }
          // Chunks carry their own line spans; a requested range keeps
          // any chunk that overlaps it rather than only those fully
          // inside, otherwise a range landing mid-chunk returns nothing.
          const from = Number.isFinite(args.startLine) ? Number(args.startLine) : null
          const to = Number.isFinite(args.endLine) ? Number(args.endLine) : null
          const files = groups.map((g) => {
            const kept = g.chunks.filter((c) => {
              if (from !== null && c.endLine !== null && c.endLine < from) return false
              if (to !== null && c.startLine !== null && c.startLine > to) return false
              return true
            })
            return {
              filePath: g.filePath,
              chunks: kept.slice(0, 12).map((c) => ({
                chunkId: c.id,
                startLine: c.startLine,
                endLine: c.endLine,
                text: truncate(c.text, MAX_CHUNK_CHARS * 2),
              })),
            }
          })
          return toolJson({ path: args.path, matchedFiles: files.length, files })
        },
      ),
    )
  }

  // ---------- 7. get_project_overview ----------

  private registerProjectOverview(server: McpServer): void {
    server.registerTool(
      'get_project_overview',
      {
        title: 'Get repository orientation',
        description:
          'High-level map of a repository: entrypoints, the most-depended-on abstractions, beginner-friendly areas, hottest files, contribution guide excerpts, and an architecture diagram. Call this first when orienting in an unfamiliar repo.',
        inputSchema: {
          workspaceId: z.string().describe('Workspace id from list_workspaces.'),
        },
        annotations: { readOnlyHint: true },
      },
      this.guarded<{ workspaceId: string }>('get_project_overview', async (_args, ws) => {
        const o = await this.runOperator<ProjectOverview>('get_project_overview', {}, ws)
        return toolJson({
          workspace: McpToolsService.workspaceView(ws),
          stats: o.stats,
          architectureMermaid: o.architectureMermaid,
          entrypoints: o.entrypoints.slice(0, 20),
          coreAbstractions: o.coreAbstractions.slice(0, 20).map((a) => ({
            entityId: a.id,
            name: a.name,
            type: a.type,
            filePath: a.filePath,
            qualifiedName: a.qualifiedName,
            description: truncate(a.description, MAX_PROSE_CHARS) || null,
          })),
          goodFirstIssues: o.goodFirstIssues.slice(0, 10),
          hotFiles: o.hotFiles.slice(0, 15),
          // Not sliced: the source already caps this at 8, and a
          // contributor being shown 3 of 5 contribution rules with no
          // sign that anything was withheld is how a client model ends
          // up confidently describing half a process.
          contribGuide: o.contribGuide.map((c) => ({
            ...c,
            excerpt: truncate((c as { excerpt?: string }).excerpt, MAX_CHUNK_CHARS),
          })),
          // Totals for every list that could have been cut above, so
          // the client can tell "that is all of them" from "ask again,
          // narrower".
          counts: {
            entrypoints: o.entrypoints.length,
            coreAbstractions: o.coreAbstractions.length,
            goodFirstIssues: o.goodFirstIssues.length,
            hotFiles: o.hotFiles.length,
            contribGuide: o.contribGuide.length,
          },
        })
      }),
    )
  }

  // ---------- 8. list_issues ----------

  private registerListIssues(server: McpServer): void {
    server.registerTool(
      'list_issues',
      {
        title: 'List GitHub issues with linked code',
        description:
          'Fetch open GitHub issues for the repository, each linked to the indexed entities its text mentions. Pass issueNumber to focus a single issue. Use to find something to work on, or to ground an issue in real code.',
        inputSchema: {
          workspaceId: z.string().describe('Workspace id from list_workspaces.'),
          issueNumber: z.number().int().optional().describe('Focus a single issue by number.'),
          labels: z
            .array(z.string().max(MAX_LABEL_CHARS))
            .max(MAX_LABELS)
            .optional()
            .describe('Filter by label names, e.g. ["good first issue"].'),
          limit: z.number().int().optional().describe('Max issues to return (1-30, default 15).'),
        },
        annotations: { readOnlyHint: true },
      },
      this.guarded<{
        workspaceId: string
        issueNumber?: number
        labels?: string[]
        limit?: number
      }>('list_issues', async (args, ws) => {
        const env = await this.runOperator<IssueEnvelope>(
          'list_issues',
          {
            issueNumber: args.issueNumber,
            labels: args.labels,
            limit: clampLimit(args.limit, 15),
          },
          ws,
        )
        if (env.issues.length === 0) {
          return toolJson({
            count: 0,
            issues: [],
            note: env.reason
              ? `No issues returned (${env.reason}).`
              : 'No matching issues.',
          })
        }
        return toolJson({
          count: env.issues.length,
          issues: env.issues.map((i) => ({
            number: i.number,
            title: i.title,
            url: i.url,
            labels: i.labels,
            updatedAt: i.updatedAt,
            bodyExcerpt: truncate(i.bodyExcerpt, MAX_PROSE_CHARS),
            relatedEntities: (i.relatedEntities ?? []).slice(0, 10).map((e) => ({
              entityId: e.entityId,
              name: e.name,
              type: e.type,
              filePath: e.filePath,
            })),
          })),
        })
      }),
    )
  }

  // ---------- 9. find_resolution ----------

  private registerFindResolution(server: McpServer): void {
    server.registerTool(
      'find_resolution',
      {
        title: 'Check whether an issue is already fixed',
        description:
          'Before working on an issue, check if someone already did: returns fixing commits, linked pull requests (open/draft/stale/merged) and similar closed issues, with a status verdict. Saves duplicating work.',
        inputSchema: {
          workspaceId: z.string().describe('Workspace id from list_workspaces.'),
          issueNumber: z.number().int().describe('GitHub issue number, e.g. 42.'),
        },
        annotations: { readOnlyHint: true },
      },
      this.guarded<{ workspaceId: string; issueNumber: number }>(
        'find_resolution',
        async (args, ws) => {
          // Embeds the issue corpus on a cache miss, so it is a paid
          // tool even though most calls hit the cache.
          const blocked = await this.budgetBlocked()
          if (blocked) return blocked
          const r = await this.runOperator<ResolutionEnvelope>(
            'find_resolution',
            { issueNumber: args.issueNumber },
            ws,
          )
          return toolJson({
            issueNumber: r.issueNumber,
            status: r.status,
            confidence: r.confidence,
            reason: r.reason ?? null,
            mergedByCommits: r.mergedByCommits.slice(0, 10).map((c) => ({
              sha: c.sha,
              author: c.author,
              date: c.date,
              message: truncate(c.message, MAX_PROSE_CHARS),
            })),
            linkedPullRequests: r.linkedPullRequests.slice(0, 10).map((p) => ({
              number: p.number,
              title: p.title,
              url: p.url,
              state: p.state,
              draft: p.draft,
              merged: p.merged,
              stale: p.stale,
              author: p.author,
              lastCommitAt: p.lastCommitAt,
              bodyExcerpt: truncate(p.bodyExcerpt, MAX_PROSE_CHARS),
            })),
            duplicateCandidates: r.duplicateCandidates.slice(0, 10),
            // Same reason as get_project_overview: a caller deciding
            // "is this already being worked on?" needs to know whether
            // it saw every linked PR or only the first ten.
            counts: {
              mergedByCommits: r.mergedByCommits.length,
              linkedPullRequests: r.linkedPullRequests.length,
              duplicateCandidates: r.duplicateCandidates.length,
            },
          })
        },
      ),
    )
  }
}

/**
 * Embeddings provider that writes what it spent to the cost ledger.
 *
 * MCP is the third paid consumer of the providers, after chat and the
 * indexer, and it was the only one invisible to `cost_log` — which both
 * let it spend past COST_BUDGET_USD_PER_DAY and made the running total
 * read low for the two consumers that do honour the cap. Metering at
 * the provider rather than at each tool covers every operator that
 * embeds (`hybrid_search` for search_code, the similarity pass in
 * find_resolution) without any of them having to remember to report.
 */
class MeteredEmbeddings implements EmbeddingsProvider {
  constructor(
    private readonly inner: EmbeddingsProvider,
    private readonly db: DrizzleDb,
    private readonly workspaceId: string,
  ) {}

  get model(): string {
    return this.inner.model
  }

  get costCentsPer1MTokens(): number {
    return this.inner.costCentsPer1MTokens
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    const vectors = await this.inner.embedBatch(texts)
    // Same ~chars/4 estimate the indexer uses (embed.ts): embedding
    // endpoints report no per-call usage, and a budget signal only has
    // to be the right order of magnitude.
    const approxTokens = texts.reduce((sum, t) => sum + Math.ceil((t?.length ?? 0) / 4), 0)
    await recordCost(this.db, {
      workspaceId: this.workspaceId,
      phase: 'embedding',
      model: this.inner.model,
      inputTokens: approxTokens,
      costCentsPer1MInput: this.inner.costCentsPer1MTokens,
    })
    return vectors
  }
}
