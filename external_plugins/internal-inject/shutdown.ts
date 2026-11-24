/**
 * Shutdown helpers for the internal-inject channel server.
 *
 * Kept as its own module so the re-entrancy and orphan rules are unit-testable:
 * server.ts binds its port at module top-level, so it cannot be imported from a test.
 */

const EXIT_CODE_OK = 0
const WIN32_PLATFORM = 'win32'

/** Process state the orphan watchdog inspects on every tick. */
export interface OrphanSnapshot {
  platform: string
  bootPpid: number
  ppid: number
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
 * @returns True when the process was reparented (POSIX only) or stdin is dead.
 */
export function isOrphaned(snapshot: OrphanSnapshot): boolean {
  const reparented = snapshot.platform !== WIN32_PLATFORM && snapshot.ppid !== snapshot.bootPpid
  return reparented || snapshot.stdinDestroyed || snapshot.stdinEnded
}
