import OpenAI from 'openai'
import { z } from 'zod'
import { getLogger } from '#server/lib/logger'

const log = getLogger().child({ component: 'providers/llm' })

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
  /** Set on assistant messages that requested tool calls. */
  tool_calls?: ToolCall[]
  /** Set on tool messages so the model can attribute the result. */
  tool_call_id?: string
}

export interface ToolDefinition {
  name: string
  description: string
  /** JSON Schema for the operator's parameters. */
  parameters: Record<string, unknown>
}

export interface ToolCall {
  id: string
  name: string
  /** Raw JSON-encoded arguments straight from the LLM. Parse client-side. */
  arguments: string
}

export interface ToolStreamingChunk {
  type: 'text' | 'tool_call' | 'done'
  text?: string
  toolCalls?: ToolCall[]
  inputTokens?: number
  outputTokens?: number
}

export interface StreamingChunk {
  type: 'text' | 'done'
  text?: string
  /** Set on the final chunk. */
  inputTokens?: number
  outputTokens?: number
}

export interface StructuredOutputOptions<T> {
  /** Zod schema the response must conform to. */
  schema: z.ZodType<T>
  /** Name passed to OpenAI structured outputs. Letters, digits, _ only. */
  schemaName: string
}

export interface LLMProvider {
  model: string
  costCentsPer1MInputTokens: number
  costCentsPer1MOutputTokens: number
  stream(messages: ChatMessage[], opts?: { temperature?: number }): AsyncGenerator<StreamingChunk>
  /** One-shot structured generation; throws on schema validation failure. */
  structured<T>(messages: ChatMessage[], opts: StructuredOutputOptions<T>): Promise<T>
  /**
   * Stream a response with tool-use enabled. Each turn yields either
   * `text` chunks (final-answer prose), a single `tool_call` chunk
   * carrying one or more parallel calls the caller must execute, or
   * `done` with usage totals. After the caller runs the tools it
   * appends `role: 'tool'` messages and re-invokes this method.
   */
  streamWithTools(
    messages: ChatMessage[],
    tools: ToolDefinition[],
    opts?: { temperature?: number },
  ): AsyncGenerator<ToolStreamingChunk>
}

class OpenAILLMProvider implements LLMProvider {
  readonly model: string
  readonly costCentsPer1MInputTokens: number
  readonly costCentsPer1MOutputTokens: number
  private client: OpenAI

  constructor(opts: { apiKey: string; model?: string; baseURL?: string }) {
    this.client = new OpenAI({ apiKey: opts.apiKey, baseURL: opts.baseURL })
    this.model = opts.model ?? 'gpt-4o'
    // Approximate retail pricing (per 1M tokens, in USD cents). Used purely
    // as an upper-bound USD estimate for budget guardrails — for non-OpenAI
    // providers (Groq, Ollama, …) the real bill may be lower or zero.
    if (/mini|haiku|small/i.test(this.model)) {
      this.costCentsPer1MInputTokens = 15
      this.costCentsPer1MOutputTokens = 60
    } else {
      this.costCentsPer1MInputTokens = 250
      this.costCentsPer1MOutputTokens = 1000
    }
  }

  async *stream(
    messages: ChatMessage[],
    opts: { temperature?: number } = {},
  ): AsyncGenerator<StreamingChunk> {
    const response = await this.client.chat.completions.create({
      model: this.model,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      messages: messages as any,
      temperature: opts.temperature ?? 0.2,
      stream: true,
      stream_options: { include_usage: true },
    })

    let inputTokens = 0
    let outputTokens = 0
    for await (const event of response) {
      const delta = event.choices[0]?.delta?.content
      if (delta) yield { type: 'text', text: delta }
      if (event.usage) {
        inputTokens = event.usage.prompt_tokens
        outputTokens = event.usage.completion_tokens
      }
    }
    yield { type: 'done', inputTokens, outputTokens }
  }

  async *streamWithTools(
    messages: ChatMessage[],
    tools: ToolDefinition[],
    opts: { temperature?: number } = {},
  ): AsyncGenerator<ToolStreamingChunk> {
    // Convert our ChatMessage[] into OpenAI's tool-aware shape. The
    // SDK requires tool messages to carry tool_call_id, and assistant
    // messages with tool_calls to include those calls structurally.
    const oaiMessages = messages.map((m) => {
      if (m.role === 'tool') {
        return { role: 'tool' as const, content: m.content, tool_call_id: m.tool_call_id ?? '' }
      }
      if (m.role === 'assistant' && m.tool_calls && m.tool_calls.length > 0) {
        return {
          role: 'assistant' as const,
          content: m.content || null,
          tool_calls: m.tool_calls.map((t) => ({
            id: t.id,
            type: 'function' as const,
            function: { name: t.name, arguments: t.arguments },
          })),
        }
      }
      return { role: m.role, content: m.content }
    })
    const oaiTools = tools.map((t) => ({
      type: 'function' as const,
      function: {
        name: t.name,
        description: t.description,
        parameters: t.parameters,
      },
    }))

    const response = await this.client.chat.completions.create({
      model: this.model,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      messages: oaiMessages as any,
      tools: oaiTools,
      tool_choice: 'auto',
      temperature: opts.temperature ?? 0.2,
      stream: true,
      stream_options: { include_usage: true },
    })

    // Tool-call fragments arrive split across deltas (matched by index).
    // Accumulate, emit once at the end of the turn.
    const toolCallsByIndex = new Map<number, { id: string; name: string; arguments: string }>()
    let inputTokens = 0
    let outputTokens = 0

    for await (const event of response) {
      const delta = event.choices[0]?.delta
      if (!delta) continue
      if (typeof delta.content === 'string' && delta.content.length > 0) {
        yield { type: 'text', text: delta.content }
      }
      if (delta.tool_calls) {
        for (const tc of delta.tool_calls) {
          const idx = tc.index ?? 0
          const cur = toolCallsByIndex.get(idx) ?? { id: '', name: '', arguments: '' }
          if (tc.id) cur.id = tc.id
          if (tc.function?.name) cur.name = tc.function.name
          if (tc.function?.arguments) cur.arguments += tc.function.arguments
          toolCallsByIndex.set(idx, cur)
        }
      }
      if (event.usage) {
        inputTokens = event.usage.prompt_tokens
        outputTokens = event.usage.completion_tokens
      }
    }

    if (toolCallsByIndex.size > 0) {
      const calls = [...toolCallsByIndex.values()].map((c) => ({
        id: c.id,
        name: c.name,
        arguments: c.arguments,
      }))
      yield { type: 'tool_call', toolCalls: calls }
    }
    yield { type: 'done', inputTokens, outputTokens }
  }

  async structured<T>(
    messages: ChatMessage[],
    opts: StructuredOutputOptions<T>,
  ): Promise<T> {
    // We use response_format: json_object (loose mode) + client-side Zod
    // validation rather than json_schema (strict mode). Strict mode rejects
    // schemas containing z.record(z.unknown()) — which our PlanSchema needs
    // for the per-operator params bag. json_object guarantees parseable
    // JSON; Zod enforces the actual shape on our side. Retry-with-feedback
    // is handled by the caller (see kag/planner.ts).
    const completion = await this.client.chat.completions.create({
      model: this.model,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      messages: messages as any,
      response_format: { type: 'json_object' },
      temperature: 0.1,
    })
    const choice = completion.choices[0]
    if (!choice) throw new Error('LLM returned no choices')
    const raw = choice.message.content
    if (!raw) {
      throw new Error('LLM returned empty content for structured output')
    }
    let json: unknown
    try {
      json = JSON.parse(raw)
    } catch (err) {
      log.error(
        { err, raw: raw.slice(0, 500), schemaName: opts.schemaName },
        'structured output: invalid JSON',
      )
      throw new Error(
        `LLM returned non-JSON content for ${opts.schemaName}: ${(err as Error).message}`,
      )
    }
    const result = opts.schema.safeParse(json)
    if (!result.success) {
      log.error(
        {
          schemaName: opts.schemaName,
          issues: result.error.issues,
          raw: raw.slice(0, 500),
        },
        'structured output: Zod validation failed',
      )
      throw new Error(
        `LLM output failed ${opts.schemaName} schema: ${result.error.issues
          .map((i) => `${i.path.join('.')}: ${i.message}`)
          .join('; ')}`,
      )
    }
    return result.data
  }
}

/**
 * Mock provider returning canned responses. Supports two modes:
 * - text: yield a single text chunk plus done
 * - structured: return a fixed object the test injected up-front
 */
export class MockLLMProvider implements LLMProvider {
  readonly model = 'mock-llm'
  readonly costCentsPer1MInputTokens = 0
  readonly costCentsPer1MOutputTokens = 0

  private nextText: string | null = null
  private nextStructured: unknown = null

  setNextText(text: string): void {
    this.nextText = text
  }
  setNextStructured(payload: unknown): void {
    this.nextStructured = payload
  }

  async *stream(messages: ChatMessage[]): AsyncGenerator<StreamingChunk> {
    void messages
    const text = this.nextText ?? 'mock response'
    this.nextText = null
    yield { type: 'text', text }
    yield { type: 'done', inputTokens: 10, outputTokens: 10 }
  }

  async *streamWithTools(
    messages: ChatMessage[],
    tools: ToolDefinition[],
  ): AsyncGenerator<ToolStreamingChunk> {
    void messages
    void tools
    const text = this.nextText ?? 'mock response'
    this.nextText = null
    yield { type: 'text', text }
    yield { type: 'done', inputTokens: 10, outputTokens: 10 }
  }

  async structured<T>(
    messages: ChatMessage[],
    opts: StructuredOutputOptions<T>,
  ): Promise<T> {
    void messages
    const payload = this.nextStructured
    this.nextStructured = null
    if (payload === null) {
      throw new Error('MockLLMProvider.structured called without setNextStructured()')
    }
    return opts.schema.parse(payload)
  }
}

function envNonEmpty(key: string): string | undefined {
  const v = process.env[key]
  return v && v.length > 0 ? v : undefined
}

export function createLLMProvider(
  opts: { apiKey?: string; model?: string; baseURL?: string; mock?: boolean } = {},
): LLMProvider {
  if (opts.mock || process.env.CODEGRAPH_MOCK_PROVIDERS === '1') {
    return new MockLLMProvider()
  }
  // Resolution order: explicit opts → LLM_* (unified) → OPENAI_* (legacy).
  // Empty strings from .env are treated as "not set".
  const apiKey =
    opts.apiKey ?? envNonEmpty('LLM_API_KEY') ?? envNonEmpty('OPENAI_API_KEY')
  const baseURL = opts.baseURL ?? envNonEmpty('LLM_BASE_URL')
  if (!apiKey) {
    throw new Error('No LLM API key configured (LLM_API_KEY or OPENAI_API_KEY)')
  }
  return new OpenAILLMProvider({ apiKey, model: opts.model, baseURL })
}

