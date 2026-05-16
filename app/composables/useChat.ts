import { randomUUID } from 'uncrypto'

export interface ChatMessageData {
  role: 'user' | 'assistant'
  content: string
  citations?: { kind: 'chunk' | 'entity'; id: string }[]
  invalid?: string[]
  pending?: boolean
}

/**
 * Stateful chat session bound to a workspace. The composable owns one
 * session id (uuid) generated client-side; refreshing reuses it for the
 * lifetime of the page.
 */
export function useChat(workspaceId: string) {
  const sessionId = ref(randomUUID())
  const messages = ref<ChatMessageData[]>([])
  const streaming = ref(false)

  async function loadHistory(): Promise<void> {
    const res = await $fetch<{
      session: { id: string } | null
      messages: { role: 'user' | 'assistant'; content: string }[]
    }>(`/api/chat/${sessionId.value}`)
    if (res.session) {
      messages.value = res.messages.map((m) => ({
        role: m.role,
        content: m.content,
      }))
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

    try {
      const response = await fetch(`/api/chat/${sessionId.value}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ workspaceId, question: trimmed }),
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
        last.content = `Error: ${err instanceof Error ? err.message : String(err)}`
        last.pending = false
      }
    } finally {
      streaming.value = false
      const last = messages.value.at(-1)
      if (last) last.pending = false
    }
  }

  function handleSseChunk(raw: string): void {
    let event = 'message'
    let data = ''
    for (const line of raw.split('\n')) {
      if (line.startsWith('event:')) event = line.slice(6).trim()
      else if (line.startsWith('data:')) data += line.slice(5).trimStart()
    }
    const last = messages.value.at(-1)
    if (!last || last.role !== 'assistant') return
    if (event === 'text') {
      last.content += data
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
    } else if (event === 'error') {
      last.content += `\n\n_Error: ${data}_`
      last.pending = false
    }
  }

  function newSession(): void {
    sessionId.value = randomUUID()
    messages.value = []
  }

  return {
    sessionId,
    messages,
    streaming,
    send,
    loadHistory,
    newSession,
  }
}
