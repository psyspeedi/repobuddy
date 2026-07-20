/**
 * Model Context Protocol surface — exposes the KAG operator core to
 * external agents (Claude Code, Cursor) over /api/mcp.
 *
 * Registered in app.module only. The worker has no HTTP surface and no
 * reason to serve MCP, so worker.module deliberately omits it.
 *
 * KagModule and ProvidersModule are both @Global, so the operator
 * registry and the provider resolver arrive without an explicit import
 * here; only the config module needs wiring for the MCP_ENABLED flag.
 */
import { Module } from '@nestjs/common'
import { AppConfigModule } from '../config/config.module'
import { McpController } from './mcp.controller'
import { McpService } from './mcp.service'
import { McpToolsService } from './internals/tools.service'

@Module({
  imports: [AppConfigModule],
  controllers: [McpController],
  providers: [McpService, McpToolsService],
})
export class McpModule {}
