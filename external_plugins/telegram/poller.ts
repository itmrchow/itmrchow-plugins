/**
 * Standalone Telegram poller — the platform's sole gateway holder and the hub
 * every scope subscribes to.
 *
 * Why a separate process: on bun/node (aarch64) the MCP StdioServerTransport
 * stdin watcher inside server.ts starves an in-process grammy poll loop once
 * Claude drives the MCP connection — the loop silently never fires (even
 * setTimeout timers stall), so inbound updates are never consumed. This process
 * has an idle stdin and is unaffected.
 *
 * It is the SOLE getUpdates consumer for the token, so there is no 409 conflict
 * with anything else. Each update is routed to a scope (one Claude session per
 * DM partner / per group) and written to that scope's SSE subscription, spawning
 * the scope through the carrier's scope-spawn script when it does not exist yet.
 *
 * Access policy is NOT applied here: dmPolicy / allowFrom / requireMention /
 * pairing stay in server.ts's gate(), so there is exactly one verdict per
 * message.
 */
import { Bot } from 'grammy'
import { readFileSync, writeFileSync, mkdirSync, chmodSync } from 'fs'
import { join } from 'path'
import { spawn as spawnProcess } from 'node:child_process'
import { resolveCount, resolvePort } from './resolve-port'
import { resolveStateDir } from './state-dir'
import { buildBotCommands } from './bot-commands'
import { resolveControlCommands } from './control-plane'
import { ScopeRegistry } from './poller-registry'
import { createSubscribeServer } from './subscribe-server'
import {
  createUpdateConsumer,
  routeUpdate,
  type RouteContext,
  type SpawnOutcome,
} from './route-update'
import { interceptReauth, runReauthBin, shouldDropEditedReauth } from './reauth-command'
import { API_ROOT_ENV, resolveApiRoot } from './api-root'
import { resolveApprovalConfig } from './approval-config'
import { ApprovalStore } from './approval-store'
import { createApprovalService, type ApprovalService } from './approval-service'
import { createApprovalHandler, mountApprovalRoutes } from './approval-http'
import { pickAccessFields, type Access } from './access-schema'
import type { Update } from 'grammy/types'
import { setDefaultResultOrder } from 'node:dns'
import { setDefaultAutoSelectFamily } from 'node:net'

// Same IPv6-blackhole timeout server.ts guards against (JP-191). The carrier's
// systemd unit already passes --dns-result-order=ipv4first, but that drop-in is
// per-host config in another repo — setting it here means the plugin carries its
// own fix to any host. Both paths set the same value; they do not conflict.
setDefaultResultOrder('ipv4first')

// And the other half of the same fix (JP-193): ipv4first only orders DNS
// results, while Node 20+ still races both families in net.connect() via Happy
// Eyeballs. Without this the dead AAAA attempt times the request out anyway.
setDefaultAutoSelectFamily(false)

const DEFAULT_POLLER_PORT = 7852
const DEFAULT_MAX_SCOPES = 10
/** Messages held per scope while it boots. A Claude start is ~30s; more than a
 *  handful of queued messages means the sender has moved on anyway. */
const MAX_QUEUE_PER_SCOPE = 20
const POLL_TIMEOUT_SECONDS = 25
const CONFLICT_RETRY_MS = 3000
const POLL_RETRY_MS = 1000
const LOOPBACK = '127.0.0.1'

/** Exit codes of scope-spawn.sh; see the spawn contract in the JP-177 plan. */
const SPAWN_EXIT_OK = 0
const SPAWN_EXIT_CAP_REACHED = 2
const SPAWN_EXIT_INVALID_SCOPE = 3

// Fail-closed, no default path: see resolveStateDir for why.
const STATE_DIR = resolveStateDir(process.env)
if (!STATE_DIR) {
  process.stderr.write(
    'telegram poller: TELEGRAM_STATE_DIR required (no default, so a stray run cannot read the live token)\n',
  )
  process.exit(1)
}

const ENV_FILE = join(STATE_DIR, '.env')
const PID_FILE = join(STATE_DIR, 'poller.pid')
const ACCESS_FILE = join(STATE_DIR, 'access.json')
const APPROVALS_FILE = join(STATE_DIR, 'approvals.json')

// Load STATE_DIR/.env (real env wins) — same convention as server.ts.
try {
  chmodSync(ENV_FILE, 0o600)
  for (const line of readFileSync(ENV_FILE, 'utf8').split('\n')) {
    const m = line.match(/^(\w+)=(.*)$/)
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2]
  }
} catch {}

// Read AFTER the .env load above, and resolve to the same port every scope's
// server.ts connects to. Reading it earlier would ignore a port set in the
// state .env while server.ts (which reads it after its own load) honours it,
// moving the hub but not its subscribers.
const POLLER_PORT = resolvePort(
  process.env.TELEGRAM_POLLER_PORT,
  DEFAULT_POLLER_PORT,
  'TELEGRAM_POLLER_PORT',
)

const MAX_SCOPES = resolveCount(process.env.MAX_SCOPES, DEFAULT_MAX_SCOPES, 'MAX_SCOPES')

// Same reason as the port above: read after the .env load so the menu this
// process advertises matches the one server.ts actually handles.
const CONTROL_COMMANDS_ENABLED = resolveControlCommands(
  process.env.TELEGRAM_CONTROL_COMMANDS,
  'TELEGRAM_CONTROL_COMMANDS',
)

const SCOPE_SPAWN_BIN = process.env.SCOPE_SPAWN_BIN

// The im-core reauth executor. Unset = /reauth and /authcode are NOT intercepted
// and route like any other message (hosts that have not opted in keep today's behaviour).
const REAUTH_BIN = process.env.REAUTH_BIN

// Approval requests over inline buttons (JP-315). Off unless explicitly enabled:
// with the switch unset nothing below is built, no route is mounted, no update
// is intercepted and no state file is written.
const APPROVAL_CONFIG = resolveApprovalConfig(process.env)

// Test hook: point the Bot API client at a local fake. Loopback hosts only, so
// the bot token cannot leave this machine through it; see resolveApiRoot.
const API_ROOT_RESOLUTION = resolveApiRoot(process.env[API_ROOT_ENV])
if (API_ROOT_RESOLUTION.kind === 'ignored') {
  process.stderr.write(
    `telegram poller: ${API_ROOT_ENV} ignored (${API_ROOT_RESOLUTION.reason}); using Telegram's Bot API servers\n`,
  )
}
const API_ROOT = API_ROOT_RESOLUTION.kind === 'override' ? API_ROOT_RESOLUTION.apiRoot : undefined
if (API_ROOT) {
  // Loud on purpose: only this process is redirected — server.ts keeps talking
  // to Telegram.
  process.stderr.write(
    `telegram poller: WARNING TELEGRAM_API_ROOT is set, Bot API calls go to ${API_ROOT} instead of Telegram (test hook)\n`,
  )
}

const TOKEN = process.env.TELEGRAM_BOT_TOKEN
if (!TOKEN) {
  process.stderr.write(`telegram poller: TELEGRAM_BOT_TOKEN required (set in ${ENV_FILE})\n`)
  process.exit(1)
}

// Replace any stale poller so a restart takes over the single getUpdates slot.
mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 })
try {
  const stale = parseInt(readFileSync(PID_FILE, 'utf8'), 10)
  if (stale > 1 && stale !== process.pid) {
    process.kill(stale, 0)
    process.stderr.write(`telegram poller: replacing stale poller pid=${stale}\n`)
    process.kill(stale, 'SIGTERM')
  }
} catch {}
writeFileSync(PID_FILE, String(process.pid))

let shuttingDown = false
const shutdown = (): void => {
  shuttingDown = true
  process.exit(0)
}
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)

const bot = API_ROOT ? new Bot(TOKEN, { client: { apiRoot: API_ROOT } }) : new Bot(TOKEN)
const registry = new ScopeRegistry({ maxScopes: MAX_SCOPES, maxQueue: MAX_QUEUE_PER_SCOPE })
const hub = createSubscribeServer({
  registry,
  onSubscribe: scopeId => process.stderr.write(`telegram poller: ${scopeId} subscribed\n`),
  onDisconnect: scopeId => process.stderr.write(`telegram poller: ${scopeId} disconnected\n`),
})

/**
 * Ask the carrier to bring a scope up.
 *
 * A missing SCOPE_SPAWN_BIN warns and refuses rather than crashing: the poller
 * must keep its port bound even when half-configured, because the watchdog
 * treats an unbound port as a dead agent and restarts it forever.
 */
function spawnScope(scopeId: string): Promise<SpawnOutcome> {
  if (!SCOPE_SPAWN_BIN) {
    process.stderr.write(
      `telegram poller: SCOPE_SPAWN_BIN unset, cannot start ${scopeId}\n`,
    )
    return Promise.resolve('not_configured')
  }
  return new Promise(resolve => {
    // Arg array, never a shell string: scopeId is regex-validated upstream, and
    // keeping it out of a shell means that validation is not the only barrier.
    const child = spawnProcess(SCOPE_SPAWN_BIN, [scopeId], {
      stdio: ['ignore', 'ignore', 'inherit'],
    })
    child.on('error', err => {
      process.stderr.write(`telegram poller: scope-spawn exec failed for ${scopeId}: ${err}\n`)
      resolve('failed')
    })
    child.on('close', code => {
      if (code === SPAWN_EXIT_OK) return resolve('ok')
      if (code === SPAWN_EXIT_CAP_REACHED) return resolve('cap_reached')
      if (code === SPAWN_EXIT_INVALID_SCOPE) return resolve('invalid_scope')
      resolve('failed')
    })
  })
}

/**
 * Who may answer an approval request: access.json's allowFrom, read fresh each
 * time so a pairing made after startup counts. Read-only here — server.ts owns
 * the file — and an unreadable file means nobody, never everybody.
 *
 * Only allowFrom is consulted, the same as server.ts's `perm:` button handler:
 * dmPolicy and static mode are not applied. So with dmPolicy "disabled" an
 * allowlisted user can still press a button, and under static mode an edit to
 * access.json takes effect here before server.ts restarts. Both only ever
 * narrow or widen within the list the owner maintains.
 */
function loadAllowFrom(): string[] {
  try {
    const parsed = JSON.parse(readFileSync(ACCESS_FILE, 'utf8')) as Partial<Access>
    const { allowFrom } = pickAccessFields(parsed)
    return Array.isArray(allowFrom) ? allowFrom.filter(id => typeof id === 'string') : []
  } catch {
    return []
  }
}

function createApprovals(): ApprovalService {
  return createApprovalService({
    store: new ApprovalStore({ filePath: APPROVALS_FILE }),
    loadAllowFrom,
    api: {
      sendRequest: async (chatId, text, buttons) => {
        const sent = await bot.api.sendMessage(chatId, text, {
          reply_markup: {
            inline_keyboard: [buttons.map(button => ({ text: button.text, callback_data: button.callbackData }))],
          },
        })
        return sent.message_id
      },
      sendPrompt: async (chatId, text, replyToMessageId) => {
        const sent = await bot.api.sendMessage(chatId, text, {
          reply_parameters: { message_id: replyToMessageId, allow_sending_without_reply: true },
          reply_markup: { force_reply: true },
        })
        return sent.message_id
      },
      editText: async (chatId, messageId, text) => {
        await bot.api.editMessageText(chatId, messageId, text)
      },
      answerCallback: async (callbackQueryId, text) => {
        await bot.api.answerCallbackQuery(callbackQueryId, text === undefined ? undefined : { text })
      },
      sendText: async (chatId, text) => {
        await bot.api.sendMessage(chatId, text)
      },
    },
  })
}

const approvals: ApprovalService | undefined = APPROVAL_CONFIG.enabled ? createApprovals() : undefined
if (approvals) {
  mountApprovalRoutes(
    hub.server,
    createApprovalHandler(approvals, {
      timeoutSeconds: APPROVAL_CONFIG.defaultTimeoutSeconds,
      commentTimeoutSeconds: APPROVAL_CONFIG.defaultCommentTimeoutSeconds,
    }),
  )
  approvals.start()
  process.stderr.write('telegram poller: approval requests enabled\n')
}

async function main(): Promise<void> {
  // Bind before init(): a token or network problem must not leave the port
  // unbound, or the watchdog reads it as a dead agent and restarts in a loop.
  hub.server.listen(POLLER_PORT, LOOPBACK, () => {
    process.stderr.write(`telegram poller: subscriptions on ${LOOPBACK}:${POLLER_PORT}\n`)
  })

  await bot.init()
  const me = bot.botInfo
  process.stderr.write(`telegram poller: polling as @${me.username}\n`)
  void bot.api
    .setMyCommands(buildBotCommands(CONTROL_COMMANDS_ENABLED), {
      scope: { type: 'all_private_chats' },
    })
    .catch(() => {})

  const ctx: RouteContext = {
    registry,
    deliver: hub.deliver,
    spawn: spawnScope,
    notify: async (chatId, text) => {
      await bot.api.sendMessage(chatId, text).catch(err => {
        process.stderr.write(`telegram poller: notify ${chatId} failed: ${err}\n`)
      })
    },
    botInfo: me,
  }

  // Built once, outside the loop: it owns the per-update failure counter, which
  // has to survive across batches for the poison-pill threshold to be reachable
  // at all (a poison update returns in a NEW batch every time).
  // Reauth commands are handled here, before routing, because this process is the
  // only getUpdates consumer and it outlives the agent it re-authenticates.
  const interceptTelegramReauth = (update: Update): Promise<boolean> => {
    const edited = update.edited_message
    if (edited && shouldDropEditedReauth(edited.text, REAUTH_BIN, me.username)) {
      process.stderr.write(`telegram poller: reauth_edit_dropped update_id=${update.update_id}\n`)
      return Promise.resolve(true)
    }
    const message = update.message
    if (!message?.text || !message.from) return Promise.resolve(false)
    return interceptReauth(
      message.text,
      {
        platform: 'telegram',
        senderId: String(message.from.id),
        chatId: String(message.chat.id),
        chatType: message.chat.type === 'private' ? 'dm' : 'group',
        botUsername: me.username,
      },
      {
        bin: REAUTH_BIN,
        run: runReauthBin,
        reply: async text => {
          await bot.api.sendMessage(message.chat.id, text).catch(err => {
            process.stderr.write(`telegram poller: reauth reply failed update_id=${update.update_id}: ${err}\n`)
          })
        },
        discardCommandMessage: async () => {
          await bot.api.deleteMessage(message.chat.id, message.message_id).catch(() => {
            process.stderr.write(`telegram poller: reauth could not delete command message update_id=${update.update_id}\n`)
          })
        },
        log: line => process.stderr.write(`telegram poller: ${line} update_id=${update.update_id}\n`),
      },
    )
  }

  const consume = createUpdateConsumer({
    route: async update => {
      if (await interceptTelegramReauth(update)) return
      // Button presses and reject comments are decided here and never reach a
      // session: the decision must stay in this process.
      if (approvals && (await approvals.interceptUpdate(update))) return
      await routeUpdate(update, ctx)
    },
  })

  let offset: number | undefined
  while (!shuttingDown) {
    try {
      const updates = await bot.api.getUpdates({ offset, timeout: POLL_TIMEOUT_SECONDS })
      const next = await consume(updates, offset)
      // A held-back offset makes the next getUpdates return instantly with the
      // same update, so without this pause the retries burn CPU in a tight loop.
      const stalled = updates.length > 0 && next === offset
      offset = next
      if (stalled) await new Promise(r => setTimeout(r, POLL_RETRY_MS))
    } catch (err) {
      const is409 = (err as { error_code?: number })?.error_code === 409
      const delay = is409 ? CONFLICT_RETRY_MS : POLL_RETRY_MS
      process.stderr.write(
        `telegram poller: ${is409 ? '409 Conflict' : `poll error: ${err}`}, retrying in ${delay / 1000}s\n`,
      )
      await new Promise(r => setTimeout(r, delay))
    }
  }
}

main().catch(err => {
  process.stderr.write(`telegram poller: fatal: ${err}\n`)
  process.exit(1)
})
