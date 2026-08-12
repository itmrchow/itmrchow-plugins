import { expect, test } from 'bun:test'
import { createReadyGate, READY_FALLBACK_MS, READY_GRACE_MS } from './channel-ready'

type Timer = { fn: () => void; ms: number }

/** Collects scheduled timers so a test fires them by hand. */
function fakeTimers(): { timers: Timer[]; setTimer: (fn: () => void, ms: number) => void } {
  const timers: Timer[] = []
  return { timers, setTimer: (fn: () => void, ms: number): void => void timers.push({ fn, ms }) }
}

/** True when the promise has resolved by the time the microtask queue drains. */
async function isResolved(p: Promise<void>): Promise<boolean> {
  const pending = Symbol('pending')
  return (await Promise.race([p, Promise.resolve(pending)])) !== pending
}

test('尚未 initialized 時不放行', async () => {
  const { setTimer } = fakeTimers()
  const gate = createReadyGate({ setTimer })
  expect(await isResolved(gate.ready)).toBe(false)
})

test('initialized 之後仍要等滿 grace 才放行', async () => {
  const { timers, setTimer } = fakeTimers()
  const gate = createReadyGate({ graceMs: 3000, setTimer, log: () => {} })
  gate.markInitialized()

  const grace = timers.find(t => t.ms === 3000)
  expect(grace).toBeDefined()
  expect(await isResolved(gate.ready)).toBe(false)

  grace!.fn()
  expect(await isResolved(gate.ready)).toBe(true)
})

test('client 一直沒 initialized：fallback 逾時仍放行並留下警告', async () => {
  const { timers, setTimer } = fakeTimers()
  const lines: string[] = []
  const gate = createReadyGate({ fallbackMs: 10_000, setTimer, log: l => void lines.push(l) })

  const fallback = timers.find(t => t.ms === 10_000)
  expect(fallback).toBeDefined()
  fallback!.fn()

  expect(await isResolved(gate.ready)).toBe(true)
  expect(lines.join('')).toContain('never reported initialized')
})

// The fallback exists only for a client that never speaks. Letting it fire after
// a normal initialize would hand the subscription out early — the exact bug.
test('已 initialized 後 fallback 逾時不再插隊放行', async () => {
  const { timers, setTimer } = fakeTimers()
  const lines: string[] = []
  const gate = createReadyGate({ graceMs: 3000, fallbackMs: 10_000, setTimer, log: l => void lines.push(l) })
  gate.markInitialized()

  timers.find(t => t.ms === 10_000)!.fn()
  expect(await isResolved(gate.ready)).toBe(false)
  expect(lines).toEqual([])

  timers.find(t => t.ms === 3000)!.fn()
  expect(await isResolved(gate.ready)).toBe(true)
})

test('markInitialized 重複呼叫只排一次 grace', () => {
  const { timers, setTimer } = fakeTimers()
  const gate = createReadyGate({ graceMs: 3000, setTimer })
  gate.markInitialized()
  gate.markInitialized()
  gate.markInitialized()
  expect(timers.filter(t => t.ms === 3000)).toHaveLength(1)
})

test('預設值：grace 遠大於實測的 60ms 缺口，且遠小於 poller 的 30s spawn timeout', () => {
  expect(READY_GRACE_MS).toBeGreaterThanOrEqual(1000)
  expect(READY_GRACE_MS + READY_FALLBACK_MS).toBeLessThan(30_000)
})
