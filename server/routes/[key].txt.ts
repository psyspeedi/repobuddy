/**
 * IndexNow key verification file. Search engines fetch this path to
 * prove we control the key before honouring submissions.
 *
 * The filename is dynamic via the [key] route param — we only answer
 * with the key contents when the requested key matches env INDEXNOW_KEY.
 */
export default defineEventHandler((event) => {
  const requested = getRouterParam(event, 'key')
  const real = process.env.INDEXNOW_KEY
  if (!requested || !real || requested !== real) {
    throw createError({ statusCode: 404, statusMessage: 'not found' })
  }
  setResponseHeader(event, 'content-type', 'text/plain; charset=utf-8')
  return real
})
