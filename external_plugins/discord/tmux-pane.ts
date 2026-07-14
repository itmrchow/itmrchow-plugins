/**
 * tmux pane access for the Discord channel server.
 *
 * Leaf module (no local imports): the single place that knows how to reach the
 * Claude TUI's tmux pane. Consumed by the control plane (/ctx, /clear) and by
 * restart-agent (finding the claude PID).
 *
 * Extracted from busy-gate.ts when the busy-gate delivery queue was removed
 * (JP-121). The queue is gone; the pane probes it was built on are not — /clear
 * still asks whether the agent is mid-turn before it interrupts.
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

/**
 * Regex matching the main-generation spinner's parenthesised timer only.
 *
 * The Claude TUI renders the live generating spinner as a parenthesised timer
 * that always leads with an elapsed-time token then a token counter, e.g.
 * `(6m 49s · ↓ 16.0k tokens)` or `(8s · ↓ 172 tokens · thought for 1s)`. The
 * leading `\(\d+[hms]` anchors on that opening `(<number><h|m|s>` so only the
 * real generating spinner matches.
 *
 * Why this supersedes a bare `tokens` substring (JP-84): a background agent
 * status panel renders its OWN token counter with no leading parenthesis — e.g.
 * `◯ backend-dev  13s · ↓ 45.3k tokens`. That line stays pinned in the footer
 * while the MAIN session is idle, so a bare `tokens` substring reads busy
 * forever. Requiring the `(<number><unit>…tokens` parenthesised shape excludes
 * the unparenthesised background-agent timer. It likewise excludes the auto-mode
 * footer `⏵⏵ auto mode on … · esc to interrupt` (JP-79), which carries no
 * parenthesised token timer.
 */
export const BUSY_PATTERN = /\(\d+[hms][^)]*tokens/

/** tmux target (session:window) to inspect. Configurable for non-a1-b hosts. */
export const TMUX_TARGET = process.env.TMUX_TARGET ?? 'claude-tg-agent:0'

/**
 * Hard cap on a single `tmux capture-pane` shell-out.
 *
 * Kept short: the probe should return in low single-digit milliseconds; a hung
 * tmux must not stall the caller. On timeout the busy capture fails open
 * (idle), so a brief cap only risks an extra-fast retry.
 */
const CAPTURE_TIMEOUT_MS = 1000

/** Number of trailing capture lines that may contain the TUI footer marker. */
const FOOTER_TAIL_LINES = 5

/**
 * Decide whether the Claude pane is mid-turn from a captured pane snapshot.
 *
 * Tests each of the last FOOTER_TAIL_LINES lines against BUSY_PATTERN. The
 * generating spinner lives in the TUI footer; scanning the whole capture would
 * read busy forever if agent output happened to echo a matching timer string.
 *
 * Lines are tested individually rather than joined: BUSY_PATTERN's `[^)]*`
 * segment must not be allowed to span a newline and stitch a stray `(12s`
 * opener on one line to a `tokens` on another, which a joined haystack would
 * permit and would resurrect false positives.
 *
 * Args:
 *   pane: stdout of `tmux capture-pane -p`.
 * Returns:
 *   True when a footer line matches the generating-spinner pattern, else False.
 */
export function isPaneBusy(pane: string): boolean {
  const lines = pane.split('\n').slice(-FOOTER_TAIL_LINES)
  return lines.some(line => BUSY_PATTERN.test(line))
}

/**
 * Capture the configured tmux pane and report busy state.
 *
 * Shells out asynchronously to `tmux capture-pane -p -t <TMUX_TARGET>` so a
 * slow or hung tmux never blocks the event loop. On any failure (tmux missing,
 * target gone, non-zero exit, timeout) resolves False — fail-open, so a broken
 * capture leaves /clear asking for no confirmation rather than refusing to run.
 *
 * Args:
 *   target: tmux session:window to inspect. Defaults to TMUX_TARGET.
 * Returns:
 *   Promise resolving True when the footer shows the busy marker, False on
 *   idle or on error.
 */
export async function capturePaneBusy(target: string = TMUX_TARGET): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync('tmux', ['capture-pane', '-p', '-t', target], {
      encoding: 'utf8',
      timeout: CAPTURE_TIMEOUT_MS,
    })
    return isPaneBusy(stdout)
  } catch (err) {
    process.stderr.write(`discord tmux-pane: capture-pane failed (treating as idle): ${err}\n`)
    return false
  }
}

/**
 * Capture the configured tmux pane and return its text.
 *
 * Same capture path as capturePaneBusy, but returns the raw pane text instead
 * of a busy boolean — used by the control plane (/ctx) to parse the context
 * gauge from the footer. Returns null on any capture failure (distinct from an
 * empty-but-successful capture '') so the caller can report "could not read the
 * pane" rather than a misleading empty parse.
 *
 * Args:
 *   target: tmux session:window to inspect. Defaults to TMUX_TARGET.
 * Returns:
 *   Promise resolving to the pane text, or null on capture failure.
 */
export async function capturePaneText(target: string = TMUX_TARGET): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('tmux', ['capture-pane', '-p', '-t', target], {
      encoding: 'utf8',
      timeout: CAPTURE_TIMEOUT_MS,
    })
    return stdout
  } catch (err) {
    process.stderr.write(`discord tmux-pane: capture-pane (text) failed: ${err}\n`)
    return null
  }
}
