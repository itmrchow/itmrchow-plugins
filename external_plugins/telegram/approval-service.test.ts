import { afterEach, beforeEach, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Update } from 'grammy/types'
import type { ApprovalBinding } from './approval-binding'
import { ApprovalStore, type ApprovalKind } from './approval-store'
import {
  createApprovalService,
  renderApprovalText,
  type ApprovalButton,
  type ApprovalService,
  type CreateApprovalInput,
} from './approval-service'

const U1 = 111
const SESSION_NAME = 'OP-8820'
const U2 = 222
const U3 = 333
const BOT_ID = 999
const TIMEOUT_SECONDS = 60
const COMMENT_TIMEOUT_SECONDS = 5

type ApiCall =
  | { method: 'sendRequest'; chatId: number; text: string; buttons: readonly ApprovalButton[]; messageId: number }
  | { method: 'sendPrompt'; chatId: number; text: string; replyTo: number; messageId: number }
  | { method: 'editText'; chatId: number; messageId: number; text: string }
  | { method: 'answerCallback'; id: string; text?: string }
  | { method: 'sendText'; chatId: number; text: string }

type Harness = {
  service: ApprovalService
  store: ApprovalStore
  calls: ApiCall[]
  fail: Set<ApiCall['method']>
  failChats: Set<number>
  allowFrom: string[]
  advance: (ms: number) => void
}

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'approval-service-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function harness(allowFrom: string[] = [String(U1)]): Harness {
  let clock = 1_000_000
  let nextMessageId = 100
  const calls: ApiCall[] = []
  const fail = new Set<ApiCall['method']>()
  const failChats = new Set<number>()
  const refuse = (method: ApiCall['method'], chatId?: number): void => {
    if (fail.has(method) || (chatId !== undefined && failChats.has(chatId))) throw new Error(`${method} refused`)
  }
  const store = new ApprovalStore({ filePath: join(dir, 'approvals.json'), now: () => clock, log: () => {} })
  const service = createApprovalService({
    store,
    loadAllowFrom: () => allowFrom,
    now: () => clock,
    log: () => {},
    api: {
      sendRequest: async (chatId, text, buttons) => {
        refuse('sendRequest', chatId)
        const messageId = nextMessageId++
        calls.push({ method: 'sendRequest', chatId, text, buttons, messageId })
        return messageId
      },
      sendPrompt: async (chatId, text, replyTo) => {
        refuse('sendPrompt')
        const messageId = nextMessageId++
        calls.push({ method: 'sendPrompt', chatId, text, replyTo, messageId })
        return messageId
      },
      editText: async (chatId, messageId, text) => {
        refuse('editText')
        calls.push({ method: 'editText', chatId, messageId, text })
      },
      answerCallback: async (id, text) => {
        refuse('answerCallback')
        calls.push({ method: 'answerCallback', id, text })
      },
      sendText: async (chatId, text) => {
        calls.push({ method: 'sendText', chatId, text })
      },
    },
  })
  return { service, store, calls, fail, failChats, allowFrom, advance: ms => void (clock += ms) }
}

const input = (id: string, kind: ApprovalKind = 'allow_deny', text = `請求 ${id}`): CreateApprovalInput => ({
  id,
  kind,
  text,
  timeoutSeconds: TIMEOUT_SECONDS,
  commentTimeoutSeconds: COMMENT_TIMEOUT_SECONDS,
  binding: null,
  sessionName: SESSION_NAME,
})

let updateId = 0
const press = (data: string, fromId: number, messageId: number, chatId = fromId): Update =>
  ({
    update_id: ++updateId,
    callback_query: {
      id: `cb${updateId}`,
      chat_instance: 'x',
      data,
      from: { id: fromId, is_bot: false, first_name: 'u' },
      message: { message_id: messageId, date: 0, chat: { id: chatId, type: 'private', first_name: 'u' } },
    },
  }) as unknown as Update

const message = (
  fromId: number,
  text: string | undefined,
  replyTo?: number,
  opts: { isBot?: boolean; chatId?: number } = {},
): Update =>
  ({
    update_id: ++updateId,
    message: {
      message_id: 5000 + updateId,
      date: 0,
      ...(text === undefined ? { sticker: { file_id: 's' } } : { text }),
      from: { id: fromId, is_bot: opts.isBot ?? false, first_name: 'u' },
      chat: { id: opts.chatId ?? fromId, type: 'private', first_name: 'u' },
      ...(replyTo === undefined ? {} : { reply_to_message: { message_id: replyTo, date: 0, chat: { id: fromId, type: 'private' } } }),
    },
  }) as unknown as Update

const sentRequests = (h: Harness): Extract<ApiCall, { method: 'sendRequest' }>[] =>
  h.calls.filter((c): c is Extract<ApiCall, { method: 'sendRequest' }> => c.method === 'sendRequest')
const edits = (h: Harness): Extract<ApiCall, { method: 'editText' }>[] =>
  h.calls.filter((c): c is Extract<ApiCall, { method: 'editText' }> => c.method === 'editText')
const prompts = (h: Harness): Extract<ApiCall, { method: 'sendPrompt' }>[] =>
  h.calls.filter((c): c is Extract<ApiCall, { method: 'sendPrompt' }> => c.method === 'sendPrompt')
const answers = (h: Harness): Extract<ApiCall, { method: 'answerCallback' }>[] =>
  h.calls.filter((c): c is Extract<ApiCall, { method: 'answerCallback' }> => c.method === 'answerCallback')

async function createOne(h: Harness, id: string, kind: ApprovalKind = 'allow_deny'): Promise<number> {
  const before = sentRequests(h).length
  const result = await h.service.create(input(id, kind))
  expect(result.ok).toBe(true)
  return sentRequests(h)[before].messageId
}

test('建立「允許 / 拒絕」請求：發一則帶兩顆按鈕的訊息，狀態 pending', async () => {
  const h = harness()
  const result = await h.service.create(input('R1', 'allow_deny', '要 merge PR #42 嗎？'))
  expect(result.ok).toBe(true)
  const [sent] = sentRequests(h)
  expect(sent.chatId).toBe(U1)
  expect(sent.text).toBe('要 merge PR #42 嗎？')
  expect(sent.buttons).toEqual([
    { text: '允許', callbackData: 'appr:allow:R1' },
    { text: '拒絕', callbackData: 'appr:deny:R1' },
  ])
  expect(h.service.get('R1')?.status).toBe('pending')
})

test('建立「approve / 退回」請求：按鈕為 approve 與 退回', async () => {
  const h = harness()
  await createOne(h, 'R2', 'approve_reject')
  expect(sentRequests(h)[0].buttons).toEqual([
    { text: 'approve', callbackData: 'appr:approve:R2' },
    { text: '退回', callbackData: 'appr:reject:R2' },
  ])
})

test('最長合法 id 的 callback_data 不超過 Telegram 的 64 bytes', async () => {
  const h = harness()
  const longest = 'a'.repeat(40)
  await createOne(h, longest, 'approve_reject')
  for (const button of sentRequests(h)[0].buttons) {
    expect(Buffer.byteLength(button.callbackData)).toBeLessThanOrEqual(64)
  }
})

test('重複 id 建立回 duplicate_id 與既有請求，不重發訊息、不重置結果', async () => {
  const h = harness()
  const messageId = await createOne(h, 'R3')
  await h.service.interceptUpdate(press('appr:deny:R3', U1, messageId))
  const again = await h.service.create(input('R3'))
  expect(again).toMatchObject({ ok: false, error: 'duplicate_id' })
  expect(again.request?.status).toBe('denied')
  expect(sentRequests(h)).toHaveLength(1)
  expect(h.service.get('R3')?.status).toBe('denied')
})

test('同一 id 同時建立兩次只會成立一筆', async () => {
  const h = harness()
  const [first, second] = await Promise.all([h.service.create(input('R4')), h.service.create(input('R4'))])
  expect([first.ok, second.ok].sort()).toEqual([false, true])
  expect(sentRequests(h)).toHaveLength(1)
})

test('allowFrom 為空時回 no_recipient，不留下請求', async () => {
  const h = harness([])
  expect(await h.service.create(input('R5'))).toEqual({ ok: false, error: 'no_recipient' })
  expect(h.service.get('R5')).toBeUndefined()
})

test('Telegram 發送失敗時回 telegram_send_failed，不留下無人能按的 pending', async () => {
  const h = harness()
  h.fail.add('sendRequest')
  expect(await h.service.create(input('R5'))).toEqual({ ok: false, error: 'telegram_send_failed' })
  expect(h.service.get('R5')).toBeUndefined()
})

test('allowFrom 多人時每人各發一則；部分失敗仍成立；先到的決定為準且所有副本一起改寫', async () => {
  const h = harness([String(U1), String(U2), String(U3)])
  h.failChats.add(U3)
  expect((await h.service.create(input('R6'))).ok).toBe(true)
  const sent = sentRequests(h)
  expect(sent.map(s => s.chatId)).toEqual([U1, U2])

  await h.service.interceptUpdate(press('appr:deny:R6', U2, sent[1].messageId))
  await h.service.interceptUpdate(press('appr:allow:R6', U1, sent[0].messageId))
  expect(h.service.get('R6')).toMatchObject({ status: 'denied', decision: 'deny' })
  expect(edits(h).map(e => [e.chatId, e.messageId])).toEqual([
    [U1, sent[0].messageId],
    [U2, sent[1].messageId],
  ])
})

test('allowFrom 使用者按允許：結果 approved、回應 callback、訊息改為已允許', async () => {
  const h = harness()
  const messageId = await createOne(h, 'R10')
  expect(await h.service.interceptUpdate(press('appr:allow:R10', U1, messageId))).toBe(true)
  expect(h.service.get('R10')).toMatchObject({ status: 'approved', decision: 'allow' })
  expect(answers(h)).toHaveLength(1)
  expect(edits(h)).toEqual([{ method: 'editText', chatId: U1, messageId, text: '請求 R10\n\n[已允許]' }])
})

test('allowFrom 使用者按拒絕：結果 denied、訊息改為已拒絕', async () => {
  const h = harness()
  const messageId = await createOne(h, 'R10')
  await h.service.interceptUpdate(press('appr:deny:R10', U1, messageId))
  expect(h.service.get('R10')).toMatchObject({ status: 'denied', decision: 'deny', comment: null })
  expect(edits(h)[0].text).toBe('請求 R10\n\n[已拒絕]')
})

test('allowFrom 使用者按 approve：結果 approved、訊息改為已 approve', async () => {
  const h = harness()
  const messageId = await createOne(h, 'R11', 'approve_reject')
  await h.service.interceptUpdate(press('appr:approve:R11', U1, messageId))
  expect(h.service.get('R11')).toMatchObject({ status: 'approved', decision: 'approve' })
  expect(edits(h)[0].text).toBe('請求 R11\n\n[已 approve]')
})

test('非 allowFrom 的人按按鈕無效：以按的人為準，不看訊息所在的 chat', async () => {
  const h = harness()
  const messageId = await createOne(h, 'R12')
  expect(await h.service.interceptUpdate(press('appr:allow:R12', U2, messageId, U1))).toBe(true)
  expect(h.service.get('R12')?.status).toBe('pending')
  expect(edits(h)).toEqual([])
  expect(answers(h)[0].text).toBe('沒有權限。')

  await h.service.interceptUpdate(press('appr:deny:R12', U1, messageId))
  expect(h.service.get('R12')?.status).toBe('denied')
})

test('偽造 / 不相符的 callback data 不改任何狀態', async () => {
  const h = harness()
  const messageId = await createOne(h, 'R13')
  const otherMessageId = await createOne(h, 'OTHER')
  const forged = [
    press('appr:allow:NOPE', U1, messageId),
    press('appr:', U1, messageId),
    press('appr:allow', U1, messageId),
    press('appr:grant:R13', U1, messageId),
    press('appr:allow:R13:extra', U1, messageId),
    press('appr:approve:R13', U1, messageId),
    press('appr:allow:R13', U1, otherMessageId),
    press('appr:allow:R13', U1, 424242),
  ]
  for (const update of forged) expect(await h.service.interceptUpdate(update)).toBe(true)
  expect(h.service.get('R13')?.status).toBe('pending')
  expect(h.service.get('OTHER')?.status).toBe('pending')
  expect(edits(h)).toEqual([])
  expect(answers(h)).toHaveLength(forged.length)
})

test('沒有附訊息的 callback 不改狀態', async () => {
  const h = harness()
  await createOne(h, 'R13')
  const update = press('appr:allow:R13', U1, 1)
  delete (update.callback_query as { message?: unknown }).message
  expect(await h.service.interceptUpdate(update)).toBe(true)
  expect(h.service.get('R13')?.status).toBe('pending')
})

test('非 appr: 開頭的 callback（例 perm:）不攔截', async () => {
  const h = harness()
  expect(await h.service.interceptUpdate(press('perm:allow:abcde', U1, 1))).toBe(false)
  expect(await h.service.interceptUpdate(press('anything', U1, 1))).toBe(false)
  expect(h.calls).toEqual([])
})

test('已有結果後再按不翻盤，後到的 callback 仍被回應', async () => {
  const h = harness()
  const r14 = await createOne(h, 'R14')
  await h.service.interceptUpdate(press('appr:deny:R14', U1, r14))
  await h.service.interceptUpdate(press('appr:allow:R14', U1, r14))
  expect(h.service.get('R14')).toMatchObject({ status: 'denied', decision: 'deny' })

  const r15 = await createOne(h, 'R15')
  await h.service.interceptUpdate(press('appr:allow:R15', U1, r15))
  await h.service.interceptUpdate(press('appr:deny:R15', U1, r15))
  expect(h.service.get('R15')).toMatchObject({ status: 'approved', decision: 'allow' })
  expect(answers(h)).toHaveLength(4)
  expect(edits(h)).toHaveLength(2)
})

test('多筆請求並行互不干擾', async () => {
  const h = harness()
  await createOne(h, 'R16')
  const r17 = await createOne(h, 'R17')
  await createOne(h, 'R18')
  await h.service.interceptUpdate(press('appr:allow:R17', U1, r17))
  expect(h.service.get('R16')?.status).toBe('pending')
  expect(h.service.get('R17')?.status).toBe('approved')
  expect(h.service.get('R18')?.status).toBe('pending')
  expect(edits(h).map(e => e.messageId)).toEqual([r17])
})

test('改訊息 / 回應 callback 失敗時，決定仍然記錄', async () => {
  const h = harness()
  const messageId = await createOne(h, 'R19')
  h.fail.add('editText')
  h.fail.add('answerCallback')
  expect(await h.service.interceptUpdate(press('appr:allow:R19', U1, messageId))).toBe(true)
  expect(h.service.get('R19')?.status).toBe('approved')
})

test('按退回後發提示；引用回覆提示訊息才記為退回 + 意見，且該回覆被吃掉', async () => {
  const h = harness()
  const messageId = await createOne(h, 'R20', 'approve_reject')
  await h.service.interceptUpdate(press('appr:reject:R20', U1, messageId))
  expect(h.service.get('R20')).toMatchObject({ status: 'awaiting_comment', decision: 'reject', comment: null })
  const [prompt] = prompts(h)
  expect(prompt.chatId).toBe(U1)
  expect(prompt.replyTo).toBe(messageId)
  expect(prompt.text).toContain('回覆')
  expect(edits(h)[0].text).toBe('請求 R20\n\n[已按退回] 等待意見中')

  const comment = '範圍要再縮小，拿掉 X'
  expect(await h.service.interceptUpdate(message(U1, comment, prompt.messageId))).toBe(true)
  expect(h.service.get('R20')).toMatchObject({ status: 'denied', decision: 'reject', comment })
  expect(edits(h)[1].text).toBe(`請求 R20\n\n[已退回] 意見：${comment}`)
})

test('引用回覆原請求訊息也算意見', async () => {
  const h = harness()
  const messageId = await createOne(h, 'R20', 'approve_reject')
  await h.service.interceptUpdate(press('appr:reject:R20', U1, messageId))
  expect(await h.service.interceptUpdate(message(U1, '意見', messageId))).toBe(true)
  expect(h.service.get('R20')?.comment).toBe('意見')
})

test('提示訊息發送失敗時仍可回覆原請求訊息寫意見', async () => {
  const h = harness()
  const messageId = await createOne(h, 'R20', 'approve_reject')
  h.fail.add('sendPrompt')
  await h.service.interceptUpdate(press('appr:reject:R20', U1, messageId))
  expect(h.service.get('R20')?.status).toBe('awaiting_comment')
  await h.service.interceptUpdate(message(U1, '意見', messageId))
  expect(h.service.get('R20')?.comment).toBe('意見')
})

test('按退回後逾時未回覆 -> 無意見退回，訊息標示無意見', async () => {
  const h = harness()
  const messageId = await createOne(h, 'R21', 'approve_reject')
  await h.service.interceptUpdate(press('appr:reject:R21', U1, messageId))
  h.advance(COMMENT_TIMEOUT_SECONDS * 1000)
  await h.service.sweep()
  expect(h.service.get('R21')).toMatchObject({ status: 'denied', decision: 'reject', comment: '' })
  expect(edits(h).at(-1)?.text).toBe('請求 R21\n\n[已退回]（無意見）')
})

test('非 allowFrom 的人與 bot 自身的回覆不算意見，也不被吃掉', async () => {
  const h = harness()
  const messageId = await createOne(h, 'R22', 'approve_reject')
  await h.service.interceptUpdate(press('appr:reject:R22', U1, messageId))
  const promptId = prompts(h)[0].messageId

  expect(await h.service.interceptUpdate(message(U2, '假意見', promptId, { chatId: U1 }))).toBe(false)
  expect(await h.service.interceptUpdate(message(BOT_ID, '假意見', promptId, { isBot: true, chatId: U1 }))).toBe(false)
  expect(await h.service.interceptUpdate(message(U1, '假意見', promptId, { isBot: true }))).toBe(false)
  expect(h.service.get('R22')?.status).toBe('awaiting_comment')

  await h.service.interceptUpdate(message(U1, '真正意見', promptId))
  expect(h.service.get('R22')).toMatchObject({ status: 'denied', comment: '真正意見' })
})

test('未引用任何訊息的一般 DM 不算意見、不被吃掉', async () => {
  const h = harness()
  const messageId = await createOne(h, 'R23', 'approve_reject')
  await h.service.interceptUpdate(press('appr:reject:R23', U1, messageId))
  expect(await h.service.interceptUpdate(message(U1, '只是一般訊息'))).toBe(false)
  expect(await h.service.interceptUpdate(message(U1, '回別則訊息', 31337))).toBe(false)
  expect(h.service.get('R23')?.status).toBe('awaiting_comment')
})

test('請求還在 pending 時回覆該訊息不算意見、不被吃掉', async () => {
  const h = harness()
  const messageId = await createOne(h, 'R23', 'approve_reject')
  expect(await h.service.interceptUpdate(message(U1, '先問個問題', messageId))).toBe(false)
  expect(h.service.get('R23')?.status).toBe('pending')
})

test('按退回後不得再改成 approve', async () => {
  const h = harness()
  const messageId = await createOne(h, 'R24', 'approve_reject')
  await h.service.interceptUpdate(press('appr:reject:R24', U1, messageId))
  await h.service.interceptUpdate(press('appr:approve:R24', U1, messageId))
  expect(h.service.get('R24')?.status).toBe('awaiting_comment')
  await h.service.interceptUpdate(message(U1, '意見', prompts(h)[0].messageId))
  expect(h.service.get('R24')).toMatchObject({ status: 'denied', decision: 'reject', comment: '意見' })
})

test('意見含多行與特殊字元時逐字保留', async () => {
  const h = harness()
  const messageId = await createOne(h, 'R26', 'approve_reject')
  await h.service.interceptUpdate(press('appr:reject:R26', U1, messageId))
  const comment = '第一行\n第二行 <b>&amp;</b> "引號" \'單引號\' _*[]`\\'
  await h.service.interceptUpdate(message(U1, comment, prompts(h)[0].messageId))
  expect(h.service.get('R26')?.comment).toBe(comment)
})

test('以非文字（貼圖）回覆時提示改用文字、吃掉該則、繼續等意見', async () => {
  const h = harness()
  const messageId = await createOne(h, 'R27', 'approve_reject')
  await h.service.interceptUpdate(press('appr:reject:R27', U1, messageId))
  expect(await h.service.interceptUpdate(message(U1, undefined, prompts(h)[0].messageId))).toBe(true)
  expect(h.service.get('R27')?.status).toBe('awaiting_comment')
  expect(h.calls.at(-1)).toEqual({ method: 'sendText', chatId: U1, text: '[等你回覆] OP-8820: 請用文字回覆意見。' })
})

test('等意見期間被取消 -> cancelled，晚到回覆提示的意見不改結果、不轉給 session', async () => {
  const h = harness()
  const messageId = await createOne(h, 'R25', 'approve_reject')
  await h.service.interceptUpdate(press('appr:reject:R25', U1, messageId))
  await h.service.cancel('R25')
  expect(h.service.get('R25')?.status).toBe('cancelled')
  expect(await h.service.interceptUpdate(message(U1, '晚到', prompts(h)[0].messageId))).toBe(true)
  expect(h.calls.at(-1)).toEqual({ method: 'sendText', chatId: U1, text: '[系統] OP-8820: 這筆請求已經結案，這則意見沒有被記錄。' })
  expect(h.service.get('R25')).toMatchObject({ status: 'cancelled', comment: null })
})

test('取消 pending 請求：訊息改為已在電腦處理，之後按允許無效', async () => {
  const h = harness()
  const messageId = await createOne(h, 'R30')
  expect((await h.service.cancel('R30'))?.status).toBe('cancelled')
  expect(edits(h)).toEqual([{ method: 'editText', chatId: U1, messageId, text: '請求 R30\n\n[已在電腦處理]' }])
  await h.service.interceptUpdate(press('appr:allow:R30', U1, messageId))
  expect(h.service.get('R30')).toMatchObject({ status: 'cancelled', decision: null })
})

test('取消已有結果的請求：保留原結果、不再改訊息', async () => {
  const h = harness()
  const messageId = await createOne(h, 'R31')
  await h.service.interceptUpdate(press('appr:allow:R31', U1, messageId))
  expect((await h.service.cancel('R31'))?.status).toBe('approved')
  expect(edits(h)).toHaveLength(1)
})

test('取消不存在的 id 回 undefined；重複取消冪等且不再改訊息', async () => {
  const h = harness()
  expect(await h.service.cancel('nope')).toBeUndefined()
  await createOne(h, 'R30')
  await h.service.cancel('R30')
  expect((await h.service.cancel('R30'))?.status).toBe('cancelled')
  expect(edits(h)).toHaveLength(1)
})

test('逾時：狀態 expired、訊息標示已逾時，之後按按鈕無效', async () => {
  const h = harness()
  const messageId = await createOne(h, 'R32')
  h.advance(TIMEOUT_SECONDS * 1000)
  await h.service.sweep()
  expect(h.service.get('R32')?.status).toBe('expired')
  expect(edits(h)).toEqual([{ method: 'editText', chatId: U1, messageId, text: '請求 R32\n\n[已逾時]' }])
  await h.service.interceptUpdate(press('appr:allow:R32', U1, messageId))
  expect(h.service.get('R32')).toMatchObject({ status: 'expired', decision: null })
})

test('查詢本身就會套用時鐘：不必等背景掃描', async () => {
  const h = harness()
  await createOne(h, 'R33')
  h.advance(TIMEOUT_SECONDS * 1000)
  expect(h.service.get('R33')?.status).toBe('expired')
})

test('超過期限才到的按鈕不會被記為允許', async () => {
  const h = harness()
  const messageId = await createOne(h, 'R34')
  h.advance(TIMEOUT_SECONDS * 1000)
  await h.service.interceptUpdate(press('appr:allow:R34', U1, messageId))
  expect(h.service.get('R34')?.status).toBe('expired')
})

test('等意見期間以 / 開頭的回覆不當意見、不被吃掉', async () => {
  const h = harness()
  const messageId = await createOne(h, 'R28', 'approve_reject')
  await h.service.interceptUpdate(press('appr:reject:R28', U1, messageId))
  expect(await h.service.interceptUpdate(message(U1, '/restart', prompts(h)[0].messageId))).toBe(false)
  expect(await h.service.interceptUpdate(message(U1, '/ctx', messageId))).toBe(false)
  expect(h.service.get('R28')?.status).toBe('awaiting_comment')
})

test('意見逾時後回覆提示訊息：吃掉並告知已結案；回覆原請求訊息或非 allowFrom 的人則照常放行', async () => {
  const h = harness()
  const messageId = await createOne(h, 'R29', 'approve_reject')
  await h.service.interceptUpdate(press('appr:reject:R29', U1, messageId))
  const promptId = prompts(h)[0].messageId
  h.advance(COMMENT_TIMEOUT_SECONDS * 1000)

  expect(await h.service.interceptUpdate(message(U2, '外人', promptId, { chatId: U1 }))).toBe(false)
  expect(await h.service.interceptUpdate(message(U1, '回原訊息', messageId))).toBe(false)
  expect(await h.service.interceptUpdate(message(U1, '遲到的意見', promptId))).toBe(true)
  expect(h.calls.at(-1)).toEqual({ method: 'sendText', chatId: U1, text: '[系統] OP-8820: 這筆請求已經結案，這則意見沒有被記錄。' })
  expect(h.service.get('R29')).toMatchObject({ status: 'denied', comment: '' })
})

test('service 對外沒有任何寫入決定的動作', () => {
  expect(Object.keys(harness().service).sort()).toEqual(
    ['cancel', 'consume', 'create', 'get', 'interceptUpdate', 'start', 'sweep'].sort(),
  )
})

const SESSION = 'session-1111'
const DANGEROUS_SUBJECT = 'git push --force origin main'
const BINDING: ApprovalBinding = { session: SESSION, subject: DANGEROUS_SUBJECT }
const BLOCK_HEADER = '【綁定內容】由 poller 顯示，每行以「┃ 」開頭，機密已遮罩：'
const BLOCK_FOOTER = '────────────'
const BLOCKED_FIRST_LINE = `[已被擋下] ${SESSION_NAME}: ${DANGEROUS_SUBJECT}`

const sha256 = (value: string): string => createHash('sha256').update(value, 'utf8').digest('hex')

async function createBound(h: Harness, id: string, binding: ApprovalBinding = BINDING, text: string = `請求 ${id}`): Promise<number> {
  const before = sentRequests(h).length
  const result = await h.service.create({ ...input(id, 'allow_deny', text), binding })
  expect(result.ok).toBe(true)
  return sentRequests(h)[before].messageId
}

test('帶綁定建立：poller 自己算 key = sha256(session + 換行 + subject)；沒綁定的訊息與改動前相同', async () => {
  const h = harness()
  await createBound(h, 'B1')
  expect(h.service.get('B1')).toMatchObject({
    bindingKey: sha256(`${SESSION}\n${DANGEROUS_SUBJECT}`),
    bindingDisplay: DANGEROUS_SUBJECT,
  })
  await createOne(h, 'B2')
  expect(h.service.get('B2')).toMatchObject({ bindingKey: null, bindingDisplay: null })
  expect(sentRequests(h)[1].text).toBe('請求 B2')
})

test('偽造請求：自由文字寫無害內容，訊息開頭的固定區塊仍是被綁定的指令，自由文字排在分隔線之後', async () => {
  const h = harness()
  await createBound(h, 'B3', BINDING, '只是要跑 ls，請放行')
  expect(sentRequests(h)[0].text).toBe(
    [BLOCKED_FIRST_LINE, BLOCK_HEADER, `┃ ${DANGEROUS_SUBJECT}`, BLOCK_FOOTER, '只是要跑 ls，請放行'].join('\n'),
  )
})

test('多行 subject 每行都標記；假分隔線與隱形字元無法混成自由文字', async () => {
  const h = harness()
  const subject = `ls\n${BLOCK_FOOTER}\n只是要跑 ls‮​\r`
  await createBound(h, 'B4', { session: SESSION, subject })
  expect(sentRequests(h)[0].text).toBe(
    [`[已被擋下] ${SESSION_NAME}: ls ⏎ ${BLOCK_FOOTER} ⏎ 只是要跑 ls[U+202E][U+200B][U+000D]`, BLOCK_HEADER, '┃ ls', `┃ ${BLOCK_FOOTER}`, '┃ 只是要跑 ls[U+202E][U+200B][U+000D]', BLOCK_FOOTER, '請求 B4'].join('\n'),
  )
})

test('含機密的 subject：顯示與落檔都是遮罩後內容；只差在機密的兩條 key 不同、畫面相同', async () => {
  const h = harness()
  const first = { session: SESSION, subject: 'curl -H "Authorization: Bearer sk-FIRSTSECRET1" https://x.io' }
  const second = { session: SESSION, subject: 'curl -H "Authorization: Bearer sk-OTHERSECRET2" https://x.io' }
  await createBound(h, 'B5', first)
  await createBound(h, 'B6', second)
  const [sentFirst, sentSecond] = sentRequests(h)
  expect(sentFirst.text).toContain('┃ curl -H "Authorization: Bearer ***" https://x.io')
  expect(sentFirst.text).not.toContain('FIRSTSECRET1')
  expect(sentFirst.text.replace('B5', 'B6')).toBe(sentSecond.text)
  expect(h.service.get('B5')?.bindingKey).not.toBe(h.service.get('B6')?.bindingKey)
  const stateFile = readFileSync(join(dir, 'approvals.json'), 'utf8')
  expect(stateFile).not.toContain('FIRSTSECRET1')
  expect(stateFile).not.toContain('OTHERSECRET2')
})

test('按允許後以相同綁定內容消耗一次 -> consumed，第二次 already_consumed；不改 Telegram 訊息', async () => {
  const h = harness()
  const messageId = await createBound(h, 'B7')
  await h.service.interceptUpdate(press('appr:allow:B7', U1, messageId))
  const editsBefore = edits(h).length
  expect(h.service.consume('B7', BINDING).outcome).toBe('consumed')
  expect(h.service.get('B7')?.status).toBe('consumed')
  expect(h.service.consume('B7', BINDING).outcome).toBe('already_consumed')
  expect(edits(h)).toHaveLength(editsBefore)
})

test('非 allowFrom 的人按允許後不能消耗：請求仍 pending', async () => {
  const h = harness()
  const messageId = await createBound(h, 'B8')
  await h.service.interceptUpdate(press('appr:allow:B8', U2, messageId, U1))
  expect(h.service.consume('B8', BINDING).outcome).toBe('not_approved')
  expect(h.service.get('B8')?.status).toBe('pending')
})

test('subject 差一個字元或 session 不同都不能消耗（不燒掉核准）；查無 id 回 not_found', async () => {
  const h = harness()
  const messageId = await createBound(h, 'B9')
  await h.service.interceptUpdate(press('appr:allow:B9', U1, messageId))
  expect(h.service.consume('B9', { session: SESSION, subject: `${DANGEROUS_SUBJECT} ` }).outcome).toBe('binding_mismatch')
  expect(h.service.consume('B9', { session: 'session-2222', subject: DANGEROUS_SUBJECT }).outcome).toBe('binding_mismatch')
  expect(h.service.get('B9')?.status).toBe('approved')
  expect(h.service.consume('nope', BINDING).outcome).toBe('not_found')
  expect(h.service.consume('B9', BINDING).outcome).toBe('consumed')
})

test('消耗前先套用時鐘：逾時的 pending 先轉 expired，回 not_approved，訊息在背景改為已逾時（區塊保留）', async () => {
  const h = harness()
  await createBound(h, 'B10')
  h.advance(TIMEOUT_SECONDS * 1000)
  expect(h.service.consume('B10', BINDING).outcome).toBe('not_approved')
  expect(h.store.get('B10')?.status).toBe('expired')
  await Promise.resolve()
  expect(edits(h).at(-1)?.text).toBe(
    [BLOCKED_FIRST_LINE, BLOCK_HEADER, `┃ ${DANGEROUS_SUBJECT}`, BLOCK_FOOTER, '請求 B10', '', '[已逾時]'].join('\n'),
  )
})

test('有綁定的請求終態文字超過上限時從尾端截斷，開頭的第一行與綁定區塊完整保留', async () => {
  const h = harness()
  const messageId = await createBound(h, 'B11')
  await h.service.interceptUpdate(press('appr:deny:B11', U1, messageId))
  const request = h.store.get('B11')
  expect(request).toBeDefined()
  if (!request) return
  const rendered = renderApprovalText({ ...request, text: '長'.repeat(5000) })
  expect(rendered.length).toBe(4096)
  expect(rendered.startsWith([BLOCKED_FIRST_LINE, BLOCK_HEADER, `┃ ${DANGEROUS_SUBJECT}`, BLOCK_FOOTER].join('\n'))).toBe(true)
})

test('終態文字超過 Telegram 上限時截斷', async () => {
  const h = harness()
  const messageId = await createOne(h, 'R35', 'approve_reject')
  await h.service.interceptUpdate(press('appr:reject:R35', U1, messageId))
  const request = h.store.recordComment('R35', '長'.repeat(5000))
  expect(request).toBeDefined()
  if (request) expect(renderApprovalText(request).length).toBe(4096)
})

test('退回意見提示第一行為 [等你回覆] <session name>:，引用原請求訊息', async () => {
  const h = harness()
  const messageId = await createOne(h, 'F1', 'approve_reject')
  await h.service.interceptUpdate(press('appr:reject:F1', U1, messageId))
  const [prompt] = prompts(h)
  expect(prompt.replyTo).toBe(messageId)
  expect(prompt.text.split('\n')[0]).toBe(`[等你回覆] ${SESSION_NAME}: 請「回覆」這則訊息寫下退回意見。5 秒內沒有回覆，會記為無意見退回。`)
})

test('session name 記在請求上：沒有綁定的請求訊息仍是呼叫端文字原樣，不由 poller 加第一行', async () => {
  const h = harness()
  await h.service.create(input('F2', 'approve_reject', '[等 approve] OP-8820: JP-379 Spec 可以 approve 嗎？'))
  expect(h.service.get('F2')?.sessionName).toBe(SESSION_NAME)
  expect(sentRequests(h)[0].text).toBe('[等 approve] OP-8820: JP-379 Spec 可以 approve 嗎？')
})

test('已被擋下的結果標籤加在末尾，第一行維持 [已被擋下]', async () => {
  const h = harness()
  const messageId = await createBound(h, 'F3')
  await h.service.interceptUpdate(press('appr:allow:F3', U1, messageId))
  const text = edits(h).at(-1)?.text ?? ''
  expect(text.split('\n')[0]).toBe(BLOCKED_FIRST_LINE)
  expect(text.endsWith('\n\n[已允許]')).toBe(true)
})
