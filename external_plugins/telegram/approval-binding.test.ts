import { expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { BINDING_SESSION_RE, composeMessageText, computeBindingKey, renderBindingDisplay } from './approval-binding'

test('key = sha256(session + 換行 + subject) 的十六進位', () => {
  const expected = createHash('sha256').update('s1\ngit status', 'utf8').digest('hex')
  expect(computeBindingKey({ session: 's1', subject: 'git status' })).toBe(expected)
})

test('session、subject 任一不同，key 就不同', () => {
  const base = computeBindingKey({ session: 's1', subject: 'git status' })
  expect(computeBindingKey({ session: 's2', subject: 'git status' })).not.toBe(base)
  expect(computeBindingKey({ session: 's1', subject: 'git status ' })).not.toBe(base)
})

test('session 不接受換行，所以 session / subject 的切法只有一種', () => {
  expect(BINDING_SESSION_RE.test('a\nb')).toBe(false)
  expect(BINDING_SESSION_RE.test('5f1c3a2e-0b7d-4c1e-9a55-3d2f8e6b7c10')).toBe(true)
})

test('顯示文字：機密遮罩，隱形與控制字元寫成 [U+XXXX]，tab 與換行保留', () => {
  expect(renderBindingDisplay('export TOKEN=abc123\tx\n‮y\u0007')).toBe('export TOKEN=***\tx\n[U+202E]y[U+0007]')
})

test('沒有綁定時訊息就是自由文字本身', () => {
  expect(composeMessageText(null, '要 merge PR #42 嗎？')).toBe('要 merge PR #42 嗎？')
})

test('有綁定時區塊在最前面、每行加標記，自由文字在分隔線之後', () => {
  expect(composeMessageText('line1\nline2', '說明')).toBe(
    ['【綁定內容】由 poller 顯示，每行以「┃ 」開頭，機密已遮罩：', '┃ line1', '┃ line2', '────────────', '說明'].join('\n'),
  )
})
