import { expect, test } from 'bun:test'
import {
  createGatewayHealth,
  shouldLogGatewayDebug,
  GATEWAY_STALE_AFTER_MS,
  type GatewayHealth,
} from './gateway-health'

const STALE_AFTER_MS = 1000

/** A health tracker on a clock and an ACK source the test drives by hand. */
function harness(): {
  health: GatewayHealth
  advance: (ms: number) => void
  ack: (at: number) => void
  clock: () => number
} {
  let clock = 10_000
  let ackAt = -1
  const health = createGatewayHealth({
    lastAckAt: () => ackAt,
    now: () => clock,
    staleAfterMs: STALE_AFTER_MS,
  })
  return {
    health,
    advance: ms => {
      clock += ms
    },
    ack: at => {
      ackAt = at
    },
    clock: () => clock,
  }
}

test('尚未收到任何 gateway 訊號時不判定為 stale', () => {
  const { health } = harness()
  expect(health.snapshot()).toEqual({ lastActivityAt: -1, ageMs: -1, stale: false })
})

test('剛收到事件即為健康，並回報靜默時長', () => {
  const { health, advance } = harness()
  health.markActivity()
  advance(400)
  expect(health.snapshot()).toEqual({ lastActivityAt: 10_000, ageMs: 400, stale: false })
})

test('靜默超過閾值才判定為 stale，剛好等於閾值不算', () => {
  const { health, advance } = harness()
  health.markActivity()
  advance(STALE_AFTER_MS)
  expect(health.snapshot().stale).toBe(false)
  advance(1)
  expect(health.snapshot()).toEqual({ lastActivityAt: 10_000, ageMs: STALE_AFTER_MS + 1, stale: true })
})

test('沒有 dispatch 但 heartbeat ACK 持續進來時仍算健康', () => {
  const { health, advance, ack, clock } = harness()
  health.markActivity()
  advance(5000)
  ack(clock())
  expect(health.snapshot().stale).toBe(false)
})

test('heartbeat ACK 停更、只剩舊 dispatch 時判定為 stale', () => {
  const { health, advance, ack, clock } = harness()
  ack(clock())
  health.markActivity()
  advance(STALE_AFTER_MS + 1)
  // 這正是 JP-195 的殭屍連線：process 活著、socket 還在，但兩個訊號源都停了。
  expect(health.snapshot().stale).toBe(true)
})

test('取兩個訊號源中較新者，不因其中一個落後而誤判', () => {
  const { health, advance, ack, clock } = harness()
  ack(clock())
  advance(STALE_AFTER_MS + 1)
  health.markActivity()
  expect(health.snapshot()).toEqual({ lastActivityAt: clock(), ageMs: 0, stale: false })
})

test('預設閾值為五分鐘', () => {
  expect(GATEWAY_STALE_AFTER_MS).toBe(300_000)
})

test('heartbeat ACK 的 debug 訊息不寫 log，其餘一律寫', () => {
  expect(shouldLogGatewayDebug('[WS => Shard 0] Heartbeat acknowledged, latency of 42ms.')).toBe(false)
  expect(shouldLogGatewayDebug('[WS => Shard 0] Destroying shard\n\tReason: Zombie connection')).toBe(true)
  expect(shouldLogGatewayDebug('[WS => Shard 0] Connecting to wss://gateway.discord.gg')).toBe(true)
})
