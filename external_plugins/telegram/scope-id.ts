/**
 * scope-id: the identity of one isolated Claude session.
 *
 * This file lives inside the telegram plugin rather than a repo-level _shared/
 * because a plugin is installed as a self-contained directory copy
 * (cache/<marketplace>/<plugin>/<version>/) — a `../_shared` import resolves to
 * nothing once installed and takes the whole MCP server down at startup. The
 * discord plugin gets its own copy; the shape is pinned by identical tests on
 * both sides, and the carrier's lib-scope.sh SCOPE_ID_RE must match too.
 */

/** The legal value space. Anything reaching a tmux target, a file path, or a
 *  command string must pass this first — it is the only injection barrier. */
export const SCOPE_ID_RE = /^[a-z][a-z0-9]*-(dm|group)-[a-z0-9]+$/

/**
 * Normalise a platform-native id into a scope-id segment.
 *
 * Telegram group ids are negative (-1001234567890). A leading "-" in the
 * argument position of `tmux new-window -n <name>` reads as a flag, and it is
 * outside SCOPE_ID_RE anyway, so it is replaced by "n". This is the single
 * implementation point of that conversion.
 *
 * @param raw - Platform-native id, numeric or string.
 * @returns The segment with any leading minus sign replaced by "n".
 */
export function normalizeScopeSegment(raw: string | number): string {
  const text = String(raw).trim()
  return text.startsWith('-') ? `n${text.slice(1)}` : text
}

/**
 * Build a semantic scope-id: `<platform>-dm-<id>` / `<platform>-group-<id>`.
 *
 * Invalid input throws instead of being repaired: a silently repaired id
 * produces a scope that looks usable, receives no messages, and nobody notices.
 *
 * @param platform - Channel platform, e.g. 'telegram' | 'discord'.
 * @param kind - 'dm' for a private chat, 'group' for a shared one.
 * @param rawId - Platform-native anchor id.
 * @returns A scope-id guaranteed to match SCOPE_ID_RE.
 * @throws Error when the assembled id is not a valid scope-id.
 */
export function buildScopeId(
  platform: string,
  kind: 'dm' | 'group',
  rawId: string | number,
): string {
  const id = `${platform}-${kind}-${normalizeScopeSegment(rawId)}`
  if (!isValidScopeId(id)) throw new Error(`invalid scope id: ${JSON.stringify(id)}`)
  return id
}

/**
 * @param value - Candidate scope-id.
 * @returns true when value is a legal scope-id.
 */
export function isValidScopeId(value: string): boolean {
  return SCOPE_ID_RE.test(value)
}
