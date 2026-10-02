/**
 * Black-box tests for approval requests (JP-315): the REAL poller process,
 * a fake Telegram Bot API, and the loopback interface — nothing in-process.
 *
 * No real token and no real Telegram: the poller is pointed at fake-telegram.ts
 * through TELEGRAM_API_ROOT, with a throwaway state directory.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { type ChildProcess, spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createServer, request as httpRequest } from 'node:http'
import { networkInterfaces, tmpdir } from 'node:os'
import { join } from 'node:path'
import { FAKE_BOT_ID, FAKE_BOT_TOKEN, startFakeTelegram, type FakeTelegram, type RecordedCall } from './fake-telegram'
import { createSseParser, type InboundEnvelope } from './subscribe-protocol'

const U1 = 111
const U2 = 222
const LOOPBACK = '127.0.0.1'
const WAIT_TIMEOUT_MS = 5000
const POLL_INTERVAL_MS = 20
const SHORT_TIMEOUT_SECONDS = 0.4
const LONG_TIMEOUT_SECONDS = 60
const TEST_TIMEOUT_MS = 20_000
const SWITCH_ON = '1'
const EXTERNAL_ADDRESS = Object.values(networkInterfaces())
  .flat()
  .find(iface => iface && iface.family === 'IPv4' && !iface.internal)?.address
const FIRST_FAKE_MESSAGE_ID = 1000

type Json = Record<string, unknown>
type Reply = { status: number; body: Json | string }

type World = {
  fake: FakeTelegram
  /** Throwaway root holding the state dir and a separate, empty HOME. */
  rootDir: string
  stateDir: string
  homeDir: string
  port: number
  poller?: ChildProcess
  stderr: string[]
}

const worlds: World[] = []

afterEach(async () => {
  for (const world of worlds.splice(0)) {
    await stopPoller(world, 'SIGKILL')
    await world.fake.close()
    rmSync(world.rootDir, { recursive: true, force: true })
  }
})

const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))

async function waitFor<T>(probe: () => T | undefined | false | Promise<T | undefined | false>, what: string): Promise<T> {
  const deadline = Date.now() + WAIT_TIMEOUT_MS
  for (;;) {
    const value = await probe()
    if (value) return value
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await sleep(POLL_INTERVAL_MS)
  }
}

async function freePort(): Promise<number> {
  const server = createServer()
  await new Promise<void>(r => server.listen(0, LOOPBACK, r))
  const { port } = server.address() as { port: number }
  await new Promise<void>(r => server.close(() => r()))
  return port
}

async function call(world: World, method: string, path: string, body?: unknown, host = LOOPBACK): Promise<Reply> {
  const res = await fetch(`http://${host}:${world.port}${path}`, {
    method,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await res.text()
  try {
    return { status: res.status, body: JSON.parse(text) as Json }
  } catch {
    return { status: res.status, body: text }
  }
}

async function startPoller(world: World, env: Record<string, string> = {}): Promise<void> {
  // A minimal environment on purpose: nothing from the developer's shell
  // (REAUTH_BIN, SCOPE_SPAWN_BIN, a real token) may leak into the poller.
  const poller = spawn(process.execPath, ['poller.ts'], {
    cwd: import.meta.dir,
    env: {
      PATH: process.env.PATH ?? '',
      HOME: world.homeDir,
      TELEGRAM_STATE_DIR: world.stateDir,
      TELEGRAM_BOT_TOKEN: FAKE_BOT_TOKEN,
      TELEGRAM_API_ROOT: world.fake.apiRoot,
      TELEGRAM_POLLER_PORT: String(world.port),
      ...env,
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  })
  poller.stderr?.on('data', (chunk: Buffer) => world.stderr.push(chunk.toString()))
  world.poller = poller
  await waitFor(() => world.stderr.join('').includes('polling as @'), 'poller to start polling')
  await waitFor(async () => (await call(world, 'GET', '/healthcheck-not-a-route').catch(() => undefined))?.status === 404, 'poller port')
}

async function stopPoller(world: World, signal: NodeJS.Signals = 'SIGTERM'): Promise<void> {
  const poller = world.poller
  if (!poller || poller.exitCode !== null || poller.signalCode !== null) return
  const exited = new Promise<void>(r => poller.once('exit', () => r()))
  poller.kill(signal)
  await exited
  world.poller = undefined
}

async function startWorld(env: Record<string, string> = { TELEGRAM_APPROVAL_BUTTONS: SWITCH_ON }): Promise<World> {
  const rootDir = mkdtempSync(join(tmpdir(), 'approval-e2e-'))
  const stateDir = join(rootDir, 'state')
  const homeDir = join(rootDir, 'home')
  mkdirSync(stateDir)
  mkdirSync(homeDir)
  writeFileSync(
    join(stateDir, 'access.json'),
    JSON.stringify({ dmPolicy: 'allowlist', allowFrom: [String(U1)], groups: {}, pending: {} }),
  )
  const world: World = { fake: await startFakeTelegram(), rootDir, stateDir, homeDir, port: await freePort(), stderr: [] }
  worlds.push(world)
  await startPoller(world, env)
  return world
}

const restartEnv = { TELEGRAM_APPROVAL_BUTTONS: SWITCH_ON }

type Created = { messageId: number; text: string; keyboard: { text: string; callback_data: string }[] }

async function create(world: World, id: string, kind = 'allow_deny', extra: Json = {}): Promise<Created> {
  const before = world.fake.callsOf('sendMessage').length
  const text = `請求 ${id}`
  const res = await call(world, 'POST', '/approvals', { id, text, kind, timeout_seconds: LONG_TIMEOUT_SECONDS, ...extra })
  expect(res.status).toBe(201)
  const sent = world.fake.callsOf('sendMessage')[before]
  const markup = sent.params.reply_markup as { inline_keyboard: Created['keyboard'][] }
  // The fake hands out message ids in send order, starting at FIRST_FAKE_MESSAGE_ID.
  return { messageId: FIRST_FAKE_MESSAGE_ID + before, text, keyboard: markup.inline_keyboard[0] }
}

const statusOf = async (world: World, id: string): Promise<Json> => {
  const res = await call(world, 'GET', `/approvals/${id}`)
  return res.body as Json
}

function pressButton(world: World, data: string, fromId: number, messageId: number, chatId = U1): number {
  return world.fake.inject({
    callback_query: {
      id: `cb-${Math.random()}`,
      chat_instance: 'x',
      data,
      from: { id: fromId, is_bot: false, first_name: 'u' },
      message: { message_id: messageId, date: 0, chat: { id: chatId, type: 'private', first_name: 'u' } },
    },
  } as never)
}

function sendDm(
  world: World,
  fromId: number,
  text: string,
  opts: { replyTo?: number; isBot?: boolean; chatId?: number } = {},
): number {
  const chatId = opts.chatId ?? fromId
  return world.fake.inject({
    message: {
      message_id: Math.floor(Math.random() * 1e6) + 5000,
      date: 0,
      text,
      from: { id: fromId, is_bot: opts.isBot ?? false, first_name: 'u' },
      chat: { id: chatId, type: 'private', first_name: 'u' },
      ...(opts.replyTo === undefined
        ? {}
        : { reply_to_message: { message_id: opts.replyTo, date: 0, chat: { id: chatId, type: 'private', first_name: 'u' } } }),
    },
  } as never)
}

const drained = (world: World): Promise<true> =>
  waitFor(() => world.fake.unconfirmed() === 0 && (true as const), 'poller to consume injected updates')

const edits = (world: World, messageId: number): RecordedCall[] =>
  world.fake.callsOf('editMessageText').filter(c => c.params.message_id === messageId)

const lastEdit = (world: World, messageId: number): Json | undefined => edits(world, messageId).at(-1)?.params

/** Subscribe as a session would, and collect what the poller routes to it. */
function subscribe(world: World, scopeId: string): { envelopes: InboundEnvelope[]; stop: () => void } {
  const envelopes: InboundEnvelope[] = []
  const req = httpRequest({ host: LOOPBACK, port: world.port, path: `/subscribe?scope=${scopeId}` }, res => {
    res.setEncoding('utf8')
    res.on('data', createSseParser(envelope => void envelopes.push(envelope)))
  })
  req.on('error', () => {})
  req.end()
  return { envelopes, stop: () => req.destroy() }
}

const routedTexts = (envelopes: InboundEnvelope[]): (string | undefined)[] =>
  envelopes.map(e => (e.payload as { message?: { text?: string } }).message?.text)

describe('開關', () => {
  test('A-3 開關未設：三個動作都失敗、不發按鈕、不建狀態檔', async () => {
    const world = await startWorld({})
    const body = { id: 'R1', text: 't', kind: 'allow_deny' }
    expect(await call(world, 'POST', '/approvals', body)).toEqual({ status: 404, body: 'not found' })
    expect(await call(world, 'GET', '/approvals/R1')).toEqual({ status: 404, body: 'not found' })
    expect(await call(world, 'POST', '/approvals/R1/cancel')).toEqual({ status: 404, body: 'not found' })
    expect(world.fake.callsOf('sendMessage')).toEqual([])
    expect(readdirSync(world.stateDir).sort()).toEqual(['access.json', 'poller.pid'])
    expect(world.stderr.join('')).not.toContain('approval')
  }, TEST_TIMEOUT_MS)

  test.each(['', '0', 'false', 'off'])('A-6 開關值 %p 視同未設', async value => {
    const world = await startWorld({ TELEGRAM_APPROVAL_BUTTONS: value })
    expect((await call(world, 'POST', '/approvals', { id: 'R1', text: 't', kind: 'allow_deny' })).status).toBe(404)
    expect(existsSync(join(world.stateDir, 'approvals.json'))).toBe(false)
  }, TEST_TIMEOUT_MS)

  test('開關未設：appr: 開頭的 callback 與回覆照舊路由給 session，poller 不回應也不改訊息', async () => {
    const world = await startWorld({})
    const session = subscribe(world, `telegram-dm-${U1}`)
    await waitFor(() => world.stderr.join('').includes('subscribed'), 'subscription')
    pressButton(world, 'appr:allow:R1', U1, 1000)
    sendDm(world, U1, '回覆', { replyTo: 1000 })
    await waitFor(() => session.envelopes.length === 2, 'both updates routed')
    expect(world.fake.callsOf('answerCallbackQuery')).toEqual([])
    expect(world.fake.callsOf('editMessageText')).toEqual([])
    expect(world.fake.callsOf('sendMessage')).toEqual([])
    session.stop()
  }, TEST_TIMEOUT_MS)

  // In-repo guard for A-2 ("switch unset = today's behaviour"): the complete
  // Bot API call log and the complete routed stream for a fixed update
  // sequence, pinned to what main produces. The one-off main-vs-branch diff
  // cannot live here (it needs a second checkout); this keeps its expectation.
  test('A-2 開關未設：固定 update 序列的完整 Bot API 呼叫記錄與轉給 session 的內容與現版相同', async () => {
    const world = await startWorld({})
    const session = subscribe(world, `telegram-dm-${U1}`)
    await waitFor(() => world.stderr.join('').includes('subscribed'), 'subscription')

    sendDm(world, U1, '一般 DM')
    sendDm(world, U1, '引用回覆', { replyTo: 1000 })
    pressButton(world, 'perm:allow:abcde', U1, 1000)
    pressButton(world, 'appr:allow:R1', U1, 1000)
    pressButton(world, 'anything', U1, 1000)
    sendDm(world, U2, '非 allowFrom 的 DM')
    sendDm(world, U1, '/reauth')
    await drained(world)
    await waitFor(() => session.envelopes.length === 6, 'six updates routed to the U1 session')
    await waitFor(() => world.fake.callsOf('sendMessage').length === 1, 'the not-configured notice to U2')

    // Everything from U1 reaches its session untouched and in order, callbacks
    // and /reauth (no REAUTH_BIN) included.
    const routed = session.envelopes.map(e => e.payload as { message?: { text?: string }; callback_query?: { data?: string } })
    expect(routed.map(p => p.message?.text ?? p.callback_query?.data)).toEqual([
      '一般 DM', '引用回覆', 'perm:allow:abcde', 'appr:allow:R1', 'anything', '/reauth',
    ])
    // The only Bot API traffic: the command menu at startup, and the
    // "not fully configured" notice to U2, who has no session and no spawn bin.
    expect(world.fake.calls.map(c => c.method)).toEqual(['setMyCommands', 'sendMessage'])
    expect(world.fake.calls[1].params).toEqual({ chat_id: U2, text: '服務未完整設定，請聯絡管理者。' })
    expect(readdirSync(world.stateDir).sort()).toEqual(['access.json', 'poller.pid'])
    session.stop()
  }, TEST_TIMEOUT_MS)

  test('開關未設：access.json 不存在也不影響啟動與路由（poller 不依賴它）', async () => {
    const world = await startWorld({})
    rmSync(join(world.stateDir, 'access.json'))
    const session = subscribe(world, `telegram-dm-${U1}`)
    await waitFor(() => world.stderr.join('').includes('subscribed'), 'subscription')
    sendDm(world, U1, '照常路由')
    await waitFor(() => session.envelopes.length === 1, 'routed')
    session.stop()
  }, TEST_TIMEOUT_MS)

  test('TELEGRAM_API_ROOT 有設時在 stderr 印警告', async () => {
    const world = await startWorld({})
    expect(world.stderr.join('')).toContain(`WARNING TELEGRAM_API_ROOT is set, Bot API calls go to ${world.fake.apiRoot}`)
  }, TEST_TIMEOUT_MS)

  test('A-5 開關開：一般 DM、引用回覆、perm: callback 照常路由，pending 請求不受影響', async () => {
    const world = await startWorld()
    const session = subscribe(world, `telegram-dm-${U1}`)
    await waitFor(() => world.stderr.join('').includes('subscribed'), 'subscription')
    const { messageId } = await create(world, 'R1', 'approve_reject')

    sendDm(world, U1, '一般訊息')
    sendDm(world, U1, '引用 bot 一般訊息', { replyTo: 4242 })
    sendDm(world, U1, '引用 pending 請求訊息', { replyTo: messageId })
    pressButton(world, 'perm:allow:abcde', U1, 4242)
    await waitFor(() => session.envelopes.length === 4, 'four updates routed')

    expect(routedTexts(session.envelopes).slice(0, 3)).toEqual(['一般訊息', '引用 bot 一般訊息', '引用 pending 請求訊息'])
    expect((session.envelopes[3].payload as { callback_query?: { data?: string } }).callback_query?.data).toBe('perm:allow:abcde')
    expect(world.fake.callsOf('answerCallbackQuery')).toEqual([])
    expect((await statusOf(world, 'R1')).status).toBe('pending')
    session.stop()
  }, TEST_TIMEOUT_MS)
})

describe('建立與按鈕', () => {
  test('B-1 / C-1 建立「允許 / 拒絕」-> pending -> U1 按允許 -> approved，訊息改為已允許且按鈕移除', async () => {
    const world = await startWorld()
    const { messageId, keyboard, text } = await create(world, 'R10')
    const sent = world.fake.callsOf('sendMessage')[0].params
    expect(sent.chat_id).toBe(U1)
    expect(sent.text).toBe(text)
    expect(sent.parse_mode).toBeUndefined()
    expect(keyboard).toEqual([
      { text: '允許', callback_data: 'appr:allow:R10' },
      { text: '拒絕', callback_data: 'appr:deny:R10' },
    ])
    expect(await statusOf(world, 'R10')).toMatchObject({ status: 'pending', decision: null })

    pressButton(world, 'appr:allow:R10', U1, messageId)
    await waitFor(async () => (await statusOf(world, 'R10')).status === 'approved', 'approved')
    expect(await statusOf(world, 'R10')).toMatchObject({ status: 'approved', decision: 'allow', comment: null })
    const edit = await waitFor(() => lastEdit(world, messageId), 'message edit')
    expect(edit.text).toBe(`${text}\n\n[已允許]`)
    expect(edit.reply_markup).toBeUndefined()
    expect(world.fake.callsOf('answerCallbackQuery')).toHaveLength(1)
  }, TEST_TIMEOUT_MS)

  test('B-2 / C-2 / C-3 「approve / 退回」按 approve；「允許 / 拒絕」按拒絕', async () => {
    const world = await startWorld()
    const r11 = await create(world, 'R11', 'approve_reject')
    expect(r11.keyboard).toEqual([
      { text: 'approve', callback_data: 'appr:approve:R11' },
      { text: '退回', callback_data: 'appr:reject:R11' },
    ])
    const r12 = await create(world, 'R12')
    pressButton(world, 'appr:approve:R11', U1, r11.messageId)
    pressButton(world, 'appr:deny:R12', U1, r12.messageId)
    await drained(world)
    expect(await statusOf(world, 'R11')).toMatchObject({ status: 'approved', decision: 'approve' })
    expect(await statusOf(world, 'R12')).toMatchObject({ status: 'denied', decision: 'deny', comment: null })
    expect(lastEdit(world, r11.messageId)?.text).toBe(`${r11.text}\n\n[已 approve]`)
    expect(lastEdit(world, r12.messageId)?.text).toBe(`${r12.text}\n\n[已拒絕]`)
  }, TEST_TIMEOUT_MS)

  test('B-3 欄位缺漏 / 不合法回 400、不發訊息、查無', async () => {
    const world = await startWorld()
    const bad: Json[] = [
      { text: 't', kind: 'allow_deny' },
      { id: 'bad', kind: 'allow_deny' },
      { id: 'bad', text: 't', kind: 'yes_no' },
      { id: 'bad id', text: 't', kind: 'allow_deny' },
    ]
    for (const body of bad) expect((await call(world, 'POST', '/approvals', body)).status).toBe(400)
    const malformed = await fetch(`http://${LOOPBACK}:${world.port}/approvals`, { method: 'POST', body: '{oops' })
    expect(malformed.status).toBe(400)
    expect(world.fake.callsOf('sendMessage')).toEqual([])
    expect((await call(world, 'GET', '/approvals/bad')).status).toBe(404)
  }, TEST_TIMEOUT_MS)

  test('B-4 重複 id 不覆寫既有請求', async () => {
    const world = await startWorld()
    const r3 = await create(world, 'R3')
    pressButton(world, 'appr:deny:R3', U1, r3.messageId)
    await drained(world)
    const again = await call(world, 'POST', '/approvals', { id: 'R3', text: 't', kind: 'allow_deny' })
    expect(again.status).toBe(409)
    expect(again.body).toMatchObject({ error: 'duplicate_id', request: { status: 'denied' } })
    expect((await statusOf(world, 'R3')).status).toBe('denied')

    await create(world, 'R4')
    const sentBefore = world.fake.callsOf('sendMessage').length
    expect((await call(world, 'POST', '/approvals', { id: 'R4', text: 't', kind: 'allow_deny' })).status).toBe(409)
    expect(world.fake.callsOf('sendMessage')).toHaveLength(sentBefore)
    expect((await statusOf(world, 'R4')).status).toBe('pending')
  }, TEST_TIMEOUT_MS)

  test('B-5 Telegram 發不出去：建立回 502，不留下 pending', async () => {
    const world = await startWorld()
    world.fake.failing.add('sendMessage')
    const res = await call(world, 'POST', '/approvals', { id: 'R5', text: 't', kind: 'allow_deny' })
    expect(res).toEqual({ status: 502, body: { error: 'telegram_send_failed' } })
    expect((await call(world, 'GET', '/approvals/R5')).status).toBe(404)
  }, TEST_TIMEOUT_MS)

  test('B-6 / B-7 特殊字元與長文原樣送出；超長文字與超長 id 在建立時被拒；最長 id 可走完', async () => {
    const world = await startWorld()
    const special = '< > & _ * [ ] ` \\ \n換行 中文'
    await call(world, 'POST', '/approvals', { id: 'S1', text: special, kind: 'allow_deny' })
    expect(world.fake.callsOf('sendMessage')[0].params.text).toBe(special)
    const long = '長'.repeat(3500)
    expect((await call(world, 'POST', '/approvals', { id: 'S2', text: long, kind: 'allow_deny' })).status).toBe(201)
    expect(world.fake.callsOf('sendMessage')[1].params.text).toBe(long)
    expect((await call(world, 'POST', '/approvals', { id: 'S3', text: '長'.repeat(3501), kind: 'allow_deny' })).status).toBe(400)

    const longest = 'L'.repeat(40)
    expect((await call(world, 'POST', '/approvals', { id: longest, text: 't', kind: 'approve_reject' })).status).toBe(201)
    const keyboard = (world.fake.callsOf('sendMessage')[2].params.reply_markup as { inline_keyboard: { callback_data: string }[][] }).inline_keyboard[0]
    for (const button of keyboard) expect(Buffer.byteLength(button.callback_data)).toBeLessThanOrEqual(64)
    pressButton(world, keyboard[0].callback_data, U1, 1002)
    await drained(world)
    expect((await statusOf(world, longest)).status).toBe('approved')
    expect((await call(world, 'POST', '/approvals', { id: 'L'.repeat(41), text: 't', kind: 'allow_deny' })).status).toBe(400)
  }, TEST_TIMEOUT_MS)

  test('C-4 非 allowFrom 的人按按鈕無效（即使 callback 掛在 U1 的 chat 與該則訊息上）', async () => {
    const world = await startWorld()
    const { messageId } = await create(world, 'R12')
    pressButton(world, 'appr:allow:R12', U2, messageId, U1)
    await drained(world)
    expect((await statusOf(world, 'R12')).status).toBe('pending')
    expect(edits(world, messageId)).toEqual([])

    pressButton(world, 'appr:deny:R12', U1, messageId)
    await drained(world)
    expect((await statusOf(world, 'R12')).status).toBe('denied')
  }, TEST_TIMEOUT_MS)

  test('C-5 偽造 / 不相符的 callback data 不改狀態，poller 之後仍正常收訊', async () => {
    const world = await startWorld()
    const r13 = await create(world, 'R13')
    const other = await create(world, 'OTHER')
    pressButton(world, 'appr:allow:NOPE', U1, r13.messageId)
    pressButton(world, 'appr:::', U1, r13.messageId)
    pressButton(world, 'appr:approve:R13', U1, r13.messageId)
    pressButton(world, 'appr:allow:R13', U1, other.messageId)
    pressButton(world, 'appr:allow:R13', U1, 31337)
    await drained(world)
    expect((await statusOf(world, 'R13')).status).toBe('pending')
    expect((await statusOf(world, 'OTHER')).status).toBe('pending')
    expect(world.fake.callsOf('editMessageText')).toEqual([])
    expect(world.fake.callsOf('answerCallbackQuery')).toHaveLength(5)

    pressButton(world, 'appr:allow:R13', U1, r13.messageId)
    await drained(world)
    expect((await statusOf(world, 'R13')).status).toBe('approved')
  }, TEST_TIMEOUT_MS)

  test('C-6 / C-7 已有結果後再按不翻盤；多筆並行互不干擾', async () => {
    const world = await startWorld()
    const r14 = await create(world, 'R14')
    const r15 = await create(world, 'R15')
    const r16 = await create(world, 'R16')
    pressButton(world, 'appr:deny:R14', U1, r14.messageId)
    pressButton(world, 'appr:allow:R14', U1, r14.messageId)
    pressButton(world, 'appr:allow:R15', U1, r15.messageId)
    pressButton(world, 'appr:deny:R15', U1, r15.messageId)
    await drained(world)
    expect(await statusOf(world, 'R14')).toMatchObject({ status: 'denied', decision: 'deny' })
    expect(await statusOf(world, 'R15')).toMatchObject({ status: 'approved', decision: 'allow' })
    expect((await statusOf(world, 'R16')).status).toBe('pending')
    expect(edits(world, r16.messageId)).toEqual([])
    expect(edits(world, r14.messageId)).toHaveLength(1)
    expect(world.fake.callsOf('answerCallbackQuery')).toHaveLength(4)
  }, TEST_TIMEOUT_MS)

  test('C-8 改訊息失敗時結果仍記錄，poller 不崩潰', async () => {
    const world = await startWorld()
    const { messageId } = await create(world, 'R19')
    world.fake.failing.add('editMessageText')
    pressButton(world, 'appr:allow:R19', U1, messageId)
    await drained(world)
    expect((await statusOf(world, 'R19')).status).toBe('approved')
    expect(world.poller?.exitCode).toBeNull()
  }, TEST_TIMEOUT_MS)
})

describe('退回 + 意見', () => {
  test('D-1 按退回 -> 提示回覆 -> 回覆後為退回 + 意見；該回覆不轉給 session', async () => {
    const world = await startWorld()
    const session = subscribe(world, `telegram-dm-${U1}`)
    await waitFor(() => world.stderr.join('').includes('subscribed'), 'subscription')
    const { messageId, text } = await create(world, 'R20', 'approve_reject')
    pressButton(world, 'appr:reject:R20', U1, messageId)
    await drained(world)

    expect(await statusOf(world, 'R20')).toMatchObject({ status: 'awaiting_comment', decision: 'reject', comment: null })
    const prompt = world.fake.callsOf('sendMessage')[1].params
    expect(prompt.chat_id).toBe(U1)
    expect(prompt.text).toContain('回覆')
    expect(prompt.reply_markup).toEqual({ force_reply: true })
    expect((prompt.reply_parameters as Json).message_id).toBe(messageId)
    const promptId = 1001

    const comment = '範圍要再縮小，拿掉 X\n第二行 <tag> & "引號"'
    sendDm(world, U1, comment, { replyTo: promptId })
    sendDm(world, U1, '之後的一般訊息')
    await waitFor(() => session.envelopes.length === 1, 'the later DM to be routed')

    expect(await statusOf(world, 'R20')).toMatchObject({ status: 'denied', decision: 'reject', comment })
    expect(lastEdit(world, messageId)?.text).toBe(`${text}\n\n[已退回] 意見：${comment}`)
    expect(routedTexts(session.envelopes)).toEqual(['之後的一般訊息'])
    session.stop()
  }, TEST_TIMEOUT_MS)

  test('D-2 按退回後逾時未回覆 -> 無意見退回', async () => {
    const world = await startWorld()
    const { messageId, text } = await create(world, 'R21', 'approve_reject', { comment_timeout_seconds: SHORT_TIMEOUT_SECONDS })
    pressButton(world, 'appr:reject:R21', U1, messageId)
    await drained(world)
    await sleep(SHORT_TIMEOUT_SECONDS * 1000 + 100)
    expect(await statusOf(world, 'R21')).toMatchObject({ status: 'denied', decision: 'reject', comment: '' })
    await waitFor(() => lastEdit(world, messageId)?.text === `${text}\n\n[已退回]（無意見）`, 'no-comment edit')
  }, TEST_TIMEOUT_MS)

  test('D-3 / D-4 / D-5 非 allowFrom、bot 自身、未引用的 DM 都不算意見；按退回後改按 approve 無效', async () => {
    const world = await startWorld()
    const { messageId } = await create(world, 'R22', 'approve_reject')
    pressButton(world, 'appr:reject:R22', U1, messageId)
    await drained(world)
    const promptId = 1001

    sendDm(world, U2, 'U2 的假意見', { replyTo: promptId, chatId: U1 })
    sendDm(world, FAKE_BOT_ID, 'bot 的假意見', { replyTo: promptId, chatId: U1, isBot: true })
    sendDm(world, U1, '未引用的一般 DM')
    pressButton(world, 'appr:approve:R22', U1, messageId)
    await drained(world)
    expect(await statusOf(world, 'R22')).toMatchObject({ status: 'awaiting_comment', comment: null })

    sendDm(world, U1, '真正意見', { replyTo: promptId })
    await drained(world)
    expect(await statusOf(world, 'R22')).toMatchObject({ status: 'denied', decision: 'reject', comment: '真正意見' })
  }, TEST_TIMEOUT_MS)

  test('D-6 以貼圖回覆：不崩潰、繼續等文字意見，最終為退回', async () => {
    const world = await startWorld()
    const { messageId } = await create(world, 'R26', 'approve_reject')
    pressButton(world, 'appr:reject:R26', U1, messageId)
    await drained(world)
    world.fake.inject({
      message: {
        message_id: 7001,
        date: 0,
        sticker: { file_id: 's' },
        from: { id: U1, is_bot: false, first_name: 'u' },
        chat: { id: U1, type: 'private', first_name: 'u' },
        reply_to_message: { message_id: 1001, date: 0, chat: { id: U1, type: 'private', first_name: 'u' } },
      },
    } as never)
    await drained(world)
    expect((await statusOf(world, 'R26')).status).toBe('awaiting_comment')
    expect(world.fake.callsOf('sendMessage').at(-1)?.params.text).toBe('請用文字回覆意見。')
    sendDm(world, U1, '文字意見', { replyTo: 1001 })
    await drained(world)
    expect(await statusOf(world, 'R26')).toMatchObject({ status: 'denied', comment: '文字意見' })
  }, TEST_TIMEOUT_MS)

  test('等意見期間以 / 開頭的回覆不當意見、照常轉給 session', async () => {
    const world = await startWorld()
    const session = subscribe(world, `telegram-dm-${U1}`)
    await waitFor(() => world.stderr.join('').includes('subscribed'), 'subscription')
    const { messageId } = await create(world, 'R28', 'approve_reject')
    pressButton(world, 'appr:reject:R28', U1, messageId)
    await drained(world)
    sendDm(world, U1, '/restart', { replyTo: 1001 })
    await waitFor(() => session.envelopes.length === 1, '/restart routed')
    expect(routedTexts(session.envelopes)).toEqual(['/restart'])
    expect((await statusOf(world, 'R28')).status).toBe('awaiting_comment')
    session.stop()
  }, TEST_TIMEOUT_MS)

  test('意見逾時後才回覆提示訊息：不轉給 session、不改結果，回一句已結案', async () => {
    const world = await startWorld()
    const session = subscribe(world, `telegram-dm-${U1}`)
    await waitFor(() => world.stderr.join('').includes('subscribed'), 'subscription')
    const { messageId } = await create(world, 'R29', 'approve_reject', { comment_timeout_seconds: SHORT_TIMEOUT_SECONDS })
    pressButton(world, 'appr:reject:R29', U1, messageId)
    await drained(world)
    await sleep(SHORT_TIMEOUT_SECONDS * 1000 + 100)
    sendDm(world, U1, '遲到的意見', { replyTo: 1001 })
    sendDm(world, U1, '之後的一般訊息')
    await waitFor(() => session.envelopes.length === 1, 'the later DM to be routed')
    expect(routedTexts(session.envelopes)).toEqual(['之後的一般訊息'])
    expect(await statusOf(world, 'R29')).toMatchObject({ status: 'denied', comment: '' })
    expect(world.fake.callsOf('sendMessage').at(-1)?.params.text).toBe('這筆請求已經結案，這則意見沒有被記錄。')
    session.stop()
  }, TEST_TIMEOUT_MS)

  test('D-7 等意見期間被取消 -> cancelled，晚到的回覆不改結果', async () => {
    const world = await startWorld()
    const { messageId } = await create(world, 'R25', 'approve_reject')
    pressButton(world, 'appr:reject:R25', U1, messageId)
    await drained(world)
    expect((await call(world, 'POST', '/approvals/R25/cancel')).body).toMatchObject({ status: 'cancelled' })
    sendDm(world, U1, '晚到的意見', { replyTo: 1001 })
    await drained(world)
    expect(await statusOf(world, 'R25')).toMatchObject({ status: 'cancelled', decision: null, comment: null })
  }, TEST_TIMEOUT_MS)
})

describe('查詢 / 取消 / 逾時', () => {
  test('E-1 / E-2 / E-3 / E-4 查無、取消 pending、取消已有結果、重複取消', async () => {
    const world = await startWorld()
    expect(await call(world, 'GET', '/approvals/never')).toEqual({ status: 404, body: { error: 'not_found' } })
    expect((await call(world, 'POST', '/approvals/never/cancel')).status).toBe(404)

    const r30 = await create(world, 'R30')
    expect((await call(world, 'POST', '/approvals/R30/cancel')).body).toMatchObject({ status: 'cancelled' })
    expect((await statusOf(world, 'R30')).status).toBe('cancelled')
    expect(lastEdit(world, r30.messageId)).toMatchObject({ text: `${r30.text}\n\n[已在電腦處理]` })
    expect(lastEdit(world, r30.messageId)?.reply_markup).toBeUndefined()
    pressButton(world, 'appr:allow:R30', U1, r30.messageId)
    await drained(world)
    expect((await statusOf(world, 'R30')).status).toBe('cancelled')
    expect((await call(world, 'POST', '/approvals/R30/cancel')).status).toBe(200)
    expect(edits(world, r30.messageId)).toHaveLength(1)

    const r31 = await create(world, 'R31')
    pressButton(world, 'appr:allow:R31', U1, r31.messageId)
    await drained(world)
    expect((await call(world, 'POST', '/approvals/R31/cancel')).body).toMatchObject({ status: 'approved', decision: 'allow' })
    expect(edits(world, r31.messageId)).toHaveLength(1)
    expect(lastEdit(world, r31.messageId)?.text).toBe(`${r31.text}\n\n[已允許]`)
  }, TEST_TIMEOUT_MS)

  test('E-5 逾時：查詢為 expired、訊息標示已逾時，之後按允許無效', async () => {
    const world = await startWorld()
    const { messageId, text } = await create(world, 'R32', 'allow_deny', { timeout_seconds: SHORT_TIMEOUT_SECONDS })
    await sleep(SHORT_TIMEOUT_SECONDS * 1000 + 100)
    expect(await statusOf(world, 'R32')).toMatchObject({ status: 'expired', decision: null })
    await waitFor(() => lastEdit(world, messageId)?.text === `${text}\n\n[已逾時]`, 'expired edit')
    pressButton(world, 'appr:allow:R32', U1, messageId)
    await drained(world)
    expect((await statusOf(world, 'R32')).status).toBe('expired')
  }, TEST_TIMEOUT_MS)

  test('預設逾時可由環境變數調短（未帶 timeout_seconds 時）', async () => {
    const world = await startWorld({
      TELEGRAM_APPROVAL_BUTTONS: SWITCH_ON,
      TELEGRAM_APPROVAL_TIMEOUT_SECONDS: String(SHORT_TIMEOUT_SECONDS),
    })
    expect((await call(world, 'POST', '/approvals', { id: 'R33', text: 't', kind: 'allow_deny' })).status).toBe(201)
    await sleep(SHORT_TIMEOUT_SECONDS * 1000 + 100)
    expect((await statusOf(world, 'R33')).status).toBe('expired')
  }, TEST_TIMEOUT_MS)
})

describe('決定保管', () => {
  test('F-1 loopback 介面無法讓請求變成允許', async () => {
    const world = await startWorld()
    await create(world, 'R40')
    const smuggled = { status: 'approved', decision: 'allow', result: 'allow', comment: 'x' }

    const fresh = await call(world, 'POST', '/approvals', { id: 'R41', text: 't', kind: 'allow_deny', ...smuggled })
    expect(fresh.body).toMatchObject({ status: 'pending', decision: null })
    await call(world, 'POST', '/approvals', { id: 'R40', text: 't', kind: 'allow_deny', ...smuggled })

    for (const method of ['PUT', 'PATCH', 'DELETE', 'POST']) {
      expect((await call(world, method, '/approvals/R40', smuggled)).status).toBe(405)
    }
    await call(world, 'GET', '/approvals/R40?status=approved&decision=allow')
    for (const verb of ['decide', 'approve', 'allow', 'set', 'update', 'resolve', 'callback', 'press']) {
      expect((await call(world, 'POST', `/approvals/R40/${verb}`, smuggled)).status).toBe(404)
      expect((await call(world, 'POST', `/${verb}`, { id: 'R40', ...smuggled })).status).toBe(404)
    }
    await call(world, 'POST', '/ack', {
      envelopeId: 'x',
      scopeId: `telegram-dm-${U1}`,
      callback_query: { data: 'appr:allow:R40', from: { id: U1 } },
    })

    expect((await statusOf(world, 'R40')).status).toBe('pending')
    expect((await statusOf(world, 'R41')).status).toBe('pending')
  }, TEST_TIMEOUT_MS)

  // Skipped, visibly, on a machine with no non-loopback interface to connect from.
  test.skipIf(!EXTERNAL_ADDRESS)('F-2 只綁 127.0.0.1', async () => {
    const world = await startWorld()
    await expect(call(world, 'GET', '/approvals/R1', undefined, EXTERNAL_ADDRESS)).rejects.toThrow()
  }, TEST_TIMEOUT_MS)

  test('帶 Origin header 的請求（瀏覽器跨站）回 403，不發訊息', async () => {
    const world = await startWorld()
    const res = await fetch(`http://${LOOPBACK}:${world.port}/approvals`, {
      method: 'POST',
      headers: { origin: 'https://evil.example', 'content-type': 'text/plain' },
      body: JSON.stringify({ id: 'R43', text: 't', kind: 'allow_deny' }),
    })
    expect(res.status).toBe(403)
    expect(world.fake.callsOf('sendMessage')).toEqual([])
    expect((await call(world, 'GET', '/approvals/R43')).status).toBe(404)
  }, TEST_TIMEOUT_MS)

  test('F-3 狀態檔在 poller 狀態目錄、權限 0600，不落在舊決定檔目錄', async () => {
    const world = await startWorld()
    const { messageId } = await create(world, 'R42')
    pressButton(world, 'appr:allow:R42', U1, messageId)
    await drained(world)
    const stateFile = join(world.stateDir, 'approvals.json')
    expect(statSync(stateFile).mode & 0o777).toBe(0o600)
    expect(readdirSync(world.stateDir).sort()).toEqual(['access.json', 'approvals.json', 'poller.pid'])
    // HOME is a throwaway dir here, so a write to the legacy gate directory
    // (~/.claude/tg-notify/approve-gates/) would show up under it.
    expect(existsSync(join(world.homeDir, '.claude'))).toBe(false)
  }, TEST_TIMEOUT_MS)
})

describe('poller 重啟', () => {
  test('G-1 / G-2 正常重啟：pending 仍可完成，各種結果與意見保留', async () => {
    const world = await startWorld()
    const r50 = await create(world, 'R50')
    const r51 = await create(world, 'R51')
    const r52 = await create(world, 'R52', 'approve_reject')
    await create(world, 'R53')
    pressButton(world, 'appr:allow:R51', U1, r51.messageId)
    pressButton(world, 'appr:reject:R52', U1, r52.messageId)
    await drained(world)
    const promptId = 1004
    sendDm(world, U1, 'X', { replyTo: promptId })
    await drained(world)
    await call(world, 'POST', '/approvals/R53/cancel')

    await stopPoller(world)
    world.stderr.length = 0
    await startPoller(world, restartEnv)

    expect((await statusOf(world, 'R50')).status).toBe('pending')
    expect(await statusOf(world, 'R51')).toMatchObject({ status: 'approved', decision: 'allow' })
    expect(await statusOf(world, 'R52')).toMatchObject({ status: 'denied', decision: 'reject', comment: 'X' })
    expect((await statusOf(world, 'R53')).status).toBe('cancelled')

    pressButton(world, 'appr:allow:R50', U1, r50.messageId)
    await waitFor(async () => (await statusOf(world, 'R50')).status === 'approved', 'R50 approved after restart')
    // 採「保留結果」：重啟不重發按鈕。
    expect(world.fake.callsOf('sendMessage').filter(c => c.params.text === r50.text)).toHaveLength(1)
  }, TEST_TIMEOUT_MS)

  test('G-3 訊息已顯示已允許後 SIGKILL：重啟後結果仍為允許', async () => {
    const world = await startWorld()
    const { messageId } = await create(world, 'R54')
    pressButton(world, 'appr:allow:R54', U1, messageId)
    await waitFor(() => lastEdit(world, messageId), 'message shows the decision')
    await stopPoller(world, 'SIGKILL')
    world.stderr.length = 0
    await startPoller(world, restartEnv)
    expect(await statusOf(world, 'R54')).toMatchObject({ status: 'approved', decision: 'allow' })
  }, TEST_TIMEOUT_MS)

  test('G-4 停機期間按下的按鈕，重啟後處理', async () => {
    const world = await startWorld()
    const { messageId } = await create(world, 'R55')
    await stopPoller(world)
    pressButton(world, 'appr:allow:R55', U1, messageId)
    world.stderr.length = 0
    await startPoller(world, restartEnv)
    await waitFor(async () => (await statusOf(world, 'R55')).status === 'approved', 'R55 approved after restart')
  }, TEST_TIMEOUT_MS)

  test('G-5 停機期間跨過逾時點：重啟後為 expired，訊息改為已逾時', async () => {
    const world = await startWorld()
    const { messageId, text } = await create(world, 'R56', 'allow_deny', { timeout_seconds: SHORT_TIMEOUT_SECONDS })
    await stopPoller(world)
    await sleep(SHORT_TIMEOUT_SECONDS * 1000 + 100)
    world.stderr.length = 0
    await startPoller(world, restartEnv)
    expect((await statusOf(world, 'R56')).status).toBe('expired')
    await waitFor(() => lastEdit(world, messageId)?.text === `${text}\n\n[已逾時]`, 'expired edit after restart')
  }, TEST_TIMEOUT_MS)

  test('G-6 等意見中跨重啟：重啟後回覆意見仍記為退回 + 意見', async () => {
    const world = await startWorld()
    const { messageId } = await create(world, 'R57', 'approve_reject')
    pressButton(world, 'appr:reject:R57', U1, messageId)
    await drained(world)
    await stopPoller(world)
    world.stderr.length = 0
    await startPoller(world, restartEnv)
    expect((await statusOf(world, 'R57')).status).toBe('awaiting_comment')
    sendDm(world, U1, '重啟後的意見', { replyTo: 1001 })
    await waitFor(async () => (await statusOf(world, 'R57')).status === 'denied', 'R57 rejected after restart')
    expect((await statusOf(world, 'R57')).comment).toBe('重啟後的意見')
  }, TEST_TIMEOUT_MS)

  test.each([
    ['刪除', (file: string) => rmSync(file)],
    ['改成不合法內容', (file: string) => writeFileSync(file, '{"version":1,"requests":[{"id":"R58","status":"approved"}]}')],
  ])('G-7 狀態檔被%s：poller 正常啟動、原請求查無、可建立新請求', async (_name, damage) => {
    const world = await startWorld()
    await create(world, 'R58')
    await stopPoller(world)
    damage(join(world.stateDir, 'approvals.json'))
    world.stderr.length = 0
    await startPoller(world, restartEnv)
    expect((await call(world, 'GET', '/approvals/R58')).status).toBe(404)
    await create(world, 'R59')
    expect((await statusOf(world, 'R59')).status).toBe('pending')
  }, TEST_TIMEOUT_MS)

  test('access.json 不存在或損毀時沒有收件人：建立回 503，且任何人按按鈕都無效', async () => {
    const world = await startWorld()
    const { messageId } = await create(world, 'R60')
    writeFileSync(join(world.stateDir, 'access.json'), '{broken')
    expect(await call(world, 'POST', '/approvals', { id: 'R61', text: 't', kind: 'allow_deny' })).toEqual({
      status: 503,
      body: { error: 'no_recipient' },
    })
    pressButton(world, 'appr:allow:R60', U1, messageId)
    await drained(world)
    expect((await statusOf(world, 'R60')).status).toBe('pending')
  }, TEST_TIMEOUT_MS)
})
