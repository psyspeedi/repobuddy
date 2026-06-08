import { Injectable } from '@nestjs/common'
import { executePlan, type ExecutorResult } from '#server/kag/executor'
import type { OperatorContext } from '#server/kag/operators/index'
import type { Plan } from '#shared/schemas/plan'

@Injectable()
export class ExecutorService {
  run(plan: Plan, ctx: OperatorContext): Promise<ExecutorResult> {
    return executePlan(plan, ctx)
  }
}
