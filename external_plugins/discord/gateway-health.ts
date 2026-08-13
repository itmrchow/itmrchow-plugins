// Liveness of the gateway connection, judged by the poller itself.
//
// Why the library's own recovery is not enough (JP-195): @discordjs/ws detects a
// zombie connection (a heartbeat with no ACK) and calls WebSocketShard#destroy,
// which — when the socket is still OPEN — sends a close frame and then
// `await`s the `close` event before reconnecting. On a black-holed TCP
// connection (NAT dropped the flow, no RST) that event never arrives, so the
// destroy hangs INSIDE the recovery path: the process stays up, the socket stays
// ESTABLISHED, no shardDisconnect / shardReconnecting is ever emitted, and the
// bot is silent until someone restarts it.
//
// So liveness is measured from the outside instead: the newest heartbeat ACK or
// dispatch the poller has seen. Nothing here talks to discord.js — the poller
// feeds it timestamps — because the poller cannot be imported by a test.

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
