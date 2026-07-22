/**
 * Inject-host resolution for the internal-inject channel server.
 *
 * Kept as its own module (rather than inlined in server.ts) for the same reason
 * as inject-port.ts: server.ts binds its host at module top-level, so it cannot
 * be imported from a test.
 */

/**
 * Resolve the bind host for the inject server from a raw env value, falling back
 * to a default when the value is absent or blank.
 *
 * No hostname/IP format validation is done on purpose: an invalid host surfaces
 * immediately when listen() rejects it, and reimplementing that check here would
 * be dead weight. An empty or whitespace-only value is treated as unset (a
 * set-but-empty env var is a defined value, so `??` alone cannot catch it) and
 * falls back to the default, keeping the loopback-only behaviour when the key is
 * present but blank.
 *
 * @param rawValue - Raw env value, or undefined when the key is unset.
 * @param defaultHost - Host to bind when rawValue is absent or blank.
 * @returns The bind host: the trimmed rawValue, or defaultHost.
 */
export function resolveInjectHost(rawValue: string | undefined, defaultHost: string): string {
  if (rawValue === undefined) return defaultHost

  const host = rawValue.trim()
  if (host === '') return defaultHost
  return host
}
