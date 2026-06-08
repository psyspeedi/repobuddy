<script setup lang="ts">
/**
 * Custom error page. Nuxt invokes this for unhandled router errors
 * (404, 500, etc). Default Nuxt error UI is indexable; we want every
 * error response noindexed and visually consistent with the rest of
 * the app.
 */

interface Props {
  error: { statusCode: number; statusMessage?: string; message?: string }
}
const props = defineProps<Props>()
const { t } = useI18n()

useHead({
  title: () => `${props.error.statusCode} — RepoBuddy`,
  meta: [{ name: 'robots', content: 'noindex, nofollow' }],
})

async function home(): Promise<void> {
  await clearError({ redirect: '/' })
}
</script>

<template>
  <div class="flex min-h-screen flex-col items-center justify-center bg-background p-6 text-center">
    <p class="cg-gradient-text text-8xl font-bold tabular-nums leading-none">
      {{ error.statusCode }}
    </p>
    <p class="mt-2 max-w-md text-lg text-muted-foreground">
      {{ error.statusMessage || error.message || t('errors.generic') }}
    </p>
    <Button class="mt-6" @click="home">
      {{ t('errors.home') }}
    </Button>
  </div>
</template>
