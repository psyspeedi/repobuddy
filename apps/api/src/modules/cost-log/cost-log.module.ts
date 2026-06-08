import { Global, Module } from '@nestjs/common'
import { CostLogService } from './cost-log.service'

@Global()
@Module({
  providers: [CostLogService],
  exports: [CostLogService],
})
export class CostLogModule {}
