import { expect, test } from 'bun:test'
import { createSseParser, encodeSse, type InboundEnvelope } from './subscribe-protocol'

const sample: InboundEnvelope = {
  envelopeId: '11111111-2222-3333-4444-555555555555',
  scopeId: 'telegram-dm-12345',
  platform: 'telegram',
  payload: { update_id: 7, message: { text: 'hi' } },
  ts: 1770000000000,
}

test('encodeSse 產出合法的 SSE frame', () => {
  const frame = encodeSse(sample)
  expect(frame.startsWith('event: message\ndata: ')).toBe(true)
  expect(frame.endsWith('\n\n')).toBe(true)
})

test('parser 還原單一 envelope', () => {
  const got: InboundEnvelope[] = []
  const feed = createSseParser(e => got.push(e))
  feed(encodeSse(sample))
  expect(got).toEqual([sample])
})

test('parser 處理被切碎的 chunk（TCP 不保證邊界）', () => {
  const got: InboundEnvelope[] = []
  const feed = createSseParser(e => got.push(e))
  const frame = encodeSse(sample)
  feed(frame.slice(0, 13))
  feed(frame.slice(13, 40))
  feed(frame.slice(40))
  expect(got).toEqual([sample])
})

test('parser 忽略 keepalive 註解行', () => {
  const got: InboundEnvelope[] = []
  const feed = createSseParser(e => got.push(e))
  feed(': keepalive\n\n')
  feed(encodeSse(sample))
  expect(got).toEqual([sample])
})

test('parser 丟棄壞掉的 data 但不中斷後續', () => {
  const got: InboundEnvelope[] = []
  const feed = createSseParser(e => got.push(e))
  feed('event: message\ndata: {not json\n\n')
  feed(encodeSse(sample))
  expect(got).toEqual([sample])
})

test('encodeSse 對含換行的 payload 仍是單行 data（JSON 逸出）', () => {
  const frame = encodeSse({ ...sample, payload: { text: 'a\nb\n\nc' } })
  const dataLines = frame.split('\n').filter(line => line.startsWith('data: '))
  expect(dataLines.length).toBe(1)

  const got: InboundEnvelope[] = []
  createSseParser(e => got.push(e))(frame)
  expect(got[0].payload).toEqual({ text: 'a\nb\n\nc' })
})
