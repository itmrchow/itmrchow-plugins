import { describe, expect, test } from 'bun:test'
import { formatReplyPreview, REPLY_PREVIEW_MAX_CHARS } from './reply-preview'

describe('formatReplyPreview', () => {
  test('passes short single-line content through unchanged', () => {
    expect(formatReplyPreview('deploy is done')).toBe('deploy is done')
  })

  test('returns empty string for empty content', () => {
    expect(formatReplyPreview('')).toBe('')
  })

  test('returns empty string for whitespace-only content', () => {
    expect(formatReplyPreview('  \n\n  ')).toBe('')
  })

  test('flattens newlines (LF and CRLF) to single spaces', () => {
    expect(formatReplyPreview('line one\nline two\r\nline three')).toBe(
      'line one line two line three',
    )
  })

  test('collapses whitespace around newlines into one space', () => {
    expect(formatReplyPreview('a   \n\n   b')).toBe('a b')
  })

  test('trims leading and trailing whitespace', () => {
    expect(formatReplyPreview('\n  hello  \n')).toBe('hello')
  })

  test('keeps content at exactly the limit without an ellipsis', () => {
    const exact = 'x'.repeat(REPLY_PREVIEW_MAX_CHARS)
    expect(formatReplyPreview(exact)).toBe(exact)
  })

  test('truncates over-limit content and appends an ellipsis', () => {
    const long = 'x'.repeat(REPLY_PREVIEW_MAX_CHARS + 50)
    const out = formatReplyPreview(long)
    expect(out).toBe(`${'x'.repeat(REPLY_PREVIEW_MAX_CHARS)}…`)
    expect(out.length).toBe(REPLY_PREVIEW_MAX_CHARS + 1)
  })

  test('truncates against the flattened form, not the raw form', () => {
    // Raw is over the limit only because of newline runs; flattened fits.
    const chunk = 'y'.repeat(50)
    const raw = `${chunk}\n\n\n${chunk}` // flattened: 101 chars
    expect(formatReplyPreview(raw)).toBe(`${chunk} ${chunk}`)
  })
})
