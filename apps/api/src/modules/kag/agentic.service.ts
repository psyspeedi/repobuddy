import { Injectable } from '@nestjs/common'
import { runAgenticAnswer, type AgenticEvent, type AgenticOptions } from '#server/kag/agentic'
import type { OperatorContext } from '#server/kag/operators/index'
import type { LLMProvider } from '#server/providers/llm'

@Injectable()
export class AgenticService {
  run(
    llm: LLMProvider,
    ctx: OperatorContext,
    question: string,
    opts: AgenticOptions = {},
  ): AsyncGenerator<AgenticEvent> {
    return runAgenticAnswer(llm, ctx, question, opts)
  }
}
