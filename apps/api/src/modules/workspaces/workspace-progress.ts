import { eq } from 'drizzle-orm'
import type { Database } from '#server/db/client'
import { workspaces } from '#server/db/schema'
import type {
  WorkspaceProgress,
  WorkspaceStatus,
} from '#shared/types/workspace'

export async function setWorkspaceProgress(
  db: Database,
  workspaceId: string,
  partial: Partial<WorkspaceProgress> & { phase: WorkspaceStatus },
): Promise<void> {
  const progress: WorkspaceProgress = {
    phase: partial.phase,
    percent: partial.percent ?? 0,
    message: partial.message ?? '',
    updatedAt: new Date().toISOString(),
  }
  await db
    .update(workspaces)
    .set({
      status: partial.phase,
      progress,
      updatedAt: new Date(),
    })
    .where(eq(workspaces.id, workspaceId))
}

export async function markWorkspaceFailed(
  db: Database,
  workspaceId: string,
  message: string,
): Promise<void> {
  await db
    .update(workspaces)
    .set({
      status: 'failed',
      error: message,
      progress: {
        phase: 'failed',
        percent: 0,
        message,
        updatedAt: new Date().toISOString(),
      } satisfies WorkspaceProgress,
      updatedAt: new Date(),
    })
    .where(eq(workspaces.id, workspaceId))
}

export async function markWorkspaceReady(
  db: Database,
  workspaceId: string,
  stats: Record<string, number>,
): Promise<void> {
  await db
    .update(workspaces)
    .set({
      status: 'ready',
      stats,
      progress: {
        phase: 'ready',
        percent: 100,
        message: 'Indexing complete',
        updatedAt: new Date().toISOString(),
      } satisfies WorkspaceProgress,
      lastIndexedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(workspaces.id, workspaceId))
}
