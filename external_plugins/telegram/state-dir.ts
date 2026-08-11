// Where the poller keeps its .env, pid file and access state.
//
// Split out of poller.ts for the same reason as the other small modules here:
// poller.ts exits at import time when half-configured, so it cannot be imported
// by a test.

/**
 * Resolve the poller's state directory from the environment.
 *
 * There is deliberately NO fallback to `$HOME/.claude/channels/telegram`. A
 * poller that defaults picks up the live bot token from whatever environment it
 * happened to inherit — which is exactly how a smoke test once long-polled
 * against the production bot for ~20 seconds. Fail-closed puts that burden on
 * the process that forgot to set it, not on the deployment being lucky; the
 * systemd unit sets it explicitly.
 *
 * @param env - Process environment.
 * @returns The configured directory, or undefined when unset or blank.
 */
export function resolveStateDir(env: Record<string, string | undefined>): string | undefined {
  const raw = env.TELEGRAM_STATE_DIR?.trim()
  return raw ? raw : undefined
}
