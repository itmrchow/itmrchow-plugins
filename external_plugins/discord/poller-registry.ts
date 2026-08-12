import type { InboundEnvelope } from './subscribe-protocol'

export type ConnectionState = 'connecting' | 'connected' | 'disconnected'

export type DispatchResult =
  | { action: 'deliver'; envelopes: InboundEnvelope[] }
  | { action: 'queued' }
  | { action: 'spawn' }
  | { action: 'rejected'; reason: 'queue_full' | 'cap_reached' }

type Entry = { state: ConnectionState; queue: InboundEnvelope[] }

/**
 * The poller's in-memory registry: identity -> { connection state, pending queue }.
 *
 * Deliberately IO-free (no HTTP, no tmux, no Bot API) so every arrival scenario
 * can be pinned by pure-function tests, and so the discord poller can reuse it
 * verbatim.
 *
 * Nothing is persisted, on purpose: a scope-id is a pure function of the sender
 * identity, a connection state written to disk is stale the moment the process
 * dies, and the only question that genuinely outlives a restart — "has this
 * identity talked to us before?" — is already answered by the session pointer
 * file on disk.
 */
export class ScopeRegistry {
  readonly #entries = new Map<string, Entry>()
  readonly #maxScopes: number
  readonly #maxQueue: number

  /**
   * @param opts.maxScopes - Cap on simultaneously live scopes; each one costs a
   *   full Claude process, so an uncapped registry lets a burst of unknown
   *   senders exhaust the host.
   * @param opts.maxQueue - Cap on messages held per scope while it starts up.
   */
  constructor(opts: { maxScopes: number; maxQueue: number }) {
    this.#maxScopes = opts.maxScopes
    this.#maxQueue = opts.maxQueue
  }

  /**
   * Accept one message and decide what should happen to it. The caller performs
   * the IO implied by the returned action.
   *
   * @param scopeId - The scope this message belongs to.
   * @param envelope - The message.
   * @returns The dispatch decision.
   */
  admit(scopeId: string, envelope: InboundEnvelope): DispatchResult {
    const entry = this.#entries.get(scopeId)
    if (!entry) {
      if (this.#entries.size >= this.#maxScopes) return { action: 'rejected', reason: 'cap_reached' }
      this.#entries.set(scopeId, { state: 'connecting', queue: [envelope] })
      return { action: 'spawn' }
    }
    if (entry.state === 'connected') return { action: 'deliver', envelopes: [envelope] }
    // connecting and disconnected share the queue path. They differ only in that
    // disconnected must NOT re-trigger a spawn: that process is still alive and
    // merely reconnecting, and a second one would leave two Claudes fighting
    // over the same scope's session pointer.
    if (entry.queue.length >= this.#maxQueue) return { action: 'rejected', reason: 'queue_full' }
    entry.queue.push(envelope)
    return { action: 'queued' }
  }

  /**
   * A scope's server.ts has subscribed.
   *
   * @param scopeId - The subscribing scope.
   * @returns Queued messages to replay, oldest first.
   */
  onSubscribed(scopeId: string): InboundEnvelope[] {
    const entry = this.#entries.get(scopeId)
    if (!entry) {
      this.#entries.set(scopeId, { state: 'connected', queue: [] })
      return []
    }
    entry.state = 'connected'
    const pending = entry.queue
    entry.queue = []
    return pending
  }

  /**
   * The subscription socket dropped. The entry is kept: the process is probably
   * still alive and reconnecting.
   *
   * @param scopeId - The scope that disconnected.
   */
  onDisconnected(scopeId: string): void {
    const entry = this.#entries.get(scopeId)
    if (entry) entry.state = 'disconnected'
  }

  /**
   * Spawn failed or timed out. Drops the entry so the identity can try again,
   * and hands back whatever never got delivered.
   *
   * @param scopeId - The scope that failed to come up.
   * @returns Undelivered messages, for reporting back to the sender.
   */
  onSpawnFailed(scopeId: string): InboundEnvelope[] {
    const entry = this.#entries.get(scopeId)
    if (!entry) return []
    this.#entries.delete(scopeId)
    return entry.queue
  }

  /**
   * Put messages that were written to a subscription but never acked back at
   * the head of the queue, so a socket that dies mid-delivery costs a redelivery
   * rather than the message. Without this the /ack half of the protocol would
   * be decorative.
   *
   * Over capacity, the newest are dropped and the oldest kept — the same policy
   * admit() uses, so whatever survives stays causally ordered.
   *
   * @param scopeId - The scope whose connection dropped.
   * @param envelopes - Un-acked messages, oldest first.
   */
  requeue(scopeId: string, envelopes: InboundEnvelope[]): void {
    const entry = this.#entries.get(scopeId)
    if (!entry || envelopes.length === 0) return
    entry.queue.unshift(...envelopes)
    if (entry.queue.length > this.#maxQueue) entry.queue.length = this.#maxQueue
  }

  /** @returns Number of scopes currently tracked, used for the cap check. */
  size(): number {
    return this.#entries.size
  }

  /**
   * @param scopeId - The scope to inspect.
   * @returns Its connection state, or undefined when unknown.
   */
  state(scopeId: string): ConnectionState | undefined {
    return this.#entries.get(scopeId)?.state
  }
}
