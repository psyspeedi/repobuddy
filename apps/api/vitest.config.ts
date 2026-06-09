import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'
import { resolve, dirname } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  test: {
    environment: 'node',
    globals: false,
    include: ['test/**/*.{test,spec}.ts'],
    exclude: ['node_modules', '.output', 'dist'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      exclude: [
        'node_modules/',
        '.output/',
        'test/',
        '**/*.config.ts',
        '**/*.d.ts',
      ],
    },
    // Integration tests share a single Postgres + Redis instance; force
    // sequential file execution to avoid TRUNCATE races and stale BullMQ
    // jobs leaking across suites.
    fileParallelism: false,
    pool: 'forks',
    poolOptions: {
      forks: { singleFork: true },
    },
  },
  resolve: {
    alias: [
      { find: '#shared', replacement: resolve(__dirname, '../../packages/shared/src') },
      { find: /^#server\/db\//, replacement: resolve(__dirname, './src/db') + '/' },
      { find: /^#server\/lib\//, replacement: resolve(__dirname, './src/lib') + '/' },
      { find: /^#server\/kag\//, replacement: resolve(__dirname, './src/modules/kag/internals') + '/' },
      { find: /^#server\/indexer\//, replacement: resolve(__dirname, './src/modules/indexer/internals') + '/' },
      { find: /^#server\/providers\//, replacement: resolve(__dirname, './src/modules/providers/internals') + '/' },
      { find: /^#modules\//, replacement: resolve(__dirname, './src/modules') + '/' },
      { find: /^#common\//, replacement: resolve(__dirname, './src/common') + '/' },
    ],
  },
})
