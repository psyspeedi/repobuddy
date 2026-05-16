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
    '@vueuse/nuxt',
    'shadcn-nuxt',
  ],

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
    databaseUrl: '',
    redisUrl: '',
    openaiApiKey: '',
    openaiModelExtraction: 'gpt-4o-mini',
    openaiModelPlanning: 'gpt-4o',
    openaiEmbeddingModel: 'text-embedding-3-small',
    githubClientId: '',
    githubClientSecret: '',
    encryptionKey: '',
    maxRepoSizeMb: 200,
    maxFilesPerIndex: 2000,
    llmBudgetUsdPerIndex: 2,
    processRole: 'web',
    public: {
      appUrl: 'http://localhost:3000',
    },
  },
})
