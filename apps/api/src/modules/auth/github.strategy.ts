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
    const apiUrl = process.env.API_URL ?? 'http://localhost:3001'
    super({
      clientID: env.GITHUB_CLIENT_ID,
      clientSecret: env.GITHUB_CLIENT_SECRET,
      callbackURL: `${apiUrl}/api/auth/github/callback`,
      scope: ['read:user', 'user:email', 'public_repo'],
      // CSRF defence — passport-oauth2 generates a random `state`, parks
      // it in req.session, and rejects callbacks whose state doesn't
      // match. Requires express-session to be registered before
      // passport.initialize() (see main.ts).
      state: true,
    })
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
