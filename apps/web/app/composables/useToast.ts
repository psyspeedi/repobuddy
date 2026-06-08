/**
 * Lightweight toast notifications — replaces window.alert() for
 * transient error/success feedback. Multiple toasts stack from the
 * top-right; each auto-dismisses after `durationMs` (default 4500ms).
 *
 * Usage:
 *   useToast().error('Re-index failed')
 *   useToast().success('Settings saved')
 *   useToast().info('…')
 *
 * UI lives in components/ToastStack.vue, mounted from the default
 * layout. The composable is shared singleton state via useState.
 */
import { randomUUID } from 'uncrypto'

export type ToastKind = 'info' | 'success' | 'error' | 'warning'

export interface ToastItem {
  id: string
  kind: ToastKind
  text: string
  /** When set, the toast self-dismisses after this many ms. */
  expiresAt?: number
}

export function useToast() {
  const items = useState<ToastItem[]>('toasts', () => [])

  function push(kind: ToastKind, text: string, durationMs = 4500): string {
    const id = randomUUID()
    items.value = [
      ...items.value,
      { id, kind, text, expiresAt: durationMs > 0 ? Date.now() + durationMs : undefined },
    ]
    if (durationMs > 0 && typeof window !== 'undefined') {
      setTimeout(() => dismiss(id), durationMs)
    }
    return id
  }

  function dismiss(id: string): void {
    items.value = items.value.filter((t) => t.id !== id)
  }

  return {
    items,
    dismiss,
    info: (t: string, ms?: number) => push('info', t, ms),
    success: (t: string, ms?: number) => push('success', t, ms),
    error: (t: string, ms?: number) => push('error', t, ms ?? 7000),
    warning: (t: string, ms?: number) => push('warning', t, ms),
  }
}
