import 'reflect-metadata'
import { config as loadDotenv } from 'dotenv'
import { resolve } from 'node:path'

// Load monorepo-root .env before anything else reads process.env
// (Sentry init, ConfigModule, providers, etc).
loadDotenv({ path: resolve(process.cwd(), '../../.env') })

// eslint-disable-next-line import/first
import { initSentry } from './modules/sentry/sentry'
initSentry()

// eslint-disable-next-line import/first
import { NestFactory } from '@nestjs/core'
// eslint-disable-next-line import/first
import { Logger as PinoLogger } from 'nestjs-pino'
// eslint-disable-next-line import/first
import cookieParser from 'cookie-parser'
// eslint-disable-next-line import/first
import session from 'express-session'
// eslint-disable-next-line import/first
import { RedisStore } from 'connect-redis'
// eslint-disable-next-line import/first
import passport from 'passport'
// eslint-disable-next-line import/first
import { AppModule } from './app.module'
// eslint-disable-next-line import/first
import { REDIS_CLIENT, type RedisClient } from './modules/redis/redis.tokens'

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { bufferLogs: true })
  app.useLogger(app.get(PinoLogger))
  app.enableShutdownHooks()

  // Share the singleton Redis from RedisModule for session storage.
  const redis = app.get<RedisClient>(REDIS_CLIENT)
  const sessionSecret = process.env.NUXT_SESSION_PASSWORD
  if (!sessionSecret || sessionSecret.length < 32) {
    throw new Error('NUXT_SESSION_PASSWORD must be ≥32 chars (legacy name; renamed later).')
  }

  app.use(cookieParser())
  app.use(
    session({
      store: new RedisStore({ client: redis, prefix: 'repobuddy-session:' }),
      secret: sessionSecret,
      name: 'repobuddy-session',
      resave: false,
      saveUninitialized: false,
      cookie: {
        httpOnly: true,
        sameSite: 'lax',
        secure: process.env.NODE_ENV === 'production',
        maxAge: 1000 * 60 * 60 * 24 * 7, // 7d
      },
    }),
  )
  app.use(passport.initialize())
  app.use(passport.session())

  app.setGlobalPrefix('api', {
    // routes/{sitemap,robots,feed,indexnow} land in step 8 — listed here when added.
    exclude: [],
  })

  const port = Number(process.env.API_PORT ?? 3001)
  await app.listen(port)
  // eslint-disable-next-line no-console
  console.log(`[@repobuddy/api] listening on http://localhost:${port}`)
}

bootstrap().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('[@repobuddy/api] bootstrap failed', err)
  process.exit(1)
})
