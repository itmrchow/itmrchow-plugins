import { expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Bot } from 'grammy'
import { resolveApiRoot } from './api-root'

test.each([undefined, '', '   '])('未設或空白（%p）：走預設（Telegram 官方位址），不回報任何事', value => {
  expect(resolveApiRoot(value)).toEqual({ kind: 'default' })
})

test.each([
  'http://127.0.0.1:8081',
  'http://localhost:8081',
  'http://[::1]:8081',
  'https://127.0.0.1',
  'http://LOCALHOST:9000',
  'http://127.0.0.1:8081/prefix',
])('loopback 位址 %p 照常生效，原值不被改寫', value => {
  expect(resolveApiRoot(value)).toEqual({ kind: 'override', apiRoot: value })
})

test('前後空白會去掉', () => {
  expect(resolveApiRoot('  http://127.0.0.1:8081  ')).toEqual({ kind: 'override', apiRoot: 'http://127.0.0.1:8081' })
})

test.each([
  ['http://127.0.0.1:8081/', 'http://127.0.0.1:8081'],
  ['http://localhost:8081//', 'http://localhost:8081'],
  ['http://[::1]:8081/prefix/', 'http://[::1]:8081/prefix'],
  ['  http://127.0.0.1/  ', 'http://127.0.0.1'],
])('尾端的 / 會去掉（%p），Bot client 才建得起來', (value, expected) => {
  const resolved = resolveApiRoot(value)
  expect(resolved).toEqual({ kind: 'override', apiRoot: expected })
  // The reason this exists: grammY throws on a trailing slash.
  expect(() => new Bot('1:fake', { client: { apiRoot: value.trim() } })).toThrow()
  expect(() => new Bot('1:fake', { client: { apiRoot: expected } })).not.toThrow()
})

test.each([
  ['外部主機', 'https://api.example.com'],
  ['外部主機、尾端帶 /', 'https://api.example.com/'],
  ['自架 Bot API server', 'http://10.0.0.5:8081'],
  ['區網位址', 'http://192.168.1.10:8081'],
  ['0.0.0.0', 'http://0.0.0.0:8081'],
  ['127 開頭但不是 loopback 的網域', 'http://127.0.0.1.example.com'],
  ['localhost 開頭的外部網域', 'http://localhost.example.com'],
  ['以 userinfo 偽裝成 loopback', 'http://127.0.0.1@evil.example'],
  ['Telegram 官方位址本身', 'https://api.telegram.org'],
])('非 loopback（%s）被忽略：不成為 override', (_name, value) => {
  const resolved = resolveApiRoot(value)
  expect(resolved.kind).toBe('ignored')
  expect(resolved).not.toHaveProperty('apiRoot')
})

test.each([
  ['無法解析', 'not a url'],
  ['缺 scheme', '127.0.0.1:8081'],
  ['非 http(s)', 'ftp://127.0.0.1'],
  ['file URL', 'file:///tmp/x'],
  ['loopback 但帶帳密', 'http://user:secret@127.0.0.1:8081'],
])('不可用的值（%s）被忽略', (_name, value) => {
  expect(resolveApiRoot(value).kind).toBe('ignored')
})

test('被忽略的理由不含原值（原值可能帶機密）', () => {
  const resolved = resolveApiRoot('http://user:s3cr3t-value@evil.example/path-marker')
  expect(resolved.kind).toBe('ignored')
  const text = JSON.stringify(resolved)
  expect(text).not.toContain('s3cr3t-value')
  expect(text).not.toContain('evil.example')
  expect(text).not.toContain('path-marker')
})

// Wiring check on the real poller, without any network: with no token it exits
// at the config check, after TELEGRAM_API_ROOT has already been judged.
test('poller 啟動時對非 loopback 值印出「已忽略」，且 log 不含原值', () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'api-root-'))
  try {
    const result = spawnSync(process.execPath, ['poller.ts'], {
      cwd: import.meta.dir,
      env: {
        PATH: process.env.PATH ?? '',
        HOME: stateDir,
        TELEGRAM_STATE_DIR: stateDir,
        TELEGRAM_API_ROOT: 'https://user:s3cr3t-value@evil.example/bot-api',
      },
      encoding: 'utf8',
    })
    expect(result.stderr).toContain("TELEGRAM_API_ROOT ignored (URL carries credentials); using Telegram's Bot API servers")
    expect(result.stderr).not.toContain('WARNING TELEGRAM_API_ROOT is set')
    expect(result.stderr).not.toContain('evil.example')
    expect(result.stderr).not.toContain('s3cr3t-value')
    expect(result.stderr).toContain('TELEGRAM_BOT_TOKEN required')
  } finally {
    rmSync(stateDir, { recursive: true, force: true })
  }
})
