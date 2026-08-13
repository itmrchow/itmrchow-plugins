// Liveness of the gateway connection, judged by the poller itself.
//
// JP-195: the bot went silent for ~10 hours with the socket still ESTABLISHED
// and nothing in the journal; a restart fixed it. The library's own recovery
// chain has a bounded worst case — zombie detection at ~41s without a heartbeat
// ACK, then WebSocketShard#destroy, whose `await` on the `close` event is capped
// by the `ws` package's own 30s close timer (production runs Node + `ws` via
// tsx, not Bun's native WebSocket) — roughly 77s end to end including the
// reconnect. Ten hours of silence therefore means something else failed, and
// that failure point is still unidentified.
//
// This module does not fix that unknown failure. It is a process-level liveness
// watchdog: a mitigation that bounds the outage, and — together with the gateway
// event logging in discord-poller.ts — the instrumentation needed to identify
// the real cause when it recurs. Liveness is measured from the outside (the
// newest heartbeat ACK or dispatch the poller has seen) exactly because no
// particular internal mechanism can be trusted while the root cause is unknown.
// Nothing here talks to discord.js — the poller feeds it timestamps — because
// the poller cannot be imported by a test.

/** How often the poller re-evaluates liveness. */
export const HEALTH_CHECK_INTERVAL_MS = 60_000

/** Silence after which the connection is presumed dead. Discord's heartbeat
 *  interval is ~41s, so this is roughly seven missed beats — long enough that an
 *  ordinary reconnect finishes first, short enough to bound the outage. */
export const GATEWAY_STALE_AFTER_MS = 5 * 60_000

export interface GatewayHealthSnapshot {
  /** Newest gateway sign of life, epoch ms; -1 before the first one. */
  lastActivityAt: number
  /** Silence since that sign of life, ms; -1 when there has been none. */
  ageMs: number
  stale: boolean
}

export interface GatewayHealthOptions {
  /** Newest heartbeat ACK timestamp, or -1 when the shard has never acked. */
  lastAckAt: () => number
  now?: () => number
  staleAfterMs?: number
}

export interface GatewayHealth {
  /** Record a gateway event (dispatch, ready, resume) as a sign of life. */
  markActivity: () => void
  snapshot: () => GatewayHealthSnapshot
}

/**
 * Track how long the gateway has been silent.
 *
 * Heartbeat ACKs are read through a callback rather than pushed in: discord.js
 * only surfaces them on the `debug` channel, but keeps the timestamp on the
 * shard, so polling it at check time is both cheaper and less brittle than
 * parsing log text.
 *
 * @param options - ACK source, plus clock and threshold overrides for tests.
 * @returns Handles to record activity and to read the current verdict.
 */
export function createGatewayHealth(options: GatewayHealthOptions): GatewayHealth {
  const now = options.now ?? Date.now
  const staleAfterMs = options.staleAfterMs ?? GATEWAY_STALE_AFTER_MS
  let lastEventAt = -1

  return {
    markActivity: (): void => {
      lastEventAt = now()
    },
    snapshot: (): GatewayHealthSnapshot => {
      const lastActivityAt = Math.max(lastEventAt, options.lastAckAt())
      if (lastActivityAt < 0) return { lastActivityAt, ageMs: -1, stale: false }
      const ageMs = now() - lastActivityAt
      return { lastActivityAt, ageMs, stale: ageMs > staleAfterMs }
    },
  }
}

/**
 * Whether a discord.js `debug` line is worth a journal entry.
 *
 * The debug channel is where the gateway says everything interesting —
 * "Destroying shard, Reason: Zombie connection" included — but it also repeats a
 * heartbeat ACK every ~41s. Dropping that one line keeps the rest loggable
 * unconditionally, which is the point: the JP-195 incident left no trace because
 * nothing listened here.
 *
 * @param message - The message discord.js passed to the debug event.
 * @returns True when the line should be written to stderr.
 */
export function shouldLogGatewayDebug(message: string): boolean {
  return !message.includes('Heartbeat acknowledged')
}
