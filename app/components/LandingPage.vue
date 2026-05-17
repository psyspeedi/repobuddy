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

// Each feature gets a distinct tint so the cards read as a colourful
// grid rather than six identical boxes. Colors come from Tailwind's
// default palette and work in both light/dark themes.
const features = computed(() => [
  { key: '0', icon: MessageSquare, tint: 'bg-violet-500/15 text-violet-600 dark:text-violet-300 ring-violet-500/30' },
  { key: '1', icon: Workflow, tint: 'bg-sky-500/15 text-sky-600 dark:text-sky-300 ring-sky-500/30' },
  { key: '2', icon: Network, tint: 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-300 ring-emerald-500/30' },
  { key: '3', icon: GitCommit, tint: 'bg-rose-500/15 text-rose-600 dark:text-rose-300 ring-rose-500/30' },
  { key: '4', icon: BookOpen, tint: 'bg-amber-500/15 text-amber-600 dark:text-amber-300 ring-amber-500/30' },
  { key: '5', icon: Activity, tint: 'bg-fuchsia-500/15 text-fuchsia-600 dark:text-fuchsia-300 ring-fuchsia-500/30' },
])
</script>

<template>
  <div class="space-y-16 py-8">
    <!-- Hero -->
    <section class="space-y-6 text-center">
      <h1 class="mx-auto max-w-3xl text-4xl font-bold tracking-tight sm:text-5xl">
        <span class="cg-gradient-text">{{ t('landing.hero.title') }}</span>
      </h1>
      <p class="mx-auto max-w-2xl text-lg text-muted-foreground">
        {{ t('landing.hero.subtitle') }}
      </p>
      <div class="flex flex-wrap justify-center gap-3">
        <a v-if="!loggedIn" href="/auth/github">
          <Button size="lg" class="shadow-lg shadow-primary/30">
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
          class="space-y-3 rounded-xl border border-border bg-card p-5 transition hover:-translate-y-0.5 hover:shadow-md hover:shadow-primary/10"
        >
          <span
            class="inline-flex h-10 w-10 items-center justify-center rounded-lg ring-1"
            :class="f.tint"
          >
            <component :is="f.icon" class="h-5 w-5" />
          </span>
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
          class="rounded-full border border-primary/20 bg-primary/5 px-3 py-1 text-primary"
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
