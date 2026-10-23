/**
 * Session-direct routing, poller side (JP-380): a DM that quote-replies to a
 * bot message goes straight to the Claude session that message came from,
 * instead of through the hub.
 *
 * Everything here only ever narrows: whenever a step cannot be decided — no
 * reply, an unknown message, a session that is not online — the caller routes
 * the update exactly as it did before this module existed. The poller never
 * spawns a session-direct scope.
 *
 * Split out of poller.ts for the same reason as the other small modules here:
 * poller.ts exits at import time when half-configured, so it cannot be imported
 * by a test.
 */
import type { Update } from 'grammy/types'
import { isAbsolute } from 'node:path'
import type { ScopeRegistry } from './poller-registry'
import type { MessageMapLookup } from './message-map'

/** Poller switch for session-direct routing. Off unless explicitly `1` / `true`. */
export const SESSION_DIRECT_SWITCH_ENV = 'TELEGRAM_SESSION_DIRECT'
/** Where the message -> session map lives. No default: the path is config, not code. */
export const MESSAGE_MAP_FILE_ENV = 'TELEGRAM_MESSAGE_MAP_FILE'

const ENABLING_VALUES: ReadonlySet<string> = new Set(['1', 'true'])
const PRIVATE_CHAT = 'private'
const COMMAND_PREFIX = '/'

/**
 * A session-direct scope: `telegram-dm-s<32 hex>`. It passes SCOPE_ID_RE, and
 * the `s` right after `-dm-` keeps it apart from every scope the poller derives
 * itself — those end in a numeric user / chat id (a negative one becomes `n…`).
 */
const SESSION_SCOPE_PREFIX = 'telegram-dm-s'
const SESSION_SCOPE_RE = /^telegram-dm-s[0-9a-f]{32}$/
const SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export type PollerSessionDirect =
  | { enabled: true; mapFile: string }
  | { enabled: false; reason: string }

/**
 * Build the scope a Claude session subscribes under in session-direct mode.
 *
 * Deterministic, so the poller (reading a session id out of the message map)
 * and the session's own server.ts (reading CLAUDE_CODE_SESSION_ID) land on the
 * same scope without talking to each other.
 *
 * @param sessionId - A Claude Code session id (UUID).
 * @returns The scope, or undefined when sessionId is not a UUID.
 */
export function buildSessionScopeId(sessionId: string): string | undefined {
  const trimmed = sessionId.trim()
  if (!SESSION_ID_RE.test(trimmed)) return undefined
  return `${SESSION_SCOPE_PREFIX}${trimmed.toLowerCase().replace(/-/g, '')}`
}

/**
 * @param scopeId - Candidate scope-id.
 * @returns true when it is a session-direct scope.
 */
export function isSessionScopeId(scopeId: string): boolean {
  return SESSION_SCOPE_RE.test(scopeId)
}

/**
 * Read the poller's session-direct settings. Fail-closed: the switch must be
 * `1` / `true`, and without a map file there is nothing to route by.
 *
 * @param env - Process environment, after the state .env load.
 * @returns Enabled with the map path, or disabled with the reason for the log.
 */
export function resolvePollerSessionDirect(env: Record<string, string | undefined>): PollerSessionDirect {
  const raw = (env[SESSION_DIRECT_SWITCH_ENV] ?? '').trim()
  if (raw === '') return { enabled: false, reason: 'unset' }
  if (!ENABLING_VALUES.has(raw.toLowerCase())) return { enabled: false, reason: 'value is not 1 / true' }
  const mapFile = resolveMessageMapFile(env)
  if (!mapFile) return { enabled: false, reason: `${MESSAGE_MAP_FILE_ENV} unset or not an absolute path` }
  return { enabled: true, mapFile }
}

/**
 * The message map path, shared by the poller (reads it) and a session-direct
 * server (appends what its reply tool sends). One variable for both, so the
 * two cannot drift onto different files.
 *
 * @param env - Process environment, after the state .env load.
 * @returns The absolute path, or undefined when unset or relative.
 */
export function resolveMessageMapFile(env: Record<string, string | undefined>): string | undefined {
  const mapFile = (env[MESSAGE_MAP_FILE_ENV] ?? '').trim()
  return mapFile !== '' && isAbsolute(mapFile) ? mapFile : undefined
}

/**
 * Decide whether a scope may subscribe.
 *
 * Only session-direct scopes are ever refused, so every other scope keeps
 * today's behaviour. A session scope is admitted only while the switch is on,
 * and only while the live total stays under maxScopes — except a scope that is
 * already connected, which is a reconnect / takeover and keeps its slot. The
 * hub is never squeezed by this: session scopes are cap-exempt in admit(), and
 * the hub's own subscription never passes through a refusal.
 *
 * @param scopeId - The subscribing scope.
 * @param opts.enabled - The poller switch.
 * @param opts.registry - Live connection state.
 * @param opts.maxScopes - The poller's scope cap.
 * @returns true to admit the subscription.
 */
export function authorizeSessionSubscription(
  scopeId: string,
  opts: { enabled: boolean; registry: ScopeRegistry; maxScopes: number },
): boolean {
  if (!isSessionScopeId(scopeId)) return true
  if (!opts.enabled) return false
  if (opts.registry.state(scopeId) === 'connected') return true
  return opts.registry.liveCount() < opts.maxScopes
}

/**
 * Find the session-direct scope a DM reply belongs to.
 *
 * Every condition must hold, otherwise undefined (= route as before):
 * a new private message from an allowlisted sender, quote-replying to a
 * message this bot sent, not a /command (those stay with the hub, which owns
 * the control plane), and the replied-to message is in the map with a session
 * id. A map entry that records a chat id must match this chat: Telegram
 * numbers messages per chat, so a bare message id alone can name a message in
 * someone else's chat.
 *
 * Reading allowFrom here is a routing narrowing, not a second access verdict:
 * a sender who fails it is routed exactly as before, to the hub, whose server
 * applies the real gate.
 *
 * @param update - Raw Telegram update.
 * @param deps.botId - This bot's user id.
 * @param deps.allowFrom - access.json allowFrom, read fresh.
 * @param deps.lookup - Message map lookup.
 * @returns The session scope, or undefined.
 */
export function resolveReplyDirectScope(
  update: Update,
  deps: { botId: number; allowFrom: () => string[]; lookup: MessageMapLookup },
): string | undefined {
  const message = update.message
  if (!message || message.chat.type !== PRIVATE_CHAT || !message.from) return undefined
  const replied = message.reply_to_message
  if (!replied || replied.from?.id !== deps.botId) return undefined
  if ((message.text ?? '').startsWith(COMMAND_PREFIX)) return undefined
  if (!deps.allowFrom().includes(String(message.from.id))) return undefined
  const entry = deps.lookup(replied.message_id)
  if (!entry) return undefined
  if (entry.chatId !== undefined && entry.chatId !== String(message.chat.id)) return undefined
  return buildSessionScopeId(entry.sessionId)
}
