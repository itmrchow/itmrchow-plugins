import { describe, expect, test } from 'bun:test'
import { parseInjectBody } from './inject'

const SERVICE = 'stock-monitor'

function body(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({ text: 'hello', chat_id: '123', reply_via: 'telegram', ...overrides })
}

describe('parseInjectBody', () => {
  test('accepts a well-formed body and stamps the service identity into meta', () => {
    const parsed = parseInjectBody(body(), SERVICE)
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return

    expect(parsed.delivery.content).toBe('hello')
    expect(parsed.delivery.meta.chat_id).toBe('123')
    expect(parsed.delivery.meta.reply_via).toBe('telegram')
    expect(parsed.delivery.meta.user_id).toBe(`service:${SERVICE}`)
    expect(parsed.delivery.meta.user).toBe(`service:${SERVICE}`)
    expect(parsed.delivery.meta.ts).toBeTruthy()
  })

  test('takes the identity from the token, never from the body', () => {
    // A caller claiming to be someone else must not become someone else.
    const parsed = parseInjectBody(body({ service: 'mgmt', user_id: 'service:mgmt' }), SERVICE)
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.delivery.meta.user_id).toBe('service:stock-monitor')
  })

  test('rejects a broken JSON body', () => {
    const parsed = parseInjectBody('{not json', SERVICE)
    expect(parsed).toEqual({ ok: false, status: 400, message: 'invalid json' })
  })

  test.each([
    ['text', { text: undefined }],
    ['chat_id', { chat_id: undefined }],
    ['reply_via', { reply_via: undefined }],
  ])('rejects a body missing %s', (_field, override) => {
    const parsed = parseInjectBody(body(override), SERVICE)
    expect(parsed.ok).toBe(false)
    if (parsed.ok) return
    expect(parsed.status).toBe(400)
    expect(parsed.message).toBe('missing text, chat_id or reply_via')
  })

  test.each([
    ['empty text', { text: '' }],
    ['empty chat_id', { chat_id: '' }],
    ['non-string text', { text: 42 }],
  ])('rejects %s', (_name, override) => {
    const parsed = parseInjectBody(body(override), SERVICE)
    expect(parsed.ok).toBe(false)
  })

  test.each([
    ['angle brackets — meta is rendered as tag attributes', '<script>'],
    ['whitespace', 'chat id'],
    ['a quote', 'chat"id'],
    ['over 64 chars', 'a'.repeat(65)],
  ])('rejects a chat_id with %s', (_name, chatId) => {
    const parsed = parseInjectBody(body({ chat_id: chatId }), SERVICE)
    expect(parsed.ok).toBe(false)
    if (parsed.ok) return
    expect(parsed.message).toBe('invalid chat_id')
  })

  test('accepts the chat_id shapes the IM channels actually use', () => {
    for (const chatId of ['1514661673150058538', '-1001234567890', 'web', 'guild:1234_thread:5678']) {
      expect(parseInjectBody(body({ chat_id: chatId }), SERVICE).ok).toBe(true)
    }
  })

  test('rejects a reply_via outside the whitelist, naming the accepted values', () => {
    const parsed = parseInjectBody(body({ reply_via: 'telgram' }), SERVICE)
    expect(parsed.ok).toBe(false)
    if (parsed.ok) return
    expect(parsed.status).toBe(400)
    expect(parsed.message).toBe('invalid reply_via (expected: telegram, discord)')
  })

  test('accepts every whitelisted reply_via', () => {
    for (const channel of ['telegram', 'discord']) {
      expect(parseInjectBody(body({ reply_via: channel }), SERVICE).ok).toBe(true)
    }
  })
})
