#!/usr/bin/env bun
/**
 * Standalone Discord poller — the platform's sole gateway holder and the hub
 * every scope subscribes to.
 *
 * Why a separate process: a discord gateway connection is one per bot token, so
 * N scopes cannot each hold one. Concentrating it here also matches telegram,
 * where the split was forced by the MCP stdin watcher starving the in-process
 * poll loop on aarch64.
 *
 * Each gateway event is routed to a scope (one Claude session per DM partner /
 * per channel, threads folded into their parent) and written to that scope's SSE
 * subscription, spawning the scope through the carrier's scope-spawn script when
 * it does not exist yet.
 *
 * Access policy is NOT applied here: dmPolicy / allowFrom / requireMention /
 * pairing stay in server.ts's gate(), so there is exactly one verdict per event.
 */
import {
  Client,
  GatewayIntentBits,
  Partials,
  ChannelType,
  type ButtonInteraction,
  type Interaction,
  type Message,
} from 'discord.js'
import { readFileSync, writeFileSync, mkdirSync, chmodSync } from 'fs'
import { join } from 'path'
import { spawn as spawnProcess } from 'node:child_process'
import { resolveCount, resolvePort } from './resolve-port'
import { resolveStateDir } from './state-dir'
import { ScopeRegistry } from './poller-registry'
import { createSubscribeServer } from './subscribe-server'
import {
  routeMessage,
  type RouteContext,
  type RouteInput,
  type SpawnOutcome,
} from './route-message'
import { toInboundMessage, type InboundInteraction } from './inbound-message'
import {
  createGatewayHealth,
  shouldLogGatewayDebug,
  GATEWAY_STALE_AFTER_MS,
  HEALTH_CHECK_INTERVAL_MS,
  type GatewayHealthSnapshot,
} from './gateway-health'

// Per-plugin port, like DISCORD_INJECT_PORT: every channel plugin is spawned by
// the same process and inherits one env, so a shared key would collide.
// telegram's poller uses 7852.
const DEFAULT_POLLER_PORT = 7853
const DEFAULT_MAX_SCOPES = 10
/** Events held per scope while it boots. A Claude start is ~30s; more than a
 *  handful of queued messages means the sender has moved on anyway. */
const MAX_QUEUE_PER_SCOPE = 20
const LOOPBACK = '127.0.0.1'

/** Exit codes of scope-spawn.sh; see the spawn contract in the JP-177 plan. */
const SPAWN_EXIT_OK = 0
const SPAWN_EXIT_TRANSIENT = 1
const SPAWN_EXIT_CAP_REACHED = 2
const SPAWN_EXIT_INVALID_SCOPE = 3

// Fail-closed, no default path: see resolveStateDir for why.
const STATE_DIR = resolveStateDir(process.env)
if (!STATE_DIR) {
  process.stderr.write(
    'discord poller: DISCORD_STATE_DIR required (no default, so a stray run cannot take over the live gateway)\n',
  )
  process.exit(1)
}

const ENV_FILE = join(STATE_DIR, '.env')
const PID_FILE = join(STATE_DIR, 'poller.pid')

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
  process.env.DISCORD_POLLER_PORT,
  DEFAULT_POLLER_PORT,
  'DISCORD_POLLER_PORT',
)

const MAX_SCOPES = resolveCount(process.env.MAX_SCOPES, DEFAULT_MAX_SCOPES, 'MAX_SCOPES')

const SCOPE_SPAWN_BIN = process.env.SCOPE_SPAWN_BIN

const TOKEN = process.env.DISCORD_BOT_TOKEN
if (!TOKEN) {
  process.stderr.write(`discord poller: DISCORD_BOT_TOKEN required (set in ${ENV_FILE})\n`)
  process.exit(1)
}

// Replace any stale poller so a restart takes over the single gateway slot.
mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 })
try {
  const stale = parseInt(readFileSync(PID_FILE, 'utf8'), 10)
  if (stale > 1 && stale !== process.pid) {
    process.kill(stale, 0)
    process.stderr.write(`discord poller: replacing stale poller pid=${stale}\n`)
    process.kill(stale, 'SIGTERM')
  }
} catch {}
writeFileSync(PID_FILE, String(process.pid))

process.on('SIGTERM', () => process.exit(0))
process.on('SIGINT', () => process.exit(0))

const client = new Client({
  intents: [
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
  // DMs arrive as partial channels — messageCreate never fires without this.
  partials: [Partials.Channel],
})

const registry = new ScopeRegistry({ maxScopes: MAX_SCOPES, maxQueue: MAX_QUEUE_PER_SCOPE })
const hub = createSubscribeServer({
  registry,
  onSubscribe: scopeId => process.stderr.write(`discord poller: ${scopeId} subscribed\n`),
  onDisconnect: scopeId => process.stderr.write(`discord poller: ${scopeId} disconnected\n`),
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
    process.stderr.write(`discord poller: SCOPE_SPAWN_BIN unset, cannot start ${scopeId}\n`)
    return Promise.resolve('not_configured')
  }
  return new Promise(resolve => {
    // Arg array, never a shell string: scopeId is regex-validated upstream, and
    // keeping it out of a shell means that validation is not the only barrier.
    const child = spawnProcess(SCOPE_SPAWN_BIN, [scopeId], {
      stdio: ['ignore', 'ignore', 'inherit'],
    })
    child.on('error', err => {
      process.stderr.write(`discord poller: scope-spawn exec failed for ${scopeId}: ${err}\n`)
      resolve('failed')
    })
    child.on('close', code => {
      if (code === SPAWN_EXIT_OK) return resolve('ok')
      if (code === SPAWN_EXIT_TRANSIENT) return resolve('failed')
      if (code === SPAWN_EXIT_CAP_REACHED) return resolve('cap_reached')
      if (code === SPAWN_EXIT_INVALID_SCOPE) return resolve('invalid_scope')
      resolve('failed')
    })
  })
}

async function notify(channelId: string, text: string): Promise<void> {
  try {
    const channel = await client.channels.fetch(channelId)
    if (channel?.isSendable()) await channel.send(text)
  } catch (err) {
    process.stderr.write(`discord poller: notify ${channelId} failed: ${err}\n`)
  }
}

const ctx: RouteContext = { registry, deliver: hub.deliver, spawn: spawnScope, notify }

/** Parent channel of a thread, or undefined when this is not a thread. */
function parentOf(channel: Message['channel'] | Interaction['channel']): string | undefined {
  return channel?.isThread() ? channel.parentId ?? undefined : undefined
}

function messageInput(msg: Message): RouteInput {
  const isDm = msg.channel.type === ChannelType.DM
  const parentId = parentOf(msg.channel)
  return {
    kind: 'messageCreate',
    isDm,
    channelId: msg.channelId,
    parentId,
    authorId: msg.author.id,
    // NOT msg.toJSON(): discord.js's flatten rewrites `author` to `authorId` and
    // uses its own camelCase names, so a subscriber reading the payload would
    // silently get `undefined` for the author. See inbound-message.ts.
    data: toInboundMessage(msg, { isDm, parentId }),
  }
}

/**
 * Reduce a button click to routing input.
 *
 * Every field is named explicitly rather than taken from toJSON(): an interaction
 * is answered over REST with `token` + `applicationId`, and both are short-lived
 * properties that discord.js's generic flatten has no obligation to emit. A
 * subscriber that receives an interaction it cannot answer leaves the clicked
 * button spinning until it times out.
 *
 * `messageContent` rides along because the answer replaces the prompt with
 * "<original>\n\n✅ Allowed" — without it the subscriber would either lose the
 * original text or pay a REST round-trip inside the 3-second callback window.
 */
function interactionInput(interaction: ButtonInteraction): RouteInput {
  const data: InboundInteraction = {
    id: interaction.id,
    token: interaction.token,
    applicationId: interaction.applicationId,
    customId: interaction.customId,
    userId: interaction.user.id,
    channelId: interaction.channelId,
    guildId: interaction.guildId,
    messageId: interaction.message?.id ?? null,
    messageContent: interaction.message?.content ?? '',
  }
  return {
    kind: 'interactionCreate',
    // guildId, not the channel type: a DM button's channel can still be partial
    // at this point, and a partial channel reports no type.
    isDm: interaction.guildId === null,
    channelId: interaction.channelId ?? interaction.user.id,
    parentId: parentOf(interaction.channel),
    authorId: interaction.user.id,
    data,
  }
}

function handle(input: RouteInput): void {
  routeMessage(input, ctx).catch(err => {
    process.stderr.write(`discord poller: routing ${input.kind} failed: ${err}\n`)
  })
}

/** Newest heartbeat ACK across shards, epoch ms; -1 before the first one. */
function lastAckAt(): number {
  let newest = -1
  for (const shard of client.ws.shards.values()) {
    if (shard.lastPingTimestamp > newest) newest = shard.lastPingTimestamp
  }
  return newest
}

const health = createGatewayHealth({ lastAckAt })

/**
 * Give up on a connection that has gone quiet and let systemd rebuild it.
 *
 * Deliberately NOT client.destroy() + login(): the JP-195 root cause is still
 * unidentified (see gateway-health.ts), and recovering through an existing code
 * path that has demonstrably reached an unknown state is more fragile than
 * rebuilding the process. Exiting hands the job to `Restart=always` in
 * claude-discord-poller.service, which is the one recovery that works without
 * knowing what broke.
 */
function surrenderGateway(snapshot: GatewayHealthSnapshot): void {
  process.stderr.write(
    `discord poller: gateway silent for ${snapshot.ageMs}ms (threshold ${GATEWAY_STALE_AFTER_MS}ms), ` +
      'presuming a zombie connection and exiting for a supervised restart\n',
  )
  process.exit(1)
}

client.on('messageCreate', msg => {
  // JP-197 臨時診斷：DM 完全收不到 messageCreate，需先確認 dispatch 有無抵達 client。
  // 定位根因後應移除或收斂。
  process.stderr.write(
    `discord poller: JP-197 diag messageCreate: channelType=${msg.channel?.type ?? 'undefined'} ` +
      `channelId=${msg.channelId} authorId=${msg.author?.id ?? 'undefined'} bot=${msg.author?.bot ?? 'undefined'}\n`,
  )
  health.markActivity()
  if (msg.author.bot) return
  handle(messageInput(msg))
})

// JP-197 臨時診斷：比 messageCreate 更底層的原始 gateway dispatch，用來區分
// 「gateway 沒送」與「discord.js 過濾掉了」。定位根因後應移除。
// `raw` 不在 discord.js 的 ClientEvents 型別內（v14 只有 Events.Raw 常數），故轉型註冊。
const rawEmitter = client as unknown as {
  on(event: 'raw', listener: (packet: unknown, shardId: number) => void): void
}
rawEmitter.on('raw', (raw: unknown) => {
  const packet = raw as { t?: string; d?: Record<string, unknown> } | null
  if (packet?.t !== 'MESSAGE_CREATE') return
  const d = packet.d ?? {}
  const author = d.author as { id?: string } | undefined
  process.stderr.write(
    `discord poller: JP-197 diag raw MESSAGE_CREATE: channelId=${String(d.channel_id)} ` +
      `authorId=${author?.id ?? 'undefined'} guildId=${d.guild_id === undefined ? 'absent' : String(d.guild_id)}\n`,
  )
})

// Permission buttons only reach the gateway holder, so the poller has to hand
// them on; server.ts answers them over REST once it receives them.
client.on('interactionCreate', interaction => {
  health.markActivity()
  if (!interaction.isButton()) return
  handle(interactionInput(interaction))
})

client.on('error', err => {
  process.stderr.write(`discord poller: client error: ${err}\n`)
})

// Gateway diagnostics. Before JP-195 none of these were listened to, so a
// connection that died left no trace at all: the incident had to be diagnosed
// from `ss -tnp` because the journal had nothing between "gateway connected" and
// the manual restart hours later.
client.on('shardError', (err, shardId) => {
  process.stderr.write(`discord poller: shard ${shardId} error: ${err}\n`)
})

client.on('shardDisconnect', (event, shardId) => {
  process.stderr.write(
    `discord poller: shard ${shardId} disconnected, code=${event.code} (not recoverable by the library)\n`,
  )
})

client.on('shardReconnecting', shardId => {
  process.stderr.write(`discord poller: shard ${shardId} reconnecting\n`)
})

client.on('shardResume', (shardId, replayed) => {
  health.markActivity()
  process.stderr.write(`discord poller: shard ${shardId} resumed, replayed ${replayed} events\n`)
})

client.on('shardReady', shardId => {
  health.markActivity()
  process.stderr.write(`discord poller: shard ${shardId} ready\n`)
})

// The library reports the zombie-connection destroy here and nowhere else.
client.on('debug', message => {
  if (shouldLogGatewayDebug(message)) process.stderr.write(`discord poller: gateway: ${message}\n`)
})

client.once('ready', c => {
  ctx.botInfo = c.user.toJSON()
  health.markActivity()
  process.stderr.write(`discord poller: gateway connected as ${c.user.tag}\n`)
})

// Bind before login(): a token or network problem must not leave the port
// unbound, or the watchdog reads it as a dead agent and restarts in a loop.
hub.server.listen(POLLER_PORT, LOOPBACK, () => {
  process.stderr.write(`discord poller: subscriptions on ${LOOPBACK}:${POLLER_PORT}\n`)
})

// Armed from the login attempt, not from `ready`: a shard that never finishes
// connecting is just as silent as one that died later, and only the timer can
// tell the difference between "still connecting" and "never will".
health.markActivity()
setInterval(() => {
  const snapshot = health.snapshot()
  if (snapshot.stale) return surrenderGateway(snapshot)
  // The verdict goes to the journal, not to a file: while the root cause is
  // unknown, this timeline is the evidence a recurrence will be diagnosed from.
  process.stderr.write(`discord poller: gateway alive, silent for ${snapshot.ageMs}ms\n`)
}, HEALTH_CHECK_INTERVAL_MS)

client.login(TOKEN).catch(err => {
  process.stderr.write(`discord poller: login failed: ${err}\n`)
  process.exit(1)
})
