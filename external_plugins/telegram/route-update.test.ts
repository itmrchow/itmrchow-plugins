import { expect, test } from 'bun:test'
import type { Update } from 'grammy/types'
import { ScopeRegistry } from './poller-registry'
import {
  consumeUpdates,
  resolveUpdateScope,
  routeUpdate,
  type RouteContext,
  type SpawnOutcome,
} from './route-update'
import type { InboundEnvelope } from './subscribe-protocol'

const privateUpdate = (updateId = 1, userId = 555, chatId = 555): Update =>
  ({
    update_id: updateId,
    message: {
      message_id: updateId,
      date: 0,
      text: 'hi',
      from: { id: userId, is_bot: false, first_name: 'u' },
      chat: { id: chatId, type: 'private', first_name: 'u' },
    },
  }) as unknown as Update

const groupUpdate = (updateId = 1, chatId = -1001234567890): Update =>
  ({
    update_id: updateId,
    message: {
      message_id: updateId,
      date: 0,
      text: 'hi',
      from: { id: 555, is_bot: false, first_name: 'u' },
      chat: { id: chatId, type: 'supergroup', title: 'g' },
    },
  }) as unknown as Update

type Harness = {
  ctx: RouteContext
  delivered: InboundEnvelope[]
  spawned: string[]
  notified: { chatId: number; text: string }[]
  timers: (() => void)[]
}

function harness(opts: {
  spawn?: SpawnOutcome
  deliverOk?: boolean
  maxScopes?: number
  maxQueue?: number
} = {}): Harness {
  const delivered: InboundEnvelope[] = []
  const spawned: string[] = []
  const notified: { chatId: number; text: string }[] = []
  const timers: (() => void)[] = []
  const registry = new ScopeRegistry({
    maxScopes: opts.maxScopes ?? 5,
    maxQueue: opts.maxQueue ?? 5,
  })
  const ctx: RouteContext = {
    registry,
    deliver: (_scopeId, envelopes) => {
      if (opts.deliverOk === false) return false
      delivered.push(...envelopes)
      return true
    },
    spawn: async scopeId => {
      spawned.push(scopeId)
      return opts.spawn ?? 'ok'
    },
    notify: async (chatId, text) => void notified.push({ chatId, text }),
    setTimer: fn => void timers.push(fn),
  }
  return { ctx, delivered, spawned, notified, timers }
}

test('私訊的 scope 錨在發話者身上', () => {
  expect(resolveUpdateScope(privateUpdate(1, 555, 555))).toEqual({
    kind: 'dm',
    anchorId: 555,
    chatId: 555,
  })
})

test('群組的 scope 錨在聊天室，負數 id 原樣帶出（由 buildScopeId 轉 n 前綴）', () => {
  expect(resolveUpdateScope(groupUpdate(1, -1001234567890))).toEqual({
    kind: 'group',
    anchorId: -1001234567890,
    chatId: -1001234567890,
  })
})

test('沒有 chat 的 update 不屬於任何 scope', () => {
  expect(resolveUpdateScope({ update_id: 9, poll: { id: 'p' } } as unknown as Update)).toBeNull()
})

test('群組訊息的 scope-id 走 n 前綴，不會產生前導負號', async () => {
  const h = harness()
  await routeUpdate(groupUpdate(1, -1001234567890), h.ctx)
  expect(h.spawned).toEqual(['telegram-group-n1001234567890'])
})

test('全新身分觸發 spawn，訊息留在佇列等訂閱', async () => {
  const h = harness()
  await routeUpdate(privateUpdate(1), h.ctx)
  expect(h.spawned).toEqual(['telegram-dm-555'])
  expect(h.delivered).toEqual([])
  expect(h.ctx.registry.state('telegram-dm-555')).toBe('connecting')
})

test('已連線的 scope 直接投遞，且帶上 botInfo', async () => {
  const h = harness()
  h.ctx.botInfo = { id: 7, username: 'bot' }
  await routeUpdate(privateUpdate(1), h.ctx)
  h.ctx.registry.onSubscribed('telegram-dm-555')
  await routeUpdate(privateUpdate(2), h.ctx)
  expect(h.delivered.length).toBe(1)
  expect(h.delivered[0].botInfo).toEqual({ id: 7, username: 'bot' })
  expect((h.delivered[0].payload as Update).update_id).toBe(2)
})

test('投遞當下連線剛斷：訊息回佇列而不是寫進死掉的 socket', async () => {
  const h = harness({ deliverOk: false })
  await routeUpdate(privateUpdate(1), h.ctx)
  h.ctx.registry.onSubscribed('telegram-dm-555')
  await routeUpdate(privateUpdate(2), h.ctx)
  expect(h.ctx.registry.state('telegram-dm-555')).toBe('disconnected')
  expect(h.ctx.registry.onSubscribed('telegram-dm-555').length).toBe(1)
})

test('spawn 回報容量已滿：清掉 entry 並回覆使用者', async () => {
  const h = harness({ spawn: 'cap_reached' })
  await routeUpdate(privateUpdate(1), h.ctx)
  expect(h.ctx.registry.state('telegram-dm-555')).toBeUndefined()
  expect(h.notified).toEqual([{ chatId: 555, text: '目前容量已滿，請稍後再試。' }])
})

test('SCOPE_SPAWN_BIN 未設：回「服務未完整設定」而不是靜默丟棄', async () => {
  const h = harness({ spawn: 'not_configured' })
  await routeUpdate(privateUpdate(1), h.ctx)
  expect(h.notified[0].text).toBe('服務未完整設定，請聯絡管理者。')
})

test('registry 容量上限擋下新身分時直接回覆，不呼叫 spawn', async () => {
  const h = harness({ maxScopes: 1 })
  await routeUpdate(privateUpdate(1, 111, 111), h.ctx)
  await routeUpdate(privateUpdate(2, 222, 222), h.ctx)
  expect(h.spawned).toEqual(['telegram-dm-111'])
  expect(h.notified).toEqual([{ chatId: 222, text: '目前容量已滿，請稍後再試。' }])
})

test('spawn 成功但逾時沒訂閱：出聲並清掉 entry', async () => {
  const h = harness()
  await routeUpdate(privateUpdate(1), h.ctx)
  expect(h.timers.length).toBe(1)
  h.timers[0]()
  await Promise.resolve()
  expect(h.ctx.registry.state('telegram-dm-555')).toBeUndefined()
  expect(h.notified[0].text).toBe('暫時無法回應，請稍後再試。')
})

test('spawn 成功且如期訂閱：逾時計時器不誤殺已連上的 scope', async () => {
  const h = harness()
  await routeUpdate(privateUpdate(1), h.ctx)
  h.ctx.registry.onSubscribed('telegram-dm-555')
  h.timers[0]()
  await Promise.resolve()
  expect(h.ctx.registry.state('telegram-dm-555')).toBe('connected')
  expect(h.notified).toEqual([])
})

test('consumeUpdates 全部處理成功時推進到最後一則之後', async () => {
  const seen: number[] = []
  const result = await consumeUpdates(
    [privateUpdate(10), privateUpdate(11)],
    async u => void seen.push(u.update_id),
    undefined,
  )
  expect(seen).toEqual([10, 11])
  expect(result).toEqual({ offset: 12 })
})

test('routeUpdate 失敗時 offset 停在該則之前，下次會重新取得（假設 A-9）', async () => {
  const attempted: number[] = []
  const route = async (u: Update): Promise<void> => {
    attempted.push(u.update_id)
    if (u.update_id === 11) throw new Error('boom')
  }
  const result = await consumeUpdates(
    [privateUpdate(10), privateUpdate(11), privateUpdate(12)],
    route,
    10,
  )
  // 11 沒處理成功，offset 必須仍指向 11，否則這則永久消失
  expect(result.offset).toBe(11)
  expect((result.error as Error).message).toBe('boom')
  expect(attempted).toEqual([10, 11])
})

test('consumeUpdates 第一則就失敗時 offset 完全不動', async () => {
  const route = async (): Promise<void> => {
    throw new Error('boom')
  }
  const result = await consumeUpdates([privateUpdate(10)], route, 5)
  expect(result.offset).toBe(5)
})
