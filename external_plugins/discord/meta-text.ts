/**
 * Sanitizer for user-controlled text bound for <channel> meta attributes.
 *
 * Inbound quote-replies carry reply_to_user (the referenced message's author)
 * as a <channel> meta attribute. Webhook/app display names allow arbitrary
 * characters (including `"`, `<`, and newlines), so the value is sanitized
 * before it lands inside a single-line attribute to prevent it from forging
 * adjacent attributes, breaking the tag across lines, or forging a whole tag.
 */

// Attribute-breaking chars → look-alikes / space. Meta values land inside a
// single-line <channel ... reply_to_user="..."> attribute; we cannot verify the
// harness escapes them, and this server already strips structural chars for
// meta-bound attachment names (safeAttName, which also drops CR/LF). Control
// chars (incl. CR/LF/tab) collapse to a space so the value can't break the tag
// onto a new line or forge adjacent attributes; look-alikes over `"`/`<`/`>`
// keep the name readable.
const CONTROL_CHARS = /[\u0000-\u001F\u007F]/g
const META_CHAR_REPLACEMENTS: ReadonlyArray<readonly [RegExp, string]> = [
  [CONTROL_CHARS, ' '],
  [/"/g, "'"],
  [/</g, '‹'],
  [/>/g, '›'],
]

/**
 * Neutralize characters that could break out of a <channel> meta attribute.
 *
 * Author names (webhook display names allow arbitrary characters) are
 * attacker-controlled; a `"` or `<` inside a single-line attribute value could
 * forge adjacent attributes or a whole channel tag, and a newline could break
 * the tag across lines, if the renderer does not escape. Replaces `"` -> `'`,
 * `<` -> `‹`, `>` -> `›`, and any control char (CR/LF/tab/...) -> a space.
 *
 * Args:
 *   value: raw user-controlled text bound for a meta attribute.
 * Returns:
 *   The value with attribute-breaking characters replaced by look-alikes or
 *   spaces.
 */
export function sanitizeMetaText(value: string): string {
  let out = value
  for (const [pattern, replacement] of META_CHAR_REPLACEMENTS) {
    out = out.replace(pattern, replacement)
  }
  return out
}
