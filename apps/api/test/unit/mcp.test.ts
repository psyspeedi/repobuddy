import { describe, expect, it, vi } from 'vitest'
import { McpToolsService, MCP_TOOL_NAMES } from '#modules/mcp/internals/tools.service'
import { publicStats } from '#modules/mcp/internals/workspace'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'

type Handler = (args: Record<string, unknown>) => Promise<CallToolResult>

/**
 * Captures registerTool calls instead of standing up a real McpServer —
 * we only care about the catalogue and the handlers, not the protocol
 * machinery (that is covered by the live curl check).
 */
function recordingServer() {
  const names: string[] = []
  const handlers = new Map<string, Handler>()
  const descriptions = new Map<string, string | undefined>()
  const server = {
    registerTool(name: string, config: { description?: string }, cb: Handler) {
      names.push(name)
      handlers.set(name, cb)
      descriptions.set(name, config.description)
      return {}
    },
  }
  return { names, handlers, descriptions, server: server as unknown as McpServer }
}

/** CallToolResult content is a union of text/image/audio/resource
 * blocks; every result we build is a single text block. */
function textOf(result: CallToolResult): string {
  const block = result.content[0]
  return block && block.type === 'text' ? block.text : ''
}

/** Drizzle's builder chain is fluent and awaited at the end; a thenable
 * terminal is all the service needs from it. */
function dbReturning(rows: unknown[]) {
  const chain = {
    from: () => chain,
    where: () => chain,
    orderBy: () => chain,
    limit: () => Promise.resolve(rows),
  }
  return { select: () => chain } as never
}

function makeService(rows: unknown[]) {
  const registry = { get: vi.fn(() => undefined) } as never
  const providers = {
    serverEmbeddings: vi.fn(() => {
      throw new Error('embeddings must not be constructed for a rejected workspace')
    }),
    serverLlm: vi.fn(() => {
      throw new Error('llm must not be constructed for a rejected workspace')
    }),
  } as never
  return new McpToolsService(dbReturning(rows), registry, providers)
}

const PUBLIC_ID = '11111111-1111-4111-8111-111111111111'

describe('MCP tool catalogue', () => {
  // Drift guard, mirroring planner-catalogue.test.ts. The registered
  // set IS the wire protocol external clients bind to — a rename or an
  // accidental extra tool is a breaking change, so it has to be a
  // deliberate edit to MCP_TOOL_NAMES rather than a silent side effect.
  it('registers exactly the declared tools, in order', () => {
    const { names, server } = recordingServer()
    makeService([]).registerAll(server)
    expect(names).toEqual([...MCP_TOOL_NAMES])
  })

  it('never exposes the `answer` operator', () => {
    // The client brings its own LLM; running ours would spend tokens
    // producing prose nobody asked for.
    expect([...MCP_TOOL_NAMES]).not.toContain('answer')
  })

  it('gives every tool a description for the client model', () => {
    const { descriptions, server } = recordingServer()
    makeService([]).registerAll(server)
    for (const name of MCP_TOOL_NAMES) {
      expect(descriptions.get(name)?.length ?? 0).toBeGreaterThan(20)
    }
  })
})

describe('public-workspace guard', () => {
  // Every workspace-scoped tool goes through the same guard, so we
  // assert on all of them rather than trusting one representative.
  const scopedTools = MCP_TOOL_NAMES.filter((n) => n !== 'list_workspaces')

  for (const tool of scopedTools) {
    it(`${tool} rejects a workspace that is not public`, async () => {
      // loadPublicWorkspace filters on is_public in SQL, so a private
      // workspace comes back as zero rows.
      const { handlers, server } = recordingServer()
      makeService([]).registerAll(server)
      const handler = handlers.get(tool)
      expect(handler).toBeDefined()

      const result = await handler!({
        workspaceId: PUBLIC_ID,
        query: 'x',
        name: 'x',
        entityId: PUBLIC_ID,
        path: 'x.ts',
        issueNumber: 1,
      })
      expect(result.isError).toBe(true)
      expect(textOf(result)).toMatch(/No public workspace/)
    })
  }

  it('rejects a malformed workspace id without touching the database', async () => {
    const select = vi.fn(() => {
      throw new Error('db should not be queried for a non-uuid id')
    })
    const service = new McpToolsService({ select } as never, { get: vi.fn() } as never, {} as never)
    const { handlers, server } = recordingServer()
    service.registerAll(server)

    const result = await handlers.get('search_code')!({ workspaceId: 'not-a-uuid', query: 'x' })
    expect(result.isError).toBe(true)
    expect(select).not.toHaveBeenCalled()
  })

  it('reports an unfinished index distinctly from a missing workspace', async () => {
    const { handlers, server } = recordingServer()
    makeService([
      {
        id: PUBLIC_ID,
        name: 'demo',
        sourceUrl: null,
        languages: [],
        stats: null,
        status: 'indexing',
        lastIndexedAt: null,
      },
    ]).registerAll(server)

    const result = await handlers.get('search_code')!({ workspaceId: PUBLIC_ID, query: 'x' })
    expect(result.isError).toBe(true)
    expect(textOf(result)).toMatch(/not finished indexing/)
  })
})

describe('publicStats', () => {
  // workspaces.stats is a free-form jsonb blob the indexer merges into,
  // and one of the things it merges carries contributor e-mail
  // addresses. These pin that only flat numbers survive the projection,
  // so a field added to stats later cannot ride out through an
  // unauthenticated tool without someone editing publicStats.
  it('drops nested objects, keeping only top-level numbers', () => {
    const projected = publicStats({
      entities: 120,
      chunks: 4300,
      gitInsights: {
        busFactor: 2,
        topAuthors: [{ name: 'Ada', email: 'ada@example.com', commitCount: 9 }],
      },
    })
    expect(projected).toEqual({ entities: 120, chunks: 4300 })
    expect(JSON.stringify(projected)).not.toContain('@')
  })

  it('drops strings, arrays and non-finite numbers', () => {
    expect(
      publicStats({ ok: 1, who: 'ada@example.com', list: [1, 2], nan: Number.NaN }),
    ).toEqual({ ok: 1 })
  })

  it('passes null through', () => {
    expect(publicStats(null)).toBeNull()
  })
})
