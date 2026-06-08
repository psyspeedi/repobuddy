import 'reflect-metadata'
import { NestFactory } from '@nestjs/core'
import { AppModule } from './app.module'

async function bootstrap() {
  const app = await NestFactory.create(AppModule)
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
