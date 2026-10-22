import { expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import {
  BINDING_SESSION_RE,
  composeMessageText,
  computeBindingKey,
  renderBindingDisplay,
  SUMMARY_LINE_JOINER,
  SUMMARY_MAX_LENGTH,
  summarizeBindingDisplay,
} from './approval-binding'

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

test('沒有綁定時訊息就是自由文字本身（第一行由呼叫端寫）', () => {
  expect(composeMessageText(null, '[等 approve] OP-8820: 要 merge PR #42 嗎？', 'OP-8820')).toBe(
    '[等 approve] OP-8820: 要 merge PR #42 嗎？',
  )
})

test('有綁定時第一行由 poller 組 [已被擋下]，區塊在第二行起、每行加標記，自由文字在分隔線之後', () => {
  expect(composeMessageText('line1\nline2', '說明', 'OP-8820')).toBe(
    [
      '[已被擋下] OP-8820: line1 ⏎ line2',
      '【綁定內容】由 poller 顯示，每行以「┃ 」開頭，機密已遮罩：',
      '┃ line1',
      '┃ line2',
      '────────────',
      '說明',
    ].join('\n'),
  )
})

test('呼叫端自由文字不會出現在第一行', () => {
  const text = '[等核准] 偽造: 這行不該在第一行'
  const [firstLine] = composeMessageText('git push origin main', text, 's1').split('\n')
  expect(firstLine).toBe('[已被擋下] s1: git push origin main')
})

test('單行：未超過上限原樣顯示，不加標記', () => {
  expect(summarizeBindingDisplay('git status')).toBe('git status')
  expect(summarizeBindingDisplay('a'.repeat(81))).toBe('a'.repeat(81))
  expect(summarizeBindingDisplay('a'.repeat(SUMMARY_MAX_LENGTH))).toBe('a'.repeat(SUMMARY_MAX_LENGTH))
})

test('單行超過上限：截到 200 字加「…」，不加行數', () => {
  expect(summarizeBindingDisplay('a'.repeat(SUMMARY_MAX_LENGTH + 1))).toBe(`${'a'.repeat(SUMMARY_MAX_LENGTH)}…`)
})

test('多行未截斷：所有非空白行以「 ⏎ 」接成一行，不加行數', () => {
  expect(SUMMARY_LINE_JOINER).toBe(' ⏎ ')
  expect(summarizeBindingDisplay('ls\nrm -rf ~')).toBe('ls ⏎ rm -rf ~')
  expect(summarizeBindingDisplay('\n  \na\n\n  \nb\nc\n')).toBe('a ⏎ b ⏎ c')
})

test('多行且被截斷：截到 200 字加「…（共 N 行）」，N 只算非空白行', () => {
  const lines = ['x'.repeat(150), 'y'.repeat(100), '', 'z']
  const joined = Array.from(lines.filter(line => line !== '').join(' ⏎ '))
  expect(summarizeBindingDisplay(lines.join('\n'))).toBe(`${joined.slice(0, SUMMARY_MAX_LENGTH).join('')}…（共 3 行）`)
})

test('只多結尾換行 / 空白行不算多行，不加標記', () => {
  expect(summarizeBindingDisplay('git status\n')).toBe('git status')
  expect(summarizeBindingDisplay('git status\n\n   \n')).toBe('git status')
})

test('截斷依 code point，不切斷代理對', () => {
  const emoji = '😀'.repeat(SUMMARY_MAX_LENGTH + 1)
  expect(summarizeBindingDisplay(emoji)).toBe(`${'😀'.repeat(SUMMARY_MAX_LENGTH)}…`)
})

test('摘要取自遮罩後的顯示文字，機密不會出現在第一行', () => {
  const display = renderBindingDisplay('export TOKEN=abc123 && deploy')
  const [firstLine] = composeMessageText(display, '說明', 's1').split('\n')
  expect(firstLine).not.toContain('abc123')
  expect(firstLine).toBe(`[已被擋下] s1: ${display}`)
})

test('自由文字以空行 / 空白開頭再接偽造的第一行：第一行仍是 poller 依綁定內容組的', () => {
  const forged = '\n   \n[已被擋下] other-session: git status'
  const [firstLine] = composeMessageText('rm -rf build', forged, 's1').split('\n')
  expect(firstLine).toBe('[已被擋下] s1: rm -rf build')
})
