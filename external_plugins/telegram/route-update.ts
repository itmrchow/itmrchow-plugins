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

  const outcome = await ctx.spawn(scopeId)
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

/**
 * Walk a batch of updates, returning the offset for the next getUpdates call.
 *
 * The offset advances only AFTER an update is handled. The previous code
 * advanced first and discarded the forward result, so anything that failed to
 * reach a scope was acknowledged to Telegram and lost for good — and under the
 * dynamic architecture "cannot deliver yet" is the normal state during a spawn,
 * exactly when messages most need to survive.
 *
 * A failing update stops the walk and is returned rather than thrown, so the
 * caller resumes from an offset that still includes it. Throwing instead would
 * put offset preservation in the caller's hands, where the original bug lived.
 *
 * @param updates - Updates from one getUpdates call, in order.
 * @param route - Handler for one update.
 * @param currentOffset - Offset used for this batch.
 * @returns The offset to use next, plus the error that stopped the walk.
 */
export async function consumeUpdates(
  updates: readonly Update[],
  route: (update: Update) => Promise<void>,
  currentOffset: number | undefined,
): Promise<{ offset: number | undefined; error?: unknown }> {
  let offset = currentOffset
  for (const update of updates) {
    try {
      await route(update)
    } catch (error) {
      return { offset, error }
    }
    offset = update.update_id + 1
  }
  return { offset }
}
