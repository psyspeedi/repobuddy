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
 *   - maxIterations: hard ceiling on tool-call rounds. Default 12.
 *   - maxTokens: cumulative budget across all turns. Default 80k input + 8k output.
 *
 * The loop is intentionally simple — there's no planner step, no
 * retry-with-feedback, no plan validation. The model owns control
 * flow. We just dispatch tools and append results.
 */
import type { OperatorContext } from './operators'
import type { OperatorName } from './operators'
import type {
  ChatMessage,
  LLMProvider,
  ToolCall,
  ToolDefinition,
} from '#server/providers/llm'
import { getLogger } from '#server/lib/logger'

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

/**
 * Tools whose result envelope is forwarded to the client for direct
 * rendering. Shared with the plan executor so planned mode surfaces
 * the same envelopes (trace entries carry `result` for these ops).
 */
export const TOOL_RESULTS_SURFACED_TO_UI = new Set<string>(['find_resolution'])

export interface AgenticOptions {
  history?: ChatMessage[]
  maxIterations?: number
  responseLocale?: 'en' | 'ru'
}

const SYSTEM_PROMPT_EN = `You are RepoBuddy, a coding agent for open-source contribution.

You are NOT a Q&A bot. Behave like Claude Code: investigate
aggressively before answering, surface concrete code paths, and
propose specific actionable fixes rather than generic advice.

You answer questions by calling tools that traverse the indexed
repo — the knowledge graph (entities, relations), source chunks,
GitHub issues, and the project overview. Every claim in your final
answer must be grounded in what those tools returned.

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
   the bug from scratch when an existing resolution exists. If
   resolution.status == "none" and list_issues.relatedEntities is
   non-empty — expand the top 2-3 via walkthrough + get_callers +
   retrieve_code_chunks before the final answer.
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
8. Before you stop calling tools, ask yourself: am I about to give
   generic advice that doesn't cite a specific file / line? If yes,
   dig deeper — read_file, hybrid_search, walkthrough, anything to
   ground the answer. Generic advice is a failure mode.
9. When you have enough GROUNDED context to answer, STOP calling tools
   and write the final answer.

Citation rules in the final answer:
- For code claims, cite the chunk: [chunk:UUID] (UUIDs from chunk results).
- For graph entities, cite [entity:UUID].
- For GitHub issues, link [#N](url). Never wrap an issue number in
  [entity:...] or [chunk:...].
- If context is insufficient, say so plainly. Do not fabricate.

Budget: max 12 tool calls per question. Plan accordingly.`

const SYSTEM_PROMPT_RU = `Ты — RepoBuddy, coding-agent для контрибьюции в OSS.

Ты НЕ Q&A-бот. Веди себя как Claude Code: исследуй агрессивно
до ответа, показывай конкретные пути в коде, предлагай конкретные
фиксы а не общие советы.

Отвечай используя tools — операторы по индексированному репо:
граф знаний (сущности, связи), chunks исходников, GitHub issues и
обзор проекта. Каждое утверждение в финальном ответе обязано
опираться на то, что вернули tools.

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
5. Если знаешь нужный файл — вызывай read_file({path}) НАПРЯМУЮ, без
   find_symbol. read_file матчит по суффиксу: 'tsconfig.json' и
   'src/index.ts' работают. Используй агрессивно — для разбора issue
   обычно нужно прочитать 2-4 конкретных файла (конфиг + основной +
   тест), вызывай read_file на каждый параллельно.
6. Если retrieve_code_chunks вернул пусто для сущности — FALLBACK на
   read_file с её filePath: связка entity_chunks бывает разреженной,
   а сам chunk при этом существует.
7. Если вопрос содержит unified diff (строки "diff --git", "---", "+++",
   "@@"), это change-set на ревью. Прочитай каждый затронутый файл
   через read_file параллельно, затем tests_for на изменённых сущностях
   для проверки покрытия тестами. Финальный ответ ОБЯЗАН содержать:
   (а) что делает diff, (б) каких callers / tests затронет, (в) риски,
   (г) конкретный следующий шаг.
8. Перед тем как остановить вызовы — спроси себя: я сейчас собираюсь
   дать общий совет без ссылки на конкретный файл / строку? Если да,
   копай дальше — read_file, hybrid_search, walkthrough, что угодно
   чтобы заземлить ответ. Общий совет — failure mode.
9. Когда GROUNDED-контекста достаточно — ОСТАНОВИСЬ и пиши ответ.

Правила цитирования в финальном ответе:
- Утверждения о коде → [chunk:UUID] (UUID берётся из результатов tool).
- Сущности графа → [entity:UUID].
- GitHub issues → [#N](url). НЕ заворачивай номер issue в [entity:...]
  или [chunk:...] — там только UUID.
- Если контекста не хватает — скажи прямо. Не выдумывай.

Бюджет: максимум 12 вызовов tools на вопрос. Планируй заранее.`

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
}

// Materialise the array form (with name) once for the OpenAI SDK.
const TOOL_DEFS: ToolDefinition[] = Object.entries(TOOL_DEFS_MAP).map(([name, def]) => ({
  name,
  ...def,
}))

/** Operators NOT exposed as tools (only the planner / executor calls them). */
const TOOL_NAMES = new Set<OperatorName>(Object.keys(TOOL_DEFS_MAP) as OperatorName[])

type OperatorsMap = Record<
  string,
  (params: never, ctx: OperatorContext) => Promise<unknown> | AsyncGenerator<unknown>
>

export async function* runAgenticAnswer(
  llm: LLMProvider,
  ctx: OperatorContext,
  question: string,
  opts: AgenticOptions = {},
  /** Required — KagOperatorsRegistry.asLegacyMap() in production;
   *  buildOperatorsMapForTest(db) in integration tests. */
  operators: OperatorsMap,
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
      // No tool calls this turn → the model is done.
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
      if (!TOOL_NAMES.has(opName) || !(opName in operators)) {
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
        const op = operators[opName] as (p: unknown, c: OperatorContext) => Promise<unknown>
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
