import { describe, expect, it } from 'vitest'
import {
  estimateMicroCents,
  MICRO_CENTS_PER_CENT,
  MICRO_CENTS_PER_USD,
} from '../../src/lib/cost-log'

// Prices from providers/internals/llm.ts, in cents per 1M tokens.
const MINI = { input: 15, output: 60 }
const FULL = { input: 250, output: 1000 }

describe('estimateMicroCents', () => {
  it('keeps sub-cent calls sub-cent', () => {
    // One annotation: ~1750 prompt tokens, 200 completion tokens on the
    // extraction tier. Rounding each term up to a whole cent — the bug
    // this replaced — billed this at 2 cents, ~50x the real figure.
    const micro = estimateMicroCents({
      inputTokens: 1750,
      outputTokens: 200,
      costCentsPer1MInput: MINI.input,
      costCentsPer1MOutput: MINI.output,
    })
    const cents = micro / MICRO_CENTS_PER_CENT
    expect(cents).toBeGreaterThan(0)
    expect(cents).toBeLessThan(0.1)
  })

  it('leaves a $2 index budget room for thousands of annotations', () => {
    const perEntity = estimateMicroCents({
      inputTokens: 1750,
      outputTokens: 200,
      costCentsPer1MInput: MINI.input,
      costCentsPer1MOutput: MINI.output,
    })
    const budget = 2 * MICRO_CENTS_PER_USD
    expect(Math.floor(budget / perEntity)).toBeGreaterThan(2000)
  })

  it('scales linearly with token count', () => {
    const one = estimateMicroCents({
      inputTokens: 1_000_000,
      costCentsPer1MInput: MINI.input,
    })
    const ten = estimateMicroCents({
      inputTokens: 10_000_000,
      costCentsPer1MInput: MINI.input,
    })
    // 1M tokens at 15 cents/1M is exactly 15 cents.
    expect(one).toBe(15 * MICRO_CENTS_PER_CENT)
    expect(ten).toBe(10 * one)
  })

  it('charges the planning tier more than the extraction tier', () => {
    const args = { inputTokens: 5000, outputTokens: 800 }
    const mini = estimateMicroCents({
      ...args,
      costCentsPer1MInput: MINI.input,
      costCentsPer1MOutput: MINI.output,
    })
    const full = estimateMicroCents({
      ...args,
      costCentsPer1MInput: FULL.input,
      costCentsPer1MOutput: FULL.output,
    })
    expect(full).toBeGreaterThan(mini * 10)
  })

  it('treats missing token counts and prices as zero', () => {
    expect(estimateMicroCents({})).toBe(0)
    expect(estimateMicroCents({ inputTokens: 1000 })).toBe(0)
    expect(estimateMicroCents({ costCentsPer1MInput: 250 })).toBe(0)
  })

  it('ignores negative token counts rather than crediting spend', () => {
    expect(
      estimateMicroCents({
        inputTokens: -1_000_000,
        costCentsPer1MInput: MINI.input,
      }),
    ).toBe(0)
  })
})
