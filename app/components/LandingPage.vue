<script setup lang="ts">
import { Button } from '@/components/ui/button'
import {
  MessageSquare,
  Network,
  Workflow,
  GitCommit,
  BookOpen,
  Activity,
} from 'lucide-vue-next'

const { t } = useI18n()
const { loggedIn } = useUserSession()

const features = computed(() => [
  { key: '0', icon: MessageSquare },
  { key: '1', icon: Workflow },
  { key: '2', icon: Network },
  { key: '3', icon: GitCommit },
  { key: '4', icon: BookOpen },
  { key: '5', icon: Activity },
])
</script>

<template>
  <div class="space-y-16 py-8">
    <!-- Hero -->
    <section class="space-y-6 text-center">
      <h1 class="mx-auto max-w-3xl text-4xl font-bold tracking-tight sm:text-5xl">
        {{ t('landing.hero.title') }}
      </h1>
      <p class="mx-auto max-w-2xl text-lg text-muted-foreground">
        {{ t('landing.hero.subtitle') }}
      </p>
      <div class="flex flex-wrap justify-center gap-3">
        <a v-if="!loggedIn" href="/auth/github">
          <Button size="lg">
            {{ t('landing.hero.cta') }}
          </Button>
        </a>
        <NuxtLink v-else to="/" @click.prevent="$router.replace('/')">
          <Button size="lg" variant="outline">
            {{ t('landing.hero.cta2') }}
          </Button>
        </NuxtLink>
      </div>
    </section>

    <!-- Features -->
    <section class="space-y-6">
      <h2 class="text-center text-2xl font-semibold">
        {{ t('landing.features.title') }}
      </h2>
      <div class="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <div
          v-for="f in features"
          :key="f.key"
          class="space-y-2 rounded-lg border border-border bg-card p-5"
        >
          <component :is="f.icon" class="h-5 w-5 text-primary" />
          <h3 class="font-semibold">
            {{ t(`landing.features.items.${f.key}.title`) }}
          </h3>
          <p class="text-sm text-muted-foreground">
            {{ t(`landing.features.items.${f.key}.body`) }}
          </p>
        </div>
      </div>
    </section>

    <!-- Stack -->
    <section class="space-y-3">
      <h2 class="text-center text-lg font-semibold uppercase tracking-wide text-muted-foreground">
        {{ t('landing.stack.title') }}
      </h2>
      <div class="flex flex-wrap justify-center gap-2 text-xs">
        <span
          v-for="i in [0, 1, 2, 3, 4, 5]"
          :key="i"
          class="rounded-full border border-border bg-card px-3 py-1"
        >
          {{ t(`landing.stack.items.${i}`) }}
        </span>
      </div>
    </section>

    <!-- Footer -->
    <footer class="border-t border-border pt-6 text-center text-xs text-muted-foreground">
      {{ t('landing.footer') }}
    </footer>
  </div>
</template>
