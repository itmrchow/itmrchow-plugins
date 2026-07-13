import { afterEach, describe, expect, test } from 'bun:test'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'
import {
  BIND_ADDR,
  parseInjectBody,
  startInjectServer,
  type ChannelDelivery,
} from './inject-core'

describe('parseInjectBody', () => {
  test('parses a valid body into a scheduler channel delivery', () => {
    const r = parseInjectBody('{"text":"hi","chat_id":"123"}')
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.delivery.content).toBe('hi')
    expect(r.delivery.meta.chat_id).toBe('123')
    expect(r.delivery.meta.user).toBe('scheduler')
    expect(r.delivery.meta.user_id).toBe('scheduler')
    expect(typeof r.delivery.meta.ts).toBe('string')
  })

  test('rejects invalid JSON with 400', () => {
    expect(parseInjectBody('not-json')).toEqual({ ok: false, status: 400, message: 'invalid json' })
  })

  test('rejects a missing chat_id with 400', () => {
    expect(parseInjectBody('{"text":"hi"}')).toEqual({ ok: false, status: 400, message: 'missing text or chat_id' })
  })

  test('rejects a missing text with 400', () => {
    expect(parseInjectBody('{"chat_id":"123"}')).toEqual({ ok: false, status: 400, message: 'missing text or chat_id' })
  })

  test('rejects an empty text with 400', () => {
    expect(parseInjectBody('{"text":"","chat_id":"123"}')).toEqual({ ok: false, status: 400, message: 'missing text or chat_id' })
  })

  test('rejects a non-string chat_id with 400', () => {
    expect(parseInjectBody('{"text":"hi","chat_id":123}')).toEqual({ ok: false, status: 400, message: 'missing text or chat_id' })
  })
})

describe('startInjectServer', () => {
  let server: Server | null = null
  const submitted: ChannelDelivery[] = []

  /** Boot the core on an ephemeral port with a recording gate; returns its base URL. */
  function boot(extraRoutes?: Parameters<typeof startInjectServer>[0]['extraRoutes']): string {
    submitted.length = 0
    server = startInjectServer({
      channelName: 'test',
      port: 0,
      gate: { submit: d => { submitted.push(d) } },
      extraRoutes,
    })
    const { port } = server.address() as AddressInfo
    return `http://${BIND_ADDR}:${port}`
  }

  afterEach(() => {
    server?.close()
    server = null
  })

  test('POST /inject submits the delivery to the gate and answers 200 ok', async () => {
    const base = boot()
    const res = await fetch(`${base}/inject`, {
      method: 'POST',
      body: '{"text":"report ready","chat_id":"555"}',
    })
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('ok')
    expect(submitted).toHaveLength(1)
    expect(submitted[0].content).toBe('report ready')
    expect(submitted[0].meta).toMatchObject({ chat_id: '555', user: 'scheduler', user_id: 'scheduler' })
  })

  test('POST /inject with a bad body answers 400 and submits nothing', async () => {
    const base = boot()
    const res = await fetch(`${base}/inject`, { method: 'POST', body: '{"text":"hi"}' })
    expect(res.status).toBe(400)
    expect(await res.text()).toBe('missing text or chat_id')
    expect(submitted).toHaveLength(0)
  })

  test('GET /inject is a 404 — POST only', async () => {
    const base = boot()
    const res = await fetch(`${base}/inject`)
    expect(res.status).toBe(404)
    expect(submitted).toHaveLength(0)
  })

  test('an unknown path is a 404', async () => {
    const base = boot()
    const res = await fetch(`${base}/nope`, { method: 'POST', body: '{}' })
    expect(res.status).toBe(404)
  })

  test('an extra route receives the raw body and owns the response', async () => {
    const seen: string[] = []
    const base = boot({
      '/update': (raw, res) => {
        seen.push(raw)
        res.writeHead(200)
        res.end('ok')
      },
    })
    const res = await fetch(`${base}/update`, { method: 'POST', body: '{"update":{"message":1}}' })
    expect(res.status).toBe(200)
    expect(seen).toEqual(['{"update":{"message":1}}'])
    // Extra routes bypass the gate entirely — they are not scheduler injections.
    expect(submitted).toHaveLength(0)
  })

  test('an unregistered extra route stays a 404', async () => {
    const base = boot({ '/update': (_raw, res) => { res.writeHead(200); res.end('ok') } })
    const res = await fetch(`${base}/other`, { method: 'POST', body: '{}' })
    expect(res.status).toBe(404)
  })
})
