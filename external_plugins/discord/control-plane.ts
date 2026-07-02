/**
 * Bot-layer operational control plane (JP-38).
 *
 * Channel-neutral control actions that survive agent death: read context
 * usage, clear context, and trigger restart. The bot process (server.ts)
 * drives these directly via tmux — they do NOT depend on the Claude agent
 * being alive enough to process a message, only (for /clear) on the TUI
 * accepting keystrokes. Restart lives in restart-agent.ts (shared with JP-37).
 *
 * Per-channel command handlers stay thin: gate (allowFrom) -> call here ->
 * reply. This module owns the tmux mechanics and footer parsing.
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { capturePaneText, TMUX_TARGET } from './busy-gate'

const execFileAsync = promisify(execFile)

/** Hard cap on a single `tmux send-keys` shell-out (matches capture timeout). */
const SEND_KEYS_TIMEOUT_MS = 1000

/** Trailing capture lines that may contain the TUI footer. */
const FOOTER_TAIL_LINES = 6

/** Control commands the bot layer recognizes (survive agent death). */
export const CONTROL_COMMANDS = ['ctx', 'clear', 'restart'] as const

export type ControlCommand = (typeof CONTROL_COMMANDS)[number]

/**
 * Parse a raw inbound message into a control command, if it is one.
 *
 * Used by channels without a native command router (discord) to split control
 * commands from chat. Matches a leading `/<cmd>` exactly (case-insensitive);
 * trailing arguments are ignored. Returns null for anything that is not a
 * recognized control command so the caller falls through to the chat path.
 *
 * Args:
 *   text: raw inbound message content.
 * Returns:
 *   The matched ControlCommand, or null when not a control command.
 */
export function parseControlCommand(text: string): ControlCommand | null {
  const trimmed = text.trim()
  if (!trimmed.startsWith('/')) return null
  const word = trimmed.slice(1).split(/\s+/)[0]?.toLowerCase() ?? ''
  return (CONTROL_COMMANDS as readonly string[]).includes(word)
    ? (word as ControlCommand)
    : null
}

/** Result of reading the context gauge from the TUI footer. */
export type ContextReading = {
  /** Percent of context USED (0-100), or null when no pattern matched. */
  pct: number | null
  /** Trailing footer text, always returned so the user can self-judge. */
  raw: string
}

/**
 * Extract Claude's context-usage percent from a captured TUI footer.
 *
 * The footer string is version-coupled and NOT yet calibrated on the VM
 * (no captured sample exists), so this tries several plausible patterns and,
 * on no match, returns pct=null with the raw footer tail. It never guesses a
 * number and never throws — an unrecognized footer degrades to "here is what
 * I saw" rather than a wrong percentage. Calibrate patterns once a real
 * footer is captured on the agent VM.
 *
 * Semantics: pct is percent USED. Footers that report "left/remaining" are
 * converted (used = 100 - left).
 *
 * Args:
 *   footer: stdout of `tmux capture-pane -p` (full pane or footer region).
 * Returns:
 *   ContextReading with pct (used%) or null, plus the raw footer tail.
 */
export function parseContextPercent(footer: string): ContextReading {
  const raw = footer
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
    .slice(-FOOTER_TAIL_LINES)
    .join('\n')

  const left =
    raw.match(/context\s*(?:left|remaining)\D*?(\d{1,3})\s*%/i) ??
    raw.match(/(\d{1,3})\s*%\s*context\s*(?:left|remaining)/i) ??
    raw.match(/(\d{1,3})\s*%\s*(?:context\s*)?(?:left|remaining)/i)
  if (left) {
    const n = clampPct(Number(left[1]))
    return { pct: n === null ? null : 100 - n, raw }
  }

  const used =
    raw.match(/context\s*used\D*?(\d{1,3})\s*%/i) ??
    raw.match(/(\d{1,3})\s*%\s*(?:context\s*)?used/i)
  if (used) {
    return { pct: clampPct(Number(used[1])), raw }
  }

  return { pct: null, raw }
}

/** Window during which a repeated /clear counts as confirming the warned one. */
export const CLEAR_CONFIRM_WINDOW_MS = 30_000

/**
 * Decide whether /clear should run now or warn-and-wait for confirmation.
 *
 * Clearing while the agent is busy interrupts the in-flight task and drops its
 * context, so a busy pane requires an explicit re-send within
 * CLEAR_CONFIRM_WINDOW_MS. An idle pane clears immediately. Pure so the
 * confirm gate is unit-testable; the caller keeps the per-sender warn timestamp.
 *
 * Args:
 *   busy: whether the pane is mid-turn.
 *   lastWarnMs: timestamp of the last warning for this sender, or null.
 *   nowMs: current time in ms.
 * Returns:
 *   'execute' to clear now, 'warn' to ask for confirmation first.
 */
export function decideClear(
  busy: boolean,
  lastWarnMs: number | null,
  nowMs: number,
): 'execute' | 'warn' {
  if (!busy) return 'execute'
  if (lastWarnMs !== null && nowMs - lastWarnMs < CLEAR_CONFIRM_WINDOW_MS) return 'execute'
  return 'warn'
}

/** Validate a parsed percentage is in 0-100; null otherwise. */
function clampPct(n: number): number | null {
  if (!Number.isFinite(n) || n < 0 || n > 100) return null
  return n
}

/**
 * Read the context-usage gauge from the agent's TUI footer.
 *
 * Captures the pane and parses it. On capture failure returns pct=null with an
 * empty raw string (caller reports "could not read"). Does not throw.
 *
 * Args:
 *   target: tmux session:window to inspect. Defaults to TMUX_TARGET.
 * Returns:
 *   Promise resolving to a ContextReading.
 */
export async function getContextPercent(target: string = TMUX_TARGET): Promise<ContextReading> {
  const pane = await capturePaneText(target)
  if (pane === null) return { pct: null, raw: '' }
  return parseContextPercent(pane)
}

/**
 * Send `/clear` to the agent pane via tmux send-keys.
 *
 * Bypasses the message pipeline (works when the pipeline is stuck but the TUI
 * still accepts keystrokes). Has no effect on a truly frozen TUI (e.g. API 401)
 * that ignores input — that case needs /restart. Caller is responsible for the
 * busy-check / confirmation policy before calling this.
 *
 * Args:
 *   target: tmux session:window. Defaults to TMUX_TARGET.
 * Returns:
 *   Promise that resolves once the keys are sent; rejects on tmux failure.
 */
export async function sendClear(target: string = TMUX_TARGET): Promise<void> {
  await execFileAsync('tmux', ['send-keys', '-t', target, '/clear', 'Enter'], {
    timeout: SEND_KEYS_TIMEOUT_MS,
  })
}
