import { Inject, Injectable } from '@nestjs/common'
import { recordAudit, type AuditInput } from '#server/lib/audit'
import { DRIZZLE_DB, type DrizzleDb } from '../drizzle/drizzle.tokens'

@Injectable()
export class AuditService {
  constructor(@Inject(DRIZZLE_DB) private readonly db: DrizzleDb) {}

  record(input: AuditInput): Promise<void> {
    return recordAudit(this.db, input)
  }
}
