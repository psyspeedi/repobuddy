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
    // Local: drops shadcn-nuxt's duplicate Button (index.ts barrel +
    // Button.vue both register as "Button" → boot warning).
    './modules/dedupe-components',
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
    optimizeDeps: {
      // Pre-bundle these so Vite doesn't re-bundle on first navigation
      // (it logs "discovered new dependencies at runtime" and triggers
      // a page reload). The list reflects what every page touches via
      // auto-imported components / composables.
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
      // Default tags applied to every page. Page-level useHead() can
      // override title / og / twitter for richer per-page metadata.
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
        // Open Graph
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
        // Twitter card
        { name: 'twitter:card', content: 'summary_large_image' },
        { name: 'twitter:title', content: 'RepoBuddy — AI assistant for codebases' },
        { name: 'twitter:description', content: 'Ask questions about any Git repo and get cited answers.' },
        { name: 'twitter:image', content: 'https://repobuddy.space/og.webp' },
        // Theme color picked up by browser chrome on mobile.
        { name: 'theme-color', content: '#7e6cf3' },
        // Robots — overridden on private pages via useHead.
        { name: 'robots', content: 'index, follow' },
      ],
      link: [
        // Google Fonts — used by the wordmark in the header. Preconnect
        // first to shave ~100ms off the first paint; display=swap so
        // text renders immediately in a fallback while the font loads.
        { rel: 'preconnect', href: 'https://fonts.googleapis.com' },
        { rel: 'preconnect', href: 'https://fonts.gstatic.com', crossorigin: '' },
        {
          rel: 'stylesheet',
          href: 'https://fonts.googleapis.com/css2?family=Architects+Daughter&family=Nunito:wght@400;500;600;700;800&display=swap',
        },
        // Favicons — multiple formats so every browser / OS picks the
        // best for its rendering pipeline.
        { rel: 'icon', type: 'image/x-icon', href: '/favicon.ico' },
        { rel: 'icon', type: 'image/svg+xml', href: '/favicon.svg' },
        { rel: 'icon', type: 'image/png', sizes: '96x96', href: '/favicon-96x96.png' },
        { rel: 'apple-touch-icon', sizes: '180x180', href: '/apple-touch-icon.png' },
        { rel: 'manifest', href: '/site.webmanifest' },
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

  // NOTE: NO SWR / prerender on `/` or `/login`.
  // The previous configuration `'/': { swr: 600 }` served the first
  // rendered HTML to every visitor for 10 minutes — but `/` shows
  // landing for guests and the workspace dashboard for authenticated
  // users. The cached HTML was leaking one user's state to everyone
  // else (and showed "no workspaces" to real users whose cache hit
  // a guest variant). Auth-dependent routes must not be cached.
})
