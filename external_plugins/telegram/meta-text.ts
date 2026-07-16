/**
 * Sanitizer for user-controlled text bound for <channel> meta attributes.
 *
 * Inbound quote-replies carry reply_to_user (the referenced message's author)
 * and reply_to_text (its full body) as <channel> meta attributes. Both are
 * sender-controlled and allow arbitrary characters (including `"`, `<`, and
 * newlines), so they are sanitized before landing inside a single-line
 * attribute to prevent forging adjacent attributes, breaking the tag across
 * lines, or forging a whole tag.
 */

// Attribute-breaking chars → look-alikes / space. Meta values land inside a
// single-line <channel ... reply_to_user="..."> attribute; we cannot verify the
// harness escapes them, and this server already strips structural chars for
// meta-bound attachment names (safeName, which also drops CR/LF). Control chars
// (C0 incl. CR/LF/tab, DEL, C1 U+0080-U+009F) plus the Unicode line separators
// U+2028/U+2029 collapse to a space so the value can't break the tag onto a new
// line or forge adjacent attributes; look-alikes over `"`/`<`/`>` keep the text
// readable. Escapes are written \uXXXX (never literal control bytes in source).
const CONTROL_CHARS = /[\u0000-\u001F\u007F\u0080-\u009F\u2028\u2029]/g
const META_CHAR_REPLACEMENTS: ReadonlyArray<readonly [RegExp, string]> = [
  [CONTROL_CHARS, ' '],
  [/"/g, "'"],
  [/</g, '‹'],
  [/>/g, '›'],
]

/**
 * Neutralize characters that could break out of a <channel> meta attribute.
 *
 * Author names and quoted message bodies are sender-controlled; a `"` or `<`
 * inside a single-line attribute value could forge adjacent attributes or a
 * whole channel tag, and a newline could break the tag across lines, if the
 * renderer does not escape. Replaces `"` -> `'`, `<` -> `‹`, `>` -> `›`, and
 * any control char (CR/LF/tab/...) -> a space.
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
