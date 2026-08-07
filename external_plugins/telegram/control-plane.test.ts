import { describe, expect, test } from 'bun:test'
import {
  CLEAR_CONFIRM_WINDOW_MS,
  CONTROL_COMMANDS,
  decideClear,
  parseContextPercent,
  parseControlCommand,
  resolveControlCommands,
} from './control-plane'

const T0 = 1_000_000_000_000

describe('decideClear (busy confirmation)', () => {
  test('executes immediately when idle', () => {
    expect(decideClear(false, null, T0)).toBe('execute')
  })

  test('warns on first busy /clear', () => {
    expect(decideClear(true, null, T0)).toBe('warn')
  })

  test('executes a busy /clear repeated within the confirm window', () => {
    expect(decideClear(true, T0, T0 + CLEAR_CONFIRM_WINDOW_MS - 1)).toBe('execute')
  })

  test('warns again if the confirm window lapsed', () => {
    expect(decideClear(true, T0, T0 + CLEAR_CONFIRM_WINDOW_MS)).toBe('warn')
  })
})

describe('parseControlCommand', () => {
  test('matches a bare control command', () => {
    expect(parseControlCommand('/ctx')).toBe('ctx')
    expect(parseControlCommand('/clear')).toBe('clear')
    expect(parseControlCommand('/restart')).toBe('restart')
  })

  test('is case-insensitive and ignores trailing args', () => {
    expect(parseControlCommand('/CTX')).toBe('ctx')
    expect(parseControlCommand('/Restart now please')).toBe('restart')
    expect(parseControlCommand('  /clear  ')).toBe('clear')
  })

  test('returns null for non-control commands and plain chat', () => {
    expect(parseControlCommand('/help')).toBeNull()
    expect(parseControlCommand('hello /ctx')).toBeNull() // not leading
    expect(parseControlCommand('ctx')).toBeNull() // no slash
    expect(parseControlCommand('')).toBeNull()
    expect(parseControlCommand('/')).toBeNull()
  })
})

describe('parseContextPercent', () => {
  test('parses "context left" as used = 100 - left', () => {
    expect(parseContextPercent('Context left: 23%').pct).toBe(77)
    expect(parseContextPercent('23% context remaining').pct).toBe(77)
  })

  test('parses "context used" directly', () => {
    expect(parseContextPercent('Context: 77% used').pct).toBe(77)
    expect(parseContextPercent('77% context used').pct).toBe(77)
  })

  test('returns null pct with raw tail on unrecognized footer', () => {
    const r = parseContextPercent('✻ Working… (12s · ↑ 3.4k tokens · esc to interrupt)')
    expect(r.pct).toBeNull()
    expect(r.raw).toContain('Working')
  })

  test('rejects out-of-range numbers', () => {
    expect(parseContextPercent('Context: 150% used').pct).toBeNull()
  })

  test('keeps only the trailing footer lines in raw', () => {
    const pane = Array.from({ length: 20 }, (_, i) => `line ${i}`).join('\n')
    const r = parseContextPercent(pane)
    expect(r.raw).toContain('line 19')
    expect(r.raw).not.toContain('line 0')
  })
})

describe('resolveControlCommands', () => {
  test('defaults to every control command when unset or blank', () => {
    expect(resolveControlCommands(undefined, 'X')).toEqual(CONTROL_COMMANDS)
    expect(resolveControlCommands('', 'X')).toEqual(CONTROL_COMMANDS)
    expect(resolveControlCommands('   ', 'X')).toEqual(CONTROL_COMMANDS)
  })

  test('keeps only the listed commands', () => {
    expect(resolveControlCommands('ctx', 'X')).toEqual(['ctx'])
    expect(resolveControlCommands('ctx,restart', 'X')).toEqual(['ctx', 'restart'])
  })

  test('tolerates spacing, casing, and duplicates', () => {
    expect(resolveControlCommands(' CTX , clear , ctx ,, ', 'X')).toEqual(['ctx', 'clear'])
  })

  test('skips unknown names but keeps the known ones', () => {
    expect(resolveControlCommands('ctx,bogus', 'X')).toEqual(['ctx'])
  })

  test('falls back to every command when nothing recognized', () => {
    expect(resolveControlCommands('bogus,none', 'X')).toEqual(CONTROL_COMMANDS)
  })
})

describe('parseControlCommand (enabled subset)', () => {
  test('matches only enabled commands', () => {
    expect(parseControlCommand('/ctx', ['ctx'])).toBe('ctx')
    expect(parseControlCommand('/clear', ['ctx'])).toBeNull()
    expect(parseControlCommand('/restart', ['ctx'])).toBeNull()
  })

  test('an omitted enabled list still matches everything', () => {
    for (const cmd of CONTROL_COMMANDS) {
      expect(parseControlCommand(`/${cmd}`)).toBe(cmd)
    }
  })
})
