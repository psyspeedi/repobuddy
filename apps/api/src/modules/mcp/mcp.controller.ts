/**
 * MCP endpoint. The global `api` prefix set in main.ts makes the final
 * path /api/mcp — that is the URL users put in their Claude Code or
 * Cursor config.
 *
 * All three methods pass `@Res()` without `passthrough`, handing the
 * response to the MCP transport: it writes status, headers and body
 * itself (the protocol negotiates between a JSON reply and an SSE
 * stream per request), so Nest must not also serialise a return value.
 */
import { Body, Controller, Delete, Get, Inject, NotFoundException, Post, Req, Res } from '@nestjs/common'
import type { Request, Response } from 'express'
import { McpService } from './mcp.service'

@Controller('mcp')
export class McpController {
  constructor(@Inject(McpService) private readonly service: McpService) {}

  @Post()
  async handle(@Req() req: Request, @Res() res: Response, @Body() body: unknown): Promise<void> {
    this.assertEnabled()
    await this.service.handlePost(req, res, body)
  }

  @Get()
  stream(@Res() res: Response): void {
    this.assertEnabled()
    this.service.rejectSessionMethod(res)
  }

  @Delete()
  terminate(@Res() res: Response): void {
    this.assertEnabled()
    this.service.rejectSessionMethod(res)
  }

  /** Disabled via MCP_ENABLED reads as "no such route", not "forbidden" —
   * there is nothing here to authenticate against. */
  private assertEnabled(): void {
    if (!this.service.enabled) throw new NotFoundException()
  }
}
