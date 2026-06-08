import { Module } from '@nestjs/common'
import { AuthModule } from '../auth/auth.module'
import { WorkspacesModule } from '../workspaces/workspaces.module'
import { ChatController } from './chat.controller'
import { ChatService } from './chat.service'

@Module({
  imports: [AuthModule, WorkspacesModule],
  providers: [ChatService],
  controllers: [ChatController],
})
export class ChatModule {}
