import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { networkInterfaces, tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Update } from 'grammy/types'
import { ApprovalStore } from './approval-store'
import { createApprovalService, type ApprovalService } from './approval-service'
import { createApprovalHandler, mountApprovalRoutes, parseCreateBody } from './approval-http'
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
    input: { id: 'a', text: 't', kind: 'approve_reject', timeoutSeconds: 60, commentTimeoutSeconds: 5 },
  })
  const custom = parseCreateBody(
    JSON.stringify({ id: 'a', text: 't', kind: 'allow_deny', timeout_seconds: 0.5, comment_timeout_seconds: 0.1 }),
    DEFAULTS,
  )
  expect(custom).toMatchObject({ ok: true, input: { timeoutSeconds: 0.5, commentTimeoutSeconds: 0.1 } })
})
