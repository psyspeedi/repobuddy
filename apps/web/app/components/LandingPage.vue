<script setup lang="ts">
import {
  Compass,
  Github,
  Terminal,
  Workflow,
  MessageSquare,
  Activity,
} from 'lucide-vue-next'

const { t } = useI18n()
const { loggedIn } = useAuth()
const { public: { apiBaseUrl } } = useRuntimeConfig()
const githubAuthUrl = `${apiBaseUrl}/auth/github`

// Each feature gets a distinct tint so the cards read as a colourful
// grid rather than six identical boxes. Colors come from Tailwind's
// default palette and work in both light/dark themes.
// Order = the contributor journey: get oriented → find work → run
// it locally → understand a flow → ask questions → judge project
// health. Each icon picks up the dominant action of its card.
const features = computed(() => [
  { key: '0', icon: Compass, tint: 'bg-violet-500/15 text-violet-600 dark:text-violet-300 ring-violet-500/30' },
  { key: '1', icon: Github, tint: 'bg-sky-500/15 text-sky-600 dark:text-sky-300 ring-sky-500/30' },
  { key: '2', icon: Terminal, tint: 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-300 ring-emerald-500/30' },
  { key: '3', icon: Workflow, tint: 'bg-rose-500/15 text-rose-600 dark:text-rose-300 ring-rose-500/30' },
  { key: '4', icon: MessageSquare, tint: 'bg-amber-500/15 text-amber-600 dark:text-amber-300 ring-amber-500/30' },
  { key: '5', icon: Activity, tint: 'bg-fuchsia-500/15 text-fuchsia-600 dark:text-fuchsia-300 ring-fuchsia-500/30' },
])

interface PublicWorkspace {
  id: string
  name: string
  sourceUrl: string | null
  languages: string[]
  ownerLogin: string | null
}

// Fetch on-demand (guests don't have auth, so this endpoint is open).
// useFetch is fine here — runs once, cached, SSR-friendly.
const { data: publicList } = await useApiFetch<{ workspaces: PublicWorkspace[] }>(
  '/api/workspaces/public',
  { default: () => ({ workspaces: [] }) },
)

// SEO: canonical URL + JSON-LD SoftwareApplication block. The
// canonical depends on APP_URL which is only available at runtime
// (nuxt.config.ts can't read it), so it's set here.
const runtime = useRuntimeConfig()
const canonicalUrl = (runtime.public.appUrl as string | undefined) ?? 'http://localhost:3000'
useHead({
  link: [
    { rel: 'canonical', href: canonicalUrl + '/' },
    // hreflang alternates — the landing is served bilingually via i18n
    // (cookie-driven, same URL). Tell Google both locales exist so it
    // doesn't pick a "preferred" version arbitrarily.
    { rel: 'alternate', hreflang: 'en', href: canonicalUrl + '/' },
    { rel: 'alternate', hreflang: 'ru', href: canonicalUrl + '/' },
    { rel: 'alternate', hreflang: 'x-default', href: canonicalUrl + '/' },
  ],
  script: [
    {
      type: 'application/ld+json',
      innerHTML: JSON.stringify({
        '@context': 'https://schema.org',
        '@type': 'SoftwareApplication',
        name: 'RepoBuddy',
        applicationCategory: 'DeveloperApplication',
        operatingSystem: 'Any',
        description:
          'RepoBuddy helps developers contribute to open-source projects faster. Indexes a Git repository into a knowledge graph, surfaces entrypoints, safe first-PR zones, and links GitHub issues back to the code. Supports TypeScript, JavaScript, Python, Go.',
        url: canonicalUrl,
        offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' },
      }),
    },
  ],
})
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
        <a v-if="!loggedIn" :href="githubAuthUrl">
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

    <!-- Public showcase -->
    <section v-if="publicList && publicList.workspaces.length > 0" class="space-y-4">
      <h2 class="text-center text-2xl font-semibold">
        {{ t('landing.public.title') }}
      </h2>
      <p class="mx-auto max-w-xl text-center text-sm text-muted-foreground">
        {{ t('landing.public.subtitle') }}
      </p>
      <div class="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <NuxtLink
          v-for="ws in publicList.workspaces"
          :key="ws.id"
          :to="`/w/${ws.id}`"
          class="block space-y-2 rounded-xl border border-border bg-card p-4 transition hover:-translate-y-0.5 hover:border-primary/40 hover:shadow-md hover:shadow-primary/10"
        >
          <div class="flex items-start justify-between gap-2">
            <h3 class="truncate font-semibold">
              {{ ws.name }}
            </h3>
            <span class="rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2 py-0.5 text-[10px] font-medium text-emerald-700 dark:text-emerald-300">
              {{ t('workspace.publicBadge') }}
            </span>
          </div>
          <p v-if="ws.ownerLogin" class="text-xs text-muted-foreground">
            @{{ ws.ownerLogin }}
          </p>
          <div v-if="ws.languages.length > 0" class="flex flex-wrap gap-1 text-[10px]">
            <span
              v-for="lang in ws.languages.slice(0, 4)"
              :key="lang"
              class="rounded bg-primary/10 px-1.5 py-0.5 text-primary"
            >
              {{ lang }}
            </span>
          </div>
        </NuxtLink>
      </div>
    </section>

    <!-- For maintainers. The other blocks address the contributor
         arriving at a repo; this one addresses the person who owns it,
         for whom onboarding is a recurring cost rather than a one-off. -->
    <section class="space-y-6 rounded-2xl border border-primary/20 bg-primary/5 p-6 sm:p-8">
      <div class="space-y-2 text-center">
        <h2 class="text-2xl font-semibold">
          {{ t('landing.maintainers.title') }}
        </h2>
        <p class="mx-auto max-w-2xl text-sm text-muted-foreground">
          {{ t('landing.maintainers.subtitle') }}
        </p>
      </div>
      <ol class="grid gap-4 sm:grid-cols-3">
        <li
          v-for="(step, i) in [0, 1, 2]"
          :key="step"
          class="space-y-2 rounded-xl border border-border bg-card p-4"
        >
          <span class="inline-flex h-7 w-7 items-center justify-center rounded-full bg-primary/15 text-sm font-semibold text-primary ring-1 ring-primary/30">
            {{ i + 1 }}
          </span>
          <h3 class="font-semibold">
            {{ t(`landing.maintainers.steps.${step}.title`) }}
          </h3>
          <p class="text-sm text-muted-foreground">
            {{ t(`landing.maintainers.steps.${step}.body`) }}
          </p>
        </li>
      </ol>
      <p class="text-center text-sm font-medium">
        {{ t('landing.maintainers.note') }}
      </p>
      <!-- Step 1 needs an account, and the only way to get one is four
           screens up in the hero. Same action, repeated where the
           reader has just decided this section is about them. -->
      <div class="flex justify-center">
        <a v-if="!loggedIn" :href="githubAuthUrl">
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

    <!-- Supported languages -->
    <section class="space-y-3">
      <h2 class="text-center text-lg font-semibold uppercase tracking-wide text-muted-foreground">
        {{ t('landing.languages.title') }}
      </h2>
      <p class="mx-auto max-w-xl text-center text-sm text-muted-foreground">
        {{ t('landing.languages.subtitle') }}
      </p>
      <div class="flex flex-wrap justify-center gap-2 text-sm font-medium">
        <span class="rounded-full border border-sky-500/30 bg-sky-500/10 px-3 py-1 text-sky-700 dark:text-sky-300">TypeScript</span>
        <span class="rounded-full border border-amber-500/30 bg-amber-500/10 px-3 py-1 text-amber-700 dark:text-amber-300">JavaScript</span>
        <span class="rounded-full border border-emerald-500/30 bg-emerald-500/10 px-3 py-1 text-emerald-700 dark:text-emerald-300">Python</span>
        <span class="rounded-full border border-cyan-500/30 bg-cyan-500/10 px-3 py-1 text-cyan-700 dark:text-cyan-300">Go</span>
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
