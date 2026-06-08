/**
 * Prometheus scrape endpoint. Exposes everything registered in
 * server/lib/metrics.ts plus a fresh BullMQ queue-depth snapshot.
 *
 * Bound to /api/metrics — point Prometheus at this URL.
 */
import { getIndexWorkspaceQueue } from '../queues'
import { register, queueDepth } from '../lib/metrics'

export default defineEventHandler(async (event) => {
  const config = useRuntimeConfig(event)
  // Refresh queue gauge on every scrape so we don't depend on event
  // handlers firing inside the worker.
  try {
    const queue = getIndexWorkspaceQueue(config.redisUrl as string)
    const [waiting, active, completed, failed] = await Promise.all([
      queue.getWaitingCount(),
      queue.getActiveCount(),
      queue.getCompletedCount(),
      queue.getFailedCount(),
    ])
    queueDepth.set({ state: 'waiting' }, waiting)
    queueDepth.set({ state: 'active' }, active)
    queueDepth.set({ state: 'completed' }, completed)
    queueDepth.set({ state: 'failed' }, failed)
  } catch {
    // Don't fail the scrape on Redis hiccups.
  }
  setResponseHeader(event, 'content-type', register.contentType)
  return register.metrics()
})
