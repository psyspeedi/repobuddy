import { randomUUID } from 'uncrypto'

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

export interface ChatMessageData {
  role: 'user' | 'assistant'
  content: string
  citations?: { kind: 'chunk' | 'entity'; id: string }[]
  invalid?: string[]
  pending?: boolean
  plan?: PlanData
  trace?: TraceEntry[]
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

const STORAGE_PREFIX = 'codegraph:session:'

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
          trace: m.trace as TraceEntry[] | undefined,
        }))
      }
    } catch {
      // Empty / missing session is fine — chat starts blank.
    } finally {
      historyLoaded.value = true
    }
  }

  async function send(question: string): Promise<void> {
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
    let event = 'message'
    // Per SSE spec, the data buffer accumulates each `data:` line joined by
    // a single \n. h3's createEventStream serialises a value containing
    // newlines as multiple `data:` lines, so dropping the separator
    // collapses headers and lists into the next paragraph (we saw
    // "### Heading:- item1- item2" before).
    let data = ''
    let hasData = false
    for (const line of raw.split('\n')) {
      if (line.startsWith('event:')) {
        event = line.slice(6).trim()
      } else if (line.startsWith('data:')) {
        let value = line.slice(5)
        // SSE spec: strip exactly one leading U+0020 SPACE (field separator).
        if (value.startsWith(' ')) value = value.slice(1)
        if (hasData) data += '\n'
        data += value
        hasData = true
      }
    }
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
        last.trace = JSON.parse(data) as TraceEntry[]
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
  }
}
