import { expect, test } from 'bun:test'
import { buildScopeId, isValidScopeId, normalizeScopeSegment } from './scope-id'

test('normalizeScopeSegment 把前導負號換成 n', () => {
  expect(normalizeScopeSegment(-1001234567890)).toBe('n1001234567890')
})

test('normalizeScopeSegment 保留正數原樣', () => {
  expect(normalizeScopeSegment(830680811401379870n.toString())).toBe('830680811401379870')
})

test('buildScopeId 組出語意化 id', () => {
  expect(buildScopeId('discord', 'dm', '830680811401379870')).toBe('discord-dm-830680811401379870')
  expect(buildScopeId('telegram', 'group', -1001234567890)).toBe('telegram-group-n1001234567890')
})

test('buildScopeId 對含非法字元的 id 直接拋錯，不做修補', () => {
  expect(() => buildScopeId('telegram', 'dm', '12; rm -rf /')).toThrow()
  expect(() => buildScopeId('telegram', 'dm', '')).toThrow()
})

test('isValidScopeId 擋掉 tmux / 路徑的元字元', () => {
  expect(isValidScopeId('telegram-dm-123')).toBe(true)
  expect(isValidScopeId('telegram-dm-123:0')).toBe(false)
  expect(isValidScopeId('telegram-dm-../etc')).toBe(false)
  expect(isValidScopeId('-telegram-dm-123')).toBe(false)
  expect(isValidScopeId('telegram-other-123')).toBe(false)
})
