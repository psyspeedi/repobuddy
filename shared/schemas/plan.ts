import { z } from 'zod'

export const OPERATOR_NAMES = [
  'find_symbol',
  'find_file',
  'get_callers',
  'get_callees',
  'get_dependencies',
  'get_dependents',
  'find_implementations',
  'git_history',
  'find_by_concept',
  'vector_search_chunks',
  'hybrid_search',
  'search_docs',
  'retrieve_code_chunks',
  'get_summary',
  'walkthrough',
  'list_issues',
  'list_prs',
  'find_similar_issues',
  'find_prs_for_issue',
  'get_project_overview',
  'read_file',
  'tests_for',
  'list_concepts',
  'answer',
] as const

export const OperatorEnum = z.enum(OPERATOR_NAMES)
export type OperatorName = z.infer<typeof OperatorEnum>

export const StepSchema = z.object({
  id: z.string().regex(/^s\d+$/, 'step id must be s<n> (e.g. s1)'),
  op: OperatorEnum,
  /**
   * Per-operator parameters. We validate the *shape* here at the schema
   * level as a free-form record; the executor validates per-op constraints
   * after substituting references.
   */
  params: z.record(z.unknown()),
  comment: z.string().optional(),
})

export const PlanSchema = z.object({
  reasoning: z.string().min(1),
  steps: z.array(StepSchema).min(1).max(15),
})

export type Plan = z.infer<typeof PlanSchema>
export type PlanStep = z.infer<typeof StepSchema>
