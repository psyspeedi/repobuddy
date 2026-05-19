<script setup lang="ts">
/**
 * Top-right toast stack. Reads from useToast(); each item has a tint
 * per kind. Click anywhere on a toast to dismiss it early.
 *
 * Mounted once from layouts/default.vue.
 */
import { CheckCircle, AlertCircle, AlertTriangle, Info, X } from 'lucide-vue-next'
import type { ToastKind } from '@/composables/useToast'

const { items, dismiss } = useToast()

// Style + icon per toast kind. Resolved via a switch (rather than a
// Record + index access) so TS's noUncheckedIndexedAccess can't claim
// the lookup is possibly undefined.
function styleFor(kind: ToastKind): string {
  switch (kind) {
    case 'success': return 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
    case 'error': return 'border-destructive/30 bg-destructive/10 text-destructive'
    case 'warning': return 'border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300'
    default: return 'border-primary/30 bg-primary/10 text-primary'
  }
}
const ICONS = {
  info: markRaw(Info),
  success: markRaw(CheckCircle),
  error: markRaw(AlertCircle),
  warning: markRaw(AlertTriangle),
} as const
</script>

<template>
  <Teleport to="body">
    <div class="pointer-events-none fixed right-4 top-4 z-[80] flex max-w-sm flex-col gap-2">
      <div
        v-for="item in items"
        :key="item.id"
        class="pointer-events-auto flex items-start gap-2 rounded-lg border px-3 py-2.5 text-sm shadow-md backdrop-blur"
        :class="styleFor(item.kind)"
        role="status"
      >
        <component :is="ICONS[item.kind]" class="mt-0.5 h-4 w-4 shrink-0" />
        <span class="flex-1 leading-snug">{{ item.text }}</span>
        <button
          type="button"
          class="-mr-1 -mt-0.5 inline-flex h-5 w-5 items-center justify-center rounded text-current/70 hover:bg-current/10"
          aria-label="Dismiss"
          @click="dismiss(item.id)"
        >
          <X class="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  </Teleport>
</template>
