import { expect, test } from 'bun:test'
import { toInboundMessage, type SourceMessage } from './inbound-message'

function sourceMessage(overrides: Partial<SourceMessage> = {}): SourceMessage {
  return {
    id: '1',
    channelId: '2',
    content: 'hello',
    createdAt: new Date('2026-08-10T01:02:03.000Z'),
    author: { id: '3', username: 'jeff' },
    attachments: { values: () => [] },
    mentions: { users: { values: () => [] }, everyone: false, repliedUser: null },
    reference: null,
    ...overrides,
  }
}

test('把 message 化約成 wire shape', () => {
  expect(toInboundMessage(sourceMessage(), { isDm: true, parentId: undefined })).toEqual({
    id: '1',
    channelId: '2',
    isDm: true,
    parentId: null,
    content: 'hello',
    timestamp: '2026-08-10T01:02:03.000Z',
    author: { id: '3', username: 'jeff' },
    attachments: [],
    mentionIds: [],
    mentionsEveryone: false,
    replyToMessageId: null,
    replyToUser: null,
  })
})

// The whole point of the module: discord.js says `name` / `contentType`, the raw
// API says `filename` / `content_type`. Reading the wrong one returns undefined
// instead of throwing, so the mapping is pinned here rather than trusted.
test('附件保留 name / contentType，缺 contentType 記成 null 而不是消失', () => {
  const msg = sourceMessage({
    attachments: {
      values: () => [
        { id: '9', name: 'a.png', size: 12, url: 'https://cdn/a.png', contentType: 'image/png' },
        { id: '10', name: null, size: 3, url: 'https://cdn/b', contentType: null },
      ],
    },
  })
  expect(toInboundMessage(msg, { isDm: false, parentId: null }).attachments).toEqual([
    { id: '9', name: 'a.png', size: 12, url: 'https://cdn/a.png', contentType: 'image/png' },
    // No name from the uploader — fall back to the id so the file still lands
    // somewhere addressable instead of being written as "undefined".
    { id: '10', name: '10', size: 3, url: 'https://cdn/b', contentType: null },
  ])
})

test('thread 帶 parentId，mention 與 quote-reply 都上線', () => {
  const msg = sourceMessage({
    mentions: {
      users: { values: () => [{ id: 'bot' }, { id: 'other' }] },
      everyone: true,
      repliedUser: { id: 'bot', username: 'claude' },
    },
    reference: { messageId: '77' },
  })
  const out = toInboundMessage(msg, { isDm: false, parentId: 'parent-1' })
  expect(out.parentId).toBe('parent-1')
  expect(out.mentionIds).toEqual(['bot', 'other'])
  expect(out.mentionsEveryone).toBe(true)
  expect(out.replyToMessageId).toBe('77')
  expect(out.replyToUser).toEqual({ id: 'bot', username: 'claude' })
})
