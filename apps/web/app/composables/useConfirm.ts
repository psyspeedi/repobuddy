/**
 * Promise-based confirm dialog. Replaces window.confirm() with a
 * controlled UI component that matches the rest of the app.
 *
 * Usage (anywhere in setup or async handler):
 *
 *   const ok = await useConfirm().ask({
 *     title: 'Delete workspace?',
 *     body: 'This is irreversible.',
 *     confirmLabel: 'Delete',
 *     destructive: true,
 *   })
 *   if (!ok) return
 *
 * The dialog itself lives in components/ConfirmDialog.vue, mounted
 * once from the default layout. State is stored in `useState` so
 * the singleton instance survives navigations.
 */
export interface ConfirmOptions {
  title: string
  body?: string
  confirmLabel?: string
  cancelLabel?: string
  destructive?: boolean
}

interface ConfirmState extends ConfirmOptions {
  open: boolean
  /** Set by ConfirmDialog.vue when the user clicks Confirm / Cancel / X. */
  resolver: ((ok: boolean) => void) | null
}

export function useConfirm() {
  const state = useState<ConfirmState>('confirm-dialog', () => ({
    open: false,
    title: '',
    resolver: null,
  }))

  function ask(opts: ConfirmOptions): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      state.value = {
        open: true,
        title: opts.title,
        body: opts.body,
        confirmLabel: opts.confirmLabel,
        cancelLabel: opts.cancelLabel,
        destructive: opts.destructive,
        resolver: resolve,
      }
    })
  }

  function resolve(ok: boolean): void {
    if (state.value.resolver) state.value.resolver(ok)
    state.value = { open: false, title: '', resolver: null }
  }

  return { state, ask, resolve }
}
