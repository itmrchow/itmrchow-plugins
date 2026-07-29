import { describe, expect, test } from 'bun:test'
import { ACCESS_FIELDS, defaultAccess, pickAccessFields, type Access } from './access-schema'

// Fixtures are DERIVED FROM ACCESS_FIELDS, never hand-written. A hand-written
// object would be forgotten by exactly the same person who forgot to add the
// field to the rebuild, and the test would stay green while data silently
// dropped. Generating it means a new field is covered the moment it joins the
// list.
function markerFor(field: string): { marker: string } {
  return { marker: `value-of-${field}` }
}

function allFieldsPresent(): Partial<Access> {
  return Object.fromEntries(
    ACCESS_FIELDS.map(field => [field, markerFor(field)]),
  ) as unknown as Partial<Access>
}

describe('ACCESS_FIELDS', () => {
  test('has no duplicates', () => {
    expect(new Set(ACCESS_FIELDS).size).toBe(ACCESS_FIELDS.length)
  })

  test('covers every key defaultAccess() produces', () => {
    for (const field of Object.keys(defaultAccess())) {
      expect(ACCESS_FIELDS).toContain(field as (typeof ACCESS_FIELDS)[number])
    }
  })
})

describe('pickAccessFields', () => {
  test('round-trips every field in ACCESS_FIELDS', () => {
    const input = allFieldsPresent()
    const out = pickAccessFields(input) as unknown as Record<string, unknown>
    for (const field of ACCESS_FIELDS) {
      expect(out[field]).toEqual(markerFor(field))
    }
  })

  test('returns exactly the known fields, no more', () => {
    const out = pickAccessFields(allFieldsPresent())
    expect(Object.keys(out).sort()).toEqual([...ACCESS_FIELDS].sort())
  })

  test('drops unknown fields, including a genuine __proto__ own property', () => {
    // Built with JSON.parse, not an object literal: `__proto__:` in a literal
    // is a prototype setter, so the key never becomes an own property and this
    // test would pass without exercising anything. JSON.parse is also the
    // exact shape readAccessFile() feeds in.
    const hostile = JSON.parse('{"__proto__":{"polluted":1},"evilKey":"nope"}')
    // Guards the guard — if this ever goes false the test below is vacuous.
    expect(Object.hasOwn(hostile, '__proto__')).toBe(true)

    const input = Object.assign(hostile, allFieldsPresent()) as Partial<Access>
    const out = pickAccessFields(input) as unknown as Record<string, unknown>

    expect(out).not.toHaveProperty('evilKey')
    expect(Object.hasOwn(out, '__proto__')).toBe(false)
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
    expect(Object.keys(out).sort()).toEqual([...ACCESS_FIELDS].sort())
  })

  test('defaults the four required fields when given an empty object', () => {
    const out = pickAccessFields({})
    expect(out.dmPolicy).toBe('pairing')
    expect(out.allowFrom).toEqual([])
    expect(out.groups).toEqual({})
    expect(out.pending).toEqual({})
  })

  test('leaves optional fields absent rather than defaulting them', () => {
    const out = pickAccessFields({}) as unknown as Record<string, unknown>
    const required = ['dmPolicy', 'allowFrom', 'groups', 'pending']
    for (const field of ACCESS_FIELDS) {
      if (required.includes(field)) continue
      expect(out[field]).toBeUndefined()
    }
  })

  test('falls back to defaults when a required field is explicitly null', () => {
    const input = { dmPolicy: null, allowFrom: null, groups: null, pending: null }
    const out = pickAccessFields(input as unknown as Partial<Access>)
    expect(out.dmPolicy).toBe('pairing')
    expect(out.allowFrom).toEqual([])
    expect(out.groups).toEqual({})
    expect(out.pending).toEqual({})
  })

  test('does not share mutable defaults between calls', () => {
    const first = pickAccessFields({})
    first.allowFrom.push('111')
    expect(pickAccessFields({}).allowFrom).toEqual([])
  })

  test('preserves admins and invites, the fields whose loss is silent', () => {
    const input: Partial<Access> = {
      dmPolicy: 'pairing',
      allowFrom: ['6083473232'],
      admins: { telegram: ['6083473232'] },
      invites: {
        tok: {
          createdAt: 1,
          createdBy: 'telegram:6083473232',
          expiresAt: 2,
          usedBy: { telegram: ['111'] },
          revokedAt: null,
        },
      },
      botUsername: 'somebot',
    }
    const out = pickAccessFields(input)
    expect(out.admins).toEqual({ telegram: ['6083473232'] })
    expect(out.invites?.tok.usedBy).toEqual({ telegram: ['111'] })
    expect(out.botUsername).toBe('somebot')
  })
})
