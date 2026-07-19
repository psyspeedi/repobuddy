import { Octokit } from '@octokit/rest'
import { loadEnv } from './env'

/**
 * Central Octokit factory for every GitHub API caller (kag operators,
 * PR-history indexing). Anonymous clients get 60 req/h per IP — fine
 * for a demo, painful in real use. When GITHUB_TOKEN is set the client
 * authenticates and the budget grows to 5000 req/h.
 */
export function createOctokit(): Octokit {
  const env = loadEnv()
  return env.GITHUB_TOKEN ? new Octokit({ auth: env.GITHUB_TOKEN }) : new Octokit()
}
