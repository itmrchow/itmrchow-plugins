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
/**
 * Characters that can hide or reorder what is shown: C0 / C1 controls other
 * than tab and newline, zero-width characters and bidi controls.
 */
const INVISIBLE_RE = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F​-‏‪-‮⁠-⁤⁦-⁩﻿]/g
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
 * The message as sent to Telegram: the poller's block first, every subject line
 * marked, then the caller's free text. Without a binding it is the free text
 * alone, exactly as before JP-374.
 *
 * @param bindingDisplay - From renderBindingDisplay, or null for an unbound request.
 * @param text - The caller's free text.
 * @returns Message text.
 */
export function composeMessageText(bindingDisplay: string | null, text: string): string {
  if (bindingDisplay === null) return text
  const lines = bindingDisplay.split(LINE_BREAK).map(line => `${BLOCK_LINE_PREFIX}${line}`)
  return [BLOCK_HEADER, ...lines, BLOCK_FOOTER, text].join(LINE_BREAK)
}

function formatCodePoint(char: string): string {
  return (char.codePointAt(0) ?? 0).toString(HEX_RADIX).toUpperCase().padStart(CODE_POINT_DIGITS, '0')
}
