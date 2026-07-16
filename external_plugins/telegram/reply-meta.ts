/**
 * Structured quote-reply metadata for inbound Telegram messages.
 *
 * Field names mirror the Discord channel (reply_to_message_id / reply_to_user),
 * but the body-delivery strategy differs: Discord's gateway omits the quoted
 * body, forcing a deferred get_message fetch, whereas Telegram embeds the full
 * referenced message in the same update and exposes no history API to fetch it
 * later — so the complete body ships up front as reply_to_text rather than a
 * truncated preview.
 */

import { sanitizeMetaText } from './meta-text'

/** Minimal shape of a Telegram quote-referenced message needed for reply meta. */
export interface RepliedMessage {
  message_id: number
  from?: { username?: string }
  text?: string
  caption?: string
}

/**
 * Build the structured quote-reply <channel> meta attributes.
 *
 * reply_to_user / reply_to_text are sender-controlled and land inside the
 * single-line <channel> tag, so both are sanitized (control chars incl. CR/LF
 * -> space, `"`/`<`/`>` -> look-alikes) to keep the tag intact. The bot's own
 * messages render as "me" (symmetric with the Discord channel).
 *
 * Args:
 *   replyMsg: the referenced message, or undefined when this is not a reply.
 *   botUsername: the bot's own username, so its own messages render as "me".
 * Returns:
 *   A meta fragment with reply_to_message_id, and (when present) reply_to_user
 *   and reply_to_text; an empty object when replyMsg is undefined.
 */
export function buildReplyMeta(
  replyMsg: RepliedMessage | undefined,
  botUsername: string,
): Record<string, string> {
  if (!replyMsg) return {}
  const meta: Record<string, string> = {
    reply_to_message_id: String(replyMsg.message_id),
  }
  const replyUser = replyMsg.from?.username
  if (replyUser) {
    meta.reply_to_user = replyUser === botUsername ? 'me' : sanitizeMetaText(replyUser)
  }
  const replyText = replyMsg.text ?? replyMsg.caption
  if (replyText) meta.reply_to_text = sanitizeMetaText(replyText)
  return meta
}
