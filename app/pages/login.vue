<script setup lang="ts">
import { Button } from '@/components/ui/button'

definePageMeta({ layout: 'default', auth: false })

const route = useRoute()
const errorMessage = computed(() => {
  if (route.query.error === 'github_auth_failed') {
    return 'GitHub authentication failed. Please try again.'
  }
  return null
})

useHead({ title: 'Sign in — CodeGraph' })
</script>

<template>
  <div class="mx-auto flex min-h-[60vh] max-w-md flex-col items-center justify-center space-y-6">
    <div class="space-y-2 text-center">
      <h1 class="text-2xl font-bold tracking-tight">
        Welcome to CodeGraph
      </h1>
      <p class="text-sm text-muted-foreground">
        Sign in with GitHub to index and explore repositories.
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
        Continue with GitHub
      </Button>
    </a>

    <p class="text-center text-xs text-muted-foreground">
      We only read public profile info, your email, and public repos.
    </p>
  </div>
</template>
