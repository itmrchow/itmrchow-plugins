import { describe, expect, test } from 'bun:test'
import {
  BusyGate,
  BUSY_MARKER,
  BUSY_PATTERN,
  capturePaneBusy,
  FOOTER_SETTLE_MS,
  isPaneBusy,
  QUEUE_MAX_SIZE,
} from './busy-gate'

/** Auto-mode footer line, always present idle or busy (JP-79 always-busy trap). */
const AUTO_MODE_FOOTER = '⏵⏵ auto mode on (shift+tab to cycle) · esc to interrupt'

const IDLE_PANE = [
  '❯ ',
  AUTO_MODE_FOOTER,
].join('\n')

const BUSY_PANE = [
  '❯ ',
  '✶ Working… (6m 49s · ↓ 16.0k tokens)',
  AUTO_MODE_FOOTER,
].join('\n')

/**
 * Idle main session with a background agent status panel pinned in the footer.
 *
 * The panel line carries its own `tokens` counter with NO parenthesised timer.
 * This is the JP-84 second always-busy regression marker: a bare `tokens`
 * substring reads busy here forever; BUSY_PATTERN must read idle.
 */
const BG_AGENT_IDLE_PANE = [
  '❯ ',
  '◯ jeff-core:backend-dev  JP-83 wiring repo   13s · ↓ 45.3k tokens',
  AUTO_MODE_FOOTER,
].join('\n')

/** Generating spinner variant that also reports a thought timer. */
const BUSY_THOUGHT_PANE = [
  '❯ ',
  '· Working… (8s · ↓ 172 tokens · thought for 1s)',
  AUTO_MODE_FOOTER,
].join('\n')

describe('isPaneBusy', () => {
  test('detects busy on the main-generation spinner timer', () => {
    expect(isPaneBusy(BUSY_PANE)).toBe(true)
  })

  test('detects busy on the thought-timer spinner variant', () => {
    expect(isPaneBusy(BUSY_THOUGHT_PANE)).toBe(true)
  })

  test('detects idle on a pure idle footer (no spinner)', () => {
    expect(isPaneBusy(IDLE_PANE)).toBe(false)
  })

  test('background-agent panel token counter reads idle (JP-84 regression)', () => {
    // Main session is idle; a background agent panel pins its own `tokens`
    // counter with no parenthesised timer. A bare `tokens` substring read this
    // busy forever and wedged every inbound message. BUSY_PATTERN must not match.
    expect(isPaneBusy(BG_AGENT_IDLE_PANE)).toBe(false)
  })

  test('treats empty capture as idle', () => {
    expect(isPaneBusy('')).toBe(false)
  })

  test('ignores a spinner timer outside the footer region (false-positive guard)', () => {
    // Agent output echoing a spinner-shaped string, then 5+ idle footer lines below.
    const pane = [
      'user pasted a log line: Working… (12s · ↓ 3.4k tokens)',
      'line 1',
      'line 2',
      'line 3',
      'line 4',
      '❯ ',
    ].join('\n')
    expect(isPaneBusy(pane)).toBe(false)
  })

  test('does not stitch a stray opener to a tokens line across newlines', () => {
    // A `(12s` opener and a `tokens` word split across two footer lines must
    // NOT be joined into a match: isPaneBusy tests each line individually.
    const pane = [
      '❯ (12s elapsed since',
      'last run · 45.3k tokens streamed',
      AUTO_MODE_FOOTER,
    ].join('\n')
    expect(isPaneBusy(pane)).toBe(false)
  })

  test('BUSY_PATTERN matches only the parenthesised spinner timer', () => {
    expect(BUSY_PATTERN.test('(6m 49s · ↓ 16.0k tokens)')).toBe(true)
    expect(BUSY_PATTERN.test('◯ backend-dev  13s · ↓ 45.3k tokens')).toBe(false)
  })

  test('BUSY_MARKER is retained for back-compat (deprecated)', () => {
    expect(BUSY_MARKER).toBe('tokens')
  })
})

type Payload = { content: string; meta: { chat_id: string } }

function makePayload(id: string): Payload {
  return { content: `msg-${id}`, meta: { chat_id: '1' } }
}

/** Mutable clock for driving the settle cooldown deterministically. */
function makeClock(start = 1_000_000): { now: () => number; advance: (ms: number) => void } {
  let t = start
  return { now: () => t, advance: (ms: number) => { t += ms } }
}

describe('BusyGate', () => {
  test('delivers on drain when idle', async () => {
    const delivered: Payload[] = []
    const gate = new BusyGate<Payload>({
      isBusy: () => false,
      deliver: async p => { delivered.push(p) },
    })
    gate.submit(makePayload('a'))
    await gate.drainOnce()
    expect(delivered.map(p => p.content)).toEqual(['msg-a'])
    gate.stop()
  })

  test('enqueues while busy, flushes FIFO when idle', async () => {
    const delivered: Payload[] = []
    let busy = true
    const clock = makeClock()
    const gate = new BusyGate<Payload>({
      isBusy: () => busy,
      deliver: async p => { delivered.push(p) },
      now: clock.now,
    })
    gate.submit(makePayload('a'))
    gate.submit(makePayload('b'))
    await gate.drainOnce()
    expect(delivered).toEqual([])            // still busy -> nothing flushed
    expect(gate.size).toBe(2)

    busy = false
    await gate.drainOnce()                   // one per tick
    expect(delivered.map(p => p.content)).toEqual(['msg-a'])
    expect(gate.size).toBe(1)
    clock.advance(FOOTER_SETTLE_MS + 1)      // wait out the settle cooldown
    await gate.drainOnce()
    expect(delivered.map(p => p.content)).toEqual(['msg-a', 'msg-b'])
    expect(gate.size).toBe(0)
    gate.stop()
  })

  test('re-checks busy each tick: one flush, then busy again holds the rest', async () => {
    const delivered: Payload[] = []
    const states = [false, true, false]      // idle, then busy, then idle
    let i = 0
    const clock = makeClock()
    const gate = new BusyGate<Payload>({
      isBusy: () => states[Math.min(i++, states.length - 1)],
      deliver: async p => { delivered.push(p) },
      now: clock.now,
    })
    gate.submit(makePayload('a'))
    gate.submit(makePayload('b'))
    await gate.drainOnce()                    // idle -> flush a
    clock.advance(FOOTER_SETTLE_MS + 1)       // cooldown elapsed; busy probe decides
    await gate.drainOnce()                    // busy -> hold
    expect(delivered.map(p => p.content)).toEqual(['msg-a'])
    expect(gate.size).toBe(1)
    gate.stop()
  })

  test('settle cooldown holds the next flush across the footer-lag window', async () => {
    // Regression for the lag double-send: the footer ALWAYS reads idle here
    // (simulating it never settling within the tick). Without the cooldown,
    // back-to-back drains would flush both a and b immediately, re-wedging b.
    const delivered: Payload[] = []
    const clock = makeClock()
    const gate = new BusyGate<Payload>({
      isBusy: () => false,                    // footer never reports busy
      deliver: async p => { delivered.push(p) },
      now: clock.now,
    })
    gate.submit(makePayload('a'))
    gate.submit(makePayload('b'))

    await gate.drainOnce()                    // T: deliver a, stamp lastDeliverAt=T
    expect(delivered.map(p => p.content)).toEqual(['msg-a'])
    expect(gate.size).toBe(1)

    clock.advance(200)                        // T+200, still < FOOTER_SETTLE_MS
    await gate.drainOnce()                    // cooldown holds -> b NOT delivered
    expect(delivered.map(p => p.content)).toEqual(['msg-a'])
    expect(gate.size).toBe(1)

    clock.advance(FOOTER_SETTLE_MS)           // now > FOOTER_SETTLE_MS past delivery
    await gate.drainOnce()                    // cooldown elapsed -> b delivered
    expect(delivered.map(p => p.content)).toEqual(['msg-a', 'msg-b'])
    expect(gate.size).toBe(0)
    gate.stop()
  })

  test('re-entrancy guard: concurrent drains shift only once', async () => {
    // A stalled deliver simulates a slow shell-out longer than one tick.
    // The second concurrent drainOnce must see draining=true and bail without
    // shifting a second payload (which would produce unordered writes).
    const delivered: Payload[] = []
    let resolveDeliver!: () => void
    const deferred = new Promise<void>(resolve => { resolveDeliver = resolve })
    const clock = makeClock()
    const gate = new BusyGate<Payload>({
      isBusy: () => false,
      deliver: async p => {
        delivered.push(p)
        await deferred                        // stall until manually resolved
      },
      now: clock.now,
    })
    gate.submit(makePayload('a'))
    gate.submit(makePayload('b'))

    const first = gate.drainOnce()            // enters, shifts a, awaits deferred
    const second = gate.drainOnce()           // sees draining=true -> returns
    await second
    expect(delivered.map(p => p.content)).toEqual(['msg-a'])  // only one shift
    expect(gate.size).toBe(1)                 // b still queued

    resolveDeliver()
    await first
    expect(delivered.map(p => p.content)).toEqual(['msg-a'])  // state consistent
    expect(gate.size).toBe(1)
    gate.stop()
  })

  test('awaits an async isBusy probe', async () => {
    const delivered: Payload[] = []
    let busy = true
    const gate = new BusyGate<Payload>({
      isBusy: async () => busy,               // async probe (production shape)
      deliver: async p => { delivered.push(p) },
    })
    gate.submit(makePayload('a'))
    await gate.drainOnce()
    expect(delivered).toEqual([])             // async-busy honored -> held
    busy = false
    await gate.drainOnce()
    expect(delivered.map(p => p.content)).toEqual(['msg-a'])
    gate.stop()
  })

  test('overflow drops the oldest entry', () => {
    const gate = new BusyGate<Payload>({
      isBusy: () => true,
      deliver: async () => {},
    })
    for (let n = 0; n < QUEUE_MAX_SIZE + 5; n++) gate.submit(makePayload(String(n)))
    expect(gate.size).toBe(QUEUE_MAX_SIZE)
    expect(gate.peekOldest()?.content).toBe('msg-5')  // 0..4 evicted
    gate.stop()
  })
})

describe('BusyGate edge cases', () => {
  test('capture failure is treated as idle (fail-open)', async () => {
    // Non-existent tmux target -> execFile rejects -> caught -> false.
    expect(await capturePaneBusy('definitely-no-such-session:0')).toBe(false)
  })

  test('stop() drops a non-empty queue', () => {
    const gate = new BusyGate<Payload>({
      isBusy: () => true,
      deliver: async () => {},
    })
    gate.submit(makePayload('x'))
    expect(gate.size).toBe(1)
    gate.stop()
    expect(gate.size).toBe(0)
  })

  test('drainOnce on empty queue is a no-op', async () => {
    const gate = new BusyGate<Payload>({
      isBusy: () => false,
      deliver: async () => { throw new Error('should not be called') },
    })
    await gate.drainOnce()  // must not throw
    expect(gate.size).toBe(0)
    gate.stop()
  })

  test('agent-dies-while-queued: messages stay queued, not delivered', async () => {
    // Agent "dead" == pane permanently busy (or capture fails -> idle).
    // While busy, queued messages are simply held; no crash, bounded by cap.
    const gate = new BusyGate<Payload>({
      isBusy: () => true,
      deliver: async () => { throw new Error('should not be called while busy') },
    })
    gate.submit(makePayload('a'))
    await gate.drainOnce()
    expect(gate.size).toBe(1)
    gate.stop()
  })
})
