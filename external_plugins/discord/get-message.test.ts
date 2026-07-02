import { describe, expect, test } from 'bun:test'
import { formatMessageDetail, formatMessageUnavailable } from './get-message'

describe('formatMessageDetail', () => {
  test('renders author, timestamp, and content for a plain message', () => {
    const out = formatMessageDetail({
      author: 'alice',
      timestamp: '2026-07-02T10:00:00.000Z',
      content: 'deploy is done',
      attachments: [],
    })
    expect(out).toBe(
      ['author: alice', 'timestamp: 2026-07-02T10:00:00.000Z', 'content: deploy is done'].join('\n'),
    )
  })

  test('marks the bot\'s own message with author "me"', () => {
    const out = formatMessageDetail({
      author: 'me',
      timestamp: '2026-07-02T10:00:00.000Z',
      content: 'ack',
      attachments: [],
    })
    expect(out.startsWith('author: me\n')).toBe(true)
  })

  test('preserves multi-line content verbatim (single-message fetch)', () => {
    const out = formatMessageDetail({
      author: 'alice',
      timestamp: '2026-07-02T10:00:00.000Z',
      content: 'line one\nline two',
      attachments: [],
    })
    expect(out).toContain('content: line one\nline two')
  })

  test('shows a placeholder for empty (attachment-only) content', () => {
    const out = formatMessageDetail({
      author: 'alice',
      timestamp: '2026-07-02T10:00:00.000Z',
      content: '',
      attachments: [{ name: 'chart.png', contentType: 'image/png', sizeBytes: 2048 }],
    })
    expect(out).toContain('content: (no text content)')
  })

  test('lists attachments with name, type, and KB size', () => {
    const out = formatMessageDetail({
      author: 'alice',
      timestamp: '2026-07-02T10:00:00.000Z',
      content: 'see files',
      attachments: [
        { name: 'chart.png', contentType: 'image/png', sizeBytes: 2048 },
        { name: 'log.txt', contentType: 'text/plain', sizeBytes: 512 },
      ],
    })
    expect(out).toContain('attachments (2):')
    expect(out).toContain('  - chart.png (image/png, 2KB)')
    expect(out).toContain('  - log.txt (text/plain, 1KB)')
  })
})

describe('formatMessageUnavailable', () => {
  test('renders a clear, non-crashing explanation with the id and reason', () => {
    expect(formatMessageUnavailable('12345', 'Unknown Message')).toBe(
      'message 12345 is unavailable (deleted, not found, or unreadable): Unknown Message',
    )
  })
})
