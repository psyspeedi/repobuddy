/**
 * Out-of-band alerter. Currently a Telegram bot via HTTPS API; designed
 * so a second channel (email/Slack) can drop in by exporting a different
 * sendAlert implementation.
 *
 * All sends are best-effort and dedup'd per-process for `key` over a
 * configurable cooldown — prevents alert storms when a counter spikes
 * and triggers the same threshold on every scrape.
 */
import { loadEnv } from './env'
import { getLogger } from './logger'

const log = getLogger().child({ component: 'alerts' })

const lastSent = new Map<string, number>()

export interface AlertOptions {
  /** Severity tag — prepended to the message. */
  severity?: 'info' | 'warn' | 'error' | 'critical'
  /** Dedup key. Re-sending the same key inside `cooldownMs` is dropped. */
  key?: string
  /** Cooldown window for `key` (default 1h). */
  cooldownMs?: number
}

export async function sendAlert(
  message: string,
  opts: AlertOptions = {},
): Promise<void> {
  const env = loadEnv()
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) {
    // Channel not configured — log and move on. Alerts in this state
    // are still observable via stderr / Loki.
    log.warn({ message, opts }, 'alert skipped — Telegram channel not configured')
    return
  }
  const cooldownMs = opts.cooldownMs ?? 60 * 60 * 1000
  if (opts.key) {
    const prev = lastSent.get(opts.key)
    if (prev && Date.now() - prev < cooldownMs) return
    lastSent.set(opts.key, Date.now())
  }

  const severityPrefix: Record<string, string> = {
    info: 'ℹ️',
    warn: '⚠️',
    error: '🔴',
    critical: '🚨',
  }
  const tag = severityPrefix[opts.severity ?? 'info'] ?? ''
  const body = `${tag} *RepoBuddy*\n${message}`

  try {
    const url = `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        chat_id: env.TELEGRAM_CHAT_ID,
        text: body,
        parse_mode: 'Markdown',
        disable_web_page_preview: true,
      }),
    })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      log.warn({ status: res.status, body: text.slice(0, 200) }, 'Telegram send failed')
    }
  } catch (err) {
    log.warn({ err }, 'Telegram send threw')
  }
}
