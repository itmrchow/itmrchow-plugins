/**
 * The fixed first line of every message this bot sends the user (JP-379):
 * `[<status>] <session name>: <content>`, so the user can tell at a glance
 * which session a message belongs to and what it wants.
 *
 * Square brackets and colon are half-width, with one space after the colon.
 * The session name is shown with its half-width `:` `[` `]` turned full-width
 * (Spec v1.1 item 6), so the first `] ` and the first `: ` are always the
 * format's own separators and a name cannot pass off part of itself as the
 * content. A session name is still not unique, so nothing may trust a message
 * on its first line alone.
 *
 * Split out of poller.ts / server.ts for the same reason as approval-config.ts:
 * both exit at import time when half-configured, so neither can be imported by
 * a test.
 */

/** The fixed list of statuses (JP-379 Spec item 3). */
export const FIRST_LINE_STATUS = {
  pendingAllow: '等核准',
  pendingApprove: '等 approve',
  waiting: '等你',
  stopped: '已停下',
  crashed: '異常結束',
  blocked: '已被擋下',
  awaitingReply: '等你回覆',
  report: '回報',
  system: '系統',
} as const

export type FirstLineStatus = (typeof FIRST_LINE_STATUS)[keyof typeof FIRST_LINE_STATUS]

/** Session name used by the hub itself and by system messages, and when a caller names none. */
export const HUB_SESSION_NAME = 'tg-hub'

/** Same cap as a request's text: a name is never cut, only refused. */
export const MAX_SESSION_NAME_LENGTH = 3500

/** Half-width characters a session name may not show as-is, and what is shown instead. */
const SESSION_NAME_DISPLAY_REPLACEMENTS: Readonly<Record<string, string>> = { ':': '：', '[': '［', ']': '］' }
const SESSION_NAME_DISPLAY_RE = /[:[\]]/g

/** Turns the first line on for system messages and the permission relay. */
export const FIRST_LINE_SWITCH_ENV = 'TELEGRAM_FIRST_LINE_FORMAT'
const ENABLING_VALUES: ReadonlySet<string> = new Set(['1', 'true'])

/**
 * Characters a session name may not carry: anything that breaks or hides the
 * first line — C0 controls (tab and newline included), DEL, C1 controls, the
 * Unicode line / paragraph separators, zero-width characters and bidi controls.
 */
const SESSION_NAME_FORBIDDEN_RE = /[\u0000-\u001F\u007F-\u009F\u200B-\u200F\u2028-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/

export type ParsedSessionName = { ok: true; sessionName: string } | { ok: false; detail: string }

/**
 * Build the first line.
 *
 * @param status - One of FIRST_LINE_STATUS.
 * @param sessionName - Session the message belongs to, raw; shown through displaySessionName.
 * @param content - Rest of the line; anything after its first newline lands on line two onwards.
 * @returns `[status] sessionName: content`.
 */
export function formatFirstLine(status: FirstLineStatus, sessionName: string, content: string): string {
  return `[${status}] ${displaySessionName(sessionName)}: ${content}`
}

/**
 * Show a session name on a first line: half-width `:` `[` `]` become
 * full-width `：` `［` `］`. Display only — the name is never refused for them.
 *
 * @param sessionName - Raw session name.
 * @returns The name as shown.
 */
export function displaySessionName(sessionName: string): string {
  return sessionName.replace(SESSION_NAME_DISPLAY_RE, char => SESSION_NAME_DISPLAY_REPLACEMENTS[char] ?? char)
}

/**
 * Validate a session name a caller sent. Absent, null, empty and
 * whitespace-only (spaces only; a line break or tab is refused) all mean
 * "none given" and fall back to HUB_SESSION_NAME.
 *
 * @param raw - The `session_name` field as received.
 * @returns The name to use, or why it was refused.
 */
export function parseSessionName(raw: unknown): ParsedSessionName {
  if (raw === undefined || raw === null) return { ok: true, sessionName: HUB_SESSION_NAME }
  if (typeof raw !== 'string') return { ok: false, detail: 'session_name must be a string' }
  // Checked before the blank test, so a name that is only a line break is refused, not defaulted.
  if (SESSION_NAME_FORBIDDEN_RE.test(raw)) {
    return { ok: false, detail: 'session_name must not contain line breaks or control characters' }
  }
  if (raw.trim() === '') return { ok: true, sessionName: HUB_SESSION_NAME }
  if (raw.length > MAX_SESSION_NAME_LENGTH) {
    return { ok: false, detail: `session_name must be at most ${MAX_SESSION_NAME_LENGTH} characters` }
  }
  return { ok: true, sessionName: raw }
}

/**
 * Whether system messages and the permission relay carry the first line.
 *
 * Fail-closed, like the approval switch: only `1` / `true` (trimmed,
 * case-insensitive) turn it on, so the other bots sharing this plugin keep
 * their messages exactly as they were.
 *
 * @param env - Process environment.
 * @returns true when the first line is on.
 */
export function resolveFirstLineFormat(env: Record<string, string | undefined>): boolean {
  return ENABLING_VALUES.has((env[FIRST_LINE_SWITCH_ENV] ?? '').trim().toLowerCase())
}

/**
 * Build the formatter for system messages: `[系統] tg-hub: <text>` when the
 * switch is on, the text untouched when it is off.
 *
 * @param enabled - From resolveFirstLineFormat.
 * @returns The formatter.
 */
export function createSystemTextFormatter(enabled: boolean): (text: string) => string {
  if (!enabled) return text => text
  return text => formatFirstLine(FIRST_LINE_STATUS.system, HUB_SESSION_NAME, text)
}

/** The permission relay's headline before JP-379, kept for the bots that leave the switch off. */
const LEGACY_PERMISSION_PREFIX = '🔐 Permission: '
const PERMISSION_CONTENT_PREFIX = '權限確認 '

/**
 * Build the formatter for the first line of server.ts's permission relay:
 * `[等核准] tg-hub: 權限確認 <tool>` when the switch is on,
 * `🔐 Permission: <tool>` as before when it is off.
 *
 * @param enabled - From resolveFirstLineFormat.
 * @returns The formatter, taking the tool name.
 */
export function createPermissionHeadline(enabled: boolean): (toolName: string) => string {
  if (!enabled) return toolName => `${LEGACY_PERMISSION_PREFIX}${toolName}`
  return toolName => formatFirstLine(FIRST_LINE_STATUS.pendingAllow, HUB_SESSION_NAME, `${PERMISSION_CONTENT_PREFIX}${toolName}`)
}
