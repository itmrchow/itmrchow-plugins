import { afterEach, beforeEach, expect, test } from 'bun:test'
import { appendFileSync, chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync, renameSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { appendMessageMapEntries, createMessageMapLookup, type MessageMapFs } from './message-map'

const SID_A = '65588277-b69e-4b0e-86bb-a69e0fe7abb6'
const SID_B = 'ce12d202-2bf1-4502-bef0-8967233bd2d9'
const line = (messageId: number, sessionId: string, extra: Record<string, unknown> = {}): string =>
  `${JSON.stringify({ message_id: messageId, session_id: sessionId, session_name: '任務 名稱', sent_at: 1, ...extra })}\n`

let dir: string
let file: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'jp380-map-'))
  file = join(dir, 'message-map.jsonl')
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

test('查得到 session_id；chat_id 有記才帶', () => {
  writeFileSync(file, line(1, SID_A) + line(2, SID_B, { chat_id: 555 }))
  const lookup = createMessageMapLookup({ filePath: file })
  expect(lookup(1)).toEqual({ sessionId: SID_A })
  expect(lookup(2)).toEqual({ sessionId: SID_B, chatId: '555' })
  expect(lookup(3)).toBeUndefined()
})

test('檔案不存在：查無，不丟例外', () => {
  const lookup = createMessageMapLookup({ filePath: join(dir, 'missing.jsonl') })
  expect(lookup(1)).toBeUndefined()
})

test('壞行略過，不影響後面的行', () => {
  writeFileSync(file, '{not json\n' + '{"message_id":"7","session_id":"x"}\n' + '[]\n' + 'null\n' + line(8, SID_A))
  const lookup = createMessageMapLookup({ filePath: file })
  expect(lookup(7)).toBeUndefined()
  expect(lookup(8)).toEqual({ sessionId: SID_A })
})

test('追加的新行下次查就讀得到', () => {
  writeFileSync(file, line(1, SID_A))
  const lookup = createMessageMapLookup({ filePath: file })
  expect(lookup(2)).toBeUndefined()
  appendFileSync(file, line(2, SID_B))
  expect(lookup(2)).toEqual({ sessionId: SID_B })
  expect(lookup(1)).toEqual({ sessionId: SID_A })
})

test('寫到一半的尾行（沒換行）先不讀，寫完再讀', () => {
  const full = line(5, SID_B)
  writeFileSync(file, line(1, SID_A) + full.slice(0, 20))
  const lookup = createMessageMapLookup({ filePath: file })
  expect(lookup(5)).toBeUndefined()
  appendFileSync(file, full.slice(20))
  expect(lookup(5)).toEqual({ sessionId: SID_B })
})

test('檔案被換掉（inode 變）或變小：整份重讀', () => {
  writeFileSync(file, line(1, SID_A) + line(2, SID_A))
  const lookup = createMessageMapLookup({ filePath: file })
  expect(lookup(2)).toEqual({ sessionId: SID_A })
  const replacement = join(dir, 'next.jsonl')
  writeFileSync(replacement, line(9, SID_B))
  renameSync(replacement, file)
  expect(lookup(2)).toBeUndefined()
  expect(lookup(9)).toEqual({ sessionId: SID_B })
})

test('只讀新增位元組：第二次查不重讀已讀過的部分', () => {
  const content = Buffer.from(line(1, SID_A) + line(2, SID_B))
  let size = content.length
  const reads: [number, number][] = []
  const fs: MessageMapFs = {
    stat: () => ({ size, ino: 1 }),
    readRange: (_path, start, end) => {
      reads.push([start, end])
      return content.subarray(start, end)
    },
  }
  const lookup = createMessageMapLookup({ filePath: '/x', fs })
  expect(lookup(1)).toEqual({ sessionId: SID_A })
  expect(lookup(2)).toEqual({ sessionId: SID_B })
  expect(reads).toEqual([[0, size]])
  size = content.length
  expect(lookup(1)).toEqual({ sessionId: SID_A })
  expect(reads.length).toBe(1)
})

test('讀取失敗：查無，不丟例外', () => {
  const fs: MessageMapFs = {
    stat: () => ({ size: 10, ino: 1 }),
    readRange: () => {
      throw new Error('EIO')
    },
  }
  expect(createMessageMapLookup({ filePath: '/x', fs })(1)).toBeUndefined()
})

test('同一 message_id 多筆：以最後一筆有效行為準；欄位不全的合法 JSON 行視同壞行', () => {
  writeFileSync(
    file,
    line(1, SID_A) + line(1, SID_B) + '{"message_id":1}\n' + '{"message_id":1,"session_id":42}\n' + '{"session_id":"x"}\n',
  )
  expect(createMessageMapLookup({ filePath: file })(1)).toEqual({ sessionId: SID_B })
})

test('檔案讀不到（沒有讀取權限）：查無，不丟例外', () => {
  writeFileSync(file, line(1, SID_A))
  chmodSync(file, 0o000)
  try {
    expect(createMessageMapLookup({ filePath: file })(1)).toBeUndefined()
  } finally {
    chmodSync(file, 0o600)
  }
})

test('2 萬行的 map：首次查表與後續查表都遠低於 1 秒', () => {
  writeFileSync(file, Array.from({ length: 20_000 }, (_, i) => line(i + 1, i % 2 ? SID_A : SID_B)).join(''))
  const lookup = createMessageMapLookup({ filePath: file })
  const firstStart = performance.now()
  expect(lookup(19_999)).toEqual({ sessionId: SID_B })
  const first = performance.now() - firstStart
  appendFileSync(file, line(20_001, SID_A))
  const nextStart = performance.now()
  expect(lookup(20_001)).toEqual({ sessionId: SID_A })
  const next = performance.now() - nextStart
  expect(first).toBeLessThan(1000)
  expect(next).toBeLessThan(50)
})

test('寫入：一次 append 多行，格式與 tg-send 相同（四個欄位），可被查回', () => {
  writeFileSync(file, line(1, SID_A))
  appendMessageMapEntries(
    file,
    [
      { messageId: 50, sessionId: SID_B, sessionName: '任務 [x]: y' },
      { messageId: 51, sessionId: SID_B, sessionName: '' },
    ],
    1_792_700_000_500,
  )
  const written = readFileSync(file, 'utf8').trim().split('\n').slice(1).map(l => JSON.parse(l) as Record<string, unknown>)
  expect(written).toEqual([
    { message_id: 50, session_id: SID_B, session_name: '任務 [x]: y', sent_at: 1_792_700_000 },
    { message_id: 51, session_id: SID_B, session_name: '', sent_at: 1_792_700_000 },
  ])
  const lookup = createMessageMapLookup({ filePath: file })
  expect(lookup(50)).toEqual({ sessionId: SID_B })
  expect(lookup(51)).toEqual({ sessionId: SID_B })
})

test('寫入：空清單不動檔案；目錄不存在時丟例外交給呼叫端處理', () => {
  appendMessageMapEntries(join(dir, 'never.jsonl'), [])
  expect(() => readFileSync(join(dir, 'never.jsonl'))).toThrow()
  expect(() => appendMessageMapEntries(join(dir, 'no', 'such', 'map.jsonl'), [{ messageId: 1, sessionId: SID_A, sessionName: '' }])).toThrow()
})
