// Where the poller's Bot API client points (TELEGRAM_API_ROOT).
//
// Split out of poller.ts for the same reason as the other small modules here:
// poller.ts exits at import time when half-configured, so it cannot be imported
// by a test.

export const API_ROOT_ENV = 'TELEGRAM_API_ROOT'

/** The only hosts an override may name: this machine, and nothing else. */
const LOOPBACK_HOSTNAMES: ReadonlySet<string> = new Set(['127.0.0.1', 'localhost', '[::1]'])
const ALLOWED_PROTOCOLS: ReadonlySet<string> = new Set(['http:', 'https:'])
const TRAILING_SLASHES_RE = /\/+$/

export type ApiRootResolution =
  /** Unset or blank: use Telegram's own servers, say nothing. */
  | { kind: 'default' }
  /** A loopback address: use it. */
  | { kind: 'override'; apiRoot: string }
  /** Anything else: use Telegram's own servers, and report why. */
  | { kind: 'ignored'; reason: string }

/**
 * Decide whether a TELEGRAM_API_ROOT value may redirect the Bot API client.
 *
 * Every Bot API request carries the bot token in its URL, so whatever this
 * returns as an override receives the token. The variable exists to point tests
 * at a local fake; restricting it to loopback hosts means it can never send the
 * token off the machine, whatever ends up in a host's environment or .env.
 *
 * `[::1]` is accepted alongside `127.0.0.1` and `localhost`: it is the same
 * guarantee on an IPv6-only loopback. A URL with embedded credentials is
 * refused — no local fake needs them, and it keeps secrets out of this value.
 *
 * Trailing slashes are dropped from an accepted value, because the Bot API
 * client rejects them outright.
 *
 * The reason never echoes the raw value, which could itself hold a secret.
 *
 * @param rawValue - Raw env value, or undefined when the key is unset.
 * @returns What the client should use, and why when the value was not usable.
 */
export function resolveApiRoot(rawValue: string | undefined): ApiRootResolution {
  const trimmed = rawValue?.trim()
  if (!trimmed) return { kind: 'default' }

  let url: URL
  try {
    url = new URL(trimmed)
  } catch {
    return { kind: 'ignored', reason: 'not a valid URL' }
  }
  if (!ALLOWED_PROTOCOLS.has(url.protocol)) return { kind: 'ignored', reason: 'not an http(s) URL' }
  if (url.username !== '' || url.password !== '') return { kind: 'ignored', reason: 'URL carries credentials' }
  if (!LOOPBACK_HOSTNAMES.has(url.hostname)) {
    return { kind: 'ignored', reason: 'host is not loopback (only 127.0.0.1, localhost and [::1] are accepted)' }
  }
  // grammY refuses an apiRoot ending in '/' by throwing from `new Bot`, which
  // would take the poller down at startup over a cosmetic difference.
  return { kind: 'override', apiRoot: trimmed.replace(TRAILING_SLASHES_RE, '') }
}
