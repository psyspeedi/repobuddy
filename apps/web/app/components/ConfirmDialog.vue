<script setup lang="ts">
/**
 * Singleton confirm dialog. Reads its state from `useConfirm()` and
 * never has to be passed props — `ask({ … })` from any setup or
 * async function pops it up.
 *
 * Mounted once in layouts/default.vue.
 */
import { AlertTriangle } from 'lucide-vue-next'

const { t } = useI18n()
const { state, resolve } = useConfirm()

// Close on Esc when open.
function onKey(e: KeyboardEvent): void {
  if (state.value.open && e.key === 'Escape') resolve(false)
}
onMounted(() => window.addEventListener('keydown', onKey))
onUnmounted(() => {
  if (typeof window !== 'undefined') window.removeEventListener('keydown', onKey)
})
</script>

<template>
  <div
    v-if="state.open"
    class="fixed inset-0 z-[70] flex items-center justify-center bg-background/80 p-4 backdrop-blur"
    @click.self="resolve(false)"
  >
    <div
      class="w-full max-w-md space-y-4 rounded-xl border bg-card p-5 shadow-xl"
      :class="state.destructive ? 'border-destructive/30' : 'border-border'"
    >
      <div class="flex items-start gap-3">
        <span
          v-if="state.destructive"
          class="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-destructive/15 text-destructive"
        >
          <AlertTriangle class="h-5 w-5" />
        </span>
        <div class="space-y-1">
          <h3 class="text-lg font-semibold" :class="state.destructive ? 'text-destructive' : ''">
            {{ state.title }}
          </h3>
          <p v-if="state.body" class="text-sm leading-relaxed text-muted-foreground">
            {{ state.body }}
          </p>
        </div>
      </div>
      <div class="flex items-center justify-end gap-2">
        <Button variant="ghost" size="sm" @click="resolve(false)">
          {{ state.cancelLabel ?? t('common.cancel') }}
        </Button>
        <Button
          size="sm"
          :class="state.destructive ? 'bg-destructive text-destructive-foreground hover:bg-destructive/90' : ''"
          @click="resolve(true)"
        >
          {{ state.confirmLabel ?? t('common.confirm') }}
        </Button>
      </div>
    </div>
  </div>
</template>
