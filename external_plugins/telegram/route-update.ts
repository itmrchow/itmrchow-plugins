import { randomUUID } from 'node:crypto'
import type { Update } from 'grammy/types'
import { buildScopeId } from './scope-id'
import type { ScopeRegistry } from './poller-registry'
import type { InboundEnvelope } from './subscribe-protocol'

const PLATFORM = 'telegram'
const PRIVATE_CHAT = 'private'
/** How long a freshly spawned scope has to come back and subscribe. */
export const SPAWN_TIMEOUT_MS = 30_000

const CAP_REACHED_TEXT = '目前容量已滿，請稍後再試。'
const SPAWN_FAILED_TEXT = '暫時無法回應，請稍後再試。'
const NOT_CONFIGURED_TEXT = '服務未完整設定，請聯絡管理者。'

/** Outcome of asking the carrier to bring a scope up. */
export type SpawnOutcome = 'ok' | 'cap_reached' | 'invalid_scope' | 'failed' | 'not_configured'

/** Where a message belongs: one anchor identity per Claude session. */
export type ScopeTarget = { kind: 'dm' | 'group'; anchorId: number; chatId: number }

export type RouteContext = {
  registry: ScopeRegistry
  /** Writes to a live subscription; false means nothing is connected. */
  deliver: (scopeId: string, envelopes: InboundEnvelope[]) => boolean
  spawn: (scopeId: string) => Promise<SpawnOutcome>
  /** User-facing message back to the originating chat. */
  notify: (chatId: number, text: string) => Promise<void>
  botInfo?: unknown
  /** Injectable for tests; production uses setTimeout. */
  setTimer?: (fn: () => void, ms: number) => void
}

type ChatLike = { id: number; type: string }

function extractChat(update: Update): ChatLike | undefined {
  const post =
    update.message ??
    update.edited_message ??
    update.channel_post ??
    update.edited_channel_post ??
    update.callback_query?.message
  return (post?.chat ??
    update.my_chat_member?.chat ??
    update.chat_member?.chat) as ChatLike | undefined
}

function extractSenderId(update: Update): number | undefined {
  return (
    update.message?.from?.id ??
    update.edited_message?.from?.id ??
    update.callback_query?.from?.id ??
    update.my_chat_member?.from?.id ??
    update.chat_member?.from?.id
  )
}

/**
 * Decide which scope a raw Telegram update belongs to.
 *
 * A private chat anchors on the sender, so one person keeps one session across
 * every chat surface; anything else anchors on the chat, so a group is one
 * shared session rather than one per participant.
 *
 * @param update - Raw Telegram Bot API update.
 * @returns The anchor, or null when the update carries no chat at all (poll
 *   answers, inline queries) and therefore belongs to no scope.
 */
export function resolveUpdateScope(update: Update): ScopeTarget | null {
  const chat = extractChat(update)
  if (!chat) return null
  if (chat.type === PRIVATE_CHAT) {
    return { kind: 'dm', anchorId: extractSenderId(update) ?? chat.id, chatId: chat.id }
  }
  return { kind: 'group', anchorId: chat.id, chatId: chat.id }
}

/**
 * Scopes with a spawn call currently awaiting a result.
 *
 * A disconnected scope asks for a spawn on EVERY arriving message (that is the
 * JP-198 fix), so a burst of N messages fires N concurrent scope-spawn.sh
 * processes onto one box-wide lock. That lock retries at one-second granularity
 * and gives up after SPAWN_LOCK_TIMEOUT_SECONDS, so past ~10 competitors the
 * losers exit non-zero — which this file reads as a failed spawn and answers by
 * dropping the whole queue and telling the user we cannot respond. Collapsing
 * the burst to one in-flight call per scope keeps the retry idempotent without
 * adding a second timeout state machine.
 *
 * Module-level because it guards a process-wide resource (the spawn lock), not
 * anything a single route call owns. It is NOT a connection state: the registry
 * still owns connecting/disconnected, and this set says nothing about them.
 */
const spawnsInFlight = new Set<string>()

function textForOutcome(outcome: SpawnOutcome): string {
  if (outcome === 'cap_reached') return CAP_REACHED_TEXT
  if (outcome === 'not_configured') return NOT_CONFIGURED_TEXT
  return SPAWN_FAILED_TEXT
}

/**
 * Abandon a scope that never came up, telling whoever was waiting.
 *
 * Silence here is the failure mode this exists to prevent: without it a failed
 * spawn leaves the identity stuck in `connecting` forever, so every later
 * message is queued into a scope that will never read it.
 */
async function abandonScope(
  scopeId: string,
  chatId: number,
  outcome: SpawnOutcome,
  ctx: RouteContext,
): Promise<void> {
  const dropped = ctx.registry.onSpawnFailed(scopeId)
  process.stderr.write(
    `telegram poller: spawn ${outcome} for ${scopeId}, dropping ${dropped.length} queued update(s)\n`,
  )
  await ctx.notify(chatId, textForOutcome(outcome))
}

/**
 * Route one raw update to its scope, spawning that scope if it does not exist.
 *
 * Deliberately does NOT apply the access policy: dmPolicy / allowFrom /
 * requireMention / pairing all stay in server.ts's gate(). A partial copy here
 * would mean two independent verdicts on the same message.
 *
 * Expected failures (no scope, spawn refused, delivery race) are handled and
 * reported inside; a throw out of this function means the update was NOT
 * handled, which is what keeps the poll offset from advancing past it.
 *
 * @param update - Raw Telegram Bot API update.
 * @param ctx - Injected collaborators.
 */
export async function routeUpdate(update: Update, ctx: RouteContext): Promise<void> {
  const target = resolveUpdateScope(update)
  if (!target) {
    process.stderr.write(
      `telegram poller: update ${update.update_id} has no chat, dropping\n`,
    )
    return
  }

  const scopeId = buildScopeId(PLATFORM, target.kind, target.anchorId)
  const envelope: InboundEnvelope = {
    envelopeId: randomUUID(),
    scopeId,
    platform: PLATFORM,
    payload: update,
    ts: Date.now(),
    botInfo: ctx.botInfo,
  }

  const decision = ctx.registry.admit(scopeId, envelope)

  if (decision.action === 'deliver') {
    // The socket can die between admit() and write(). Falling back to the queue
    // keeps the message alive for the reconnect instead of writing it into a
    // closed pipe and calling it delivered.
    if (!ctx.deliver(scopeId, decision.envelopes)) {
      ctx.registry.onDisconnected(scopeId)
      ctx.registry.requeue(scopeId, decision.envelopes)
    }
    return
  }

  if (decision.action === 'queued') return

  if (decision.action === 'rejected') {
    if (decision.reason === 'cap_reached') {
      process.stderr.write(`telegram poller: scope_cap_reached, refusing ${scopeId}\n`)
      await ctx.notify(target.chatId, CAP_REACHED_TEXT)
      return
    }
    process.stderr.write(`telegram poller: queue full for ${scopeId}, dropping update\n`)
    return
  }

  // The update is already queued by admit(); the pending spawn's subscribe will
  // flush it along with everything else, so skipping the duplicate call loses
  // nothing.
  if (spawnsInFlight.has(scopeId)) return
  spawnsInFlight.add(scopeId)
  let outcome: SpawnOutcome
  try {
    outcome = await ctx.spawn(scopeId)
  } finally {
    spawnsInFlight.delete(scopeId)
  }

  if (outcome !== 'ok') {
    await abandonScope(scopeId, target.chatId, outcome, ctx)
    return
  }

  const setTimer = ctx.setTimer ?? ((fn, ms) => void setTimeout(fn, ms).unref?.())
  setTimer(() => {
    if (ctx.registry.state(scopeId) === 'connecting') {
      void abandonScope(scopeId, target.chatId, 'failed', ctx)
    }
  }, SPAWN_TIMEOUT_MS)
}

export type ConsumeContext = {
  route: (update: Update) => Promise<void>
  /** Defaults to stderr. Injectable so tests can read what was reported. */
  log?: (line: string) => void
}

/** Walks one getUpdates batch and returns the offset for the next call. */
export type UpdateConsumer = (
  updates: readonly Update[],
  currentOffset: number | undefined,
) => Promise<number | undefined>

/**
 * Build the batch consumer for one poller.
 *
 * The per-update failure counter lives in this closure rather than in a field
 * the caller passes in: it has to survive ACROSS getUpdates batches (a poison
 * update comes back in a new batch every time, so a counter scoped to one call
 * resets to 1 forever and never reaches the threshold), and a caller-owned
 * object makes that lifetime an invisible contract — pass a fresh literal per
 * batch and the poison-pill guard silently stops working, with no type error.
 *
 * @param ctx - Handler and optional log sink.
 * @returns A consumer that owns its own cross-batch state.
 */
export function createUpdateConsumer(ctx: ConsumeContext): UpdateConsumer {
  const failures = new Map<number, number>()
  return (updates, currentOffset) => consumeUpdates(updates, ctx, currentOffset, failures)
}

/** Consecutive failures on one update before it is skipped as a poison pill. */
export const POISON_PILL_MAX_ATTEMPTS = 3

/**
 * Best-effort scope-id for logging only.
 *
 * Never throws: an update whose scope cannot be computed is itself a likely
 * poison cause, and the log line explaining that must not be what crashes.
 */
function describeScope(update: Update): string {
  try {
    const target = resolveUpdateScope(update)
    return target ? buildScopeId(PLATFORM, target.kind, target.anchorId) : 'unknown'
  } catch {
    return 'unknown'
  }
}

/**
 * Walk a batch of updates, returning the offset for the next getUpdates call.
 *
 * The offset advances only AFTER an update is handled. The previous code
 * advanced first and discarded the forward result, so anything that failed to
 * reach a scope was acknowledged to Telegram and lost for good — and under the
 * dynamic architecture "cannot deliver yet" is the normal state during a spawn,
 * exactly when messages most need to survive.
 *
 * A failure stops the walk and is reported through the returned offset rather
 * than thrown, so offset preservation is a property of this function instead of
 * its caller — which is where the original bug lived.
 *
 * Holding the offset back has its own failure mode, so it is bounded: an update
 * that fails POISON_PILL_MAX_ATTEMPTS times in a row is logged and skipped.
 * Without that, one permanently unprocessable update pins the offset forever,
 * Telegram redelivers it endlessly, and the platform goes deaf to everything
 * else — strictly worse than losing that one message. Transient failures never
 * reach the threshold: while a scope is spawning or reconnecting, the registry
 * already counts the message as queued, i.e. handled.
 *
 * @param updates - Updates from one getUpdates call, in order.
 * @param ctx - Handler and optional log sink.
 * @param currentOffset - Offset used for this batch.
 * @param failures - Cross-batch failure counter, owned by createUpdateConsumer.
 * @returns The offset to use next.
 */
async function consumeUpdates(
  updates: readonly Update[],
  ctx: ConsumeContext,
  currentOffset: number | undefined,
  failures: Map<number, number>,
): Promise<number | undefined> {
  const log = ctx.log ?? ((line: string) => void process.stderr.write(`${line}\n`))
  let offset = currentOffset

  for (const update of updates) {
    try {
      await ctx.route(update)
      failures.delete(update.update_id)
      offset = update.update_id + 1
      continue
    } catch (error) {
      const attempts = (failures.get(update.update_id) ?? 0) + 1
      failures.set(update.update_id, attempts)

      if (attempts < POISON_PILL_MAX_ATTEMPTS) {
        log(
          `telegram poller: route failed (attempt ${attempts}/${POISON_PILL_MAX_ATTEMPTS}) ` +
          `update_id=${update.update_id} scope=${describeScope(update)}: ${error}`,
        )
        return offset
      }

      // Dropping a message must never be silent: this line is the only trace
      // anyone will ever have that it happened.
      log(
        `telegram poller: poison_pill_skipped update_id=${update.update_id} ` +
        `scope=${describeScope(update)} attempts=${attempts}: ${error}`,
      )
      failures.delete(update.update_id)
      offset = update.update_id + 1
    }
  }
  return offset
}
