import { Injectable } from '@nestjs/common'
import { webFetch, webSearch, type WebFetchResult, type WebSearchEnvelope } from '../../../../lib/web'
import type { KagOperator } from './_interface'
import type { OperatorContext } from './_types'

// ---------- web_search ----------
/**
 * Open-web search via DuckDuckGo's HTML endpoint. Use for library
 * docs, framework behaviour, error messages, RFCs, blog posts,
 * Stack Overflow — anything NOT inside the indexed repo. Returns
 * up to `limit` { title, url, snippet } results.
 *
 * DDG occasionally rate-limits anonymous scrapers — degrades to
 * `{ results: [], reason: 'rate_limited' }` instead of throwing.
 */
export interface WebSearchParams {
  query: string
  limit?: number
}

export async function webSearchOp(
  params: WebSearchParams,
  _ctx: OperatorContext,
): Promise<WebSearchEnvelope> {
  const limit = Math.min(Math.max(params.limit ?? 6, 1), 10)
  return await webSearch(params.query, limit)
}

// ---------- web_fetch ----------
/**
 * Fetch a URL, strip chrome (script/style/nav/aside/footer/etc.),
 * extract the main content region, convert to Markdown, truncate
 * to ~12K chars. Use to expand on a search result the agent
 * already picked, or to read a URL the user pasted.
 */
export interface WebFetchParams {
  url: string
}

export async function webFetchOp(
  params: WebFetchParams,
  _ctx: OperatorContext,
): Promise<WebFetchResult> {
  return await webFetch(params.url)
}

// ---------- @Injectable wrappers ----------

@Injectable()
export class WebSearchOperator implements KagOperator<WebSearchParams, WebSearchEnvelope> {
  readonly name = 'web_search' as const
  execute(p: WebSearchParams, c: OperatorContext) { return webSearchOp(p, c) }
}

@Injectable()
export class WebFetchOperator implements KagOperator<WebFetchParams, WebFetchResult> {
  readonly name = 'web_fetch' as const
  execute(p: WebFetchParams, c: OperatorContext) { return webFetchOp(p, c) }
}
