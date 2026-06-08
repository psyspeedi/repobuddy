import { describe, expect, it } from 'vitest'
import {
  createEmbeddingsProvider,
  MockEmbeddingsProvider,
  EMBEDDING_DIMS,
} from '#server/providers/embeddings'

describe('MockEmbeddingsProvider', () => {
  const provider = new MockEmbeddingsProvider()

  it('returns vectors of correct dimensionality', async () => {
    const [vec] = await provider.embedBatch(['hello world'])
    expect(vec).toHaveLength(EMBEDDING_DIMS)
  })

  it('is deterministic for the same input', async () => {
    const [a] = await provider.embedBatch(['some text'])
    const [b] = await provider.embedBatch(['some text'])
    expect(a).toEqual(b)
  })

  it('differs for different inputs', async () => {
    const [a, b] = await provider.embedBatch(['cat', 'dog'])
    expect(a).not.toEqual(b)
  })

  it('produces L2-normalised vectors', async () => {
    const [vec] = await provider.embedBatch(['normalise me'])
    if (!vec) throw new Error('expected vector')
    const norm = Math.sqrt(vec.reduce((acc, v) => acc + v * v, 0))
    expect(norm).toBeCloseTo(1, 3)
  })

  it('handles empty input', async () => {
    expect(await provider.embedBatch([])).toEqual([])
  })
})

describe('createEmbeddingsProvider', () => {
  it('returns mock provider when requested', () => {
    const p = createEmbeddingsProvider({ mock: true })
    expect(p).toBeInstanceOf(MockEmbeddingsProvider)
    expect(p.model).toBe('mock-embeddings')
    expect(p.costCentsPer1MTokens).toBe(0)
  })

  it('throws when api key missing and not mock', () => {
    const orig = process.env.OPENAI_API_KEY
    delete process.env.OPENAI_API_KEY
    try {
      expect(() => createEmbeddingsProvider()).toThrow(/OPENAI_API_KEY/)
    } finally {
      if (orig !== undefined) process.env.OPENAI_API_KEY = orig
    }
  })
})
