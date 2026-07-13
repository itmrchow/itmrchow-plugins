import { describe, expect, test } from 'bun:test'
import { resolveInjectPort } from './inject-port'

const DEFAULT_PORT = 7842
const KEY = 'TELEGRAM_INJECT_PORT'

describe('resolveInjectPort', () => {
  test('falls back to the default when the key is unset', () => {
    expect(resolveInjectPort(undefined, DEFAULT_PORT, KEY)).toBe(DEFAULT_PORT)
  })

  test('honours a valid override', () => {
    expect(resolveInjectPort('7998', DEFAULT_PORT, KEY)).toBe(7998)
  })

  test('falls back on an empty string — a set-but-empty env var is defined, so ?? cannot catch it', () => {
    expect(resolveInjectPort('', DEFAULT_PORT, KEY)).toBe(DEFAULT_PORT)
  })

  test('falls back on a non-numeric value instead of binding NaN', () => {
    expect(resolveInjectPort('abc', DEFAULT_PORT, KEY)).toBe(DEFAULT_PORT)
  })

  test('falls back on a trailing-garbage value rather than silently truncating it', () => {
    expect(resolveInjectPort('7998abc', DEFAULT_PORT, KEY)).toBe(DEFAULT_PORT)
  })

  test('falls back on a non-integer value', () => {
    expect(resolveInjectPort('78.5', DEFAULT_PORT, KEY)).toBe(DEFAULT_PORT)
  })

  test('falls back on port 0 and on out-of-range ports', () => {
    expect(resolveInjectPort('0', DEFAULT_PORT, KEY)).toBe(DEFAULT_PORT)
    expect(resolveInjectPort('-1', DEFAULT_PORT, KEY)).toBe(DEFAULT_PORT)
    expect(resolveInjectPort('65536', DEFAULT_PORT, KEY)).toBe(DEFAULT_PORT)
  })

  test('accepts the range boundaries', () => {
    expect(resolveInjectPort('1', DEFAULT_PORT, KEY)).toBe(1)
    expect(resolveInjectPort('65535', DEFAULT_PORT, KEY)).toBe(65535)
  })
})
