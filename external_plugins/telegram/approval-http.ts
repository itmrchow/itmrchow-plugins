/**
 * Loopback HTTP interface for approval requests (JP-315): create, query, cancel.
 *
 * There is no route that writes a decision, and there must never be one — the
 * decision comes from Telegram only. See approval-store.ts.
 *
 * Mounted onto the poller's existing subscription server instead of opening a
 * second port, by wrapping its request listener: subscribe-server.ts is shared
 * byte-for-byte with the discord plugin, and this feature is telegram-only.
 */
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import { isValidTimeoutSeconds } from './approval-config'
import {
  APPROVAL_ID_PATTERN,
  APPROVAL_ID_RE,
  MAX_APPROVAL_TEXT_LENGTH,
  type ApprovalService,
  type CreateApprovalError,
  type CreateApprovalInput,
} from './approval-service'
import { ACTIONS_BY_KIND, type ApprovalKind, type ApprovalRequest } from './approval-store'

export const APPROVALS_PATH = '/approvals'
const CANCEL_SEGMENT = 'cancel'
/** A request body is one small JSON object; the text cap is 3500 characters. */
const MAX_BODY_BYTES = 32_768
/** Any absolute base works — only the path is read back out. */
const URL_BASE = 'http://127.0.0.1'

const HTTP_OK = 200
const HTTP_CREATED = 201
const HTTP_BAD_REQUEST = 400
const HTTP_FORBIDDEN = 403
const HTTP_NOT_FOUND = 404
const HTTP_METHOD_NOT_ALLOWED = 405
const HTTP_CONFLICT = 409
const HTTP_BAD_GATEWAY = 502
const HTTP_SERVICE_UNAVAILABLE = 503

const CREATE_ERROR_STATUS: Readonly<Record<CreateApprovalError, number>> = {
  duplicate_id: HTTP_CONFLICT,
  no_recipient: HTTP_SERVICE_UNAVAILABLE,
  too_many_requests: HTTP_SERVICE_UNAVAILABLE,
  telegram_send_failed: HTTP_BAD_GATEWAY,
}

/** What a caller sees of a request. Message ids and chat ids stay inside the poller. */
export type ApprovalView = {
  id: string
  kind: ApprovalKind
  status: ApprovalRequest['status']
  decision: ApprovalRequest['decision']
  comment: string | null
  created_at_ms: number
  expires_at_ms: number
  resolved_at_ms: number | null
}

export type ApprovalHttpDefaults = { timeoutSeconds: number; commentTimeoutSeconds: number }

type ParsedCreate = { ok: true; input: CreateApprovalInput } | { ok: false; detail: string }

/**
 * Reduce a stored request to what a caller may see.
 *
 * @param request - A stored request.
 * @returns Its public JSON shape.
 */
export function toApprovalView(request: ApprovalRequest): ApprovalView {
  return {
    id: request.id,
    kind: request.kind,
    status: request.status,
    decision: request.decision,
    comment: request.comment,
    created_at_ms: request.createdAtMs,
    expires_at_ms: request.expiresAtMs,
    resolved_at_ms: request.resolvedAtMs,
  }
}

/**
 * Validate a create body. Only the documented fields are read; anything else in
 * the body (a smuggled `status`, `decision`, …) is ignored, never applied.
 *
 * @param raw - Request body text.
 * @param defaults - Timeouts used when the body names none.
 * @returns The typed input, or what was wrong.
 */
export function parseCreateBody(raw: string, defaults: ApprovalHttpDefaults): ParsedCreate {
  let body: unknown
  try {
    body = JSON.parse(raw)
  } catch {
    return { ok: false, detail: 'body is not valid JSON' }
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return { ok: false, detail: 'body must be a JSON object' }
  }
  const fields = body as Record<string, unknown>
  const { id, text, kind } = fields
  if (typeof id !== 'string' || !APPROVAL_ID_RE.test(id)) {
    return { ok: false, detail: `id must match ${APPROVAL_ID_PATTERN}` }
  }
  if (typeof text !== 'string' || text.trim() === '') return { ok: false, detail: 'text must be a non-empty string' }
  if (text.length > MAX_APPROVAL_TEXT_LENGTH) {
    return { ok: false, detail: `text must be at most ${MAX_APPROVAL_TEXT_LENGTH} characters` }
  }
  if (typeof kind !== 'string' || !Object.hasOwn(ACTIONS_BY_KIND, kind)) {
    return { ok: false, detail: 'kind must be allow_deny or approve_reject' }
  }
  const timeoutSeconds = fields.timeout_seconds ?? defaults.timeoutSeconds
  if (!isValidTimeoutSeconds(timeoutSeconds)) return { ok: false, detail: 'timeout_seconds is out of range' }
  const commentTimeoutSeconds = fields.comment_timeout_seconds ?? defaults.commentTimeoutSeconds
  if (!isValidTimeoutSeconds(commentTimeoutSeconds)) {
    return { ok: false, detail: 'comment_timeout_seconds is out of range' }
  }
  return { ok: true, input: { id, text, kind: kind as ApprovalKind, timeoutSeconds, commentTimeoutSeconds } }
}

function sendJson(res: ServerResponse, status: number, body: Record<string, unknown>): void {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

function readBody(req: IncomingMessage): Promise<string | null> {
  return new Promise(resolve => {
    const chunks: Buffer[] = []
    let received = 0
    let tooLarge = false
    req.on('data', (chunk: Buffer | string) => {
      const buffer = typeof chunk === 'string' ? Buffer.from(chunk) : chunk
      received += buffer.length
      if (received > MAX_BODY_BYTES) tooLarge = true
      if (!tooLarge) chunks.push(buffer)
    })
    req.on('end', () => resolve(tooLarge ? null : Buffer.concat(chunks).toString('utf8')))
    req.on('error', () => resolve(null))
  })
}

/**
 * Build the handler for everything under /approvals.
 *
 * @param service - The approval service.
 * @param defaults - Timeouts used when a create body names none.
 * @returns A handler that returns true when it took the request, false when
 *   the path is not under /approvals and the caller should handle it.
 */
export function createApprovalHandler(
  service: ApprovalService,
  defaults: ApprovalHttpDefaults,
): (req: IncomingMessage, res: ServerResponse) => boolean {
  const handleCreate = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const raw = await readBody(req)
    if (raw === null) return sendJson(res, HTTP_BAD_REQUEST, { error: 'invalid_request', detail: 'body too large' })
    const parsed = parseCreateBody(raw, defaults)
    if (!parsed.ok) return sendJson(res, HTTP_BAD_REQUEST, { error: 'invalid_request', detail: parsed.detail })
    const result = await service.create(parsed.input)
    if (result.ok) return sendJson(res, HTTP_CREATED, toApprovalView(result.request))
    sendJson(res, CREATE_ERROR_STATUS[result.error], {
      error: result.error,
      ...(result.request ? { request: toApprovalView(result.request) } : {}),
    })
  }

  const handleGet = (res: ServerResponse, id: string): void => {
    const request = service.get(id)
    if (!request) return sendJson(res, HTTP_NOT_FOUND, { error: 'not_found' })
    sendJson(res, HTTP_OK, toApprovalView(request))
  }

  const handleCancel = async (res: ServerResponse, id: string): Promise<void> => {
    const request = await service.cancel(id)
    if (!request) return sendJson(res, HTTP_NOT_FOUND, { error: 'not_found' })
    sendJson(res, HTTP_OK, toApprovalView(request))
  }

  const dispatch = async (req: IncomingMessage, res: ServerResponse, segments: string[]): Promise<void> => {
    const [id, verb, ...rest] = segments
    if (id === undefined) {
      if (req.method !== 'POST') return sendJson(res, HTTP_METHOD_NOT_ALLOWED, { error: 'method_not_allowed' })
      return handleCreate(req, res)
    }
    if (rest.length > 0 || (verb !== undefined && verb !== CANCEL_SEGMENT)) {
      return sendJson(res, HTTP_NOT_FOUND, { error: 'not_found' })
    }
    if (verb === CANCEL_SEGMENT) {
      if (req.method !== 'POST') return sendJson(res, HTTP_METHOD_NOT_ALLOWED, { error: 'method_not_allowed' })
      return handleCancel(res, id)
    }
    if (req.method !== 'GET') return sendJson(res, HTTP_METHOD_NOT_ALLOWED, { error: 'method_not_allowed' })
    handleGet(res, id)
  }

  return (req, res) => {
    const { pathname } = new URL(req.url ?? '', URL_BASE)
    if (pathname !== APPROVALS_PATH && !pathname.startsWith(`${APPROVALS_PATH}/`)) return false
    // Browsers attach Origin to every cross-site POST, including the no-cors
    // "simple" ones that skip preflight; local callers (curl, scripts) do not.
    // Refusing it keeps a web page from creating or cancelling requests.
    if (req.headers.origin !== undefined) {
      sendJson(res, HTTP_FORBIDDEN, { error: 'forbidden_origin' })
      return true
    }
    const segments = pathname.slice(APPROVALS_PATH.length).split('/').filter(segment => segment !== '')
    dispatch(req, res, segments).catch(err => {
      process.stderr.write(`telegram poller: approval request failed: ${err}\n`)
      if (!res.headersSent) sendJson(res, HTTP_SERVICE_UNAVAILABLE, { error: 'internal_error' })
    })
    return true
  }
}

/**
 * Put the approval routes in front of a server's existing request handling.
 * Requests the handler does not take reach the original listeners untouched.
 *
 * @param server - The poller's HTTP server, with its own listeners already attached.
 * @param handler - From createApprovalHandler.
 */
export function mountApprovalRoutes(
  server: Server,
  handler: (req: IncomingMessage, res: ServerResponse) => boolean,
): void {
  const original = server.listeners('request') as ((req: IncomingMessage, res: ServerResponse) => void)[]
  server.removeAllListeners('request')
  server.on('request', (req: IncomingMessage, res: ServerResponse) => {
    if (handler(req, res)) return
    for (const listener of original) listener.call(server, req, res)
  })
}
