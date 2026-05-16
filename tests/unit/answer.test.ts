import { describe, expect, it } from 'vitest'
import { answer, extractCitations } from '../../server/kag/operators/answer'
import { MockLLMProvider } from '../../server/providers/llm'

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
