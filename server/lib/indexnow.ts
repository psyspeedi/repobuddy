/**
 * IndexNow pinger. When a public workspace appears or disappears, we
 * notify Bing + Yandex via their shared protocol so the index updates
 * in minutes instead of days.
 *
 * Key handshake: the search engines fetch
 * https://<host>/<KEY>.txt and expect to find <KEY> inside. We serve
 * that file via server/routes/[key].txt.ts using the runtime key.
 *
 * No-op when INDEXNOW_KEY is unset — convenient for dev.
 */
import { getLogger } from './logger'

const log = getLogger().child({ component: 'indexnow' })

export async function pingIndexNow(urls: string[]): Promise<void> {
  const key = process.env.INDEXNOW_KEY
  const host = process.env.APP_URL
  if (!key || !host) return
  try {
    const u = new URL(host)
    const res = await fetch('https://api.indexnow.org/IndexNow', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        host: u.host,
        key,
        keyLocation: `${host.replace(/\/$/, '')}/${key}.txt`,
        urlList: urls,
      }),
    })
    if (!res.ok) {
      log.warn({ status: res.status, body: await res.text().catch(() => '') }, 'IndexNow rejected')
    }
  } catch (err) {
    log.warn({ err }, 'IndexNow send failed')
  }
}
