import { Module } from '@nestjs/common'
import { IndexerModule } from '../indexer/indexer.module'
import { QueuesModule } from '../queues/queues.module'
import { IndexWorkspaceProcessor } from './index-workspace.processor'

@Module({
  imports: [QueuesModule, IndexerModule],
  providers: [IndexWorkspaceProcessor],
})
export class WorkersModule {}
