import { Injectable } from '@nestjs/common'
import {
  assertCanCreateWorkspace,
  assertCanSendMessage,
  consumeMessage,
  consumeWorkspace,
  getLimits,
  getStatus,
  recordTokenUsage,
  type QuotaContext,
  type QuotaLimits,
  type QuotaStatus,
} from '#server/lib/quotas'
import { rateLimitTake } from '#server/lib/rate-limit'

/**
 * @Injectable wrapper around the existing quota / rate-limit helpers
 * in #server/lib. Lets controllers + the ChatService inject one thing
 * instead of importing the raw functions.
 */
@Injectable()
export class QuotasService {
  limits(ctx: QuotaContext): QuotaLimits {
    return getLimits(ctx)
  }

  status(ctx: QuotaContext): Promise<QuotaStatus> {
    return getStatus(ctx)
  }

  assertCanCreateWorkspace(ctx: QuotaContext): Promise<void> {
    return assertCanCreateWorkspace(ctx)
  }

  consumeWorkspace(ctx: QuotaContext): Promise<void> {
    return consumeWorkspace(ctx)
  }

  assertCanSendMessage(ctx: QuotaContext): Promise<void> {
    return assertCanSendMessage(ctx)
  }

  consumeMessage(ctx: QuotaContext): Promise<void> {
    return consumeMessage(ctx)
  }

  recordTokenUsage(ctx: QuotaContext, tokens: number): Promise<void> {
    return recordTokenUsage(ctx, tokens)
  }

  rateLimitTake(
    key: string,
    capacity: number,
    windowSec: number,
  ): ReturnType<typeof rateLimitTake> {
    return rateLimitTake(key, capacity, windowSec)
  }
}
