/**
 * Session-direct mode, server side (JP-380): an ordinary Claude session — not
 * the hub, not a carrier scope — subscribes to the poller under its own scope
 * so a reply to one of its messages reaches it directly.
 *
 * Two things must be known without the launch command's env, because
 * `claude --bg` and `claude respawn` start the session without it:
 *  - whether the mode is on and which state dir (bot token, access.json,
 *    poller port) to use — from a pointer file at a fixed path;
 *  - whether this session can show channel messages at all — a session started
 *    without `--channels` acks every delivery and then drops it silently, so
 *    it must never subscribe. Read from the session's own claude process argv,
 *    or for a background session from the job record Claude Code keeps.
 *
 * Every step is fail-closed: anything unreadable or unexpected means "off" /
 * "cannot show", and the session keeps today's behaviour (replies go to the hub).
 *
 * Split out of server.ts because server.ts needs an MCP client to start, so it
 * cannot be imported by a test.
 */
import { execFileSync } from 'node:child_process'
import { readdirSync, readFileSync } from 'node:fs'
import { isAbsolute, join, sep } from 'node:path'

/** File name of the pointer, under `<home>/.claude/channels/`. */
export const SESSION_DIRECT_POINTER_NAME = 'telegram-session-direct.json'

/** How far up the process tree to look for this session's claude process. */
export const MAX_ANCESTOR_DEPTH = 4

const CHANNELS_FLAG = '--channels'
const CHANNELS_FLAG_EQ = `${CHANNELS_FLAG}=`
const FLAG_PREFIX = '-'
const SPEC_SEGMENT_RE = /^[A-Za-z0-9._-]+$/
const PLUGIN_CACHE_DIR = 'cache'
const SESSION_NAME_FALLBACK_PREFIX = 'session-'
const SESSION_ID_SHORT_LENGTH = 8
const PS_TIMEOUT_MS = 2000

export type SessionDirectPointer =
  | { kind: 'on'; stateDir: string }
  | { kind: 'off'; reason: string; misconfigured: boolean }

/** What Claude Code records about a live session (`<config>/sessions/<pid>.json`). */
export type SessionRecord = { sessionId: string; name?: string }

/** What Claude Code records about a background job (`<config>/jobs/<id>/state.json`). */
export type JobRecord = { sessionId?: string; resumeSessionId?: string; respawnFlags?: string[] }

/** Process and file reads the probe needs; injectable for tests. */
export type SessionProbeIo = {
  readArgs: (pid: number) => string[] | undefined
  readParentPid: (pid: number) => number | undefined
  readSessionRecord: (pid: number) => SessionRecord | undefined
  listJobRecords: () => JobRecord[]
}

export type ChannelProbeResult = { ok: true; claudePid: number } | { ok: false; reason: string }

/**
 * Decide whether this server runs in session-direct mode.
 *
 * Consulted only when the launch env carries neither AGENT_SCOPE nor
 * TELEGRAM_STATE_DIR: the hub and every carrier scope set one of them, so they
 * never read the pointer and behave exactly as before.
 *
 * @param env - Process environment as launched (before any state .env load).
 * @param pointerPath - Absolute path of the pointer file.
 * @param readFile - Reads a file as UTF-8; throws when absent. Injectable for tests.
 * @returns On with the state dir, or off with the reason.
 */
export function resolveSessionDirectPointer(
  env: Record<string, string | undefined>,
  pointerPath: string,
  readFile: (path: string) => string = path => readFileSync(path, 'utf8'),
): SessionDirectPointer {
  if ((env.AGENT_SCOPE ?? '').trim() !== '') return { kind: 'off', reason: 'AGENT_SCOPE set', misconfigured: false }
  if ((env.TELEGRAM_STATE_DIR ?? '').trim() !== '') {
    return { kind: 'off', reason: 'TELEGRAM_STATE_DIR set', misconfigured: false }
  }
  let raw: string
  try {
    raw = readFile(pointerPath)
  } catch {
    return { kind: 'off', reason: 'no pointer file', misconfigured: false }
  }
  let parsed: { enabled?: unknown; stateDir?: unknown }
  try {
    parsed = JSON.parse(raw) as typeof parsed
  } catch {
    return { kind: 'off', reason: 'pointer file is not valid JSON', misconfigured: true }
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return { kind: 'off', reason: 'pointer file is not a JSON object', misconfigured: true }
  }
  if (parsed.enabled !== true) return { kind: 'off', reason: 'pointer "enabled" is not true', misconfigured: false }
  if (typeof parsed.stateDir !== 'string' || !isAbsolute(parsed.stateDir)) {
    return { kind: 'off', reason: 'pointer "stateDir" is not an absolute path', misconfigured: true }
  }
  return { kind: 'on', stateDir: parsed.stateDir }
}

/**
 * The `--channels` entry that names this plugin, derived from where Claude Code
 * installed it: `<...>/cache/<marketplace>/<plugin>/<version>`.
 *
 * @param pluginRoot - CLAUDE_PLUGIN_ROOT.
 * @returns `plugin:<plugin>@<marketplace>`, or undefined when the path does not
 *   have that shape (e.g. run from a checkout) — which means "cannot tell".
 */
export function channelSpecFromPluginRoot(pluginRoot: string | undefined): string | undefined {
  if (!pluginRoot) return undefined
  const parts = pluginRoot.split(sep).filter(part => part !== '')
  if (parts.length < 4) return undefined
  const [cacheDir, marketplace, plugin] = parts.slice(-4, -1)
  if (cacheDir !== PLUGIN_CACHE_DIR) return undefined
  if (!SPEC_SEGMENT_RE.test(marketplace) || !SPEC_SEGMENT_RE.test(plugin)) return undefined
  return `plugin:${plugin}@${marketplace}`
}

/**
 * Whether an argv carries `--channels` naming the given entry.
 *
 * Accepts `--channels a b`, `--channels a,b` and `--channels=a,b`; the values
 * after a bare `--channels` run until the next token that starts with `-`.
 *
 * @param args - Argument vector (program name may be included).
 * @param channelSpec - Entry to look for, e.g. `plugin:telegram@itmrchow-plugins`.
 * @returns true when found.
 */
export function hasChannelFlag(args: readonly string[], channelSpec: string): boolean {
  const values: string[] = []
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg.startsWith(CHANNELS_FLAG_EQ)) {
      values.push(arg.slice(CHANNELS_FLAG_EQ.length))
      continue
    }
    if (arg !== CHANNELS_FLAG) continue
    while (i + 1 < args.length && !args[i + 1].startsWith(FLAG_PREFIX)) values.push(args[++i])
  }
  return values.some(value => value.split(',').some(entry => entry.trim() === channelSpec))
}

/**
 * Find this session's own claude process and decide whether it shows channel
 * messages from this plugin.
 *
 * The claude process is recognised by its session record carrying our
 * CLAUDE_CODE_SESSION_ID — not by "the nearest claude above us", which would
 * pick up an outer session when this one was started from another session's
 * shell. Then: its argv has `--channels <spec>` (foreground start), or, when
 * the argv does not show the flags (a `claude --bg` session runs inside a
 * pre-started spare process whose argv is just `claude bg-spare …`), the job
 * record for this session id lists it in its respawn flags.
 *
 * @param opts.sessionId - CLAUDE_CODE_SESSION_ID.
 * @param opts.startPid - Where the walk starts: this process's parent.
 * @param opts.channelSpec - From channelSpecFromPluginRoot.
 * @param opts.io - Process and file reads.
 * @returns ok with the claude pid, or the reason it cannot be told.
 */
export function probeSessionChannel(opts: {
  sessionId: string | undefined
  startPid: number
  channelSpec: string | undefined
  io: SessionProbeIo
}): ChannelProbeResult {
  const { sessionId, channelSpec, io } = opts
  if (!sessionId) return { ok: false, reason: 'CLAUDE_CODE_SESSION_ID unset' }
  if (!channelSpec) return { ok: false, reason: 'plugin install path not recognised (CLAUDE_PLUGIN_ROOT)' }

  let claudePid: number | undefined
  let pid: number | undefined = opts.startPid
  for (let depth = 0; depth < MAX_ANCESTOR_DEPTH && pid !== undefined && pid > 1; depth++) {
    if (io.readSessionRecord(pid)?.sessionId === sessionId) {
      claudePid = pid
      break
    }
    pid = io.readParentPid(pid)
  }
  if (claudePid === undefined) return { ok: false, reason: 'own claude process not found' }

  const args = io.readArgs(claudePid)
  if (args && hasChannelFlag(args, channelSpec)) return { ok: true, claudePid }

  const job = io.listJobRecords().find(record => record.sessionId === sessionId || record.resumeSessionId === sessionId)
  if (job && Array.isArray(job.respawnFlags) && hasChannelFlag(job.respawnFlags, channelSpec)) {
    return { ok: true, claudePid }
  }
  return { ok: false, reason: `session not started with ${CHANNELS_FLAG} ${channelSpec}` }
}

/**
 * The name this session goes by on a first line: its current name from the
 * session record, else `session-<first 8 of the id>` so there is always one.
 *
 * @param record - The session record, read fresh; undefined when unreadable.
 * @param sessionId - CLAUDE_CODE_SESSION_ID.
 * @returns The name.
 */
export function sessionDisplayName(record: SessionRecord | undefined, sessionId: string): string {
  const name = record?.name?.trim()
  if (name) return name
  return `${SESSION_NAME_FALLBACK_PREFIX}${sessionId.slice(0, SESSION_ID_SHORT_LENGTH)}`
}

/**
 * Read a JSON file, or undefined on any failure.
 *
 * @param path - File path.
 * @returns The parsed value.
 */
function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as unknown
  } catch {
    return undefined
  }
}

/**
 * Run `ps` for one field of one process.
 *
 * @param pid - Process id.
 * @param field - ps output field, e.g. `args` or `ppid`.
 * @returns Trimmed output, or undefined when ps fails or prints nothing.
 */
function readPsField(pid: number, field: string): string | undefined {
  try {
    const out = execFileSync('ps', ['-ww', '-o', `${field}=`, '-p', String(pid)], {
      encoding: 'utf8',
      timeout: PS_TIMEOUT_MS,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
    return out === '' ? undefined : out
  } catch {
    return undefined
  }
}

/**
 * Read a process's argv: exact from /proc where it exists (Linux), else from
 * ps, split on whitespace — none of the tokens looked for contain a space.
 *
 * @param pid - Process id.
 * @returns The argv, or undefined.
 */
function readProcessArgs(pid: number): string[] | undefined {
  try {
    const raw = readFileSync(`/proc/${pid}/cmdline`, 'utf8')
    const args = raw.split('\0').filter(arg => arg !== '')
    if (args.length > 0) return args
  } catch {}
  return readPsField(pid, 'args')?.split(/\s+/)
}

/**
 * The real process and file reads, against Claude Code's config dir.
 *
 * @param configDir - CLAUDE_CONFIG_DIR, or `<home>/.claude`.
 * @returns The io for probeSessionChannel.
 */
export function createSystemProbeIo(configDir: string): SessionProbeIo {
  return {
    readArgs: readProcessArgs,
    readParentPid: pid => {
      const raw = readPsField(pid, 'ppid')
      const parent = raw === undefined ? NaN : Number(raw)
      return Number.isInteger(parent) ? parent : undefined
    },
    readSessionRecord: pid => {
      const raw = readJson(join(configDir, 'sessions', `${pid}.json`)) as { sessionId?: unknown; name?: unknown } | undefined
      if (typeof raw?.sessionId !== 'string') return undefined
      return { sessionId: raw.sessionId, ...(typeof raw.name === 'string' ? { name: raw.name } : {}) }
    },
    listJobRecords: () => {
      const jobsDir = join(configDir, 'jobs')
      let ids: string[]
      try {
        ids = readdirSync(jobsDir)
      } catch {
        return []
      }
      const records: JobRecord[] = []
      for (const id of ids) {
        const raw = readJson(join(jobsDir, id, 'state.json')) as
          | { sessionId?: unknown; resumeSessionId?: unknown; respawnFlags?: unknown }
          | undefined
        if (typeof raw !== 'object' || raw === null) continue
        records.push({
          ...(typeof raw.sessionId === 'string' ? { sessionId: raw.sessionId } : {}),
          ...(typeof raw.resumeSessionId === 'string' ? { resumeSessionId: raw.resumeSessionId } : {}),
          ...(Array.isArray(raw.respawnFlags)
            ? { respawnFlags: raw.respawnFlags.filter((flag): flag is string => typeof flag === 'string') }
            : {}),
        })
      }
      return records
    },
  }
}
