/**
 * Shared agent-restart action (JP-37 + JP-38).
 *
 * Two entry points share this module:
 *   - JP-38 `/restart` — manual, user-initiated from the bot layer.
 *   - JP-37 watchdog — automatic, on detected session death.
 *
 * Two restart tiers (cheapest that works wins):
 *   - Tier 1 (process): resolve the Claude PID live from tmux (pane PID ->
 *     walk the process tree for the `claude` descendant), SIGTERM it, and
 *     escalate to SIGKILL if it survives the grace period; the launcher's
 *     in-session `while true` loop relaunches it. No sudo, works on a frozen
 *     TUI (signal, not keystroke), and no PID file to go stale.
 *   - Tier 2 (service): `sudo systemctl restart <SERVICE>`. Escalation when
 *     no Claude PID can be found or the process survives both signals. Needs
 *     scoped NOPASSWD sudoers.
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
import { TMUX_TARGET } from './tmux-pane'
import { clearRestartMarker, writeRestartMarker } from './startup-notice'

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

/** Grace period after SIGTERM before escalating to SIGKILL (Tier 1). */
export const SIGTERM_GRACE_MS = 10_000

/** Grace period after SIGKILL before declaring Tier 1 failed. SIGKILL cannot
 * be ignored, so this only covers reaping latency / uninterruptible sleep. */
export const SIGKILL_GRACE_MS = 2_000

/** Poll interval while waiting for a signalled process to exit. */
export const KILL_POLL_INTERVAL_MS = 250

/** /proc comm name of the Claude CLI process we target with Tier 1. */
const CLAUDE_COMM = 'claude'

/** BFS depth cap when walking the pane's process tree for the claude PID. */
const MAX_TREE_DEPTH = 10

/** Hard cap on a single tmux/pgrep probe shell-out. */
const PROBE_TIMEOUT_MS = 1000

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

/** Signals Tier 1 may send, in escalation order. */
export type KillSignal = 'SIGTERM' | 'SIGKILL'

/** Injectable side effects (production defaults wire to fs/exec/clock). */
export type RestartDeps = {
  now: () => number
  killProcess: (pid: number, signal: KillSignal) => void
  isAlive: (pid: number) => boolean
  readComm: (pid: number) => string | null
  sleep: (ms: number) => Promise<void>
  findClaudePid: () => Promise<number | null>
  systemctlRestart: () => Promise<void>
}

const defaultDeps: RestartDeps = {
  now: () => Date.now(),
  killProcess: (pid, signal) => process.kill(pid, signal),
  isAlive: pid => {
    try {
      process.kill(pid, 0)
      return true
    } catch {
      return false
    }
  },
  readComm: pid => {
    try {
      return readFileSync(`/proc/${pid}/comm`, 'utf8').trim()
    } catch {
      return null
    }
  },
  sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
  findClaudePid: () => findClaudePidViaTmux(),
  systemctlRestart: async () => {
    await execFileAsync('sudo', ['systemctl', 'restart', SERVICE], { timeout: 30_000 })
  },
}

/** Injectable process-tree reads for the tmux PID resolution (testable). */
export type ProcessTreeReader = {
  getChildren: (pid: number) => Promise<number[]>
  getCommand: (pid: number) => Promise<string | null>
}

const defaultTreeReader: ProcessTreeReader = {
  getChildren: async pid => {
    try {
      const { stdout } = await execFileAsync('pgrep', ['-P', String(pid)], {
        timeout: PROBE_TIMEOUT_MS,
      })
      return stdout
        .split('\n')
        .map(line => Number(line.trim()))
        .filter(n => Number.isInteger(n) && n > 0)
    } catch {
      // pgrep exits non-zero when a process has no children — not an error.
      return []
    }
  },
  getCommand: async pid => {
    try {
      return readFileSync(`/proc/${pid}/comm`, 'utf8').trim()
    } catch {
      return null
    }
  },
}

/**
 * Find the Claude CLI PID under a root process by walking the process tree.
 *
 * Breadth-first from rootPid, matching each descendant's comm name against
 * CLAUDE_COMM, capped at MAX_TREE_DEPTH levels. BFS returns the claude process
 * closest to the pane shell, which is the launcher-managed one we must signal.
 *
 * Args:
 *   rootPid: PID to start the walk from (tmux pane PID in production).
 *   tree: injectable process-tree reads.
 * Returns:
 *   The claude PID, or null when no descendant matches.
 */
export async function findClaudePidInTree(
  rootPid: number,
  tree: ProcessTreeReader = defaultTreeReader,
): Promise<number | null> {
  const queue: Array<{ pid: number; depth: number }> = [{ pid: rootPid, depth: 0 }]
  while (queue.length > 0) {
    const { pid, depth } = queue.shift()!
    if (depth >= MAX_TREE_DEPTH) continue
    for (const child of await tree.getChildren(pid)) {
      if ((await tree.getCommand(child)) === CLAUDE_COMM) return child
      queue.push({ pid: child, depth: depth + 1 })
    }
  }
  return null
}

/**
 * Parse `tmux list-panes -F '#{pane_pid}'` output into pane PIDs.
 *
 * Pure (no IO) so the multi-pane handling is unit-testable. Blank and
 * non-numeric lines are dropped.
 *
 * Args:
 *   stdout: raw list-panes output, one pane PID per line.
 * Returns:
 *   All valid pane PIDs, in pane order.
 */
export function parsePanePids(stdout: string): number[] {
  return stdout
    .split('\n')
    .map(line => Number(line.trim()))
    .filter(n => Number.isInteger(n) && n > 0)
}

/**
 * Resolve the Claude PID live from tmux: pane PIDs -> claude descendant.
 *
 * Replaces the former PID-file lookup — tmux is the source of truth for what
 * is actually running in the agent session, so the PID can never go stale the
 * way a launcher-written file can. Every pane of the target window is probed
 * in order (a split window must not hide claude behind pane 0); the first
 * claude descendant wins. Returns null (Tier 2 escalation) when the tmux
 * target is gone, no pane PID is parsable, or no claude descendant exists.
 *
 * Args:
 *   target: tmux session:window to inspect. Defaults to TMUX_TARGET.
 *   tree: injectable process-tree reads.
 * Returns:
 *   The claude PID, or null when it cannot be resolved.
 */
export async function findClaudePidViaTmux(
  target: string = TMUX_TARGET,
  tree: ProcessTreeReader = defaultTreeReader,
): Promise<number | null> {
  let panePids: number[]
  try {
    const { stdout } = await execFileAsync(
      'tmux',
      ['list-panes', '-t', target, '-F', '#{pane_pid}'],
      { timeout: PROBE_TIMEOUT_MS },
    )
    panePids = parsePanePids(stdout)
  } catch (err) {
    process.stderr.write(`restart-agent: tmux list-panes failed for ${target}: ${err}\n`)
    return null
  }
  for (const panePid of panePids) {
    const pid = await findClaudePidInTree(panePid, tree)
    if (pid !== null) return pid
  }
  return null
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

    // Marker BEFORE the restart: the freshly booted bot server reads it to
    // announce "I'm back" with a plugin-version diff (startup-notice.ts).
    writeRestartMarker(reason, deps.now())
    const tier = await performRestart(deps)
    saveState(decision.nextState)
    return { status: 'ok', tier }
  } catch (err) {
    // Restart failed — the agent never went down; a boot notice would lie.
    clearRestartMarker()
    return { status: 'failed', error: String(err) }
  } finally {
    releaseLock()
  }
}

/**
 * Run the cheapest restart tier that works: Tier 1 (signal the claude PID
 * resolved live from tmux, SIGTERM then SIGKILL) when a PID is found, else
 * Tier 2 (systemctl). Escalates to Tier 2 when no PID resolves or the process
 * survives both signals.
 *
 * Args:
 *   deps: injectable side effects.
 * Returns:
 *   The tier that ran. Throws only if Tier 2 itself fails.
 */
export async function performRestart(deps: RestartDeps = defaultDeps): Promise<RestartTier> {
  const pid = await deps.findClaudePid()
  if (pid !== null) {
    if (await terminateWithEscalation(pid, deps)) return 'process'
    process.stderr.write(
      `restart-agent: Tier 1 pid ${pid} survived SIGTERM+SIGKILL, escalating to Tier 2\n`,
    )
  }
  await deps.systemctlRestart()
  return 'service'
}

/**
 * Terminate a process with SIGTERM -> SIGKILL escalation.
 *
 * Sends SIGTERM and polls liveness for up to SIGTERM_GRACE_MS; if the process
 * survives, sends SIGKILL and polls for up to SIGKILL_GRACE_MS. A kill() that
 * throws (e.g. ESRCH after the process exited on its own) resolves to the
 * current liveness rather than an error.
 *
 * Args:
 *   pid: process to terminate.
 *   deps: injectable side effects (clock, signals, liveness, sleep).
 * Returns:
 *   True when the process is gone, false when it survived both signals.
 */
export async function terminateWithEscalation(pid: number, deps: RestartDeps): Promise<boolean> {
  if (!sendSignal(pid, 'SIGTERM', deps)) return !deps.isAlive(pid)
  if (await waitForExit(pid, SIGTERM_GRACE_MS, deps)) return true
  // PID-reuse guard: SIGTERM_GRACE_MS is long enough for the target to exit
  // AND the kernel to hand its PID to an unrelated process — isAlive alone
  // would then report "survived" and the SIGKILL below would hit an innocent
  // victim. Re-verify the PID still names a claude process before escalating;
  // a mismatch (or a vanished /proc entry) means our target is already gone.
  if (deps.readComm(pid) !== CLAUDE_COMM) return true
  process.stderr.write(`restart-agent: pid ${pid} survived SIGTERM, sending SIGKILL\n`)
  if (!sendSignal(pid, 'SIGKILL', deps)) return !deps.isAlive(pid)
  return waitForExit(pid, SIGKILL_GRACE_MS, deps)
}

/** Send a signal; false when kill() threw (process may already be gone). */
function sendSignal(pid: number, signal: KillSignal, deps: RestartDeps): boolean {
  try {
    deps.killProcess(pid, signal)
    return true
  } catch (err) {
    process.stderr.write(`restart-agent: kill(${pid}, ${signal}) threw: ${err}\n`)
    return false
  }
}

/** Poll liveness until the process exits or graceMs elapses. True = exited. */
async function waitForExit(pid: number, graceMs: number, deps: RestartDeps): Promise<boolean> {
  const deadline = deps.now() + graceMs
  while (deps.now() < deadline) {
    if (!deps.isAlive(pid)) return true
    await deps.sleep(KILL_POLL_INTERVAL_MS)
  }
  return !deps.isAlive(pid)
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
