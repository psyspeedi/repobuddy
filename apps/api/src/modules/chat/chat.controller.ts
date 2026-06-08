import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Header,
  HttpCode,
  Inject,
  Param,
  Post,
  Query,
  Req,
  Res,
  Sse,
} from '@nestjs/common'
import type { Request, Response } from 'express'
import type { Observable } from 'rxjs'
import type { MessageEvent } from '@nestjs/common'
import { ChatService } from './chat.service'
import { ChatBodySchema } from './chat.types'

@Controller('chat')
export class ChatController {
  constructor(@Inject(ChatService) private readonly service: ChatService) {}

  @Get('sessions')
  async sessions(@Req() req: Request, @Query('workspaceId') workspaceId: string | undefined) {
    return this.service.listSessions(req, workspaceId ?? null)
  }

  @Get(':sessionId')
  async history(@Req() req: Request, @Param('sessionId') sessionId: string) {
    return this.service.getHistory(req, sessionId)
  }

  @Delete(':sessionId')
  async remove(@Req() req: Request, @Param('sessionId') sessionId: string) {
    return this.service.deleteSession(req, sessionId)
  }

  /**
   * SSE chat endpoint. @Sse() handles content-type / cache-control,
   * we add x-accel-buffering manually to keep nginx from holding the
   * stream until it has a full buffer.
   */
  @Post(':sessionId')
  @Header('x-accel-buffering', 'no')
  @HttpCode(200)
  @Sse()
  chat(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Param('sessionId') sessionId: string,
    @Body() body: unknown,
  ): Observable<MessageEvent> {
    void res
    const parsed = ChatBodySchema.safeParse(body)
    if (!parsed.success) {
      throw new BadRequestException({ message: 'Invalid chat payload', issues: parsed.error.issues })
    }
    return this.service.chatStream(req, sessionId, parsed.data)
  }
}
