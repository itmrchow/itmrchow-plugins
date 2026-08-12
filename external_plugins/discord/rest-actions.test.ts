import { expect, test } from 'bun:test'
import {
  addReaction,
  createDmChannel,
  editMessage,
  encodeReactionEmoji,
  fetchChannel,
  fetchMessage,
  fetchMessages,
  INTERACTION_CALLBACK_UPDATE_MESSAGE,
  respondInteraction,
  sendMessage,
  triggerTyping,
  type RestLike,
  type RestOptions,
  type RestRoute,
} from './rest-actions'

type Call = { method: string; route: string; options?: RestOptions }

function fakeRest(result: unknown = {}): RestLike & { calls: Call[] } {
  const calls: Call[] = []
  const record =
    (method: string) =>
    async (route: RestRoute, options?: RestOptions): Promise<unknown> => {
      calls.push({ method, route, options })
      return result
    }
  return {
    calls,
    get: record('GET'),
    post: record('POST'),
    patch: record('PATCH'),
    put: record('PUT'),
  }
}

test('sendMessage 打對 route，body 原樣送出', async () => {
  const rest = fakeRest({ id: '77' })
  const sent = await sendMessage(rest, '123', { content: 'hi' })
  expect(rest.calls[0]).toEqual({
    method: 'POST',
    route: '/channels/123/messages',
    options: { body: { content: 'hi' } },
  })
  expect(sent.id).toBe('77')
})

test('sendMessage 帶檔案時走 multipart，files 進 options', async () => {
  const rest = fakeRest({ id: '78' })
  const files = [{ name: 'a.png', data: Buffer.from('x') }]
  await sendMessage(rest, '123', { content: 'hi' }, files)
  expect(rest.calls[0].options?.files).toBe(files)
})

test('addReaction 對 unicode emoji 做 URL 編碼（不編碼會 400）', async () => {
  const rest = fakeRest()
  await addReaction(rest, '123', '456', '👀')
  expect(rest.calls[0]).toEqual({
    method: 'PUT',
    route: `/channels/123/messages/456/reactions/${encodeURIComponent('👀')}/@me`,
    options: undefined,
  })
})

test('custom emoji 的 <:name:id> 外框要脫掉，REST 只吃 name:id', () => {
  expect(encodeReactionEmoji('<:party:1234>')).toBe('party%3A1234')
  expect(encodeReactionEmoji('<a:spin:99>')).toBe('spin%3A99')
  expect(encodeReactionEmoji('👀')).toBe(encodeURIComponent('👀'))
})

test('editMessage 打 PATCH', async () => {
  const rest = fakeRest({ id: '456' })
  const edited = await editMessage(rest, '123', '456', { content: 'new' })
  expect(rest.calls[0]).toEqual({
    method: 'PATCH',
    route: '/channels/123/messages/456',
    options: { body: { content: 'new' } },
  })
  expect(edited.id).toBe('456')
})

test('fetchMessage / fetchChannel 打 GET', async () => {
  const rest = fakeRest({ id: '456' })
  await fetchMessage(rest, '123', '456')
  await fetchChannel(rest, '123')
  expect(rest.calls.map(c => `${c.method} ${c.route}`)).toEqual([
    'GET /channels/123/messages/456',
    'GET /channels/123',
  ])
})

test('fetchMessages 把 limit 放進 query', async () => {
  const rest = fakeRest([])
  await fetchMessages(rest, '123', 50)
  expect(rest.calls[0].route).toBe('/channels/123/messages?limit=50')
})

test('triggerTyping 打 POST /typing', async () => {
  const rest = fakeRest()
  await triggerTyping(rest, '123')
  expect(rest.calls[0].route).toBe('/channels/123/typing')
})

test('createDmChannel 用 recipient_id 開 DM', async () => {
  const rest = fakeRest({ id: 'dm1' })
  const ch = await createDmChannel(rest, '555')
  expect(rest.calls[0]).toEqual({
    method: 'POST',
    route: '/users/@me/channels',
    options: { body: { recipient_id: '555' } },
  })
  expect(ch.id).toBe('dm1')
})

test('respondInteraction 打 callback route，token 走 URL 編碼', async () => {
  const rest = fakeRest()
  await respondInteraction(rest, '9', 'tok/en', {
    type: INTERACTION_CALLBACK_UPDATE_MESSAGE,
    data: { content: 'done', components: [] },
  })
  expect(rest.calls[0]).toEqual({
    method: 'POST',
    route: `/interactions/9/${encodeURIComponent('tok/en')}/callback`,
    options: { body: { type: 7, data: { content: 'done', components: [] } } },
  })
})
