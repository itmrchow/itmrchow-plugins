/**
 * What an approval is bound to (JP-374 Spec v1.2): the key, and how the bound
 * content is shown to the user.
 *
 * The caller sends the content itself — `binding_session` + `binding_subject`
 * (for a Bash call, the command) — never a key. The poller derives the key and
 * puts the content, masked, in a block of the message that only the poller
 * writes, above the caller's free text. That way what the user approves is
 * what the key stands for: a caller cannot pair harmless-looking text with a
 * key for something else.
 *
 * The raw subject is hashed and dropped; only the key and the masked display
 * are kept. Two subjects that differ only inside a masked secret get different
 * keys but look the same on screen (accepted in Spec v1.2).
 */
import { createHash } from 'node:crypto'
import { TRUNCATION_MARK } from './approval-config'
import { FIRST_LINE_STATUS, formatFirstLine } from './first-line'
import { INVISIBLE_CHAR_CLASS } from './invisible-chars'
import { maskSecrets } from './secret-mask'

/** The content a request is bound to, as sent by the caller. */
export type ApprovalBinding = { session: string; subject: string }

/**
 * Session ids are what Claude Code hands hooks (a UUID). No newline can occur,
 * so session + "\n" + subject splits back into exactly one pair.
 */
export const BINDING_SESSION_PATTERN = '[A-Za-z0-9_-]{1,128}'
export const BINDING_SESSION_RE = new RegExp(`^${BINDING_SESSION_PATTERN}$`)

const KEY_SEPARATOR = '\n'
const BLOCK_HEADER = '【綁定內容】由 poller 顯示，每行以「┃ 」開頭，機密已遮罩：'
const BLOCK_LINE_PREFIX = '┃ '
const BLOCK_FOOTER = '────────────'
const LINE_BREAK = '\n'
/** First-line summary cap: a glance, the block below holds the whole content. */
export const SUMMARY_MAX_LENGTH = 80
/**
 * Characters that can hide or reorder what is shown: C0 / C1 controls other
 * than tab and newline, zero-width characters and bidi controls. One list,
 * shared with the session-name check; see invisible-chars.ts.
 */
const INVISIBLE_RE = new RegExp(`[${INVISIBLE_CHAR_CLASS}]`, 'g')
const HEX_RADIX = 16
const CODE_POINT_DIGITS = 4

/**
 * Derive the key an approval is bound to.
 *
 * @param binding - Session and subject, raw.
 * @returns Hex sha256 of session + "\n" + subject.
 */
export function computeBindingKey(binding: ApprovalBinding): string {
  return createHash('sha256').update(`${binding.session}${KEY_SEPARATOR}${binding.subject}`, 'utf8').digest('hex')
}

/**
 * Turn a raw subject into what may be stored and shown: secrets masked,
 * invisible characters written out as `[U+XXXX]`.
 *
 * @param subject - Raw subject from the caller.
 * @returns The display text.
 */
export function renderBindingDisplay(subject: string): string {
  return maskSecrets(subject).replace(INVISIBLE_RE, char => `[U+${formatCodePoint(char)}]`)
}

/**
 * The message as sent to Telegram. A bound request (JP-379) opens with a first
 * line the poller writes entirely itself — `[已被擋下] <session name>: <summary
 * of the bound content>` — then the poller's block, every subject line marked,
 * then the caller's free text; so nothing the caller wrote can reach the first
 * line. Without a binding it is the free text alone, exactly as before JP-374:
 * the caller writes its own first line.
 *
 * @param bindingDisplay - From renderBindingDisplay, or null for an unbound request.
 * @param text - The caller's free text.
 * @param sessionName - Session the request belongs to; only shown for a bound request.
 * @returns Message text.
 */
export function composeMessageText(bindingDisplay: string | null, text: string, sessionName: string): string {
  if (bindingDisplay === null) return text
  const firstLine = formatFirstLine(FIRST_LINE_STATUS.blocked, sessionName, summarizeBindingDisplay(bindingDisplay))
  const lines = bindingDisplay.split(LINE_BREAK).map(line => `${BLOCK_LINE_PREFIX}${line}`)
  return [firstLine, BLOCK_HEADER, ...lines, BLOCK_FOOTER, text].join(LINE_BREAK)
}

/**
 * One-line summary of the bound content for the first line (Spec v1.2 Q2):
 * its first non-blank line, cut to SUMMARY_MAX_LENGTH with `…`; when the
 * content has more than one non-blank line, `…（共 N 行）` follows, N being the
 * number of non-blank lines, so a glance at the first line shows there is
 * more. Blank lines, a trailing newline included, never count. Taken from the
 * display, so it is already masked; the block below shows it whole.
 *
 * @param bindingDisplay - From renderBindingDisplay.
 * @returns The summary.
 */
export function summarizeBindingDisplay(bindingDisplay: string): string {
  const nonBlankLines = bindingDisplay.split(LINE_BREAK).filter(line => line.trim() !== '')
  // By code point, so a cut never splits a surrogate pair.
  const head = Array.from(nonBlankLines[0] ?? '')
  const summary = head.slice(0, SUMMARY_MAX_LENGTH).join('')
  if (nonBlankLines.length > 1) return `${summary}${TRUNCATION_MARK}${formatLineCount(nonBlankLines.length)}`
  return head.length > SUMMARY_MAX_LENGTH ? `${summary}${TRUNCATION_MARK}` : summary
}

function formatLineCount(count: number): string {
  return `（共 ${count} 行）`
}

function formatCodePoint(char: string): string {
  return (char.codePointAt(0) ?? 0).toString(HEX_RADIX).toUpperCase().padStart(CODE_POINT_DIGITS, '0')
}
