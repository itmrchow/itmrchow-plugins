// Invite tokens: an admin hands out a token out-of-band (deep-link or plain
// text), the holder redeems it via /start <token> and lands in allowFrom.
// Opposite direction from pairing (bot mints a code, human approves after the
// fact), so `pending` is not reused — the two coexist.
//
// Deliberately platform-agnostic and I/O-free: no grammy, no fs. Reading and
// writing access.json stays in server.ts so these stay unit-testable, and so
// the Discord port is a copy of this file plus a new call site (same pattern
// as meta-text.ts / inject-port.ts, which already exist once per platform).

import { randomBytes } from 'node:crypto'

/** One invite ticket. Keyed by the token itself, so the token is not a field. */
export type Invite = {
  note?: string
  createdAt: number
  createdBy: string
  /** Required, epoch ms. There is no never-expiring invite. */
  expiresAt: number
  /** platform -> user ids that redeemed this token. */
  usedBy: Record<string, string[]>
  /** Tombstone. Revoking sets a timestamp and keeps the key, so a revoked
   *  token can never be resurrected by a later create. */
  revokedAt: number | null
}

export type InviteCheck =
  | { ok: true }
  | { ok: false; reason: 'unknown' | 'expired' | 'revoked' }

const INVITE_TOKEN_BYTES = 16
/** How long revoked tombstones stay before pruning. */
export const REVOKED_RETENTION_MS = 30 * 24 * 60 * 60 * 1000

/**
 * Mint a fresh invite token.
 *
 * 16 bytes (32 hex chars) — deliberately longer than pairing's 6 hex chars,
 * because a redeemed invite grants access with no second human approval step.
 *
 * @returns A 32-char lowercase hex string.
 */
export function generateInviteToken(): string {
  return randomBytes(INVITE_TOKEN_BYTES).toString('hex')
}

/**
 * Decide whether a token may be redeemed right now.
 *
 * @param invites All known invites, keyed by token.
 * @param token The token presented by the sender.
 * @param now Current time, epoch ms.
 * @returns `{ ok: true }`, or a failure with the reason. The reason is for
 *   tests and local diagnostics only — callers must not relay it to the
 *   sender, since a bad token is a silent drop.
 */
export function checkInvite(
  invites: Record<string, Invite>,
  token: string,
  now: number,
): InviteCheck {
  const invite = invites[token]
  if (!invite) return { ok: false, reason: 'unknown' }
  // Revoked wins over expired: an admin pulling a token is the more specific
  // fact, and it stays true after the token would have expired anyway.
  if (invite.revokedAt !== null) return { ok: false, reason: 'revoked' }
  if (invite.expiresAt <= now) return { ok: false, reason: 'expired' }
  return { ok: true }
}

/**
 * Record that a sender redeemed this invite, in place.
 *
 * @param invite The invite being redeemed.
 * @param platform Channel name, e.g. 'telegram'.
 * @param senderId The redeeming user's id on that platform.
 * @returns Whether anything changed (false when the same sender redeems twice).
 */
export function applyBind(invite: Invite, platform: string, senderId: string): boolean {
  const bucket = invite.usedBy[platform] ?? []
  if (bucket.includes(senderId)) return false
  bucket.push(senderId)
  invite.usedBy[platform] = bucket
  return true
}

/**
 * Drop revoked tombstones older than the retention window, in place.
 *
 * Never touches un-revoked invites — expired-but-live ones are kept so `list`
 * can still explain why a token stopped working.
 *
 * @param invites All known invites, keyed by token.
 * @param now Current time, epoch ms.
 * @param retentionMs How long a tombstone is kept after revocation.
 * @returns Whether anything was deleted.
 */
export function pruneRevoked(
  invites: Record<string, Invite>,
  now: number,
  retentionMs: number,
): boolean {
  let changed = false
  for (const [token, invite] of Object.entries(invites)) {
    if (invite.revokedAt === null) continue
    if (now - invite.revokedAt <= retentionMs) continue
    delete invites[token]
    changed = true
  }
  return changed
}
