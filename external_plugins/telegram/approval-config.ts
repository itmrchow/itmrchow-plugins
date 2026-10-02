// Environment switches for the approval-request feature (JP-315).
//
// Split out of poller.ts for the same reason as the other small modules here:
// poller.ts exits at import time when half-configured, so it cannot be imported
// by a test.

/** The switch. Anything but an enabling value keeps the poller exactly as it was. */
export const APPROVAL_SWITCH_ENV = 'TELEGRAM_APPROVAL_BUTTONS'
export const APPROVAL_TIMEOUT_ENV = 'TELEGRAM_APPROVAL_TIMEOUT_SECONDS'
export const APPROVAL_COMMENT_TIMEOUT_ENV = 'TELEGRAM_APPROVAL_COMMENT_TIMEOUT_SECONDS'

/** Matches the 24h total wait the tg-approve gate script has always used. */
export const DEFAULT_APPROVAL_TIMEOUT_SECONDS = 86_400
/** How long a "reject" waits for the reviewer's written comment. */
export const DEFAULT_COMMENT_TIMEOUT_SECONDS = 300
/** Upper bound for either timeout; a request nobody answers in a week is dead. */
export const MAX_TIMEOUT_SECONDS = 604_800

const ENABLING_VALUES: ReadonlySet<string> = new Set(['1', 'true'])

export type ApprovalConfig = {
  enabled: boolean
  defaultTimeoutSeconds: number
  defaultCommentTimeoutSeconds: number
}

/**
 * Whether a raw timeout value is usable: a finite number of seconds, above
 * zero and no longer than MAX_TIMEOUT_SECONDS. Fractions are allowed so tests
 * can run a whole expiry in milliseconds.
 *
 * @param seconds - Candidate value.
 * @returns true when it can be used as a timeout.
 */
export function isValidTimeoutSeconds(seconds: unknown): seconds is number {
  return typeof seconds === 'number' && Number.isFinite(seconds) && seconds > 0 && seconds <= MAX_TIMEOUT_SECONDS
}

function resolveTimeoutSeconds(rawValue: string | undefined, defaultSeconds: number, envKey: string): number {
  if (rawValue === undefined || rawValue.trim() === '') return defaultSeconds
  const seconds = Number(rawValue)
  if (isValidTimeoutSeconds(seconds)) return seconds
  process.stderr.write(
    `telegram poller: ${envKey}=${JSON.stringify(rawValue)} is not a number of seconds in ` +
    `(0, ${MAX_TIMEOUT_SECONDS}]; falling back to ${defaultSeconds}\n`,
  )
  return defaultSeconds
}

/**
 * Read the approval-request settings from the environment.
 *
 * Fail-closed on the switch: only `1` / `true` (trimmed, case-insensitive)
 * enable the feature. Unset, empty, `0`, `false` and typos all leave it off, so
 * a host that never opted in — the VM agents sharing this plugin — keeps
 * today's behaviour whatever else is in its environment.
 *
 * @param env - Process environment.
 * @returns Whether the feature is on, and the timeouts to use when a request names none.
 */
export function resolveApprovalConfig(env: Record<string, string | undefined>): ApprovalConfig {
  const enabled = ENABLING_VALUES.has((env[APPROVAL_SWITCH_ENV] ?? '').trim().toLowerCase())
  if (!enabled) {
    return {
      enabled,
      defaultTimeoutSeconds: DEFAULT_APPROVAL_TIMEOUT_SECONDS,
      defaultCommentTimeoutSeconds: DEFAULT_COMMENT_TIMEOUT_SECONDS,
    }
  }
  return {
    enabled,
    defaultTimeoutSeconds: resolveTimeoutSeconds(
      env[APPROVAL_TIMEOUT_ENV], DEFAULT_APPROVAL_TIMEOUT_SECONDS, APPROVAL_TIMEOUT_ENV,
    ),
    defaultCommentTimeoutSeconds: resolveTimeoutSeconds(
      env[APPROVAL_COMMENT_TIMEOUT_ENV], DEFAULT_COMMENT_TIMEOUT_SECONDS, APPROVAL_COMMENT_TIMEOUT_ENV,
    ),
  }
}
