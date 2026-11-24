/**
 * Shutdown helpers for the internal-inject channel server.
 *
 * Kept as its own module so the re-entrancy and orphan rules are unit-testable:
 * server.ts binds its port at module top-level, so it cannot be imported from a test.
 */

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
 * Look up the parent pid of another process via `ps` (POSIX only).
 *
 * @param pid - Process whose parent to look up.
 * @returns The parent pid, or null on win32, when the process does not exist, or when `ps` fails.
 */
export function readParentPid(pid: number): number | null {
  if (process.platform === WIN32_PLATFORM) return null
  const result = Bun.spawnSync(['ps', '-o', 'ppid=', '-p', String(pid)])
  if (!result.success) return null
  const parentPid = Number(result.stdout.toString().trim())
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
