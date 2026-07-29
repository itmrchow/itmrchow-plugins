import { describe, expect, test } from 'bun:test'
import { parseStartToken, redeemInvite, type RedeemDeps } from './invite-redeem'
import type { Invite } from './invite'
import { defaultAccess, type Access } from './access-schema'

const NOW = 1_700_000_000_000
const HOUR_MS = 60 * 60 * 1000
const TOKEN = 'a'.repeat(32)
const SENDER = '6083473232'

function makeInvite(overrides: Partial<Invite> = {}): Invite {
  return {
    createdAt: NOW - HOUR_MS,
    createdBy: 'discord:admin',
    expiresAt: NOW + HOUR_MS,
    usedBy: {},
    revokedAt: null,
    ...overrides,
  }
}

function makeAccess(overrides: Partial<Access> = {}): Access {
  return { ...defaultAccess(), invites: { [TOKEN]: makeInvite() }, ...overrides }
}

type Harness = {
  deps: RedeemDeps
  /** The object readAccess() hands out — assert on it after redemption. */
  access: Access
  saved: Access[]
  warnings: string[]
  readCount: () => number
}

function makeHarness(
  access: Access = makeAccess(),
  overrides: Partial<RedeemDeps> = {},
): Harness {
  const saved: Access[] = []
  const warnings: string[] = []
  let reads = 0
  const deps: RedeemDeps = {
    readAccess: () => { reads += 1; return access },
    saveAccess: a => { saved.push(a) },
    now: () => NOW,
    isStatic: false,
    bootInvites: undefined,
    warn: m => { warnings.push(m) },
    ...overrides,
  }
  return { deps, access, saved, warnings, readCount: () => reads }
}

describe('parseStartToken', () => {
  test('extracts a well-formed token', () => {
    expect(parseStartToken(`/start ${TOKEN}`)).toBe(TOKEN)
  })

  test('tolerates surrounding whitespace and multiple spaces', () => {
    expect(parseStartToken(`  /start   ${TOKEN}  `)).toBe(TOKEN)
  })

  test('ignores a bare /start', () => {
    expect(parseStartToken('/start')).toBeNull()
  })

  test('ignores a non-token payload, so ordinary messages still reach gate()', () => {
    expect(parseStartToken('/start 你好')).toBeNull()
    expect(parseStartToken('/start hello world')).toBeNull()
  })

  test('rejects uppercase hex — tokens are always minted lowercase', () => {
    expect(parseStartToken(`/start ${'A'.repeat(32)}`)).toBeNull()
  })

  test('rejects the wrong length', () => {
    expect(parseStartToken(`/start ${'a'.repeat(31)}`)).toBeNull()
    expect(parseStartToken(`/start ${'a'.repeat(33)}`)).toBeNull()
  })

  test('rejects a token with anything before or after it', () => {
    expect(parseStartToken(`hey /start ${TOKEN}`)).toBeNull()
    expect(parseStartToken(`/start ${TOKEN} thanks`)).toBeNull()
  })
})

describe('redeemInvite', () => {
  test('binds the sender and persists once', () => {
    const h = makeHarness()
    expect(redeemInvite(h.deps, SENDER, TOKEN)).toBe(true)
    expect(h.saved).toHaveLength(1)
    expect(h.access.allowFrom).toEqual([SENDER])
    expect(h.access.invites?.[TOKEN].usedBy).toEqual({ discord: [SENDER] })
  })

  test('drops an unknown token without writing', () => {
    const h = makeHarness()
    expect(redeemInvite(h.deps, SENDER, 'b'.repeat(32))).toBe(false)
    expect(h.saved).toHaveLength(0)
    expect(h.access.allowFrom).toEqual([])
  })

  test('drops an expired token without writing', () => {
    const h = makeHarness(makeAccess({
      invites: { [TOKEN]: makeInvite({ expiresAt: NOW - 1 }) },
    }))
    expect(redeemInvite(h.deps, SENDER, TOKEN)).toBe(false)
    expect(h.saved).toHaveLength(0)
  })

  test('drops a revoked token without writing', () => {
    const h = makeHarness(makeAccess({
      invites: { [TOKEN]: makeInvite({ revokedAt: NOW - 1 }) },
    }))
    expect(redeemInvite(h.deps, SENDER, TOKEN)).toBe(false)
    expect(h.saved).toHaveLength(0)
  })

  test('refuses under dmPolicy disabled, leaving allowFrom untouched', () => {
    const h = makeHarness(makeAccess({ dmPolicy: 'disabled' }))
    expect(redeemInvite(h.deps, SENDER, TOKEN)).toBe(false)
    expect(h.saved).toHaveLength(0)
    expect(h.access.allowFrom).toEqual([])
    expect(h.access.invites?.[TOKEN].usedBy).toEqual({})
  })

  test('in static mode with invites configured, warns once without the token', () => {
    const h = makeHarness(makeAccess(), {
      isStatic: true,
      bootInvites: { [TOKEN]: makeInvite() },
    })
    expect(redeemInvite(h.deps, SENDER, TOKEN)).toBe(false)
    expect(h.warnings).toHaveLength(1)
    expect(h.warnings[0]).not.toContain(TOKEN)
    expect(h.saved).toHaveLength(0)
  })

  test('in static mode with no invites configured, stays silent', () => {
    const h = makeHarness(makeAccess(), { isStatic: true, bootInvites: {} })
    expect(redeemInvite(h.deps, SENDER, TOKEN)).toBe(false)
    expect(h.warnings).toHaveLength(0)
  })

  test('re-redeeming the same token still welcomes but writes nothing', () => {
    const h = makeHarness(makeAccess({
      allowFrom: [SENDER],
      invites: { [TOKEN]: makeInvite({ usedBy: { discord: [SENDER] } }) },
    }))
    expect(redeemInvite(h.deps, SENDER, TOKEN)).toBe(true)
    expect(h.saved).toHaveLength(0)
  })

  test('keeps the telegram bucket intact when redeeming on discord', () => {
    const h = makeHarness(makeAccess({
      invites: { [TOKEN]: makeInvite({ usedBy: { telegram: ['tg-user'] } }) },
    }))
    expect(redeemInvite(h.deps, SENDER, TOKEN)).toBe(true)
    expect(h.access.invites?.[TOKEN].usedBy).toEqual({
      telegram: ['tg-user'],
      discord: [SENDER],
    })
  })

  test('clears the sender\'s pending pairing code, leaving other senders alone', () => {
    const h = makeHarness(makeAccess({
      pending: {
        abc123: { senderId: SENDER, chatId: 'dm-1', createdAt: NOW, expiresAt: NOW + HOUR_MS, replies: 1 },
        def456: { senderId: 'someone-else', chatId: 'dm-2', createdAt: NOW, expiresAt: NOW + HOUR_MS, replies: 1 },
      },
    }))
    expect(redeemInvite(h.deps, SENDER, TOKEN)).toBe(true)
    expect(Object.keys(h.access.pending)).toEqual(['def456'])
  })

  test('refuses to welcome when the write fails, and keeps the token out of the warning', () => {
    const h = makeHarness(makeAccess(), {
      saveAccess: () => { throw new Error('disk full') },
    })
    expect(redeemInvite(h.deps, SENDER, TOKEN)).toBe(false)
    expect(h.warnings).toHaveLength(1)
    expect(h.warnings[0]).not.toContain(TOKEN)
  })

  test('re-reads access on every call rather than caching', () => {
    const h = makeHarness()
    redeemInvite(h.deps, SENDER, TOKEN)
    redeemInvite(h.deps, 'another-user', TOKEN)
    expect(h.readCount()).toBe(2)
    expect(h.access.allowFrom).toEqual([SENDER, 'another-user'])
  })
})
