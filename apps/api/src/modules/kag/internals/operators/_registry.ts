import { Injectable } from '@nestjs/common'
import type { OperatorName } from '#shared/schemas/plan'
import type { KagOperator } from './_interface'
import type { OperatorContext } from './_types'

/**
 * Registry built from every @Injectable operator class registered in
 * KagModule. Exposes lookup helpers + a `Record<OperatorName, fn>` map
 * matching the legacy `OPERATORS` const shape so the executor /
 * agentic loop can keep dispatching by name without knowing about the
 * class machinery underneath.
 *
 * Constructed via a factory provider in KagModule (NestJS doesn't have
 * Angular-style multi-providers, so we inject each class explicitly
 * and pass the array in).
 */
@Injectable()
export class KagOperatorsRegistry {
  private readonly map = new Map<OperatorName, KagOperator>()

  constructor(operators: KagOperator[]) {
    for (const op of operators) {
      if (this.map.has(op.name)) {
        throw new Error(`Duplicate KAG operator registration: ${op.name}`)
      }
      this.map.set(op.name, op)
    }
  }

  get(name: OperatorName): KagOperator | undefined {
    return this.map.get(name)
  }

  all(): ReadonlyMap<OperatorName, KagOperator> {
    return this.map
  }

  /**
   * Returns a `Record<OperatorName, (params, ctx) => Promise|AsyncGenerator>`
   * matching the legacy `OPERATORS` const shape so the executor can keep
   * dispatching exactly the same way it did before DI.
   */
  asLegacyMap(): Record<
    OperatorName,
    (params: never, ctx: OperatorContext) => Promise<unknown> | AsyncGenerator<unknown>
  > {
    const out = {} as Record<
      OperatorName,
      (params: never, ctx: OperatorContext) => Promise<unknown> | AsyncGenerator<unknown>
    >
    for (const [name, op] of this.map) {
      out[name] = ((p: never, c: OperatorContext) => op.execute(p, c)) as never
    }
    return out
  }
}
