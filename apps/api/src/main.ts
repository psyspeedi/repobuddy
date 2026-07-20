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
import { RequestMethod } from '@nestjs/common'
// eslint-disable-next-line import/first
import type { NestExpressApplication } from '@nestjs/platform-express'
// eslint-disable-next-line import/first
import { Logger as PinoLogger } from 'nestjs-pino'
// eslint-disable-next-line import/first
import cookieParser from 'cookie-parser'
// eslint-disable-next-line import/first
import session from 'express-session'
// eslint-disable-next-line import/first
import { RedisStore } from 'connect-redis'
// eslint-disable-next-line import/first
import { createClient as createNodeRedisClient } from 'redis'
// eslint-disable-next-line import/first
import passport from 'passport'
// eslint-disable-next-line import/first
import { AppModule } from './app.module'
// eslint-disable-next-line import/first
import { McpExceptionFilter } from './modules/mcp/internals/parse-error.filter'

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { bufferLogs: true })
  app.useLogger(app.get(PinoLogger))
  app.enableShutdownHooks()

  // In production the API never publishes a port: Caddy terminates TLS
  // and proxies /api/* to api:3001, so without this every request would
  // report the proxy container's address as `req.ip` and the whole
  // internet would share one per-IP rate-limit bucket. `1` means "trust
  // exactly one hop": Express reads the right-most X-Forwarded-For
  // entry, which is the one Caddy appended, so a client that sends its
  // own X-Forwarded-For cannot push a fake address into that slot.
  app.set('trust proxy', 1)

  // Frontend lives on a separate origin (Nuxt at :3000 in dev). CORS
  // + credentials are required so the session cookie travels with
  // every API call. WEB_ORIGIN can be a comma-separated list.
  const origins = (process.env.WEB_ORIGIN ?? 'http://localhost:3000')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  app.enableCors({ origin: origins, credentials: true })

  // connect-redis v9 only speaks the node-redis (`redis`) protocol.
  // Our shared REDIS_CLIENT is ioredis (required by BullMQ), so we
  // open a small dedicated node-redis connection just for sessions.
  const sessionRedis = createNodeRedisClient({ url: process.env.REDIS_URL ?? 'redis://localhost:6379' })
  sessionRedis.on('error', (err) => {
    // eslint-disable-next-line no-console
    console.error('[session-redis] error', err)
  })
  await sessionRedis.connect()

  const sessionSecret = process.env.NUXT_SESSION_PASSWORD
  if (!sessionSecret || sessionSecret.length < 32) {
    throw new Error('NUXT_SESSION_PASSWORD must be ≥32 chars (legacy name; renamed later).')
  }

  app.use(cookieParser())
  app.use(
    session({
      store: new RedisStore({ client: sessionRedis, prefix: 'repobuddy-session:' }),
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
    // SEO routes live outside the /api prefix so crawlers find them at
    // canonical paths. GitHub OAuth start + callback also stay outside
    // /api so the GitHub App callback URL is a stable :3001/auth/github/callback.
    exclude: [
      'robots.txt',
      'sitemap.xml',
      'feed.xml',
      'indexnow/:filename',
      { path: 'auth/github', method: RequestMethod.GET },
      { path: 'auth/github/callback', method: RequestMethod.GET },
    ],
  })

  // Global because that is the only filter Nest consults for failures
  // raised before routing — a malformed body on /api/mcp is one. The
  // filter narrows itself to that path and hands everything else to
  // BaseExceptionFilter, so the REST surface keeps Nest's error shape.
  app.useGlobalFilters(new McpExceptionFilter(app.getHttpAdapter()))

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
