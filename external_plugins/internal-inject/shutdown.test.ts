import { describe, expect, test } from 'bun:test'
import { createShutdown, isOrphaned, type OrphanSnapshot } from './shutdown'

const BOOT_PPID = 4242

function makeSnapshot(overrides: Partial<OrphanSnapshot> = {}): OrphanSnapshot {
  return {
    platform: 'darwin',
    bootPpid: BOOT_PPID,
    ppid: BOOT_PPID,
    stdinDestroyed: false,
    stdinEnded: false,
    ...overrides,
  }
}

describe('createShutdown', () => {
  test('runs the cleanup and exits with code 0', () => {
    const calls: string[] = []
    const shutdown = createShutdown(
      () => calls.push('cleanup'),
      code => calls.push(`exit:${code}`),
    )

    shutdown()

    expect(calls).toEqual(['cleanup', 'exit:0'])
  })

  test('is re-entrant: several triggers firing together run cleanup and exit once', () => {
    let cleanups = 0
    let exits = 0
    const shutdown = createShutdown(
      () => { cleanups += 1 },
      () => { exits += 1 },
    )

    shutdown()
    shutdown()
    shutdown()

    expect(cleanups).toBe(1)
    expect(exits).toBe(1)
  })

  test('still exits when the cleanup throws, so a failed close never leaves the process alive', () => {
    const exitCodes: number[] = []
    const shutdown = createShutdown(
      () => { throw new Error('close failed') },
      code => exitCodes.push(code),
    )

    shutdown()

    expect(exitCodes).toEqual([0])
  })
})

describe('isOrphaned', () => {
  test('is false while the parent is unchanged and stdin is open', () => {
    expect(isOrphaned(makeSnapshot())).toBe(false)
  })

  test('is true once the process has been reparented', () => {
    expect(isOrphaned(makeSnapshot({ ppid: 1 }))).toBe(true)
  })

  test('ignores a ppid change on win32, where ppid does not track reparenting', () => {
    expect(isOrphaned(makeSnapshot({ platform: 'win32', ppid: 1 }))).toBe(false)
  })

  test('is true when stdin has been destroyed', () => {
    expect(isOrphaned(makeSnapshot({ stdinDestroyed: true }))).toBe(true)
  })

  test('is true when stdin has reached EOF', () => {
    expect(isOrphaned(makeSnapshot({ stdinEnded: true }))).toBe(true)
  })

  test('still detects a dead stdin on win32', () => {
    expect(isOrphaned(makeSnapshot({ platform: 'win32', stdinEnded: true }))).toBe(true)
  })
})
