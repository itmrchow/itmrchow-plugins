/**
 * The one list of characters that can hide or reorder what is shown (JP-379
 * review r1 P2-4), shared by the binding block's display escaping
 * (approval-binding.ts) and the session-name check (first-line.ts), so the
 * two cannot drift apart.
 *
 * Kept as regex character-class bodies rather than RegExp objects: each user
 * adds its own members and flags.
 */

/**
 * C0 / C1 controls other than tab and newline, DEL, zero-width characters and
 * bidi controls. The binding block escapes exactly these as `[U+XXXX]`; the
 * set is pinned by that block's existing output, so widening it changes what
 * the user is shown and is a display-rule change, not a refactor.
 */
export const INVISIBLE_CHAR_CLASS = '\u0000-\u0008\u000B-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF'

/** Tab, newline and the Unicode line / paragraph separators: allowed inside a binding block, never on a first line. */
export const LINE_BREAK_CHAR_CLASS = '\u0009\u000A\u2028\u2029'

/**
 * Further invisible format characters a session name is refused for: soft
 * hyphen, Arabic letter mark (a bidi mark), Mongolian vowel separator and the
 * tag characters. Astral, so a RegExp using this needs the `u` flag. Not added
 * to the binding block's set: that would change its existing display.
 */
export const EXTRA_INVISIBLE_CHAR_CLASS = '\u00AD\u061C\u180E\u{E0000}-\u{E007F}'
