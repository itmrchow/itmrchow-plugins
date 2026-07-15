/**
 * Poll-mode resolution, shared in spirit by server.ts (which acts on the mode)
 * and launch.sh (which mirrors the platform default to pick a runtime).
 *
 * Two poll strategies exist because of an aarch64-linux-only bug: the MCP
 * StdioServerTransport stdin watcher inside server.ts starves an in-process
 * grammy long-poll once Claude drives the MCP connection (even setTimeout timers
 * stall), so inbound updates are never consumed. To work around it, aarch64-linux
 * uses "decoupled" mode — a standalone poller.ts feeds updates over HTTP. Every
 * other platform has no such bug and uses "builtin" mode — a single-process
 * bot.start(), like upstream, with no external poller dependency.
 *
 * Picking decoupled where it isn't needed is not free: it silently fails unless
 * an external poller process is actually deployed. So the default is builtin
 * everywhere EXCEPT the one platform with the proven bug.
 */

export type PollMode = 'builtin' | 'decoupled'

const MODE_BUILTIN: PollMode = 'builtin'
const MODE_DECOUPLED: PollMode = 'decoupled'

const STARVING_ARCH = 'arm64'
const STARVING_PLATFORM = 'linux'

/**
 * The platform whose in-process poll loop is starved by the MCP stdin watcher.
 * Only arm64-linux (a1-b) has the proven bug; darwin/x64 do not.
 */
function isStarvingPlatform(arch: string, platform: string): boolean {
  return arch === STARVING_ARCH && platform === STARVING_PLATFORM
}

/** Platform default when TELEGRAM_POLL_MODE is unset: decoupled only on the starving platform. */
function defaultMode(arch: string, platform: string): PollMode {
  return isStarvingPlatform(arch, platform) ? MODE_DECOUPLED : MODE_BUILTIN
}

/**
 * Resolve the polling mode from arch, platform, and a raw env override.
 *
 * Default (rawEnv unset/blank): decoupled iff arch is arm64 AND platform is linux,
 * else builtin. An explicit rawEnv of 'builtin' or 'decoupled' (case-insensitive,
 * whitespace-trimmed) overrides the default, with one clamp: 'builtin' on
 * arm64-linux is forced back to decoupled and warned, because in-process polling
 * is proven not to work there — honouring it would silently strand inbound updates.
 * An unrecognised non-blank value falls back to the platform default and warns,
 * mirroring resolveInjectPort's tolerant style.
 *
 * @param arch - process.arch of the running process (e.g. 'arm64', 'x64').
 * @param platform - process.platform of the running process (e.g. 'linux', 'darwin').
 * @param rawEnv - Raw TELEGRAM_POLL_MODE value, or undefined when the key is unset.
 * @returns The resolved poll mode, 'builtin' or 'decoupled'.
 */
export function resolvePollMode(
  arch: string,
  platform: string,
  rawEnv: string | undefined,
): PollMode {
  const fallback = defaultMode(arch, platform)
  if (rawEnv === undefined) return fallback

  // A blank/whitespace-only env var reads as "unset" for a mode toggle — fall
  // back silently rather than warning, since an empty export is not a typo.
  const normalized = rawEnv.trim().toLowerCase()
  if (normalized === '') return fallback

  if (normalized !== MODE_BUILTIN && normalized !== MODE_DECOUPLED) {
    process.stderr.write(
      `telegram channel: TELEGRAM_POLL_MODE=${JSON.stringify(rawEnv)} is not a valid ` +
      `mode ('builtin' | 'decoupled'); falling back to ${fallback}\n`,
    )
    return fallback
  }

  if (normalized === MODE_BUILTIN && isStarvingPlatform(arch, platform)) {
    process.stderr.write(
      `telegram channel: TELEGRAM_POLL_MODE=builtin is not supported on ${arch}-${platform} ` +
      `(in-process poll starves under the MCP stdin watcher); forcing decoupled\n`,
    )
    return MODE_DECOUPLED
  }

  return normalized
}
