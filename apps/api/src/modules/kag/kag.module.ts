import { Global, Module } from '@nestjs/common'
import { AgenticService } from './agentic.service'
import { ExecutorService } from './executor.service'
import { PlannerService } from './planner.service'

/**
 * Knowledge-Augmented Graph domain. Thin DI wrappers over the legacy
 * `#server/kag/{planner,executor,agentic}` functions so HTTP handlers
 * can inject them instead of calling raw module-level functions.
 *
 * The ~30 operators (find_symbol / vector_search / find_resolution …)
 * stay where they are — they're dispatched by name inside executor /
 * agentic, not consumed individually, so wrapping each as its own
 * provider would add noise without buying DI benefits. They move in
 * a later refactor once the legacy folder is otherwise empty.
 */
@Global()
@Module({
  providers: [PlannerService, ExecutorService, AgenticService],
  exports: [PlannerService, ExecutorService, AgenticService],
})
export class KagModule {}
