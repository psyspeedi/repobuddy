import { describe, expect, it } from 'vitest'
import { planQuestion } from '#server/kag/planner'
import { MockLLMProvider } from '#server/providers/llm'

describe('planQuestion', () => {
  it('returns the LLM-generated plan when valid', async () => {
    const llm = new MockLLMProvider()
    const expected = {
      reasoning: 'Direct lookup.',
      steps: [
        { id: 's1', op: 'find_symbol', params: { name: 'Foo' } },
        { id: 's2', op: 'answer', params: { question: 'q', context: ['$s1'] } },
      ],
    }
    llm.setNextStructured(expected)
    const plan = await planQuestion(llm, 'Where is Foo defined?', {
      workspaceName: 'w',
      languages: ['typescript'],
    })
    expect(plan.reasoning).toBe('Direct lookup.')
    expect(plan.steps).toHaveLength(2)
    expect(plan.steps[0]?.op).toBe('find_symbol')
  })

  it('falls back to RAG plan when llm throws both times', async () => {
    const llm = new MockLLMProvider()
    // setNextStructured not called → throws on first AND retry.
    const plan = await planQuestion(llm, 'broad question', {
      workspaceName: 'w',
      languages: ['typescript'],
    })
    expect(plan.reasoning).toMatch(/fallback/i)
    expect(plan.steps).toHaveLength(2)
    expect(plan.steps[0]?.op).toBe('hybrid_search')
    expect(plan.steps[1]?.op).toBe('answer')
  })

  it('first failure + valid retry returns retry payload', async () => {
    const llm = new MockLLMProvider()
    // structured() consumes setNextStructured exactly once. First call throws
    // (queue empty); set up retry payload AFTER the first call has been
    // consumed. We emulate by overriding the provider method.
    let calls = 0
    const original = llm.structured.bind(llm)
    llm.structured = (messages, opts) => {
      calls++
      if (calls === 1) return Promise.reject(new Error('schema fail'))
      llm.setNextStructured({
        reasoning: 'second attempt ok',
        steps: [
          { id: 's1', op: 'find_symbol', params: { name: 'X' } },
          { id: 's2', op: 'answer', params: { question: 'q', context: ['$s1'] } },
        ],
      })
      return original(messages, opts)
    }
    const plan = await planQuestion(llm, 'q', {
      workspaceName: 'w',
      languages: [],
    })
    expect(plan.reasoning).toBe('second attempt ok')
    expect(calls).toBe(2)
  })
})
