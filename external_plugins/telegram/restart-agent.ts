/**
 * Shared agent-restart action (JP-37 + JP-38).
 *
 * Two entry points share this module:
 *   - JP-38 `/restart` — manual, user-initiated from the bot layer.
 *   - JP-37 watchdog — automatic, on detected session death.
 *
 * Two restart tiers (cheapest that works wins):
 *   - Tier 1 (process): kill the Claude process; the launcher's in-session
 *     `while true` loop relaunches it. No sudo, works on a frozen TUI (signal,
 *     not keystroke). Needs the launcher to write CLAUDE_PID_FILE.
 *   - Tier 2 (service): `sudo systemctl restart <SERVICE>`. Escalation when
 *     Tier 1 is unavailable or the session itself is wedged. Needs scoped
 *     NOPASSWD sudoers.
 *
 * Storm guard (auto only): cooldown + max-per-window, persisted so a watchdog
 * restart does not reset the counter. Manual `/restart` passes bypassThrottle
 * to skip the guard (a human deciding to restart overrides the runaway-
 * automation brake) but still takes the lockfile so manual and auto restarts
 * never collide.
 */
import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

/** No re-restart within this window after a restart (storm guard, auto only). */
export const RESTART_COOLDOWN_MS = 5 * 60 * 1000

/** Sliding window for the per-window restart cap (storm guard, auto only). */
export const RESTART_WINDOW_MS = 30 * 60 * 1000

/** Max automatic restarts allowed per RESTART_WINDOW_MS. */
export const RESTART_MAX_PER_WINDOW = 3

/** A lockfile older than this is treated as stale and overtaken. */
const LOCK_STALE_MS = 2 * 60 * 1000

/** systemctl unit restarted by Tier 2. Override per host via env. */
const SERVICE = process.env.AGENT_SERVICE ?? 'claude-tg-agent.service'

/**
 * Shared restart state directory — NOT a per-channel STATE_DIR, so the lock
 * and counter are common across telegram, discord, and the watchdog (they all
 * restart the same one service).
 */
const RESTART_STATE_DIR =
  process.env.AGENT_RESTART_STATE_DIR ?? join(homedir(), '.claude', 'agent-restart')
const STATE_FILE = join(RESTART_STATE_DIR, 'restart-state.json')
const LOCK_FILE = join(RESTART_STATE_DIR, 'restart.lock')

/** Path to the file holding the Claude PID, written by the launcher (Tier 1). */
const CLAUDE_PID_FILE = process.env.CLAUDE_PID_FILE ?? join(RESTART_STATE_DIR, 'claude.pid')

/** Which restart tier actually ran. */
export type RestartTier = 'process' | 'service'

/** Persisted restart history (timestamps in ms). */
export type RestartState = { history: number[] }

/** Outcome of the pure throttle decision. */
export type RestartDecision =
  | { allow: true; nextState: RestartState }
  | { allow: false; reason: 'cooldown' | 'limit'; retryAfterMs: number }

/**
 * Decide whether an automatic restart is allowed under the storm guard.
 *
 * Pure function (no IO) so the guard is unit-testable with an injected clock.
 * bypassThrottle (manual /restart) always allows but still records the restart
 * in history so a following automatic restart sees it for cooldown purposes.
 *
 * Args:
 *   state: persisted restart history.
 *   nowMs: current time in ms.
 *   bypassThrottle: true for manual restarts (skip cooldown + cap checks).
 * Returns:
 *   A RestartDecision; when allow is true, nextState is the history to persist.
 */
export function decideRestart(
  state: RestartState,
  nowMs: number,
  bypassThrottle: boolean,
): RestartDecision {
  const recent = state.history.filter(ts => nowMs - ts < RESTART_WINDOW_MS)

  if (bypassThrottle) {
    return { allow: true, nextState: { history: [...recent, nowMs] } }
  }

  const last = recent.length ? Math.max(...recent) : Number.NEGATIVE_INFINITY
  const sinceLast = nowMs - last
  if (sinceLast < RESTART_COOLDOWN_MS) {
    return { allow: false, reason: 'cooldown', retryAfterMs: RESTART_COOLDOWN_MS - sinceLast }
  }

  if (recent.length >= RESTART_MAX_PER_WINDOW) {
    const oldest = Math.min(...recent)
    return { allow: false, reason: 'limit', retryAfterMs: RESTART_WINDOW_MS - (nowMs - oldest) }
  }

  return { allow: true, nextState: { history: [...recent, nowMs] } }
}

/** Final result reported back to the caller (bot reply / watchdog log). */
export type RestartResult =
  | { status: 'ok'; tier: RestartTier }
  | { status: 'throttled'; reason: 'cooldown' | 'limit'; retryAfterMs: number }
  | { status: 'in-progress' }
  | { status: 'failed'; error: string }

/** Injectable side effects (production defaults wire to fs/exec/clock). */
export type RestartDeps = {
  now: () => number
  killProcess: (pid: number) => void
  systemctlRestart: () => Promise<void>
  readPid: () => number | null
}

const defaultDeps: RestartDeps = {
  now: () => Date.now(),
  killProcess: pid => process.kill(pid, 'SIGTERM'),
  systemctlRestart: async () => {
    await execFileAsync('sudo', ['systemctl', 'restart', SERVICE], { timeout: 30_000 })
  },
  readPid: () => {
    if (!existsSync(CLAUDE_PID_FILE)) return null
    const pid = Number(readFileSync(CLAUDE_PID_FILE, 'utf8').trim())
    return Number.isInteger(pid) && pid > 0 ? pid : null
  },
}

/**
 * Restart the Claude agent, tiered, with storm guard and a cross-process lock.
 *
 * Tries Tier 1 (kill PID -> launcher relaunches); falls back to Tier 2
 * (systemctl) when no PID is available or the kill throws. The lockfile
 * prevents a manual /restart and an automatic watchdog restart from running at
 * once; if a restart is already in progress the call returns 'in-progress'
 * without acting.
 *
 * Args:
 *   reason: human-readable trigger (logged into the lockfile).
 *   opts.bypassThrottle: true for manual /restart (skip the storm guard).
 *   deps: injectable side effects (tests override; omit in production).
 * Returns:
 *   A RestartResult describing what happened.
 */
export async function restartAgent(
  reason: string,
  opts: { bypassThrottle?: boolean } = {},
  deps: RestartDeps = defaultDeps,
): Promise<RestartResult> {
  const bypassThrottle = opts.bypassThrottle ?? false
  mkdirSync(RESTART_STATE_DIR, { recursive: true, mode: 0o700 })

  if (!acquireLock(reason, deps.now())) {
    return { status: 'in-progress' }
  }

  try {
    const state = loadState()
    const decision = decideRestart(state, deps.now(), bypassThrottle)
    if (!decision.allow) {
      return { status: 'throttled', reason: decision.reason, retryAfterMs: decision.retryAfterMs }
    }

    const tier = await performRestart(deps)
    saveState(decision.nextState)
    return { status: 'ok', tier }
  } catch (err) {
    return { status: 'failed', error: String(err) }
  } finally {
    releaseLock()
  }
}

/**
 * Run the cheapest restart tier that works: Tier 1 (process kill) when a PID is
 * available, else Tier 2 (systemctl). Falls through to Tier 2 if the kill
 * throws (e.g. stale PID).
 *
 * Args:
 *   deps: injectable side effects.
 * Returns:
 *   The tier that ran. Throws only if Tier 2 itself fails.
 */
export async function performRestart(deps: RestartDeps = defaultDeps): Promise<RestartTier> {
  const pid = deps.readPid()
  if (pid !== null) {
    try {
      deps.killProcess(pid)
      return 'process'
    } catch (err) {
      process.stderr.write(`restart-agent: Tier 1 kill(${pid}) failed, escalating: ${err}\n`)
    }
  }
  await deps.systemctlRestart()
  return 'service'
}

/** Load persisted restart state; missing/corrupt file -> empty history. */
function loadState(): RestartState {
  try {
    const parsed = JSON.parse(readFileSync(STATE_FILE, 'utf8')) as Partial<RestartState>
    return { history: Array.isArray(parsed.history) ? parsed.history : [] }
  } catch {
    return { history: [] }
  }
}

/** Persist restart state. */
function saveState(state: RestartState): void {
  writeFileSync(STATE_FILE, JSON.stringify(state), { mode: 0o600 })
}

/**
 * Acquire the restart lock atomically (O_EXCL). A lock older than LOCK_STALE_MS
 * is overtaken (the holder likely died mid-restart). Returns false when a fresh
 * lock is held.
 */
function acquireLock(reason: string, nowMs: number): boolean {
  if (existsSync(LOCK_FILE)) {
    const heldAt = readLockTs()
    if (heldAt !== null && nowMs - heldAt < LOCK_STALE_MS) return false
    rmSync(LOCK_FILE, { force: true })
  }
  try {
    writeFileSync(LOCK_FILE, JSON.stringify({ pid: process.pid, ts: nowMs, reason }), {
      flag: 'wx',
      mode: 0o600,
    })
    return true
  } catch {
    return false
  }
}

/** Read the lock's timestamp, or null if unreadable. */
function readLockTs(): number | null {
  try {
    const ts = Number((JSON.parse(readFileSync(LOCK_FILE, 'utf8')) as { ts?: number }).ts)
    return Number.isFinite(ts) ? ts : null
  } catch {
    return null
  }
}

/** Release the restart lock (best effort). */
function releaseLock(): void {
  rmSync(LOCK_FILE, { force: true })
}
