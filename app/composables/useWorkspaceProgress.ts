import type { WorkspaceProgress } from '#shared/types/workspace'

interface ProgressState {
  status: string
  progress: WorkspaceProgress | null
  stats: Record<string, number> | null
  error: string | null
}

/**
 * Subscribes to SSE progress for a workspace. Returns reactive state and
 * stops streaming when the component is unmounted.
 */
export function useWorkspaceProgress(workspaceId: string) {
  const state = ref<ProgressState>({
    status: 'pending',
    progress: null,
    stats: null,
    error: null,
  })
  const done = ref(false)
  let es: EventSource | null = null

  function start(): void {
    if (es) return
    es = new EventSource(`/api/workspaces/${workspaceId}/progress`)

    es.addEventListener('progress', (e) => {
      try {
        const parsed = JSON.parse((e as MessageEvent).data) as ProgressState
        state.value = parsed
      } catch {
        // ignore malformed payload
      }
    })

    es.addEventListener('done', () => {
      done.value = true
      es?.close()
      es = null
    })

    es.addEventListener('error', () => {
      // EventSource auto-reconnects; nothing to do here.
    })
  }

  function stop(): void {
    es?.close()
    es = null
  }

  onMounted(start)
  onBeforeUnmount(stop)

  return { state, done, start, stop }
}
