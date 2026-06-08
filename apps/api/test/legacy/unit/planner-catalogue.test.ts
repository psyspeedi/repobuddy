import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { OPERATOR_NAMES } from '../../shared/schemas/plan'

const PLANNER_SOURCE = readFileSync(
  resolve(__dirname, '../../server/kag/planner.ts'),
  'utf-8',
)
const AGENTIC_SOURCE = readFileSync(
  resolve(__dirname, '../../server/kag/agentic.ts'),
  'utf-8',
)

describe('planner catalogue prose covers OPERATOR_NAMES', () => {
  // The planner's SYSTEM_PROMPT is a hand-written prose catalogue that
  // teaches the LLM about each operator. TypeScript can't enforce that
  // every Zod-enum entry is mentioned there (it's a string). When that
  // sync breaks the planner stops emitting plans that use the new op —
  // silent regression. This test prevents that.

  for (const name of OPERATOR_NAMES) {
    it(`mentions \`${name}\` in the planner prompt`, () => {
      expect(PLANNER_SOURCE).toContain(name)
    })
  }
})

describe('agentic tool defs cover every non-`answer` operator', () => {
  // `answer` is the implicit final-text turn — the LLM stops calling
  // tools and writes prose. Everything else must be exposed as a tool
  // for the agentic loop to be able to dispatch it.
  const toolNames = OPERATOR_NAMES.filter((n) => n !== 'answer')
  for (const name of toolNames) {
    it(`has a tool definition for \`${name}\``, () => {
      expect(AGENTIC_SOURCE).toMatch(new RegExp(`['"]?${name}['"]?\\s*:`))
    })
  }
})
