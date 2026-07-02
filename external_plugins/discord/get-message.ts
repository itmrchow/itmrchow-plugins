/**
 * Formatting for the get_message tool — fetch one message by ID and render its
 * full detail (author, timestamp, complete content, attachments).
 *
 * The tool exists because inbound quote-replies carry only reply_to_message_id
 * + reply_to_user (no inline preview); the model calls get_message to read the
 * referenced message's full text on demand. Formatting lives here (a pure,
 * discord.js-free module) so it is unit-testable — server.ts connects to
 * Discord on import and cannot be exercised in tests.
 */

/** One attachment on a fetched message; name is already sanitized by the caller. */
export interface MessageAttachmentDetail {
  /** Attachment file name, pre-sanitized (safe for a newline-joined tool result). */
  name: string
  /** MIME type, or 'unknown' when Discord does not report one. */
  contentType: string
  /** Size in bytes. */
  sizeBytes: number
}

/** Resolved detail of a single fetched message, ready to render. */
export interface MessageDetail {
  /** Author display name, or 'me' when the message is the bot's own. */
  author: string
  /** ISO 8601 creation timestamp. */
  timestamp: string
  /** Full message text (may be empty for attachment-only messages). */
  content: string
  /** Attachments on the message, if any. */
  attachments: ReadonlyArray<MessageAttachmentDetail>
}

const BYTES_PER_KB = 1024

/**
 * Render a fetched message's full detail as a labeled multi-line block.
 *
 * Content is emitted verbatim (this is a single-message fetch, so newlines in
 * the body cannot forge adjacent rows the way they can in fetch_messages).
 * Empty content renders as a "(no text content)" placeholder so the caller can
 * tell an attachment-only message from a fetch error.
 *
 * Args:
 *   detail: the resolved message detail.
 * Returns:
 *   A newline-joined block with author, timestamp, content, and (when present)
 *   an attachments section.
 */
export function formatMessageDetail(detail: MessageDetail): string {
  const lines: string[] = [
    `author: ${detail.author}`,
    `timestamp: ${detail.timestamp}`,
    `content: ${detail.content || '(no text content)'}`,
  ]
  if (detail.attachments.length > 0) {
    lines.push(`attachments (${detail.attachments.length}):`)
    for (const att of detail.attachments) {
      const kb = (att.sizeBytes / BYTES_PER_KB).toFixed(0)
      lines.push(`  - ${att.name} (${att.contentType}, ${kb}KB)`)
    }
  }
  return lines.join('\n')
}

/**
 * Render the non-fatal "message unavailable" result for get_message.
 *
 * Returned (as a normal, non-error tool result) when the fetch fails — a
 * deleted, never-existed, or unreadable message — so the model can carry on
 * instead of the whole tool call erroring.
 *
 * Args:
 *   messageId: the requested message ID.
 *   reason: the underlying error message.
 * Returns:
 *   A single-line human-readable explanation.
 */
export function formatMessageUnavailable(messageId: string, reason: string): string {
  return `message ${messageId} is unavailable (deleted, not found, or unreadable): ${reason}`
}
