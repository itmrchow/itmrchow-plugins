import { afterEach, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadTokens, resolveService, type TokenEntry } from './auth'

const dirs: string[] = []

afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true })
})

/** Write a tokens.json with the given raw content, returning its path. */
function tokenFile(content: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'internal-inject-'))
  dirs.push(dir)
  const file = join(dir, 'tokens.json')
  writeFileSync(file, content)
  return file
}

function sha256(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

function entry(service: string, token: string): TokenEntry {
  return { service, token_sha256: sha256(token), issued_at: '2026-07-14T12:00:00Z' }
}

describe('loadTokens', () => {
  test('reads valid entries', () => {
    const file = tokenFile(JSON.stringify({ tokens: [entry('mgmt', 'secret')] }))
    const { entries, problem } = loadTokens(file)
    expect(problem).toBeUndefined()
    expect(entries).toHaveLength(1)
    expect(entries[0]!.service).toBe('mgmt')
  })

  test('a missing file yields a problem, not a throw — the server must stay bound to its port', () => {
    const { entries, problem } = loadTokens('/nonexistent/tokens.json')
    expect(entries).toEqual([])
    expect(problem).toContain('not readable')
  })

  test('a corrupt file yields a problem, not a throw', () => {
    const { entries, problem } = loadTokens(tokenFile('{ not json'))
    expect(entries).toEqual([])
    expect(problem).toContain('not valid JSON')
  })

  test('a file without a tokens array yields a problem', () => {
    const { entries, problem } = loadTokens(tokenFile(JSON.stringify({ services: [] })))
    expect(entries).toEqual([])
    expect(problem).toContain('no "tokens" array')
  })

  test('drops malformed entries and keeps the valid ones', () => {
    const file = tokenFile(JSON.stringify({
      tokens: [
        { service: 'no-hash' },
        { service: 'short-hash', token_sha256: 'abc' },
        { service: 'not-hex', token_sha256: 'z'.repeat(64) },
        { token_sha256: sha256('nameless') },
        entry('mgmt', 'secret'),
      ],
    }))
    const { entries, problem } = loadTokens(file)
    expect(problem).toBeUndefined()
    expect(entries.map(e => e.service)).toEqual(['mgmt'])
  })

  test('an empty tokens array yields a problem', () => {
    const { entries, problem } = loadTokens(tokenFile(JSON.stringify({ tokens: [] })))
    expect(entries).toEqual([])
    expect(problem).toContain('no valid entries')
  })
})

describe('resolveService', () => {
  const entries = [entry('stock-monitor', 'token-a'), entry('mgmt', 'token-b')]

  test('resolves a known token to its service', () => {
    expect(resolveService('Bearer token-a', entries)).toBe('stock-monitor')
    expect(resolveService('Bearer token-b', entries)).toBe('mgmt')
  })

  test('matches the Bearer scheme case-insensitively (RFC 7235), the token exactly', () => {
    expect(resolveService('bearer token-a', entries)).toBe('stock-monitor')
    expect(resolveService('Bearer TOKEN-A', entries)).toBeNull()
  })

  test.each([
    ['header absent', undefined],
    ['empty header', ''],
    ['no scheme', 'token-a'],
    ['wrong scheme', 'Basic token-a'],
    ['scheme with no token', 'Bearer'],
    ['scheme with empty token', 'Bearer '],
  ])('rejects %s', (_name, header) => {
    expect(resolveService(header, entries)).toBeNull()
  })

  test('rejects an unknown token', () => {
    expect(resolveService('Bearer nope', entries)).toBeNull()
  })

  test('rejects everything when the token table is empty — the missing-file path', () => {
    expect(resolveService('Bearer token-a', [])).toBeNull()
  })

  test('a caller cannot present the stored digest itself as the token', () => {
    // The file stores sha256(token). Leaking it must not be equivalent to leaking
    // the token — that is the whole reason the plaintext is not stored.
    expect(resolveService(`Bearer ${sha256('token-a')}`, entries)).toBeNull()
  })
})
