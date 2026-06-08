import { Controller, Get, Header, Inject, Param, Req, Sse } from '@nestjs/common'
import type { MessageEvent } from '@nestjs/common'
import { Observable } from 'rxjs'
import { eq } from 'drizzle-orm'
import type { Request } from 'express'
import { workspaces } from '#server/db/schema'
import { DRIZZLE_DB, type DrizzleDb } from '../drizzle/drizzle.tokens'
import { WorkspaceAccessService } from './workspace-access.service'

const POLL_MS = 1000
const HEARTBEAT_MS = 15000

@Controller('workspaces/:id')
export class WorkspacesProgressController {
  constructor(
    @Inject(DRIZZLE_DB) private readonly db: DrizzleDb,
    @Inject(WorkspaceAccessService) private readonly access: WorkspaceAccessService,
  ) {}

  /**
   * Streams workspace status until ready / failed. Naive 1s polling
   * with 15s heartbeats. Could move to LISTEN/NOTIFY later — the SSE
   * surface stays identical.
   */
  @Get('progress')
  @Header('x-accel-buffering', 'no')
  @Sse()
  async progress(@Req() req: Request, @Param('id') id: string): Promise<Observable<MessageEvent>> {
    await this.access.read(req, id)
    return new Observable<MessageEvent>((subscriber) => {
      let alive = true
      let lastSerialized = ''
      let pollTimer: NodeJS.Timeout | null = null
      let heartbeatTimer: NodeJS.Timeout | null = null

      req.on('close', () => {
        alive = false
        if (pollTimer) clearTimeout(pollTimer)
        if (heartbeatTimer) clearInterval(heartbeatTimer)
        subscriber.complete()
      })

      const pushOne = async (): Promise<boolean> => {
        const [current] = await this.db
          .select()
          .from(workspaces)
          .where(eq(workspaces.id, id))
          .limit(1)
        if (!current) return false
        const serialized = JSON.stringify({
          status: current.status,
          progress: current.progress,
          stats: current.stats,
          error: current.error,
        })
        if (serialized !== lastSerialized) {
          subscriber.next({ type: 'progress', data: serialized })
          lastSerialized = serialized
        }
        return current.status !== 'ready' && current.status !== 'failed'
      }

      heartbeatTimer = setInterval(() => {
        if (!alive) return
        subscriber.next({ type: 'heartbeat', data: String(Date.now()) })
      }, HEARTBEAT_MS)

      const loop = async () => {
        try {
          const shouldContinue = await pushOne()
          if (!shouldContinue) {
            subscriber.next({ type: 'done', data: '{}' })
            subscriber.complete()
            if (heartbeatTimer) clearInterval(heartbeatTimer)
            return
          }
          while (alive) {
            await new Promise((r) => {
              pollTimer = setTimeout(r, POLL_MS)
            })
            if (!alive) break
            const cont = await pushOne()
            if (!cont) {
              subscriber.next({ type: 'done', data: '{}' })
              subscriber.complete()
              if (heartbeatTimer) clearInterval(heartbeatTimer)
              return
            }
          }
        } catch (err) {
          subscriber.error(err)
        } finally {
          if (heartbeatTimer) clearInterval(heartbeatTimer)
        }
      }
      void loop()
    })
  }
}
