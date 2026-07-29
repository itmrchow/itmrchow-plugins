// The /start <token> redemption decision, lifted out of server.ts.
//
// Telegram keeps the equivalent function inline in its server.ts and covers it
// only by hand, using the /update endpoint to inject a synthetic message.
// Discord has no such endpoint — inbound messages only ever come off the
// gateway WebSocket — and adding one would mean an unauthenticated local path
// that writes allowFrom. So the decision is parameterised on its I/O instead,
// and the unit tests below are the only automated coverage this path gets.
// What stays in server.ts is roughly eight lines of wiring.

import { applyBind, checkInvite, type Invite } from './invite'
import type { Access } from './access-schema'

/** Everything redeemInvite touches outside itself, parameterised for tests. */
export type RedeemDeps = {
  /** Must re-read access.json; a cached object would clobber a token the
   *  im-invite skill minted seconds ago from its own process. */
  readAccess: () => Access
  saveAccess: (access: Access) => void
  now: () => number
  /** DISCORD_ACCESS_MODE === 'static' */
  isStatic: boolean
  /** Boot snapshot's invites, used only to decide whether static mode is worth
   *  warning about. */
  bootInvites: Record<string, Invite> | undefined
  warn: (message: string) => void
}

const START_TOKEN_RE = /^\/start\s+([0-9a-f]{32})$/

/**
 * Pull an invite token out of a message body.
 *
 * Discord has no command router, so this prefix-matches an ordinary text
 * message. The match is therefore strict — exactly 32 lowercase hex chars,
 * nothing before or after — because anything looser would silently swallow an
 * allowlisted user's normal message that happened to start with "/start ".
 * Tokens are always minted lowercase (generateInviteToken, and the skill's
 * `openssl rand -hex 16`), so no case folding: accepting uppercase would only
 * add a way for a hand-edited key to never match.
 *
 * @param content The raw message body.
 * @returns The token, or null when this is not a redemption attempt.
 */
export function parseStartToken(content: string): string | null {
  return START_TOKEN_RE.exec(content.trim())?.[1] ?? null
}

/**
 * Redeem a token: bind the sender into allowFrom and persist.
 *
 * Every failure is a silent drop — a bad token gets no reply, so this can't be
 * used to probe which tokens exist. The token is never logged and never
 * reaches the agent's session context.
 *
 * @param deps The injected I/O surface.
 * @param senderId The Discord user snowflake (not the DM channel id — allowFrom
 *   is matched against msg.author.id).
 * @param token A token already validated in shape by parseStartToken.
 * @returns Whether the sender is now bound, i.e. whether to send a welcome.
 */
export function redeemInvite(deps: RedeemDeps, senderId: string, token: string): boolean {
  // Static mode never writes access.json, so a "bound" sender would be blocked
  // on their very next message. Dropping is the honest outcome.
  if (deps.isStatic) {
    // Warn only where there are invites to fail — that's the case worth
    // reporting: an admin minted a token after boot and it silently cannot
    // work. With none configured this is just a stranger typing /start
    // <anything>, and the branch is reachable without gate(), so an
    // unconditional write would be a cheap log-flood surface that reads like a
    // security event. Never log the token itself.
    if (Object.keys(deps.bootInvites ?? {}).length > 0) {
      deps.warn('discord channel: static mode — ignoring an invite redemption attempt\n')
    }
    return false
  }

  const access = deps.readAccess()
  // 'disabled' means the bot does nothing in DMs, so the token's validity must
  // not even be evaluated. Redemption runs ahead of gate(), which is where
  // this policy is normally enforced, so skipping the check here would still
  // write the sender into allowFrom: harmless while the policy holds, but the
  // moment an operator switches back to pairing/allowlist that person is
  // already on the list, admitted without review and with nothing in the
  // record to show it.
  if (access.dmPolicy === 'disabled') return false
  const invites = access.invites ?? {}
  if (!checkInvite(invites, token, deps.now()).ok) return false

  let changed = applyBind(invites[token], 'discord', senderId)
  if (!access.allowFrom.includes(senderId)) {
    access.allowFrom.push(senderId)
    changed = true
  }
  // Any pairing code this sender was waiting on is now dead weight.
  for (const [code, p] of Object.entries(access.pending)) {
    if (p.senderId !== senderId) continue
    delete access.pending[code]
    changed = true
  }

  // Persist before replying: a failed write plus a sent welcome would leave
  // someone believing they have access they don't have. Re-redeeming an
  // already-redeemed token changes nothing and still gets the welcome.
  if (!changed) return true
  try {
    deps.saveAccess(access)
  } catch (err) {
    deps.warn(`discord channel: invite bind failed to save: ${err}\n`)
    return false
  }
  return true
}
