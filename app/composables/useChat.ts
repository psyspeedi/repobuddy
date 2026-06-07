import { randomUUID } from 'uncrypto'
import { parseSseEvent } from '#shared/lib/sse'
import type { ResolutionEnvelope } from '#shared/schemas/resolution'

export interface PlanData {
  reasoning: string
  steps: { id: string; op: string; params: Record<string, unknown>; comment?: string }[]
}

export interface TraceEntry {
  stepId: string
  op: string
  ok: boolean
  durationMs: number
  summary?: string
  error?: string
}

/**
 * Agentic tool-use trace shape. Emitted by the server when the chat
 * runs in agentic mode — there's no static plan, just a sequence of
 * tool dispatches the LLM chose at runtime.
 */
export interface AgenticStep {
  iteration: number
  name: string
  args: Record<string, unknown>
  summary: string
  durationMs: number
  error?: string
  /**
   * Structured envelope for the small set of operators whose UI
   * renders the result directly (find_resolution → resolution banner).
   * Most steps don't have this — the server only includes it for
   * whitelisted ops.
   */
  result?: unknown
}
export interface AgenticTrace {
  mode: 'agentic'
  steps: AgenticStep[]
}

export type AnyTrace = TraceEntry[] | AgenticTrace

/**
 * Pull the most recent find_resolution envelope out of an agentic
 * trace. Returns null if the trace isn't agentic, has no resolution
 * step, or the step's status is "none" (nothing to surface). Used by
 * the chat page to feed ChatMessage's banner without each message
 * having to know about trace shape.
 */
export function extractResolution(trace: AnyTrace | undefined): ResolutionEnvelope | null {
  if (!trace || !('mode' in trace) || trace.mode !== 'agentic') return null
  // Iterate newest-first so a second find_resolution call (rare but
  // possible if the LLM checks two issues in one turn) takes priority.
  for (let i = trace.steps.length - 1; i >= 0; i--) {
    const step = trace.steps[i]
    if (!step || step.name !== 'find_resolution' || !step.result) continue
    const env = step.result as ResolutionEnvelope
    if (env.status && env.status !== 'none') return env
  }
  return null
}

export interface ChatMessageData {
  role: 'user' | 'assistant'
  content: string
  citations?: { kind: 'chunk' | 'entity'; id: string }[]
  invalid?: string[]
  pending?: boolean
  plan?: PlanData
  trace?: AnyTrace
  /** Tokens per second for the most recently completed assistant turn. */
  tokensPerSec?: number
  /** Filled with the abort signal when the message is still streaming so the UI can call cancel(). */
  aborted?: boolean
}

interface HistoryMessage {
  role: 'user' | 'assistant'
  content: string
  plan?: unknown
  trace?: unknown
}

const STORAGE_PREFIX = 'repobuddy:session:'

function readPersistedSession(workspaceId: string): string | null {
  if (typeof window === 'undefined') return null
  try {
    return localStorage.getItem(STORAGE_PREFIX + workspaceId)
  } catch {
    return null
  }
}

function writePersistedSession(workspaceId: string, id: string): void {
  if (typeof window === 'undefined') return
  try {
    localStorage.setItem(STORAGE_PREFIX + workspaceId, id)
  } catch {
    /* private mode etc — ignore */
  }
}

/**
 * Stateful chat session bound to a workspace. The session id is persisted in
 * localStorage keyed by workspace, so reloading the page reuses the same
 * session and its message history. Call `newSession()` to start a fresh one.
 */
export function useChat(workspaceId: string) {
  // Composables must be invoked synchronously at the top of a setup
  // function. useI18n() used to be called inside send() — that worked
  // in the happy path because Nuxt's async context still resolved, but
  // when send() was triggered from a non-setup callback (e.g. an event
  // handler bound after mount) it threw "Must be called at the top of
  // a setup function". Pulling it up here is the documented pattern.
  const i18n = useI18n()
  // Shared counter that the layout's quota pill watches — bumped after
  // every successful chat completion so the "used / limit" numbers
  // update without a manual refresh.
  const quotaBump = useState<number>('quota-bump', () => 0)
  const initialId = readPersistedSession(workspaceId) ?? randomUUID()
  if (!readPersistedSession(workspaceId)) {
    writePersistedSession(workspaceId, initialId)
  }
  const sessionId = ref(initialId)
  const messages = ref<ChatMessageData[]>([])
  const streaming = ref(false)
  const historyLoaded = ref(false)

  // Session focus — entities / files / issues the user has pinned for
  // this chat. Persisted in localStorage keyed by workspaceId so it
  // survives reloads. The chat endpoint receives the focus on every
  // turn and pre-loads the relevant chunks into the prompt.
  interface SessionFocus {
    entityIds: string[]
    filePaths: string[]
    issueNumbers: number[]
  }
  const FOCUS_KEY = `repobuddy:focus:${workspaceId}`
  const focus = ref<SessionFocus>({ entityIds: [], filePaths: [], issueNumbers: [] })
  if (import.meta.client) {
    try {
      const raw = localStorage.getItem(FOCUS_KEY)
      if (raw) {
        const parsed = JSON.parse(raw) as Partial<SessionFocus>
        focus.value = {
          entityIds: parsed.entityIds ?? [],
          filePaths: parsed.filePaths ?? [],
          issueNumbers: parsed.issueNumbers ?? [],
        }
      }
    } catch { /* private mode / corrupt JSON — start blank */ }
  }
  watch(focus, (v) => {
    try { localStorage.setItem(FOCUS_KEY, JSON.stringify(v)) } catch { /* private mode */ }
  }, { deep: true })

  function pinEntity(id: string): void {
    if (!focus.value.entityIds.includes(id)) focus.value.entityIds = [...focus.value.entityIds, id]
  }
  function unpinEntity(id: string): void {
    focus.value.entityIds = focus.value.entityIds.filter((x) => x !== id)
  }
  function pinFile(path: string): void {
    if (!focus.value.filePaths.includes(path)) focus.value.filePaths = [...focus.value.filePaths, path]
  }
  function unpinFile(path: string): void {
    focus.value.filePaths = focus.value.filePaths.filter((x) => x !== path)
  }
  function pinIssue(n: number): void {
    if (!focus.value.issueNumbers.includes(n)) focus.value.issueNumbers = [...focus.value.issueNumbers, n]
  }
  function unpinIssue(n: number): void {
    focus.value.issueNumbers = focus.value.issueNumbers.filter((x) => x !== n)
  }
  function clearFocus(): void {
    focus.value = { entityIds: [], filePaths: [], issueNumbers: [] }
  }
  // Abort handle for the in-flight chat fetch. Set in send(), cleared
  // when streaming ends. cancel() aborts and lets send() exit cleanly.
  let activeController: AbortController | null = null
  let startedAt = 0

  async function loadHistory(): Promise<void> {
    try {
      const res = await $fetch<{
        session: { id: string } | null
        messages: HistoryMessage[]
      }>(`/api/chat/${sessionId.value}`)
      if (res.session && res.messages.length > 0) {
        messages.value = res.messages.map((m) => ({
          role: m.role,
          content: m.content,
          plan: m.plan as PlanData | undefined,
          trace: m.trace as AnyTrace | undefined,
        }))
      }
    } catch {
      // Empty / missing session is fine — chat starts blank.
    } finally {
      historyLoaded.value = true
    }
  }

  async function send(
    question: string,
    opts: { mode?: 'planned' | 'agentic' } = {},
  ): Promise<void> {
    if (streaming.value) return
    const trimmed = question.trim()
    if (!trimmed) return

    messages.value = [
      ...messages.value,
      { role: 'user', content: trimmed },
      { role: 'assistant', content: '', pending: true },
    ]
    streaming.value = true

    activeController = new AbortController()
    startedAt = Date.now()
    try {
      const response = await fetch(`/api/chat/${sessionId.value}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        signal: activeController.signal,
        body: JSON.stringify({
          workspaceId,
          question: trimmed,
          locale: i18n.locale.value,
          mode: opts.mode ?? 'planned',
          focus: focus.value,
        }),
      })
      if (!response.ok || !response.body) {
        throw new Error(`Chat failed: ${response.status}`)
      }
      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''

      // SSE parse: events end with \n\n; lines start with `event:` / `data:`.
      while (true) {
        const { value, done } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        let idx: number
        while ((idx = buffer.indexOf('\n\n')) !== -1) {
          const raw = buffer.slice(0, idx)
          buffer = buffer.slice(idx + 2)
          handleSseChunk(raw)
        }
      }
    } catch (err) {
      const last = messages.value.at(-1)
      if (last && last.role === 'assistant') {
        const isAbort =
          (err instanceof DOMException && err.name === 'AbortError')
          || (err instanceof Error && err.name === 'AbortError')
        if (isAbort) {
          last.aborted = true
          if (!last.content) last.content = '_(stopped by user)_'
        } else {
          last.content = `Error: ${err instanceof Error ? err.message : String(err)}`
        }
        last.pending = false
      }
    } finally {
      streaming.value = false
      activeController = null
      const last = messages.value.at(-1)
      if (last) last.pending = false
    }
  }

  function cancel(): void {
    if (activeController) activeController.abort()
  }

  function handleSseChunk(raw: string): void {
    const { event, data } = parseSseEvent(raw)
    const last = messages.value.at(-1)
    if (!last || last.role !== 'assistant') return
    if (event === 'text') {
      last.content += data
    } else if (event === 'plan') {
      try {
        last.plan = JSON.parse(data) as PlanData
      } catch { /* malformed */ }
    } else if (event === 'trace') {
      try {
        last.trace = JSON.parse(data) as AnyTrace
      } catch { /* malformed */ }
    } else if (event === 'tool_step') {
      // Agentic mode streams tool_step events one at a time as the LLM
      // dispatches them. We accumulate into a live AgenticTrace so the
      // Reasoning Inspector can render the unfolding sequence in real
      // time (the final 'trace' event will overwrite this with the
      // canonical snapshot, but the live stream is the more useful UX).
      try {
        const step = JSON.parse(data) as AgenticStep
        if (!last.trace || !('mode' in last.trace) || last.trace.mode !== 'agentic') {
          last.trace = { mode: 'agentic', steps: [] }
        }
        ;(last.trace as AgenticTrace).steps.push(step)
      } catch { /* malformed */ }
    } else if (event === 'citations') {
      try {
        const parsed = JSON.parse(data) as {
          citations: { kind: 'chunk' | 'entity'; id: string }[]
          invalid: string[]
        }
        last.citations = parsed.citations
        last.invalid = parsed.invalid
      } catch {
        /* ignore malformed payload */
      }
    } else if (event === 'done') {
      last.pending = false
      // Compute tokens/sec from elapsed wall-clock and the totals in the
      // done payload. Display is fully optional; falls back gracefully.
      try {
        const payload = JSON.parse(data) as { inputTokens?: number; outputTokens?: number }
        const elapsed = Math.max(0.5, (Date.now() - startedAt) / 1000)
        const total = (payload.outputTokens ?? 0)
        if (total > 0) last.tokensPerSec = Math.round(total / elapsed)
      } catch { /* malformed */ }
      // Tell the layout's quota pill to re-fetch /api/me/quota now that
      // the server has recorded this message's tokens.
      quotaBump.value++
    } else if (event === 'error') {
      last.content += `\n\n_Error: ${data}_`
      last.pending = false
    }
  }

  function newSession(): void {
    const fresh = randomUUID()
    sessionId.value = fresh
    writePersistedSession(workspaceId, fresh)
    messages.value = []
    historyLoaded.value = true
  }

  /** Switch to an existing persisted session and load its history. */
  async function switchSession(id: string): Promise<void> {
    if (id === sessionId.value) return
    sessionId.value = id
    writePersistedSession(workspaceId, id)
    messages.value = []
    historyLoaded.value = false
    await loadHistory()
  }

  return {
    sessionId,
    messages,
    streaming,
    historyLoaded,
    switchSession,
    send,
    cancel,
    loadHistory,
    newSession,
    focus,
    pinEntity,
    unpinEntity,
    pinFile,
    unpinFile,
    pinIssue,
    unpinIssue,
    clearFocus,
  }
}
