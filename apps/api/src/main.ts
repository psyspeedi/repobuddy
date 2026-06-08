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
import { AppModule } from './app.module'

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { bufferLogs: true })
  app.useLogger(app.get(PinoLogger))
  app.setGlobalPrefix('api', {
    // routes/{sitemap,robots,feed,indexnow} land in step 8 — they get
    // listed here when their controller is added.
    exclude: [],
  })
  app.enableShutdownHooks()

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
