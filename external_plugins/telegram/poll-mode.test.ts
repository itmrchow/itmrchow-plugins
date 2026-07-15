import { describe, expect, test } from 'bun:test'
import { resolvePollMode } from './poll-mode'

describe('resolvePollMode', () => {
  describe('platform default (env unset)', () => {
    test('arm64-linux defaults to decoupled — the one platform with the starvation bug', () => {
      expect(resolvePollMode('arm64', 'linux', undefined)).toBe('decoupled')
    })

    test('x64-linux defaults to builtin', () => {
      expect(resolvePollMode('x64', 'linux', undefined)).toBe('builtin')
    })

    test('arm64-darwin (Apple Silicon Mac) defaults to builtin', () => {
      expect(resolvePollMode('arm64', 'darwin', undefined)).toBe('builtin')
    })

    test('x64-darwin defaults to builtin', () => {
      expect(resolvePollMode('x64', 'darwin', undefined)).toBe('builtin')
    })
  })

  describe('explicit override', () => {
    test('decoupled is honoured on x64 (test/forced)', () => {
      expect(resolvePollMode('x64', 'linux', 'decoupled')).toBe('decoupled')
    })

    test('builtin is honoured on x64', () => {
      expect(resolvePollMode('x64', 'linux', 'builtin')).toBe('builtin')
    })

    test('decoupled is honoured on arm64-linux (matches default)', () => {
      expect(resolvePollMode('arm64', 'linux', 'decoupled')).toBe('decoupled')
    })

    test('builtin on non-starving arm64-darwin is honoured (not clamped)', () => {
      expect(resolvePollMode('arm64', 'darwin', 'builtin')).toBe('builtin')
    })
  })

  describe('clamp: builtin on arm64-linux is forced back to decoupled', () => {
    test('arm64-linux + builtin -> decoupled', () => {
      expect(resolvePollMode('arm64', 'linux', 'builtin')).toBe('decoupled')
    })
  })

  describe('env value tolerance', () => {
    test('trims and lowercases the value', () => {
      expect(resolvePollMode('x64', 'linux', '  BuiltIn  ')).toBe('builtin')
      expect(resolvePollMode('x64', 'linux', 'DECOUPLED')).toBe('decoupled')
    })

    test('blank / whitespace-only value falls back to the platform default', () => {
      expect(resolvePollMode('arm64', 'linux', '')).toBe('decoupled')
      expect(resolvePollMode('x64', 'linux', '   ')).toBe('builtin')
    })

    test('unrecognised value falls back to the platform default', () => {
      expect(resolvePollMode('x64', 'linux', 'foo')).toBe('builtin')
      expect(resolvePollMode('arm64', 'linux', 'foo')).toBe('decoupled')
    })
  })
})
