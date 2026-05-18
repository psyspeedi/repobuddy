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
    // We use response_format: json_object (loose mode) + client-side Zod
    // validation rather than json_schema (strict mode). Strict mode rejects
    // schemas containing z.record(z.unknown()) — which our PlanSchema needs
    // for the per-operator params bag. json_object guarantees parseable
    // JSON; Zod enforces the actual shape on our side. Retry-with-feedback
    // is handled by the caller (see kag/planner.ts).
    const completion = await this.client.chat.completions.create({
      model: this.model,
      messages,
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

