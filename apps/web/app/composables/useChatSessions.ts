export interface ChatSessionListItem {
  id: string
  title: string
  workspaceId: string
  createdAt: string
  updatedAt: string
  messageCount: number
  preview: string | null
}

interface SessionsResponse {
  sessions: ChatSessionListItem[]
}

/**
 * Lightweight chat-session list for the sidebar. Refresh after every
 * send completes (the page wires that up) so a brand-new session
 * appears as soon as it's persisted.
 */
export function useChatSessions(workspaceId: string) {
  const sessions = ref<ChatSessionListItem[]>([])
  const loading = ref(false)
  const api = useApi()

  async function refresh(): Promise<void> {
    loading.value = true
    try {
      const res = await api<SessionsResponse>('/api/chat/sessions', {
        query: { workspaceId },
      })
      sessions.value = res.sessions
    } catch {
      // Soft fail — sidebar simply shows empty.
    } finally {
      loading.value = false
    }
  }

  async function remove(id: string): Promise<void> {
    await api(`/api/chat/${id}`, { method: 'DELETE' })
    sessions.value = sessions.value.filter((s) => s.id !== id)
  }

  return { sessions, loading, refresh, remove }
}
