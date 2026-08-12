/**
 * Wire format between the platform poller (the sole gateway holder) and each
 * scope's server.ts, carried as SSE over loopback HTTP.
 *
 * Kept inside the plugin directory for the same reason as scope-id.ts: an
 * installed plugin is a self-contained directory copy, so a repo-level
 * `../_shared` import does not exist at runtime.
 */

/** One inbound message pushed to a scope. `payload` keeps its platform-native
 *  shape (a Telegram `Update`, a Discord message JSON) so server.ts can feed it
 *  straight to the platform library. */
export type InboundEnvelope = {
  envelopeId: string
  scopeId: string
  platform: string
  payload: unknown
  ts: number
  /**
   * The bot's own identity, as returned by getMe.
   *
   * Carried on the wire because a subscriber cannot obtain it for itself: an
   * in-process getMe starves under the MCP stdin watcher on arm64-linux, which
   * is the entire reason the poller exists. Repeating it per message costs a
   * few bytes and removes a startup ordering dependency; subscribers apply it
   * once and ignore it thereafter.
   */
  botInfo?: unknown
}

/** SSE comment line. The poller sends one every 20s so a subscriber can tell
 *  "quiet" apart from "dead socket" without a protocol-level ping. */
export const SSE_KEEPALIVE = ': keepalive\n\n'

/** Idle budget on the subscriber side: no bytes at all (not even a keepalive)
 *  for this long means the connection is gone. Slack over 2 keepalives. */
export const SSE_IDLE_TIMEOUT_MS = 45_000

/** How often the poller writes SSE_KEEPALIVE to every open subscription. */
export const SSE_KEEPALIVE_INTERVAL_MS = 20_000

const EVENT_PREFIX = 'event: message\ndata: '
const DATA_PREFIX = 'data: '
const FRAME_SEPARATOR = '\n\n'

/**
 * Encode an envelope as one SSE frame.
 *
 * A single `data:` line is enough because JSON.stringify escapes newlines —
 * without that guarantee an embedded newline would split the frame and the
 * subscriber would parse a truncated fragment.
 *
 * @param envelope - The message to push.
 * @returns A complete SSE frame, terminated by a blank line.
 */
export function encodeSse(envelope: InboundEnvelope): string {
  return `${EVENT_PREFIX}${JSON.stringify(envelope)}${FRAME_SEPARATOR}`
}

/**
 * Create an incremental SSE parser.
 *
 * The returned function accepts arbitrarily chopped string chunks: TCP does not
 * align frame boundaries with write() calls, so a "one chunk, one frame"
 * assumption holds in tests and fails in production.
 *
 * A malformed data line drops only that frame and is logged to stderr rather
 * than thrown — one bad message must not tear down the subscription, which
 * would leave that scope receiving nothing at all from then on.
 *
 * @param onEnvelope - Called once per successfully parsed envelope, in order.
 * @returns A feed function to hand each incoming chunk to.
 */
export function createSseParser(
  onEnvelope: (envelope: InboundEnvelope) => void,
): (chunk: string) => void {
  let buffer = ''
  return (chunk: string): void => {
    buffer += chunk
    let boundary = buffer.indexOf(FRAME_SEPARATOR)
    while (boundary !== -1) {
      const frame = buffer.slice(0, boundary)
      buffer = buffer.slice(boundary + FRAME_SEPARATOR.length)
      const dataLine = frame.split('\n').find(line => line.startsWith(DATA_PREFIX))
      if (dataLine) {
        try {
          onEnvelope(JSON.parse(dataLine.slice(DATA_PREFIX.length)) as InboundEnvelope)
        } catch (err) {
          process.stderr.write(`sse parser: dropping malformed frame: ${err}\n`)
        }
      }
      boundary = buffer.indexOf(FRAME_SEPARATOR)
    }
  }
}
