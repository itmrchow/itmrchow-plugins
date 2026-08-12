import { expect, test } from 'bun:test'
import { resolveScopeAnchor } from './scope-anchor'

test('DM 的錨點是發話者，不是頻道', () => {
  expect(resolveScopeAnchor({ isDm: true, channelId: '999', parentId: undefined, authorId: '555' }))
    .toEqual({ kind: 'dm', anchorId: '555' })
})

test('一般 guild 頻道的錨點是頻道自己', () => {
  expect(resolveScopeAnchor({ isDm: false, channelId: '111', parentId: undefined, authorId: '555' }))
    .toEqual({ kind: 'group', anchorId: '111' })
})

test('thread 的錨點是父頻道，不另開一個 scope', () => {
  expect(resolveScopeAnchor({ isDm: false, channelId: '222', parentId: '111', authorId: '555' }))
    .toEqual({ kind: 'group', anchorId: '111' })
})

test('parentId 為 null 的 thread 退回頻道自己，不會產出無效錨點', () => {
  expect(resolveScopeAnchor({ isDm: false, channelId: '222', parentId: null, authorId: '555' }))
    .toEqual({ kind: 'group', anchorId: '222' })
})
