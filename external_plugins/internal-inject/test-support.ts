/** Shared fixtures for the internal-inject tests. */

import { mkdtempSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * Create a temporary directory whose only executable is a symlink to the running bun,
 * for use as PATH in a child process that must not find `ps`.
 *
 * @returns Absolute path of the directory.
 */
export function createBunOnlyPathDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'internal-inject-bun-only-path-'))
  symlinkSync(process.execPath, join(dir, 'bun'))
  return dir
}
