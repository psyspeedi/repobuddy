import { Inject, Injectable } from '@nestjs/common'
import {
  assertWithinDailyBudget,
  getTodaySpendUsd,
  recordCost,
  type CostLogInput,
} from '#server/lib/cost-log'
import { DRIZZLE_DB, type DrizzleDb } from '../drizzle/drizzle.tokens'

@Injectable()
export class CostLogService {
  constructor(@Inject(DRIZZLE_DB) private readonly db: DrizzleDb) {}

  record(input: Omit<CostLogInput, never>): Promise<void> {
    return recordCost(this.db, input)
  }

  todaySpendUsd(): Promise<number> {
    return getTodaySpendUsd()
  }

  assertWithinDailyBudget(opts: { bypass?: boolean } = {}): Promise<void> {
    return assertWithinDailyBudget(opts)
  }
}
