import { describe, expect, test } from 'bun:test'
import { resolveInjectHost } from './inject-host'

const DEFAULT_HOST = '127.0.0.1'

describe('resolveInjectHost', () => {
  test('falls back to the default when the key is unset — behaviour matches the loopback-only current version', () => {
    expect(resolveInjectHost(undefined, DEFAULT_HOST)).toBe(DEFAULT_HOST)
  })

  test('honours a non-loopback override', () => {
    expect(resolveInjectHost('10.140.15.196', DEFAULT_HOST)).toBe('10.140.15.196')
  })

  test('falls back on an empty string — a set-but-empty env var is defined, so ?? cannot catch it', () => {
    expect(resolveInjectHost('', DEFAULT_HOST)).toBe(DEFAULT_HOST)
  })

  test('falls back on a whitespace-only value', () => {
    expect(resolveInjectHost('   ', DEFAULT_HOST)).toBe(DEFAULT_HOST)
  })

  test('trims surrounding whitespace from a valid value', () => {
    expect(resolveInjectHost('  10.140.15.196  ', DEFAULT_HOST)).toBe('10.140.15.196')
  })
})
