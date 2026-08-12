/**
 * Which identity a discord message anchors its scope on.
 *
 * Split out of the poller so the rule is testable without a gateway connection,
 * and kept free of discord.js types so a test can state the four inputs
 * directly instead of faking a Message.
 *
 * This is NOT the access gate — that stays in server.ts, so there is exactly one
 * verdict per message. The only question answered here is "which Claude session
 * does this belong to".
 */

/** The four facts about a message that decide its scope. */
export type AnchorInput = {
  isDm: boolean
  channelId: string
  /** Parent channel of a thread; absent/null for anything that is not a thread. */
  parentId: string | null | undefined
  authorId: string
}

export type ScopeAnchor = { kind: 'dm' | 'group'; anchorId: string }

/**
 * Resolve the scope anchor for one inbound discord message.
 *
 * A DM anchors on the author rather than the DM channel, so one person keeps one
 * session. A thread anchors on its PARENT channel: a thread has its own channel
 * id, and anchoring on it would spawn a fresh Claude process every time someone
 * opens a discussion in an opted-in channel. This mirrors the gate's existing
 * parent lookup in server.ts, so membership and session identity agree.
 *
 * @param input - Facts extracted from the message.
 * @returns The scope kind and the id it anchors on.
 */
export function resolveScopeAnchor(input: AnchorInput): ScopeAnchor {
  if (input.isDm) return { kind: 'dm', anchorId: input.authorId }
  return { kind: 'group', anchorId: input.parentId ?? input.channelId }
}
