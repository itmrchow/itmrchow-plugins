import { expect, test } from 'bun:test'
import { request, type Server } from 'node:http'
import { ScopeRegistry } from './poller-registry'
import { createSubscribeServer, type SubscribeHub } from './subscribe-server'
import { createSseParser, type InboundEnvelope } from './subscribe-protocol'

const envelope = (id: string, scopeId = 'telegram-dm-1'): InboundEnvelope => ({
  envelopeId: id,
  scopeId,
  platform: 'telegram',
  payload: { n: id },
  ts: 1,
})

async function listen(hub: SubscribeHub): Promise<number> {
  await new Promise<void>(r => hub.server.listen(0, '127.0.0.1', r))
  return (hub.server.address() as { port: number }).port
}

function collect(
  port: number,
  scope: string,
  want: number,
): { done: Promise<InboundEnvelope[]>; stop: () => void } {
  let stop = (): void => {}
  const done = new Promise<InboundEnvelope[]>((resolve, reject) => {
    const out: InboundEnvelope[] = []
    const timer = setTimeout(() => reject(new Error('補送逾時')), 3000)
    const req = request(
      { host: '127.0.0.1', port, path: `/subscribe?scope=${scope}` },
      res => {
        res.setEncoding('utf8')
        const feed = createSseParser(e => {
          out.push(e)
          if (out.length === want) {
            clearTimeout(timer)
            resolve(out)
          }
        })
        res.on('data', feed)
      },
    )
    req.on('error', reject)
    req.end()
    stop = () => {
      clearTimeout(timer)
      req.destroy()
    }
  })
  return { done, stop }
}

const closeServer = (server: Server): Promise<void> =>
  new Promise(r => server.close(() => r()))

test('訂閱端連上後，registry 內排隊的訊息會依序補送', async () => {
  const registry = new ScopeRegistry({ maxScopes: 5, maxQueue: 10 })
  registry.admit('telegram-dm-1', envelope('e1'))
  registry.admit('telegram-dm-1', envelope('e2'))

  const hub = createSubscribeServer({ registry })
  const port = await listen(hub)
  const sub = collect(port, 'telegram-dm-1', 2)
  const got = await sub.done

  expect(got.map(e => e.envelopeId)).toEqual(['e1', 'e2'])
  sub.stop()
  hub.close()
  await closeServer(hub.server)
})

test('scope 參數不合法時拒絕訂閱（400），不建立連線', async () => {
  const registry = new ScopeRegistry({ maxScopes: 5, maxQueue: 10 })
  const hub = createSubscribeServer({ registry })
  const port = await listen(hub)

  const status = await new Promise<number>((resolve, reject) => {
    const req = request(
      { host: '127.0.0.1', port, path: '/subscribe?scope=../etc/passwd' },
      res => {
        res.resume()
        resolve(res.statusCode ?? 0)
      },
    )
    req.on('error', reject)
    req.end()
  })

  expect(status).toBe(400)
  expect(registry.state('../etc/passwd')).toBeUndefined()
  hub.close()
  await closeServer(hub.server)
})

test('同一個 scope 重複訂閱時踢掉舊連線、保留新的', async () => {
  const registry = new ScopeRegistry({ maxScopes: 5, maxQueue: 10 })
  const hub = createSubscribeServer({ registry })
  const port = await listen(hub)

  const firstClosed = new Promise<void>(resolve => {
    const req = request(
      { host: '127.0.0.1', port, path: '/subscribe?scope=telegram-dm-2' },
      res => {
        res.resume()
        res.on('end', () => resolve())
        res.on('close', () => resolve())
      },
    )
    req.end()
  })
  await new Promise(r => setTimeout(r, 100))
  const second = collect(port, 'telegram-dm-2', 1)

  await firstClosed
  // 舊連線被踢掉不該讓 registry 認為這個 scope 斷線了 —— 新連線才是現任
  expect(registry.state('telegram-dm-2')).toBe('connected')
  expect(hub.deliver('telegram-dm-2', [envelope('after-takeover', 'telegram-dm-2')])).toBe(true)
  expect((await second.done)[0].envelopeId).toBe('after-takeover')

  second.stop()
  hub.close()
  await closeServer(hub.server)
})

test('連線斷掉時未 ack 的訊息回到佇列，重連後補送', async () => {
  const registry = new ScopeRegistry({ maxScopes: 5, maxQueue: 10 })
  const hub = createSubscribeServer({ registry })
  const port = await listen(hub)

  const first = collect(port, 'telegram-dm-3', 1)
  await new Promise(r => setTimeout(r, 100))
  hub.deliver('telegram-dm-3', [envelope('unacked', 'telegram-dm-3')])
  expect((await first.done)[0].envelopeId).toBe('unacked')
  first.stop()
  await new Promise(r => setTimeout(r, 100))

  const second = collect(port, 'telegram-dm-3', 1)
  expect((await second.done)[0].envelopeId).toBe('unacked')

  second.stop()
  hub.close()
  await closeServer(hub.server)
})

test('已 ack 的訊息不會在重連後重送', async () => {
  const registry = new ScopeRegistry({ maxScopes: 5, maxQueue: 10 })
  const hub = createSubscribeServer({ registry })
  const port = await listen(hub)

  const first = collect(port, 'telegram-dm-4', 1)
  await new Promise(r => setTimeout(r, 100))
  hub.deliver('telegram-dm-4', [envelope('acked', 'telegram-dm-4')])
  await first.done

  const ackBody = JSON.stringify({ envelopeId: 'acked' })
  await new Promise<void>((resolve, reject) => {
    const req = request(
      {
        host: '127.0.0.1',
        port,
        path: '/ack',
        method: 'POST',
        headers: { 'content-type': 'application/json' },
      },
      res => {
        res.resume()
        res.on('end', () => resolve())
      },
    )
    req.on('error', reject)
    req.end(ackBody)
  })

  first.stop()
  await new Promise(r => setTimeout(r, 100))
  registry.admit('telegram-dm-4', envelope('fresh', 'telegram-dm-4'))
  const second = collect(port, 'telegram-dm-4', 1)
  // 補送的第一則是 fresh 而不是 acked，代表 acked 已從 in-flight 移除
  expect((await second.done)[0].envelopeId).toBe('fresh')

  second.stop()
  hub.close()
  await closeServer(hub.server)
})

test('deliver 對沒有連線的 scope 回 false，讓呼叫端改走佇列', () => {
  const registry = new ScopeRegistry({ maxScopes: 5, maxQueue: 10 })
  const hub = createSubscribeServer({ registry })
  expect(hub.deliver('telegram-dm-nobody', [envelope('x')])).toBe(false)
  hub.close()
})
