import { Module } from '@nestjs/common'
import { AuthModule } from '../auth/auth.module'
import { WorkspacesModule } from '../workspaces/workspaces.module'
import { MeController } from './me.controller'

@Module({
  imports: [AuthModule, WorkspacesModule],
  controllers: [MeController],
})
export class MeModule {}
