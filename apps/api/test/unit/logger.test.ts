import { describe, expect, it } from 'vitest'
import { currentTrace, withTrace } from '#server/lib/logger'

describe('withTrace', () => {
  it('creates a fresh traceId when none provided', async () => {
    const result = await withTrace({}, () => {
      const ctx = currentTrace()
      return ctx?.traceId
    })
    expect(result).toMatch(/^[0-9a-f-]{36}$/)
  })

  it('uses provided traceId verbatim', async () => {
    const tid = '00000000-0000-0000-0000-000000000001'
    const result = await withTrace({ traceId: tid }, () => currentTrace()?.traceId)
    expect(result).toBe(tid)
  })

  it('inherits parent traceId on nested call', async () => {
    const tid = '00000000-0000-0000-0000-000000000002'
    const inner = await withTrace({ traceId: tid }, async () => {
      return withTrace({ workspaceId: 'w1' }, () => currentTrace())
    })
    expect(inner?.traceId).toBe(tid)
    expect(inner?.workspaceId).toBe('w1')
  })

  it('returns undefined outside any trace', () => {
    expect(currentTrace()).toBeUndefined()
  })
})
