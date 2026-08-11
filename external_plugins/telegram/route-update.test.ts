import { expect, test } from 'bun:test'
import type { Update } from 'grammy/types'
import { ScopeRegistry } from './poller-registry'
import {
  createUpdateConsumer,
  resolveUpdateScope,
  routeUpdate,
  type ConsumeContext,
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

test('處理成功才推進到最後一則之後', async () => {
  const seen: number[] = []
  const consume = createUpdateConsumer({ route: async u => void seen.push(u.update_id) })
  const offset = await consume([privateUpdate(10), privateUpdate(11)], undefined)
  expect(seen).toEqual([10, 11])
  expect(offset).toBe(12)
})

test('處理失敗時 offset 不推進，訊息不會永久遺失（A-9 回歸）', async () => {
  const consume = createUpdateConsumer({
    route: async () => {
      throw new Error('boom')
    },
  })
  const offset = await consume([privateUpdate(10), privateUpdate(11)], undefined)
  expect(offset).toBeUndefined()
})

test('部分成功時只推進到第一個失敗之前（維持因果順序）', async () => {
  const attempted: number[] = []
  const consume = createUpdateConsumer({
    route: async (u: Update) => {
      attempted.push(u.update_id)
      if (u.update_id === 11) throw new Error('boom')
    },
  })
  const offset = await consume([privateUpdate(10), privateUpdate(11), privateUpdate(12)], 10)
  expect(offset).toBe(11)
  // 失敗那則之後的不先跑，否則同一個 chat 的訊息會亂序
  expect(attempted).toEqual([10, 11])
})

test('同一則連續失敗 3 次後跳過並記 log，不讓一則毒訊息弄聾整個平台（§2.5）', async () => {
  const logged: string[] = []
  const consume = createUpdateConsumer({
    route: async () => {
      throw new Error('boom')
    },
    log: line => void logged.push(line),
  })
  let offset: number | undefined
  for (let i = 0; i < 3; i++) offset = await consume([privateUpdate(10)], offset)

  expect(offset).toBe(11)
  expect(logged.some(l => l.includes('poison_pill_skipped'))).toBe(true)
  expect(logged.some(l => l.includes('update_id=10'))).toBe(true)
  // 事後要找得到「是誰的訊息被丟掉」
  expect(logged.some(l => l.includes('telegram-dm-555'))).toBe(true)
})

test('毒丸計數以 update_id 為鍵：不同訊息的失敗不互相累加', async () => {
  const consume = createUpdateConsumer({
    route: async () => {
      throw new Error('boom')
    },
  })
  await consume([privateUpdate(10)], undefined)
  await consume([privateUpdate(11)], undefined)
  // 兩則各失敗 1 次；若計數共用，第 3 次呼叫就會誤跳過
  const offset = await consume([privateUpdate(12)], undefined)
  expect(offset).toBeUndefined()
})

test('成功後清除該則的失敗計數：偶發失敗不會累積成毒丸', async () => {
  let failNext = true
  const consume = createUpdateConsumer({
    route: async () => {
      if (failNext) throw new Error('flaky')
    },
  })
  // 失敗 2 次（差一次就到門檻）
  await consume([privateUpdate(10)], undefined)
  await consume([privateUpdate(10)], undefined)

  failNext = false
  expect(await consume([privateUpdate(10)], undefined)).toBe(11)

  // 計數若沒被成功清掉，接下來這兩次會分別數成第 3、4 次而誤判毒丸
  failNext = true
  expect(await consume([privateUpdate(10)], undefined)).toBeUndefined()
  expect(await consume([privateUpdate(10)], undefined)).toBeUndefined()
})

test('毒丸跳過後繼續處理同一批的後續訊息', async () => {
  const attempted: number[] = []
  const consume = createUpdateConsumer({
    route: async (u: Update) => {
      attempted.push(u.update_id)
      if (u.update_id === 10) throw new Error('boom')
    },
  })
  await consume([privateUpdate(10)], undefined)
  await consume([privateUpdate(10)], undefined)
  const offset = await consume([privateUpdate(10), privateUpdate(11)], undefined)
  expect(offset).toBe(12)
  expect(attempted.at(-1)).toBe(11)
})

test('scope-id 算不出來的毒訊息照樣跳得掉，log 標成 unknown', async () => {
  const logged: string[] = []
  const noChat = { update_id: 20, poll: { id: 'p' } } as unknown as Update
  const consume = createUpdateConsumer({
    route: async () => {
      throw new Error('boom')
    },
    log: line => void logged.push(line),
  })
  let offset: number | undefined
  for (let i = 0; i < 3; i++) offset = await consume([noChat], offset)
  expect(offset).toBe(21)
  expect(logged.some(l => l.includes('scope=unknown'))).toBe(true)
})

test('計數器由 consumer 自己持有：跨批次累加不靠呼叫端傳同一個物件（P2-3）', async () => {
  const ctx: ConsumeContext = {
    route: async () => {
      throw new Error('boom')
    },
  }
  // 每一批都用「同一份設定物件」重新建 consumer —— 這是舊 API 最容易被誤用的姿勢：
  // 計數存在呼叫端物件時它剛好還會累加，存在 consumer 自己身上時則每次歸零。
  let offset: number | undefined
  for (let i = 0; i < 5; i++) offset = await createUpdateConsumer(ctx)([privateUpdate(10)], offset)
  // 各自的計數永遠是 1，因此永遠不會誤判毒丸、offset 一直守住那一則
  expect(offset).toBeUndefined()

  // 同一個 consumer 才會累加到門檻
  const consume = createUpdateConsumer(ctx)
  for (let i = 0; i < 3; i++) offset = await consume([privateUpdate(10)], offset)
  expect(offset).toBe(11)
})
