import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { isValidScopeId } from './scope-id'
import {
  encodeSse,
  SSE_KEEPALIVE,
  SSE_KEEPALIVE_INTERVAL_MS,
  type InboundEnvelope,
} from './subscribe-protocol'
import type { ScopeRegistry } from './poller-registry'

const SUBSCRIBE_PATH = '/subscribe'
const ACK_PATH = '/ack'
const SCOPE_PARAM = 'scope'
/** Ack bodies are one JSON object with one uuid; anything larger is not ours. */
const MAX_ACK_BODY_BYTES = 4096
/** Any absolute base works — only the path and query are read back out. */
const URL_BASE = 'http://127.0.0.1'

type Connection = { res: ServerResponse; inFlight: Map<string, InboundEnvelope> }

export type SubscribeHub = {
  server: Server
  /**
   * Write envelopes to a scope's live subscription.
   *
   * @returns false when that scope has no connection right now, so the caller
   *   can queue instead of dropping.
   */
  deliver: (scopeId: string, envelopes: InboundEnvelope[]) => boolean
  close: () => void
}

/**
 * Build the poller's subscription endpoint: the one socket each scope's
 * server.ts connects back on.
 *
 * The registry is driven from in here rather than by the caller because
 * subscribe / disconnect / redelivery only make sense as one unit — splitting
 * them would let a caller mark a scope connected while no socket exists.
 *
 * @param opts.registry - Shared dispatch state machine.
 * @param opts.onSubscribe - Observability hook, called after the scope is live.
 * @param opts.onDisconnect - Observability hook, called after cleanup.
 * @returns The hub. The caller is responsible for calling listen().
 */
export function createSubscribeServer(opts: {
  registry: ScopeRegistry
  onSubscribe?: (scopeId: string) => void
  onDisconnect?: (scopeId: string) => void
}): SubscribeHub {
  const connections = new Map<string, Connection>()

  const deliver = (scopeId: string, envelopes: InboundEnvelope[]): boolean => {
    const conn = connections.get(scopeId)
    if (!conn) return false
    for (const envelope of envelopes) {
      // Recorded before the write: if the socket dies mid-frame we still know
      // the message was never acked and must be redelivered.
      conn.inFlight.set(envelope.envelopeId, envelope)
      conn.res.write(encodeSse(envelope))
    }
    return true
  }

  const dropConnection = (scopeId: string, conn: Connection): void => {
    if (connections.get(scopeId) !== conn) return // already replaced by a newer one
    connections.delete(scopeId)
    opts.registry.onDisconnected(scopeId)
    opts.registry.requeue(scopeId, [...conn.inFlight.values()])
    opts.onDisconnect?.(scopeId)
  }

  const handleSubscribe = (req: IncomingMessage, res: ServerResponse, scopeId: string): void => {
    if (!isValidScopeId(scopeId)) {
      res.writeHead(400)
      res.end('invalid scope')
      return
    }
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    })
    // Nagle would hold a small frame back waiting for more bytes that never
    // come on an idle stream, adding latency to every single message.
    req.socket.setNoDelay(true)

    // A second subscription for the same scope means the previous process is
    // gone (or hung) and this one is the real owner — keep the newer socket.
    connections.get(scopeId)?.res.end()

    const conn: Connection = { res, inFlight: new Map() }
    connections.set(scopeId, conn)
    // Disconnect is detected on the REQUEST, not the response: bun's node:http
    // never fires res 'close' when a client aborts (node does), so a res-side
    // listener would leave the scope marked connected forever and every message
    // written into a dead socket. Verified on bun 1.3 and node 26.
    req.on('close', () => dropConnection(scopeId, conn))

    deliver(scopeId, opts.registry.onSubscribed(scopeId))
    opts.onSubscribe?.(scopeId)
  }

  const handleAck = (req: IncomingMessage, res: ServerResponse): void => {
    let raw = ''
    req.on('data', (chunk: Buffer | string) => {
      raw += chunk
      if (raw.length > MAX_ACK_BODY_BYTES) req.destroy()
    })
    req.on('end', () => {
      let envelopeId: unknown
      try {
        envelopeId = (JSON.parse(raw) as { envelopeId?: unknown }).envelopeId
      } catch {
        res.writeHead(400)
        res.end('invalid json')
        return
      }
      if (typeof envelopeId === 'string') {
        for (const conn of connections.values()) conn.inFlight.delete(envelopeId)
      }
      res.writeHead(200)
      res.end('ok')
    })
  }

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '', URL_BASE)
    if (req.method === 'GET' && url.pathname === SUBSCRIBE_PATH) {
      handleSubscribe(req, res, url.searchParams.get(SCOPE_PARAM) ?? '')
      return
    }
    if (req.method === 'POST' && url.pathname === ACK_PATH) {
      handleAck(req, res)
      return
    }
    res.writeHead(404)
    res.end('not found')
  })

  // unref: a bare interval would keep the process alive forever, which turns a
  // clean shutdown into a SIGKILL wait.
  const keepalive = setInterval(() => {
    for (const conn of connections.values()) conn.res.write(SSE_KEEPALIVE)
  }, SSE_KEEPALIVE_INTERVAL_MS)
  keepalive.unref()

  return {
    server,
    deliver,
    close: () => {
      clearInterval(keepalive)
      for (const conn of connections.values()) conn.res.end()
      connections.clear()
      server.close()
    },
  }
}
