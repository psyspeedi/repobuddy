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
} from '../providers/llm'
import { getLogger } from '../lib/logger'

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
  }
  inputTokens?: number
  outputTokens?: number
  iterations?: number
}

export interface AgenticOptions {
  history?: ChatMessage[]
  maxIterations?: number
  responseLocale?: 'en' | 'ru'
}

const SYSTEM_PROMPT_EN = `You are RepoBuddy, an OSS contribution copilot.

You answer questions about a codebase using ONLY tools you call. Each
tool returns structured graph data — entities, chunks, GitHub issues,
project overview. You must call tools to discover facts; never make
up file paths, symbol names, or behaviour.

How to think:
1. For broad questions ("tell me about", "where do I start") start with
   get_project_overview — cheap and gives entry points + core abstractions.
2. For "how does X work" first find_symbol the identifier, then walkthrough
   the entity to see callees / tests / parent.
3. For "who calls X" use get_callers with transitive: true.
4. For "issue #N" ALWAYS call list_issues with issueNumber:N first.
5. If you know the file you need, call read_file({path}) DIRECTLY — don't
   try to find_symbol first. read_file matches by suffix, so 'tsconfig.json'
   or 'src/index.ts' both work. Use this aggressively: a typical issue
   resolution needs to read 2-4 specific files (config + the file the
   issue is about + a test file) — call read_file on each in parallel.
6. If retrieve_code_chunks comes back empty for an entity, FALLBACK to
   read_file with that entity's filePath — sometimes the entity_chunks
   join is sparse but the chunk exists.
7. When you have enough context to answer, STOP calling tools and write
   the final answer.

Citation rules in the final answer:
- For code claims, cite the chunk: [chunk:UUID] (UUIDs from chunk results).
- For graph entities, cite [entity:UUID].
- For GitHub issues, link [#N](url). Never wrap an issue number in
  [entity:...] or [chunk:...].
- If context is insufficient, say so plainly. Do not fabricate.

Budget: max 12 tool calls per question. Plan accordingly.`

const SYSTEM_PROMPT_RU = `Ты — RepoBuddy, помощник для контрибьюторов в OSS.

Отвечай ТОЛЬКО используя вызовы инструментов. Каждый tool возвращает
структурированные данные графа — сущности, фрагменты кода, GitHub issues,
обзор проекта. Никогда не выдумывай пути к файлам, имена символов или
поведение.

Как мыслить:
1. Широкие вопросы ("расскажи о", "с чего начать") — начинай с
   get_project_overview, дёшево и сразу видны точки входа.
2. "Как работает X" — сначала find_symbol по имени, затем walkthrough
   для callees / tests / parent.
3. "Кто вызывает X" — get_callers с transitive: true.
4. "issue #N" — ВСЕГДА сначала list_issues с issueNumber:N. Если
   relatedEntities непуст, разверни 2-3 верхних через walkthrough +
   get_callers + retrieve_code_chunks перед финальным ответом.
5. Когда контекста достаточно — ОСТАНОВИСЬ и напиши финальный ответ.

Правила цитирования в финальном ответе:
- Утверждения о коде → [chunk:UUID] (UUID берётся из результатов tool).
- Сущности графа → [entity:UUID].
- GitHub issues → [#N](url). НЕ заворачивай номер issue в [entity:...]
  или [chunk:...] — там только UUID.
- Если контекста не хватает — скажи прямо. Не выдумывай.

Бюджет: максимум 12 вызовов tools на вопрос. Планируй соответственно.

Полезно знать: read_file({path}) открывает файл буквально (suffix-match,
'tsconfig.json' работает). Используй агрессивно — для разбора issue
обычно нужно прочитать 2-4 конкретных файла (конфиг + основной + тест).`

const LANGUAGE_INSTRUCTION_EN = 'Always respond in English.'
const LANGUAGE_INSTRUCTION_RU = 'Always respond in Russian (русский).'

// Subset of operators exposed as tools. `answer` is excluded — the LLM
// generates the final answer inline when it stops calling tools.
const TOOL_DEFS: ToolDefinition[] = [
  {
    name: 'get_project_overview',
    description: 'Snapshot of the workspace: entrypoints, top-fanout classes/functions, hot files, safe-first-PR zones, and entity-type stats. Call at the start of broad orientation questions.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'find_symbol',
    description: 'Locate entities by name. Use the bare identifier (e.g. "OrderService", not "the OrderService class"). Set `fuzzy: true` if the name might be a substring. Omit `name` and pass only `type` to enumerate entities of a kind.',
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
  {
    name: 'find_file',
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
  {
    name: 'get_callers',
    description: 'Entities that call a target. Set `transitive: true` and `maxDepth` to walk multiple hops. Pass either a single entity or an array.',
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
  {
    name: 'get_callees',
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
  {
    name: 'walkthrough',
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
  {
    name: 'retrieve_code_chunks',
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
  {
    name: 'hybrid_search',
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
  {
    name: 'search_docs',
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
  {
    name: 'find_by_concept',
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
  {
    name: 'list_issues',
    description: 'Open GitHub issues from the workspace repo. Pass `issueNumber` to focus a single issue; otherwise lists open issues filtered by labels. The result includes relatedEntities + relatedChunks already linked to indexed code — you can expand those with walkthrough / get_callers if needed.',
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
  {
    name: 'git_history',
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
  {
    name: 'read_file',
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
]

/** Operators NOT exposed as tools (used only by the planner / executor). */
const TOOL_NAMES = new Set<OperatorName>(
  TOOL_DEFS.map((t) => t.name as OperatorName),
)

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
      // No tool calls this turn → final answer streamed already.
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
