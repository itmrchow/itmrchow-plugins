/**
 * Black-box tests for session-direct routing (JP-380): the REAL poller process,
 * a fake Telegram Bot API, and SSE subscribers standing in for the hub and a
 * task session — nothing in-process.
 */
import { afterEach, expect, test } from 'bun:test'
import { type ChildProcess, spawn } from 'node:child_process'
import { appendFileSync, chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, request } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Update } from 'grammy/types'
import { FAKE_BOT_ID, FAKE_BOT_TOKEN, startFakeTelegram, type FakeTelegram } from './fake-telegram'
import { createSseParser, type InboundEnvelope } from './subscribe-protocol'

const USER_ID = 111
const HUB_SCOPE = `telegram-dm-${USER_ID}`
const SESSION_ID = 'ce12d202-2bf1-4502-bef0-8967233bd2d9'
const SESSION_SCOPE = 'telegram-dm-sce12d2022bf14502bef08967233bd2d9'
const OTHER_SESSION_SCOPE = 'telegram-dm-s00000000000040008000000000000001'
const MAPPED_MESSAGE_ID = 3332
/** The fake Bot API numbers the messages the poller sends from here. */
const FIRST_SENT_ID = 1000
const LOOPBACK = '127.0.0.1'
const WAIT_TIMEOUT_MS = 5000
const POLL_INTERVAL_MS = 20
const SETTLE_MS = 300
const TEST_TIMEOUT_MS = 20_000
const HTTP_OK = 200
const HTTP_REFUSED = 503

type Subscriber = { status: number; got: InboundEnvelope[]; stop: () => void }

type World = {
  fake: FakeTelegram
  rootDir: string
  stateDir: string
  mapFile: string
  port: number
  poller?: ChildProcess
  stderr: string[]
  subscribers: Subscriber[]
}

const worlds: World[] = []

afterEach(async () => {
  for (const world of worlds.splice(0)) {
    for (const sub of world.subscribers) sub.stop()
    const poller = world.poller
    if (poller && poller.exitCode === null && poller.signalCode === null) {
      const exited = new Promise<void>(r => poller.once('exit', () => r()))
      poller.kill('SIGKILL')
      await exited
    }
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

async function freePort(): Promise<number> {
  const server = createServer()
  await new Promise<void>(r => server.listen(0, LOOPBACK, r))
  const { port } = server.address() as { port: number }
  await new Promise<void>(r => server.close(() => r()))
  return port
}

async function startWorld(opts: { direct: boolean; env?: Record<string, string> }): Promise<World> {
  const rootDir = mkdtempSync(join(tmpdir(), 'session-direct-e2e-'))
  const stateDir = join(rootDir, 'state')
  const homeDir = join(rootDir, 'home')
  mkdirSync(stateDir)
  mkdirSync(homeDir)
  writeFileSync(
    join(stateDir, 'access.json'),
    JSON.stringify({ dmPolicy: 'allowlist', allowFrom: [String(USER_ID)], groups: {}, pending: {} }),
  )
  const mapFile = join(rootDir, 'message-map.jsonl')
  writeFileSync(mapFile, `${JSON.stringify({ message_id: MAPPED_MESSAGE_ID, session_id: SESSION_ID, session_name: 't', sent_at: 1 })}\n`)
  const world: World = {
    fake: await startFakeTelegram(),
    rootDir,
    stateDir,
    mapFile,
    port: await freePort(),
    stderr: [],
    subscribers: [],
  }
  worlds.push(world)
  const poller = spawn(process.execPath, ['poller.ts'], {
    cwd: import.meta.dir,
    env: {
      PATH: process.env.PATH ?? '',
      HOME: homeDir,
      TELEGRAM_STATE_DIR: stateDir,
      TELEGRAM_BOT_TOKEN: FAKE_BOT_TOKEN,
      TELEGRAM_API_ROOT: world.fake.apiRoot,
      TELEGRAM_POLLER_PORT: String(world.port),
      ...(opts.direct ? { TELEGRAM_SESSION_DIRECT: '1', TELEGRAM_MESSAGE_MAP_FILE: mapFile } : {}),
      ...opts.env,
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  })
  poller.stderr?.on('data', (chunk: Buffer) => world.stderr.push(chunk.toString()))
  world.poller = poller
  await waitFor(() => world.stderr.join('').includes('polling as @'), 'poller to start polling')
  return world
}

const subscribedLines = (world: World, scopeId: string): number =>
  world.stderr.join('').split(`telegram poller: ${scopeId} subscribed`).length - 1

/**
 * Subscribe like server.ts does, acking every envelope. Resolves on a refusal,
 * or once the poller logs the subscription: an SSE 200 carries no body until
 * the first frame, so its headers may not arrive before then.
 */
async function subscribe(world: World, scopeId: string): Promise<Subscriber> {
  const before = subscribedLines(world, scopeId)
  const got: InboundEnvelope[] = []
  const sub: Subscriber = { status: 0, got, stop: () => {} }
  world.subscribers.push(sub)
  const req = request({ host: LOOPBACK, port: world.port, path: `/subscribe?scope=${scopeId}` }, res => {
    sub.status = res.statusCode ?? 0
    if (sub.status !== HTTP_OK) {
      res.resume()
      return
    }
    res.setEncoding('utf8')
    res.on('data', createSseParser(envelope => {
      got.push(envelope)
      const body = JSON.stringify({ envelopeId: envelope.envelopeId, scopeId })
      request({ host: LOOPBACK, port: world.port, path: '/ack', method: 'POST' }).on('error', () => {}).end(body)
    }))
  })
  req.on('error', () => {})
  req.end()
  sub.stop = () => req.destroy()
  await waitFor(() => sub.status === HTTP_REFUSED || subscribedLines(world, scopeId) > before, `subscribe ${scopeId}`)
  if (sub.status === 0) sub.status = HTTP_OK
  return sub
}

const dm = (text: string, replyTo?: { messageId: number; fromId: number }): Omit<Update, 'update_id'> =>
  ({
    message: {
      message_id: 9000,
      date: 0,
      text,
      from: { id: USER_ID, is_bot: false, first_name: 'u' },
      chat: { id: USER_ID, type: 'private', first_name: 'u' },
      ...(replyTo
        ? {
            reply_to_message: {
              message_id: replyTo.messageId,
              date: 0,
              text: '[等你] t: 要繼續嗎？',
              from: { id: replyTo.fromId, is_bot: true, first_name: 'fake' },
              chat: { id: USER_ID, type: 'private', first_name: 'u' },
            },
          }
        : {}),
    },
  }) as unknown as Omit<Update, 'update_id'>

const textOf = (envelope: InboundEnvelope): string | undefined =>
  (envelope.payload as { message?: { text?: string } }).message?.text

/** Inject an update and wait until the poller has confirmed (consumed) it. */
async function injectAndSettle(world: World, update: Omit<Update, 'update_id'>): Promise<void> {
  world.fake.inject(update)
  await waitFor(() => world.fake.unconfirmed() === 0, 'poller to consume the update')
  await sleep(SETTLE_MS)
}

test('開關開：回覆對照表裡的 bot 訊息且 session 在線 -> 只送到該 session，中控收不到', async () => {
  const world = await startWorld({ direct: true })
  const hub = await subscribe(world, HUB_SCOPE)
  const session = await subscribe(world, SESSION_SCOPE)
  expect([hub.status, session.status]).toEqual([HTTP_OK, HTTP_OK])

  await injectAndSettle(world, dm('繼續跑', { messageId: MAPPED_MESSAGE_ID, fromId: FAKE_BOT_ID }))

  expect(session.got.map(textOf)).toEqual(['繼續跑'])
  expect(session.got[0].scopeId).toBe(SESSION_SCOPE)
  expect(hub.got).toEqual([])
}, TEST_TIMEOUT_MS)

test('對照表追加的新訊息也能直送（不必重啟 poller）', async () => {
  const world = await startWorld({ direct: true })
  const hub = await subscribe(world, HUB_SCOPE)
  const session = await subscribe(world, SESSION_SCOPE)
  await injectAndSettle(world, dm('第一則', { messageId: MAPPED_MESSAGE_ID, fromId: FAKE_BOT_ID }))
  appendFileSync(world.mapFile, `${JSON.stringify({ message_id: 3400, session_id: SESSION_ID, session_name: 't', sent_at: 2 })}\n`)
  await injectAndSettle(world, dm('第二則', { messageId: 3400, fromId: FAKE_BOT_ID }))
  expect(session.got.map(textOf)).toEqual(['第一則', '第二則'])
  expect(hub.got).toEqual([])
}, TEST_TIMEOUT_MS)

test('回落：session 不在線 / 查不到對照 / 沒有引用回覆 / 回覆的不是 bot / 指令 -> 全部進中控', async () => {
  const world = await startWorld({ direct: true })
  const hub = await subscribe(world, HUB_SCOPE)

  await injectAndSettle(world, dm('session 不在線', { messageId: MAPPED_MESSAGE_ID, fromId: FAKE_BOT_ID }))
  const session = await subscribe(world, SESSION_SCOPE)
  await injectAndSettle(world, dm('查不到', { messageId: 1, fromId: FAKE_BOT_ID }))
  await injectAndSettle(world, dm('沒有回覆'))
  await injectAndSettle(world, dm('回覆別人', { messageId: MAPPED_MESSAGE_ID, fromId: 999 }))
  await injectAndSettle(world, dm('/status', { messageId: MAPPED_MESSAGE_ID, fromId: FAKE_BOT_ID }))

  expect(hub.got.map(textOf)).toEqual(['session 不在線', '查不到', '沒有回覆', '回覆別人', '/status'])
  expect(session.got).toEqual([])
}, TEST_TIMEOUT_MS)

test('回落：session 斷線後再回覆 -> 進中控，poller 不替它 spawn', async () => {
  const world = await startWorld({ direct: true, env: { SCOPE_SPAWN_BIN: '/nonexistent/scope-spawn' } })
  const hub = await subscribe(world, HUB_SCOPE)
  const session = await subscribe(world, SESSION_SCOPE)
  session.stop()
  await waitFor(() => world.stderr.join('').includes(`${SESSION_SCOPE} disconnected`), 'session disconnect')

  await injectAndSettle(world, dm('斷線後', { messageId: MAPPED_MESSAGE_ID, fromId: FAKE_BOT_ID }))

  expect(hub.got.map(textOf)).toEqual(['斷線後'])
  expect(world.stderr.join('')).not.toContain(`scope-spawn exec failed for ${SESSION_SCOPE}`)
}, TEST_TIMEOUT_MS)

test('按鈕 callback 一律進中控（不看直送）', async () => {
  const world = await startWorld({ direct: true })
  const hub = await subscribe(world, HUB_SCOPE)
  const session = await subscribe(world, SESSION_SCOPE)
  await injectAndSettle(world, {
    callback_query: {
      id: 'cb1',
      chat_instance: 'x',
      data: 'perm:allow:abcde',
      from: { id: USER_ID, is_bot: false, first_name: 'u' },
      message: {
        message_id: MAPPED_MESSAGE_ID,
        date: 0,
        chat: { id: USER_ID, type: 'private', first_name: 'u' },
        from: { id: FAKE_BOT_ID, is_bot: true, first_name: 'fake' },
        text: '[等核准] tg-hub: 權限確認 Bash',
      },
    },
  } as unknown as Omit<Update, 'update_id'>)
  expect(hub.got.length).toBe(1)
  expect(session.got).toEqual([])
}, TEST_TIMEOUT_MS)

test('開關關（預設）：拒絕專屬 scope 訂閱，回覆照舊進中控', async () => {
  const world = await startWorld({ direct: false })
  const hub = await subscribe(world, HUB_SCOPE)
  const session = await subscribe(world, SESSION_SCOPE)
  expect(hub.status).toBe(HTTP_OK)
  expect(session.status).toBe(HTTP_REFUSED)

  await injectAndSettle(world, dm('照舊', { messageId: MAPPED_MESSAGE_ID, fromId: FAKE_BOT_ID }))
  expect(hub.got.map(textOf)).toEqual(['照舊'])
  expect(world.stderr.join('')).toContain('session-direct off (unset)')
}, TEST_TIMEOUT_MS)

test('名額：總在線數到 MAX_SCOPES 時新的專屬 scope 被拒，中控照常訂閱與收訊', async () => {
  const world = await startWorld({ direct: true, env: { MAX_SCOPES: '2' } })
  const first = await subscribe(world, SESSION_SCOPE)
  const second = await subscribe(world, OTHER_SESSION_SCOPE)
  expect(first.status).toBe(HTTP_OK)
  expect(second.status).toBe(HTTP_OK)
  const third = await subscribe(world, 'telegram-dm-s00000000000040008000000000000002')
  expect(third.status).toBe(HTTP_REFUSED)

  // The hub is never squeezed: it subscribes past the cap, and with no hub
  // subscriber at all a hub message is still admitted (spawn path), not refused.
  const hub = await subscribe(world, HUB_SCOPE)
  expect(hub.status).toBe(HTTP_OK)
  await injectAndSettle(world, dm('中控照常'))
  expect(hub.got.map(textOf)).toEqual(['中控照常'])
  expect(world.fake.callsOf('sendMessage')).toEqual([])
}, TEST_TIMEOUT_MS)

test('名額：專屬 scope 佔滿時，中控尚未連上的第一則訊息也不會被回「容量已滿」', async () => {
  const world = await startWorld({ direct: true, env: { MAX_SCOPES: '1' } })
  expect((await subscribe(world, SESSION_SCOPE)).status).toBe(HTTP_OK)
  await injectAndSettle(world, dm('中控還沒連上'))
  const sent = world.fake.callsOf('sendMessage').map(call => String(call.params.text))
  expect(sent.some(text => text.includes('容量已滿'))).toBe(false)
  expect(world.stderr.join('')).not.toContain('scope_cap_reached')
}, TEST_TIMEOUT_MS)

const SESSION_2_ID = '00000000-0000-4000-8000-0000000000aa'
const SESSION_2_SCOPE = 'telegram-dm-s000000000000400080000000000000aa'
const mapLine = (messageId: number, sessionId: string): string =>
  `${JSON.stringify({ message_id: messageId, session_id: sessionId, session_name: 't', sent_at: 1 })}\n`

test('多個 session：送到被回覆那則的來源 session；同 message_id 多筆以最後一筆為準（最後那筆不在線就回落中控）', async () => {
  const world = await startWorld({ direct: true })
  appendFileSync(world.mapFile, mapLine(3500, SESSION_2_ID) + mapLine(3600, SESSION_ID) + mapLine(3600, SESSION_2_ID))
  const hub = await subscribe(world, HUB_SCOPE)
  const s1 = await subscribe(world, SESSION_SCOPE)
  const s2 = await subscribe(world, SESSION_2_SCOPE)

  await injectAndSettle(world, dm('給 S2', { messageId: 3500, fromId: FAKE_BOT_ID }))
  await injectAndSettle(world, dm('重複對照', { messageId: 3600, fromId: FAKE_BOT_ID }))
  expect(s2.got.map(textOf)).toEqual(['給 S2', '重複對照'])
  expect(s1.got).toEqual([])

  s2.stop()
  await waitFor(() => world.stderr.join('').includes(`${SESSION_2_SCOPE} disconnected`), 'S2 disconnect')
  await injectAndSettle(world, dm('S2 離線', { messageId: 3600, fromId: FAKE_BOT_ID }))
  expect(hub.got.map(textOf)).toEqual(['S2 離線'])
  expect(s1.got).toEqual([])
}, TEST_TIMEOUT_MS)

test('中控不在線、session 在線：照樣直送', async () => {
  const world = await startWorld({ direct: true })
  const session = await subscribe(world, SESSION_SCOPE)
  await injectAndSettle(world, dm('中控不在', { messageId: MAPPED_MESSAGE_ID, fromId: FAKE_BOT_ID }))
  expect(session.got.map(textOf)).toEqual(['中控不在'])
}, TEST_TIMEOUT_MS)

test('map 壞掉的各種情況：壞行 + 截斷尾行時有效行照用；整份壞 / 檔案消失 / 無讀取權限 -> 中控，poller 持續運作', async () => {
  const world = await startWorld({ direct: true })
  writeFileSync(world.mapFile, '{bad\n' + mapLine(3700, SESSION_ID) + '{"message_id":3701}\n' + mapLine(3702, SESSION_ID).slice(0, 25))
  const hub = await subscribe(world, HUB_SCOPE)
  const session = await subscribe(world, SESSION_SCOPE)

  await injectAndSettle(world, dm('壞行之間的有效行', { messageId: 3700, fromId: FAKE_BOT_ID }))
  await injectAndSettle(world, dm('截斷行', { messageId: 3702, fromId: FAKE_BOT_ID }))
  appendFileSync(world.mapFile, mapLine(3702, SESSION_ID).slice(25))
  await injectAndSettle(world, dm('截斷行補完', { messageId: 3702, fromId: FAKE_BOT_ID }))
  expect(session.got.map(textOf)).toEqual(['壞行之間的有效行', '截斷行補完'])

  writeFileSync(world.mapFile, '{bad\nnot json\n')
  await injectAndSettle(world, dm('整份壞', { messageId: 3700, fromId: FAKE_BOT_ID }))
  chmodSync(world.mapFile, 0o000)
  await injectAndSettle(world, dm('讀不到', { messageId: 3700, fromId: FAKE_BOT_ID }))
  chmodSync(world.mapFile, 0o600)
  rmSync(world.mapFile)
  await injectAndSettle(world, dm('檔案消失', { messageId: 3700, fromId: FAKE_BOT_ID }))
  await injectAndSettle(world, dm('之後的一般訊息'))
  expect(hub.got.map(textOf)).toEqual(['截斷行', '整份壞', '讀不到', '檔案消失', '之後的一般訊息'])
  expect(session.got.length).toBe(2)
}, TEST_TIMEOUT_MS)

test('群組、非 allowFrom 的人、/reauth 類指令：都不直送', async () => {
  const world = await startWorld({ direct: true })
  const session = await subscribe(world, SESSION_SCOPE)
  const stranger = 222
  world.fake.inject({
    message: {
      message_id: 1,
      date: 0,
      text: '群組裡回覆',
      from: { id: USER_ID, is_bot: false, first_name: 'u' },
      chat: { id: -1001, type: 'supergroup', title: 'g' },
      reply_to_message: { message_id: MAPPED_MESSAGE_ID, date: 0, from: { id: FAKE_BOT_ID, is_bot: true, first_name: 'fake' }, chat: { id: -1001, type: 'supergroup', title: 'g' } },
    },
  } as unknown as Omit<Update, 'update_id'>)
  world.fake.inject({
    message: {
      message_id: 2,
      date: 0,
      text: '陌生人回覆',
      from: { id: stranger, is_bot: false, first_name: 's' },
      chat: { id: stranger, type: 'private', first_name: 's' },
      reply_to_message: { message_id: MAPPED_MESSAGE_ID, date: 0, from: { id: FAKE_BOT_ID, is_bot: true, first_name: 'fake' }, chat: { id: stranger, type: 'private', first_name: 's' } },
    },
  } as unknown as Omit<Update, 'update_id'>)
  await injectAndSettle(world, dm('/authcode 123', { messageId: MAPPED_MESSAGE_ID, fromId: FAKE_BOT_ID }))
  expect(session.got).toEqual([])
}, TEST_TIMEOUT_MS)

test('攔截順序不變：approvals 的按鈕與退回意見引用回覆不會被直送吃掉（即使 map 指向在線 session）', async () => {
  const world = await startWorld({ direct: true, env: { TELEGRAM_APPROVAL_BUTTONS: '1' } })
  const hub = await subscribe(world, HUB_SCOPE)
  const session = await subscribe(world, SESSION_SCOPE)
  const api = async (method: string, path: string, body?: unknown): Promise<{ status: number; body: Record<string, unknown> }> => {
    const res = await fetch(`http://${LOOPBACK}:${world.port}${path}`, {
      method,
      headers: body === undefined ? undefined : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    return { status: res.status, body: (await res.json()) as Record<string, unknown> }
  }
  const pressed = (data: string, messageId: number): Omit<Update, 'update_id'> =>
    ({
      callback_query: {
        id: `cb-${data}`,
        chat_instance: 'x',
        data,
        from: { id: USER_ID, is_bot: false, first_name: 'u' },
        message: { message_id: messageId, date: 0, chat: { id: USER_ID, type: 'private', first_name: 'u' } },
      },
    }) as unknown as Omit<Update, 'update_id'>

  expect((await api('POST', '/approvals', { id: 'A1', text: '請求 A1', kind: 'approve_reject', timeout_seconds: 60 })).status).toBe(201)
  const requestMessageId = 1000
  await injectAndSettle(world, pressed('appr:approve:A1', requestMessageId))
  expect((await api('GET', '/approvals/A1')).body).toMatchObject({ status: 'approved' })

  expect((await api('POST', '/approvals', { id: 'R1', text: '請求 R1', kind: 'approve_reject', timeout_seconds: 60 })).status).toBe(201)
  const rejectMessageId = await waitFor(() => {
    const sent = world.fake.callsOf('sendMessage')
    return sent.length >= 2 ? FIRST_SENT_ID + sent.length - 1 : undefined
  }, 'second request message')
  await injectAndSettle(world, pressed('appr:reject:R1', rejectMessageId))
  const promptId = await waitFor(() => {
    const sent = world.fake.callsOf('sendMessage')
    const index = sent.findIndex(call => call.params.reply_markup !== undefined && 'force_reply' in (call.params.reply_markup as Record<string, unknown>))
    return index === -1 ? undefined : FIRST_SENT_ID + index
  }, 'comment prompt')
  // The worst case: the map claims the prompt came from the online session.
  appendFileSync(world.mapFile, mapLine(promptId, SESSION_ID) + mapLine(rejectMessageId, SESSION_ID))
  await injectAndSettle(world, dm('範圍再縮小', { messageId: promptId, fromId: FAKE_BOT_ID }))

  expect((await api('GET', '/approvals/R1')).body).toMatchObject({ status: 'denied', comment: '範圍再縮小' })
  expect(session.got).toEqual([])
  expect(hub.got).toEqual([])
}, TEST_TIMEOUT_MS)
