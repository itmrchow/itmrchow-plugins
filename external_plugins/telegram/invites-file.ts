// Persistence for invite tokens, which live in ONE file shared by every IM
// channel: ~/.claude/channels/invites.json (override: $INVITES_FILE).
//
// Not under channels/<platform>/ on purpose. A token is platform-agnostic by
// design — `usedBy` buckets redemptions per platform precisely so the same
// ticket works everywhere — and storing it inside one platform's state dir made
// the other platform unable to see it. Any platform subdirectory would also
// imply an owner, and this file has none.
//
// This module is the I/O half of invite.ts, which stays deliberately fs-free so
// its decision logic remains unit-testable. Same split as meta-text.ts /
// inject-port.ts: pure logic plus a matching .test.ts.
//
// Concurrency: three processes (telegram server, discord server, the im-invite
// skill) read-modify-write this file with no lock. That is a deliberate
// trade-off, not an oversight — minting and redeeming are human-paced actions
// and the write window is milliseconds, so a lost update needs two humans
// acting inside the same millisecond. Writes are at least atomic (tmp+rename),
// so a reader never sees a half-written file.
//
// This file is byte-identical across every channel plugin, and a cross-file
// test asserts that. Edit one, copy it to the other.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { Invite } from './invite'

/** Bumped only when the on-disk shape changes incompatibly. */
export const INVITES_FILE_VERSION = 1

/**
 * Every field preserved when an invite is read back.
 *
 * Same whitelist discipline as ACCESS_FIELDS in access-schema.ts: the token is
 * the object's key and is attacker-supplied, so a hand-edited or hostile file
 * must not be able to smuggle extra keys through a spread and back out to disk.
 */
const INVITE_FIELDS = [
  'note', 'createdAt', 'createdBy', 'expiresAt', 'usedBy', 'revokedAt',
] as const satisfies readonly (keyof Invite)[]

// Add a field to Invite without adding it here and this stops being assignable
// — the mistake becomes a compile error instead of silent data loss.
type MissingInviteField = Exclude<keyof Invite, (typeof INVITE_FIELDS)[number]>
const _inviteFieldsExhaustive: MissingInviteField extends never ? true : never = true
void _inviteFieldsExhaustive

/** The on-disk shape. `version` exists so a future schema change has something
 *  to branch on rather than having to guess from the payload. */
type InvitesFile = {
  version: number
  invites: Record<string, Invite>
}

/**
 * Locate the shared invites file.
 *
 * @param env Process environment; `INVITES_FILE` (absolute path) wins.
 * @param home The user's home directory.
 * @returns An absolute path to the invites file.
 */
export function resolveInvitesFile(
  env: Record<string, string | undefined>,
  home: string,
): string {
  return env.INVITES_FILE ?? join(home, '.claude', 'channels', 'invites.json')
}

/**
 * Rebuild the invites map from freshly parsed JSON, keeping only known fields.
 *
 * @param parsed Whatever JSON.parse produced; any shape is tolerated.
 * @returns A map safe to hand back to saveInvites().
 */
export function pickInvites(parsed: unknown): Record<string, Invite> {
  const raw = (parsed as { invites?: unknown } | null)?.invites
  if (typeof raw !== 'object' || raw === null) return {}
  // Null prototype while building: tokens are attacker-controlled keys, and
  // assigning '__proto__' on an ordinary object would set the prototype instead
  // of creating a property. Spreading at the end turns it back into a normal
  // object, where '__proto__' lands as an own property and stays inert.
  const out: Record<string, Invite> = Object.create(null) as Record<string, Invite>
  for (const token of Object.keys(raw)) {
    const entry = (raw as Record<string, unknown>)[token]
    if (typeof entry !== 'object' || entry === null) continue
    const picked: Record<string, unknown> = {}
    for (const field of INVITE_FIELDS) {
      if (Object.hasOwn(entry, field)) picked[field] = (entry as Record<string, unknown>)[field]
    }
    out[token] = picked as unknown as Invite
  }
  return { ...out }
}

/**
 * Read the shared invites file.
 *
 * A missing file is the normal cold-start case and yields an empty map. A
 * corrupt one is moved aside rather than deleted, matching readAccessFile():
 * losing tokens silently is worse than starting empty with the evidence kept.
 *
 * @param file Absolute path to the invites file.
 * @returns All known invites, keyed by token.
 */
export function readInvites(file: string): Record<string, Invite> {
  let raw: string
  try {
    raw = readFileSync(file, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {}
    process.stderr.write(`invites: cannot read ${file}: ${err}\n`)
    return {}
  }
  try {
    return pickInvites(JSON.parse(raw))
  } catch {
    try {
      renameSync(file, `${file}.corrupt-${Date.now()}`)
    } catch {}
    process.stderr.write('invites: invites.json is corrupt, moved aside. Starting fresh.\n')
    return {}
  }
}

/**
 * Write the shared invites file atomically.
 *
 * tmp+rename, 0600, parent dir 0700 — the file holds bearer tokens, and a
 * reader in another process must never observe a partial write.
 *
 * @param file Absolute path to the invites file.
 * @param invites All invites to persist, keyed by token.
 */
export function saveInvites(file: string, invites: Record<string, Invite>): void {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
  const payload: InvitesFile = { version: INVITES_FILE_VERSION, invites }
  const tmp = file + '.tmp'
  writeFileSync(tmp, JSON.stringify(payload, null, 2) + '\n', { mode: 0o600 })
  renameSync(tmp, file)
}

/**
 * Read invites straight out of a legacy access.json, bypassing its whitelist.
 *
 * Deliberately NOT readAccessFile(): ACCESS_FIELDS no longer lists `invites`,
 * so that path returns an empty map by construction and a migration built on it
 * would silently move nothing. This reads the raw parsed object instead.
 *
 * @param accessFile Absolute path to a platform's access.json.
 * @returns The invites it still carries, or null when the file is absent or
 *   unreadable (both mean "nothing to migrate").
 */
export function readLegacyAccessInvites(accessFile: string): Record<string, Invite> | null {
  try {
    return pickInvites(JSON.parse(readFileSync(accessFile, 'utf8')))
  } catch {
    return null
  }
}

/** Everything migrateInvitesFromAccess touches outside itself. */
export type MigrateDeps = {
  /** <PLATFORM>_ACCESS_MODE === 'static' */
  isStatic: boolean
  /** Raw legacy invites from this platform's access.json — see readLegacyAccessInvites. */
  readLegacy: () => Record<string, Invite> | null
  readShared: () => Record<string, Invite>
  saveShared: (invites: Record<string, Invite>) => void
  /** Rewrite access.json through the field whitelist, which now drops `invites`. */
  stripLegacy: () => void
  warn: (message: string) => void
}

/**
 * Move invites out of a legacy access.json into the shared file, at boot.
 *
 * Idempotent and merge-shaped, because both channel servers run this against
 * their own access.json and either may start first: tokens the shared file
 * lacks are added, tokens it already has win. Tokens are 32 hex random chars,
 * so a genuine key collision does not happen in practice; the rule exists so
 * the outcome does not depend on boot order.
 *
 * Must run before any saveAccess(): `invites` is no longer in ACCESS_FIELDS, so
 * the first write of access.json would drop it permanently and without a trace.
 * Never throws — invites are an auxiliary feature and must not stop a channel
 * from booting.
 *
 * @param deps The injected I/O surface.
 * @returns Whether any token was moved into the shared file.
 */
export function migrateInvitesFromAccess(deps: MigrateDeps): boolean {
  try {
    const legacy = deps.readLegacy()
    if (legacy === null || Object.keys(legacy).length === 0) return false
    if (deps.isStatic) {
      // Static mode never writes state, so there is no safe way to move these
      // and no point rewriting access.json either. Say so and leave it alone.
      deps.warn('invites: static mode — legacy access.json invites left in place, not migrated\n')
      return false
    }
    const shared = deps.readShared()
    let moved = false
    for (const [token, invite] of Object.entries(legacy)) {
      if (Object.hasOwn(shared, token)) continue
      shared[token] = invite
      moved = true
    }
    // Save the shared copy before stripping the source: the reverse order loses
    // every token if the second write fails.
    if (moved) deps.saveShared(shared)
    deps.stripLegacy()
    return moved
  } catch (err) {
    deps.warn(`invites: migration from access.json failed, leaving it in place: ${err}\n`)
    return false
  }
}
