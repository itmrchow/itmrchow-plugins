/**
 * The poller under tsx (node), which is how the arm64 VM agents run it — every
 * other test in this directory starts it under bun.
 *
 * A module that loads under bun but not under tsx would put a VM's poller into
 * a restart loop and cut off inbound Telegram, whatever the approval switch
 * says: poller.ts imports the approval modules unconditionally.
 *
 * tsx is not a dependency of this plugin (hosts install it themselves), so it
 * is looked up at $TSX_BIN, then on PATH. Without it the tests are skipped,
 * visibly, with the reason printed.
 */
import { afterEach, expect, test } from 'bun:test'
import { type ChildProcess, spawn, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FAKE_BOT_TOKEN, startFakeTelegram, type FakeTelegram } from './fake-telegram'

const TSX_BIN = process.env.TSX_BIN || Bun.which('tsx')
const LOOPBACK = '127.0.0.1'
const U1 = 111
const WAIT_TIMEOUT_MS = 15_000
const POLL_INTERVAL_MS = 50
const TEST_TIMEOUT_MS = 30_000
const EXIT_MISCONFIGURED = 1
/** What a module that failed to load under node looks like on stderr. */
const LOAD_FAILURE_RE = /SyntaxError|ERR_MODULE_NOT_FOUND|ERR_UNKNOWN_FILE_EXTENSION|Cannot find module|TransformError/

/**
 * What `process.versions.bun` is inside the runtime tsx actually starts.
 * 'undefined' means node. Anything else means "tsx" is running on bun (a bun
 * binary standing in for node on PATH, `bun --bun`, …), and every test below
 * would pass without having exercised node at all.
 */
const BUN_VERSION_UNDER_TSX = TSX_BIN
  ? spawnSync(TSX_BIN, ['-e', 'process.stdout.write(String(process.versions.bun))'], {
      env: { PATH: process.env.PATH ?? '' },
      // stdin closed: with an open pipe, `tsx -e` waits on it and never exits.
      stdio: ['ignore', 'pipe', 'ignore'],
      encoding: 'utf8',
      timeout: WAIT_TIMEOUT_MS,
    }).stdout
  : undefined
const RUNS_ON_NODE = 'undefined'

if (!TSX_BIN) {
  process.stderr.write(
    'poller-tsx.e2e: SKIPPED — tsx not found (set TSX_BIN or put tsx on PATH); the poller was NOT verified under tsx\n',
  )
}

type Running = { poller: ChildProcess; fake: FakeTelegram; rootDir: string; stderr: string[]; port: number }

const running: Running[] = []
const tempDirs: string[] = []

afterEach(async () => {
  for (const run of running.splice(0)) {
    run.poller.kill('SIGKILL')
    await run.fake.close()
  }
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))

async function waitFor(probe: () => boolean | Promise<boolean>, what: string, stderr: string[]): Promise<void> {
  const deadline = Date.now() + WAIT_TIMEOUT_MS
  while (!(await probe())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}; poller stderr:\n${stderr.join('')}`)
    await sleep(POLL_INTERVAL_MS)
  }
}

function makeDirs(): { rootDir: string; stateDir: string; homeDir: string } {
  const rootDir = mkdtempSync(join(tmpdir(), 'poller-tsx-'))
  tempDirs.push(rootDir)
  const stateDir = join(rootDir, 'state')
  const homeDir = join(rootDir, 'home')
  mkdirSync(stateDir)
  mkdirSync(homeDir)
  return { rootDir, stateDir, homeDir }
}

async function freePort(): Promise<number> {
  const server = createServer()
  await new Promise<void>(r => server.listen(0, LOOPBACK, r))
  const { port } = server.address() as { port: number }
  await new Promise<void>(r => server.close(() => r()))
  return port
}

async function startUnderTsx(env: Record<string, string>): Promise<Running> {
  const { rootDir, stateDir, homeDir } = makeDirs()
  writeFileSync(join(stateDir, 'access.json'), JSON.stringify({ allowFrom: [String(U1)] }))
  const fake = await startFakeTelegram()
  const port = await freePort()
  const stderr: string[] = []
  // Minimal environment: nothing from the developer's shell may reach the poller.
  const poller = spawn(TSX_BIN as string, ['poller.ts'], {
    cwd: import.meta.dir,
    env: {
      PATH: process.env.PATH ?? '',
      HOME: homeDir,
      TELEGRAM_STATE_DIR: stateDir,
      TELEGRAM_BOT_TOKEN: FAKE_BOT_TOKEN,
      TELEGRAM_API_ROOT: fake.apiRoot,
      TELEGRAM_POLLER_PORT: String(port),
      ...env,
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  })
  poller.stderr?.on('data', (chunk: Buffer) => stderr.push(chunk.toString()))
  const run: Running = { poller, fake, rootDir, stderr, port }
  running.push(run)
  await waitFor(() => stderr.join('').includes('polling as @'), 'the poller to start polling under tsx', stderr)
  return run
}

// Fails rather than skips: tsx was supplied, so a green run would be read as
// "verified under tsx". A skip is reserved for "there is no tsx to try".
test.skipIf(!TSX_BIN)('tsx 實際跑在 node 上（不是 bun 冒充），否則下面三條等於沒驗', () => {
  expect(BUN_VERSION_UNDER_TSX).toBe(RUNS_ON_NODE)
})

test.skipIf(!TSX_BIN)('tsx 下 poller 的所有模組都載入成功：無 token 時停在設定檢查，而不是 import / 語法錯誤', () => {
  const { stateDir, homeDir } = makeDirs()
  const result = spawnSync(TSX_BIN as string, ['poller.ts'], {
    cwd: import.meta.dir,
    env: { PATH: process.env.PATH ?? '', HOME: homeDir, TELEGRAM_STATE_DIR: stateDir },
    encoding: 'utf8',
    timeout: WAIT_TIMEOUT_MS,
  })
  // Static imports are resolved before any top-level statement runs, so
  // reaching the token check means every module poller.ts imports was loaded.
  expect(result.stderr).toContain('TELEGRAM_BOT_TOKEN required')
  expect(result.stderr).not.toMatch(LOAD_FAILURE_RE)
  expect(result.status).toBe(EXIT_MISCONFIGURED)
  expect(readdirSync(stateDir)).toEqual([])
}, TEST_TIMEOUT_MS)

test.skipIf(!TSX_BIN)('tsx 下開關未設：poller 正常啟動並輪詢，核准路徑落到既有的 404，不建狀態檔', async () => {
  const run = await startUnderTsx({})
  const res = await fetch(`http://${LOOPBACK}:${run.port}/approvals/R1`)
  expect(res.status).toBe(404)
  expect(await res.text()).toBe('not found')
  expect(run.stderr.join('')).not.toMatch(LOAD_FAILURE_RE)
  expect(run.stderr.join('')).not.toContain('approval requests enabled')
  expect(readdirSync(join(run.rootDir, 'state')).sort()).toEqual(['access.json', 'poller.pid'])
}, TEST_TIMEOUT_MS)

test.skipIf(!TSX_BIN)('tsx 下開關開：路由掛載成立，建立 -> 按鈕 -> 查詢走得完', async () => {
  const run = await startUnderTsx({ TELEGRAM_APPROVAL_BUTTONS: '1' })
  const base = `http://${LOOPBACK}:${run.port}`
  const created = await fetch(`${base}/approvals`, {
    method: 'POST',
    body: JSON.stringify({ id: 'tsx-run-1', text: 't', kind: 'allow_deny' }),
  })
  expect(created.status).toBe(201)
  const sent = run.fake.callsOf('sendMessage')[0].params
  expect(sent.chat_id).toBe(U1)

  run.fake.inject({
    callback_query: {
      id: 'cb',
      chat_instance: 'x',
      data: 'appr:allow:tsx-run-1',
      from: { id: U1, is_bot: false, first_name: 'u' },
      // The fake numbers its messages from 1000.
      message: { message_id: 1000, date: 0, chat: { id: U1, type: 'private', first_name: 'u' } },
    },
  } as never)
  const status = async (): Promise<unknown> =>
    ((await (await fetch(`${base}/approvals/tsx-run-1`)).json()) as { status: unknown }).status
  await waitFor(async () => (await status()) === 'approved', 'the request to be approved', run.stderr)

  // The pre-existing routes still answer through the wrapped listener.
  expect((await fetch(`${base}/not-a-route`)).status).toBe(404)
}, TEST_TIMEOUT_MS)
