/**
 * Inject-port resolution for the internal-inject channel server.
 *
 * Kept as its own module (rather than inlined in server.ts) so the resolution
 * rules are unit-testable: server.ts binds its port at module top-level, so it
 * cannot be imported from a test.
 *
 * A copy of the telegram/discord module rather than a shared import: each plugin
 * is installed on its own from the marketplace, so a cross-plugin relative import
 * breaks the moment the plugin is installed by itself.
 */

const MIN_PORT = 1
const MAX_PORT = 65535

/**
 * Resolve an inject-server port from a raw env value, falling back to a default
 * when the value is absent or unusable.
 *
 * Rejects anything that is not a whole number in the valid TCP port range, and
 * warns on stderr when it does. An unusable value must not reach listen(): a NaN
 * port binds an arbitrary free port instead of throwing, which silently strands
 * the inject endpoint on an address nobody knows — and the watchdog probes the
 * port it expects, so it would restart the agent every cycle.
 *
 * Uses Number() rather than parseInt(): parseInt('7844abc') returns 7844, quietly
 * accepting a typo, while Number() rejects it. Empty string is likewise rejected
 * (it coerces to 0, which is out of range) — note `??` alone cannot catch it,
 * since an empty env var is a defined value.
 *
 * @param rawValue - Raw env value, or undefined when the key is unset.
 * @param defaultPort - Port to use when rawValue is absent or invalid.
 * @param envKey - Env key name, used only in the warning message.
 * @returns A valid TCP port number.
 */
export function resolveInjectPort(
  rawValue: string | undefined,
  defaultPort: number,
  envKey: string,
): number {
  if (rawValue === undefined) return defaultPort

  const port = Number(rawValue)
  if (!Number.isInteger(port) || port < MIN_PORT || port > MAX_PORT) {
    process.stderr.write(
      `internal-inject channel: ${envKey}=${JSON.stringify(rawValue)} is not a valid port ` +
      `(${MIN_PORT}-${MAX_PORT}); falling back to ${defaultPort}\n`,
    )
    return defaultPort
  }
  return port
}
