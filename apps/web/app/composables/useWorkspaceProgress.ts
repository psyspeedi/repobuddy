import type { WorkspaceProgress } from '#shared/types/workspace'

interface ProgressState {
  status: string
  progress: WorkspaceProgress | null
  stats: Record<string, number> | null
  error: string | null
}

const POLL_INTERVAL_MS = 1000
const TERMINAL_STATUSES = new Set(['ready', 'failed'])

interface WorkspaceResponse {
  workspace: {
    status: string
    progress: WorkspaceProgress | null
    stats: Record<string, number> | null
    error: string | null
  }
}

/**
 * Polls the workspace endpoint once per second until the status reaches a
 * terminal state ('ready' or 'failed'), then stops. We deliberately avoid
 * SSE here — in Nuxt 4 dev mode the Vite middleware buffers
 * `createEventStream` responses, so events never reach the browser. REST
 * polling at 1Hz is correctly through every dev/prod proxy combo.
 */
export function useWorkspaceProgress(workspaceId: string) {
  const state = ref<ProgressState>({
    status: 'pending',
    progress: null,
    stats: null,
    error: null,
  })
  const done = ref(false)
  let timer: ReturnType<typeof setInterval> | null = null
  let inflight = false

  async function poll(): Promise<void> {
    if (inflight) return
    inflight = true
    try {
      const data = await $fetch<WorkspaceResponse>(
        `/api/workspaces/${workspaceId}`,
      )
      state.value = {
        status: data.workspace.status,
        progress: data.workspace.progress,
        stats: data.workspace.stats,
        error: data.workspace.error,
      }
      if (TERMINAL_STATUSES.has(data.workspace.status)) {
        done.value = true
        stop()
      }
    } catch {
      // Swallow transient fetch errors; the next tick retries.
    } finally {
      inflight = false
    }
  }

  function start(): void {
    if (timer) return
    void poll()
    timer = setInterval(() => void poll(), POLL_INTERVAL_MS)
  }

  function stop(): void {
    if (timer) {
      clearInterval(timer)
      timer = null
    }
  }

  onMounted(start)
  onBeforeUnmount(stop)

  return { state, done, start, stop }
}
