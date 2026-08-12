import { describe, expect, test } from 'bun:test'
import { resolveCount, resolvePort } from './resolve-port'

const DEFAULT_PORT = 7852
const KEY = 'TELEGRAM_POLLER_PORT'

describe('resolvePort', () => {
  test('falls back to the default when the key is unset', () => {
    expect(resolvePort(undefined, DEFAULT_PORT, KEY)).toBe(DEFAULT_PORT)
  })

  test('honours a valid override', () => {
    expect(resolvePort('7998', DEFAULT_PORT, KEY)).toBe(7998)
  })

  test('falls back on an empty string — a set-but-empty env var is defined, so ?? cannot catch it', () => {
    expect(resolvePort('', DEFAULT_PORT, KEY)).toBe(DEFAULT_PORT)
  })

  test('falls back on a non-numeric value instead of binding NaN', () => {
    expect(resolvePort('abc', DEFAULT_PORT, KEY)).toBe(DEFAULT_PORT)
  })

  test('falls back on a trailing-garbage value rather than silently truncating it', () => {
    expect(resolvePort('7998abc', DEFAULT_PORT, KEY)).toBe(DEFAULT_PORT)
  })

  test('falls back on a non-integer value', () => {
    expect(resolvePort('78.5', DEFAULT_PORT, KEY)).toBe(DEFAULT_PORT)
  })

  test('falls back on port 0 and on out-of-range ports', () => {
    expect(resolvePort('0', DEFAULT_PORT, KEY)).toBe(DEFAULT_PORT)
    expect(resolvePort('-1', DEFAULT_PORT, KEY)).toBe(DEFAULT_PORT)
    expect(resolvePort('65536', DEFAULT_PORT, KEY)).toBe(DEFAULT_PORT)
  })

  test('accepts the range boundaries', () => {
    expect(resolvePort('1', DEFAULT_PORT, KEY)).toBe(1)
    expect(resolvePort('65535', DEFAULT_PORT, KEY)).toBe(65535)
  })
})

describe('resolveCount', () => {
  const CAP_KEY = 'MAX_SCOPES'
  const DEFAULT_CAP = 10

  test('falls back to the default when the key is unset', () => {
    expect(resolveCount(undefined, DEFAULT_CAP, CAP_KEY)).toBe(DEFAULT_CAP)
  })

  test('honours a valid override', () => {
    expect(resolveCount('3', DEFAULT_CAP, CAP_KEY)).toBe(3)
  })

  test('falls back on zero, negatives, non-integers, and blanks', () => {
    expect(resolveCount('0', DEFAULT_CAP, CAP_KEY)).toBe(DEFAULT_CAP)
    expect(resolveCount('-1', DEFAULT_CAP, CAP_KEY)).toBe(DEFAULT_CAP)
    expect(resolveCount('2.5', DEFAULT_CAP, CAP_KEY)).toBe(DEFAULT_CAP)
    expect(resolveCount('', DEFAULT_CAP, CAP_KEY)).toBe(DEFAULT_CAP)
    expect(resolveCount('abc', DEFAULT_CAP, CAP_KEY)).toBe(DEFAULT_CAP)
  })

  test('accepts counts beyond the TCP port range, unlike resolvePort', () => {
    expect(resolveCount('70000', DEFAULT_CAP, CAP_KEY)).toBe(70000)
  })
})
