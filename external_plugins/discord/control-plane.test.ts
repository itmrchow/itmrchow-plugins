import { describe, expect, test } from 'bun:test'
import {
  CLEAR_CONFIRM_WINDOW_MS,
  decideClear,
  parseContextPercent,
  parseControlCommand,
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
