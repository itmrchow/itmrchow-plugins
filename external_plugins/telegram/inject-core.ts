/**
 * Shared scheduler-/inject HTTP core for channel plugins (JP-113).
 *
 * Telegram and Discord both expose the same loopback endpoint for schedulers
 * and other local processes: `POST /inject {text, chat_id}` -> parse -> hand to
 * the channel's busy-gate -> `notifications/claude/channel`. That skeleton was
 * copy-pasted inline in both server.ts files; it lives here once instead.
 *
 * Each channel still binds its OWN port (telegram 7842 / discord 7843). The
 * inject payload carries no channel discriminator — `chat_id` is an opaque
 * string that cannot distinguish a Telegram chat from a Discord channel — so
 * the port IS the channel selector. That is load-bearing, not duplication.
 *
 * Kept free of channel imports (no grammy / discord.js) so the HTTP contract is
 * unit-testable without booting an MCP server or a gateway connection.
 *
 * NOTE ON PLACEMENT: this file is duplicated byte-for-byte into every channel
 * plugin dir rather than imported from a shared sibling dir. Plugin install
 * copies the plugin directory ALONE into
 * ~/.claude/plugins/cache/<marketplace>/<plugin>/<version>/, so a
 * `../_shared/...` import would resolve in the repo but break for installed
 * users. Same established compromise as busy-gate.ts / control-plane.ts /
 * restart-agent.ts / startup-notice.ts. Keep the copies in sync.
 */

import { createServer, type Server, type ServerResponse } from 'node:http'

/** Route the scheduler POSTs report text to. */
const INJECT_ROUTE = '/inject'

/**
 * Loopback-only bind, deliberately not configurable.
 *
 * The endpoint is unauthenticated: anything that can reach the port can inject
 * a message into the agent's session. Widening this to a LAN/all-interfaces
 * address requires authentication first (OP-8688), so there is no bind-address
 * option to reach for in the meantime.
 */
export const BIND_ADDR = '127.0.0.1'

/** Synthetic author stamped on injected messages — they have no real IM sender. */
const SCHEDULER_ACTOR = 'scheduler'

const HTTP_OK = 200
const HTTP_BAD_REQUEST = 400
const HTTP_NOT_FOUND = 404

/** Synthetic channel message handed to the busy-gate for delivery. */
export type ChannelDelivery = {
  content: string
  meta: Record<string, string>
}

/** Outcome of parsing a raw /inject request body. */
export type InjectParse =
  | { ok: true; delivery: ChannelDelivery }
  | { ok: false; status: number; message: string }

/** The only thing the inject core needs from a channel's BusyGate. */
export type InjectGate = {
  submit(delivery: ChannelDelivery): void
}

/**
 * Handler for a channel-specific POST route (e.g. telegram's poller `/update`).
 *
 * Receives the fully-buffered request body and owns the response: it must write
 * a status and end `res` itself.
 */
export type RouteHandler = (raw: string, res: ServerResponse) => void | Promise<void>

/** Wiring for a channel's inject server. */
export type InjectServerOptions = {
  /** Channel name, used only as the stderr log prefix (e.g. `telegram`). */
  channelName: string
  /** TCP port to listen on — the de facto channel selector (telegram 7842 / discord 7843). */
  port: number
  /** Busy-gate that receives parsed deliveries. */
  gate: InjectGate
  /** Extra POST routes owned by the channel, keyed by path (e.g. telegram's `/update`). */
  extraRoutes?: Record<string, RouteHandler>
}

/**
 * Parse and validate a raw /inject request body into a channel delivery.
 *
 * The scheduler POSTs `{ text, chat_id }`; this turns it into the synthetic
 * `scheduler` channel message handed to the busy-gate. Kept pure (no I/O) so
 * the HTTP contract is unit-testable without booting the MCP server.
 *
 * @param raw - Raw request body, expected to be JSON `{ text, chat_id }`.
 * @returns `{ ok: true, delivery }` on success, else `{ ok: false, status, message }`
 *   carrying the HTTP status (400) and reason to write back.
 */
export function parseInjectBody(raw: string): InjectParse {
  let body: unknown
  try {
    body = JSON.parse(raw)
  } catch {
    return { ok: false, status: HTTP_BAD_REQUEST, message: 'invalid json' }
  }
  // JSON.parse succeeds on valid non-objects — `null`, `"str"`, `123`, `[]`.
  // `JSON.parse('null')` in particular returns null, and reading `.text` off it
  // throws a TypeError out of the request handler, killing the whole channel
  // server: one unauthenticated `curl -d null` was enough to take the process
  // down. Reject anything that is not a JSON object before touching a field.
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return { ok: false, status: HTTP_BAD_REQUEST, message: 'body must be a json object' }
  }
  const { text, chat_id } = body as { text?: unknown; chat_id?: unknown }
  if (typeof text !== 'string' || !text || typeof chat_id !== 'string' || !chat_id) {
    return { ok: false, status: HTTP_BAD_REQUEST, message: 'missing text or chat_id' }
  }
  return {
    ok: true,
    delivery: {
      content: text,
      meta: {
        chat_id,
        user: SCHEDULER_ACTOR,
        user_id: SCHEDULER_ACTOR,
        ts: new Date().toISOString(),
      },
    },
  }
}

/**
 * Start the channel's inject HTTP server on its own port.
 *
 * Serves `POST /inject` (scheduler text -> busy-gate) plus any channel-specific
 * routes passed in `extraRoutes`. Anything else — wrong method or unknown path —
 * is a 404. Always binds loopback ({@link BIND_ADDR}). node http (not Bun.serve):
 * telegram's runtime is node via tsx, where libuv schedules stdin, timers and
 * HTTP fairly; bun (aarch64) starves the grammy poll behind the MCP stdin
 * watcher.
 *
 * @param options - Channel wiring; see {@link InjectServerOptions}.
 * @returns The listening http.Server (callers may `close()` it in teardown/tests).
 */
export function startInjectServer(options: InjectServerOptions): Server {
  const { channelName, port, gate, extraRoutes = {} } = options

  const server = createServer((req, res) => {
    const path = req.url ?? ''
    const extra = extraRoutes[path]
    if (req.method !== 'POST' || (path !== INJECT_ROUTE && !extra)) {
      res.writeHead(HTTP_NOT_FOUND)
      res.end('not found')
      return
    }
    let raw = ''
    req.on('data', chunk => { raw += chunk })
    req.on('end', () => {
      void (async () => {
        if (extra) {
          await extra(raw, res)
          return
        }
        // /inject: scheduler text delivered as a synthetic channel message.
        const parsed = parseInjectBody(raw)
        if (!parsed.ok) {
          res.writeHead(parsed.status)
          res.end(parsed.message)
          return
        }
        gate.submit(parsed.delivery)
        process.stderr.write(`${channelName} channel: injected via HTTP for chat_id=${parsed.delivery.meta.chat_id}\n`)
        res.writeHead(HTTP_OK)
        res.end('ok')
      })()
    })
  })

  // Log from the listen callback, not right after the call: listen() is async,
  // so logging inline announces "listening" before the bind has actually
  // succeeded (and before the port is connectable). Callers that need the bound
  // port must likewise wait for the 'listening' event — on node, address() is
  // null until then.
  server.listen(port, BIND_ADDR, () => {
    // Report the port actually bound, not the one requested — they differ when
    // the caller passes 0 (ephemeral) as the tests do.
    const addr = server.address()
    const boundPort = typeof addr === 'object' && addr !== null ? addr.port : port
    process.stderr.write(`${channelName} channel: inject endpoint listening on ${BIND_ADDR}:${boundPort}\n`)
  })
  return server
}
