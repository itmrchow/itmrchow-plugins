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

test('情境 5 斷線重連中：入佇列但不再觸發 spawn', () => {
  reg.admit('telegram-dm-4', env('telegram-dm-4'))
  reg.onSubscribed('telegram-dm-4')
  reg.onDisconnected('telegram-dm-4')
  expect(reg.state('telegram-dm-4')).toBe('disconnected')
  expect(reg.admit('telegram-dm-4', env('telegram-dm-4'))).toEqual({ action: 'queued' })
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

test('情境 8 全域重啟：poller 不屬於任何 scope，斷線等同情境 5', () => {
  reg.admit('telegram-dm-8', env('telegram-dm-8'))
  reg.onSubscribed('telegram-dm-8')
  reg.onDisconnected('telegram-dm-8')
  expect(reg.admit('telegram-dm-8', env('telegram-dm-8'))).toEqual({ action: 'queued' })
  expect(reg.size()).toBe(1)
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
