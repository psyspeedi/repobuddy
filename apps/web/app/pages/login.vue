<script setup lang="ts">

definePageMeta({ layout: 'default', auth: false })

const { t } = useI18n()
const route = useRoute()
const errorMessage = computed(() => {
  if (route.query.error === 'github_auth_failed') {
    return t('login.errorGithub')
  }
  return null
})

useHead({ title: () => `${t('login.title')} — RepoBuddy` })
</script>

<template>
  <div class="mx-auto flex min-h-[60vh] max-w-md flex-col items-center justify-center space-y-6">
    <div class="space-y-2 text-center">
      <h1 class="text-2xl font-bold tracking-tight">
        {{ t('login.title') }}
      </h1>
      <p class="text-sm text-muted-foreground">
        {{ t('login.subtitle') }}
      </p>
    </div>

    <p
      v-if="errorMessage"
      class="rounded-md border border-destructive bg-destructive/10 px-3 py-2 text-sm text-destructive"
    >
      {{ errorMessage }}
    </p>

    <a href="/auth/github" class="w-full">
      <Button class="w-full" size="lg">
        {{ t('login.button') }}
      </Button>
    </a>

    <p class="text-center text-xs text-muted-foreground">
      {{ t('login.permissionNote') }}
    </p>
  </div>
</template>
