import { Inject, Injectable } from '@nestjs/common'
import { PassportStrategy } from '@nestjs/passport'
import { Strategy, type Profile } from 'passport-github2'
import { TypedConfigService } from '../config/typed-config.service'
import { AuthService } from './auth.service'
import type { SessionUser } from './auth.types'

@Injectable()
export class GithubStrategy extends PassportStrategy(Strategy, 'github') {
  constructor(
    @Inject(TypedConfigService) config: TypedConfigService,
    @Inject(AuthService) private readonly auth: AuthService,
  ) {
    const env = config.all()
    // `||` not `??`: compose passes API_URL through as an empty string
    // when the operator leaves it unset, and an empty base would build a
    // relative, invalid OAuth callback. Fall back on empty too.
    const apiUrl = process.env.API_URL || 'http://localhost:3001'
    // CSRF defence — passport-oauth2 generates a random `state`, parks
    // it in req.session, and rejects callbacks whose state doesn't
    // match. passport-github2 types declare `state` as string, but the
    // underlying passport-oauth2 accepts boolean `true` for auto-gen.
    // Casting to keep the runtime behaviour without fighting the type.
    super({
      clientID: env.GITHUB_CLIENT_ID,
      clientSecret: env.GITHUB_CLIENT_SECRET,
      callbackURL: `${apiUrl}/auth/github/callback`,
      scope: ['read:user', 'user:email', 'public_repo'],
      state: true,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any)
  }

  async validate(
    accessToken: string,
    refreshToken: string | undefined,
    profile: Profile,
  ): Promise<SessionUser> {
    const email = profile.emails?.[0]?.value ?? null
    const avatarUrl = profile.photos?.[0]?.value ?? null
    const dbUser = await this.auth.upsertUserFromGithub(
      {
        id: profile.id,
        login: profile.username ?? '',
        email,
        avatarUrl,
      },
      {
        access_token: accessToken,
        refresh_token: refreshToken,
        scope: 'read:user user:email public_repo',
      },
    )
    return {
      id: dbUser.id,
      githubId: dbUser.githubId,
      login: dbUser.githubLogin,
      email: dbUser.email,
      avatarUrl: dbUser.avatarUrl,
    }
  }
}
