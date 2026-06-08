import 'reflect-metadata'
import { config as loadDotenv } from 'dotenv'
import { resolve } from 'node:path'

loadDotenv({ path: resolve(process.cwd(), '../../.env') })

// eslint-disable-next-line import/first
import { initSentry } from './modules/sentry/sentry'
initSentry()

// eslint-disable-next-line import/first
import { NestFactory } from '@nestjs/core'
// eslint-disable-next-line import/first
import { Logger as PinoLogger } from 'nestjs-pino'
// eslint-disable-next-line import/first
import { WorkerRootModule } from './worker.module'

async function bootstrap() {
  const app = await NestFactory.createApplicationContext(WorkerRootModule, {
    bufferLogs: true,
  })
  app.useLogger(app.get(PinoLogger))
  app.enableShutdownHooks()

  // eslint-disable-next-line no-console
  console.log('[@repobuddy/api worker] listening on BullMQ queues')

  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, async () => {
      // eslint-disable-next-line no-console
      console.log(`[@repobuddy/api worker] ${sig} received, shutting down`)
      await app.close()
      process.exit(0)
    })
  }
}

bootstrap().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('[@repobuddy/api worker] bootstrap failed', err)
  process.exit(1)
})
