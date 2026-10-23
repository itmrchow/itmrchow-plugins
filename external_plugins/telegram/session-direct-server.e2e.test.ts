/**
 * Black-box tests for session-direct mode on the server side (JP-380): the REAL
 * server.ts process, driven over MCP stdio like Claude Code drives it, against
 * an in-test subscription hub and a fake Telegram Bot API.
 *
 * The server finds "its own claude process" by walking up from its parent —
 * here that parent is this test runner — and matching the session record.
 * So each world writes a session record for process.pid into a throwaway
 * CLAUDE_CONFIG_DIR, and a job record saying whether the session was started
 * with --channels (this runner's own argv never is).
 */
import { afterEach, expect, test } from 'bun:test'
import { type ChildProcess, spawn } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { FAKE_BOT_TOKEN, startFakeTelegram, type FakeTelegram } from './fake-telegram'
import { ScopeRegistry } from './poller-registry'
import { createSubscribeServer, type SubscribeHub } from './subscribe-server'
import type { InboundEnvelope } from './subscribe-protocol'

const USER_ID = 111
const HUB_SCOPE = `telegram-dm-${USER_ID}`
const CHANNEL_SPEC = 'plugin:telegram@itmrchow-plugins'
const SESSION_NAME = 'JP-412 [infra]: DB'
const LOOPBACK = '127.0.0.1'
const WAIT_TIMEOUT_MS = 10_000
const POLL_INTERVAL_MS = 25
/** The server holds its subscription READY_GRACE_MS (3s) after `initialized`; this is how long to wait to be sure it did not subscribe. */
const NO_SUBSCRIBE_WAIT_MS = 4500
const TEST_TIMEOUT_MS = 30_000
const FIRST_FAKE_MESSAGE_ID = 1000

type JsonRpc = { id?: number; method?: string; result?: Record<string, unknown>; params?: Record<string, unknown> }

type World = {
  rootDir: string
  homeDir: string
  configDir: string
  stateDir: string
  mapFile: string
  sessionId: string
  fake: FakeTelegram
  hub: SubscribeHub
  registry: ScopeRegistry
  subscribed: string[]
  server?: ChildProcess
  stdout: JsonRpc[]
  stderr: string[]
  nextId: number
}

const worlds: World[] = []

afterEach(async () => {
  for (const world of worlds.splice(0)) {
    const server = world.server
    if (server && server.exitCode === null && server.signalCode === null) {
      const exited = new Promise<void>(r => server.once('exit', () => r()))
      server.kill('SIGKILL')
      await exited
    }
    world.hub.close()
    await world.fake.close()
    rmSync(world.rootDir, { recursive: true, force: true })
  }
})

const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))

async function waitFor<T>(probe: () => T | undefined | false, what: string): Promise<T> {
  const deadline = Date.now() + WAIT_TIMEOUT_MS
  for (;;) {
    const value = probe()
    if (value) return value
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await sleep(POLL_INTERVAL_MS)
  }
}

type WorldOpts = {
  /** Write the pointer file (switch on). Default true. */
  pointer?: boolean
  /** Job record lists --channels for this session. Default true. */
  channels?: boolean
  /** Put TELEGRAM_MESSAGE_MAP_FILE in the state .env. Default true. */
  mapSetting?: boolean
  /** Extra launch env for server.ts (e.g. AGENT_SCOPE for the hub), given the state dir. */
  env?: (stateDir: string) => Record<string, string>
  /** Extra access.json fields. */
  access?: Record<string, unknown>
  sessionId?: string
}

async function startWorld(opts: WorldOpts = {}): Promise<World> {
  const rootDir = mkdtempSync(join(tmpdir(), 'session-direct-server-e2e-'))
  const homeDir = join(rootDir, 'home')
  const configDir = join(rootDir, 'cfg')
  const stateDir = join(rootDir, 'state')
  const mapDir = join(rootDir, 'map')
  const mapFile = join(mapDir, 'message-map.jsonl')
  for (const dir of [join(homeDir, '.claude', 'channels'), join(configDir, 'sessions'), stateDir, mapDir]) {
    mkdirSync(dir, { recursive: true })
  }
  const sessionId = opts.sessionId ?? randomUUID()

  const registry = new ScopeRegistry({ maxScopes: 10, maxQueue: 10 })
  const subscribed: string[] = []
  const hub = createSubscribeServer({ registry, onSubscribe: scopeId => void subscribed.push(scopeId) })
  await new Promise<void>(r => hub.server.listen(0, LOOPBACK, r))
  const hubPort = (hub.server.address() as { port: number }).port
  const fake = await startFakeTelegram()

  writeFileSync(
    join(stateDir, '.env'),
    [
      `TELEGRAM_BOT_TOKEN=${FAKE_BOT_TOKEN}`,
      `TELEGRAM_POLLER_PORT=${hubPort}`,
      `TELEGRAM_API_ROOT=${fake.apiRoot}`,
      ...(opts.mapSetting === false ? [] : [`TELEGRAM_MESSAGE_MAP_FILE=${mapFile}`]),
    ].join('\n') + '\n',
  )
  writeFileSync(
    join(stateDir, 'access.json'),
    JSON.stringify({ dmPolicy: 'allowlist', allowFrom: [String(USER_ID)], groups: {}, pending: {}, ...opts.access }),
  )
  if (opts.pointer !== false) {
    writeFileSync(
      join(homeDir, '.claude', 'channels', 'telegram-session-direct.json'),
      JSON.stringify({ enabled: true, stateDir }),
    )
  }
  writeFileSync(join(configDir, 'sessions', `${process.pid}.json`), JSON.stringify({ pid: process.pid, sessionId, name: SESSION_NAME }))
  mkdirSync(join(configDir, 'jobs', 'job1'), { recursive: true })
  writeFileSync(
    join(configDir, 'jobs', 'job1', 'state.json'),
    JSON.stringify({
      sessionId,
      resumeSessionId: sessionId,
      respawnFlags: opts.channels === false ? ['--name', 'x'] : ['--name', 'x', '--channels', CHANNEL_SPEC],
    }),
  )

  const world: World = {
    rootDir, homeDir, configDir, stateDir, mapFile, sessionId, fake, hub, registry, subscribed,
    stdout: [], stderr: [], nextId: 1,
  }
  worlds.push(world)

  const server = spawn(process.execPath, ['server.ts'], {
    cwd: import.meta.dir,
    env: {
      PATH: process.env.PATH ?? '',
      HOME: homeDir,
      CLAUDE_CONFIG_DIR: configDir,
      CLAUDE_CODE_SESSION_ID: sessionId,
      CLAUDE_PLUGIN_ROOT: join(rootDir, 'plugins', 'cache', 'itmrchow-plugins', 'telegram', '0.12.0'),
      AGENT_RESTART_STATE_DIR: join(rootDir, 'agent-restart'),
      INVITES_FILE: join(rootDir, 'invites.json'),
      ...opts.env?.(stateDir),
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  let buffered = ''
  server.stdout?.on('data', (chunk: Buffer) => {
    buffered += chunk.toString()
    let newline = buffered.indexOf('\n')
    while (newline !== -1) {
      const line = buffered.slice(0, newline).trim()
      buffered = buffered.slice(newline + 1)
      if (line) world.stdout.push(JSON.parse(line) as JsonRpc)
      newline = buffered.indexOf('\n')
    }
  })
  server.stderr?.on('data', (chunk: Buffer) => world.stderr.push(chunk.toString()))
  world.server = server
  return world
}

function send(world: World, message: Record<string, unknown>): void {
  world.server?.stdin?.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`)
}

async function rpc(world: World, method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
  const id = world.nextId++
  send(world, { id, method, params })
  const reply = await waitFor(() => world.stdout.find(message => message.id === id), `${method} reply`)
  return reply.result ?? {}
}

/** Do the MCP handshake; returns the server's declared capabilities. */
async function initialize(world: World): Promise<Record<string, unknown>> {
  const result = await rpc(world, 'initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'e2e', version: '0' },
  })
  send(world, { method: 'notifications/initialized' })
  return result.capabilities as Record<string, unknown>
}

const sessionScopeOf = (sessionId: string): string => `telegram-dm-s${sessionId.replace(/-/g, '')}`

const stderrOf = (world: World): string => world.stderr.join('')

const mapLines = (world: World): Record<string, unknown>[] =>
  existsSync(world.mapFile)
    ? readFileSync(world.mapFile, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l) as Record<string, unknown>)
    : []

async function reply(world: World, text: string): Promise<Record<string, unknown>> {
  return rpc(world, 'tools/call', { name: 'reply', arguments: { chat_id: String(USER_ID), text } })
}

test('直送模式：以專屬 scope 訂閱，不宣告權限 relay，同 session id 兩次啟動 scope 相同', async () => {
  const sessionId = randomUUID()
  for (let run = 0; run < 2; run++) {
    const world = await startWorld({ sessionId })
    const capabilities = await initialize(world)
    const experimental = capabilities.experimental as Record<string, unknown>
    expect(Object.keys(experimental)).toEqual(['claude/channel'])
    await waitFor(() => world.subscribed.length > 0, 'session-direct subscription')
    expect(world.subscribed).toEqual([sessionScopeOf(sessionId)])
    expect(world.subscribed).not.toContain(HUB_SCOPE)
  }
}, TEST_TIMEOUT_MS)

test('不同 session id -> 不同專屬 scope', async () => {
  const a = await startWorld()
  const b = await startWorld()
  await Promise.all([initialize(a), initialize(b)])
  await waitFor(() => a.subscribed.length > 0 && b.subscribed.length > 0, 'both subscriptions')
  expect(a.subscribed[0]).not.toBe(b.subscribed[0])
}, TEST_TIMEOUT_MS)

test('沒帶 --channels：不訂閱，stderr 說明原因', async () => {
  const world = await startWorld({ channels: false })
  await initialize(world)
  await sleep(NO_SUBSCRIBE_WAIT_MS)
  expect(world.subscribed).toEqual([])
  expect(stderrOf(world)).toContain('session-direct not subscribing (session not started with --channels')
}, TEST_TIMEOUT_MS)

test('判斷不了（找不到自己的 session 記錄）：不訂閱', async () => {
  const world = await startWorld()
  rmSync(join(world.configDir, 'sessions', `${process.pid}.json`))
  await initialize(world)
  await sleep(NO_SUBSCRIBE_WAIT_MS)
  expect(world.subscribed).toEqual([])
  expect(stderrOf(world)).toContain('own claude process not found')
}, TEST_TIMEOUT_MS)

test('開關未設（沒有指標檔）：照現行（預設 state 目錄沒有 token -> 退出），不訂閱任何 scope', async () => {
  const world = await startWorld({ pointer: false })
  await waitFor(() => typeof world.server?.exitCode === 'number', 'server exit')
  expect(stderrOf(world)).toContain('TELEGRAM_BOT_TOKEN required')
  expect(world.subscribed).toEqual([])
  expect(mapLines(world)).toEqual([])
}, TEST_TIMEOUT_MS)

test('中控（有 AGENT_SCOPE）：只訂閱 AGENT_SCOPE、仍宣告權限 relay；reply 不寫 map', async () => {
  const world = await startWorld({ env: stateDir => ({ AGENT_SCOPE: HUB_SCOPE, TELEGRAM_STATE_DIR: stateDir }) })
  const capabilities = await initialize(world)
  expect(Object.keys(capabilities.experimental as Record<string, unknown>).sort()).toEqual([
    'claude/channel',
    'claude/channel/permission',
  ])
  await waitFor(() => world.subscribed.length > 0, 'hub subscription')
  await sleep(500)
  expect(world.subscribed).toEqual([HUB_SCOPE])
  expect(stderrOf(world)).not.toContain('session-direct')

  const result = await reply(world, 'hub 的回覆')
  expect(JSON.stringify(result)).toContain('sent (id: ')
  expect(mapLines(world)).toEqual([])
}, TEST_TIMEOUT_MS)

test('直送模式 reply：每則送出的訊息都寫進 map（四欄位、session_id = 本 session）', async () => {
  const world = await startWorld({ access: { textChunkLimit: 5 } })
  await initialize(world)
  await waitFor(() => world.subscribed.length > 0, 'subscription')

  const result = await reply(world, '0123456789AB')
  expect(JSON.stringify(result)).toContain('sent 3 parts')
  const sentIds = world.fake.callsOf('sendMessage').map((_, i) => FIRST_FAKE_MESSAGE_ID + i)
  expect(mapLines(world)).toEqual(
    sentIds.map(messageId => ({
      message_id: messageId,
      session_id: world.sessionId,
      session_name: SESSION_NAME,
      sent_at: expect.any(Number),
    })),
  )
}, TEST_TIMEOUT_MS)

test('直送模式 edit_message：不寫 map', async () => {
  const world = await startWorld()
  await initialize(world)
  await rpc(world, 'tools/call', { name: 'edit_message', arguments: { chat_id: String(USER_ID), message_id: '1000', text: 'x' } })
  expect(world.fake.callsOf('editMessageText').length).toBe(1)
  expect(mapLines(world)).toEqual([])
}, TEST_TIMEOUT_MS)

test('map 寫不進去：reply 照常成功、訊息照常送出、stderr 記一筆；恢復可寫後下一次照常寫', async () => {
  const world = await startWorld()
  await initialize(world)
  const mapDir = join(world.rootDir, 'map')
  chmodSync(mapDir, 0o500)
  try {
    const failed = await reply(world, '寫不進 map')
    expect(JSON.stringify(failed)).toContain('sent (id: ')
    expect((failed as { isError?: boolean }).isError).toBeUndefined()
    expect(world.fake.callsOf('sendMessage').length).toBe(1)
    await waitFor(() => stderrOf(world).includes('could not record 1 sent message(s)'), 'map write failure log')
  } finally {
    chmodSync(mapDir, 0o700)
  }
  await reply(world, '恢復')
  expect(mapLines(world).map(line => line.message_id)).toEqual([FIRST_FAKE_MESSAGE_ID + 1])
}, TEST_TIMEOUT_MS)

test('直送模式但 state .env 沒設 map 路徑：reply 照常、不寫 map、啟動時說明', async () => {
  const world = await startWorld({ mapSetting: false })
  await initialize(world)
  const result = await reply(world, 'x')
  expect(JSON.stringify(result)).toContain('sent (id: ')
  expect(mapLines(world)).toEqual([])
  expect(stderrOf(world)).toContain('session-direct not recording sent messages')
}, TEST_TIMEOUT_MS)

test('直送進來的訊息：channel 通知帶 session_name（顯示形式），且不帶 AGENT_SCOPE 頂掉中控', async () => {
  const world = await startWorld()
  await initialize(world)
  const scopeId = await waitFor(() => world.subscribed[0], 'subscription')
  const envelope: InboundEnvelope = {
    envelopeId: randomUUID(),
    scopeId,
    platform: 'telegram',
    ts: Date.now(),
    botInfo: { id: 123456, is_bot: true, first_name: 'fake', username: 'fake_test_bot' },
    payload: {
      update_id: 1,
      message: {
        message_id: 9001,
        date: 0,
        text: '繼續跑',
        from: { id: USER_ID, is_bot: false, first_name: 'u', username: 'jeff' },
        chat: { id: USER_ID, type: 'private', first_name: 'u' },
        reply_to_message: {
          message_id: 3332,
          date: 0,
          text: '[等你] x: 要繼續嗎？',
          from: { id: 123456, is_bot: true, first_name: 'fake', username: 'fake_test_bot' },
          chat: { id: USER_ID, type: 'private', first_name: 'u' },
        },
      },
    },
  }
  expect(world.hub.deliver(scopeId, [envelope])).toBe(true)
  const notification = await waitFor(
    () => world.stdout.find(message => message.method === 'notifications/claude/channel'),
    'channel notification',
  )
  const params = notification.params as { content: string; meta: Record<string, string> }
  expect(params.content).toBe('繼續跑')
  expect(params.meta.session_name).toBe('JP-412 ［infra］： DB')
  expect(params.meta.reply_to_message_id).toBe('3332')
  expect(world.subscribed).not.toContain(HUB_SCOPE)
}, TEST_TIMEOUT_MS)

test('直送模式 server 不論訂閱成功與否、poller 在不在，都不自己呼叫 getUpdates', async () => {
  const subscribedWorld = await startWorld()
  const unsubscribedWorld = await startWorld({ channels: false })
  // No poller at all: point the subscription at a port nothing listens on.
  const pollerlessWorld = await startWorld()
  pollerlessWorld.hub.close()
  await Promise.all([initialize(subscribedWorld), initialize(unsubscribedWorld), initialize(pollerlessWorld)])
  await waitFor(() => subscribedWorld.subscribed.length > 0, 'subscription')
  await sleep(NO_SUBSCRIBE_WAIT_MS)
  await reply(subscribedWorld, 'x')
  for (const world of [subscribedWorld, unsubscribedWorld, pollerlessWorld]) {
    expect(world.fake.getUpdatesCount()).toBe(0)
  }
  expect(stderrOf(pollerlessWorld)).toContain('subscription lost')
}, TEST_TIMEOUT_MS)
