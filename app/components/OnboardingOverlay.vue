<script setup lang="ts">
import { MessageSquare, Network, Sparkles } from 'lucide-vue-next'

const STORAGE_KEY = 'cg-onboarding-seen-v1'

const { t } = useI18n()
const open = ref(false)
const step = ref(0)

onMounted(() => {
  // Skip on SSR and when the visitor has already dismissed.
  if (typeof window === 'undefined') return
  if (localStorage.getItem(STORAGE_KEY)) return
  open.value = true
})

const steps = computed(() => [
  { icon: MessageSquare, title: t('onboarding.s1.title'), body: t('onboarding.s1.body') },
  { icon: Sparkles, title: t('onboarding.s2.title'), body: t('onboarding.s2.body') },
  { icon: Network, title: t('onboarding.s3.title'), body: t('onboarding.s3.body') },
])

function next(): void {
  if (step.value < steps.value.length - 1) step.value++
  else dismiss()
}
function dismiss(): void {
  open.value = false
  try { localStorage.setItem(STORAGE_KEY, '1') } catch { /* ignore */ }
}
</script>

<template>
  <div
    v-if="open"
    class="fixed inset-0 z-[60] flex items-center justify-center bg-background/80 p-4 backdrop-blur"
    @click.self="dismiss"
  >
    <div class="w-full max-w-md space-y-5 rounded-xl border border-primary/20 bg-card p-6 shadow-xl">
      <div class="flex items-start gap-3">
        <span class="inline-flex h-10 w-10 items-center justify-center rounded-lg bg-primary/15 text-primary">
          <component :is="steps[step]?.icon" class="h-5 w-5" />
        </span>
        <div class="space-y-1">
          <h3 class="text-lg font-semibold">
            {{ steps[step]?.title }}
          </h3>
          <p class="text-sm leading-relaxed text-muted-foreground">
            {{ steps[step]?.body }}
          </p>
        </div>
      </div>
      <div class="flex items-center justify-between">
        <div class="flex gap-1">
          <span
            v-for="i in steps.length"
            :key="i"
            class="h-1.5 w-6 rounded-full transition"
            :class="i - 1 <= step ? 'bg-primary' : 'bg-muted'"
          />
        </div>
        <div class="flex gap-2">
          <Button variant="ghost" size="sm" @click="dismiss">
            {{ t('onboarding.skip') }}
          </Button>
          <Button size="sm" @click="next">
            {{ step < steps.length - 1 ? t('onboarding.next') : t('onboarding.finish') }}
          </Button>
        </div>
      </div>
    </div>
  </div>
</template>
