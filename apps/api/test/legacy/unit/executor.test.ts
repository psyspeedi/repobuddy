import { describe, expect, it } from 'vitest'
import { resolveReferences } from '../../server/kag/executor'

describe('resolveReferences', () => {
  it('returns plain string unchanged', () => {
    expect(resolveReferences('hello', {})).toBe('hello')
  })

  it('resolves single $s1 reference', () => {
    expect(resolveReferences('$s1', { s1: [{ id: 'a' }] })).toEqual([{ id: 'a' }])
  })

  it('resolves $s1.field', () => {
    expect(
      resolveReferences('$s1.entity', { s1: { entity: { id: 'x' } } }),
    ).toEqual({ id: 'x' })
  })

  it('resolves $s1[0].id', () => {
    expect(
      resolveReferences('$s1[0].id', {
        s1: [{ id: 'first' }, { id: 'second' }],
      }),
    ).toBe('first')
  })

  it('walks nested objects', () => {
    expect(
      resolveReferences(
        { target: '$s1', limit: 10, nested: { entity: '$s2.first' } },
        { s1: ['x', 'y'], s2: { first: 'aaa' } },
      ),
    ).toEqual({ target: ['x', 'y'], limit: 10, nested: { entity: 'aaa' } })
  })

  it('walks arrays', () => {
    expect(
      resolveReferences(['$s1', '$s2'], { s1: 1, s2: 2 }),
    ).toEqual([1, 2])
  })

  it('returns undefined for unresolvable path', () => {
    expect(resolveReferences('$s1.missing', { s1: {} })).toBeUndefined()
  })

  it('leaves $-prefixed strings that do not match pattern alone', () => {
    expect(resolveReferences('$variable', {})).toBe('$variable')
  })
})
