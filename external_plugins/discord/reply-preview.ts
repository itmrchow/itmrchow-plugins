/**
 * Reply-preview formatting for inbound quote-replies (structured reply reference).
 *
 * When a user quote-replies on Discord, the inbound <channel> meta carries a
 * short preview of the referenced message so the model gets context without
 * an extra fetch_messages round-trip.
 */

/** Max characters of the referenced message carried in reply_to_preview. */
export const REPLY_PREVIEW_MAX_CHARS = 120

/**
 * Flatten and truncate a referenced message's content into a one-line preview.
 *
 * Newlines (and surrounding whitespace) collapse to a single space so the
 * preview cannot forge adjacent meta fields or extra lines. Content longer
 * than REPLY_PREVIEW_MAX_CHARS is cut and suffixed with an ellipsis ("…").
 *
 * Args:
 *   content: raw message content of the referenced (quoted) message.
 * Returns:
 *   Single-line preview, at most REPLY_PREVIEW_MAX_CHARS + 1 chars ("…"
 *   included); empty string when the content is empty/whitespace-only.
 */
export function formatReplyPreview(content: string): string {
  const flat = content.replace(/\s*[\r\n]+\s*/g, ' ').trim()
  if (flat.length <= REPLY_PREVIEW_MAX_CHARS) return flat
  return `${flat.slice(0, REPLY_PREVIEW_MAX_CHARS)}…`
}
