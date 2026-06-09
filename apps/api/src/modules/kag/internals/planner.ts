import { PlanSchema, type Plan } from '#shared/schemas/plan'
import type { LLMProvider } from '#server/providers/llm'
import { getLogger } from '#server/lib/logger'
import { plannerFailures } from '#server/lib/metrics'

const log = getLogger().child({ component: 'kag/planner' })

const SYSTEM_PROMPT = `You are RepoBuddy's query planner. You receive a user question about a codebase and respond ONLY with a single JSON object — a plan whose steps will be executed by a graph engine. No surrounding prose, no markdown fences.

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
- walkthrough({ entity, limit? }) → { entity, callees, tests, parents }[]   (entity-centric tour: direct callees + tests covering it + enclosing parent)
- list_issues({ labels?, state?, limit?, issueNumber? }) → { issues: { number, title, url, labels, bodyExcerpt, updatedAt, relatedEntities[] }[], relatedChunks: Chunk[] }   (open GitHub issues from the workspace's source repo, ALREADY LINKED to indexed code via relatedEntities + relatedChunks. Use issueNumber to focus a single issue; otherwise lists up to the configured limit of open issues)
- list_prs({ state?, labels?, limit?, prNumber? }) → { prs: PR[] }   (GitHub pull requests; each PR carries referencedIssues parsed from "fixes #N" / "closes #N" in body. Use to find "how was a similar issue fixed", look up specific PR by number, or browse recent work)
- find_similar_issues({ issueNumber?, query?, limit? }) → { similar: { number, title, url, similarity, state, bodyExcerpt, labels }[] }   (embedding-cosine similarity over recent issues. Pass issueNumber to find "issues like this one" or query for free-text. Crucial for "has someone already reported this", "any duplicates", or building a precedent before working on an issue)
- find_prs_for_issue({ issueNumber, limit? }) → PrSummary[]   (graph-indexed: merged PRs whose body referenced this issue via "fixes #N" / "closes #N". Answers "how was this issue fixed before", or finds the actual fix-PR for an open issue that already has a candidate PR. Returns empty if PR-history hasn't been indexed yet)
- find_resolution({ issueNumber }) → { status, confidence, mergedByCommits, linkedPullRequests, duplicateCandidates }   (CALL FIRST when the user asks about a specific open issue. Detects if the issue is already solved or being solved: scans indexed commits for "fixes #N", live-searches GitHub PRs (any state, incl. DRAFT) that reference #N, and cosine-similar closed issues. Returns a status bucket: merged | open_pr | draft_pr | stale_pr | duplicate_closed | related | none. If status != 'none', frame the answer around the existing resolution ("already fixed in <sha>, pull latest" / "draft PR #X — great contributor entry point") instead of investigating the bug from scratch)
- get_project_overview({}) → { entrypoints, coreAbstractions, goodFirstIssues, hotFiles, stats }   (snapshot of the whole workspace — main entrypoints, classes/functions everything depends on, hot files, safe-first-PR zones, entity-type stats. Use for broad orientation questions or as a first step before diving deeper)
- read_file({ path, limit? }) → { filePath, chunks: Chunk[] }[]   (verbatim file contents. Matches by exact path or path-suffix — pass "tsconfig.json" or "src/index.ts". Use when you know the file you need and just want its text without going through entity lookup)
- tests_for({ entity, limit? }) → Entity[]   (test files that cover the given entity via the tested_by relation. Use for "what tests should I run if I change X", "что сломается", "impact analysis")
- list_concepts({ query?, limit? }) → Entity[]   (project's domain glossary — concept / pattern / decision entities from the LLM annotation step. Use for "what does <jargon term> mean in this project", or to seed orientation when the user is parsing project-specific issue language)
- web_search({ query, limit? }) → { results: { title, url, snippet }[] }   (open-web search via DuckDuckGo. Use AGGRESSIVELY for framework/library behaviour, error messages, version differences, RFCs, blog posts, Stack Overflow. The indexed repo never contains upstream docs — anything about Nuxt, React, Vue, Django etc. needs this)
- web_fetch({ url }) → { url, title, markdown, truncated }   (fetch a URL, strip chrome, return Markdown ~12K chars. Use to expand a promising web_search result, or to read a URL the user pasted)
- propose_edit({ filePath, search, replace, rationale? }) → { resolvedPath, diff, rationale }   (build a unified-diff hunk for a single-occurrence edit. The user sees the diff inline and can apply it themselves. Use when the user asks "how would you fix this" or "suggest a patch". Always include the search context — never propose blank-search "rewrite the file")
- answer({ question, context, style? }) → streaming response with inline citations

## Reference syntax

Refer to a previous step's result with "$s1", "$s2.field", "$s1[0].id".

## Rules

- Always end with an \`answer\` step whose \`context\` is a list of step refs (entities + chunks).
- If the user mentions any identifier that looks like a class/function/type name (CamelCase, snake_case, contains digits, or appears in code), use \`find_symbol\`. Strip surrounding natural-language words from the \`name\` parameter — only the bare identifier. Prefer \`fuzzy: true\` when the name might be embedded in longer qualified names (e.g. "ZodBigInt" → also matches "ZodBigIntDef").
- For "list / enumerate all X" questions (functions, classes, files, types, modules — no specific identifier), call \`find_symbol\` with ONLY the \`type\` parameter set (no \`name\`). It returns up to \`limit\` entities of that type. Pair with \`get_summary\` to surface their LLM-generated descriptions. Bumping limit to 30-50 is fine for these.
- Use \`find_by_concept\` only when there is no concrete identifier — for genuinely fuzzy semantic queries ("where is discount logic").
- For multi-hop "who calls X transitively" — use get_callers with transitive: true.
- For broad / architectural / "tell me about this project" / "how does X work overall" / "what does this repo do" / "что это за проект" questions — START with \`get_project_overview\` (entrypoints + core abstractions + hot files + stats). Combine with \`search_docs\` for README context and optionally \`hybrid_search\` for code snippets. The overview lifts core abstractions into the entity context automatically, so the answer can cite them directly.
- For "walk me through X" / "how does X work" / "explain X step by step" / "проведи меня по X" — first resolve X via find_symbol, then use \`walkthrough\` to gather callees + tests + parent, then retrieve_code_chunks of those for the answer.
- For "are there any issues" / "what can I work on" / "good first issues" / "что можно поделать" / "есть issues" / "what's open" — call \`list_issues\` (optionally with labels like ["good first issue", "help wanted"]). Pass the returned envelope to \`answer\`. The operator already linked relatedEntities + relatedChunks, so the answer can ground in real code.
- For a SPECIFIC issue ("I want to work on issue #42", "issue #191", "помоги с #42") — call \`list_issues\` with \`issueNumber: 42\` (no labels). The operator returns relatedEntities + relatedChunks but for issue-resolution questions you should ALWAYS expand further — pick 2-3 top relatedEntities and run \`walkthrough\` on the entity-shaped ones (functions, classes) AND \`get_callers\` to surface who depends on each, then \`retrieve_code_chunks\` on every entity gathered (initial + walkthrough + callers). The answer step then has the issue text + its direct linked code + the callers + the walkthrough — enough to actually recommend a starting point and a fix, not just point back to GitHub.
  When relatedEntities is empty AND the issue body contains identifiers worth chasing, fall back to \`find_symbol\` / \`hybrid_search\` on those identifiers before the answer step.
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
    question: 'Walk me through how processOrder works.',
    plan: {
      reasoning: 'Walkthrough request — resolve symbol, gather its callees + tests + parent, then retrieve the code for the answer.',
      steps: [
        { id: 's1', op: 'find_symbol', params: { name: 'processOrder', type: 'function' } },
        { id: 's2', op: 'walkthrough', params: { entity: '$s1', limit: 12 } },
        { id: 's3', op: 'retrieve_code_chunks', params: { entities: '$s1' } },
        {
          id: 's4',
          op: 'answer',
          params: {
            question: 'Walk me through how processOrder works.',
            context: ['$s1', '$s2', '$s3'],
            style: 'detailed',
          },
        },
      ],
    },
  },
  {
    question: 'What functions and classes are in this project?',
    plan: {
      reasoning: 'Open-ended enumeration — list entities by type via find_symbol with no name, summarise to surface descriptions.',
      steps: [
        { id: 's1', op: 'find_symbol', params: { type: 'function', limit: 40 } },
        { id: 's2', op: 'find_symbol', params: { type: 'class', limit: 25 } },
        { id: 's3', op: 'get_summary', params: { entity: '$s1' } },
        { id: 's4', op: 'get_summary', params: { entity: '$s2' } },
        {
          id: 's5',
          op: 'answer',
          params: {
            question: 'What functions and classes are in this project?',
            context: ['$s1', '$s2', '$s3', '$s4'],
            style: 'detailed',
          },
        },
      ],
    },
  },
  {
    question: 'Tell me about this project.',
    plan: {
      reasoning: 'Broad orientation question — start with get_project_overview for structured signals (entrypoints + core abstractions + hot files + stats), add docs for narrative context, end with answer.',
      steps: [
        { id: 's1', op: 'get_project_overview', params: {} },
        {
          id: 's2',
          op: 'search_docs',
          params: { query: 'project overview architecture main features', limit: 12 },
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
  {
    question: 'Are there any open issues I could pick up?',
    plan: {
      reasoning: 'Asking about open GitHub issues — list_issues is the only operator that reaches outside the indexed graph to fetch them.',
      steps: [
        { id: 's1', op: 'list_issues', params: { labels: ['good first issue', 'help wanted'], limit: 15 } },
        {
          id: 's2',
          op: 'answer',
          params: {
            question: 'Are there any open issues I could pick up?',
            context: ['$s1'],
          },
        },
      ],
    },
  },
  {
    question: 'I want to work on issue #42 — where do I start in the code?',
    plan: {
      reasoning: 'Specific issue resolution — fetch it, then expand the top relatedEntities (walkthrough + callers) so the answer can ground in real code, not just point back to GitHub.',
      steps: [
        { id: 's1', op: 'list_issues', params: { issueNumber: 42 } },
        { id: 's2', op: 'walkthrough', params: { entity: '$s1.issues[0].relatedEntities', limit: 8 } },
        { id: 's3', op: 'get_callers', params: { target: '$s1.issues[0].relatedEntities', transitive: false, limit: 12 } },
        { id: 's4', op: 'retrieve_code_chunks', params: { entities: '$s3' } },
        {
          id: 's5',
          op: 'answer',
          params: {
            question: 'I want to work on issue #42 — where do I start in the code?',
            context: ['$s1', '$s2', '$s3', '$s4'],
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
      plannerFailures.inc()
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
