import { describe, expect, test } from 'bun:test'
import {
  decideRestart,
  performRestart,
  RESTART_COOLDOWN_MS,
  RESTART_MAX_PER_WINDOW,
  RESTART_WINDOW_MS,
  type RestartDeps,
  type RestartState,
} from './restart-agent'

const T0 = 1_000_000_000_000

describe('decideRestart (auto, storm guard)', () => {
  test('allows the first restart', () => {
    const d = decideRestart({ history: [] }, T0, false)
    expect(d.allow).toBe(true)
  })

  test('blocks a second restart inside the cooldown window', () => {
    const d = decideRestart({ history: [T0] }, T0 + RESTART_COOLDOWN_MS - 1, false)
    expect(d).toMatchObject({ allow: false, reason: 'cooldown' })
  })

  test('allows again once the cooldown has elapsed', () => {
    const d = decideRestart({ history: [T0] }, T0 + RESTART_COOLDOWN_MS, false)
    expect(d.allow).toBe(true)
  })

  test('blocks once the per-window cap is hit (spaced past cooldown)', () => {
    // Three restarts spaced one cooldown apart, all within the 30-min window.
    const history = [T0, T0 + RESTART_COOLDOWN_MS, T0 + 2 * RESTART_COOLDOWN_MS]
    expect(history.length).toBe(RESTART_MAX_PER_WINDOW)
    const now = T0 + 3 * RESTART_COOLDOWN_MS // past cooldown, still in window
    const d = decideRestart({ history }, now, false)
    expect(d).toMatchObject({ allow: false, reason: 'limit' })
  })

  test('drops restarts older than the window from the cap count', () => {
    const history = [T0, T0 + RESTART_COOLDOWN_MS, T0 + 2 * RESTART_COOLDOWN_MS]
    const now = T0 + RESTART_WINDOW_MS + 1 // all three now outside the window
    const d = decideRestart({ history }, now, false)
    expect(d.allow).toBe(true)
  })
})

describe('decideRestart (manual, bypassThrottle)', () => {
  test('allows during cooldown', () => {
    const d = decideRestart({ history: [T0] }, T0 + 1, true)
    expect(d.allow).toBe(true)
  })

  test('allows even at the per-window cap', () => {
    const history = [T0, T0 + 1000, T0 + 2000]
    const d = decideRestart({ history }, T0 + 3000, true)
    expect(d.allow).toBe(true)
  })

  test('records the manual restart in history', () => {
    const d = decideRestart({ history: [] }, T0, true)
    expect(d.allow && d.nextState.history).toEqual([T0])
  })
})

describe('performRestart (tier selection)', () => {
  function deps(overrides: Partial<RestartDeps>): RestartDeps {
    return {
      now: () => T0,
      killProcess: () => {},
      systemctlRestart: async () => {},
      readPid: () => null,
      ...overrides,
    }
  }

  test('uses Tier 1 (process) when a PID is available', async () => {
    let killed = 0
    const tier = await performRestart(deps({ readPid: () => 4242, killProcess: () => { killed++ } }))
    expect(tier).toBe('process')
    expect(killed).toBe(1)
  })

  test('falls back to Tier 2 (service) when no PID', async () => {
    let restarted = 0
    const tier = await performRestart(
      deps({ readPid: () => null, systemctlRestart: async () => { restarted++ } }),
    )
    expect(tier).toBe('service')
    expect(restarted).toBe(1)
  })

  test('escalates to Tier 2 when Tier 1 kill throws (stale PID)', async () => {
    let restarted = 0
    const tier = await performRestart(
      deps({
        readPid: () => 4242,
        killProcess: () => { throw new Error('ESRCH') },
        systemctlRestart: async () => { restarted++ },
      }),
    )
    expect(tier).toBe('service')
    expect(restarted).toBe(1)
  })
})
