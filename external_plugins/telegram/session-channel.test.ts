import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  resolveChannelSpec,
  createSystemProbeIo,
  hasChannelFlag,
  probeSessionChannel,
  resolveSessionDirectPointer,
  resolveSessionDisplayName,
  type JobRecord,
  type SessionProbeIo,
  type SessionRecord,
} from './session-channel'

const POINTER = '/home/u/.claude/channels/telegram-session-direct.json'
const SPEC = 'plugin:telegram@itmrchow-plugins'
const SID = '1cf90a25-0dd0-4447-b7f1-ebf989600053'

const readerOf = (content: string | undefined) => (): string => {
  if (content === undefined) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
  return content
}

test('指標檔：有 AGENT_SCOPE 或 TELEGRAM_STATE_DIR（中控 / 其他 bot）時完全不讀', () => {
  let reads = 0
  const read = (): string => {
    reads++
    return '{"enabled":true,"stateDir":"/s"}'
  }
  expect(resolveSessionDirectPointer({ AGENT_SCOPE: 'telegram-dm-1' }, POINTER, read).kind).toBe('off')
  expect(resolveSessionDirectPointer({ TELEGRAM_STATE_DIR: '/x' }, POINTER, read).kind).toBe('off')
  expect(reads).toBe(0)
})

test('指標檔：不存在 = 關（預設關），且不算設定錯誤', () => {
  expect(resolveSessionDirectPointer({}, POINTER, readerOf(undefined))).toEqual({
    kind: 'off',
    reason: 'no pointer file',
    misconfigured: false,
  })
})

test('指標檔：enabled 不是 true 就關', () => {
  for (const raw of ['{"enabled":"true","stateDir":"/s"}', '{"enabled":1,"stateDir":"/s"}', '{"stateDir":"/s"}']) {
    expect(resolveSessionDirectPointer({}, POINTER, readerOf(raw)).kind).toBe('off')
  }
})

test('指標檔：壞 JSON / stateDir 不是絕對路徑 -> 關且標設定錯誤', () => {
  for (const raw of ['{', 'null', '{"enabled":true}', '{"enabled":true,"stateDir":"rel/dir"}']) {
    const result = resolveSessionDirectPointer({}, POINTER, readerOf(raw))
    expect(result).toMatchObject({ kind: 'off', misconfigured: true })
  }
})

test('指標檔：合法 -> 開並給 stateDir', () => {
  expect(resolveSessionDirectPointer({ AGENT_SCOPE: ' ' }, POINTER, readerOf('{"enabled":true,"stateDir":"/s/tg"}'))).toEqual({
    kind: 'on',
    stateDir: '/s/tg',
  })
})

test('plugin 安裝路徑 -> --channels 項目', () => {
  expect(resolveChannelSpec('/Users/u/.claude/plugins/cache/itmrchow-plugins/telegram/0.12.0')).toBe(SPEC)
  expect(resolveChannelSpec('/Users/u/.claude/plugins/cache/itmrchow-plugins/telegram/0.12.0/')).toBe(SPEC)
  expect(resolveChannelSpec(undefined)).toBeUndefined()
  expect(resolveChannelSpec('/repo/external_plugins/telegram')).toBeUndefined()
})

test('--channels 旗標的各種寫法', () => {
  expect(hasChannelFlag(['claude', '--agent', 'tg-hub', '--channels', SPEC], SPEC)).toBe(true)
  expect(hasChannelFlag(['--channels', 'server:x', SPEC, '--model', 'opus'], SPEC)).toBe(true)
  expect(hasChannelFlag(['--channels', `server:x,${SPEC}`], SPEC)).toBe(true)
  expect(hasChannelFlag([`--channels=${SPEC}`], SPEC)).toBe(true)
})

test('--channels 沒有本 plugin、或本 plugin 字樣出現在別的旗標值裡 -> 不算', () => {
  expect(hasChannelFlag(['claude', '--name', SPEC], SPEC)).toBe(false)
  expect(hasChannelFlag(['--channels', 'plugin:telegram@other'], SPEC)).toBe(false)
  expect(hasChannelFlag(['--channels', '--model', SPEC], SPEC)).toBe(false)
  expect(hasChannelFlag(['claude', 'bg-spare', '--bg-spare', '/tmp/x.sock'], SPEC)).toBe(false)
})

type Tree = Record<number, { parent?: number; args?: string[]; record?: SessionRecord }>

const ioOf = (tree: Tree, jobs: JobRecord[] = []): SessionProbeIo => ({
  readArgs: pid => tree[pid]?.args,
  readParentPid: pid => tree[pid]?.parent,
  readSessionRecord: pid => tree[pid]?.record,
  listJobRecords: () => jobs,
})

test('前景啟動：自己的 claude 程序 argv 帶 --channels -> 可顯示', () => {
  const tree: Tree = { 200: { parent: 100, args: ['claude', '--channels', SPEC], record: { sessionId: SID } } }
  expect(probeSessionChannel({ sessionId: SID, startPid: 200, channelSpec: SPEC, io: ioOf(tree) })).toEqual({
    ok: true,
    claudePid: 200,
  })
})

test('中間隔一層（例：tsx 包裝）也找得到自己的 claude 程序', () => {
  const tree: Tree = {
    300: { parent: 200, args: ['tsx', 'server.ts'] },
    200: { parent: 100, args: ['claude', '--channels', SPEC], record: { sessionId: SID } },
  }
  expect(probeSessionChannel({ sessionId: SID, startPid: 300, channelSpec: SPEC, io: ioOf(tree) }).ok).toBe(true)
})

test('不會誤認外層 session：外層 claude 帶 --channels、自己這層沒帶 -> 不可顯示', () => {
  const tree: Tree = {
    300: { parent: 250, args: ['claude', '-p', 'hi'], record: { sessionId: SID } },
    250: { parent: 200, args: ['zsh'] },
    200: { parent: 1, args: ['claude', '--channels', SPEC], record: { sessionId: 'aaaaaaaa-0000-4000-8000-000000000000' } },
  }
  expect(probeSessionChannel({ sessionId: SID, startPid: 300, channelSpec: SPEC, io: ioOf(tree) }).ok).toBe(false)
})

test('背景 session（bg-spare 程序）：argv 看不到旗標時查 job 記錄的 respawnFlags', () => {
  const tree: Tree = { 400: { parent: 1, args: ['claude', 'bg-spare', '--bg-spare', '/tmp/s'], record: { sessionId: SID } } }
  const withChannel: JobRecord[] = [
    { sessionId: 'other', respawnFlags: ['--channels', SPEC] },
    { sessionId: SID, resumeSessionId: SID, respawnFlags: ['--name', 'x', '--channels', SPEC] },
  ]
  expect(probeSessionChannel({ sessionId: SID, startPid: 400, channelSpec: SPEC, io: ioOf(tree, withChannel) }).ok).toBe(true)
  const resumed: JobRecord[] = [{ sessionId: 'new', resumeSessionId: SID, respawnFlags: ['--channels', SPEC] }]
  expect(probeSessionChannel({ sessionId: SID, startPid: 400, channelSpec: SPEC, io: ioOf(tree, resumed) }).ok).toBe(true)
  const without: JobRecord[] = [{ sessionId: SID, respawnFlags: ['--name', 'x'] }]
  expect(probeSessionChannel({ sessionId: SID, startPid: 400, channelSpec: SPEC, io: ioOf(tree, without) }).ok).toBe(false)
  expect(probeSessionChannel({ sessionId: SID, startPid: 400, channelSpec: SPEC, io: ioOf(tree) }).ok).toBe(false)
})

test('前景程序沒帶旗標：不看 job 記錄（舊 bg 記錄 + 同 session id 前景 resume 不可誤判）', () => {
  const tree: Tree = { 500: { parent: 1, args: ['claude', '--resume', SID], record: { sessionId: SID } } }
  const stale: JobRecord[] = [{ sessionId: SID, resumeSessionId: SID, respawnFlags: ['--channels', SPEC] }]
  expect(probeSessionChannel({ sessionId: SID, startPid: 500, channelSpec: SPEC, io: ioOf(tree, stale) })).toEqual({
    ok: false,
    reason: `session not started with --channels ${SPEC}`,
  })
})

test('argv 讀不到：不可顯示，也不看 job 記錄', () => {
  const tree: Tree = { 600: { parent: 1, record: { sessionId: SID } } }
  const jobs: JobRecord[] = [{ sessionId: SID, respawnFlags: ['--channels', SPEC] }]
  expect(probeSessionChannel({ sessionId: SID, startPid: 600, channelSpec: SPEC, io: ioOf(tree, jobs) })).toEqual({
    ok: false,
    reason: 'claude process argv unreadable',
  })
})

test('判斷不了一律不可顯示：無 session id / 無 spec / 找不到自己的 claude 程序 / 超過層數', () => {
  const tree: Tree = { 200: { parent: 100, args: ['claude', '--channels', SPEC], record: { sessionId: SID } } }
  expect(probeSessionChannel({ sessionId: undefined, startPid: 200, channelSpec: SPEC, io: ioOf(tree) }).ok).toBe(false)
  expect(probeSessionChannel({ sessionId: SID, startPid: 200, channelSpec: undefined, io: ioOf(tree) }).ok).toBe(false)
  expect(probeSessionChannel({ sessionId: SID, startPid: 999, channelSpec: SPEC, io: ioOf(tree) }).ok).toBe(false)
  const deep: Tree = {
    6: { parent: 5 },
    5: { parent: 4 },
    4: { parent: 3 },
    3: { parent: 2 },
    2: { parent: 1, args: ['claude', '--channels', SPEC], record: { sessionId: SID } },
  }
  expect(probeSessionChannel({ sessionId: SID, startPid: 6, channelSpec: SPEC, io: ioOf(deep) }).ok).toBe(false)
})

test('session 名：有名字用名字，沒有用 session-<id 前 8 碼>', () => {
  expect(resolveSessionDisplayName({ sessionId: SID, name: ' JP-380 直送 ' }, SID)).toBe('JP-380 直送')
  expect(resolveSessionDisplayName({ sessionId: SID, name: '  ' }, SID)).toBe('session-1cf90a25')
  expect(resolveSessionDisplayName(undefined, SID)).toBe('session-1cf90a25')
})

let configDir: string
beforeEach(() => {
  configDir = mkdtempSync(join(tmpdir(), 'jp380-cfg-'))
})
afterEach(() => rmSync(configDir, { recursive: true, force: true }))

test('系統 io：讀 sessions/<pid>.json 與 jobs/*/state.json，壞檔略過', () => {
  mkdirSync(join(configDir, 'sessions'))
  writeFileSync(join(configDir, 'sessions', '123.json'), JSON.stringify({ pid: 123, sessionId: SID, name: 'n' }))
  writeFileSync(join(configDir, 'sessions', '124.json'), '{broken')
  for (const [id, body] of [
    ['a', JSON.stringify({ sessionId: SID, respawnFlags: ['--channels', SPEC, 7] })],
    ['b', '{broken'],
  ] as const) {
    mkdirSync(join(configDir, 'jobs', id), { recursive: true })
    writeFileSync(join(configDir, 'jobs', id, 'state.json'), body)
  }
  const io = createSystemProbeIo(configDir)
  expect(io.readSessionRecord(123)).toEqual({ sessionId: SID, name: 'n' })
  expect(io.readSessionRecord(124)).toBeUndefined()
  expect(io.readSessionRecord(125)).toBeUndefined()
  expect(io.listJobRecords()).toEqual([{ sessionId: SID, respawnFlags: ['--channels', SPEC] }])
})

test('系統 io：jobs 目錄不存在 -> 空清單；ps 讀得到自己的父程序與 argv', () => {
  const io = createSystemProbeIo(configDir)
  expect(io.listJobRecords()).toEqual([])
  expect(io.readParentPid(process.pid)).toBe(process.ppid)
  expect(io.readArgs(process.pid)?.length).toBeGreaterThan(0)
})
