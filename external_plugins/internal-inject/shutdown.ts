/** Shutdown helpers for the internal-inject channel server. */

const EXIT_CODE_OK = 0
const WIN32_PLATFORM = 'win32'
const ERRNO_NO_PERMISSION = 'EPERM'
const EXISTENCE_CHECK_SIGNAL = 0

/** Process state the orphan watchdog inspects on every tick. */
export interface OrphanSnapshot {
  platform: string
  bootPpid: number
  ppid: number
  grandparentAlive: boolean
  stdinDestroyed: boolean
  stdinEnded: boolean
}

/**
 * Build an idempotent shutdown function.
 *
 * The first call runs `cleanup` and then `exit(0)`; every later call is a no-op,
 * so stdin EOF, signals and the watchdog may all fire without double cleanup.
 * `exit` still runs when `cleanup` throws.
 *
 * @param cleanup - Releases resources (e.g. closes the inject HTTP listener).
 * @param exit - Terminates the process; `process.exit` in production.
 * @returns A function that performs the shutdown at most once.
 */
export function createShutdown(cleanup: () => void, exit: (code: number) => void): () => void {
  let shuttingDown = false
  return (): void => {
    if (shuttingDown) return
    shuttingDown = true
    try {
      cleanup()
    } catch (err) {
      process.stderr.write(`internal-inject channel: cleanup failed during shutdown: ${err}\n`)
    }
    exit(EXIT_CODE_OK)
  }
}

/**
 * Decide whether the server has lost the Claude session that started it.
 *
 * @param snapshot - Current process state plus the parent pid recorded at boot.
 * @returns True when the process was reparented or its boot-time grandparent is gone
 *   (both POSIX only), or stdin is dead.
 */
export function isOrphaned(snapshot: OrphanSnapshot): boolean {
  const posix = snapshot.platform !== WIN32_PLATFORM
  const reparented = posix && snapshot.ppid !== snapshot.bootPpid
  const grandparentGone = posix && !snapshot.grandparentAlive
  return reparented || grandparentGone || snapshot.stdinDestroyed || snapshot.stdinEnded
}

/**
 * Look up the parent pid of another process via `ps`.
 *
 * Never throws: a missing `ps` executable must not crash the server at boot.
 *
 * @param pid - Process whose parent to look up.
 * @returns The parent pid, or null when the process does not exist, `ps` exits non-zero,
 *   or `ps` cannot be executed at all (e.g. not on PATH).
 */
export function readParentPid(pid: number): number | null {
  let output: string
  try {
    const result = Bun.spawnSync(['ps', '-o', 'ppid=', '-p', String(pid)])
    if (!result.success) return null
    output = result.stdout.toString()
  } catch {
    return null
  }
  const parentPid = Number(output.trim())
  return Number.isInteger(parentPid) && parentPid > 0 ? parentPid : null
}

/**
 * Check whether a process still exists, without signalling it.
 *
 * @param pid - Process to check.
 * @returns True when the process exists, including one we lack permission to signal.
 */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, EXISTENCE_CHECK_SIGNAL)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === ERRNO_NO_PERMISSION
  }
}

/**
 * Check whether the grandparent recorded at boot is still running.
 *
 * Fails open: an unknown grandparent (null, e.g. `ps` was unavailable at boot) counts
 * as alive, which disables this check and leaves the ppid and stdin checks in charge.
 *
 * @param grandparentPid - Grandparent pid recorded at boot, or null when it could not be read.
 * @returns True when the grandparent is unknown or still exists.
 */
export function isGrandparentAlive(grandparentPid: number | null): boolean {
  return grandparentPid === null || isProcessAlive(grandparentPid)
}
