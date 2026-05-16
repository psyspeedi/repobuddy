import { describe, expect, it } from 'vitest'
import { SUPPORTED_LANGUAGES } from '#shared/types'

describe('smoke', () => {
  it('exposes supported languages', () => {
    expect(SUPPORTED_LANGUAGES).toContain('typescript')
    expect(SUPPORTED_LANGUAGES).toContain('python')
    expect(SUPPORTED_LANGUAGES).toContain('go')
    expect(SUPPORTED_LANGUAGES).toHaveLength(4)
  })

  it('runs basic arithmetic', () => {
    expect(2 + 2).toBe(4)
  })
})
