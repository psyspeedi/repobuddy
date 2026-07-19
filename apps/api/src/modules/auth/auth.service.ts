import { Inject, Injectable, Logger } from '@nestjs/common'
import { eq } from 'drizzle-orm'
import { encrypt } from '#server/lib/crypto'
import { oauthTokens, users, type User } from '#server/db/schema'
import { TypedConfigService } from '../config/typed-config.service'
import { DRIZZLE_DB, type DrizzleDb } from '../drizzle/drizzle.tokens'

interface GithubProfile {
  id: string | number
  login: string
  email: string | null
  avatarUrl: string | null
}

interface GithubTokens {
  access_token: string
  refresh_token?: string | undefined
  scope?: string | undefined
}

@Injectable()
export class AuthService {
  private readonly log = new Logger(AuthService.name)
  private adminCache: Set<string> | null = null

  constructor(
    @Inject(DRIZZLE_DB) private readonly db: DrizzleDb,
    @Inject(TypedConfigService) private readonly config: TypedConfigService,
  ) {}

  async upsertUserFromGithub(
    profile: GithubProfile,
    tokens: GithubTokens,
  ): Promise<User> {
    const githubIdStr = String(profile.id)
    let [dbUser] = await this.db
      .select()
      .from(users)
      .where(eq(users.githubId, githubIdStr))
      .limit(1)

    if (!dbUser) {
      const [inserted] = await this.db
        .insert(users)
        .values({
          githubId: githubIdStr,
          githubLogin: profile.login,
          email: profile.email,
          avatarUrl: profile.avatarUrl,
        })
        .returning()
      if (!inserted) throw new Error('user insert returned no row')
      dbUser = inserted
      this.log.log(`created new user ${dbUser.id} (${profile.login})`)
    } else {
      this.log.log(`existing user logged in ${dbUser.id} (${profile.login})`)
    }

    if (tokens.access_token) {
      const encKey = this.config.get('ENCRYPTION_KEY')
      const encryptedAccess = encrypt(tokens.access_token, encKey)
      const encryptedRefresh = tokens.refresh_token
        ? encrypt(tokens.refresh_token, encKey)
        : null
      await this.db
        .insert(oauthTokens)
        .values({
          userId: dbUser.id,
          provider: 'github',
          encryptedAccessToken: encryptedAccess,
          encryptedRefreshToken: encryptedRefresh,
          scope: tokens.scope ?? null,
        })
        .onConflictDoUpdate({
          target: [oauthTokens.userId, oauthTokens.provider],
          set: {
            encryptedAccessToken: encryptedAccess,
            encryptedRefreshToken: encryptedRefresh,
            scope: tokens.scope ?? null,
            updatedAt: new Date(),
          },
        })
    }

    return dbUser
  }

  async findById(id: string): Promise<User | null> {
    const [u] = await this.db.select().from(users).where(eq(users.id, id)).limit(1)
    return u ?? null
  }

  isAdmin(login: string | null | undefined): boolean {
    if (!login) return false
    if (!this.adminCache) {
      this.adminCache = new Set(
        this.config
          .get('ADMIN_LOGINS')
          .split(',')
          .map((s) => s.trim().toLowerCase())
          .filter(Boolean),
      )
    }
    return this.adminCache.has(login.toLowerCase())
  }
}
