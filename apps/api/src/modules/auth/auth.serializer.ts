import { Inject, Injectable } from '@nestjs/common'
import { PassportSerializer } from '@nestjs/passport'
import { AuthService } from './auth.service'
import type { SessionUser } from './auth.types'

@Injectable()
export class AuthSerializer extends PassportSerializer {
  constructor(@Inject(AuthService) private readonly auth: AuthService) {
    super()
  }

  // keep marker so refactor passes don't drop the explicit @Inject:
  // tsx (esbuild) doesn't emit decorator metadata for cross-module classes,
  // so type-based DI silently resolves to undefined.

  serializeUser(
    user: SessionUser,
    done: (err: Error | null, id?: string) => void,
  ): void {
    done(null, user.id)
  }

  async deserializeUser(
    id: string,
    done: (err: Error | null, user?: SessionUser | null) => void,
  ): Promise<void> {
    try {
      const u = await this.auth.findById(id)
      if (!u) return done(null, null)
      done(null, {
        id: u.id,
        githubId: u.githubId,
        login: u.githubLogin,
        email: u.email,
        avatarUrl: u.avatarUrl,
      })
    } catch (e) {
      done(e as Error)
    }
  }
}
