/**
 * Keeps every /api/mcp error in the JSON-RPC envelope.
 *
 * A malformed request body never reaches `McpController.handle`: Nest's
 * body parser rejects it first, and Nest's own error layer turns the
 * parser's `SyntaxError` into a `BadRequestException`. That path is
 * upstream of routing, so neither the MCP transport nor a
 * controller-scoped `@UseFilters` ever sees it — the client gets a
 * plain `{ message, error, statusCode }` body while every other failure
 * of this endpoint (429, 405, 500) is shaped as JSON-RPC. A strict
 * client parsing the error body for `error.code` chokes on the odd one
 * out instead of reporting what went wrong.
 *
 * The one hook that does run for those failures is a GLOBAL filter, so
 * this is registered globally and narrowed by path: anything that is
 * not the MCP endpoint falls through to `BaseExceptionFilter`, leaving
 * the REST surface's error shape untouched.
 */
import { ArgumentsHost, BadRequestException, Catch, HttpException } from '@nestjs/common'
import { BaseExceptionFilter } from '@nestjs/core'
import type { Request, Response } from 'express'
import { jsonRpcError } from '../mcp.service'

/** Final path of the MCP endpoint, global prefix included. */
const MCP_PATH = '/api/mcp'

/** JSON-RPC codes from the spec's reserved range. */
const JSONRPC_PARSE_ERROR = -32700
const JSONRPC_INVALID_REQUEST = -32600
const JSONRPC_INTERNAL_ERROR = -32603

@Catch()
export class McpExceptionFilter extends BaseExceptionFilter {
  override catch(exception: unknown, host: ArgumentsHost): void {
    if (host.getType() !== 'http') {
      super.catch(exception, host)
      return
    }
    const http = host.switchToHttp()
    const req = http.getRequest<Request>()
    if (stripQuery(req.originalUrl ?? req.url ?? '') !== MCP_PATH) {
      super.catch(exception, host)
      return
    }

    // MCP_ENABLED=false answers 404 on purpose, and "no such route" is
    // a REST answer: dressed as JSON-RPC a client would read it as "the
    // server is here and refused you", which inverts what the kill
    // switch means.
    const status = exception instanceof HttpException ? exception.getStatus() : 500
    if (status === 404) {
      super.catch(exception, host)
      return
    }

    const res = http.getResponse<Response>()
    // The transport writes status, headers and body itself and may
    // already have streamed part of an SSE response; anything appended
    // now would corrupt it.
    if (res.headersSent) return

    if (exception instanceof BadRequestException) {
      // Nest maps body-parser's SyntaxError (and URIError) to
      // BadRequestException carrying the parser's own text. Everything
      // else 400 on this route is a well-formed body we still refused.
      const isParseFailure = /JSON|URI|percent/i.test(messageOf(exception))
      res
        .status(400)
        .json(
          isParseFailure
            ? jsonRpcError(JSONRPC_PARSE_ERROR, 'Parse error: request body is not valid JSON.')
            : jsonRpcError(JSONRPC_INVALID_REQUEST, 'Invalid request.'),
        )
      return
    }

    res.status(status).json(jsonRpcError(JSONRPC_INTERNAL_ERROR, 'Internal server error.'))
  }
}

function stripQuery(url: string): string {
  const q = url.indexOf('?')
  return (q === -1 ? url : url.slice(0, q)).replace(/\/+$/, '') || '/'
}

/** Nest wraps the parser's text in `{ message }`; fall back to the
 * exception's own message when the response is a bare string. */
function messageOf(exception: HttpException): string {
  const body = exception.getResponse()
  if (typeof body === 'string') return body
  const message = (body as { message?: unknown }).message
  if (typeof message === 'string') return message
  if (Array.isArray(message)) return message.join(' ')
  return exception.message
}
