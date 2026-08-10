/**
 * Port resolution, shared by poller.ts (which binds the subscription port) and
 * server.ts (which connects to it).
 *
 * Both must resolve the SAME port from the SAME env key: every scope's server
 * is a client of the poller's subscription endpoint. Importing one function from
 * both is what keeps them from drifting — a duplicated literal in each file
 * would still "work" on the defaults and only break once someone overrides the
 * port, at which point inbound messages vanish silently.
 */

const MIN_PORT = 1
const MAX_PORT = 65535

/**
 * Resolve a listen port from a raw env value, falling back to a default
 * when the value is absent or unusable.
 *
 * Rejects anything that is not a whole number in the valid TCP port range, and
 * warns on stderr when it does. An unusable value must not reach listen(): a NaN
 * port binds an arbitrary free port instead of throwing, which silently strands
 * the endpoint on an address nobody knows.
 *
 * Uses Number() rather than parseInt(): parseInt('7842abc') returns 7842, quietly
 * accepting a typo, while Number() rejects it. Empty string is likewise rejected
 * (it coerces to 0, which is out of range) — note `??` alone cannot catch it,
 * since an empty env var is a defined value.
 *
 * @param rawValue - Raw env value, or undefined when the key is unset.
 * @param defaultPort - Port to use when rawValue is absent or invalid.
 * @param envKey - Env key name, used only in the warning message.
 * @returns A valid TCP port number.
 */
export function resolvePort(
  rawValue: string | undefined,
  defaultPort: number,
  envKey: string,
): number {
  if (rawValue === undefined) return defaultPort

  const port = Number(rawValue)
  if (!Number.isInteger(port) || port < MIN_PORT || port > MAX_PORT) {
    process.stderr.write(
      `telegram channel: ${envKey}=${JSON.stringify(rawValue)} is not a valid port ` +
      `(${MIN_PORT}-${MAX_PORT}); falling back to ${defaultPort}\n`,
    )
    return defaultPort
  }
  return port
}

/**
 * Resolve a positive whole-number setting (a count, not a port) from a raw env
 * value, falling back to a default when the value is absent or unusable.
 *
 * Shares resolvePort's tolerance and its Number()-over-parseInt() reasoning, but
 * reports itself as a count: a cap of 10 rejected with "is not a valid port"
 * sends whoever reads the log looking for a networking problem.
 *
 * @param rawValue - Raw env value, or undefined when the key is unset.
 * @param defaultValue - Value to use when rawValue is absent or invalid.
 * @param envKey - Env key name, used only in the warning message.
 * @returns A whole number of at least 1.
 */
export function resolveCount(
  rawValue: string | undefined,
  defaultValue: number,
  envKey: string,
): number {
  if (rawValue === undefined) return defaultValue

  const count = Number(rawValue)
  if (!Number.isInteger(count) || count < 1) {
    process.stderr.write(
      `telegram channel: ${envKey}=${JSON.stringify(rawValue)} is not a positive whole ` +
      `number; falling back to ${defaultValue}\n`,
    )
    return defaultValue
  }
  return count
}
