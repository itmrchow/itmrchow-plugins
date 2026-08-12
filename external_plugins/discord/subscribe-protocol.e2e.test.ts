import { expect, test } from 'bun:test'
import { createServer, request } from 'node:http'
import {
  createSseParser,
  encodeSse,
  SSE_KEEPALIVE,
  type InboundEnvelope,
} from './subscribe-protocol'

const sample: InboundEnvelope = {
  envelopeId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
  scopeId: 'telegram-dm-999',
  platform: 'telegram',
  payload: { update_id: 1 },
  ts: 1,
}

test('SSE over node:http 在本執行環境會即時 flush，不被緩衝', async () => {
  const server = createServer((_req, res) => {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    })
    res.socket?.setNoDelay(true)
    res.write(SSE_KEEPALIVE)
    res.write(encodeSse(sample))
    // Deliberately no end(): SSE is a long-lived stream. If the runtime buffers
    // until end(), this test times out — which is exactly the failure we want
    // surfaced here rather than in production.
  })
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
  const port = (server.address() as { port: number }).port

  const received = await new Promise<InboundEnvelope>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('沒有在 3 秒內收到推送 —— SSE 被緩衝了')),
      3000,
    )
    const req = request(
      { host: '127.0.0.1', port, path: '/subscribe?scope=telegram-dm-999' },
      res => {
        res.setEncoding('utf8')
        const feed = createSseParser(e => {
          clearTimeout(timer)
          resolve(e)
        })
        res.on('data', feed)
      },
    )
    req.on('error', reject)
    req.end()
  })

  expect(received).toEqual(sample)
  server.close()
})
