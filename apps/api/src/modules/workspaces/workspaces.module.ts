import { Module } from '@nestjs/common'
import { AuthModule } from '../auth/auth.module'
import { QueuesModule } from '../queues/queues.module'
import { WorkspaceAccessService } from './workspace-access.service'
import { WorkspacesController } from './workspaces.controller'
import { WorkspacesProgressController } from './workspaces-progress.controller'
import { WorkspacesQueryController } from './workspaces-query.controller'
import { WorkspacesQueryService } from './workspaces-query.service'

@Module({
  imports: [AuthModule, QueuesModule],
  providers: [WorkspaceAccessService, WorkspacesQueryService],
  controllers: [WorkspacesController, WorkspacesQueryController, WorkspacesProgressController],
  exports: [WorkspaceAccessService],
})
export class WorkspacesModule {}
