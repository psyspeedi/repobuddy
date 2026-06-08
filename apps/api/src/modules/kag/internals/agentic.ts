/**
 * Agentic tool-use chat loop. The LLM is given KAG operators as
 * OpenAI function-calling tools and decides at runtime which to
 * invoke, in what order, until it can produce a final grounded
 * answer (or hits a budget).
 *
 * Contract:
 *   for await (const evt of runAgenticAnswer(...)) {
 *     evt.type === 'text'      → append to streamed response body
 *     evt.type === 'tool_step' → trace metadata (op, params, summary)
 *     evt.type === 'done'      → totals (tokens, iterations)
 *   }
 *
 * Cost / latency knobs:
 *   - maxIterations: hard ceiling on tool-call rounds. Default 8.
 *   - maxTokens: cumulative budget across all turns. Default 80k input + 8k output.
 *
 * The loop is intentionally simple — there's no planner step, no
 * retry-with-feedback, no plan validation. The model owns control
 * flow. We just dispatch tools and append results.
 */
import type { OperatorContext } from './operators'
import { OPERATORS, type OperatorName } from './operators'
import type {
  ChatMessage,
  LLMProvider,
  ToolCall,
  ToolDefinition,
} from '../../providers/internals/llm'
import { getLogger } from '../../../lib/logger'

const log = getLogger().child({ component: 'kag/agentic' })

export interface AgenticEvent {
  type: 'text' | 'tool_step' | 'done'
  text?: string
  toolStep?: {
    iteration: number
    name: string
    args: Record<string, unknown>
    summary: string
    durationMs: number
    error?: string
    /**
     * For a small whitelist of operators whose output the UI renders
     * directly (currently: find_resolution → ChatResolutionBanner),
     * pass the structured envelope through alongside the human-
     * readable summary. We don't put every tool result here — that
     * would balloon the SSE stream — only ones with a dedicated
     * client-side renderer.
     */
    result?: unknown
  }
  inputTokens?: number
  outputTokens?: number
  iterations?: number
}

/** Tools whose result envelope is forwarded to the client for direct rendering. */
const TOOL_RESULTS_SURFACED_TO_UI = new Set<string>(['find_resolution'])

export interface AgenticOptions {
  history?: ChatMessage[]
  maxIterations?: number
  responseLocale?: 'en' | 'ru'
  /**
   * When true, the loop runs ONE critic pass right before the agent
   * would have exited (no-tool-call turn). The critic gets the
   * question + the proposed answer and either replies "OK" or lists
   * concrete gaps; if it lists gaps, those are appended as a system
   * nudge and the loop runs one more round of tool calls. Adds ~1
   * LLM call per question — caller flips this on for hard / vague
   * questions, off for cheap factual ones.
   */
  selfCritique?: boolean
}

const SYSTEM_PROMPT_EN = `You are RepoBuddy, a coding agent for open-source contribution.

You are NOT a Q&A bot. Behave like Claude Code: investigate
aggressively before answering, surface concrete code paths, and
propose specific actionable fixes rather than generic advice.

You answer questions by calling tools that traverse the indexed
repo (entities, chunks, GitHub issues, project overview) AND by
calling web_search / web_fetch to bring in upstream framework /
library docs, error-message lookups, RFCs, blog posts, Stack
Overflow. Anything about Nuxt / React / Vue / Django / a specific
library version that is NOT in the indexed repo MUST come from a
web call — do not answer from memory on framework behaviour.

How to think:
1. For broad questions ("tell me about", "where do I start") start with
   get_project_overview — cheap and gives entry points + core abstractions.
2. For "how does X work" first find_symbol the identifier, then walkthrough
   the entity to see callees / tests / parent.
3. For "who calls X" use get_callers with transitive: true.
4. For "issue #N" ALWAYS call find_resolution({issueNumber:N}) FIRST in
   parallel with list_issues({issueNumber:N}). If find_resolution returns
   status != "none", frame the answer around the resolution — "fixed in
   <sha>, pull latest" (merged), "draft PR #X by @author is mid-flight,
   finishing it would be a great contribution" (draft_pr), "looks like
   a duplicate of #M (closed)" (duplicate_closed). Do NOT investigate
   the bug from scratch when an existing resolution exists.
5. If you know the file you need, call read_file({path}) DIRECTLY — don't
   try to find_symbol first. read_file matches by suffix, so 'tsconfig.json'
   or 'src/index.ts' both work. Use this aggressively: a typical issue
   resolution needs to read 2-4 specific files (config + the file the
   issue is about + a test file) — call read_file on each in parallel.
6. If retrieve_code_chunks comes back empty for an entity, FALLBACK to
   read_file with that entity's filePath — sometimes the entity_chunks
   join is sparse but the chunk exists.
7. If the user's question contains a unified diff (lines starting with
   "diff --git", "---", "+++", "@@"), treat it as a change-set under
   review. Read every touched file with read_file in parallel, then
   tests_for on the changed entities to flag missing test coverage.
   Final answer must list (a) what the diff does, (b) which callers /
   tests are affected, (c) risks, (d) a concrete follow-up step.
8. When the question touches a FRAMEWORK or LIBRARY behaviour
   (Nuxt SSR vs static, React hook semantics, Django ORM behaviour,
   third-party library API), call web_search FIRST with the specific
   query, then web_fetch the most authoritative result (official docs >
   library README on GitHub > Stack Overflow answer > blog post). Cite
   the URL inline in the final answer with markdown link form. Without
   a web call your answer to framework questions is a guess.
9. When the user asks "how would you fix this" / "suggest a patch" /
   "what should I change" — call propose_edit with the exact search
   string from the file you just read. The unified diff renders in the
   chat. Do not just describe the change in prose when you can propose
   a concrete patch.
10. Before you stop calling tools, ask yourself: am I about to give
    generic advice that doesn't cite a specific file / line / URL? If
    yes, dig deeper — web_search, read_file, walkthrough, anything to
    ground the answer. Generic advice is a failure mode.
11. When you have enough GROUNDED context to answer, STOP calling tools
    and write the final answer.

Citation rules in the final answer:
- For code claims, cite the chunk: [chunk:UUID] (UUIDs from chunk results).
- For graph entities, cite [entity:UUID].
- For GitHub issues, link [#N](url). Never wrap an issue number in
  [entity:...] or [chunk:...].
- If context is insufficient, say so plainly. Do not fabricate.

Budget: max 16 tool calls per question. Plan accordingly. web_search +
web_fetch each cost one call.`

const SYSTEM_PROMPT_RU = `Ты — RepoBuddy, coding-agent для контрибьюции в OSS.

Ты НЕ Q&A-бот. Веди себя как Claude Code: исследуй агрессивно
до ответа, показывай конкретные пути в коде, предлагай конкретные
патчи а не общие советы.

Отвечай используя tools — операторы по индексированному репо
(сущности, chunks, GitHub issues) И web_search / web_fetch для
upstream-документации framework'ов / библиотек, поиска по
сообщениям ошибок, RFC, блогам, Stack Overflow. Любой вопрос про
Nuxt / React / Vue / Django / поведение конкретной версии
библиотеки которое НЕ в индексированном репо — ОБЯЗАН пройти через
web-вызов. Не отвечай по памяти про поведение framework'ов.

Как мыслить:
1. Широкие вопросы ("расскажи о", "с чего начать") — начинай с
   get_project_overview, дёшево и сразу видны точки входа.
2. "Как работает X" — сначала find_symbol по имени, затем walkthrough
   для callees / tests / parent.
3. "Кто вызывает X" — get_callers с transitive: true.
4. "issue #N" — ВСЕГДА сначала find_resolution({issueNumber:N})
   параллельно с list_issues({issueNumber:N}). Если find_resolution
   вернул status != "none", стройте ответ ВОКРУГ найденной резолюции —
   «уже починили в <sha>, обнови» (merged), «черновой PR #X от @author
   в процессе — дописать тесты и снять draft будет отличным вкладом»
   (draft_pr), «похоже на дубликат #M (closed)» (duplicate_closed).
   НЕ расследуйте баг с нуля если резолюция уже найдена. Если
   resolution.status == "none" и list_issues.relatedEntities непуст —
   разверните 2-3 верхних через walkthrough + get_callers +
   retrieve_code_chunks перед финальным ответом.
5. Если вопрос содержит unified diff (строки "diff --git", "---", "+++",
   "@@"), это change-set на ревью. Прочитай каждый затронутый файл
   через read_file параллельно, затем tests_for на изменённых сущностях
   для проверки покрытия тестами. Финальный ответ ОБЯЗАН содержать:
   (а) что делает diff, (б) каких callers / tests затронет, (в) риски,
   (г) конкретный следующий шаг.
6. Когда вопрос про поведение FRAMEWORK'а или ЛИБЫ (Nuxt SSR vs static,
   React hook semantics, поведение ORM в Django, API третьесторонней
   либы) — СНАЧАЛА web_search с конкретным запросом, затем web_fetch
   самого авторитетного результата (официальная документация > README
   либы на GitHub > Stack Overflow ответ > блог). В финальном ответе
   цитируй URL через markdown-ссылку. Без web-вызова ответ на
   framework-вопрос — это догадка.
7. Когда юзер просит "как ты это починишь" / "предложи патч" / "что
   нужно поменять" — вызывай propose_edit с точной search-строкой из
   файла который только что прочитал. Unified diff отрисуется в чате.
   Не описывай изменение прозой когда можешь предложить конкретный патч.
8. Перед тем как остановить вызовы — спроси себя: я сейчас собираюсь
   дать общий совет без ссылки на конкретный файл / строку / URL? Если
   да, копай дальше — web_search, read_file, walkthrough, что угодно
   чтобы заземлить ответ. Общий совет — failure mode.
9. Когда GROUNDED-контекста достаточно — ОСТАНОВИСЬ и пиши ответ.

Правила цитирования в финальном ответе:
- Утверждения о коде → [chunk:UUID] (UUID берётся из результатов tool).
- Сущности графа → [entity:UUID].
- GitHub issues → [#N](url). НЕ заворачивай номер issue в [entity:...]
  или [chunk:...] — там только UUID.
- Если контекста не хватает — скажи прямо. Не выдумывай.

Бюджет: максимум 16 вызовов tools на вопрос. web_search + web_fetch
тоже считаются.

Полезно знать: read_file({path}) открывает файл буквально (suffix-match,
'tsconfig.json' работает). Используй агрессивно — для разбора issue
обычно нужно прочитать 2-4 конкретных файла (конфиг + основной + тест).`

const LANGUAGE_INSTRUCTION_EN = 'Always respond in English.'
const LANGUAGE_INSTRUCTION_RU = 'Always respond in Russian (русский).'

// Subset of operators exposed as tools. `answer` is excluded — the LLM
// generates the final answer inline when it stops calling tools.
//
// Typed as a Record keyed by ToolOperatorName so adding an operator
// (touching OPERATOR_NAMES in shared/schemas/plan.ts) becomes a
// compile-error here until a tool def is added. Single source of
// truth: the OPERATOR_NAMES tuple drives everything downstream.
type ToolOperatorName = Exclude<OperatorName, 'answer'>
const TOOL_DEFS_MAP: Record<ToolOperatorName, Omit<ToolDefinition, 'name'>> = {
  get_project_overview: {
    description: 'Snapshot of the workspace: entrypoints, top-fanout classes/functions, hot files, safe-first-PR zones, and entity-type stats. Call at the start of broad orientation questions.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
  },
  find_symbol: {
    description: 'Locate entities by name. Use the bare identifier (e.g. "OrderService", not "the OrderService class"). Set fuzzy: true if the name might be a substring. Omit name and pass only type to enumerate entities of a kind.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Identifier to look up' },
        type: { type: 'string', description: "Optional filter: 'class' | 'function' | 'type' | 'file' | 'module' | …" },
        fuzzy: { type: 'boolean' },
        limit: { type: 'integer', minimum: 1, maximum: 50 },
      },
      additionalProperties: false,
    },
  },
  find_file: {
    description: 'Find file entities by path glob/substring (e.g. "src/auth/login.ts").',
    parameters: {
      type: 'object',
      properties: {
        pathPattern: { type: 'string' },
        limit: { type: 'integer', minimum: 1, maximum: 30 },
      },
      required: ['pathPattern'],
      additionalProperties: false,
    },
  },
  get_callers: {
    description: 'Entities that call a target. Set transitive: true and maxDepth to walk multiple hops. Pass either a single entity or an array.',
    parameters: {
      type: 'object',
      properties: {
        target: { description: 'Entity or array of entities returned by find_symbol / walkthrough' },
        transitive: { type: 'boolean' },
        maxDepth: { type: 'integer', minimum: 1, maximum: 6 },
        limit: { type: 'integer', minimum: 1, maximum: 50 },
      },
      required: ['target'],
      additionalProperties: false,
    },
  },
  get_callees: {
    description: 'Entities called from a source.',
    parameters: {
      type: 'object',
      properties: {
        source: { description: 'Entity or array of entities' },
        transitive: { type: 'boolean' },
        maxDepth: { type: 'integer', minimum: 1, maximum: 6 },
        limit: { type: 'integer', minimum: 1, maximum: 50 },
      },
      required: ['source'],
      additionalProperties: false,
    },
  },
  get_dependencies: {
    description: 'Modules / files that the source imports or depends on.',
    parameters: {
      type: 'object',
      properties: {
        source: { description: 'Entity or array' },
        transitive: { type: 'boolean' },
        maxDepth: { type: 'integer', minimum: 1, maximum: 6 },
      },
      additionalProperties: false,
    },
  },
  get_dependents: {
    description: 'Reverse of get_dependencies — modules / files that depend on the target.',
    parameters: {
      type: 'object',
      properties: {
        target: { description: 'Entity or array' },
        transitive: { type: 'boolean' },
        maxDepth: { type: 'integer', minimum: 1, maximum: 6 },
      },
      additionalProperties: false,
    },
  },
  find_implementations: {
    description: 'Concrete classes implementing a given interface / abstract type.',
    parameters: {
      type: 'object',
      properties: {
        interfaceOrType: { description: 'Interface or type entity' },
        limit: { type: 'integer', minimum: 1, maximum: 30 },
      },
      required: ['interfaceOrType'],
      additionalProperties: false,
    },
  },
  walkthrough: {
    description: 'Around a target entity: direct callees + tests covering it + enclosing parent. Use when the user asks "how does X work" or "walk me through X".',
    parameters: {
      type: 'object',
      properties: {
        entity: { description: 'Single entity or array' },
        limit: { type: 'integer', minimum: 1, maximum: 30 },
      },
      required: ['entity'],
      additionalProperties: false,
    },
  },
  retrieve_code_chunks: {
    description: 'Fetch the source-code chunks for a set of entities. Always call this before the final answer when you need to reason about implementation details.',
    parameters: {
      type: 'object',
      properties: {
        entities: { description: 'Array of entities (from find_symbol / walkthrough / callers)' },
        limit: { type: 'integer', minimum: 1, maximum: 30 },
      },
      required: ['entities'],
      additionalProperties: false,
    },
  },
  get_summary: {
    description: 'LLM-generated short description of an entity (from the annotation step). Cheap; useful when you need a label for an unfamiliar symbol.',
    parameters: {
      type: 'object',
      properties: {
        entity: { description: 'Entity or array' },
      },
      required: ['entity'],
      additionalProperties: false,
    },
  },
  hybrid_search: {
    description: 'Semantic + full-text search across all chunks (code, docs, commit messages). Use for fuzzy "where is X handled" questions when no specific symbol name applies.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        limit: { type: 'integer', minimum: 1, maximum: 20 },
      },
      required: ['query'],
      additionalProperties: false,
    },
  },
  vector_search_chunks: {
    description: 'Pure-vector semantic search over chunks. Prefer hybrid_search unless you specifically want vector-only ranking (e.g. cross-language similarity).',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        limit: { type: 'integer', minimum: 1, maximum: 20 },
      },
      required: ['query'],
      additionalProperties: false,
    },
  },
  search_docs: {
    description: 'Full-text + semantic search restricted to markdown / doc chunks (READMEs, design notes). Use for broad architectural questions.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        limit: { type: 'integer', minimum: 1, maximum: 20 },
      },
      required: ['query'],
      additionalProperties: false,
    },
  },
  find_by_concept: {
    description: 'Semantic similarity search over entity descriptions (LLM-annotated). Use for "where is discount logic" style fuzzy queries.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        limit: { type: 'integer', minimum: 1, maximum: 20 },
      },
      required: ['query'],
      additionalProperties: false,
    },
  },
  list_issues: {
    description: 'Open GitHub issues from the workspace repo. Pass issueNumber to focus a single issue; otherwise lists open issues filtered by labels. The result includes relatedEntities + relatedChunks already linked to indexed code — you can expand those with walkthrough / get_callers if needed.',
    parameters: {
      type: 'object',
      properties: {
        issueNumber: { type: 'integer', minimum: 1 },
        labels: { type: 'array', items: { type: 'string' } },
        state: { type: 'string', enum: ['open', 'closed', 'all'] },
        limit: { type: 'integer', minimum: 1, maximum: 30 },
      },
      additionalProperties: false,
    },
  },
  git_history: {
    description: 'Recent commits touching a file or entity (author, date, message, file list).',
    parameters: {
      type: 'object',
      properties: {
        entity: { description: 'Entity to inspect' },
        since: { type: 'string', description: 'ISO date lower bound' },
        limit: { type: 'integer', minimum: 1, maximum: 50 },
      },
      required: ['entity'],
      additionalProperties: false,
    },
  },
  read_file: {
    description: "Open a file VERBATIM by path. Pass the path as you know it ('tsconfig.json', 'src/index.ts', 'package.json') — the operator matches by exact path OR path-suffix. Use this when you know which file you need. Returns the file's chunks; cite chunks by [chunk:UUID] in the final answer.",
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        limit: { type: 'integer', minimum: 1, maximum: 20 },
      },
      required: ['path'],
      additionalProperties: false,
    },
  },
  tests_for: {
    description: 'Test files / test entities that cover a given entity (function, class, file) via the tested_by relation. Use for impact analysis: "if I change X, which tests should I run", "что сломается если я поменяю Y".',
    parameters: {
      type: 'object',
      properties: {
        entity: { description: 'Entity or array of entities returned by find_symbol / walkthrough' },
        limit: { type: 'integer', minimum: 1, maximum: 50 },
      },
      required: ['entity'],
      additionalProperties: false,
    },
  },
  list_concepts: {
    description: "Project's domain glossary — concept / pattern / decision entities derived by the LLM annotation step (project-specific jargon, recurring patterns, design decisions). Use when the user is parsing project-specific language or asks 'what does <jargon> mean here'.",
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Substring filter over name / description (optional)' },
        limit: { type: 'integer', minimum: 1, maximum: 50 },
      },
      additionalProperties: false,
    },
  },
  list_prs: {
    description: 'GitHub pull requests from the workspace repo. Each PR includes referencedIssues parsed from "fixes #N" / "closes #N" in the body — use to find "how was a similar issue fixed" by scanning PR titles + linked issues. Pass prNumber for a single PR.',
    parameters: {
      type: 'object',
      properties: {
        state: { type: 'string', enum: ['open', 'closed', 'all'] },
        labels: { type: 'array', items: { type: 'string' } },
        limit: { type: 'integer', minimum: 1, maximum: 30 },
        prNumber: { type: 'integer', minimum: 1 },
      },
      additionalProperties: false,
    },
  },
  find_similar_issues: {
    description: 'Embedding-cosine search over recent issues. Pass issueNumber to find "issues like this one" before working on it (catches duplicates and precedents) — or pass a free-text query. Returns top-K with similarity scores.',
    parameters: {
      type: 'object',
      properties: {
        issueNumber: { type: 'integer', minimum: 1 },
        query: { type: 'string' },
        limit: { type: 'integer', minimum: 1, maximum: 10 },
      },
      additionalProperties: false,
    },
  },
  find_prs_for_issue: {
    description: 'Graph-indexed: merged PRs whose body referenced the given issue via "fixes #N" / "closes #N". Use when the user asks "how was this fixed", "is there already a PR for this", or to find a precedent before working on a similar issue.',
    parameters: {
      type: 'object',
      properties: {
        issueNumber: { type: 'integer', minimum: 1 },
        limit: { type: 'integer', minimum: 1, maximum: 30 },
      },
      required: ['issueNumber'],
      additionalProperties: false,
    },
  },
  find_resolution: {
    description: 'CALL FIRST for any "issue #N" question. Detects whether the issue is ALREADY solved or being solved elsewhere — scans indexed commits for "fixes #N" / "closes #N", live-searches GitHub PRs (any state, including DRAFT) that reference #N, and finds cosine-similar closed issues. Returns { status: merged | open_pr | draft_pr | stale_pr | duplicate_closed | related | none, confidence, mergedByCommits, linkedPullRequests, duplicateCandidates }. If status != "none", frame the answer around the existing resolution INSTEAD of investigating the bug from scratch — e.g. "already merged in <sha>, pull latest", or "draft PR #X by @author is mid-flight — finishing the work would be a great contribution".',
    parameters: {
      type: 'object',
      properties: {
        issueNumber: { type: 'integer', minimum: 1 },
      },
      required: ['issueNumber'],
      additionalProperties: false,
    },
  },
  web_search: {
    description: 'Open-web search via DuckDuckGo. USE AGGRESSIVELY for anything outside the indexed repo: framework behaviour (Nuxt, React, Django), library API questions, error-message lookups, version diffs, RFCs, blog posts, Stack Overflow. Returns up to `limit` { title, url, snippet } results — pass the most promising url to web_fetch to read the full content.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        limit: { type: 'integer', minimum: 1, maximum: 10 },
      },
      required: ['query'],
      additionalProperties: false,
    },
  },
  web_fetch: {
    description: 'Fetch a URL, strip chrome, return the main content as Markdown (~12K chars max). Use to read a web_search hit in depth, or to follow a URL pasted by the user or referenced in an issue body. Do not pass URLs to your own previously-generated text.',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string' },
      },
      required: ['url'],
      additionalProperties: false,
    },
  },
  propose_edit: {
    description: 'Propose a concrete edit to a file as a unified diff. The server does NOT apply anything — the diff renders inline for the user. Use when the user asks "how would you fix this" or "suggest a patch" or "what change should I make". Always read the file first (read_file or retrieve_code_chunks) so the search string matches verbatim. Include a short rationale.',
    parameters: {
      type: 'object',
      properties: {
        filePath: { type: 'string', description: 'Path as you know it — exact or path-suffix' },
        search: { type: 'string', description: 'Exact text in the file to replace (must occur once)' },
        replace: { type: 'string', description: 'New text' },
        rationale: { type: 'string', description: 'One-sentence why' },
      },
      required: ['filePath', 'search', 'replace'],
      additionalProperties: false,
    },
  },
}

// Materialise the array form (with name) once for the OpenAI SDK.
const TOOL_DEFS: ToolDefinition[] = Object.entries(TOOL_DEFS_MAP).map(([name, def]) => ({
  name,
  ...def,
}))

/** Operators NOT exposed as tools (only the planner / executor calls them). */
const TOOL_NAMES = new Set<OperatorName>(Object.keys(TOOL_DEFS_MAP) as OperatorName[])

export async function* runAgenticAnswer(
  llm: LLMProvider,
  ctx: OperatorContext,
  question: string,
  opts: AgenticOptions = {},
): AsyncGenerator<AgenticEvent> {
  const maxIterations = opts.maxIterations ?? 12
  const langName = opts.responseLocale === 'ru' ? LANGUAGE_INSTRUCTION_RU : LANGUAGE_INSTRUCTION_EN
  const systemPrompt = opts.responseLocale === 'ru' ? SYSTEM_PROMPT_RU : SYSTEM_PROMPT_EN

  const wsHint = ctx.workspace
    ? `Workspace: ${ctx.workspace.name}; languages: ${ctx.workspace.languages.join(', ')}.`
    : ''

  const messages: ChatMessage[] = [
    { role: 'system', content: `${systemPrompt}\n\n${langName}\n\n${wsHint}` },
    ...(opts.history ?? []),
    { role: 'user', content: question },
  ]

  let totalInput = 0
  let totalOutput = 0
  let iteration = 0
  let critiqued = false

  while (iteration < maxIterations) {
    iteration += 1
    let assistantText = ''
    let pendingToolCalls: ToolCall[] | null = null
    let lastInput = 0
    let lastOutput = 0

    for await (const evt of llm.streamWithTools(messages, TOOL_DEFS, { temperature: 0.2 })) {
      if (evt.type === 'text' && evt.text) {
        assistantText += evt.text
        yield { type: 'text', text: evt.text }
      } else if (evt.type === 'tool_call') {
        pendingToolCalls = evt.toolCalls ?? null
      } else if (evt.type === 'done') {
        lastInput = evt.inputTokens ?? 0
        lastOutput = evt.outputTokens ?? 0
        totalInput += lastInput
        totalOutput += lastOutput
      }
    }

    if (!pendingToolCalls || pendingToolCalls.length === 0) {
      // No tool calls this turn → the model thinks it's done. If
      // self-critique is on and we haven't already run it, give the
      // answer one independent review pass and force another round
      // if the critic flags gaps.
      if (opts.selfCritique && !critiqued && iteration < maxIterations) {
        critiqued = true
        const verdict = await runCritic(llm, question, assistantText, opts.responseLocale === 'ru')
        if (verdict.kind === 'gaps') {
          messages.push({ role: 'assistant', content: assistantText })
          const nudge = opts.responseLocale === 'ru'
            ? `Внутренний ревьюер нашёл пробелы в твоём ответе. Закрой их (вызови инструменты, если нужно) перед финальным ответом:\n${verdict.gaps}`
            : `An internal reviewer flagged gaps in your answer. Close them (call tools if needed) before the final answer:\n${verdict.gaps}`
          messages.push({ role: 'system', content: nudge })
          totalInput += verdict.inputTokens
          totalOutput += verdict.outputTokens
          continue
        }
      }
      yield {
        type: 'done',
        inputTokens: totalInput,
        outputTokens: totalOutput,
        iterations: iteration,
      }
      return
    }

    // Add the assistant turn (text + tool calls) and dispatch each
    // tool. Append one tool message per call so the LLM's next turn
    // can match by tool_call_id.
    messages.push({
      role: 'assistant',
      content: assistantText,
      tool_calls: pendingToolCalls,
    })

    for (const call of pendingToolCalls) {
      const start = Date.now()
      let parsed: Record<string, unknown> = {}
      try {
        parsed = call.arguments ? JSON.parse(call.arguments) as Record<string, unknown> : {}
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err)
        const summary = `error: invalid JSON args (${errMsg})`
        messages.push({
          role: 'tool',
          tool_call_id: call.id,
          content: JSON.stringify({ error: summary }),
        })
        yield {
          type: 'tool_step',
          toolStep: { iteration, name: call.name, args: {}, summary, durationMs: Date.now() - start, error: summary },
        }
        continue
      }

      const opName = call.name as OperatorName
      if (!TOOL_NAMES.has(opName) || !(opName in OPERATORS)) {
        const summary = `error: unknown tool ${call.name}`
        messages.push({
          role: 'tool',
          tool_call_id: call.id,
          content: JSON.stringify({ error: summary }),
        })
        yield {
          type: 'tool_step',
          toolStep: { iteration, name: call.name, args: parsed, summary, durationMs: Date.now() - start, error: summary },
        }
        continue
      }

      try {
        const op = OPERATORS[opName] as (p: unknown, c: OperatorContext) => Promise<unknown>
        const result = await op(parsed, ctx)
        const trimmed = trimToolResult(result)
        messages.push({
          role: 'tool',
          tool_call_id: call.id,
          content: JSON.stringify(trimmed),
        })
        yield {
          type: 'tool_step',
          toolStep: {
            iteration,
            name: call.name,
            args: parsed,
            summary: describeResult(trimmed),
            durationMs: Date.now() - start,
            ...(TOOL_RESULTS_SURFACED_TO_UI.has(call.name) ? { result: trimmed } : {}),
          },
        }
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err)
        log.warn({ tool: call.name, args: parsed, err: errMsg }, 'agentic tool call failed')
        messages.push({
          role: 'tool',
          tool_call_id: call.id,
          content: JSON.stringify({ error: errMsg }),
        })
        yield {
          type: 'tool_step',
          toolStep: { iteration, name: call.name, args: parsed, summary: `error: ${errMsg}`, durationMs: Date.now() - start, error: errMsg },
        }
      }
    }
  }

  // Hit the iteration cap without a final text-only turn. Force one
  // last text-only turn by appending a system nudge and re-invoking
  // without tools (caller can decide to stream that).
  messages.push({
    role: 'system',
    content: 'Tool-call budget exhausted. Compose the best answer you can from what you have gathered. Cite [chunk:UUID] / [entity:UUID] / [#N](url) as before.',
  })
  for await (const evt of llm.stream(messages, { temperature: 0.2 })) {
    if (evt.type === 'text' && evt.text) yield { type: 'text', text: evt.text }
    if (evt.type === 'done') {
      totalInput += evt.inputTokens ?? 0
      totalOutput += evt.outputTokens ?? 0
    }
  }
  yield {
    type: 'done',
    inputTokens: totalInput,
    outputTokens: totalOutput,
    iterations: iteration,
  }
}

/**
 * Cap absurdly large tool results so they don't blow up the next
 * turn's input tokens. Most operators already cap their internal
 * limits but defensive trimming is cheap insurance.
 */
function trimToolResult(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.slice(0, 30).map((v) => trimToolResult(v))
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (typeof v === 'string' && v.length > 4000) {
        out[k] = v.slice(0, 4000) + '… [truncated]'
      } else {
        out[k] = trimToolResult(v)
      }
    }
    return out
  }
  return value
}

/**
 * One independent LLM pass that reviews a proposed answer for
 * completeness. Returns `OK` if the answer is good enough or a
 * non-empty `gaps` string with concrete things to investigate.
 *
 * Deliberately cheap: small system prompt, no tools, short max-out.
 * The cost lands on a "smart enough" model — same provider as the
 * main loop — but typical critic turns are <300 output tokens.
 */
async function runCritic(
  llm: LLMProvider,
  question: string,
  answer: string,
  ru: boolean,
): Promise<{ kind: 'ok' } | { kind: 'gaps'; gaps: string; inputTokens: number; outputTokens: number }> {
  const system = ru
    ? `Ты — придирчивый ревьюер ответов coding-агента. Тебе дан вопрос пользователя и предлагаемый ответ агента. Твоя задача: найти конкретные пробелы — что не проверено, какой файл/функция не прочитан, какой framework-вопрос не уточнён через web_search, какое утверждение не подкреплено цитатой [chunk:UUID]/[entity:UUID]/[#N](url). Если ответ достаточен — ответь ровно одним словом: OK. Если есть пробелы — выдай нумерованный список (макс 5 пунктов), каждый пункт — императивная инструкция агенту что именно сделать. Никакого вводного текста.`
    : `You are a strict reviewer of a coding agent's answer. You are given the user's question and the agent's proposed answer. Your job: find concrete gaps — what wasn't checked, which file/function wasn't read, which framework question wasn't pinned down with web_search, which claim has no [chunk:UUID]/[entity:UUID]/[#N](url) citation. If the answer is sufficient, reply with exactly one word: OK. Otherwise output a numbered list (max 5 items), each an imperative instruction telling the agent what specifically to do. No preamble.`
  const user = ru
    ? `ВОПРОС:\n${question}\n\nОТВЕТ АГЕНТА:\n${answer}`
    : `QUESTION:\n${question}\n\nAGENT ANSWER:\n${answer}`
  let text = ''
  let inputTokens = 0
  let outputTokens = 0
  for await (const evt of llm.stream(
    [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    { temperature: 0 },
  )) {
    if (evt.type === 'text' && evt.text) text += evt.text
    if (evt.type === 'done') {
      inputTokens = evt.inputTokens ?? 0
      outputTokens = evt.outputTokens ?? 0
    }
  }
  const trimmed = text.trim()
  if (!trimmed || /^ok\.?\s*$/i.test(trimmed)) return { kind: 'ok' }
  return { kind: 'gaps', gaps: trimmed, inputTokens, outputTokens }
}

function describeResult(value: unknown): string {
  if (value === null || value === undefined) return 'null'
  if (Array.isArray(value)) return `array(${value.length})`
  if (typeof value === 'object') {
    const keys = Object.keys(value as Record<string, unknown>)
    return `object{${keys.slice(0, 6).join(',')}${keys.length > 6 ? '…' : ''}}`
  }
  if (typeof value === 'string') return `"${value.slice(0, 60)}${value.length > 60 ? '…' : ''}"`
  return String(value)
}
