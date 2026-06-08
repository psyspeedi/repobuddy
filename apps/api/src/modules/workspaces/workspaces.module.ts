import { Module } from '@nestjs/common'
import { AuthModule } from '../auth/auth.module'
import { QueuesModule } from '../queues/queues.module'
import { WorkspaceAccessService } from './workspace-access.service'
import { WorkspacesController } from './workspaces.controller'

@Module({
  imports: [AuthModule, QueuesModule],
  providers: [WorkspaceAccessService],
  controllers: [WorkspacesController],
  exports: [WorkspaceAccessService],
})
export class WorkspacesModule {}
