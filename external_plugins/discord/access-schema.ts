// The access.json schema and the whitelist that rebuilds it on read.
//
// Split out of server.ts purely for testability: server.ts runs process.exit(1)
// at import time when no bot token is present, so a test can't import it. The
// rebuild below is the single highest-risk piece of this file — see
// pickAccessFields — and leaving it untestable meant its only guard was a
// comment. Same shape as the other extracted modules here (meta-text.ts,
// inject-port.ts, control-plane.ts): pure logic plus a matching .test.ts.

export type PendingEntry = {
  senderId: string
  /** DM channel ID — where to send the approval confirm. Not a user id. */
  chatId: string
  createdAt: number
  expiresAt: number
  replies: number
}

export type GroupPolicy = {
  requireMention: boolean
  allowFrom: string[]
}

export type Access = {
  dmPolicy: 'pairing' | 'allowlist' | 'disabled'
  allowFrom: string[]
  /** Keyed on channel ID (snowflake), not guild ID. One entry per guild channel. */
  groups: Record<string, GroupPolicy>
  pending: Record<string, PendingEntry>
  mentionPatterns?: string[]
  // delivery/UX config — optional, defaults live in the reply handler
  /** Emoji to react with on receipt. Empty string disables. Unicode char or custom emoji ID. */
  ackReaction?: string
  /** Which chunks get Discord's reply reference when reply_to is passed. Default: 'first'. 'off' = never thread. */
  replyToMode?: 'off' | 'first' | 'all'
  /** Max chars per outbound message before splitting. Default: 2000 (Discord's hard cap). */
  textChunkLimit?: number
  /** Split on paragraph boundaries instead of hard char count. */
  chunkMode?: 'length' | 'newline'
  /** Per-platform admin user ids. Written by a human editing this file; this
   *  process only ever reads it. There is deliberately no code path that adds
   *  an admin. */
  admins?: Record<string, string[]>
  // Invite tickets used to live here. They moved to the shared, cross-platform
  // ~/.claude/channels/invites.json — see invites-file.ts. Do not add the field
  // back: two homes for one token is what made a Telegram-minted invite
  // invisible to Discord.
}

/**
 * Every field preserved when access.json is read back.
 *
 * Single source of truth: this list drives the rebuild, the exhaustiveness
 * guard below, and the unit tests. A field absent here is silently dropped the
 * next time the file is written — which is how a hand-added `admins` entry
 * would vanish without a trace.
 */
export const ACCESS_FIELDS = [
  'dmPolicy', 'allowFrom', 'groups', 'pending', 'mentionPatterns', 'ackReaction',
  'replyToMode', 'textChunkLimit', 'chunkMode', 'admins',
] as const satisfies readonly (keyof Access)[]

// Add a field to Access without adding it to ACCESS_FIELDS and this stops
// being assignable — the mistake becomes a compile error instead of silent
// data loss.
type MissingAccessField = Exclude<keyof Access, (typeof ACCESS_FIELDS)[number]>
const _accessFieldsExhaustive: MissingAccessField extends never ? true : never = true
void _accessFieldsExhaustive

export function defaultAccess(): Access {
  return {
    dmPolicy: 'pairing',
    allowFrom: [],
    groups: {},
    pending: {},
    ackReaction: '👀',
  }
}

/**
 * Rebuild an Access object from freshly parsed JSON, keeping only known fields.
 *
 * A whitelist rather than a spread: a corrupt or hand-edited file must not be
 * able to inject arbitrary keys that then get written back out.
 *
 * The four required fields fall back to their defaults; optional fields stay
 * absent rather than gaining defaults, so an existing deployment's file doesn't
 * sprout empty sections on first write.
 *
 * @param parsed The result of JSON.parse on access.json.
 * @returns A complete Access object safe to hand to saveAccess().
 */
export function pickAccessFields(parsed: Partial<Access>): Access {
  // Written through a widened alias: TypeScript can't correlate a key with its
  // own value type while looping over a union of keys.
  const picked: Record<string, unknown> = {}
  for (const field of ACCESS_FIELDS) {
    if (Object.hasOwn(parsed, field)) picked[field] = parsed[field]
  }
  const access = picked as unknown as Access
  // `??` rather than the loop's presence check, so an explicit null in the
  // file still lands on the default — matching the original per-field reads.
  access.dmPolicy = parsed.dmPolicy ?? 'pairing'
  access.allowFrom = parsed.allowFrom ?? []
  access.groups = parsed.groups ?? {}
  access.pending = parsed.pending ?? {}
  return access
}
