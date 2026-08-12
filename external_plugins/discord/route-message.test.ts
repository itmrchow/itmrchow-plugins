import { expect, test } from 'bun:test'
import { ScopeRegistry } from './poller-registry'
import { routeMessage, type DiscordPayload, type RouteContext, type RouteInput, type SpawnOutcome } from './route-message'
import type { InboundEnvelope } from './subscribe-protocol'

const dmMessage = (overrides: Partial<RouteInput> = {}): RouteInput => ({
  kind: 'messageCreate',
  isDm: true,
  channelId: '999',
  parentId: undefined,
  authorId: '555',
  data: { content: 'hi' },
  ...overrides,
})

type Harness = {
  ctx: RouteContext
  delivered: Array<{ scopeId: string; envelopes: InboundEnvelope[] }>
  notified: Array<{ channelId: string; text: string }>
  spawned: string[]
  logs: string[]
  fireTimer: () => void
}

function harness(opts: { registry: ScopeRegistry; spawn?: SpawnOutcome; deliverOk?: boolean }): Harness {
  const delivered: Harness['delivered'] = []
  const notified: Harness['notified'] = []
  const spawned: string[] = []
  const logs: string[] = []
  let timer: (() => void) | undefined
  const ctx: RouteContext = {
    registry: opts.registry,
    deliver: (scopeId, envelopes) => {
      delivered.push({ scopeId, envelopes })
      return opts.deliverOk ?? true
    },
    spawn: scopeId => {
      spawned.push(scopeId)
      return Promise.resolve(opts.spawn ?? 'ok')
    },
    notify: (channelId, text) => {
      notified.push({ channelId, text })
      return Promise.resolve()
    },
    setTimer: fn => {
      timer = fn
    },
    log: line => void logs.push(line),
  }
  return { ctx, delivered, notified, spawned, logs, fireTimer: () => timer?.() }
}

test('第一次見到的 DM 觸發 spawn，scope-id 錨在發話者', async () => {
  const registry = new ScopeRegistry({ maxScopes: 5, maxQueue: 10 })
  const h = harness({ registry })

  await routeMessage(dmMessage(), h.ctx)

  expect(h.spawned).toEqual(['discord-dm-555'])
  expect(h.delivered).toEqual([])
  expect(registry.state('discord-dm-555')).toBe('connecting')
})

test('thread 訊息落在父頻道的 scope，不另開一個', async () => {
  const registry = new ScopeRegistry({ maxScopes: 5, maxQueue: 10 })
  const h = harness({ registry })

  await routeMessage(
    dmMessage({ isDm: false, channelId: '222', parentId: '111' }),
    h.ctx,
  )

  expect(h.spawned).toEqual(['discord-group-111'])
})

test('scope 已連上時直送，payload 帶事件種類與原始 JSON', async () => {
  const registry = new ScopeRegistry({ maxScopes: 5, maxQueue: 10 })
  registry.onSubscribed('discord-dm-555')
  const h = harness({ registry })

  await routeMessage(dmMessage(), h.ctx)

  expect(h.delivered).toHaveLength(1)
  expect(h.delivered[0].scopeId).toBe('discord-dm-555')
  const payload = h.delivered[0].envelopes[0].payload as DiscordPayload
  expect(payload).toEqual({ kind: 'messageCreate', data: { content: 'hi' } })
})

test('按鈕互動走同一個 scope，只是事件種類不同', async () => {
  const registry = new ScopeRegistry({ maxScopes: 5, maxQueue: 10 })
  registry.onSubscribed('discord-dm-555')
  const h = harness({ registry })

  await routeMessage(dmMessage({ kind: 'interactionCreate', data: { customId: 'perm:allow:abcde' } }), h.ctx)

  expect(h.delivered[0].scopeId).toBe('discord-dm-555')
  expect((h.delivered[0].envelopes[0].payload as DiscordPayload).kind).toBe('interactionCreate')
})

test('寫入時才發現連線已死 -> 標記斷線並把訊息放回佇列，不算已送達', async () => {
  const registry = new ScopeRegistry({ maxScopes: 5, maxQueue: 10 })
  registry.onSubscribed('discord-dm-555')
  const h = harness({ registry, deliverOk: false })

  await routeMessage(dmMessage(), h.ctx)

  expect(registry.state('discord-dm-555')).toBe('disconnected')
  // 回到佇列 -> 重連時補送得出來
  expect(registry.onSubscribed('discord-dm-555')).toHaveLength(1)
})

test('scope 數已達上限時回覆使用者，不靜默丟棄', async () => {
  const registry = new ScopeRegistry({ maxScopes: 1, maxQueue: 10 })
  registry.onSubscribed('discord-dm-1')
  const h = harness({ registry })

  await routeMessage(dmMessage(), h.ctx)

  expect(h.spawned).toEqual([])
  expect(h.notified).toHaveLength(1)
  expect(h.notified[0].channelId).toBe('999')
})

test('spawn 失敗時清掉 entry 並回覆，identity 之後還能重試', async () => {
  const registry = new ScopeRegistry({ maxScopes: 5, maxQueue: 10 })
  const h = harness({ registry, spawn: 'failed' })

  await routeMessage(dmMessage(), h.ctx)

  expect(registry.state('discord-dm-555')).toBeUndefined()
  expect(h.notified).toHaveLength(1)
})

test('spawn 說成功但 scope 一直沒連上 -> 逾時後放棄並回覆', async () => {
  const registry = new ScopeRegistry({ maxScopes: 5, maxQueue: 10 })
  const h = harness({ registry })

  await routeMessage(dmMessage(), h.ctx)
  expect(h.notified).toHaveLength(0)

  h.fireTimer()
  await Promise.resolve()

  expect(registry.state('discord-dm-555')).toBeUndefined()
  expect(h.notified).toHaveLength(1)
})

test('scope 已連上時逾時計時器不會誤殺', async () => {
  const registry = new ScopeRegistry({ maxScopes: 5, maxQueue: 10 })
  const h = harness({ registry })

  await routeMessage(dmMessage(), h.ctx)
  registry.onSubscribed('discord-dm-555')
  h.fireTimer()
  await Promise.resolve()

  expect(registry.state('discord-dm-555')).toBe('connected')
  expect(h.notified).toHaveLength(0)
})

test('佇列滿了只記錄不回覆 —— 對方正在洗版，再回更多訊息只是幫倒忙', async () => {
  const registry = new ScopeRegistry({ maxScopes: 5, maxQueue: 1 })
  const h = harness({ registry })

  await routeMessage(dmMessage(), h.ctx) // spawn，佔掉唯一的佇列位
  await routeMessage(dmMessage(), h.ctx)

  expect(h.notified).toEqual([])
  expect(h.logs.some(line => line.includes('queue full'))).toBe(true)
})
