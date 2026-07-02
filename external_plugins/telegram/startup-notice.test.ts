import { describe, expect, test } from 'bun:test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  buildStartupNotice,
  claimRestartMarker,
  clearRestartMarker,
  consumeStartupNotice,
  MARKER_TTL_MS,
  parseInstalledPlugins,
  writeRestartMarker,
  type PluginSnapshot,
} from './startup-notice'

const T0 = 1_000_000_000_000

describe('parseInstalledPlugins', () => {
  test('parses the version-2 registry format', () => {
    const raw = JSON.stringify({
      version: 2,
      plugins: {
        'discord@itmrchow-plugins': [
          { version: '0.0.7', gitCommitSha: 'abc123', installPath: '/x' },
        ],
        'telegram@itmrchow-plugins': [{ version: '0.1.2', gitCommitSha: 'def456' }],
      },
    })
    expect(parseInstalledPlugins(raw)).toEqual({
      'discord@itmrchow-plugins': { version: '0.0.7', sha: 'abc123' },
      'telegram@itmrchow-plugins': { version: '0.1.2', sha: 'def456' },
    })
  })

  test('returns empty on corrupt JSON', () => {
    expect(parseInstalledPlugins('{nope')).toEqual({})
  })

  test('returns empty when the plugins map is missing', () => {
    expect(parseInstalledPlugins('{"version":2}')).toEqual({})
  })

  test('skips malformed entries but keeps valid ones', () => {
    const raw = JSON.stringify({
      plugins: {
        good: [{ version: '1.0.0' }],
        noVersion: [{ gitCommitSha: 'x' }],
        emptyArray: [],
        notArray: { version: '9.9.9' },
      },
    })
    expect(parseInstalledPlugins(raw)).toEqual({ good: { version: '1.0.0', sha: '' } })
  })

  test('multi-scope entries: picks the most recently updated install', () => {
    const raw = JSON.stringify({
      plugins: {
        'multi@m': [
          { version: '1.0.0', gitCommitSha: 'old', lastUpdated: '2026-01-01T00:00:00Z' },
          { version: '2.0.0', gitCommitSha: 'new', lastUpdated: '2026-06-01T00:00:00Z' },
        ],
      },
    })
    expect(parseInstalledPlugins(raw)).toEqual({
      'multi@m': { version: '2.0.0', sha: 'new' },
    })
  })

  test('multi-scope entries without lastUpdated fall back to the first', () => {
    const raw = JSON.stringify({
      plugins: {
        'multi@m': [
          { version: '1.0.0', gitCommitSha: 'a' },
          { version: '2.0.0', gitCommitSha: 'b' },
        ],
      },
    })
    expect(parseInstalledPlugins(raw)).toEqual({
      'multi@m': { version: '1.0.0', sha: 'a' },
    })
  })
})

describe('buildStartupNotice', () => {
  const base: PluginSnapshot = {
    'discord@m': { version: '0.0.7', sha: 'aaa' },
    'telegram@m': { version: '0.1.2', sha: 'bbb' },
  }

  test('lists unchanged plugins with bare versions', () => {
    const notice = buildStartupNotice(base, base)
    expect(notice).toBe(
      ['回來了，agent 重啟完成。', 'plugin 版本：', 'discord@m 0.0.7', 'telegram@m 0.1.2'].join(
        '\n',
      ),
    )
  })

  test('flags a version change with old -> new', () => {
    const current = { ...base, 'discord@m': { version: '0.0.8', sha: 'ccc' } }
    expect(buildStartupNotice(base, current)).toContain('discord@m 0.0.7 -> 0.0.8')
  })

  test('flags a sha-only change as (updated)', () => {
    const current = { ...base, 'discord@m': { version: '0.0.7', sha: 'zzz' } }
    expect(buildStartupNotice(base, current)).toContain('discord@m 0.0.7 (updated)')
  })

  test('flags plugins added or removed across the restart', () => {
    const current = {
      'discord@m': base['discord@m'],
      'newbie@m': { version: '1.0.0', sha: 'n' },
    }
    const notice = buildStartupNotice(base, current)
    expect(notice).toContain('newbie@m 1.0.0 (new)')
    expect(notice).toContain('telegram@m 0.1.2 (removed)')
  })

  test('degrades to the headline alone when no plugins are known', () => {
    expect(buildStartupNotice({}, {})).toBe('回來了，agent 重啟完成。')
  })

  test('contains no markdown or emoji', () => {
    const current = { ...base, 'discord@m': { version: '0.0.8', sha: 'ccc' } }
    const notice = buildStartupNotice(base, current)
    expect(notice).not.toMatch(/[*_`#\[\]]/)
    expect(notice).not.toMatch(/[\u{1F300}-\u{1FAFF}✅❌⚠]/u)
  })
})

describe('restart marker lifecycle', () => {
  function tempDir(): string {
    return mkdtempSync(join(tmpdir(), 'startup-notice-test-'))
  }

  test('write then claim round-trips the marker', () => {
    const dir = tempDir()
    const plugins: PluginSnapshot = { 'discord@m': { version: '0.0.7', sha: 'aaa' } }
    writeRestartMarker('manual /restart (test)', T0, plugins, dir)
    const marker = claimRestartMarker(dir, T0 + 1)
    expect(marker).toEqual({ ts: T0, reason: 'manual /restart (test)', plugins })
  })

  test('second claim loses the race (single notice guarantee)', () => {
    const dir = tempDir()
    writeRestartMarker('r', T0, {}, dir)
    expect(claimRestartMarker(dir, T0 + 1)).not.toBeNull()
    expect(claimRestartMarker(dir, T0 + 2)).toBeNull()
  })

  test('claim on a clean boot (no marker) returns null', () => {
    expect(claimRestartMarker(tempDir())).toBeNull()
  })

  test('clearRestartMarker removes an unclaimed marker', () => {
    const dir = tempDir()
    writeRestartMarker('r', T0, {}, dir)
    clearRestartMarker(dir)
    expect(claimRestartMarker(dir, T0 + 1)).toBeNull()
  })

  test('a corrupt marker is consumed silently (null, no repeat)', () => {
    const dir = tempDir()
    writeFileSync(join(dir, 'restart-notice.json'), '{corrupt')
    expect(claimRestartMarker(dir)).toBeNull()
    expect(claimRestartMarker(dir)).toBeNull()
  })

  test('a marker just inside the TTL is still claimable', () => {
    const dir = tempDir()
    writeRestartMarker('r', T0, {}, dir)
    expect(claimRestartMarker(dir, T0 + MARKER_TTL_MS)).not.toBeNull()
  })

  test('a marker past the TTL is consumed silently (stale restart)', () => {
    const dir = tempDir()
    writeRestartMarker('r', T0, {}, dir)
    expect(claimRestartMarker(dir, T0 + MARKER_TTL_MS + 1)).toBeNull()
    // Consumed, not left behind: a later claim finds nothing either.
    expect(claimRestartMarker(dir, T0 + MARKER_TTL_MS + 2)).toBeNull()
  })

  test('consumeStartupNotice builds the diffed notice from the marker', () => {
    const dir = tempDir()
    // consumeStartupNotice claims with the real clock — write a fresh marker.
    writeRestartMarker('r', Date.now(), { 'discord@m': { version: '0.0.7', sha: 'aaa' } }, dir)
    const notice = consumeStartupNotice(dir, { 'discord@m': { version: '0.0.8', sha: 'bbb' } })
    expect(notice).toContain('回來了')
    expect(notice).toContain('discord@m 0.0.7 -> 0.0.8')
    expect(consumeStartupNotice(dir, {})).toBeNull()
  })
})
