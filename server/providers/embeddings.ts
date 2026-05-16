import OpenAI from 'openai'
import { createHash } from 'node:crypto'
import {
  decode,
  encode,
  isWithinTokenLimit,
} from 'gpt-tokenizer/model/text-embedding-3-small'
import { getLogger } from '../lib/logger'

const log = getLogger().child({ component: 'providers/embeddings' })

export const EMBEDDING_DIMS = 1536

export interface EmbeddingsProvider {
  /** Returns one vector per input, in the same order. */
  embedBatch(texts: string[]): Promise<number[][]>
  /** Cents per million input tokens (for cost guardrails). 0 for mocks. */
  costCentsPer1MTokens: number
  model: string
}

interface OpenAIProviderOptions {
  apiKey: string
  model?: string
  maxBatchSize?: number
  maxRetries?: number
}

class OpenAIEmbeddingsProvider implements EmbeddingsProvider {
  readonly model: string
  readonly costCentsPer1MTokens = 2 // text-embedding-3-small as of 2024
  private client: OpenAI
  private maxBatchSize: number
  private maxRetries: number

  constructor(opts: OpenAIProviderOptions) {
    this.client = new OpenAI({ apiKey: opts.apiKey })
    this.model = opts.model ?? 'text-embedding-3-small'
    this.maxBatchSize = opts.maxBatchSize ?? 100
    this.maxRetries = opts.maxRetries ?? 3
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return []
    // OpenAI embedding models cap at 8192 tokens per input. We tokenise with
    // the actual cl100k-style tokenizer used by text-embedding-3-small and
    // truncate over-long inputs. Full chunk text in DB is unchanged; only
    // what we feed the API is shortened.
    const truncated = texts.map((t) => truncateToTokenLimit(t))
    const result: number[][] = new Array(texts.length)
    for (let start = 0; start < truncated.length; start += this.maxBatchSize) {
      const slice = truncated.slice(start, start + this.maxBatchSize)
      const vectors = await this.embedWithRetry(slice)
      for (let i = 0; i < vectors.length; i++) {
        const vec = vectors[i]
        if (vec) result[start + i] = vec
      }
    }
    return result
  }

  private async embedWithRetry(texts: string[]): Promise<number[][]> {
    let lastErr: unknown
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        const response = await this.client.embeddings.create({
          model: this.model,
          input: texts,
        })
        return response.data.map((d) => d.embedding)
      } catch (err) {
        lastErr = err
        const status = (err as { status?: number }).status
        if (status && status < 500 && status !== 429) {
          throw err
        }
        const backoffMs = Math.min(1000 * 2 ** attempt, 16000)
        log.warn({ attempt, status, backoffMs }, 'embed retry')
        await sleep(backoffMs)
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error('embed retries exhausted')
  }
}

const EMBEDDING_TOKEN_LIMIT = 8000 // OpenAI hard cap is 8192; keep margin.

function truncateToTokenLimit(text: string): string {
  // Fast path: most chunks are well under the cap.
  if (isWithinTokenLimit(text, EMBEDDING_TOKEN_LIMIT)) return text
  const tokens = encode(text)
  return decode(tokens.slice(0, EMBEDDING_TOKEN_LIMIT))
}

/**
 * Deterministic embeddings derived from a hash. Used in tests so we can
 * assert specific similarity orderings without hitting OpenAI.
 *
 * Algorithm: SHA-256(text) → 32 bytes → expanded into 1536 floats by
 * cycling and adding a small per-position perturbation, then L2-normalised.
 */
export class MockEmbeddingsProvider implements EmbeddingsProvider {
  readonly costCentsPer1MTokens = 0
  readonly model = 'mock-embeddings'

  async embedBatch(texts: string[]): Promise<number[][]> {
    return texts.map((t) => this.embed(t))
  }

  private embed(text: string): number[] {
    const hash = createHash('sha256').update(text.toLowerCase()).digest()
    const out = new Array<number>(EMBEDDING_DIMS)
    let sumSq = 0
    for (let i = 0; i < EMBEDDING_DIMS; i++) {
      const byte = hash[i % hash.length] ?? 0
      const v = (byte / 255) * 2 - 1 + Math.sin(i * 0.013)
      out[i] = v
      sumSq += v * v
    }
    const norm = Math.sqrt(sumSq) || 1
    for (let i = 0; i < EMBEDDING_DIMS; i++) {
      out[i] = (out[i] ?? 0) / norm
    }
    return out
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

export function createEmbeddingsProvider(
  opts: Partial<OpenAIProviderOptions> & { mock?: boolean } = {},
): EmbeddingsProvider {
  if (opts.mock || process.env.CODEGRAPH_MOCK_PROVIDERS === '1') {
    return new MockEmbeddingsProvider()
  }
  const apiKey = opts.apiKey ?? process.env.OPENAI_API_KEY
  if (!apiKey) {
    throw new Error('OPENAI_API_KEY is required for embeddings (or pass mock: true)')
  }
  return new OpenAIEmbeddingsProvider({ ...opts, apiKey })
}
