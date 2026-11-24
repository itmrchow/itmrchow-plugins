import { afterEach, beforeAll, describe, expect, test } from 'bun:test'
import type { Subprocess } from 'bun'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { connect, createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createBunOnlyPathDir } from './test-support'

const PLUGIN_DIR = import.meta.dir
const LOOPBACK = '127.0.0.1'
const TEST_SERVICE = 'lifecycle-test'
const TEST_TOKEN = 'lifecycle-test-token'
const POLL_INTERVAL_MS = 100
const BOOT_TIMEOUT_MS = 10_000
const EXIT_TIMEOUT_MS = 3_000
const ORPHAN_EXIT_TIMEOUT_MS = 10_000
const WATCHDOG_INTERVAL_MS = 2_000
const WATCHDOG_MARGIN_MS = 1_000
const LONG_TEST_TIMEOUT_MS = 30_000
const HTTP_OK = 200
const STDIN_HOLDER_SECONDS = 60

type ServerSubprocess = Subprocess<'pipe', 'ignore', 'ignore'>
type ServerLayout = 'direct' | 'parent-shell' | 'grandparent-shell'

let stateDir = ''
const spawned: ServerSubprocess[] = []
const usedPorts: number[] = []
const stdinHolders: string[] = []

beforeAll(() => {
  stateDir = mkdtempSync(join(tmpdir(), 'internal-inject-lifecycle-'))
  const tokenSha256 = createHash('sha256').update(TEST_TOKEN).digest('hex')
  writeFileSync(
    join(stateDir, 'tokens.json'),
    JSON.stringify({ tokens: [{ service: TEST_SERVICE, token_sha256: tokenSha256, issued_at: new Date().toISOString() }] }),
    { mode: 0o600 },
  )
})

afterEach(() => {
  for (const proc of spawned.splice(0)) {
    if (proc.exitCode === null && proc.signalCode === null) proc.kill('SIGKILL')
  }
  for (const port of usedPorts.splice(0)) killListenerOn(port)
  for (const duration of stdinHolders.splice(0)) runBestEffort(['pkill', '-f', `^sleep ${duration}$`])
})

process.on('exit', () => {
  if (stateDir) rmSync(stateDir, { recursive: true, force: true })
})

/**
 * Reserve a free loopback port by binding port 0 and releasing it.
 *
 * @returns A port number that was free a moment ago.
 */
async function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer()
    probe.once('error', reject)
    probe.listen(0, LOOPBACK, () => {
      const address = probe.address()
      if (address === null || typeof address === 'string') {
        probe.close()
        reject(new Error('could not read probe address'))
        return
      }
      probe.close(() => resolve(address.port))
    })
  })
}

/**
 * Check whether something accepts TCP connections on a loopback port.
 *
 * @param port - Port to probe.
 * @returns True when a connection succeeds.
 */
async function isListening(port: number): Promise<boolean> {
  return new Promise(resolve => {
    const socket = connect(port, LOOPBACK)
    socket.once('connect', () => {
      socket.destroy()
      resolve(true)
    })
    socket.once('error', () => resolve(false))
  })
}

/**
 * Check whether a fresh listener can bind the port.
 *
 * @param port - Port to try.
 * @returns True when the bind succeeds.
 */
async function canBind(port: number): Promise<boolean> {
  return new Promise(resolve => {
    const probe = createServer()
    probe.once('error', () => resolve(false))
    probe.listen(port, LOOPBACK, () => probe.close(() => resolve(true)))
  })
}

/**
 * Poll a condition until it holds or the deadline passes.
 *
 * @param check - Condition to poll.
 * @param timeoutMs - Maximum time to wait.
 * @returns True when the condition held before the deadline.
 */
async function waitFor(check: () => Promise<boolean> | boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await check()) return true
    await Bun.sleep(POLL_INTERVAL_MS)
  }
  return check()
}

/**
 * Kill whatever still listens on a port; cleans up a grandchild left by a failed test.
 *
 * @param port - Port whose listener should be killed.
 */
function killListenerOn(port: number): void {
  const pids = runBestEffort(['lsof', '-ti', `tcp:${port}`, '-sTCP:LISTEN'])
    .split('\n')
    .filter(line => line.trim() !== '')
  for (const pid of pids) {
    try {
      process.kill(Number(pid), 'SIGKILL')
    } catch {
      // Already gone.
    }
  }
}

/**
 * Run a cleanup command, tolerating a missing executable or a non-zero exit.
 *
 * @param cmd - Command and arguments.
 * @returns The command's stdout, or an empty string when it could not run.
 */
function runBestEffort(cmd: string[]): string {
  try {
    return Bun.spawnSync(cmd).stdout.toString()
  } catch {
    return ''
  }
}

/**
 * Start server.ts with its inject listener on a fresh port and wait until it accepts connections.
 *
 * @param layout - `direct`, or under one (`parent-shell`) or two (`grandparent-shell`) `sh` layers so a test can kill an ancestor.
 * @param fixedPort - Reuse this port instead of reserving a fresh one.
 * @param envOverrides - Extra environment for the spawned process.
 * @returns The spawned process (the outermost shell for shell layouts) and the inject port.
 */
async function startServer(
  layout: ServerLayout,
  fixedPort?: number,
  envOverrides: Record<string, string> = {},
): Promise<{ proc: ServerSubprocess; port: number }> {
  const port = fixedPort ?? (await getFreePort())
  usedPorts.push(port)
  const serverCmd = [process.execPath, 'server.ts']
  // Stdin is fed by a sibling `sleep` under the same shell, not by this test process.
  const stdinHolderDuration = `${STDIN_HOLDER_SECONDS}.${port}`
  stdinHolders.push(stdinHolderDuration)
  const parentScript = `sleep ${stdinHolderDuration} | "${process.execPath}" server.ts; :`
  const grandparentScript = `sleep ${stdinHolderDuration} | sh -c '"${process.execPath}" server.ts; :'; :`
  const layoutCommands: Record<ServerLayout, string[]> = {
    direct: serverCmd,
    'parent-shell': ['sh', '-c', parentScript],
    'grandparent-shell': ['sh', '-c', grandparentScript],
  }
  const cmd = layoutCommands[layout]
  const proc = Bun.spawn(cmd, {
    cwd: PLUGIN_DIR,
    env: {
      ...process.env,
      INTERNAL_INJECT_PORT: String(port),
      INTERNAL_INJECT_HOST: LOOPBACK,
      INTERNAL_INJECT_STATE_DIR: stateDir,
      ...envOverrides,
    },
    stdin: 'pipe',
    stdout: 'ignore',
    stderr: 'ignore',
  })
  spawned.push(proc)
  const booted = await waitFor(() => isListening(port), BOOT_TIMEOUT_MS)
  if (!booted) throw new Error(`server did not start listening on ${port}`)
  return { proc, port }
}

/**
 * Wait for the process to exit, giving up after a deadline.
 *
 * @param proc - Process to wait on.
 * @param timeoutMs - Maximum time to wait.
 * @returns True when it exited in time.
 */
async function waitForExit(proc: ServerSubprocess, timeoutMs: number): Promise<boolean> {
  const timedOut = Bun.sleep(timeoutMs).then(() => false)
  return Promise.race([proc.exited.then(() => true), timedOut])
}

/**
 * Send one authenticated inject request.
 *
 * @param port - Inject port.
 * @returns HTTP status of the response.
 */
async function postInject(port: number): Promise<number> {
  const response = await fetch(`http://${LOOPBACK}:${port}/inject`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TEST_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: 'ping', chat_id: 'lifecycle', reply_via: 'telegram' }),
  })
  return response.status
}

describe('server lifecycle', () => {
  test('stays alive past several watchdog ticks and keeps accepting injects', async () => {
    const { proc, port } = await startServer('direct')

    await Bun.sleep(WATCHDOG_INTERVAL_MS * 3 + WATCHDOG_MARGIN_MS)

    expect(proc.exitCode).toBeNull()
    expect(await postInject(port)).toBe(HTTP_OK)
  }, LONG_TEST_TIMEOUT_MS)

  test('still binds and shuts down on stdin close when ps is not on PATH', async () => {
    const { proc, port } = await startServer('direct', undefined, { PATH: createBunOnlyPathDir() })

    expect(proc.exitCode).toBeNull()
    expect(await postInject(port)).toBe(HTTP_OK)

    proc.stdin.end()

    expect(await waitForExit(proc, EXIT_TIMEOUT_MS)).toBe(true)
    expect(proc.exitCode).toBe(0)
    expect(await canBind(port)).toBe(true)
  }, LONG_TEST_TIMEOUT_MS)

  test('exits and releases the port when stdin is closed', async () => {
    const { proc, port } = await startServer('direct')

    proc.stdin.end()

    expect(await waitForExit(proc, EXIT_TIMEOUT_MS)).toBe(true)
    expect(proc.exitCode).toBe(0)
    expect(await canBind(port)).toBe(true)
  }, LONG_TEST_TIMEOUT_MS)

  for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) {
    test(`exits cleanly and releases the port on ${signal}`, async () => {
      const { proc, port } = await startServer('direct')

      proc.kill(signal)

      expect(await waitForExit(proc, EXIT_TIMEOUT_MS)).toBe(true)
      expect(proc.exitCode).toBe(0)
      expect(await canBind(port)).toBe(true)
    }, LONG_TEST_TIMEOUT_MS)
  }

  test('exits within the orphan deadline when its parent is SIGKILLed while stdin stays open', async () => {
    const { proc: shell, port } = await startServer('parent-shell')

    shell.kill('SIGKILL')
    await shell.exited

    expect(await waitFor(async () => !(await isListening(port)), ORPHAN_EXIT_TIMEOUT_MS)).toBe(true)
    expect(await canBind(port)).toBe(true)
  }, LONG_TEST_TIMEOUT_MS)

  test('exits within the orphan deadline when its grandparent is SIGKILLed while parent and stdin survive', async () => {
    const { proc: outerShell, port } = await startServer('grandparent-shell')

    outerShell.kill('SIGKILL')
    await outerShell.exited

    expect(await waitFor(async () => !(await isListening(port)), ORPHAN_EXIT_TIMEOUT_MS)).toBe(true)
    expect(await canBind(port)).toBe(true)
  }, LONG_TEST_TIMEOUT_MS)

  test('a second server binds the same port right after the first one shut down', async () => {
    const first = await startServer('direct')
    first.proc.stdin.end()
    expect(await waitForExit(first.proc, EXIT_TIMEOUT_MS)).toBe(true)

    const second = await startServer('direct', first.port)

    expect(second.proc.exitCode).toBeNull()
    expect(await postInject(second.port)).toBe(HTTP_OK)
  }, LONG_TEST_TIMEOUT_MS)
})
