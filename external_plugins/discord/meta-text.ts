/**
 * Sanitizer for user-controlled text bound for <channel> meta attributes.
 *
 * Inbound quote-replies carry reply_to_user (the referenced message's author)
 * as a <channel> meta attribute. Webhook/app display names allow arbitrary
 * characters (including `"` and `<`), so the value is sanitized before it lands
 * inside an attribute to prevent it from forging adjacent attributes or tags.
 */

// Attribute-breaking chars → look-alikes. Meta values land inside a
// <channel ... reply_to_user="..."> attribute; we cannot verify the harness
// escapes them, and this server already strips structural chars for meta-bound
// attachment names (safeAttName). Look-alikes keep the name readable.
const META_CHAR_REPLACEMENTS: ReadonlyArray<readonly [RegExp, string]> = [
  [/"/g, "'"],
  [/</g, '‹'],
  [/>/g, '›'],
]

/**
 * Neutralize characters that could break out of a <channel> meta attribute.
 *
 * Author names (webhook display names allow arbitrary characters) are
 * attacker-controlled; a `"` or `<` inside an attribute value could forge
 * adjacent attributes or a whole channel tag if the renderer does not escape.
 * Replaces `"` -> `'`, `<` -> `‹`, `>` -> `›`.
 *
 * Args:
 *   value: raw user-controlled text bound for a meta attribute.
 * Returns:
 *   The value with attribute-breaking characters replaced by look-alikes.
 */
export function sanitizeMetaText(value: string): string {
  let out = value
  for (const [pattern, replacement] of META_CHAR_REPLACEMENTS) {
    out = out.replace(pattern, replacement)
  }
  return out
}
