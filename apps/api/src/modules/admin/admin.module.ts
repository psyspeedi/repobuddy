import { Module } from '@nestjs/common'
import { AuthModule } from '../auth/auth.module'
import { WorkspacesModule } from '../workspaces/workspaces.module'
import { AdminController } from './admin.controller'

@Module({
  imports: [AuthModule, WorkspacesModule],
  controllers: [AdminController],
})
export class AdminModule {}
