<script setup lang="ts">
/**
 * "Want more limits?" button. Visible to authenticated, non-bypass
 * users only (admins and BYOK people aren't the target audience).
 *
 * One click per user: after the first submission the button disables
 * and shows a thank-you state. Admin sees aggregated pings on /admin.
 *
 * Visual goal: noticeable but not pushy — a subtle pill in the header
 * area, glow on hover, no banner / popup nag.
 */
import { Sparkles, Check } from 'lucide-vue-next'

interface Props {
  bypass: boolean
}
const props = defineProps<Props>()
const { t } = useI18n()
const { loggedIn } = useUserSession()

const show = computed(() => loggedIn.value && !props.bypass)

interface InterestState { sent: boolean; sentAt: string | null }
const { data: state, refresh } = useFetch<InterestState>('/api/me/interest', {
  default: () => ({ sent: false, sentAt: null }),
  // Avoid SSR'ing this for guests — the endpoint 401's and noise floods the logs.
  immediate: false,
})

watch(show, async (v) => { if (v) await refresh() }, { immediate: true })

const open = ref(false)
const message = ref('')
const submitting = ref(false)

async function submit(): Promise<void> {
  if (submitting.value) return
  submitting.value = true
  try {
    await $fetch('/api/me/interest', {
      method: 'POST',
      body: { kind: 'more_limits', message: message.value.trim() || undefined },
    })
    open.value = false
    message.value = ''
    await refresh()
  } catch (err) {
    useToast().error(err instanceof Error ? err.message : t('interest.failed'))
  } finally {
    submitting.value = false
  }
}
</script>

<template>
  <span v-if="show" class="relative">
    <button
      v-if="!state?.sent"
      type="button"
      class="inline-flex items-center gap-1.5 rounded-full border border-amber-500/40 bg-gradient-to-r from-amber-500/10 to-fuchsia-500/10 px-3 py-1 text-xs font-medium text-amber-700 transition hover:from-amber-500/20 hover:to-fuchsia-500/20 hover:shadow-sm hover:shadow-amber-500/20 dark:text-amber-300"
      :title="t('interest.title')"
      @click="open = true"
    >
      <Sparkles class="h-3 w-3" />
      <span class="hidden sm:inline">{{ t('interest.cta') }}</span>
    </button>
    <span
      v-else
      class="inline-flex items-center gap-1.5 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-3 py-1 text-xs font-medium text-emerald-700 dark:text-emerald-300"
      :title="t('interest.sentTitle')"
    >
      <Check class="h-3 w-3" />
      <span class="hidden sm:inline">{{ t('interest.sentLabel') }}</span>
    </span>

    <!-- Modal — teleported to <body> so the header's backdrop-filter
         doesn't pull `position: fixed` into a new containing block,
         which previously offset the modal toward the header instead
         of the viewport. -->
    <Teleport to="body">
    <div
      v-if="open"
      class="fixed inset-0 z-50 flex items-center justify-center bg-background/80 p-4 backdrop-blur"
      @click.self="open = false"
    >
      <div class="w-full max-w-md space-y-4 rounded-xl border border-amber-500/30 bg-card p-5 shadow-xl">
        <div class="space-y-1">
          <h3 class="flex items-center gap-2 text-lg font-semibold">
            <Sparkles class="h-5 w-5 text-amber-500" />
            {{ t('interest.modalTitle') }}
          </h3>
          <p class="text-sm text-muted-foreground">
            {{ t('interest.modalBody') }}
          </p>
        </div>
        <label class="block space-y-1 text-sm">
          <span class="text-xs font-medium text-muted-foreground">{{ t('interest.messageLabel') }}</span>
          <textarea
            v-model="message"
            rows="3"
            maxlength="500"
            :placeholder="t('interest.messagePlaceholder')"
            class="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
          />
        </label>
        <div class="flex items-center justify-end gap-2">
          <Button variant="ghost" size="sm" :disabled="submitting" @click="open = false">
            {{ t('interest.cancel') }}
          </Button>
          <Button size="sm" :disabled="submitting" @click="submit">
            {{ submitting ? t('interest.sending') : t('interest.send') }}
          </Button>
        </div>
      </div>
    </div>
    </Teleport>
  </span>
</template>
