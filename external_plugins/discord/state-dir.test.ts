import { expect, test } from 'bun:test'
import { resolveStateDir } from './state-dir'

test('有設就用設的值', () => {
  expect(resolveStateDir({ DISCORD_STATE_DIR: '/tmp/dc-test' })).toBe('/tmp/dc-test')
})

test('沒設就回 undefined，不退回 $HOME 預設路徑（fail-closed）', () => {
  // HOME 有值也不能被拿來組預設路徑 —— 正式 token 就住在那條路徑底下
  expect(resolveStateDir({ HOME: '/home/agent' })).toBeUndefined()
})

test('空字串 / 只有空白視同沒設', () => {
  expect(resolveStateDir({ DISCORD_STATE_DIR: '' })).toBeUndefined()
  expect(resolveStateDir({ DISCORD_STATE_DIR: '   ' })).toBeUndefined()
})
