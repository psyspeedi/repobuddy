import type { OperatorName } from '#shared/schemas/plan'
import type { OperatorContext } from './_types'

/**
 * Contract every KAG operator implements. Generic over its params shape
 * (P) and return shape (R) — the executor only cares about the name and
 * the execute signature, so the registry can keep a `KagOperator<unknown,
 * unknown>[]` without losing the typed surface inside each class.
 *
 * `execute` may return either a Promise (most ops) or an AsyncGenerator
 * (answer stream). The executor branches on `typeof out.next === 'function'`
 * to handle both — same as the legacy function dispatch.
 */
export interface KagOperator<P = unknown, R = unknown> {
  /** Matches the `OperatorName` enum entry from shared/schemas/plan. */
  readonly name: OperatorName
  execute(params: P, ctx: OperatorContext): Promise<R> | AsyncGenerator<R>
}

/** DI token used by NestJS multi-provider registration. */
export const KAG_OPERATOR = Symbol.for('repobuddy:kag-operator')
