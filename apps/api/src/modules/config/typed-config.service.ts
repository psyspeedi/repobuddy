import { Injectable } from '@nestjs/common'
import { loadEnv, type Env } from '#server/lib/env'

/**
 * Wraps the existing Zod-validated env loader so the rest of the app
 * receives typed config via DI. Keeps a single source of truth for
 * schema (`#server/lib/env`) — when we delete the legacy folder, the
 * schema moves to this module.
 */
@Injectable()
export class TypedConfigService {
  private readonly env: Env = loadEnv()

  get<K extends keyof Env>(key: K): Env[K] {
    return this.env[key]
  }

  all(): Readonly<Env> {
    return this.env
  }
}
