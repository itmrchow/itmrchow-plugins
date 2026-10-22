import { afterEach, beforeEach, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { networkInterfaces, tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Update } from 'grammy/types'
import { ApprovalStore } from './approval-store'
import { createApprovalService, type ApprovalService } from './approval-service'
import { createApprovalHandler, mountApprovalRoutes, parseCreateBody } from './approval-http'
import { composeMessageText, renderBindingDisplay } from './approval-binding'
import { ScopeRegistry } from './poller-registry'
import { createSubscribeServer, type SubscribeHub } from './subscribe-server'

const U1 = 111
const DEFAULTS = { timeoutSeconds: 60, commentTimeoutSeconds: 5 }
const EXTERNAL_ADDRESS = Object.values(networkInterfaces())
  .flat()
  .find(iface => iface && iface.family === 'IPv4' && !iface.internal)?.address

type Reply = { status: number; body: Record<string, unknown> | string }
type Context = { hub: SubscribeHub; port: number; service?: ApprovalService; sent: number[]; failSend: { on: boolean } }

let dir: string
const open: SubscribeHub[] = []

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'approval-http-'))
})

afterEach(() => {
  for (const hub of open.splice(0)) hub.close()
  rmSync(dir, { recursive: true, force: true })
})

async function startServer(opts: { enabled: boolean }): Promise<Context> {
  const hub = createSubscribeServer({ registry: new ScopeRegistry({ maxScopes: 5, maxQueue: 5 }) })
  open.push(hub)
  const sent: number[] = []
  const failSend = { on: false }
  let service: ApprovalService | undefined
  if (opts.enabled) {
    let nextMessageId = 100
    service = createApprovalService({
      store: new ApprovalStore({ filePath: join(dir, 'approvals.json'), log: () => {} }),
      loadAllowFrom: () => [String(U1)],
      log: () => {},
      api: {
        sendRequest: async () => {
          if (failSend.on) throw new Error('telegram down')
          sent.push(nextMessageId)
          return nextMessageId++
        },
        sendPrompt: async () => nextMessageId++,
        editText: async () => {},
        answerCallback: async () => {},
        sendText: async () => {},
      },
    })
    mountApprovalRoutes(hub.server, createApprovalHandler(service, DEFAULTS))
  }
  await new Promise<void>(r => hub.server.listen(0, '127.0.0.1', r))
  return { hub, port: (hub.server.address() as { port: number }).port, service, sent, failSend }
}

async function call(port: number, method: string, path: string, body?: unknown, host = '127.0.0.1'): Promise<Reply> {
  const res = await fetch(`http://${host}:${port}${path}`, {
    method,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  })
  const text = await res.text()
  try {
    return { status: res.status, body: JSON.parse(text) as Record<string, unknown> }
  } catch {
    return { status: res.status, body: text }
  }
}

const pressAllow = (id: string, messageId: number): Update =>
  ({
    update_id: 1,
    callback_query: {
      id: 'cb',
      chat_instance: 'x',
      data: `appr:allow:${id}`,
      from: { id: U1, is_bot: false, first_name: 'u' },
      message: { message_id: messageId, date: 0, chat: { id: U1, type: 'private', first_name: 'u' } },
    },
  }) as unknown as Update

const statusOf = async (port: number, id: string): Promise<unknown> =>
  ((await call(port, 'GET', `/approvals/${id}`)).body as Record<string, unknown>).status

test('建立 -> 查詢 pending -> 按鈕允許 -> 查詢 approved', async () => {
  const { port, service, sent } = await startServer({ enabled: true })
  const created = await call(port, 'POST', '/approvals', { id: 'R1', text: '可以 merge 嗎', kind: 'allow_deny' })
  expect(created.status).toBe(201)
  expect(created.body).toMatchObject({ id: 'R1', kind: 'allow_deny', status: 'pending', decision: null, comment: null })
  expect(Object.keys(created.body as object).sort()).toEqual(
    ['comment', 'created_at_ms', 'decision', 'expires_at_ms', 'id', 'kind', 'resolved_at_ms', 'status'],
  )

  expect(await statusOf(port, 'R1')).toBe('pending')
  await service?.interceptUpdate(pressAllow('R1', sent[0]))
  const settled = await call(port, 'GET', '/approvals/R1')
  expect(settled.status).toBe(200)
  expect(settled.body).toMatchObject({ status: 'approved', decision: 'allow' })
})

test('查詢不存在的請求回 404 not_found', async () => {
  const { port } = await startServer({ enabled: true })
  expect(await call(port, 'GET', '/approvals/never')).toEqual({ status: 404, body: { error: 'not_found' } })
})

test('取消：200 與 cancelled；取消不存在的 id 回 404；重複取消冪等', async () => {
  const { port } = await startServer({ enabled: true })
  await call(port, 'POST', '/approvals', { id: 'R30', text: 't', kind: 'allow_deny' })
  const cancelled = await call(port, 'POST', '/approvals/R30/cancel')
  expect(cancelled.status).toBe(200)
  expect(cancelled.body).toMatchObject({ status: 'cancelled', decision: null })
  expect((await call(port, 'POST', '/approvals/R30/cancel')).body).toMatchObject({ status: 'cancelled' })
  expect(await call(port, 'POST', '/approvals/never/cancel')).toEqual({ status: 404, body: { error: 'not_found' } })
})

test('重複 id 回 409 並附既有請求現況', async () => {
  const { port, service, sent } = await startServer({ enabled: true })
  await call(port, 'POST', '/approvals', { id: 'R3', text: 't', kind: 'allow_deny' })
  await service?.interceptUpdate(pressAllow('R3', sent[0]))
  const again = await call(port, 'POST', '/approvals', { id: 'R3', text: 't', kind: 'allow_deny' })
  expect(again.status).toBe(409)
  expect(again.body).toMatchObject({ error: 'duplicate_id', request: { id: 'R3', status: 'approved' } })
  expect(sent).toHaveLength(1)
})

test.each([
  ['缺 id', { text: 't', kind: 'allow_deny' }],
  ['id 含不合法字元', { id: 'a b', text: 't', kind: 'allow_deny' }],
  ['id 含冒號', { id: 'a:b', text: 't', kind: 'allow_deny' }],
  ['id 超過 40 字元', { id: 'a'.repeat(41), text: 't', kind: 'allow_deny' }],
  ['缺顯示文字', { id: 'bad', kind: 'allow_deny' }],
  ['顯示文字空白', { id: 'bad', text: '   ', kind: 'allow_deny' }],
  ['顯示文字過長', { id: 'bad', text: 'x'.repeat(3501), kind: 'allow_deny' }],
  ['未知按鈕組', { id: 'bad', text: 't', kind: 'yes_no' }],
  ['缺按鈕組', { id: 'bad', text: 't' }],
  ['逾時為 0', { id: 'bad', text: 't', kind: 'allow_deny', timeout_seconds: 0 }],
  ['逾時非數字', { id: 'bad', text: 't', kind: 'allow_deny', timeout_seconds: '60' }],
  ['等意見時間為負', { id: 'bad', text: 't', kind: 'allow_deny', comment_timeout_seconds: -1 }],
  ['session_name 含換行', { id: 'bad', text: 't', kind: 'allow_deny', session_name: 'a\nb' }],
  ['session_name 含 CR', { id: 'bad', text: 't', kind: 'allow_deny', session_name: 'a\rb' }],
  ['session_name 含控制字元', { id: 'bad', text: 't', kind: 'allow_deny', session_name: `a${String.fromCharCode(7)}b` }],
  ['session_name 含 line separator', { id: 'bad', text: 't', kind: 'allow_deny', session_name: `a${String.fromCharCode(0x2028)}b` }],
  ['session_name 非字串', { id: 'bad', text: 't', kind: 'allow_deny', session_name: 42 }],
  ['session_name 超過 3500 字', { id: 'bad', text: 't', kind: 'allow_deny', session_name: 'n'.repeat(3501) }],
  [
    '已被擋下時 session_name 與綁定內容合計超過 Telegram 上限',
    {
      id: 'bad',
      text: 't',
      kind: 'allow_deny',
      binding_session: 'session-1111',
      binding_subject: 's'.repeat(600),
      session_name: 'n'.repeat(3500),
    },
  ],
  ['格式錯誤', '{not json'],
  ['不是物件', '[1,2]'],
])('建立時%s回 400，不發訊息、不留下請求', async (_name, body) => {
  const { port, sent } = await startServer({ enabled: true })
  const res = await call(port, 'POST', '/approvals', body)
  expect(res.status).toBe(400)
  expect(res.body).toMatchObject({ error: 'invalid_request' })
  expect(sent).toEqual([])
  expect((await call(port, 'GET', '/approvals/bad')).status).toBe(404)
})

test('body 過大回 400', async () => {
  const { port } = await startServer({ enabled: true })
  const res = await call(port, 'POST', '/approvals', { id: 'big', text: 't', kind: 'allow_deny', pad: 'x'.repeat(40_000) })
  expect(res.status).toBe(400)
})

test('Telegram 發不出去回 502，查詢為查無', async () => {
  const { port, failSend } = await startServer({ enabled: true })
  failSend.on = true
  const res = await call(port, 'POST', '/approvals', { id: 'R5', text: 't', kind: 'allow_deny' })
  expect(res).toEqual({ status: 502, body: { error: 'telegram_send_failed' } })
  expect((await call(port, 'GET', '/approvals/R5')).status).toBe(404)
})

test('顯示文字含特殊字元、換行、中文與接近上限的長文時原樣建立', async () => {
  const { port } = await startServer({ enabled: true })
  const special = '< > & _ * [ ] ` \n第二行 中文'
  expect((await call(port, 'POST', '/approvals', { id: 's1', text: special, kind: 'allow_deny' })).status).toBe(201)
  expect((await call(port, 'POST', '/approvals', { id: 's2', text: '長'.repeat(3500), kind: 'allow_deny' })).status).toBe(201)
})

test('loopback 介面沒有寫入決定的動作：各種嘗試後請求仍 pending', async () => {
  const { port } = await startServer({ enabled: true })
  await call(port, 'POST', '/approvals', { id: 'R40', text: 't', kind: 'allow_deny' })
  const smuggled = { status: 'approved', decision: 'allow', result: 'allow', comment: 'x', resolved_at_ms: 1 }

  // (a) 建立時夾帶結果欄位：新 id 與既有 id
  const fresh = await call(port, 'POST', '/approvals', { id: 'R41', text: 't', kind: 'allow_deny', ...smuggled })
  expect(fresh.body).toMatchObject({ status: 'pending', decision: null, comment: null })
  await call(port, 'POST', '/approvals', { id: 'R40', text: 't', kind: 'allow_deny', ...smuggled })

  // (b) 查詢 / 取消以外的 method 與夾帶 body
  for (const method of ['PUT', 'PATCH', 'DELETE', 'POST']) {
    const res = await call(port, method, '/approvals/R40', smuggled)
    expect(res.status).toBe(405)
  }
  for (const method of ['GET', 'PUT', 'PATCH', 'DELETE']) {
    expect((await call(port, method, '/approvals', method === 'GET' ? undefined : smuggled)).status).toBe(405)
  }
  expect((await call(port, 'GET', `/approvals/R40?status=approved&decision=allow`)).body).toMatchObject({ status: 'pending' })

  // (c) 未公開的路徑
  for (const verb of ['decide', 'approve', 'allow', 'set', 'update', 'resolve', 'decision', 'press', 'callback']) {
    expect((await call(port, 'POST', `/approvals/R40/${verb}`, smuggled)).status).toBe(404)
    expect((await call(port, 'POST', `/approvals/R40/cancel/${verb}`, smuggled)).status).toBe(404)
    expect((await call(port, 'POST', `/${verb}`, { id: 'R40', ...smuggled })).status).toBe(404)
  }

  // (d) 既有 loopback 能力（/ack）夾帶偽造的 callback
  await call(port, 'POST', '/ack', { envelopeId: 'x', scopeId: 'telegram-dm-111', callback_query: { data: 'appr:allow:R40' } })

  expect(await statusOf(port, 'R40')).toBe('pending')
  expect(await statusOf(port, 'R41')).toBe('pending')
})

test('取消動作夾帶結果欄位也只會變成 cancelled，不會變成允許', async () => {
  const { port } = await startServer({ enabled: true })
  await call(port, 'POST', '/approvals', { id: 'R42', text: 't', kind: 'allow_deny' })
  const res = await call(port, 'POST', '/approvals/R42/cancel', { status: 'approved', decision: 'allow' })
  expect(res.body).toMatchObject({ status: 'cancelled', decision: null })
})

test('掛上核准路由後，既有的 /subscribe 與 /ack 與未知路徑行為不變', async () => {
  const { port } = await startServer({ enabled: true })
  expect(await call(port, 'GET', '/subscribe?scope=../etc/passwd')).toEqual({ status: 400, body: 'invalid scope' })
  expect(await call(port, 'POST', '/ack', { envelopeId: 'e', scopeId: 'telegram-dm-1' })).toEqual({ status: 200, body: 'ok' })
  expect(await call(port, 'GET', '/other')).toEqual({ status: 404, body: 'not found' })
  expect(await call(port, 'GET', '/approvalsX')).toEqual({ status: 404, body: 'not found' })
})

test('開關未設（未掛路由）時三個動作都落到既有的 404 not found', async () => {
  const { port } = await startServer({ enabled: false })
  const body = { id: 'R1', text: 't', kind: 'allow_deny' }
  expect(await call(port, 'POST', '/approvals', body)).toEqual({ status: 404, body: 'not found' })
  expect(await call(port, 'GET', '/approvals/R1')).toEqual({ status: 404, body: 'not found' })
  expect(await call(port, 'POST', '/approvals/R1/cancel')).toEqual({ status: 404, body: 'not found' })
})

// Skipped, visibly, on a machine with no non-loopback interface to connect from.
test.skipIf(!EXTERNAL_ADDRESS)('只綁 127.0.0.1：從本機其他介面位址連不上', async () => {
  const { port } = await startServer({ enabled: true })
  await expect(call(port, 'GET', '/approvals/R1', undefined, EXTERNAL_ADDRESS)).rejects.toThrow()
})

test('帶 Origin header 的請求（瀏覽器跨站）一律 403，不建立也不取消', async () => {
  const { port, sent } = await startServer({ enabled: true })
  await call(port, 'POST', '/approvals', { id: 'R50', text: 't', kind: 'allow_deny' })
  const fromPage = (method: string, path: string, body?: string): Promise<Response> =>
    fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers: { origin: 'https://evil.example', 'content-type': 'text/plain' },
      body,
    })

  const created = await fromPage('POST', '/approvals', JSON.stringify({ id: 'R51', text: 't', kind: 'allow_deny' }))
  expect(created.status).toBe(403)
  expect(await created.json()).toEqual({ error: 'forbidden_origin' })
  expect((await fromPage('POST', '/approvals/R50/cancel')).status).toBe(403)
  expect((await fromPage('GET', '/approvals/R50')).status).toBe(403)

  expect(sent).toHaveLength(1)
  expect((await call(port, 'GET', '/approvals/R51')).status).toBe(404)
  expect(await statusOf(port, 'R50')).toBe('pending')
})

test('parseCreateBody 只讀取文件化的欄位，未帶逾時用預設值', () => {
  const parsed = parseCreateBody(JSON.stringify({ id: 'a', text: 't', kind: 'approve_reject', status: 'approved' }), DEFAULTS)
  expect(parsed).toEqual({
    ok: true,
    input: {
      id: 'a',
      text: 't',
      kind: 'approve_reject',
      timeoutSeconds: 60,
      commentTimeoutSeconds: 5,
      binding: null,
      sessionName: 'tg-hub',
    },
  })
  const custom = parseCreateBody(
    JSON.stringify({ id: 'a', text: 't', kind: 'allow_deny', timeout_seconds: 0.5, comment_timeout_seconds: 0.1 }),
    DEFAULTS,
  )
  expect(custom).toMatchObject({ ok: true, input: { timeoutSeconds: 0.5, commentTimeoutSeconds: 0.1 } })
})

const SESSION = 'session-1111'
const SUBJECT = 'echo bound-command'
const BINDING = { binding_session: SESSION, binding_subject: SUBJECT }
const KEY = createHash('sha256').update(`${SESSION}\n${SUBJECT}`, 'utf8').digest('hex')

async function createBound(ctx: Context, id: string, binding: Record<string, unknown> = BINDING): Promise<Reply> {
  return call(ctx.port, 'POST', '/approvals', { id, text: 't', kind: 'allow_deny', ...binding })
}

const consumeBody = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({ ...BINDING, ...overrides })

test('建立帶 binding_session + binding_subject：回應的 binding_key 是 poller 算的 sha256；建立、查詢、取消都帶回', async () => {
  const ctx = await startServer({ enabled: true })
  const created = await createBound(ctx, 'K1')
  expect(created.status).toBe(201)
  expect(created.body).toMatchObject({ id: 'K1', status: 'pending', binding_key: KEY })
  expect((await call(ctx.port, 'GET', '/approvals/K1')).body).toMatchObject({ binding_key: KEY })
  expect((await call(ctx.port, 'POST', '/approvals/K1/cancel')).body).toMatchObject({ status: 'cancelled', binding_key: KEY })
  // The raw subject is never echoed back.
  expect(JSON.stringify(created.body)).not.toContain(SUBJECT)
})

test('沒帶綁定欄位的請求，回應欄位與既有格式完全相同', async () => {
  const { port } = await startServer({ enabled: true })
  await call(port, 'POST', '/approvals', { id: 'K2', text: 't', kind: 'allow_deny' })
  const queried = await call(port, 'GET', '/approvals/K2')
  expect(Object.keys(queried.body as object).sort()).toEqual(
    ['comment', 'created_at_ms', 'decision', 'expires_at_ms', 'id', 'kind', 'resolved_at_ms', 'status'],
  )
})

test('呼叫端自帶 binding_key 一律忽略：請求維持未綁定，也不能用那個 key 消耗', async () => {
  const ctx = await startServer({ enabled: true })
  const created = await call(ctx.port, 'POST', '/approvals', { id: 'K10', text: 't', kind: 'allow_deny', binding_key: KEY })
  expect(created.status).toBe(201)
  expect(created.body).not.toHaveProperty('binding_key')
  await ctx.service?.interceptUpdate(pressAllow('K10', ctx.sent[0]))
  expect((await call(ctx.port, 'POST', '/approvals/K10/consume', consumeBody())).body).toMatchObject({
    error: 'binding_mismatch',
  })
})

test.each([
  ['只帶 session', { binding_session: SESSION }],
  ['只帶 subject', { binding_subject: SUBJECT }],
  ['session 空字串', { binding_session: '', binding_subject: SUBJECT }],
  ['session 含換行', { binding_session: 'a\nb', binding_subject: SUBJECT }],
  ['session 非字串', { binding_session: 42, binding_subject: SUBJECT }],
  ['session 超過 128 字元', { binding_session: 'a'.repeat(129), binding_subject: SUBJECT }],
  ['subject 空白', { binding_session: SESSION, binding_subject: '  ' }],
  ['subject 非字串', { binding_session: SESSION, binding_subject: null }],
  ['自由文字 + 綁定區塊超過一則訊息', { binding_session: SESSION, binding_subject: 'x'.repeat(1000) }],
])('建立時%s回 400，不發訊息', async (_name: string, binding: Record<string, unknown>) => {
  const ctx = await startServer({ enabled: true })
  const res = await call(ctx.port, 'POST', '/approvals', { id: 'bad', text: '長'.repeat(3400), kind: 'allow_deny', ...binding })
  expect(res.status).toBe(400)
  expect(res.body).toMatchObject({ error: 'invalid_request' })
  expect(ctx.sent).toEqual([])
})

test('消耗：按允許後以相同綁定內容消耗 -> 200 consumed，之後查詢為 consumed、再消耗回 409 already_consumed', async () => {
  const ctx = await startServer({ enabled: true })
  await createBound(ctx, 'K3')
  await ctx.service?.interceptUpdate(pressAllow('K3', ctx.sent[0]))
  const consumed = await call(ctx.port, 'POST', '/approvals/K3/consume', consumeBody())
  expect(consumed.status).toBe(200)
  expect(consumed.body).toMatchObject({ id: 'K3', status: 'consumed', decision: 'allow', binding_key: KEY })
  expect(await statusOf(ctx.port, 'K3')).toBe('consumed')
  const again = await call(ctx.port, 'POST', '/approvals/K3/consume', consumeBody())
  expect(again.status).toBe(409)
  expect(again.body).toMatchObject({ error: 'already_consumed', request: { id: 'K3', status: 'consumed' } })
})

test('消耗：未 approved 回 409 not_approved；內容不同或請求沒綁定回 409 binding_mismatch；狀態都不變', async () => {
  const ctx = await startServer({ enabled: true })
  await createBound(ctx, 'K4')
  const pending = await call(ctx.port, 'POST', '/approvals/K4/consume', consumeBody())
  expect(pending).toMatchObject({ status: 409, body: { error: 'not_approved', request: { status: 'pending' } } })

  await ctx.service?.interceptUpdate(pressAllow('K4', ctx.sent[0]))
  for (const overrides of [{ binding_subject: `${SUBJECT}x` }, { binding_session: 'session-2222' }]) {
    const borrowed = await call(ctx.port, 'POST', '/approvals/K4/consume', consumeBody(overrides))
    expect(borrowed).toMatchObject({ status: 409, body: { error: 'binding_mismatch' } })
  }
  expect(await statusOf(ctx.port, 'K4')).toBe('approved')

  await call(ctx.port, 'POST', '/approvals', { id: 'K5', text: 't', kind: 'allow_deny' })
  await ctx.service?.interceptUpdate(pressAllow('K5', ctx.sent[1]))
  const unbound = await call(ctx.port, 'POST', '/approvals/K5/consume', consumeBody())
  expect(unbound).toMatchObject({ status: 409, body: { error: 'binding_mismatch' } })
  expect(await statusOf(ctx.port, 'K5')).toBe('approved')
})

test('消耗：查無 id 回 404；body 不合法回 400；非 POST 回 405', async () => {
  const ctx = await startServer({ enabled: true })
  await createBound(ctx, 'K6')
  expect(await call(ctx.port, 'POST', '/approvals/never/consume', consumeBody())).toEqual({
    status: 404,
    body: { error: 'not_found' },
  })
  const badBodies = [
    undefined, '{not json', '[1]', {}, { binding_key: KEY },
    { binding_session: SESSION }, { binding_subject: SUBJECT }, consumeBody({ binding_session: 'a b' }), consumeBody({ binding_subject: '' }),
  ]
  for (const body of badBodies) {
    const res = await call(ctx.port, 'POST', '/approvals/K6/consume', body)
    expect(res).toMatchObject({ status: 400, body: { error: 'invalid_request' } })
  }
  for (const method of ['GET', 'PUT', 'DELETE']) {
    expect((await call(ctx.port, method, '/approvals/K6/consume')).status).toBe(405)
  }
  expect((await call(ctx.port, 'POST', '/approvals/K6/consume/x', consumeBody())).status).toBe(404)
  expect(await statusOf(ctx.port, 'K6')).toBe('pending')
})

test('消耗夾帶結果欄位也不會讓 pending 變成 approved', async () => {
  const ctx = await startServer({ enabled: true })
  await createBound(ctx, 'K7')
  const smuggled = consumeBody({ status: 'approved', decision: 'allow' })
  expect((await call(ctx.port, 'POST', '/approvals/K7/consume', smuggled)).status).toBe(409)
  expect(await statusOf(ctx.port, 'K7')).toBe('pending')
})

test('消耗帶 Origin header 一律 403，不消耗', async () => {
  const ctx = await startServer({ enabled: true })
  await createBound(ctx, 'K8')
  await ctx.service?.interceptUpdate(pressAllow('K8', ctx.sent[0]))
  const res = await fetch(`http://127.0.0.1:${ctx.port}/approvals/K8/consume`, {
    method: 'POST',
    headers: { origin: 'https://evil.example', 'content-type': 'text/plain' },
    body: JSON.stringify(consumeBody()),
  })
  expect(res.status).toBe(403)
  expect(await statusOf(ctx.port, 'K8')).toBe('approved')
})

test('開關未設（未掛路由）時消耗也落到既有的 404 not found', async () => {
  const { port } = await startServer({ enabled: false })
  expect(await call(port, 'POST', '/approvals/R1/consume', consumeBody())).toEqual({ status: 404, body: 'not found' })
})

test('parseCreateBody 讀可選的 binding_session + binding_subject', () => {
  const parsed = parseCreateBody(JSON.stringify({ id: 'a', text: 't', kind: 'allow_deny', ...BINDING }), DEFAULTS)
  expect(parsed).toMatchObject({ ok: true, input: { binding: { session: SESSION, subject: SUBJECT } } })
})

test('消耗時狀態檔寫不進去 -> 503 persist_failed，之後同一筆也不能再消耗', async () => {
  const ctx = await startServer({ enabled: true })
  await createBound(ctx, 'K9')
  await ctx.service?.interceptUpdate(pressAllow('K9', ctx.sent[0]))
  mkdirSync(join(dir, 'approvals.json.tmp'))
  const failed = await call(ctx.port, 'POST', '/approvals/K9/consume', consumeBody())
  expect(failed).toMatchObject({ status: 503, body: { error: 'persist_failed', request: { status: 'consumed' } } })
  expect((await call(ctx.port, 'POST', '/approvals/K9/consume', consumeBody())).body).toMatchObject({
    error: 'already_consumed',
  })
})

test('parseCreateBody 讀可選的 session_name；未帶 / null / 空白填 tg-hub', () => {
  const base = { id: 'a', text: 't', kind: 'allow_deny' }
  expect(parseCreateBody(JSON.stringify({ ...base, session_name: 'OP-8820' }), DEFAULTS)).toMatchObject({
    ok: true,
    input: { sessionName: 'OP-8820' },
  })
  for (const sessionName of [undefined, null, '', '  ']) {
    expect(parseCreateBody(JSON.stringify({ ...base, session_name: sessionName }), DEFAULTS)).toMatchObject({
      ok: true,
      input: { sessionName: 'tg-hub' },
    })
  }
})

test('帶 session_name 建立：201，回應欄位與既有格式相同（不回傳 session_name）', async () => {
  const { port } = await startServer({ enabled: true })
  const res = await call(port, 'POST', '/approvals', { id: 'N1', text: 't', kind: 'allow_deny', session_name: 'OP-8820' })
  expect(res.status).toBe(201)
  expect(Object.keys(res.body as Record<string, unknown>).sort()).toEqual(
    ['comment', 'created_at_ms', 'decision', 'expires_at_ms', 'id', 'kind', 'resolved_at_ms', 'status'].sort(),
  )
})

test('4096 上限把第一行摘要算進去：區塊加 text 放得下、加上第一行就超過時回 400', () => {
  const body = {
    id: 'a', text: '長'.repeat(3500), kind: 'allow_deny', binding_session: SESSION, binding_subject: 'x'.repeat(450), session_name: 'OP-8820',
  }
  const withoutFirstLine = composeMessageText(renderBindingDisplay(body.binding_subject), body.text, 'OP-8820').split('\n').slice(1).join('\n')
  expect(withoutFirstLine.length).toBeLessThanOrEqual(4096)
  expect(parseCreateBody(JSON.stringify(body), DEFAULTS).ok).toBe(false)
})
