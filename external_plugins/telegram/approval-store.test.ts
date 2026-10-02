import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ApprovalStore, SETTLED_RETENTION_MS, type ApprovalKind, type NewApproval } from './approval-store'

const CHAT_ID = 555
const TIMEOUT_MS = 60_000
const COMMENT_TIMEOUT_MS = 5_000

let dir: string
let filePath: string
let clock: number

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'approval-store-'))
  filePath = join(dir, 'approvals.json')
  clock = 1_000_000
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

const openStore = (): ApprovalStore => new ApprovalStore({ filePath, now: () => clock, log: () => {} })

const newApproval = (id: string, kind: ApprovalKind = 'allow_deny', messageId = 10): NewApproval => ({
  id,
  kind,
  text: `請求 ${id}`,
  createdAtMs: clock,
  expiresAtMs: clock + TIMEOUT_MS,
  commentTimeoutMs: COMMENT_TIMEOUT_MS,
  messages: [{ chatId: CHAT_ID, messageId }],
})

const on = (messageId = 10): { chatId: number; messageId: number } => ({ chatId: CHAT_ID, messageId })

test('新增的請求一律從 pending 開始', () => {
  const store = openStore()
  const request = store.add(newApproval('r1'))
  expect(request.status).toBe('pending')
  expect(request.decision).toBeNull()
  expect(store.get('r1')?.status).toBe('pending')
})

test('重複 id 新增會丟錯，既有結果不被覆寫', () => {
  const store = openStore()
  store.add(newApproval('r1'))
  store.press('r1', 'deny', on())
  expect(() => store.add(newApproval('r1'))).toThrow()
  expect(store.get('r1')?.status).toBe('denied')
})

test('按允許 -> approved；按拒絕 -> denied', () => {
  const store = openStore()
  store.add(newApproval('a'))
  store.add(newApproval('b', 'allow_deny', 11))
  expect(store.press('a', 'allow', on()).outcome).toBe('resolved')
  expect(store.press('b', 'deny', on(11)).outcome).toBe('resolved')
  expect(store.get('a')).toMatchObject({ status: 'approved', decision: 'allow', comment: null })
  expect(store.get('b')).toMatchObject({ status: 'denied', decision: 'deny', comment: null })
})

test('按 approve -> approved', () => {
  const store = openStore()
  store.add(newApproval('a', 'approve_reject'))
  store.press('a', 'approve', on())
  expect(store.get('a')).toMatchObject({ status: 'approved', decision: 'approve' })
})

test('動作不在該請求的按鈕組內時不改狀態', () => {
  const store = openStore()
  store.add(newApproval('a', 'allow_deny'))
  expect(store.press('a', 'approve', on()).outcome).toBe('wrong_action')
  expect(store.get('a')?.status).toBe('pending')
})

test('按鈕掛在不屬於該請求的訊息上時不改狀態', () => {
  const store = openStore()
  store.add(newApproval('a'))
  expect(store.press('a', 'allow', on(999)).outcome).toBe('wrong_message')
  expect(store.press('a', 'allow', { chatId: 777, messageId: 10 }).outcome).toBe('wrong_message')
  expect(store.get('a')?.status).toBe('pending')
})

test('查無的 id 按按鈕回 not_found', () => {
  expect(openStore().press('nope', 'allow', on()).outcome).toBe('not_found')
})

test('已有結果後再按不翻盤', () => {
  const store = openStore()
  store.add(newApproval('a'))
  store.press('a', 'deny', on())
  expect(store.press('a', 'allow', on()).outcome).toBe('already_settled')
  expect(store.get('a')).toMatchObject({ status: 'denied', decision: 'deny' })
})

test('按退回先進入等意見，收到意見才記為退回 + 意見', () => {
  const store = openStore()
  store.add(newApproval('a', 'approve_reject'))
  expect(store.press('a', 'reject', on()).outcome).toBe('awaiting_comment')
  expect(store.get('a')).toMatchObject({ status: 'awaiting_comment', decision: 'reject', comment: null })

  store.addPrompt('a', on(20))
  expect(store.findAwaitingComment(on(20))?.id).toBe('a')
  expect(store.findAwaitingComment(on(10))?.id).toBe('a')
  expect(store.findAwaitingComment(on(30))).toBeUndefined()

  store.recordComment('a', '範圍要再縮小')
  expect(store.get('a')).toMatchObject({ status: 'denied', decision: 'reject', comment: '範圍要再縮小' })
  expect(store.findAwaitingComment(on(20))).toBeUndefined()
})

test('按退回後再按 approve 不會變成允許', () => {
  const store = openStore()
  store.add(newApproval('a', 'approve_reject'))
  store.press('a', 'reject', on())
  expect(store.press('a', 'approve', on()).outcome).toBe('already_settled')
  expect(store.get('a')?.status).toBe('awaiting_comment')
})

test('等意見逾時 -> 無意見退回', () => {
  const store = openStore()
  store.add(newApproval('a', 'approve_reject'))
  store.press('a', 'reject', on())
  clock += COMMENT_TIMEOUT_MS - 1
  expect(store.sweep()).toEqual([])
  clock += 1
  expect(store.sweep().map(r => r.id)).toEqual(['a'])
  expect(store.get('a')).toMatchObject({ status: 'denied', decision: 'reject', comment: '' })
  expect(store.sweep()).toEqual([])
})

test('非等意見中的請求不接受意見', () => {
  const store = openStore()
  store.add(newApproval('a', 'approve_reject'))
  expect(store.recordComment('a', 'x')).toBeUndefined()
  expect(store.get('a')?.status).toBe('pending')
})

test('pending 逾時 -> expired，之後按按鈕不改結果', () => {
  const store = openStore()
  store.add(newApproval('a'))
  clock += TIMEOUT_MS
  expect(store.sweep().map(r => r.id)).toEqual(['a'])
  expect(store.get('a')?.status).toBe('expired')
  expect(store.press('a', 'allow', on()).outcome).toBe('already_settled')
  expect(store.get('a')).toMatchObject({ status: 'expired', decision: null })
})

test('取消 pending / 等意見中的請求 -> cancelled；之後按按鈕或回意見都無效', () => {
  const store = openStore()
  store.add(newApproval('a'))
  store.add(newApproval('b', 'approve_reject', 11))
  store.press('b', 'reject', on(11))
  expect(store.cancel('a').outcome).toBe('cancelled')
  expect(store.cancel('b').outcome).toBe('cancelled')
  expect(store.press('a', 'allow', on()).outcome).toBe('already_settled')
  expect(store.recordComment('b', '晚到的意見')).toBeUndefined()
  expect(store.get('a')).toMatchObject({ status: 'cancelled', decision: null })
  expect(store.get('b')).toMatchObject({ status: 'cancelled', decision: null, comment: null })
})

test('取消已有結果的請求保留原結果；重複取消冪等；查無回 not_found', () => {
  const store = openStore()
  store.add(newApproval('a'))
  store.press('a', 'allow', on())
  expect(store.cancel('a').outcome).toBe('unchanged')
  expect(store.get('a')?.status).toBe('approved')

  store.add(newApproval('b', 'allow_deny', 11))
  store.cancel('b')
  expect(store.cancel('b').outcome).toBe('unchanged')
  expect(store.cancel('nope').outcome).toBe('not_found')
})

test('已結束的請求過了保留期才清掉', () => {
  const store = openStore()
  store.add(newApproval('a'))
  store.press('a', 'allow', on())
  clock += SETTLED_RETENTION_MS - 1
  store.sweep()
  expect(store.get('a')).toBeDefined()
  clock += 1
  store.sweep()
  expect(store.get('a')).toBeUndefined()
})

test('狀態檔權限 0600，重開後 pending 與各種結果都保留', () => {
  const store = openStore()
  store.add(newApproval('pending'))
  store.add(newApproval('ok', 'allow_deny', 11))
  store.add(newApproval('back', 'approve_reject', 12))
  store.add(newApproval('gone', 'allow_deny', 13))
  store.add(newApproval('waiting', 'approve_reject', 14))
  store.press('ok', 'allow', on(11))
  store.press('back', 'reject', on(12))
  store.recordComment('back', 'X')
  store.cancel('gone')
  store.press('waiting', 'reject', on(14))

  expect(statSync(filePath).mode & 0o777).toBe(0o600)

  const reopened = openStore()
  expect(reopened.get('pending')?.status).toBe('pending')
  expect(reopened.get('ok')).toMatchObject({ status: 'approved', decision: 'allow' })
  expect(reopened.get('back')).toMatchObject({ status: 'denied', comment: 'X' })
  expect(reopened.get('gone')?.status).toBe('cancelled')
  expect(reopened.get('waiting')?.status).toBe('awaiting_comment')
  expect(reopened.press('pending', 'allow', on()).outcome).toBe('resolved')
})

test('停機期間跨過期限的請求，重開後 sweep 轉為 expired', () => {
  openStore().add(newApproval('a'))
  clock += TIMEOUT_MS + 1
  const reopened = openStore()
  reopened.sweep()
  expect(reopened.get('a')?.status).toBe('expired')
})

test.each([
  ['不是 JSON', 'not json{'],
  ['版本不符', JSON.stringify({ version: 99, requests: [] })],
  ['項目欄位不合法', JSON.stringify({ version: 1, requests: [{ id: 'a', status: 'approved' }] })],
  ['狀態值不合法', JSON.stringify({ version: 1, requests: [{ id: 'a', kind: 'allow_deny', text: 't', status: 'yes', decision: null, comment: null, createdAtMs: 1, expiresAtMs: 2, commentTimeoutMs: 3, commentDeadlineMs: null, resolvedAtMs: null, messages: [], prompts: [] }] })],
])('狀態檔損毀（%s）時從空狀態啟動並把壞檔移開', (_name, content) => {
  writeFileSync(filePath, content)
  const store = openStore()
  expect(store.size()).toBe(0)
  expect(store.get('a')).toBeUndefined()
  expect(readdirSync(dir).some(name => name.startsWith('approvals.json.corrupt-'))).toBe(true)
  store.add(newApproval('fresh'))
  expect(JSON.parse(readFileSync(filePath, 'utf8')).requests).toHaveLength(1)
})

test('store 沒有任何可直接寫入決定的公開方法', () => {
  const methods = Object.getOwnPropertyNames(ApprovalStore.prototype).filter(name => name !== 'constructor').sort()
  expect(methods).toEqual(
    ['add', 'addPrompt', 'cancel', 'findAwaitingComment', 'get', 'press', 'recordComment', 'size', 'sweep'].sort(),
  )
})
