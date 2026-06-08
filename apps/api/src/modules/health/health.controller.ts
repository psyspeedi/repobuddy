import { Controller, Get, Inject } from '@nestjs/common'
import {
  HealthCheck,
  HealthCheckService,
  type HealthIndicatorResult,
} from '@nestjs/terminus'
import { sql } from 'drizzle-orm'
import { DRIZZLE_DB, type DrizzleDb } from '../drizzle/drizzle.tokens'
import { REDIS_CLIENT, type RedisClient } from '../redis/redis.tokens'

@Controller('health')
export class HealthController {
  constructor(
    @Inject(HealthCheckService) private readonly health: HealthCheckService,
    @Inject(DRIZZLE_DB) private readonly db: DrizzleDb,
    @Inject(REDIS_CLIENT) private readonly redis: RedisClient,
  ) {}

  @Get()
  @HealthCheck()
  check() {
    return this.health.check([
      async () => this.dbHealth(),
      async () => this.redisHealth(),
    ])
  }

  private async dbHealth(): Promise<HealthIndicatorResult> {
    const t0 = Date.now()
    try {
      await this.db.execute(sql`select 1`)
      return { db: { status: 'up', latencyMs: Date.now() - t0 } }
    } catch (err) {
      return {
        db: {
          status: 'down',
          detail: err instanceof Error ? err.message : String(err),
        },
      }
    }
  }

  private async redisHealth(): Promise<HealthIndicatorResult> {
    const t0 = Date.now()
    try {
      const pong = await this.redis.ping()
      return {
        redis: {
          status: pong === 'PONG' ? 'up' : 'down',
          latencyMs: Date.now() - t0,
        },
      }
    } catch (err) {
      return {
        redis: {
          status: 'down',
          detail: err instanceof Error ? err.message : String(err),
        },
      }
    }
  }
}
