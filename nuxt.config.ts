import tailwindcss from '@tailwindcss/vite'

export default defineNuxtConfig({
  compatibilityDate: '2025-01-01',
  devtools: { enabled: true },

  future: {
    compatibilityVersion: 4,
  },

  modules: [
    '@nuxt/eslint',
    '@nuxtjs/color-mode',
    '@nuxtjs/i18n',
    '@sentry/nuxt/module',
    '@vueuse/nuxt',
    'nuxt-auth-utils',
    'shadcn-nuxt',
  ],

  // Sentry — picks up SENTRY_DSN from process.env at runtime. Module
  // is a no-op when DSN is unset, so deploying without observability
  // still works.
  sentry: {
    sourceMapsUploadOptions: { enabled: false },
  },

  i18n: {
    locales: [
      { code: 'en', name: 'English', file: 'en.json' },
      { code: 'ru', name: 'Русский', file: 'ru.json' },
    ],
    defaultLocale: 'en',
    strategy: 'no_prefix',
    detectBrowserLanguage: {
      useCookie: true,
      cookieKey: 'codegraph-i18n',
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
    plugins: [tailwindcss()],
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
      title: 'CodeGraph',
      meta: [
        { charset: 'utf-8' },
        { name: 'viewport', content: 'width=device-width, initial-scale=1' },
        { name: 'description', content: 'AI assistant for understanding codebases' },
      ],
    },
  },

  runtimeConfig: {
    databaseUrl: process.env.DATABASE_URL ?? '',
    redisUrl: process.env.REDIS_URL ?? '',
    openaiApiKey: process.env.OPENAI_API_KEY ?? '',
    openaiModelExtraction: process.env.OPENAI_MODEL_EXTRACTION ?? 'gpt-4o-mini',
    openaiModelPlanning: process.env.OPENAI_MODEL_PLANNING ?? 'gpt-4o',
    openaiEmbeddingModel:
      process.env.OPENAI_EMBEDDING_MODEL ?? 'text-embedding-3-small',
    encryptionKey: process.env.ENCRYPTION_KEY ?? '',
    maxRepoSizeMb: Number(process.env.MAX_REPO_SIZE_MB ?? 200),
    maxFilesPerIndex: Number(process.env.MAX_FILES_PER_INDEX ?? 2000),
    llmBudgetUsdPerIndex: Number(process.env.LLM_BUDGET_USD_PER_INDEX ?? 2),
    processRole: process.env.PROCESS_ROLE ?? 'web',

    // nuxt-auth-utils wires session and OAuth from these keys
    session: {
      password: process.env.NUXT_SESSION_PASSWORD ?? '',
      name: 'codegraph-session',
      cookie: {
        sameSite: 'lax',
      },
    },
    oauth: {
      github: {
        clientId: process.env.GITHUB_CLIENT_ID ?? '',
        clientSecret: process.env.GITHUB_CLIENT_SECRET ?? '',
      },
    },

    public: {
      appUrl: process.env.APP_URL ?? 'http://localhost:3000',
    },
  },
})
