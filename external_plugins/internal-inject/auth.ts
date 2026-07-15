/**
 * Bearer-token authentication for the internal-inject channel server.
 *
 * The token table maps a token to the SERVICE that holds it, so the identity in
 * every delivered message (`user_id: "service:<name>"`) is derived from the
 * credential, never from a field the caller filled in themselves.
 *
 * Kept pure (no side effects, path passed in) so the whole auth contract is
 * unit-testable without booting the MCP server.
 */

import { createHash, timingSafeEqual } from 'node:crypto'
import { readFileSync } from 'node:fs'

/** Length of a hex-encoded sha256 digest. Anything else in the file is malformed. */
const SHA256_HEX_LENGTH = 64

/** One issued token: the service it identifies, and the sha256 of its secret. */
export type TokenEntry = {
  service: string
  token_sha256: string
  issued_at?: string
}

/**
 * Result of reading the token file.
 *
 * `problem` is a human-readable reason the file yielded no usable entries. It is
 * returned rather than logged so the caller decides when to be loud — the file is
 * re-read on every request, and a warning per request would drown the log.
 */
export type TokenLoad = {
  entries: TokenEntry[]
  problem?: string
}

/**
 * Read and validate the token table.
 *
 * A missing or broken file is NOT fatal: it yields zero entries, which makes every
 * request 401 while the HTTP port stays bound. Exiting instead would leave nothing
 * listening on the inject port, and the claude-tg-agent watchdog reads an unbound
 * port as a dead agent and restarts it — a missing token file would turn into a
 * restart loop.
 *
 * @param file - Path to tokens.json.
 * @returns The valid entries, plus a `problem` string when the file could not be
 *   used or contained no valid entry.
 */
export function loadTokens(file: string): TokenLoad {
  let raw: string
  try {
    raw = readFileSync(file, 'utf8')
  } catch {
    return { entries: [], problem: `token file not readable: ${file}` }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { entries: [], problem: `token file is not valid JSON: ${file}` }
  }

  const tokens = (parsed as { tokens?: unknown })?.tokens
  if (!Array.isArray(tokens)) {
    return { entries: [], problem: `token file has no "tokens" array: ${file}` }
  }

  const entries = tokens.filter(isValidEntry)
  if (entries.length === 0) {
    return { entries: [], problem: `token file has no valid entries: ${file}` }
  }
  return { entries }
}

/**
 * Resolve the service behind an Authorization header, or null when it is absent,
 * malformed, or carries a token no entry matches.
 *
 * The presented token is hashed and compared against the stored digests with
 * timingSafeEqual, so a wrong token cannot be discovered a byte at a time.
 *
 * @param authHeader - Raw `Authorization` header value, or undefined.
 * @param entries - Token table from loadTokens().
 * @returns The service name, or null when the caller is not authenticated.
 */
export function resolveService(authHeader: string | undefined, entries: TokenEntry[]): string | null {
  const token = parseBearer(authHeader)
  if (!token) return null

  const presented = createHash('sha256').update(token).digest()
  for (const entry of entries) {
    const stored = Buffer.from(entry.token_sha256, 'hex')
    if (stored.length !== presented.length) continue
    if (timingSafeEqual(stored, presented)) return entry.service
  }
  return null
}

/**
 * Extract the token from an `Authorization: Bearer <token>` header.
 *
 * Only the Bearer scheme is accepted — there is deliberately no second header to
 * carry the same credential, since a fallback path is one more thing that can
 * drift out of sync with the one that is tested. The scheme name is matched
 * case-insensitively (RFC 7235 says it is case-insensitive); the token is not.
 *
 * @param authHeader - Raw header value, or undefined when the header is absent.
 * @returns The token, or null when the header is missing or not a Bearer header.
 */
function parseBearer(authHeader: string | undefined): string | null {
  if (!authHeader) return null
  const match = authHeader.match(/^Bearer[ \t]+(\S+)$/i)
  return match ? match[1]! : null
}

/** Type guard for one entry of the token file: a service name plus a hex sha256. */
function isValidEntry(candidate: unknown): candidate is TokenEntry {
  const entry = candidate as TokenEntry
  return (
    typeof entry?.service === 'string' &&
    entry.service.length > 0 &&
    typeof entry?.token_sha256 === 'string' &&
    /^[0-9a-f]+$/i.test(entry.token_sha256) &&
    entry.token_sha256.length === SHA256_HEX_LENGTH
  )
}
