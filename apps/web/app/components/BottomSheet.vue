<script setup lang="ts">
/**
 * Mobile bottom sheet. Teleported to <body> so it escapes any
 * containing-block from a parent backdrop-filter / transform. Locks
 * page scroll while open and closes on Esc + backdrop click.
 *
 * The parent decides WHEN to open it (typically `open = isMobile && sidePanel`)
 * — this component does not itself check viewport. That separation
 * lets the same panel content render either as a desktop side column
 * or as a mobile sheet without duplicating slot markup.
 */
import { X } from 'lucide-vue-next'

interface Props {
  open: boolean
  /** Optional small label shown above the drag indicator. */
  title?: string
  /** Maximum height as a viewport percentage. Default 88vh. */
  maxHeightVh?: number
}
const props = withDefaults(defineProps<Props>(), { maxHeightVh: 88 })
const emit = defineEmits<{ (e: 'close'): void }>()

function onKeydown(e: KeyboardEvent): void {
  if (e.key === 'Escape') emit('close')
}

watch(
  () => props.open,
  (isOpen) => {
    if (typeof window === 'undefined' || typeof document === 'undefined') return
    if (isOpen) {
      window.addEventListener('keydown', onKeydown)
      document.body.style.overflow = 'hidden'
    } else {
      window.removeEventListener('keydown', onKeydown)
      document.body.style.overflow = ''
    }
  },
)
onBeforeUnmount(() => {
  if (typeof window === 'undefined' || typeof document === 'undefined') return
  window.removeEventListener('keydown', onKeydown)
  document.body.style.overflow = ''
})

const panelStyle = computed(() => ({
  maxHeight: `${props.maxHeightVh}vh`,
}))
</script>

<template>
  <Teleport to="body">
    <Transition name="cg-sheet">
      <div
        v-if="open"
        class="fixed inset-0 z-50 flex flex-col justify-end"
        role="dialog"
        aria-modal="true"
      >
        <div
          class="absolute inset-0 bg-background/70 backdrop-blur-sm"
          @click="$emit('close')"
        />
        <div
          class="relative flex w-full flex-col rounded-t-2xl border-t border-border bg-card shadow-2xl"
          :style="panelStyle"
        >
          <div class="relative shrink-0 border-b border-border px-4 pt-3 pb-2">
            <div class="mx-auto h-1 w-10 rounded-full bg-muted-foreground/30" />
            <h2
              v-if="title"
              class="mt-2 text-center text-xs font-medium uppercase tracking-wide text-muted-foreground"
            >
              {{ title }}
            </h2>
            <button
              type="button"
              class="absolute right-3 top-3 rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
              :aria-label="'Close'"
              @click="$emit('close')"
            >
              <X class="h-4 w-4" />
            </button>
          </div>
          <div class="flex-1 overflow-y-auto p-3">
            <slot />
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
/* The backdrop fades while the panel slides up. Apply different
 * transition timings via nested transition classes on the panel
 * vs. the backdrop. */
.cg-sheet-enter-active,
.cg-sheet-leave-active {
  transition: opacity 180ms ease;
}
.cg-sheet-enter-from,
.cg-sheet-leave-to {
  opacity: 0;
}
.cg-sheet-enter-active > div:last-child,
.cg-sheet-leave-active > div:last-child {
  transition: transform 220ms cubic-bezier(0.22, 0.61, 0.36, 1);
}
.cg-sheet-enter-from > div:last-child,
.cg-sheet-leave-to > div:last-child {
  transform: translateY(100%);
}
</style>
