import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// The poller is the token's only getUpdates consumer. A second consumer — any
// server.ts, including a session-direct one that read the hub's token through
// the pointer file — would 409 against it and steal the hub's updates. server.ts
// cannot be started in a unit test (it needs an MCP client), so this pins the
// source: no long-poll entry point may appear in it. The runtime side is pinned
// by session-direct-server.e2e.test.ts (no getUpdates reaches the fake Bot API).
const SOURCE = readFileSync(join(import.meta.dir, 'server.ts'), 'utf8')
// Comments mention getUpdates to explain the design; only code matters here.
const CODE = SOURCE.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')

test('server.ts 的程式碼不呼叫 getUpdates，也不啟動 grammy 的 polling（bot.start / run）', () => {
  expect(CODE).not.toMatch(/getUpdates/)
  expect(CODE).not.toMatch(/\bbot\s*\.\s*start\s*\(/)
  expect(CODE).not.toMatch(/@grammyjs\/runner|\brun\s*\(\s*bot\b/)
})

test('server.ts 收訊只走 poller 訂閱：update 由 bot.handleUpdate 餵入', () => {
  expect(CODE).toMatch(/startSubscribeClient\(/)
  expect(CODE).toMatch(/bot\.handleUpdate\(/)
})
