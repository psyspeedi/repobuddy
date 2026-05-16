import { eq } from 'drizzle-orm'
import { getDb } from '../../db/client'
import { oauthTokens, users } from '../../db/schema'
import { encrypt } from '../../lib/crypto'
import { getLogger } from '../../lib/logger'

const log = getLogger().child({ component: 'oauth/github' })

export default defineOAuthGitHubEventHandler({
  config: {
    emailRequired: true,
    scope: ['read:user', 'user:email', 'public_repo'],
  },

  async onSuccess(event, { user: ghUser, tokens }) {
    const config = useRuntimeConfig(event)
    const db = getDb(config.databaseUrl as string)

    const githubIdStr = String(ghUser.id)

    let [dbUser] = await db
      .select()
      .from(users)
      .where(eq(users.githubId, githubIdStr))
      .limit(1)

    if (!dbUser) {
      const [inserted] = await db
        .insert(users)
        .values({
          githubId: githubIdStr,
          githubLogin: ghUser.login as string,
          email: (ghUser.email as string | null) ?? null,
          avatarUrl: (ghUser.avatar_url as string | null) ?? null,
        })
        .returning()
      dbUser = inserted
      log.info({ userId: dbUser?.id, login: ghUser.login }, 'created new user')
    } else {
      log.info({ userId: dbUser.id, login: ghUser.login }, 'existing user logged in')
    }

    if (!dbUser) throw createError({ statusCode: 500, message: 'User row missing after insert' })

    const accessToken = (tokens as { access_token?: string }).access_token
    const refreshToken = (tokens as { refresh_token?: string }).refresh_token
    if (accessToken) {
      const encKey = config.encryptionKey as string
      const encryptedAccess = encrypt(accessToken, encKey)
      const encryptedRefresh = refreshToken ? encrypt(refreshToken, encKey) : null

      await db
        .insert(oauthTokens)
        .values({
          userId: dbUser.id,
          provider: 'github',
          encryptedAccessToken: encryptedAccess,
          encryptedRefreshToken: encryptedRefresh,
          scope: (tokens as { scope?: string }).scope ?? null,
        })
        .onConflictDoUpdate({
          target: [oauthTokens.userId, oauthTokens.provider],
          set: {
            encryptedAccessToken: encryptedAccess,
            encryptedRefreshToken: encryptedRefresh,
            scope: (tokens as { scope?: string }).scope ?? null,
            updatedAt: new Date(),
          },
        })
    }

    await setUserSession(event, {
      user: {
        id: dbUser.id,
        githubId: dbUser.githubId,
        login: dbUser.githubLogin,
        email: dbUser.email,
        avatarUrl: dbUser.avatarUrl,
      },
      loggedInAt: Date.now(),
    })

    return sendRedirect(event, '/')
  },

  onError(event, error) {
    log.error({ err: error }, 'github oauth failed')
    return sendRedirect(event, '/login?error=github_auth_failed')
  },
})
