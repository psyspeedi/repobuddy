import { describe, expect, it } from 'vitest'
import { answer, extractCitations } from '#server/kag/operators/answer'
import { MockLLMProvider } from '#server/providers/llm'

describe('extractCitations', () => {
  it('parses chunk and entity citations', () => {
    const text =
      'The OrderService [entity:00000000-0000-0000-0000-000000000001] calls processPayment defined in src/orders.ts [chunk:00000000-0000-0000-0000-000000000002].'
    const cites = extractCitations(text)
    expect(cites).toEqual([
      { kind: 'entity', id: '00000000-0000-0000-0000-000000000001' },
      { kind: 'chunk', id: '00000000-0000-0000-0000-000000000002' },
    ])
  })

  it('deduplicates repeated citations', () => {
    const text = '[chunk:abc01234-1234-1234-1234-1234567890ab] and [chunk:abc01234-1234-1234-1234-1234567890ab] again'
    const cites = extractCitations(text)
    expect(cites).toHaveLength(1)
  })

  it('ignores malformed markers', () => {
    expect(extractCitations('[chunk:not-a-uuid] [entity:abc]')).toEqual([])
  })

  it('returns empty array for no citations', () => {
    expect(extractCitations('plain text')).toEqual([])
  })
})

describe('answer operator', () => {
  it('streams text + done chunks from mock llm', async () => {
    const llm = new MockLLMProvider()
    llm.setNextText('The class is OrderService [chunk:11111111-1111-1111-1111-111111111111].')

    const events: { type: string; text?: string }[] = []
    for await (const evt of answer(llm, {
      question: 'Where is OrderService defined?',
      chunks: [
        {
          id: '11111111-1111-1111-1111-111111111111',
          text: 'export class OrderService {}',
          filePath: 'src/orders.ts',
          startLine: 10,
          endLine: 25,
        },
      ],
    })) {
      events.push({ type: evt.type, text: evt.text })
    }
    expect(events.length).toBe(2)
    expect(events[0]?.type).toBe('text')
    expect(events[0]?.text).toContain('OrderService')
    expect(events[1]?.type).toBe('done')
  })
})

describe('resolution status in the answer prompt', () => {
  /**
   * Captures the rendered user message so we can assert on the prompt
   * itself. MockLLMProvider discards its messages.
   */
  class RecordingLLM extends MockLLMProvider {
    lastUserMessage = ''
    override async *stream(messages: { role: string; content: string }[]) {
      this.lastUserMessage = messages.find((m) => m.role === 'user')?.content ?? ''
      yield { type: 'text' as const, text: 'ok' }
      yield { type: 'done' as const, inputTokens: 1, outputTokens: 1 }
    }
  }

  const run = async (resolution: Record<string, unknown>): Promise<string> => {
    const llm = new RecordingLLM()
    for await (const _ of answer(llm as never, {
      question: 'I want to take issue #42',
      chunks: [],
      resolution: resolution as never,
    })) { /* drain */ }
    return llm.lastUserMessage
  }

  const base = {
    issueNumber: 42,
    status: 'none' as const,
    confidence: 'low' as const,
    mergedByCommits: [],
    linkedPullRequests: [],
    duplicateCandidates: [],
  }

  it('asserts "unresolved" only when the check actually completed', async () => {
    const prompt = await run(base)
    expect(prompt).toContain('found NO merged fix')
    expect(prompt).not.toContain('could NOT complete')
  })

  it('hedges instead of asserting when the lookup was rate limited', async () => {
    const prompt = await run({ ...base, reason: 'rate_limited' })
    expect(prompt).toContain('could NOT complete')
    expect(prompt).toContain('rate limit')
    // The whole point: it must not tell the user nobody is working on it.
    expect(prompt).not.toContain('found NO merged fix')
  })

  it('hedges when the GitHub call failed outright', async () => {
    const prompt = await run({ ...base, reason: 'fetch_failed' })
    expect(prompt).toContain('could NOT complete')
    expect(prompt).not.toContain('found NO merged fix')
  })

  it('still reports a positive verdict normally', async () => {
    const prompt = await run({
      ...base,
      status: 'merged',
      confidence: 'high',
      mergedByCommits: [{ sha: 'abc1234', message: 'fixes #42', author: 'me', date: '2026-01-01' }],
    })
    expect(prompt).toContain('Status: merged')
    expect(prompt).toContain('### Fixing commits')
    expect(prompt).not.toContain('could NOT complete')
  })
})
