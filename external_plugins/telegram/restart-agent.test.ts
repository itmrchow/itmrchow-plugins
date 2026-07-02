import { describe, expect, test } from 'bun:test'
import {
  decideRestart,
  findClaudePidInTree,
  performRestart,
  RESTART_COOLDOWN_MS,
  RESTART_MAX_PER_WINDOW,
  RESTART_WINDOW_MS,
  SIGTERM_GRACE_MS,
  terminateWithEscalation,
  type ProcessTreeReader,
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

/**
 * Deps with a fake clock: sleep() advances the clock so waitForExit's polling
 * loop runs deterministically without real timers.
 */
function fakeDeps(overrides: Partial<RestartDeps>): RestartDeps {
  let clock = T0
  return {
    now: () => clock,
    killProcess: () => {},
    isAlive: () => false,
    sleep: async ms => {
      clock += ms
    },
    findClaudePid: async () => null,
    systemctlRestart: async () => {},
    ...overrides,
  }
}

describe('performRestart (tier selection)', () => {
  test('uses Tier 1 (process) when a PID resolves and the kill succeeds', async () => {
    const signals: string[] = []
    const tier = await performRestart(
      fakeDeps({
        findClaudePid: async () => 4242,
        killProcess: (_pid, signal) => {
          signals.push(signal)
        },
        isAlive: () => false, // dies right after SIGTERM
      }),
    )
    expect(tier).toBe('process')
    expect(signals).toEqual(['SIGTERM'])
  })

  test('falls back to Tier 2 (service) when no PID resolves from tmux', async () => {
    let restarted = 0
    const tier = await performRestart(
      fakeDeps({
        findClaudePid: async () => null,
        systemctlRestart: async () => {
          restarted++
        },
      }),
    )
    expect(tier).toBe('service')
    expect(restarted).toBe(1)
  })

  test('escalates to Tier 2 when the process survives SIGTERM and SIGKILL', async () => {
    let restarted = 0
    const tier = await performRestart(
      fakeDeps({
        findClaudePid: async () => 4242,
        isAlive: () => true, // unkillable
        systemctlRestart: async () => {
          restarted++
        },
      }),
    )
    expect(tier).toBe('service')
    expect(restarted).toBe(1)
  })
})

describe('terminateWithEscalation (SIGTERM -> SIGKILL)', () => {
  test('returns true on SIGTERM alone when the process exits in the grace window', async () => {
    const signals: string[] = []
    let aliveProbes = 0
    const ok = await terminateWithEscalation(
      4242,
      fakeDeps({
        killProcess: (_pid, signal) => {
          signals.push(signal)
        },
        isAlive: () => {
          aliveProbes++
          return aliveProbes <= 2 // survives two polls, then exits
        },
      }),
    )
    expect(ok).toBe(true)
    expect(signals).toEqual(['SIGTERM'])
  })

  test('sends SIGKILL when the process survives the full SIGTERM grace period', async () => {
    const signals: string[] = []
    let sigkillAt: number | null = null
    const deps = fakeDeps({
      killProcess: (_pid, signal) => {
        signals.push(signal)
        if (signal === 'SIGKILL') sigkillAt = deps.now()
      },
      isAlive: () => signals.length < 2, // dies only once SIGKILL was sent
    })
    const ok = await terminateWithEscalation(4242, deps)
    expect(ok).toBe(true)
    expect(signals).toEqual(['SIGTERM', 'SIGKILL'])
    expect(sigkillAt! - T0).toBeGreaterThanOrEqual(SIGTERM_GRACE_MS)
  })

  test('returns false when the process survives both signals', async () => {
    const ok = await terminateWithEscalation(4242, fakeDeps({ isAlive: () => true }))
    expect(ok).toBe(false)
  })

  test('treats a throwing kill (ESRCH) as success when the process is gone', async () => {
    const ok = await terminateWithEscalation(
      4242,
      fakeDeps({
        killProcess: () => {
          throw new Error('ESRCH')
        },
        isAlive: () => false,
      }),
    )
    expect(ok).toBe(true)
  })
})

describe('findClaudePidInTree (tmux pane -> claude descendant)', () => {
  function treeOf(children: Record<number, number[]>, comms: Record<number, string>): ProcessTreeReader {
    return {
      getChildren: async pid => children[pid] ?? [],
      getCommand: async pid => comms[pid] ?? null,
    }
  }

  test('finds claude as a direct child of the pane PID', async () => {
    const tree = treeOf({ 100: [200] }, { 200: 'claude' })
    expect(await findClaudePidInTree(100, tree)).toBe(200)
  })

  test('finds claude deeper in the tree (pane -> shell -> claude)', async () => {
    const tree = treeOf({ 100: [200], 200: [300] }, { 200: 'bash', 300: 'claude' })
    expect(await findClaudePidInTree(100, tree)).toBe(300)
  })

  test('prefers the shallowest claude (BFS) over a nested one', async () => {
    const tree = treeOf(
      { 100: [200, 210], 210: [300] },
      { 200: 'claude', 210: 'bash', 300: 'claude' },
    )
    expect(await findClaudePidInTree(100, tree)).toBe(200)
  })

  test('returns null when no descendant is claude', async () => {
    const tree = treeOf({ 100: [200], 200: [300] }, { 200: 'bash', 300: 'bun' })
    expect(await findClaudePidInTree(100, tree)).toBe(null)
  })

  test('returns null on a childless pane', async () => {
    expect(await findClaudePidInTree(100, treeOf({}, {}))).toBe(null)
  })
})
