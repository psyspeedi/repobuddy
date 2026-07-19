import { Global, Module, type Provider } from '@nestjs/common'
import {
  KAG_OPERATOR_CLASSES,
  KagOperatorsRegistry,
  type KagOperator,
} from './internals/operators'
import { AgenticService } from './agentic.service'
import { ExecutorService } from './executor.service'
import { PlannerService } from './planner.service'

/**
 * Knowledge-Augmented Graph domain. Each of the 15 operators is an
 * @Injectable class that implements KagOperator; KagOperatorsRegistry
 * collects them and exposes a `Record<OperatorName, fn>` map matching
 * the legacy dispatch shape, which ExecutorService / AgenticService
 * pass into executePlan() and runAgenticAnswer().
 *
 * NestJS has no Angular-style multi-provider — instead we use a
 * factory that injects each operator class explicitly and hands the
 * array to the registry. Adding a new operator is now: drop a class,
 * append it to KAG_OPERATOR_CLASSES; the registry construction will
 * throw loudly on a name collision.
 */
const OPERATOR_PROVIDERS: Provider[] = [...KAG_OPERATOR_CLASSES]

const REGISTRY_PROVIDER: Provider = {
  provide: KagOperatorsRegistry,
  inject: [...KAG_OPERATOR_CLASSES],
  useFactory: (...ops: KagOperator[]) => new KagOperatorsRegistry(ops),
}

@Global()
@Module({
  providers: [
    ...OPERATOR_PROVIDERS,
    REGISTRY_PROVIDER,
    PlannerService,
    ExecutorService,
    AgenticService,
  ],
  exports: [
    KagOperatorsRegistry,
    PlannerService,
    ExecutorService,
    AgenticService,
  ],
})
export class KagModule {}
