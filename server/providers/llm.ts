import OpenAI from 'openai'
import { z } from 'zod'
import { getLogger } from '../lib/logger'

const log = getLogger().child({ component: 'providers/llm' })

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
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
}

class OpenAILLMProvider implements LLMProvider {
  readonly model: string
  readonly costCentsPer1MInputTokens: number
  readonly costCentsPer1MOutputTokens: number
  private client: OpenAI

  constructor(opts: { apiKey: string; model?: string }) {
    this.client = new OpenAI({ apiKey: opts.apiKey })
    this.model = opts.model ?? 'gpt-4o'
    // Approximate retail pricing (per 1M tokens, in USD cents).
    if (this.model.startsWith('gpt-4o-mini')) {
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
      messages,
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

  async structured<T>(
    messages: ChatMessage[],
    opts: StructuredOutputOptions<T>,
  ): Promise<T> {
    // OpenAI's `chat.completions.parse` with `zodResponseFormat` (beta API)
    // is the supported path for Zod-typed responses.
    const parsed = await this.client.chat.completions.parse({
      model: this.model,
      messages,
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: opts.schemaName,
          strict: true,
          schema: zodToOpenAIJsonSchema(opts.schema),
        },
      } as never,
    } as never)
    const raw = parsed.choices[0]?.message.content
    if (!raw) throw new Error('LLM returned empty content')
    try {
      const json = JSON.parse(raw)
      return opts.schema.parse(json)
    } catch (err) {
      log.error({ err, raw: raw.slice(0, 500) }, 'structured output parse failed')
      throw err
    }
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

export function createLLMProvider(
  opts: { apiKey?: string; model?: string; mock?: boolean } = {},
): LLMProvider {
  if (opts.mock || process.env.CODEGRAPH_MOCK_PROVIDERS === '1') {
    return new MockLLMProvider()
  }
  const apiKey = opts.apiKey ?? process.env.OPENAI_API_KEY
  if (!apiKey) {
    throw new Error('OPENAI_API_KEY required for LLM provider')
  }
  return new OpenAILLMProvider({ apiKey, model: opts.model })
}

/**
 * Minimal Zod → OpenAI JSON schema converter for our specific shapes
 * (object with primitive fields, arrays, optional unions). For complex
 * schemas, swap this for `zod-to-json-schema` later.
 */
function zodToOpenAIJsonSchema(schema: z.ZodTypeAny): unknown {
  return convert(schema)
}

function convert(s: z.ZodTypeAny): Record<string, unknown> {
  if (s instanceof z.ZodString) return { type: 'string' }
  if (s instanceof z.ZodNumber) return { type: 'number' }
  if (s instanceof z.ZodBoolean) return { type: 'boolean' }
  if (s instanceof z.ZodLiteral) {
    return { type: typeof s.value, enum: [s.value] }
  }
  if (s instanceof z.ZodEnum) {
    return { type: 'string', enum: [...s.options] }
  }
  if (s instanceof z.ZodArray) {
    return { type: 'array', items: convert(s.element) }
  }
  if (s instanceof z.ZodOptional) return convert(s.unwrap())
  if (s instanceof z.ZodNullable) {
    const inner = convert(s.unwrap())
    return { anyOf: [inner, { type: 'null' }] }
  }
  if (s instanceof z.ZodObject) {
    const shape = s.shape as Record<string, z.ZodTypeAny>
    const properties: Record<string, unknown> = {}
    const required: string[] = []
    for (const [key, val] of Object.entries(shape)) {
      properties[key] = convert(val)
      if (!(val instanceof z.ZodOptional)) required.push(key)
    }
    return {
      type: 'object',
      properties,
      required,
      additionalProperties: false,
    }
  }
  if (s instanceof z.ZodUnion) {
    return { anyOf: s.options.map((o: z.ZodTypeAny) => convert(o)) }
  }
  if (s instanceof z.ZodDiscriminatedUnion) {
    return { anyOf: [...s.options.values()].map((o: z.ZodTypeAny) => convert(o)) }
  }
  if (s instanceof z.ZodRecord) {
    return { type: 'object', additionalProperties: convert(s.valueSchema) }
  }
  if (s instanceof z.ZodUnknown || s instanceof z.ZodAny) return {}
  return {} // best-effort
}
