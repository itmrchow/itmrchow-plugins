/**
 * Readiness gate between "this MCP server is connected" and "the Claude client
 * can actually receive channel notifications".
 *
 * Copied byte-identically into every channel plugin (see shared-parity.test.ts),
 * so nothing here may name a platform. Log lines say "channel:".
 *
 * Why it exists (JP-190). A freshly spawned scope subscribes to its poller the
 * moment its MCP transport is up, and the poller answers a subscription by
 * flushing that scope's queue — which, for a brand-new identity, holds the very
 * message that triggered the spawn. Claude Code registers its channel
 * notification handler only AFTER the transport handshake finishes, and a
 * notification that lands before the handler exists is dropped by the MCP client
 * with no error: notification() resolves, the subscriber acks, the poller clears
 * it from in-flight, and the sender's first message is gone for good.
 *
 * Measured on a1-b (17:34, discord-dm scope):
 *   30.904 server stderr "channel: subscribed as discord-dm-…"  <- flush happens here
 *   30.905 "Successfully connected (transport: stdio)"
 *   30.960 "Channel notifications registered"                   <- handler exists only now
 *
 * Long-lived scopes never see this — their messages arrive seconds or hours
 * after boot. A new scope's first message lands inside that window every time,
 * which is why the bug reads as "dynamic scopes never answer the first message".
 *
 * The gate is a delay, not a handshake, because the registration point is not
 * observable from inside the MCP server: the client tells us when it is
 * initialized and nothing after that. So we anchor on the one signal we do get
 * and hold the subscription a further grace period, sized far above the observed
 * gap rather than just above it.
 */

/**
 * How long to wait after the client reports itself initialized.
 *
 * Two orders of magnitude above the ~60ms gap measured above, and negligible
 * against the ~13s a scope already spends booting. It must stay well under the
 * poller's SPAWN_TIMEOUT_MS (30s), which is how long a spawned scope has to come
 * back and subscribe before the poller gives up and drops its queue.
 *
 * Sized for the handler-registration gap. Should the field ever show the client
 * also needs its session to be interactive before it can take a notification,
 * this constant is the single place to raise.
 */
export const READY_GRACE_MS = 3000

/**
 * How long to wait for the client's `initialized` before giving up on it.
 *
 * A client that never sends it must not leave the scope permanently unsubscribed
 * — silence is the failure this whole module exists to prevent, and an
 * unsubscribed scope is a worse version of it.
 */
export const READY_FALLBACK_MS = 10_000

export type ReadyGate = {
  /** Call from the MCP server's `oninitialized`. Idempotent. */
  markInitialized: () => void
  /** Resolves when channel notifications may safely be sent. Never rejects. */
  ready: Promise<void>
}

/**
 * Build the readiness gate for one MCP server process.
 *
 * @param opts.graceMs - Wait after `initialized`. Defaults to READY_GRACE_MS.
 * @param opts.fallbackMs - Give up waiting for `initialized` after this long.
 *   Defaults to READY_FALLBACK_MS.
 * @param opts.setTimer - Injectable for tests; production uses unref'd setTimeout.
 * @param opts.log - Diagnostics sink; defaults to stderr.
 * @returns The gate.
 */
export function createReadyGate(opts: {
  graceMs?: number
  fallbackMs?: number
  setTimer?: (fn: () => void, ms: number) => void
  log?: (line: string) => void
} = {}): ReadyGate {
  const graceMs = opts.graceMs ?? READY_GRACE_MS
  const fallbackMs = opts.fallbackMs ?? READY_FALLBACK_MS
  const setTimer = opts.setTimer ?? ((fn: () => void, ms: number) => void setTimeout(fn, ms).unref?.())
  const log = opts.log ?? ((line: string) => void process.stderr.write(line))

  let settle!: () => void
  const ready = new Promise<void>(resolve => {
    settle = resolve
  })

  let settled = false
  let initialized = false
  const finish = (): void => {
    if (settled) return
    settled = true
    settle()
  }

  setTimer(() => {
    if (initialized) return
    log(`channel: MCP client never reported initialized within ${fallbackMs}ms; subscribing anyway\n`)
    finish()
  }, fallbackMs)

  return {
    markInitialized: (): void => {
      if (initialized) return
      initialized = true
      setTimer(finish, graceMs)
    },
    ready,
  }
}
