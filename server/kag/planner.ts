import { PlanSchema, type Plan } from '#shared/schemas/plan'
import type { LLMProvider } from '../providers/llm'
import { getLogger } from '../lib/logger'

const log = getLogger().child({ component: 'kag/planner' })

const SYSTEM_PROMPT = `You are CodeGraph's query planner. You receive a user question about a codebase and respond ONLY with a single JSON object — a plan whose steps will be executed by a graph engine. No surrounding prose, no markdown fences.

The JSON object MUST have this top-level shape:
{
  "reasoning": "1-3 sentences explaining the strategy",
  "steps": [ { "id": "s1", "op": "operator_name", "params": { ... } }, ... ]
}

## Available operators

- find_symbol({ name, type?, fuzzy?, limit? }) → Entity[]
- find_file({ pathPattern, limit? }) → Entity[]
- get_callers({ target, transitive?, maxDepth?, limit? }) → Entity[]
- get_callees({ source, transitive?, maxDepth?, limit? }) → Entity[]
- get_dependencies({ source | target, transitive?, maxDepth? }) → Entity[]
- get_dependents({ target | source, transitive?, maxDepth? }) → Entity[]
- find_implementations({ interfaceOrType, limit? }) → Entity[]
- git_history({ entity, since?, limit? }) → Commit[]
- find_by_concept({ query, limit? }) → Entity[]   (semantic search over entity descriptions)
- vector_search_chunks({ query, limit? }) → Chunk[]
- hybrid_search({ query, limit? }) → Chunk[]   (across ALL chunks — code, docs, commit messages)
- search_docs({ query, limit? }) → Chunk[]      (restricted to markdown/doc chunks — READMEs, design notes, PR descriptions)
- retrieve_code_chunks({ entities, limit? }) → Chunk[]
- get_summary({ entity }) → { id, name, type, description }[]
- answer({ question, context, style? }) → streaming response with inline citations

## Reference syntax

Refer to a previous step's result with "$s1", "$s2.field", "$s1[0].id".

## Rules

- Always end with an \`answer\` step whose \`context\` is a list of step refs (entities + chunks).
- If the user mentions any identifier that looks like a class/function/type name (CamelCase, snake_case, contains digits, or appears in code), use \`find_symbol\`. Strip surrounding natural-language words from the \`name\` parameter — only the bare identifier. Prefer \`fuzzy: true\` when the name might be embedded in longer qualified names (e.g. "ZodBigInt" → also matches "ZodBigIntDef").
- Use \`find_by_concept\` only when there is no concrete identifier — for genuinely fuzzy semantic queries ("where is discount logic").
- For multi-hop "who calls X transitively" — use get_callers with transitive: true.
- For broad / architectural / "tell me about this project" / "how does X work overall" questions — use \`search_docs\` (covers READMEs, docs/*.md, design notes) as the primary retrieval step, optionally combined with \`hybrid_search\` for code snippets. Bumping limit to 15 is fine on such broad queries.
- The question may be in any language (Russian, Chinese, etc.). Extract identifiers verbatim; do not translate them.
- Keep plans concise: 2-5 steps is usually right.`

const FEW_SHOTS = [
  {
    question: 'Where is the OrderService class defined?',
    plan: {
      reasoning: 'Direct symbol lookup.',
      steps: [
        { id: 's1', op: 'find_symbol', params: { name: 'OrderService', type: 'class' } },
        { id: 's2', op: 'retrieve_code_chunks', params: { entities: '$s1' } },
        {
          id: 's3',
          op: 'answer',
          params: { question: 'Where is OrderService defined?', context: ['$s1', '$s2'] },
        },
      ],
    },
  },
  {
    question: 'Which functions call processPayment directly or transitively?',
    plan: {
      reasoning: 'Resolve target then walk callers transitively.',
      steps: [
        { id: 's1', op: 'find_symbol', params: { name: 'processPayment', type: 'function' } },
        { id: 's2', op: 'get_callers', params: { target: '$s1', transitive: true, maxDepth: 5 } },
        { id: 's3', op: 'get_summary', params: { entity: '$s2' } },
        {
          id: 's4',
          op: 'answer',
          params: {
            question: 'Who calls processPayment transitively?',
            context: ['$s2', '$s3'],
          },
        },
      ],
    },
  },
  {
    question: 'Where is discount logic implemented?',
    plan: {
      reasoning: 'No exact symbol — fall back to concept search.',
      steps: [
        { id: 's1', op: 'find_by_concept', params: { query: 'discount calculation', limit: 10 } },
        { id: 's2', op: 'retrieve_code_chunks', params: { entities: '$s1' } },
        {
          id: 's3',
          op: 'answer',
          params: { question: 'Where is discount logic?', context: ['$s1', '$s2'] },
        },
      ],
    },
  },
  {
    question: 'Tell me about this project.',
    plan: {
      reasoning: 'Broad question — primary signal is docs (README, design notes); add code overview for completeness.',
      steps: [
        {
          id: 's1',
          op: 'search_docs',
          params: { query: 'project overview architecture main features', limit: 15 },
        },
        {
          id: 's2',
          op: 'hybrid_search',
          params: { query: 'main entry points top-level modules', limit: 6 },
        },
        {
          id: 's3',
          op: 'answer',
          params: {
            question: 'Tell me about this project.',
            context: ['$s1', '$s2'],
            style: 'detailed',
          },
        },
      ],
    },
  },
]

function fewShotMessages() {
  const out: { role: 'user' | 'assistant'; content: string }[] = []
  for (const ex of FEW_SHOTS) {
    out.push({ role: 'user', content: ex.question })
    out.push({ role: 'assistant', content: JSON.stringify(ex.plan, null, 2) })
  }
  return out
}

export interface PlanContext {
  /** Lightweight summary of the workspace to ground the planner. */
  workspaceName: string
  languages: string[]
  stats?: Record<string, number>
}

export async function planQuestion(
  llm: LLMProvider,
  question: string,
  ctx: PlanContext,
): Promise<Plan> {
  const userMessage = renderUserMessage(question, ctx)
  try {
    return await llm.structured<Plan>(
      [
        { role: 'system', content: SYSTEM_PROMPT },
        ...fewShotMessages(),
        { role: 'user', content: userMessage },
      ],
      { schema: PlanSchema, schemaName: 'kag_plan' },
    )
  } catch (firstErr) {
    const errMsg = firstErr instanceof Error ? firstErr.message : String(firstErr)
    log.warn(
      { err: errMsg, question: question.slice(0, 200) },
      'planner first attempt failed, retrying with feedback',
    )
    try {
      return await llm.structured<Plan>(
        [
          { role: 'system', content: SYSTEM_PROMPT },
          ...fewShotMessages(),
          { role: 'user', content: userMessage },
          {
            role: 'user',
            content: `Your previous response failed validation: ${errMsg}\nReturn a plan that satisfies the schema exactly. Respond with ONLY a JSON object — no prose. Ensure every step id is "s<N>", every op is one of the listed operators, and references use "$sN" or "$sN.field".`,
          },
        ],
        { schema: PlanSchema, schemaName: 'kag_plan' },
      )
    } catch (secondErr) {
      const secondMsg = secondErr instanceof Error ? secondErr.message : String(secondErr)
      log.error(
        {
          firstErr: errMsg,
          secondErr: secondMsg,
          question: question.slice(0, 200),
        },
        'planner retry failed; falling back to hybrid RAG plan',
      )
      // Final fallback: a deterministic plan that runs hybrid_search + answer.
      return {
        reasoning: 'Planner unavailable; using RAG fallback.',
        steps: [
          {
            id: 's1',
            op: 'hybrid_search',
            params: { query: question, limit: 8 },
          },
          {
            id: 's2',
            op: 'answer',
            params: { question, context: ['$s1'] },
          },
        ],
      }
    }
  }
}

function renderUserMessage(question: string, ctx: PlanContext): string {
  const stats = ctx.stats
    ? `Stats: ${Object.entries(ctx.stats)
        .map(([k, v]) => `${k}=${v}`)
        .join(', ')}`
    : ''
  return [
    `Workspace: ${ctx.workspaceName}`,
    `Languages: ${ctx.languages.join(', ') || 'unknown'}`,
    stats,
    '',
    `Question: ${question}`,
    '',
    'Produce the plan JSON.',
  ]
    .filter(Boolean)
    .join('\n')
}
