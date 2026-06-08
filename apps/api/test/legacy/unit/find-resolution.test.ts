import { describe, expect, it } from 'vitest'
import {
  classifyResolution,
  FIX_REF_RE_FOR,
  type ResolutionCommit,
  type ResolutionDuplicate,
  type ResolutionPr,
} from '../../server/kag/operators'

const commit = (sha: string): ResolutionCommit => ({
  sha,
  message: `fix(parser): handle edge case (fixes #42)`,
  author: 'alice',
  date: '2026-06-01T00:00:00Z',
})

const pr = (overrides: Partial<ResolutionPr>): ResolutionPr => ({
  number: 100,
  title: 'fix parser edge case',
  url: 'https://github.com/o/r/pull/100',
  state: 'open',
  draft: false,
  merged: false,
  mergedAt: null,
  author: 'bob',
  lastCommitAt: '2026-06-01T00:00:00Z',
  stale: false,
  bodyExcerpt: 'fixes #42',
  ...overrides,
})

const dup = (overrides: Partial<ResolutionDuplicate>): ResolutionDuplicate => ({
  number: 41,
  title: 'similar bug',
  url: 'https://github.com/o/r/issues/41',
  state: 'closed',
  similarity: 0.9,
  ...overrides,
})

describe('FIX_REF_RE_FOR', () => {
  // The classifier trusts that ONLY commits / PR bodies with a real
  // closing-keyword reference end up in mergedByCommits / linked-PRs.
  // The regex is the gate that filters bare "#N" mentions (which are
  // false positives like "related to #42" / "follow-up after #42").

  const re = FIX_REF_RE_FOR(42)

  it('matches canonical closing keywords', () => {
    expect(re.test('Fixes #42')).toBe(true)
    expect(re.test('fixed #42')).toBe(true)
    expect(re.test('fix #42')).toBe(true)
    expect(re.test('closes #42')).toBe(true)
    expect(re.test('closed #42')).toBe(true)
    expect(re.test('close #42')).toBe(true)
    expect(re.test('resolves #42')).toBe(true)
    expect(re.test('resolved #42')).toBe(true)
    expect(re.test('resolve #42')).toBe(true)
  })

  it('is case-insensitive', () => {
    expect(re.test('CLOSES #42')).toBe(true)
    expect(re.test('FiXeS #42')).toBe(true)
  })

  it('rejects bare references and weak-link phrasing', () => {
    expect(re.test('#42')).toBe(false)
    expect(re.test('related to #42')).toBe(false)
    expect(re.test('follow-up after #42')).toBe(false)
    expect(re.test('see #42 for context')).toBe(false)
    expect(re.test('mentioned in #42')).toBe(false)
  })

  it('rejects different issue numbers via word-boundary', () => {
    expect(re.test('fixes #421')).toBe(false)
    expect(re.test('fixes #4')).toBe(false)
  })

  it('matches inside longer text', () => {
    expect(re.test('This PR fixes #42 and improves perf.')).toBe(true)
  })
})

describe('classifyResolution status ladder', () => {
  // Ladder: merged > open_pr > draft_pr > stale_pr > duplicate_closed
  // > related > none. Highest-signal channel wins so the agent doesn't
  // talk about a draft PR when a merge already shipped.

  it('returns "none" / low when all channels empty', () => {
    const env = classifyResolution(42, [], [], [])
    expect(env.status).toBe('none')
    expect(env.confidence).toBe('low')
  })

  it('returns "merged" / high when commits exist (beats everything)', () => {
    const env = classifyResolution(
      42,
      [commit('abc')],
      [pr({ draft: true })],          // would have been draft_pr alone
      [dup({ similarity: 0.95 })],    // would have been duplicate_closed
    )
    expect(env.status).toBe('merged')
    expect(env.confidence).toBe('high')
  })

  it('returns "open_pr" / medium when an open ready PR exists, no merges', () => {
    const env = classifyResolution(42, [], [pr({ draft: false, stale: false })], [])
    expect(env.status).toBe('open_pr')
    expect(env.confidence).toBe('medium')
  })

  it('returns "draft_pr" / medium when only a draft PR exists (the zod#6049 case)', () => {
    const env = classifyResolution(42, [], [pr({ draft: true })], [])
    expect(env.status).toBe('draft_pr')
    expect(env.confidence).toBe('medium')
  })

  it('prefers open ready PR over draft PR when both exist', () => {
    const env = classifyResolution(
      42,
      [],
      [pr({ number: 200, draft: true }), pr({ number: 201, draft: false })],
      [],
    )
    expect(env.status).toBe('open_pr')
  })

  it('returns "stale_pr" / low when only stale PR exists', () => {
    const env = classifyResolution(42, [], [pr({ stale: true })], [])
    expect(env.status).toBe('stale_pr')
    expect(env.confidence).toBe('low')
  })

  it('returns "duplicate_closed" / medium when closed similar issue with sim≥0.85', () => {
    const env = classifyResolution(42, [], [], [dup({ state: 'closed', similarity: 0.9 })])
    expect(env.status).toBe('duplicate_closed')
    expect(env.confidence).toBe('medium')
  })

  it('returns "related" / low for sim 0.70–0.85 even if closed', () => {
    const env = classifyResolution(42, [], [], [dup({ state: 'closed', similarity: 0.78 })])
    expect(env.status).toBe('related')
    expect(env.confidence).toBe('low')
  })

  it('returns "related" / low when only open similar exists (open is not a duplicate)', () => {
    const env = classifyResolution(42, [], [], [dup({ state: 'open', similarity: 0.92 })])
    expect(env.status).toBe('related')
    expect(env.confidence).toBe('low')
  })

  it('skips merged PR from open_pr classification (already in past)', () => {
    const env = classifyResolution(
      42,
      [],
      [pr({ merged: true, mergedAt: '2026-05-01T00:00:00Z' })],
      [],
    )
    expect(env.status).toBe('none')
  })
})
