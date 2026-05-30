/**
 * Parse a single Server-Sent Events block — the text between two
 * `\n\n` separators in the response stream — into `{ event, data }`.
 *
 * Per the SSE spec:
 *   - `event:` lines set the event name (default 'message').
 *   - Multiple `data:` lines are joined with a single `\n`. Dropping
 *     the separator collapses formatting like Markdown headings into
 *     their next paragraph ("### Heading:- item1- item2" was the
 *     symptom that drove this implementation).
 *   - Each `data:` line has exactly one leading U+0020 SPACE stripped
 *     (that space is the field separator, not payload content).
 *   - Comments (lines starting with `:`), `id:` and `retry:` fields
 *     are ignored — we don't use them, and h3's createEventStream
 *     doesn't emit them.
 *
 * Pure function — no Vue, no DOM. Lives in shared/lib so it can be
 * unit-tested without a browser environment.
 */
export interface SseEvent {
  event: string
  data: string
  hasData: boolean
}

export function parseSseEvent(raw: string): SseEvent {
  let event = 'message'
  let data = ''
  let hasData = false
  for (const line of raw.split('\n')) {
    if (line.startsWith('event:')) {
      event = line.slice(6).trim()
    } else if (line.startsWith('data:')) {
      let value = line.slice(5)
      if (value.startsWith(' ')) value = value.slice(1)
      if (hasData) data += '\n'
      data += value
      hasData = true
    }
    // `:`-prefixed comments, `id:`, `retry:` deliberately ignored.
  }
  return { event, data, hasData }
}
