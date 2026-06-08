/**
 * Test-only helper. Integration tests run without a Nest context, so
 * they can't get the operators via DI — this constructs every class
 * by hand with a shared `db` instance and returns the same
 * `Record<OperatorName, fn>` shape the executor / agentic loop expects.
 *
 * Production code should NOT import from here.
 */
import type { OperatorName } from '#shared/schemas/plan'
import type { Database } from '../../../../db/client'
import type { KagOperator } from './_interface'
import { KagOperatorsRegistry } from './_registry'
import type { OperatorContext } from './_types'
import { KAG_OPERATOR_CLASSES } from './index'

export function buildOperatorsMapForTest(db: Database): Record<
  OperatorName,
  (params: never, ctx: OperatorContext) => Promise<unknown> | AsyncGenerator<unknown>
> {
  const instances: KagOperator[] = KAG_OPERATOR_CLASSES.map((Cls) => new Cls(db as never))
  return new KagOperatorsRegistry(instances).asLegacyMap()
}
