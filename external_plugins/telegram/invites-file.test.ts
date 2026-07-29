import { describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Invite } from './invite'
import {
  INVITES_FILE_VERSION,
  migrateInvitesFromAccess,
  pickInvites,
  readInvites,
  readLegacyAccessInvites,
  resolveInvitesFile,
  saveInvites,
  type MigrateDeps,
} from './invites-file'

const TOKEN = 'a'.repeat(32)
const OTHER_TOKEN = 'b'.repeat(32)

function makeInvite(overrides: Partial<Invite> = {}): Invite {
  return {
    createdAt: 1_000,
    createdBy: 'admin-1',
    expiresAt: 9_999_999_999_999,
    usedBy: {},
    revokedAt: null,
    ...overrides,
  }
}

function scratch(): string {
  return mkdtempSync(join(tmpdir(), 'invites-file-'))
}

describe('resolveInvitesFile', () => {
  test('INVITES_FILE overrides the default', () => {
    expect(resolveInvitesFile({ INVITES_FILE: '/srv/invites.json' }, '/home/x'))
      .toBe('/srv/invites.json')
  })

  test('defaults to channels/invites.json, outside any platform subdirectory', () => {
    expect(resolveInvitesFile({}, '/home/x'))
      .toBe('/home/x/.claude/channels/invites.json')
  })
})

describe('readInvites', () => {
  test('a missing file is an empty map, not an error', () => {
    expect(readInvites(join(scratch(), 'nope.json'))).toEqual({})
  })

  test('corrupt JSON is moved aside and read as empty', () => {
    const dir = scratch()
    const file = join(dir, 'invites.json')
    writeFileSync(file, '{ not json')
    expect(readInvites(file)).toEqual({})
    expect(existsSync(file)).toBe(false)
    expect(readdirSync(dir).some(f => f.startsWith('invites.json.corrupt-'))).toBe(true)
  })

  test('round-trips what saveInvites wrote', () => {
    const file = join(scratch(), 'invites.json')
    const invites = { [TOKEN]: makeInvite({ note: 'jeff' }) }
    saveInvites(file, invites)
    expect(readInvites(file)).toEqual(invites)
  })

  test('unknown fields are dropped and __proto__ does not pollute', () => {
    const file = join(scratch(), 'invites.json')
    writeFileSync(file, JSON.stringify({
      version: 1,
      invites: {
        [TOKEN]: { ...makeInvite(), sneaky: 'x' },
        __proto__: { polluted: true },
      },
    }))
    const invites = readInvites(file)
    expect(invites[TOKEN]).toEqual(makeInvite())
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
    // The key survives as an ordinary own property — it just isn't a prototype.
    expect(Object.getPrototypeOf(invites)).toBe(Object.prototype)
  })

  test('a non-object payload yields an empty map rather than throwing', () => {
    const file = join(scratch(), 'invites.json')
    writeFileSync(file, '"just a string"')
    expect(readInvites(file)).toEqual({})
  })
})

describe('saveInvites', () => {
  test('writes the versioned envelope', () => {
    const file = join(scratch(), 'invites.json')
    saveInvites(file, { [TOKEN]: makeInvite() })
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as { version: number }
    expect(parsed.version).toBe(INVITES_FILE_VERSION)
  })

  test('leaves no .tmp behind and keeps the file at 0600', () => {
    const dir = scratch()
    const file = join(dir, 'invites.json')
    saveInvites(file, { [TOKEN]: makeInvite() })
    saveInvites(file, { [TOKEN]: makeInvite(), [OTHER_TOKEN]: makeInvite() })
    expect(readdirSync(dir)).toEqual(['invites.json'])
    expect(statSync(file).mode & 0o777).toBe(0o600)
  })

  test('creates the parent directory when it does not exist', () => {
    const file = join(scratch(), 'deep', 'nested', 'invites.json')
    saveInvites(file, {})
    expect(existsSync(file)).toBe(true)
  })
})

describe('readLegacyAccessInvites', () => {
  test('reads the raw field that the access whitelist no longer keeps', () => {
    const file = join(scratch(), 'access.json')
    writeFileSync(file, JSON.stringify({
      dmPolicy: 'allowlist',
      allowFrom: [],
      invites: { [TOKEN]: makeInvite() },
    }))
    expect(readLegacyAccessInvites(file)).toEqual({ [TOKEN]: makeInvite() })
  })

  test('a missing or corrupt file is null, meaning nothing to migrate', () => {
    const dir = scratch()
    expect(readLegacyAccessInvites(join(dir, 'nope.json'))).toBeNull()
    const bad = join(dir, 'access.json')
    writeFileSync(bad, '{ not json')
    expect(readLegacyAccessInvites(bad)).toBeNull()
  })

  test('an access.json without invites is an empty map', () => {
    const file = join(scratch(), 'access.json')
    writeFileSync(file, JSON.stringify({ dmPolicy: 'pairing', allowFrom: [] }))
    expect(readLegacyAccessInvites(file)).toEqual({})
  })
})

describe('pickInvites', () => {
  test('tolerates any shape', () => {
    expect(pickInvites(null)).toEqual({})
    expect(pickInvites(42)).toEqual({})
    expect(pickInvites({ invites: [1, 2] })).toEqual({})
    expect(pickInvites({ invites: { [TOKEN]: 'not an object' } })).toEqual({})
  })
})

describe('migrateInvitesFromAccess', () => {
  type Recorded = {
    saved: Record<string, Invite>[]
    stripped: number
    warnings: string[]
  }

  function harness(
    legacy: Record<string, Invite> | null,
    shared: Record<string, Invite>,
    isStatic = false,
  ): { deps: MigrateDeps; log: Recorded } {
    const log: Recorded = { saved: [], stripped: 0, warnings: [] }
    return {
      log,
      deps: {
        isStatic,
        readLegacy: () => legacy,
        readShared: () => shared,
        saveShared: invites => { log.saved.push(structuredClone(invites)) },
        stripLegacy: () => { log.stripped += 1 },
        warn: m => { log.warnings.push(m) },
      },
    }
  }

  test('moves tokens into an absent shared file and strips the source', () => {
    const { deps, log } = harness({ [TOKEN]: makeInvite() }, {})
    expect(migrateInvitesFromAccess(deps)).toBe(true)
    expect(log.saved).toEqual([{ [TOKEN]: makeInvite() }])
    expect(log.stripped).toBe(1)
  })

  test('merges: the second platform contributes only what is missing', () => {
    const shared = { [TOKEN]: makeInvite({ note: 'from telegram' }) }
    const legacy = {
      [TOKEN]: makeInvite({ note: 'discord copy, stale' }),
      [OTHER_TOKEN]: makeInvite({ note: 'discord only' }),
    }
    const { deps, log } = harness(legacy, shared)
    expect(migrateInvitesFromAccess(deps)).toBe(true)
    expect(log.saved[0][TOKEN].note).toBe('from telegram')
    expect(log.saved[0][OTHER_TOKEN].note).toBe('discord only')
  })

  test('a second run with nothing new still strips but saves nothing', () => {
    const { deps, log } = harness({ [TOKEN]: makeInvite() }, { [TOKEN]: makeInvite() })
    expect(migrateInvitesFromAccess(deps)).toBe(false)
    expect(log.saved).toEqual([])
    expect(log.stripped).toBe(1)
  })

  test('is a no-op when access.json is absent or carries no invites', () => {
    for (const legacy of [null, {}]) {
      const { deps, log } = harness(legacy, {})
      expect(migrateInvitesFromAccess(deps)).toBe(false)
      expect(log.stripped).toBe(0)
      expect(log.warnings).toEqual([])
    }
  })

  test('static mode warns and touches nothing', () => {
    const { deps, log } = harness({ [TOKEN]: makeInvite() }, {}, true)
    expect(migrateInvitesFromAccess(deps)).toBe(false)
    expect(log.saved).toEqual([])
    expect(log.stripped).toBe(0)
    expect(log.warnings[0]).toContain('static mode')
  })

  test('never throws, and never strips the source when the shared write failed', () => {
    const { deps, log } = harness({ [TOKEN]: makeInvite() }, {})
    deps.saveShared = () => { throw new Error('disk full') }
    expect(() => migrateInvitesFromAccess(deps)).not.toThrow()
    expect(log.stripped).toBe(0)
    expect(log.warnings[0]).toContain('disk full')
  })

  test('end to end on real files: access.json invites land in the shared file', () => {
    const dir = scratch()
    const accessFile = join(dir, 'access.json')
    const sharedFile = join(dir, 'invites.json')
    writeFileSync(accessFile, JSON.stringify({
      dmPolicy: 'allowlist',
      allowFrom: ['1'],
      invites: { [TOKEN]: makeInvite() },
    }))
    migrateInvitesFromAccess({
      isStatic: false,
      readLegacy: () => readLegacyAccessInvites(accessFile),
      readShared: () => readInvites(sharedFile),
      saveShared: invites => { saveInvites(sharedFile, invites) },
      stripLegacy: () => {
        const parsed = JSON.parse(readFileSync(accessFile, 'utf8')) as Record<string, unknown>
        delete parsed.invites
        writeFileSync(accessFile, JSON.stringify(parsed))
      },
      warn: () => {},
    })
    expect(readInvites(sharedFile)).toEqual({ [TOKEN]: makeInvite() })
    expect(readFileSync(accessFile, 'utf8')).not.toContain('invites')
  })
})

describe('cross-plugin copies', () => {
  test('every channel plugin ships a byte-identical invites-file.ts', () => {
    const pluginsDir = join(import.meta.dir, '..')
    const copies = readdirSync(pluginsDir)
      .map(name => join(pluginsDir, name, 'invites-file.ts'))
      .filter(path => existsSync(path))
    // Two today (telegram, discord). One would mean this guard stopped guarding.
    expect(copies.length).toBeGreaterThan(1)
    const contents = copies.map(path => readFileSync(path, 'utf8'))
    for (const [i, body] of contents.entries()) {
      expect(`${copies[i]}\n${body}`).toBe(`${copies[i]}\n${contents[0]}`)
    }
  })
})
