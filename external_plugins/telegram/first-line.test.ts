import { expect, test } from 'bun:test'
import {
  createPermissionHeadline,
  displaySessionName,
  createSystemTextFormatter,
  FIRST_LINE_STATUS,
  formatFirstLine,
  HUB_SESSION_NAME,
  MAX_SESSION_NAME_LENGTH,
  parseSessionName,
  resolveFirstLineFormat,
} from './first-line'

test('第一行 = 半形方括號狀態 + 空白 + session name + 半形冒號 + 空白 + 內容', () => {
  expect(formatFirstLine(FIRST_LINE_STATUS.blocked, 'OP-8820', 'git push')).toBe('[已被擋下] OP-8820: git push')
})

test('狀態值固定清單', () => {
  expect(Object.values(FIRST_LINE_STATUS).sort()).toEqual(
    ['等核准', '等 approve', '等你', '已停下', '異常結束', '已被擋下', '等你回覆', '回報', '系統'].sort(),
  )
})

test.each([undefined, null, '', '   '])('session_name %p 視同未帶，填 tg-hub', raw => {
  expect(parseSessionName(raw)).toEqual({ ok: true, sessionName: HUB_SESSION_NAME })
})

test.each(['OP-8820', 'my session: 二', 'a'.repeat(MAX_SESSION_NAME_LENGTH)])('session_name %p 原樣採用', raw => {
  expect(parseSessionName(raw)).toEqual({ ok: true, sessionName: raw })
})

test.each([
  ['換行', 'a\nb'],
  ['只有換行', '\n'],
  ['只有 tab', '\t'],
  ['CR', 'a\rb'],
  ['tab', 'a\tb'],
  ['NUL', 'a\u0000b'],
  ['DEL', 'a\u007Fb'],
  ['C1 NEL', 'a\u0085b'],
  ['line separator', 'a\u2028b'],
  ['paragraph separator', 'a\u2029b'],
  ['零寬空白', 'a\u200Bb'],
  ['bidi override', 'a\u202Eb'],
  ['bidi isolate', 'a\u2066b'],
  ['BOM', 'a\uFEFFb'],
])('session_name 含%s時拒收', (_label, raw) => {
  const parsed = parseSessionName(raw)
  expect(parsed.ok).toBe(false)
})

test('session_name 非字串時拒收', () => {
  expect(parseSessionName(42).ok).toBe(false)
  expect(parseSessionName(['a']).ok).toBe(false)
})

test('session_name 超過上限時拒收，不截斷', () => {
  expect(parseSessionName('a'.repeat(MAX_SESSION_NAME_LENGTH + 1)).ok).toBe(false)
})

test.each([undefined, '', '0', 'false', 'yes'])('開關值 %p 視同未設，系統訊息不加第一行', value => {
  expect(resolveFirstLineFormat({ TELEGRAM_FIRST_LINE_FORMAT: value })).toBe(false)
  expect(createSystemTextFormatter(false)('目前容量已滿，請稍後再試。')).toBe('目前容量已滿，請稍後再試。')
})

test.each(['1', 'true', ' TRUE '])('開關值 %p 開啟', value => {
  expect(resolveFirstLineFormat({ TELEGRAM_FIRST_LINE_FORMAT: value })).toBe(true)
})

test('開關開啟時系統訊息第一行為 [系統] tg-hub:，多行內容從第二行起照舊', () => {
  expect(createSystemTextFormatter(true)('回來了，agent 重啟完成。\nplugin 版本：')).toBe(
    '[系統] tg-hub: 回來了，agent 重啟完成。\nplugin 版本：',
  )
})

test('權限 relay 第一行：開關開啟為 [等核准] tg-hub: 權限確認 <tool>，關閉維持舊版', () => {
  expect(createPermissionHeadline(true)('Bash')).toBe('[等核准] tg-hub: 權限確認 Bash')
  expect(createPermissionHeadline(false)('Bash')).toBe('🔐 Permission: Bash')
})

test('session name 顯示時半形 : [ ] 換成全形，第一行只剩格式本身的 "] " 與 ": "', () => {
  expect(displaySessionName('x] y: git status')).toBe('x］ y： git status')
  expect(displaySessionName('a:b')).toBe('a：b')
  const line = formatFirstLine(FIRST_LINE_STATUS.blocked, 'x] y: git status', 'rm -rf build')
  expect(line).toBe('[已被擋下] x］ y： git status: rm -rf build')
  expect(line.split('] ').length - 1).toBe(1)
  expect(line.split(': ').length - 1).toBe(1)
  expect(formatFirstLine(FIRST_LINE_STATUS.awaitingReply, '[等你] c', 'x')).toBe('[等你回覆] ［等你］ c: x')
})

test('session name 不含 : [ ] 時原樣顯示', () => {
  expect(displaySessionName('OP-8820')).toBe('OP-8820')
})
