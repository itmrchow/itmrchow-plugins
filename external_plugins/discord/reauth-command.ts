/**
 * `/reauth` and `/authcode` interception, shared byte-for-byte by the telegram
 * and discord pollers (see discord/shared-parity.test.ts).
 *
 * The poller only parses and relays. Who is an admin, whether a flow exists and
 * every timer live in the im-core executor (scripts/reauth.sh), which answers
 * with an exit code. The values below mirror im-core
 * scripts/lib/reauth-contract.sh; tests/parity.test.sh compares them.
 *
 * Silence is deliberate for every verdict that does not prove the sender is an
 * admin: answering a stranger tells them the command exists.
 */
import { spawn } from 'node:child_process'

export const REAUTH_EXIT_OK = 0
export const REAUTH_EXIT_USAGE = 2
export const REAUTH_EXIT_NOT_CONFIGURED = 3
export const REAUTH_EXIT_UNAUTHORIZABLE = 4
export const REAUTH_EXIT_NOT_ADMIN = 10
export const REAUTH_EXIT_NOT_DM = 11
export const REAUTH_EXIT_BUSY = 12
export const REAUTH_EXIT_NO_PENDING = 13
export const REAUTH_EXIT_INVALID_CODE = 14

/** Upper bound for one executor call; `start` backgrounds its driver and returns in well under this. */
export const REAUTH_BIN_TIMEOUT_MS = 15_000

const REAUTH_RE = /^\/reauth(?:@(\w+))?$/
const AUTHCODE_RE = /^\/authcode(?:@(\w+))?(?:\s+([\s\S]*))?$/

const NOT_DM_REPLY = '這個指令只能在私訊使用'
const NOT_CONFIGURED_REPLY = '重新驗證功能未完整設定，請到 VM 查看 poller 的 journal。'

const START_REPLIES: ReadonlyMap<number, string> = new Map([
  [REAUTH_EXIT_OK, '已開始重新驗證，授權連結稍後私訊給你。'],
  [REAUTH_EXIT_NOT_DM, NOT_DM_REPLY],
  [REAUTH_EXIT_NOT_CONFIGURED, NOT_CONFIGURED_REPLY],
  [REAUTH_EXIT_BUSY, '已有進行中的重新驗證流程，請等它結束後再試。'],
])

const CODE_REPLIES: ReadonlyMap<number, string> = new Map([
  [REAUTH_EXIT_OK, '已收到驗證碼，處理中，完成或失敗都會再通知你。'],
  [REAUTH_EXIT_NOT_DM, NOT_DM_REPLY],
  [REAUTH_EXIT_NOT_CONFIGURED, NOT_CONFIGURED_REPLY],
  [REAUTH_EXIT_BUSY, '驗證碼已收過，流程處理中，請等候結果通知。'],
  [REAUTH_EXIT_NO_PENDING, '目前沒有等待驗證碼的流程（可能已逾時），需要時請重新 /reauth。'],
  [REAUTH_EXIT_INVALID_CODE, '驗證碼格式不正確，請貼上授權頁顯示的完整驗證碼：/authcode <驗證碼>'],
])

export type ReauthCommand = { kind: 'reauth' } | { kind: 'authcode'; code: string }

export type ReauthSource = {
  platform: 'telegram' | 'discord'
  senderId: string
  chatId: string
  chatType: 'dm' | 'group'
  /** Telegram only: a `/cmd@name` addressed to another bot is not ours. */
  botUsername?: string
}

export type ReauthDeps = {
  /** REAUTH_BIN; undefined turns interception off entirely. */
  bin: string | undefined
  run: (bin: string, args: readonly string[], stdin?: string) => Promise<number | null>
  reply: (text: string) => Promise<void>
  log: (line: string) => void
  /** Removes the user's /authcode message where the platform allows it. */
  discardCommandMessage?: () => Promise<void>
}

function isAddressedToUs(mention: string | undefined, botUsername: string | undefined): boolean {
  if (mention === undefined) return true
  return botUsername !== undefined && mention.toLowerCase() === botUsername.toLowerCase()
}

/**
 * Recognise the two commands.
 *
 * @param text - Raw message text.
 * @param botUsername - This bot's username, to reject `/cmd@otherbot`.
 * @returns The command, or null when the text is anything else.
 */
export function parseReauthCommand(text: string, botUsername?: string): ReauthCommand | null {
  const trimmed = text.trim()
  const reauth = REAUTH_RE.exec(trimmed)
  if (reauth) return isAddressedToUs(reauth[1], botUsername) ? { kind: 'reauth' } : null
  const authcode = AUTHCODE_RE.exec(trimmed)
  if (authcode) {
    return isAddressedToUs(authcode[1], botUsername) ? { kind: 'authcode', code: (authcode[2] ?? '').trim() } : null
  }
  return null
}

/**
 * Map an executor verdict to the one line sent back, or null for silence.
 *
 * @param kind - Which command was run.
 * @param exit - Executor exit code; null when it could not be run or timed out.
 * @returns Reply text, or null.
 */
export function replyForExit(kind: ReauthCommand['kind'], exit: number | null): string | null {
  if (exit === null) return null
  return (kind === 'reauth' ? START_REPLIES : CODE_REPLIES).get(exit) ?? null
}

/**
 * Handle `/reauth` / `/authcode` before routing. Never throws.
 *
 * @param text - Message text.
 * @param source - Who sent it and where.
 * @param deps - Executor runner and platform glue.
 * @returns true when the message was a reauth command (the caller must NOT route it).
 */
export async function interceptReauth(text: string, source: ReauthSource, deps: ReauthDeps): Promise<boolean> {
  if (!deps.bin) return false
  const command = parseReauthCommand(text, source.botUsername)
  if (!command) return false
  try {
    const args = [
      command.kind === 'reauth' ? 'start' : 'code',
      '--platform', source.platform,
      '--sender', source.senderId,
      '--chat', source.chatId,
      '--chat-type', source.chatType,
    ]
    const stdin = command.kind === 'authcode' ? `${command.code}\n` : undefined
    const exit = await deps.run(deps.bin, args, stdin)
    deps.log(`reauth_intercepted command=${command.kind} exit=${exit ?? 'none'}`)
    const reply = replyForExit(command.kind, exit)
    if (reply === null) return true
    if (command.kind === 'authcode' && deps.discardCommandMessage) await deps.discardCommandMessage()
    await deps.reply(reply)
  } catch (err) {
    // Only the error name: nothing in this path is handed the code, but a message is
    // free text from a library and is not worth the risk of echoing input.
    deps.log(`reauth_intercept_failed command=${command.kind}: ${err instanceof Error ? err.name : 'unknown'}`)
  }
  return true
}

/**
 * Run the executor. The code, when any, goes through stdin so it never shows up in argv.
 *
 * @param bin - Executor path.
 * @param args - Arguments (identity only).
 * @param stdin - Optional stdin payload.
 * @returns Exit code, or null on spawn failure / timeout.
 */
export function runReauthBin(bin: string, args: readonly string[], stdin?: string): Promise<number | null> {
  return new Promise(resolve => {
    let settled = false
    const finish = (value: number | null): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(value)
    }
    const child = spawn(bin, [...args], { stdio: [stdin === undefined ? 'ignore' : 'pipe', 'ignore', 'inherit'] })
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      finish(null)
    }, REAUTH_BIN_TIMEOUT_MS)
    child.on('error', () => finish(null))
    child.on('close', code => finish(code))
    // The executor stops reading after its length cap; an unhandled EPIPE here would
    // be an 'error' event with no listener, which takes the whole poller down.
    child.stdin?.on('error', () => {})
    if (stdin !== undefined) child.stdin?.end(stdin)
  })
}
