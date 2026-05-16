import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'
import { resolve, dirname } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  test: {
    environment: 'node',
    globals: false,
    include: ['tests/**/*.{test,spec}.ts'],
    exclude: ['node_modules', '.nuxt', '.output', 'dist'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      exclude: [
        'node_modules/',
        '.nuxt/',
        '.output/',
        'tests/',
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
    alias: {
      '@': resolve(__dirname, './app'),
      '~': resolve(__dirname, './app'),
      '#shared': resolve(__dirname, './shared'),
      '#server': resolve(__dirname, './server'),
    },
  },
})
