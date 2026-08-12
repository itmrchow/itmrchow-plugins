// Where the poller keeps its .env and pid file.
//
// Split out of discord-poller.ts for the same reason as the other small modules
// here: the poller exits at import time when half-configured, so it cannot be
// imported by a test.

/**
 * Resolve the poller's state directory from the environment.
 *
 * There is deliberately NO fallback to `$HOME/.claude/channels/discord`, even
 * though server.ts has one. A poller that defaults picks up the live bot token
 * from whatever environment it happened to inherit, and it is the sole gateway
 * holder — a stray run does not merely read the token, it steals the connection
 * from the real one. Fail-closed puts that burden on the process that forgot to
 * set it; the systemd unit sets it explicitly.
 *
 * @param env - Process environment.
 * @returns The configured directory, or undefined when unset or blank.
 */
export function resolveStateDir(env: Record<string, string | undefined>): string | undefined {
  const raw = env.DISCORD_STATE_DIR?.trim()
  return raw ? raw : undefined
}
