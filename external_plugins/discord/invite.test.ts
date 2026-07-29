import { describe, expect, test } from 'bun:test'
import {
  applyBind,
  checkInvite,
  generateInviteToken,
  pruneRevoked,
  REVOKED_RETENTION_MS,
  type Invite,
} from './invite'

const NOW = 1_700_000_000_000
const HOUR_MS = 60 * 60 * 1000

function makeInvite(overrides: Partial<Invite> = {}): Invite {
  return {
    createdAt: NOW - HOUR_MS,
    createdBy: 'discord:6083473232',
    expiresAt: NOW + HOUR_MS,
    usedBy: {},
    revokedAt: null,
    ...overrides,
  }
}

describe('checkInvite', () => {
  test('rejects an unknown token', () => {
    expect(checkInvite({}, 'deadbeef', NOW)).toEqual({ ok: false, reason: 'unknown' })
  })

  test('rejects an expired token', () => {
    const invites = { tok: makeInvite({ expiresAt: NOW - 1 }) }
    expect(checkInvite(invites, 'tok', NOW)).toEqual({ ok: false, reason: 'expired' })
  })

  test('treats expiresAt exactly equal to now as expired', () => {
    const invites = { tok: makeInvite({ expiresAt: NOW }) }
    expect(checkInvite(invites, 'tok', NOW)).toEqual({ ok: false, reason: 'expired' })
  })

  test('reports revoked before expired when both apply', () => {
    const invites = { tok: makeInvite({ expiresAt: NOW - 1, revokedAt: NOW - HOUR_MS }) }
    expect(checkInvite(invites, 'tok', NOW)).toEqual({ ok: false, reason: 'revoked' })
  })

  test('rejects a revoked but unexpired token', () => {
    const invites = { tok: makeInvite({ revokedAt: NOW - 1 }) }
    expect(checkInvite(invites, 'tok', NOW)).toEqual({ ok: false, reason: 'revoked' })
  })

  test('accepts a live token', () => {
    expect(checkInvite({ tok: makeInvite() }, 'tok', NOW)).toEqual({ ok: true })
  })

  test('rejects inherited Object keys as unknown, not by luck of another check', () => {
    const invites = { tok: makeInvite() }
    for (const key of ['__proto__', 'constructor', 'toString', 'hasOwnProperty']) {
      expect(checkInvite(invites, key, NOW)).toEqual({ ok: false, reason: 'unknown' })
    }
  })
})

describe('applyBind', () => {
  test('records a first-time redeemer', () => {
    const invite = makeInvite()
    expect(applyBind(invite, 'discord', '111')).toBe(true)
    expect(invite.usedBy).toEqual({ discord: ['111'] })
  })

  test('is a no-op when the same sender redeems again', () => {
    const invite = makeInvite({ usedBy: { discord: ['111'] } })
    expect(applyBind(invite, 'discord', '111')).toBe(false)
    expect(invite.usedBy.discord).toEqual(['111'])
  })

  test('appends a second distinct sender on the same platform', () => {
    const invite = makeInvite({ usedBy: { discord: ['111'] } })
    expect(applyBind(invite, 'discord', '222')).toBe(true)
    expect(invite.usedBy.discord).toEqual(['111', '222'])
  })

  test('creates a new platform bucket without touching existing ones', () => {
    const invite = makeInvite({ usedBy: { discord: ['111'] } })
    expect(applyBind(invite, 'telegram', '999')).toBe(true)
    expect(invite.usedBy).toEqual({ discord: ['111'], telegram: ['999'] })
  })
})

describe('pruneRevoked', () => {
  test('keeps a tombstone still inside the retention window', () => {
    const invites = { tok: makeInvite({ revokedAt: NOW - REVOKED_RETENTION_MS }) }
    expect(pruneRevoked(invites, NOW, REVOKED_RETENTION_MS)).toBe(false)
    expect(Object.keys(invites)).toEqual(['tok'])
  })

  test('deletes a tombstone past the retention window', () => {
    const invites = { tok: makeInvite({ revokedAt: NOW - REVOKED_RETENTION_MS - 1 }) }
    expect(pruneRevoked(invites, NOW, REVOKED_RETENTION_MS)).toBe(true)
    expect(invites).toEqual({})
  })

  test('never deletes an un-revoked invite, however old or expired', () => {
    const invites = {
      tok: makeInvite({ createdAt: 0, expiresAt: 1, revokedAt: null }),
    }
    expect(pruneRevoked(invites, NOW, REVOKED_RETENTION_MS)).toBe(false)
    expect(Object.keys(invites)).toEqual(['tok'])
  })

  test('prunes only the stale tombstones in a mixed set', () => {
    const invites = {
      stale: makeInvite({ revokedAt: NOW - REVOKED_RETENTION_MS - 1 }),
      fresh: makeInvite({ revokedAt: NOW - 1 }),
      live: makeInvite(),
    }
    expect(pruneRevoked(invites, NOW, REVOKED_RETENTION_MS)).toBe(true)
    expect(Object.keys(invites).sort()).toEqual(['fresh', 'live'])
  })
})

describe('generateInviteToken', () => {
  test('returns 32 lowercase hex chars', () => {
    expect(generateInviteToken()).toMatch(/^[0-9a-f]{32}$/)
  })

  test('does not repeat across calls', () => {
    expect(generateInviteToken()).not.toBe(generateInviteToken())
  })
})
