import { Module } from '@nestjs/common'
import { LoggerModule as PinoLoggerModule } from 'nestjs-pino'

const isDev = process.env.NODE_ENV !== 'production'

@Module({
  imports: [
    PinoLoggerModule.forRoot({
      pinoHttp: {
        level: process.env.LOG_LEVEL ?? 'info',
        base: {
          service: 'repobuddy',
          role: process.env.PROCESS_ROLE ?? 'web',
        },
        autoLogging: { ignore: (req) => req.url === '/api/health' || req.url === '/api/metrics' },
        ...(isDev
          ? {
              transport: {
                target: 'pino-pretty',
                options: {
                  colorize: true,
                  translateTime: 'HH:MM:ss.l',
                  ignore: 'pid,hostname,service,req,res,responseTime',
                },
              },
            }
          : {}),
      },
    }),
  ],
})
export class LoggerModule {}
