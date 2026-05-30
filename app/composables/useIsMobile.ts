/**
 * Reactive `is viewport below the given breakpoint` flag, kept in sync
 * via `matchMedia`. Defaults to Tailwind's `lg` (1024px) since the
 * chat side-panels (Reasoning Inspector / Source Viewer / Neighbour
 * Graph) are gated on `lg:` in `app/pages/w/[id]/index.vue` — anything
 * narrower needs the BottomSheet treatment.
 */
export function useIsMobile(breakpointPx = 1024) {
  const isMobile = ref(false)
  let mq: MediaQueryList | null = null
  function onChange(e: MediaQueryListEvent | MediaQueryList): void {
    isMobile.value = e.matches
  }
  onMounted(() => {
    mq = window.matchMedia(`(max-width: ${breakpointPx - 1}px)`)
    onChange(mq)
    // Safari < 14 used the deprecated addListener; modern browsers expose
    // addEventListener. We're targeting evergreen + Safari 14+.
    mq.addEventListener('change', onChange)
  })
  onBeforeUnmount(() => {
    if (mq) mq.removeEventListener('change', onChange)
  })
  return isMobile
}
