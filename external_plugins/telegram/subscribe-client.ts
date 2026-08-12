/**
 * SSE subscription client: one scope's server.ts connecting back to its
 * platform poller.
 *
 * Copied byte-identically into the discord plugin (see shared-parity.test.ts
 * there for why), so nothing here may name a platform. Log lines say "channel:"
 * and carry the scope-id, which already begins with the platform name.
 */
import { request, type ClientRequest, type IncomingMessage } from 'node:http'
import {
  createSseParser,
  SSE_IDLE_TIMEOUT_MS,
  type InboundEnvelope,
} from './subscribe-protocol'

const BASE_BACKOFF_MS = 1000
const MAX_BACKOFF_MS = 30_000
const JITTER_RATIO = 0.2
const SUBSCRIBE_PATH = '/subscribe'
const ACK_PATH = '/ack'

/**
 * How long to wait before reconnect attempt number `attempt`.
 *
 * The jitter is not decoration: /restart is global, so N servers lose their
 * subscription in the same second. Without it they would all reconnect on the
 * same millisecond and fill the poller's accept queue.
 *
 * @param attempt - Retry counter, starting at 0.
 * @param random - Randomness source; injectable for tests.
 * @returns Milliseconds to wait.
 */
export function nextBackoffMs(attempt: number, random: () => number = Math.random): number {
  const base = Math.min(BASE_BACKOFF_MS * 2 ** attempt, MAX_BACKOFF_MS)
  return Math.round(base * (1 - JITTER_RATIO + 2 * JITTER_RATIO * random()))
}

export type SubscribeClient = { stop: () => void }

/**
 * Build the reconnect scheduler for ONE connection attempt.
 *
 * It fires at most once. node emits BOTH `req` 'error' and `res` 'close' when a
 * connection dies, bun emits only one — so on the production runtime an
 * unguarded scheduler starts two reconnect loops (two sockets, one of them
 * orphaned and never acking), and no test running on bun can reproduce it.
 * Do not remove the flag on the grounds that "it is only called once here".
 *
 * @param opts.isStopped - Client shutdown check; a stopped client schedules nothing.
 * @param opts.nextWaitMs - Backoff for this attempt; called once per connection.
 * @param opts.reconnect - Performs the delayed reconnect.
 * @param opts.log - Diagnostics sink; defaults to stderr.
 * @returns A scheduler taking the reason this connection died.
 */
export function createReconnectScheduler(opts: {
  isStopped: () => boolean
  nextWaitMs: () => number
  reconnect: (waitMs: number) => void
  log?: (line: string) => void
}): (reason: string) => void {
  let scheduled = false
  return (reason: string): void => {
    if (opts.isStopped() || scheduled) return
    scheduled = true
    const wait = opts.nextWaitMs()
    const log = opts.log ?? ((line: string) => void process.stderr.write(line))
    log(`channel: subscription lost (${reason}); reconnecting in ${wait}ms\n`)
    opts.reconnect(wait)
  }
}

/**
 * Subscribe to this scope's message stream on the platform poller and keep the
 * connection alive across restarts of either side.
 *
 * @param opts.host - Poller host, always loopback in practice.
 * @param opts.port - Poller subscription port.
 * @param opts.scopeId - This process's scope identity.
 * @param opts.onEnvelope - Handles one message; acked only after it resolves.
 * @returns A handle that stops reconnecting when called.
 */
export function startSubscribeClient(opts: {
  host: string
  port: number
  scopeId: string
  onEnvelope: (envelope: InboundEnvelope) => Promise<void>
}): SubscribeClient {
  let stopped = false
  let attempt = 0
  let active: ClientRequest | undefined
  let idleTimer: ReturnType<typeof setTimeout> | undefined

  const ack = (envelopeId: string): void => {
    const body = JSON.stringify({ envelopeId, scopeId: opts.scopeId })
    const req = request({
      host: opts.host,
      port: opts.port,
      path: ACK_PATH,
      method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
    })
    req.on('error', err => {
      process.stderr.write(`channel ${opts.scopeId}: ack ${envelopeId} failed: ${err}\n`)
    })
    req.end(body)
  }

  const armIdleTimer = (res: IncomingMessage): void => {
    if (idleTimer) clearTimeout(idleTimer)
    // Keepalives arrive well inside this window, so silence past it means the
    // socket is dead in a way TCP has not noticed yet (a half-open connection
    // reads as healthy forever).
    idleTimer = setTimeout(() => res.destroy(new Error('idle timeout')), SSE_IDLE_TIMEOUT_MS)
    idleTimer.unref?.()
  }

  const connect = (): void => {
    if (stopped) return
    // Per connection, not per client: each attempt gets its own once-flag so a
    // later connection can still reconnect.
    const scheduleReconnect = createReconnectScheduler({
      isStopped: () => stopped,
      nextWaitMs: () => {
        const wait = nextBackoffMs(attempt)
        attempt += 1
        return wait
      },
      reconnect: wait => {
        if (idleTimer) clearTimeout(idleTimer)
        setTimeout(connect, wait).unref?.()
      },
    })
    const req = request(
      {
        host: opts.host,
        port: opts.port,
        path: `${SUBSCRIBE_PATH}?scope=${encodeURIComponent(opts.scopeId)}`,
      },
      res => {
        if (res.statusCode !== 200) {
          res.resume()
          scheduleReconnect(`http ${res.statusCode}`)
          return
        }
        attempt = 0
        process.stderr.write(`channel: subscribed as ${opts.scopeId}\n`)
        res.setEncoding('utf8')
        armIdleTimer(res)

        // Messages are handled one at a time: inbound handling is stateful
        // (pairing, command routing), and interleaving two messages from the
        // same chat reorders that state.
        let chain = Promise.resolve()
        const feed = createSseParser(envelope => {
          chain = chain.then(async () => {
            try {
              await opts.onEnvelope(envelope)
              ack(envelope.envelopeId)
            } catch (err) {
              // No ack: the poller keeps it in-flight and redelivers on reconnect.
              process.stderr.write(
                `channel ${opts.scopeId}: handling ${envelope.envelopeId} failed: ${err}\n`,
              )
            }
          })
        })
        res.on('data', (chunk: string) => {
          armIdleTimer(res)
          feed(chunk)
        })
        res.on('close', () => scheduleReconnect('stream closed'))
      },
    )
    req.on('error', err => scheduleReconnect(String(err)))
    req.end()
    active = req
  }

  connect()

  return {
    stop: () => {
      stopped = true
      if (idleTimer) clearTimeout(idleTimer)
      active?.destroy()
    },
  }
}
