import { describe, expect, it } from 'vitest'
import { parseSseEvent } from '../../shared/lib/sse'

describe('parseSseEvent', () => {
  it('defaults the event name to "message" when no event: line is present', () => {
    const out = parseSseEvent('data: hi')
    expect(out.event).toBe('message')
    expect(out.data).toBe('hi')
    expect(out.hasData).toBe(true)
  })

  it('reads the event: line and trims whitespace', () => {
    const out = parseSseEvent('event: text\ndata: hello')
    expect(out.event).toBe('text')
    expect(out.data).toBe('hello')
  })

  it('strips exactly one leading U+0020 from data: lines', () => {
    // Two spaces — only the first one is the SSE field separator.
    const out = parseSseEvent('data:  trailing-space-payload')
    expect(out.data).toBe(' trailing-space-payload')
  })

  it('joins multiple data: lines with a single \\n', () => {
    // h3's createEventStream serialises a value containing newlines as
    // multiple data: lines. Dropping the separator (which the naïve
    // implementation did) collapses Markdown headings into the next
    // paragraph — we saw "### Heading:- item1- item2" before this fix.
    const raw = 'event: text\ndata: ### Heading\ndata: - item 1\ndata: - item 2'
    const out = parseSseEvent(raw)
    expect(out.event).toBe('text')
    expect(out.data).toBe('### Heading\n- item 1\n- item 2')
  })

  it('returns hasData=false when only an event: line is present', () => {
    const out = parseSseEvent('event: done')
    expect(out.event).toBe('done')
    expect(out.data).toBe('')
    expect(out.hasData).toBe(false)
  })

  it('handles an empty payload data: with hasData=true', () => {
    // `data:` (no space, no payload) is still a data field per spec —
    // produces an empty-string payload. Distinguishable from "no data
    // at all" via hasData.
    const out = parseSseEvent('event: text\ndata:')
    expect(out.data).toBe('')
    expect(out.hasData).toBe(true)
  })

  it('ignores comments, id, and retry fields', () => {
    const raw = [
      ': this is a comment',
      'id: 42',
      'retry: 5000',
      'event: text',
      'data: payload',
    ].join('\n')
    const out = parseSseEvent(raw)
    expect(out.event).toBe('text')
    expect(out.data).toBe('payload')
  })

  it('preserves payload content that itself starts with the word "data"', () => {
    // The lstrip is for the field-separator space ONLY; we should not
    // touch payload that legitimately starts with "data" / a colon.
    const out = parseSseEvent('event: text\ndata: data: nested')
    expect(out.data).toBe('data: nested')
  })

  it('produces JSON-parseable data when the server emits structured payload', () => {
    // Common shape: { event: 'plan', data: JSON-encoded object }.
    const payload = { reasoning: 'r', steps: [{ id: 's1', op: 'find_symbol', params: {} }] }
    const raw = `event: plan\ndata: ${JSON.stringify(payload)}`
    const out = parseSseEvent(raw)
    expect(out.event).toBe('plan')
    expect(JSON.parse(out.data)).toEqual(payload)
  })

  it('handles a multi-line JSON payload split across data: lines', () => {
    // Some SSE producers pretty-print payloads. Round-trip should hold.
    const payload = { a: 1, b: [2, 3] }
    const pretty = JSON.stringify(payload, null, 2)
    const raw = ['event: trace', ...pretty.split('\n').map((l) => `data: ${l}`)].join('\n')
    const out = parseSseEvent(raw)
    expect(out.event).toBe('trace')
    expect(JSON.parse(out.data)).toEqual(payload)
  })
})
