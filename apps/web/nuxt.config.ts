import tailwindcss from '@tailwindcss/vite'
import { fileURLToPath } from 'node:url'
import { resolve, dirname } from 'node:path'

const dir = dirname(fileURLToPath(import.meta.url))

export default defineNuxtConfig({
  alias: {
    '#shared': resolve(dir, '../../packages/shared/src'),
  },
  compatibilityDate: '2025-01-01',
  devtools: { enabled: true },

  future: {
    compatibilityVersion: 4,
  },

  modules: [
    '@nuxt/eslint',
    '@nuxtjs/color-mode',
    '@nuxtjs/i18n',
    '@vueuse/nuxt',
    'shadcn-nuxt',
    // Local: drops shadcn-nuxt's duplicate Button (index.ts barrel +
    // Button.vue both register as "Button" → boot warning).
    './modules/dedupe-components',
  ],

  i18n: {
    // Russian plural rules live here — see i18n.config.ts.
    vueI18n: './i18n.config.ts',
    locales: [
      { code: 'en', name: 'English', file: 'en.json' },
      { code: 'ru', name: 'Русский', file: 'ru.json' },
    ],
    defaultLocale: 'en',
    strategy: 'no_prefix',
    detectBrowserLanguage: {
      useCookie: true,
      cookieKey: 'repobuddy-i18n',
      redirectOn: 'root',
    },
  },

  colorMode: {
    classSuffix: '',
    preference: 'dark',
    fallback: 'dark',
  },

  css: ['~/assets/css/tailwind.css'],

  vite: {
    // @tailwindcss/vite ships its own bundled vite types; Nuxt 4
    // bundles vite 5 — duplicate type identity, identical shape.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    plugins: [tailwindcss() as any],
    optimizeDeps: {
      include: [
        '@vue/devtools-core',
        '@vue/devtools-kit',
        'class-variance-authority',
        'clsx',
        'reka-ui',
        'tailwind-merge',
        'lucide-vue-next',
      ],
    },
  },

  shadcn: {
    prefix: '',
    componentDir: './app/components/ui',
  },

  typescript: {
    strict: true,
    typeCheck: false,
    tsConfig: {
      compilerOptions: {
        noUncheckedIndexedAccess: true,
        noImplicitOverride: true,
        noFallthroughCasesInSwitch: true,
        noImplicitReturns: true,
        forceConsistentCasingInFileNames: true,
      },
    },
  },

  app: {
    head: {
      title: 'RepoBuddy — AI assistant for understanding codebases',
      titleTemplate: '%s',
      htmlAttrs: { lang: 'en' },
      meta: [
        { charset: 'utf-8' },
        { name: 'viewport', content: 'width=device-width, initial-scale=1' },
        {
          name: 'description',
          content:
            'RepoBuddy indexes a Git repository into a hybrid knowledge graph (AST + LLM annotations + git history) and answers questions in plain language with cited sources. Supports TypeScript, JavaScript, Python, Go.',
        },
        { name: 'keywords', content: 'codebase, AI, knowledge graph, code search, KAG, RAG, OpenAI, AST, TypeScript, Python, Go' },
        { property: 'og:type', content: 'website' },
        { property: 'og:site_name', content: 'RepoBuddy' },
        { property: 'og:title', content: 'RepoBuddy — AI assistant for codebases' },
        {
          property: 'og:description',
          content:
            'Ask questions about any Git repo and get cited answers. AST + LLM annotations + git history fused into one knowledge graph.',
        },
        { property: 'og:image', content: 'https://repobuddy.space/og.webp' },
        { property: 'og:image:width', content: '1200' },
        { property: 'og:image:height', content: '630' },
        { property: 'og:image:type', content: 'image/webp' },
        { property: 'og:url', content: 'https://repobuddy.space/' },
        { name: 'twitter:card', content: 'summary_large_image' },
        { name: 'twitter:title', content: 'RepoBuddy — AI assistant for codebases' },
        { name: 'twitter:description', content: 'Ask questions about any Git repo and get cited answers.' },
        { name: 'twitter:image', content: 'https://repobuddy.space/og.webp' },
        { name: 'theme-color', content: '#7e6cf3' },
        { name: 'robots', content: 'index, follow' },
      ],
      link: [
        { rel: 'preconnect', href: 'https://fonts.googleapis.com' },
        { rel: 'preconnect', href: 'https://fonts.gstatic.com', crossorigin: '' },
        {
          rel: 'stylesheet',
          href: 'https://fonts.googleapis.com/css2?family=Architects+Daughter&family=Nunito:wght@400;500;600;700;800&display=swap',
        },
        { rel: 'icon', type: 'image/x-icon', href: '/favicon.ico' },
        { rel: 'icon', type: 'image/svg+xml', href: '/favicon.svg' },
        { rel: 'icon', type: 'image/png', sizes: '96x96', href: '/favicon-96x96.png' },
        { rel: 'apple-touch-icon', sizes: '180x180', href: '/apple-touch-icon.png' },
        { rel: 'manifest', href: '/site.webmanifest' },
      ],
    },
  },

  runtimeConfig: {
    public: {
      appUrl: process.env.APP_URL ?? 'http://localhost:3000',
      // After the NestJS migration the API lives on a separate origin.
      // useApi() / useApiFetch() prepend this to every request.
      apiBaseUrl: process.env.API_BASE_URL ?? 'http://localhost:3001',
    },
  },
})
