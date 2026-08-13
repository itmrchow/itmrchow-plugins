import { beforeEach, expect, test } from 'bun:test'
import { ScopeRegistry } from './poller-registry'
import type { InboundEnvelope } from './subscribe-protocol'

let n = 0
const env = (scopeId: string): InboundEnvelope => ({
  envelopeId: `env-${++n}`,
  scopeId,
  platform: 'telegram',
  payload: { i: n },
  ts: n,
})

let reg: ScopeRegistry
beforeEach(() => {
  reg = new ScopeRegistry({ maxScopes: 3, maxQueue: 2 })
})

test('情境 1 穩態：已連線的 scope 直接投遞', () => {
  reg.admit('telegram-dm-1', env('telegram-dm-1'))
  reg.onSubscribed('telegram-dm-1')
  const e = env('telegram-dm-1')
  expect(reg.admit('telegram-dm-1', e)).toEqual({ action: 'deliver', envelopes: [e] })
})

test('情境 2 全新身分：要求 spawn 並把訊息留在佇列', () => {
  expect(reg.admit('telegram-dm-2', env('telegram-dm-2'))).toEqual({ action: 'spawn' })
  expect(reg.state('telegram-dm-2')).toBe('connecting')
})

test('情境 3 舊身分重連：poller 端與全新身分同路徑（是否 --resume 由 spawn 腳本依 pointer 檔決定）', () => {
  expect(reg.admit('telegram-dm-7', env('telegram-dm-7'))).toEqual({ action: 'spawn' })
})

test('情境 4 啟動中：後續訊息入佇列，訂閱那刻依序 flush（FIFO）', () => {
  reg.admit('telegram-dm-3', env('telegram-dm-3'))
  const second = env('telegram-dm-3')
  expect(reg.admit('telegram-dm-3', second)).toEqual({ action: 'queued' })
  const flushed = reg.onSubscribed('telegram-dm-3')
  expect(flushed.length).toBe(2)
  expect(flushed[1]).toEqual(second)
  expect(reg.state('telegram-dm-3')).toBe('connected')
})

test('情境 5 斷線後收到新訊息：入佇列並重新要求 spawn（JP-198）', () => {
  reg.admit('telegram-dm-4', env('telegram-dm-4'))
  reg.onSubscribed('telegram-dm-4')
  reg.onDisconnected('telegram-dm-4')
  expect(reg.state('telegram-dm-4')).toBe('disconnected')
  const late = env('telegram-dm-4')
  expect(reg.admit('telegram-dm-4', late)).toEqual({ action: 'spawn' })
  // 訊息沒被 spawn 這條路徑吃掉：重連時仍補得出來
  expect(reg.onSubscribed('telegram-dm-4')).toEqual([late])
})

test('情境 5b 斷線後 state 維持 disconnected：不借用 connecting 的 spawn 逾時計時器', () => {
  reg.admit('telegram-dm-4b', env('telegram-dm-4b'))
  reg.onSubscribed('telegram-dm-4b')
  reg.onDisconnected('telegram-dm-4b')
  reg.admit('telegram-dm-4b', env('telegram-dm-4b'))
  expect(reg.state('telegram-dm-4b')).toBe('disconnected')
})

test('情境 5c 斷線且佇列已滿：照舊擋下，不因為要 spawn 就放行超量', () => {
  reg.admit('telegram-dm-4c', env('telegram-dm-4c'))
  reg.onSubscribed('telegram-dm-4c')
  reg.onDisconnected('telegram-dm-4c')
  reg.admit('telegram-dm-4c', env('telegram-dm-4c'))
  reg.admit('telegram-dm-4c', env('telegram-dm-4c'))
  expect(reg.admit('telegram-dm-4c', env('telegram-dm-4c'))).toEqual({
    action: 'rejected',
    reason: 'queue_full',
  })
})

test('情境 6 spawn 失敗：清空佇列並交還未送出的訊息供回報', () => {
  reg.admit('telegram-dm-5', env('telegram-dm-5'))
  reg.admit('telegram-dm-5', env('telegram-dm-5'))
  const dropped = reg.onSpawnFailed('telegram-dm-5')
  expect(dropped.length).toBe(2)
  expect(reg.state('telegram-dm-5')).toBeUndefined()
  expect(reg.size()).toBe(0)
})

test('情境 7 佇列爆量：丟新的、保留先到的（維持因果順序）', () => {
  reg.admit('telegram-dm-6', env('telegram-dm-6'))
  const kept = env('telegram-dm-6')
  reg.admit('telegram-dm-6', kept)
  expect(reg.admit('telegram-dm-6', env('telegram-dm-6'))).toEqual({
    action: 'rejected',
    reason: 'queue_full',
  })
  const flushed = reg.onSubscribed('telegram-dm-6')
  expect(flushed[1]).toEqual(kept)
})

test('情境 8 全域重啟：poller 活著、claude 全沒了 -> 下一則訊息把 scope 拉回來', () => {
  reg.admit('telegram-dm-8', env('telegram-dm-8'))
  reg.onSubscribed('telegram-dm-8')
  reg.onDisconnected('telegram-dm-8')
  expect(reg.admit('telegram-dm-8', env('telegram-dm-8'))).toEqual({ action: 'spawn' })
  expect(reg.size()).toBe(1)
})

test('啟動中的 scope 不受 JP-198 影響：仍只排隊，不重複要求 spawn', () => {
  expect(reg.admit('telegram-dm-10', env('telegram-dm-10'))).toEqual({ action: 'spawn' })
  expect(reg.admit('telegram-dm-10', env('telegram-dm-10'))).toEqual({ action: 'queued' })
  expect(reg.state('telegram-dm-10')).toBe('connecting')
})

test('requeue 把未 ack 的訊息放回佇列前端，維持原順序', () => {
  const first = env('telegram-dm-9')
  const second = env('telegram-dm-9')
  reg.admit('telegram-dm-9', first)
  reg.onSubscribed('telegram-dm-9')
  reg.onDisconnected('telegram-dm-9')
  const later = env('telegram-dm-9')
  reg.admit('telegram-dm-9', later)
  reg.requeue('telegram-dm-9', [first, second])
  // maxQueue=2：先到的兩則留下，後到的 later 被擠掉
  expect(reg.onSubscribed('telegram-dm-9')).toEqual([first, second])
})

test('requeue 對不存在的 scope 是 no-op（spawn 失敗後連線才斷）', () => {
  reg.requeue('telegram-dm-gone', [env('telegram-dm-gone')])
  expect(reg.size()).toBe(0)
})

test('容量上限：超過 maxScopes 不再 spawn（假設 A-8）', () => {
  reg.admit('telegram-dm-a', env('telegram-dm-a'))
  reg.admit('telegram-dm-b', env('telegram-dm-b'))
  reg.admit('telegram-dm-c', env('telegram-dm-c'))
  expect(reg.admit('telegram-dm-d', env('telegram-dm-d'))).toEqual({
    action: 'rejected',
    reason: 'cap_reached',
  })
})

test('容量上限只擋新身分：已在 registry 的 scope 不受影響', () => {
  reg.admit('telegram-dm-a', env('telegram-dm-a'))
  reg.onSubscribed('telegram-dm-a')
  reg.admit('telegram-dm-b', env('telegram-dm-b'))
  reg.admit('telegram-dm-c', env('telegram-dm-c'))
  const e = env('telegram-dm-a')
  expect(reg.admit('telegram-dm-a', e)).toEqual({ action: 'deliver', envelopes: [e] })
})

test('spawn 失敗後容量釋出，讓下一個身分還能進來', () => {
  reg.admit('telegram-dm-a', env('telegram-dm-a'))
  reg.admit('telegram-dm-b', env('telegram-dm-b'))
  reg.admit('telegram-dm-c', env('telegram-dm-c'))
  reg.onSpawnFailed('telegram-dm-c')
  expect(reg.admit('telegram-dm-d', env('telegram-dm-d'))).toEqual({ action: 'spawn' })
})
