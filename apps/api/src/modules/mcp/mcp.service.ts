/**
 * Streamable HTTP transport for the MCP endpoint, in stateless mode.
 *
 * Stateless means every POST is self-contained: we build a fresh
 * McpServer + transport, answer the one JSON-RPC message, and tear both
 * down. That costs a little per-request setup but buys horizontal
 * scalability — no session affinity, so any replica can serve any call,
 * and an abandoned client cannot pin server memory. It is also why GET
 * (the SSE notification stream) and DELETE (session teardown) are not
 * supported: neither means anything without a session to attach to.
 *
 * Rate limiting is per IP on the shared Redis sliding window (see
 * `trust proxy` in main.ts — behind Caddy `req.ip` is only a real
 * client address because of it). The endpoint is unauthenticated, so
 * the IP is the only subject we have. Two windows are taken per POST:
 * a generous hourly budget and a short burst window, because the
 * hourly one alone permits spending the whole allowance in seconds —
 * which is what trips GitHub's secondary rate limits on our shared
 * token.
 */
import { Inject, Injectable, Logger } from '@nestjs/common'
import type { Request, Response } from 'express'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { rateLimitTake } from '#server/lib/rate-limit'
import { TypedConfigService } from '#modules/config/typed-config.service'
import { McpToolsService } from './internals/tools.service'

const SERVER_NAME = 'repobuddy'
const SERVER_VERSION = '0.0.1'

/** 120 requests per hour per IP — generous for interactive agent use,
 * low enough that a runaway loop cannot drain the embeddings budget. */
const RATE_LIMIT_PER_HOUR = 120
const RATE_LIMIT_WINDOW_SEC = 60 * 60

/** Burst window on top of the hourly one. The hourly budget alone can
 * be spent in ten seconds, and `find_resolution` fans out to GitHub
 * search (30 req/min account-wide) on the token the indexer shares. */
const BURST_LIMIT = 10
const BURST_WINDOW_SEC = 10

/** JSON-RPC error codes we emit at the transport layer. */
const JSONRPC_METHOD_NOT_ALLOWED = -32000
const JSONRPC_INVALID_REQUEST = -32600
const JSONRPC_RATE_LIMITED = -32003

@Injectable()
export class McpService {
  private readonly log = new Logger(McpService.name)

  constructor(
    @Inject(TypedConfigService) private readonly config: TypedConfigService,
    @Inject(McpToolsService) private readonly tools: McpToolsService,
  ) {}

  /** Computed once — the values come from env and never change. */
  private hostsCache: string[] | null = null
  private originsCache: string[] | null = null

  get enabled(): boolean {
    return this.config.get('MCP_ENABLED')
  }

  /**
   * Host header values the transport will answer to. Built from the
   * same env the rest of the app uses for URLs, plus the loopback pair
   * on API_PORT so `curl localhost:3001/api/mcp` keeps working in dev
   * (APP_URL points at Nuxt on :3000, not at us).
   */
  private get allowedHosts(): string[] {
    this.hostsCache ??= unique([
      ...hostsOf(this.config.get('APP_URL')),
      ...hostsOf(process.env.API_BASE_URL),
      ...['localhost', '127.0.0.1', '[::1]'].map(
        (h) => `${h}:${process.env.API_PORT ?? 3001}`,
      ),
    ])
    return this.hostsCache
  }

  /**
   * Origins allowed to drive the endpoint from a browser. The transport
   * only rejects an Origin it was *sent* and does not recognise, so
   * header-less clients (Claude Code, curl) are unaffected.
   */
  private get allowedOrigins(): string[] {
    this.originsCache ??= unique([
      this.config.get('APP_URL'),
      ...(process.env.WEB_ORIGIN ?? 'http://localhost:3000').split(','),
    ].map((s) => s.trim().replace(/\/$/, '')))
    return this.originsCache
  }

  /**
   * Handle one JSON-RPC message. Nest's body parser already consumed
   * the stream, so the parsed body is handed to `handleRequest` as the
   * third argument — re-reading `req` would hang forever.
   */
  async handlePost(req: Request, res: Response, body: unknown): Promise<void> {
    // Batching is rejected before anything else runs. The SDK transport
    // happily accepts a JSON-RPC array and dispatches every element,
    // uncapped and concurrently — so one POST costing one rate-limit
    // token could execute hundreds of tools/call, each a paid
    // embeddings request. Batching was dropped from the MCP spec in
    // 2025-06-18, so refusing it costs no compatibility.
    if (Array.isArray(body)) {
      res
        .status(400)
        .json(
          jsonRpcError(
            JSONRPC_INVALID_REQUEST,
            'Batched requests are not supported. Send one JSON-RPC message per POST.',
          ),
        )
      return
    }

    const ip = req.ip ?? 'unknown'
    const limit = await rateLimitTake(
      `cg:rl:mcp:ip:${ip}`,
      RATE_LIMIT_PER_HOUR,
      RATE_LIMIT_WINDOW_SEC,
    )
    if (!limit.ok) {
      res.status(429).json(
        jsonRpcError(
          JSONRPC_RATE_LIMITED,
          `Rate limit exceeded (${RATE_LIMIT_PER_HOUR} requests/hour). Retry in ${Math.ceil(
            limit.retryAfterSec / 60,
          )} minute(s).`,
        ),
      )
      return
    }

    const burst = await rateLimitTake(`cg:rl:mcp:burst:${ip}`, BURST_LIMIT, BURST_WINDOW_SEC)
    if (!burst.ok) {
      res.status(429).json(
        jsonRpcError(
          JSONRPC_RATE_LIMITED,
          `Too many requests in a short window (${BURST_LIMIT} per ${BURST_WINDOW_SEC}s). Retry in ${burst.retryAfterSec}s.`,
        ),
      )
      return
    }

    const server = new McpServer(
      { name: SERVER_NAME, version: SERVER_VERSION },
      {
        instructions:
          'RepoBuddy indexes public GitHub repositories into a typed knowledge graph. Call list_workspaces first to get a workspaceId, then search_code / find_symbol to locate code, get_callers and walkthrough to trace it, and list_issues / find_resolution to find work that is not already done.',
      },
    )
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      // Host/Origin validation. Without it a page on evil.com whose DNS
      // is rebound to 127.0.0.1 reaches a locally-running API as
      // same-origin — CORS never applies, so `enableCors` does not help.
      // Production is also covered by Caddy's host matcher, but a
      // self-hosted deployment without a proxy in front has only this.
      enableDnsRebindingProtection: true,
      allowedHosts: this.allowedHosts,
      allowedOrigins: this.allowedOrigins,
    })

    // Both objects hold per-request state (the transport owns the
    // response writer). Closing on 'close' covers the client-aborted
    // case too, which the finally block below would otherwise miss.
    res.on('close', () => {
      void transport.close().catch(() => undefined)
      void server.close().catch(() => undefined)
    })

    try {
      this.tools.registerAll(server)
      await server.connect(transport)
      await transport.handleRequest(req, res, body)
    } catch (err) {
      this.log.error({ err }, 'mcp request failed')
      if (!res.headersSent) {
        res.status(500).json(jsonRpcError(-32603, 'Internal server error.'))
      }
    }
  }

  /** GET / DELETE carry no meaning without a session. */
  rejectSessionMethod(res: Response): void {
    // RFC 9110 §15.5.6 makes Allow mandatory on 405, and it saves a
    // client from parsing English out of the message to learn that
    // POST is the only method here.
    res.setHeader('Allow', 'POST')
    res
      .status(405)
      .json(
        jsonRpcError(
          JSONRPC_METHOD_NOT_ALLOWED,
          'Method not allowed. This MCP server runs stateless — use POST for every JSON-RPC message; SSE streams and session termination are not supported.',
        ),
      )
  }
}

/**
 * JSON-RPC error envelope. Exported so the parse-error filter can emit
 * the same shape — every failure of this endpoint, including the ones
 * raised before the transport sees the body, must look like JSON-RPC
 * to a client that only knows how to parse that.
 */
export function jsonRpcError(code: number, message: string) {
  return { jsonrpc: '2.0' as const, error: { code, message }, id: null }
}

/** `host:port` of a URL, or nothing if the value is unset/unparseable. */
function hostsOf(url: string | undefined): string[] {
  if (!url) return []
  try {
    return [new URL(url).host]
  } catch {
    return []
  }
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))]
}
