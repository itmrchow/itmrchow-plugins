import { describe, expect, test } from 'bun:test'
import { createBodyCollector, MAX_BODY_BYTES } from './body'

/** Split a buffer at an arbitrary byte offset, the way TCP is free to. */
function splitAt(buf: Buffer, offset: number): Buffer[] {
  return [buf.subarray(0, offset), buf.subarray(offset)]
}

describe('createBodyCollector', () => {
  test('a multi-byte character split across a chunk boundary survives intact', () => {
    // The bug this module exists for: decoding each chunk on its own turns the two
    // halves of one character into two U+FFFD. Chinese alert text is 3 bytes per
    // character, so a chunk boundary lands mid-character routinely.
    const text = '線路異常，請立即處理'
    const buf = Buffer.from(text, 'utf8')

    // Cut one byte into the first character — the worst case, not a lucky one.
    const collector = createBodyCollector()
    for (const chunk of splitAt(buf, 1)) collector.push(chunk)

    expect(collector.decode()).toBe(text)
    expect(collector.decode()).not.toContain('�')
  })

  test.each([
    ['3-byte characters (Chinese)', '線路異常，請立即處理。CDN 回源 5xx'],
    // Emoji are 4 bytes in UTF-8 AND a surrogate pair in JS (one emoji is
    // .length === 2), so they split differently from Chinese in both encodings.
    // Alert text carries them routinely — untested is unlocked.
    ['4-byte characters (emoji, a surrogate pair in JS)', '🚨 線路異常 🔥 回源 5xx 🚨'],
  ])('every possible split point of a body with %s decodes intact', (_name, text) => {
    const buf = Buffer.from(text, 'utf8')

    for (let cut = 1; cut < buf.length; cut++) {
      const collector = createBodyCollector()
      for (const chunk of splitAt(buf, cut)) collector.push(chunk)
      expect(collector.decode()).toBe(text)
    }
  })

  test('a 4-byte character split in the middle survives — a surrogate pair is not two characters', () => {
    const emoji = '🚨'
    const buf = Buffer.from(emoji, 'utf8')
    expect(buf.length).toBe(4) // 4 bytes...
    expect(emoji.length).toBe(2) // ...but 2 UTF-16 code units

    for (let cut = 1; cut < 4; cut++) {
      const collector = createBodyCollector()
      for (const chunk of splitAt(buf, cut)) collector.push(chunk)
      expect(collector.decode()).toBe(emoji)
    }
  })

  test('the naive per-chunk decode really does corrupt — the bug is not hypothetical', () => {
    // Pins WHY this module exists. If this ever stops corrupting, the collector has
    // stopped earning its keep.
    const buf = Buffer.from('線', 'utf8')
    const naive = splitAt(buf, 1).reduce((acc, chunk) => acc + chunk, '')
    expect(naive).toContain('�')
  })

  test('the cap counts bytes, not UTF-16 code units', () => {
    // '線' is 3 bytes but ONE code unit; a cap read off a decoded string's .length
    // would admit ~3x the intended payload. Under a 10-byte cap, four '線' (12
    // bytes) must be refused — a UTF-16 count would see 4 and let them through.
    const collector = createBodyCollector(10)
    expect(collector.push(Buffer.from('線線線', 'utf8'))).toBe(true) // 9 bytes
    expect(collector.push(Buffer.from('線', 'utf8'))).toBe(false) // would be 12 > 10
    expect(collector.decode()).toBe('線線線') // the refused chunk is not kept
  })

  test('the cap counts emoji as their 4 bytes, not their 2 code units', () => {
    const collector = createBodyCollector(6)
    expect(collector.push(Buffer.from('🚨', 'utf8'))).toBe(true) // 4 bytes, 2 code units
    expect(collector.push(Buffer.from('🔥', 'utf8'))).toBe(false) // would be 8 > 6
  })

  test('push reports the overflow instead of throwing, so the caller can answer 413', () => {
    const collector = createBodyCollector(MAX_BODY_BYTES)
    expect(collector.push(Buffer.alloc(MAX_BODY_BYTES))).toBe(true)
    expect(collector.push(Buffer.from('x'))).toBe(false)
  })

  test('an over-cap chunk is not accumulated', () => {
    const collector = createBodyCollector(4)
    collector.push(Buffer.from('ab'))
    collector.push(Buffer.from('cdef'))
    expect(collector.decode()).toBe('ab')
  })

  test('a chunk landing exactly on the cap is accepted', () => {
    const collector = createBodyCollector(4)
    expect(collector.push(Buffer.from('abcd'))).toBe(true)
    expect(collector.push(Buffer.from('e'))).toBe(false)
  })

  test('an empty body decodes to an empty string', () => {
    expect(createBodyCollector().decode()).toBe('')
  })
})
