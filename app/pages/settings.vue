<script setup lang="ts">
import { Key, Check, AlertCircle } from 'lucide-vue-next'

const { t } = useI18n()

interface ByokState {
  configured: boolean
  baseUrl: string | null
  model: string | null
  embeddingModel: string | null
}

const { data: byok, refresh } = await useFetch<ByokState>('/api/me/byok')

const baseUrl = ref(byok.value?.baseUrl ?? '')
const model = ref(byok.value?.model ?? '')
const embeddingModel = ref(byok.value?.embeddingModel ?? '')
const apiKey = ref('')

const saving = ref(false)
const message = ref<{ kind: 'ok' | 'error'; text: string } | null>(null)

async function save(): Promise<void> {
  if (saving.value) return
  saving.value = true
  message.value = null
  try {
    await $fetch('/api/me/byok', {
      method: 'PUT',
      body: {
        baseUrl: baseUrl.value.trim() || null,
        model: model.value.trim() || null,
        embeddingModel: embeddingModel.value.trim() || null,
        // Only send apiKey when the user typed something — empty string
        // means "leave existing key alone".
        ...(apiKey.value.trim() ? { apiKey: apiKey.value.trim() } : {}),
      },
    })
    apiKey.value = ''
    await refresh()
    message.value = { kind: 'ok', text: t('settings.saved') }
  } catch (err) {
    message.value = {
      kind: 'error',
      text: err instanceof Error ? err.message : t('settings.saveFailed'),
    }
  } finally {
    saving.value = false
  }
}

async function clearByok(): Promise<void> {
  if (saving.value) return
  const ok = await useConfirm().ask({
    title: t('settings.clearConfirm'),
    body: t('settings.clearConfirmBody'),
    confirmLabel: t('settings.clear'),
    destructive: true,
  })
  if (!ok) return
  saving.value = true
  try {
    await $fetch('/api/me/byok', {
      method: 'PUT',
      body: { apiKey: null, baseUrl: null, model: null, embeddingModel: null },
    })
    baseUrl.value = ''
    model.value = ''
    embeddingModel.value = ''
    apiKey.value = ''
    await refresh()
    message.value = { kind: 'ok', text: t('settings.cleared') }
  } catch (err) {
    message.value = {
      kind: 'error',
      text: err instanceof Error ? err.message : t('settings.saveFailed'),
    }
  } finally {
    saving.value = false
  }
}

useHead(() => ({
  title: () => `${t('settings.title')} — RepoBuddy`,
  meta: [{ name: 'robots', content: 'noindex, nofollow' }],
}))
</script>

<template>
  <div class="mx-auto max-w-2xl space-y-6">
    <header class="space-y-1">
      <h1 class="text-2xl font-bold">
        {{ t('settings.title') }}
      </h1>
      <p class="text-sm text-muted-foreground">
        {{ t('settings.subtitle') }}
      </p>
    </header>

    <section class="space-y-4 rounded-xl border border-border bg-card p-5">
      <div class="flex items-center justify-between">
        <div class="flex items-center gap-2">
          <Key class="h-4 w-4 text-primary" />
          <h2 class="font-semibold">
            {{ t('settings.byokTitle') }}
          </h2>
        </div>
        <span
          v-if="byok?.configured"
          class="inline-flex items-center gap-1 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2 py-0.5 text-[11px] font-medium text-emerald-700 dark:text-emerald-300"
        >
          <Check class="h-3 w-3" />
          {{ t('settings.byokActive') }}
        </span>
      </div>
      <p class="text-sm text-muted-foreground">
        {{ t('settings.byokHelp') }}
      </p>

      <div class="space-y-3">
        <label class="block space-y-1 text-sm">
          <span class="font-medium">{{ t('settings.baseUrl') }}</span>
          <input
            v-model="baseUrl"
            type="url"
            placeholder="https://api.openai.com/v1"
            class="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
          >
          <span class="text-xs text-muted-foreground">{{ t('settings.baseUrlHint') }}</span>
        </label>
        <label class="block space-y-1 text-sm">
          <span class="font-medium">{{ t('settings.model') }}</span>
          <input
            v-model="model"
            type="text"
            placeholder="gpt-4o"
            class="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
          >
        </label>
        <label class="block space-y-1 text-sm">
          <span class="font-medium">{{ t('settings.embeddingModel') }}</span>
          <input
            v-model="embeddingModel"
            type="text"
            placeholder="text-embedding-3-small"
            class="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
          >
        </label>
        <label class="block space-y-1 text-sm">
          <span class="font-medium">{{ t('settings.apiKey') }}</span>
          <input
            v-model="apiKey"
            type="password"
            autocomplete="off"
            :placeholder="byok?.configured ? t('settings.apiKeyExistingPlaceholder') : 'sk-…'"
            class="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
          >
          <span class="text-xs text-muted-foreground">{{ t('settings.apiKeyHint') }}</span>
        </label>
      </div>

      <div v-if="message" class="flex items-center gap-2 rounded-md border px-3 py-2 text-sm" :class="message.kind === 'ok' ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300' : 'border-destructive/30 bg-destructive/10 text-destructive'">
        <Check v-if="message.kind === 'ok'" class="h-4 w-4" />
        <AlertCircle v-else class="h-4 w-4" />
        {{ message.text }}
      </div>

      <div class="flex items-center justify-end gap-2 pt-1">
        <Button v-if="byok?.configured" variant="ghost" size="sm" :disabled="saving" @click="clearByok">
          {{ t('settings.clear') }}
        </Button>
        <Button :disabled="saving" @click="save">
          {{ saving ? t('settings.saving') : t('settings.save') }}
        </Button>
      </div>
    </section>
  </div>
</template>
