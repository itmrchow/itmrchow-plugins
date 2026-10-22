import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// JP-379 review r1 P2-5: every ctx.reply in server.ts is a system message
// (pairing, /start /help /status, /ctx /clear /restart) and must open with the
// first line when TELEGRAM_FIRST_LINE_FORMAT is on. server.ts cannot be started
// in a test (it needs an MCP client), so this pins the source instead: a new
// ctx.reply that forgets the formatter turns red here. The session's own text
// goes out through bot.api in the reply / edit_message tools, never ctx.reply.
const SOURCE = readFileSync(join(import.meta.dir, 'server.ts'), 'utf8')
const REPLY_CALL = 'ctx.reply('
const FORMATTED_REPLY_RE = /^ctx\.reply\(\s*formatSystemText\(/

const replyCalls = (): string[] => {
  const calls: string[] = []
  for (let at = SOURCE.indexOf(REPLY_CALL); at !== -1; at = SOURCE.indexOf(REPLY_CALL, at + REPLY_CALL.length)) {
    calls.push(SOURCE.slice(at, at + 80))
  }
  return calls
}

test('server.ts 確實有 ctx.reply 呼叫（避免改名後本測試空轉）', () => {
  expect(replyCalls().length).toBeGreaterThan(0)
})

test('server.ts 每一個 ctx.reply 的參數都包在 formatSystemText 裡', () => {
  const unwrapped = replyCalls().filter(call => !FORMATTED_REPLY_RE.test(call))
  expect(unwrapped).toEqual([])
})
