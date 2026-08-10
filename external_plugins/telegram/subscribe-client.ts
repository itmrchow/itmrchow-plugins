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
    const body = JSON.stringify({ envelopeId })
    const req = request({
      host: opts.host,
      port: opts.port,
      path: ACK_PATH,
      method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
    })
    req.on('error', err => {
      process.stderr.write(`telegram channel: ack ${envelopeId} failed: ${err}\n`)
    })
    req.end(body)
  }

  const scheduleReconnect = (reason: string): void => {
    if (stopped) return
    if (idleTimer) clearTimeout(idleTimer)
    const wait = nextBackoffMs(attempt)
    attempt += 1
    process.stderr.write(
      `telegram channel: subscription lost (${reason}); reconnecting in ${wait}ms\n`,
    )
    setTimeout(connect, wait).unref?.()
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
        process.stderr.write(`telegram channel: subscribed as ${opts.scopeId}\n`)
        res.setEncoding('utf8')
        armIdleTimer(res)

        // Messages are handled one at a time: grammy's update handling is
        // stateful (pairing, command routing), and interleaving two updates
        // from the same chat reorders that state.
        let chain = Promise.resolve()
        const feed = createSseParser(envelope => {
          chain = chain.then(async () => {
            try {
              await opts.onEnvelope(envelope)
              ack(envelope.envelopeId)
            } catch (err) {
              // No ack: the poller keeps it in-flight and redelivers on reconnect.
              process.stderr.write(
                `telegram channel: handling ${envelope.envelopeId} failed: ${err}\n`,
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
