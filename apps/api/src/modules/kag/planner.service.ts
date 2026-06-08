import { Injectable } from '@nestjs/common'
import { planQuestion, type PlanContext } from '#server/kag/planner'
import type { LLMProvider } from '#server/providers/llm'
import type { Plan } from '#shared/schemas/plan'

@Injectable()
export class PlannerService {
  plan(llm: LLMProvider, question: string, ctx: PlanContext): Promise<Plan> {
    return planQuestion(llm, question, ctx)
  }
}
