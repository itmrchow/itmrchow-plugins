import { randomUUID } from 'node:crypto'
import { buildScopeId } from './scope-id'
import { resolveScopeAnchor, type AnchorInput } from './scope-anchor'
import type { ScopeRegistry } from './poller-registry'
import type { InboundEnvelope } from './subscribe-protocol'

const PLATFORM = 'discord'
/** How long a freshly spawned scope has to come back and subscribe. */
export const SPAWN_TIMEOUT_MS = 30_000

const CAP_REACHED_TEXT = 'At capacity right now — please try again shortly.'
const SPAWN_FAILED_TEXT = 'Temporarily unable to respond — please try again shortly.'
const NOT_CONFIGURED_TEXT = 'Service is not fully configured; contact the operator.'

/** Outcome of asking the carrier to bring a scope up. */
export type SpawnOutcome = 'ok' | 'cap_reached' | 'invalid_scope' | 'failed' | 'not_configured'

/**
 * Which gateway event produced this payload.
 *
 * Carried on the wire because a discord payload, unlike a Telegram `Update`, is
 * not self-describing: a message JSON and an interaction JSON are both bare
 * objects with an `id`. The subscriber has to know which one it is holding
 * before it can decide whether to reply or to answer an interaction token.
 */
export type InboundKind = 'messageCreate' | 'interactionCreate'

/** What travels in `InboundEnvelope.payload` for this platform. */
export type DiscordPayload = { kind: InboundKind; data: unknown }

/** One gateway event, reduced to what routing needs. */
export type RouteInput = AnchorInput & {
  kind: InboundKind
  /** Raw JSON of the event — never a discord.js instance; those do not survive
   *  JSON serialisation. */
  data: unknown
}

export type RouteContext = {
  registry: ScopeRegistry
  /** Writes to a live subscription; false means nothing is connected. */
  deliver: (scopeId: string, envelopes: InboundEnvelope[]) => boolean
  spawn: (scopeId: string) => Promise<SpawnOutcome>
  /** User-facing message back to the originating channel. */
  notify: (channelId: string, text: string) => Promise<void>
  botInfo?: unknown
  /** Injectable for tests; production uses setTimeout. */
  setTimer?: (fn: () => void, ms: number) => void
  /** Defaults to stderr. Injectable so tests can read what was reported. */
  log?: (line: string) => void
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
  channelId: string,
  outcome: SpawnOutcome,
  ctx: RouteContext,
  log: (line: string) => void,
): Promise<void> {
  const dropped = ctx.registry.onSpawnFailed(scopeId)
  log(`discord poller: spawn ${outcome} for ${scopeId}, dropping ${dropped.length} queued event(s)`)
  await ctx.notify(channelId, textForOutcome(outcome))
}

/**
 * Route one gateway event to its scope, spawning that scope if it does not exist.
 *
 * Deliberately does NOT apply the access policy: dmPolicy / allowFrom /
 * requireMention / pairing all stay in server.ts's gate(), so there is exactly
 * one verdict per message. A partial copy here would mean two.
 *
 * Expected failures (spawn refused, delivery race) are handled and reported
 * inside. A throw means the event was not handled at all; the caller decides
 * what to do with that — unlike Telegram there is no offset to hold back, so a
 * gateway event that throws is simply lost.
 *
 * @param input - The event, reduced to anchor facts plus its raw JSON.
 * @param ctx - Injected collaborators.
 */
export async function routeMessage(input: RouteInput, ctx: RouteContext): Promise<void> {
  const log = ctx.log ?? ((line: string) => void process.stderr.write(`${line}\n`))
  const anchor = resolveScopeAnchor(input)
  const scopeId = buildScopeId(PLATFORM, anchor.kind, anchor.anchorId)
  const payload: DiscordPayload = { kind: input.kind, data: input.data }
  const envelope: InboundEnvelope = {
    envelopeId: randomUUID(),
    scopeId,
    platform: PLATFORM,
    payload,
    ts: Date.now(),
    botInfo: ctx.botInfo,
  }

  const decision = ctx.registry.admit(scopeId, envelope)

  if (decision.action === 'deliver') {
    // The socket can die between admit() and write(). Falling back to the queue
    // keeps the event alive for the reconnect instead of writing it into a
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
      log(`discord poller: scope_cap_reached, refusing ${scopeId}`)
      await ctx.notify(input.channelId, CAP_REACHED_TEXT)
      return
    }
    log(`discord poller: queue full for ${scopeId}, dropping event`)
    return
  }

  const outcome = await ctx.spawn(scopeId)
  if (outcome !== 'ok') {
    await abandonScope(scopeId, input.channelId, outcome, ctx, log)
    return
  }

  const setTimer = ctx.setTimer ?? ((fn, ms) => void setTimeout(fn, ms).unref?.())
  setTimer(() => {
    if (ctx.registry.state(scopeId) === 'connecting') {
      void abandonScope(scopeId, input.channelId, 'failed', ctx, log)
    }
  }, SPAWN_TIMEOUT_MS)
}
