import { expect, test } from 'bun:test'
import type { Update } from 'grammy/types'
import { ScopeRegistry } from './poller-registry'
import { isValidScopeId } from './scope-id'
import type { MessageMapEntry } from './message-map'
import {
  authorizeSessionSubscription,
  buildSessionScopeId,
  isSessionScopeId,
  resolveMessageMapFile,
  resolvePollerSessionDirect,
  resolveReplyDirectScope,
} from './session-direct'

const SESSION_ID = 'CE12D202-2BF1-4502-BEF0-8967233BD2D9'
const SESSION_SCOPE = 'telegram-dm-sce12d2022bf14502bef08967233bd2d9'
const BOT_ID = 4242
const USER_ID = 555

test('專屬 scope：由 session id 決定論地算出，且符合既有 scope 格式', () => {
  expect(buildSessionScopeId(SESSION_ID)).toBe(SESSION_SCOPE)
  expect(buildSessionScopeId(` ${SESSION_ID.toLowerCase()} `)).toBe(SESSION_SCOPE)
  expect(isValidScopeId(SESSION_SCOPE)).toBe(true)
  expect(isSessionScopeId(SESSION_SCOPE)).toBe(true)
})

test('專屬 scope：session id 不是 UUID 就不給 scope', () => {
  for (const bad of ['', 'abc', '125dc7c7981d4d27bf53de4df1c0b01f', '../../etc', `${SESSION_ID}x`]) {
    expect(buildSessionScopeId(bad)).toBeUndefined()
  }
})

test('專屬 scope 永遠不會等於中控或任何 poller 自己算出的 scope', () => {
  for (const scope of ['telegram-dm-555', 'telegram-dm-n1001', 'telegram-group-n1001234567890', 'telegram-dm-s1']) {
    expect(isSessionScopeId(scope)).toBe(false)
  }
})

test('poller 開關：預設關、只認 1 / true，且必須有絕對路徑的 map 檔', () => {
  expect(resolvePollerSessionDirect({})).toEqual({ enabled: false, reason: 'unset' })
  expect(resolvePollerSessionDirect({ TELEGRAM_SESSION_DIRECT: 'yes' }).enabled).toBe(false)
  expect(resolvePollerSessionDirect({ TELEGRAM_SESSION_DIRECT: '1' }).enabled).toBe(false)
  expect(
    resolvePollerSessionDirect({ TELEGRAM_SESSION_DIRECT: '1', TELEGRAM_MESSAGE_MAP_FILE: 'rel/map.jsonl' }).enabled,
  ).toBe(false)
  expect(
    resolvePollerSessionDirect({ TELEGRAM_SESSION_DIRECT: ' TRUE ', TELEGRAM_MESSAGE_MAP_FILE: '/x/map.jsonl' }),
  ).toEqual({ enabled: true, mapFile: '/x/map.jsonl' })
})

test('map 路徑：只收絕對路徑', () => {
  expect(resolveMessageMapFile({})).toBeUndefined()
  expect(resolveMessageMapFile({ TELEGRAM_MESSAGE_MAP_FILE: ' rel/x ' })).toBeUndefined()
  expect(resolveMessageMapFile({ TELEGRAM_MESSAGE_MAP_FILE: ' /a/b.jsonl ' })).toBe('/a/b.jsonl')
})

test('authorize：非專屬 scope 一律放行（行為不變）', () => {
  const registry = new ScopeRegistry({ maxScopes: 1, maxQueue: 1 })
  registry.onSubscribed('telegram-dm-1')
  expect(authorizeSessionSubscription('telegram-dm-2', { enabled: false, registry, maxScopes: 1 })).toBe(true)
})

test('authorize：開關關閉時拒絕專屬 scope', () => {
  const registry = new ScopeRegistry({ maxScopes: 5, maxQueue: 1 })
  expect(authorizeSessionSubscription(SESSION_SCOPE, { enabled: false, registry, maxScopes: 5 })).toBe(false)
})

test('authorize：總在線數到上限時拒絕新的專屬 scope，已在線的重連放行', () => {
  const registry = new ScopeRegistry({ maxScopes: 2, maxQueue: 1, isCapExempt: isSessionScopeId })
  registry.onSubscribed('telegram-dm-555')
  expect(authorizeSessionSubscription(SESSION_SCOPE, { enabled: true, registry, maxScopes: 2 })).toBe(true)
  registry.onSubscribed(SESSION_SCOPE)
  const other = buildSessionScopeId('00000000-0000-4000-8000-000000000001')!
  expect(authorizeSessionSubscription(other, { enabled: true, registry, maxScopes: 2 })).toBe(false)
  expect(authorizeSessionSubscription(SESSION_SCOPE, { enabled: true, registry, maxScopes: 2 })).toBe(true)
})

test('authorize：斷線的不佔名額（沿用 JP-384 算法）', () => {
  const registry = new ScopeRegistry({ maxScopes: 1, maxQueue: 1, isCapExempt: isSessionScopeId })
  registry.onSubscribed('telegram-dm-555')
  registry.onDisconnected('telegram-dm-555')
  expect(authorizeSessionSubscription(SESSION_SCOPE, { enabled: true, registry, maxScopes: 1 })).toBe(true)
})

type ReplyOpts = {
  chatType?: string
  fromId?: number
  repliedFrom?: number | null
  text?: string
  chatId?: number
  repliedId?: number
}

const replyUpdate = (opts: ReplyOpts = {}): Update =>
  ({
    update_id: 1,
    message: {
      message_id: 9001,
      date: 0,
      text: opts.text ?? '好，照這樣做',
      from: { id: opts.fromId ?? USER_ID, is_bot: false, first_name: 'u' },
      chat: { id: opts.chatId ?? USER_ID, type: opts.chatType ?? 'private', first_name: 'u' },
      ...(opts.repliedFrom === null
        ? {}
        : {
            reply_to_message: {
              message_id: opts.repliedId ?? 3332,
              date: 0,
              text: '[等你] JP-384: 要繼續嗎？',
              from: { id: opts.repliedFrom ?? BOT_ID, is_bot: true, first_name: 'bot' },
              chat: { id: opts.chatId ?? USER_ID, type: 'private', first_name: 'u' },
            },
          }),
    },
  }) as unknown as Update

const map = new Map<number, MessageMapEntry>([
  [3332, { sessionId: SESSION_ID }],
  [3340, { sessionId: SESSION_ID, chatId: String(USER_ID) }],
  [3341, { sessionId: SESSION_ID, chatId: '777' }],
  [3350, { sessionId: 'not-a-uuid' }],
])
const deps = { botId: BOT_ID, allowFrom: () => [String(USER_ID)], lookup: (id: number) => map.get(id) }

test('直送：私訊回覆 bot 訊息且查得到 -> 該 session 的 scope', () => {
  expect(resolveReplyDirectScope(replyUpdate(), deps)).toBe(SESSION_SCOPE)
})

test('直送：map 記了 chat_id 時必須是同一個 chat', () => {
  expect(resolveReplyDirectScope(replyUpdate({ repliedId: 3340 }), deps)).toBe(SESSION_SCOPE)
  expect(resolveReplyDirectScope(replyUpdate({ repliedId: 3341 }), deps)).toBeUndefined()
})

test('不直送：沒有回覆 / 回覆的不是 bot / 群組 / 查不到 / session id 壞掉', () => {
  expect(resolveReplyDirectScope(replyUpdate({ repliedFrom: null }), deps)).toBeUndefined()
  expect(resolveReplyDirectScope(replyUpdate({ repliedFrom: USER_ID }), deps)).toBeUndefined()
  expect(resolveReplyDirectScope(replyUpdate({ chatType: 'supergroup', chatId: -1001 }), deps)).toBeUndefined()
  expect(resolveReplyDirectScope(replyUpdate({ repliedId: 1 }), deps)).toBeUndefined()
  expect(resolveReplyDirectScope(replyUpdate({ repliedId: 3350 }), deps)).toBeUndefined()
})

test('不直送：發話者不在 allowFrom（交給中控的 gate 處理）', () => {
  expect(resolveReplyDirectScope(replyUpdate({ fromId: 999, chatId: 999 }), deps)).toBeUndefined()
  expect(resolveReplyDirectScope(replyUpdate(), { ...deps, allowFrom: () => [] })).toBeUndefined()
})

test('不直送：/指令 留給中控（控制指令與 /reauth 類都不分流）', () => {
  expect(resolveReplyDirectScope(replyUpdate({ text: '/status' }), deps)).toBeUndefined()
})

test('不直送：callback_query 與 edited_message 不看', () => {
  const callback = { update_id: 2, callback_query: { id: 'q', from: { id: USER_ID }, data: 'perm:allow:abcde' } }
  expect(resolveReplyDirectScope(callback as unknown as Update, deps)).toBeUndefined()
  const edited = { update_id: 3, edited_message: (replyUpdate() as { message: unknown }).message }
  expect(resolveReplyDirectScope(edited as unknown as Update, deps)).toBeUndefined()
})
