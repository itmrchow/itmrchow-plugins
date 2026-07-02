/**
 * Reply-preview formatting for inbound quote-replies (structured reply reference).
 *
 * When a user quote-replies on Discord, the inbound <channel> meta carries a
 * short preview of the referenced message so the model gets context without
 * an extra fetch_messages round-trip.
 */

/** Max characters (code points) of the referenced message carried in reply_to_preview. */
export const REPLY_PREVIEW_MAX_CHARS = 120

// Attribute-breaking chars → look-alikes. Meta values land inside a
// <channel ... reply_to_preview="..."> attribute; we cannot verify the
// harness escapes them, and this server already strips structural chars for
// meta-bound attachment names (safeAttName). Look-alikes over '_' so quoted
// prose stays readable.
const META_CHAR_REPLACEMENTS: ReadonlyArray<readonly [RegExp, string]> = [
  [/"/g, "'"],
  [/</g, '‹'],
  [/>/g, '›'],
]

/**
 * Neutralize characters that could break out of a <channel> meta attribute.
 *
 * Referenced-message content and author names (webhook display names allow
 * arbitrary characters) are attacker-controlled; a `"` or `<` inside an
 * attribute value could forge adjacent attributes or a whole channel tag if
 * the renderer does not escape. Replaces `"` -> `'`, `<` -> `‹`, `>` -> `›`.
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

/**
 * Flatten, sanitize, and truncate a referenced message into a one-line preview.
 *
 * Newlines (and surrounding whitespace) collapse to a single space so the
 * preview cannot forge adjacent meta fields or extra lines; attribute-breaking
 * characters are replaced via sanitizeMetaText. Content longer than
 * REPLY_PREVIEW_MAX_CHARS is cut on a code-point boundary (no split surrogate
 * pairs) and suffixed with an ellipsis ("…").
 *
 * Args:
 *   content: raw message content of the referenced (quoted) message.
 * Returns:
 *   Single-line sanitized preview, at most REPLY_PREVIEW_MAX_CHARS + 1 code
 *   points ("…" included); empty string when the content is empty or
 *   whitespace-only.
 */
export function formatReplyPreview(content: string): string {
  const flat = sanitizeMetaText(content.replace(/\s*[\r\n]+\s*/g, ' ').trim())
  const codePoints = [...flat]
  if (codePoints.length <= REPLY_PREVIEW_MAX_CHARS) return flat
  return `${codePoints.slice(0, REPLY_PREVIEW_MAX_CHARS).join('')}…`
}
