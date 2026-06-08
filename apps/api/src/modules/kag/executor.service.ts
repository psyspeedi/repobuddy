import { Inject, Injectable } from '@nestjs/common'
import { executePlan, type ExecutorResult } from '#server/kag/executor'
import { KagOperatorsRegistry, type OperatorContext } from '#server/kag/operators/index'
import type { Plan } from '#shared/schemas/plan'

@Injectable()
export class ExecutorService {
  constructor(
    @Inject(KagOperatorsRegistry) private readonly operators: KagOperatorsRegistry,
  ) {}

  run(plan: Plan, ctx: OperatorContext): Promise<ExecutorResult> {
    return executePlan(plan, ctx, this.operators.asLegacyMap())
  }
}
