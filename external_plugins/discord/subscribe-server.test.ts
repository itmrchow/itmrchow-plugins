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

function ack(port: number, body: { envelopeId?: string; scopeId?: string }): Promise<number> {
  const raw = JSON.stringify(body)
  return new Promise<number>((resolve, reject) => {
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
        res.on('end', () => resolve(res.statusCode ?? 0))
      },
    )
    req.on('error', reject)
    req.end(raw)
  })
}

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

  await ack(port, { envelopeId: 'acked', scopeId: 'telegram-dm-4' })

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

test('接管舊連線時，舊連線未 ack 的訊息同步回佇列並補送給新連線（P1-1）', async () => {
  const registry = new ScopeRegistry({ maxScopes: 5, maxQueue: 10 })
  const hub = createSubscribeServer({ registry })
  const port = await listen(hub)

  const first = collect(port, 'telegram-dm-9', 1)
  await new Promise(r => setTimeout(r, 100))
  hub.deliver('telegram-dm-9', [envelope('in-flight', 'telegram-dm-9')])
  expect((await first.done)[0].envelopeId).toBe('in-flight')

  // 舊連線還開著就被新連線接管（agent 崩潰重生的情境）。舊連線的 close 事件是
  // 非同步的，接管若不同步做，requeue 永遠不會執行，這則訊息就靜默消失。
  const second = collect(port, 'telegram-dm-9', 1)
  expect((await second.done)[0].envelopeId).toBe('in-flight')

  first.stop()
  second.stop()
  hub.close()
  await closeServer(hub.server)
})

test('ack 只清掉自己 scope 的 in-flight，不會誤刪別的 scope（P2-1）', async () => {
  const registry = new ScopeRegistry({ maxScopes: 5, maxQueue: 10 })
  const hub = createSubscribeServer({ registry })
  const port = await listen(hub)

  const a = collect(port, 'telegram-dm-a', 1)
  const b = collect(port, 'telegram-dm-b', 1)
  await new Promise(r => setTimeout(r, 100))
  hub.deliver('telegram-dm-a', [envelope('shared-id', 'telegram-dm-a')])
  hub.deliver('telegram-dm-b', [envelope('shared-id', 'telegram-dm-b')])
  await a.done
  await b.done

  // 只有 A 送出 ack
  const status = await ack(port, { envelopeId: 'shared-id', scopeId: 'telegram-dm-a' })
  expect(status).toBe(200)

  a.stop()
  b.stop()
  await new Promise(r => setTimeout(r, 100))
  // B 沒 ack 過，斷線後那則必須還在佇列裡
  expect(registry.onSubscribed('telegram-dm-b').map(e => e.envelopeId)).toEqual(['shared-id'])
  expect(registry.onSubscribed('telegram-dm-a')).toEqual([])

  hub.close()
  await closeServer(hub.server)
})

test('ack 缺 scopeId 一律 400，不做任何刪除', async () => {
  const registry = new ScopeRegistry({ maxScopes: 5, maxQueue: 10 })
  const hub = createSubscribeServer({ registry })
  const port = await listen(hub)

  const sub = collect(port, 'telegram-dm-c', 1)
  await new Promise(r => setTimeout(r, 100))
  hub.deliver('telegram-dm-c', [envelope('kept', 'telegram-dm-c')])
  await sub.done

  expect(await ack(port, { envelopeId: 'kept' })).toBe(400)

  sub.stop()
  await new Promise(r => setTimeout(r, 100))
  expect(registry.onSubscribed('telegram-dm-c').map(e => e.envelopeId)).toEqual(['kept'])

  hub.close()
  await closeServer(hub.server)
})

test('deliver 對沒有連線的 scope 回 false，讓呼叫端改走佇列', () => {
  const registry = new ScopeRegistry({ maxScopes: 5, maxQueue: 10 })
  const hub = createSubscribeServer({ registry })
  expect(hub.deliver('telegram-dm-nobody', [envelope('x')])).toBe(false)
  hub.close()
})

function subscribeStatus(port: number, scope: string): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path: `/subscribe?scope=${scope}` }, res => {
      resolve(res.statusCode ?? 0)
      req.destroy()
    })
    req.on('error', err => {
      // destroy() after the status arrived surfaces as a socket hang-up; ignore it.
      if ((err as NodeJS.ErrnoException).code !== 'ECONNRESET') reject(err)
    })
    req.end()
  })
}

test('authorize 回 false：503、不建 registry 項目（JP-380）', async () => {
  const registry = new ScopeRegistry({ maxScopes: 5, maxQueue: 10 })
  const asked: string[] = []
  const hub = createSubscribeServer({
    registry,
    authorize: scopeId => {
      asked.push(scopeId)
      return false
    },
  })
  const port = await listen(hub)

  expect(await subscribeStatus(port, 'telegram-dm-9')).toBe(503)
  expect(asked).toEqual(['telegram-dm-9'])
  expect(registry.state('telegram-dm-9')).toBeUndefined()
  expect(hub.deliver('telegram-dm-9', [envelope('x', 'telegram-dm-9')])).toBe(false)

  hub.close()
  await closeServer(hub.server)
})

test('authorize 拒絕不會踢掉同 scope 已在線的連線（JP-380）', async () => {
  const registry = new ScopeRegistry({ maxScopes: 5, maxQueue: 10 })
  let allow = true
  const hub = createSubscribeServer({ registry, authorize: () => allow })
  const port = await listen(hub)

  const live = collect(port, 'telegram-dm-7', 1)
  await new Promise(r => setTimeout(r, 100))
  allow = false
  expect(await subscribeStatus(port, 'telegram-dm-7')).toBe(503)
  expect(registry.state('telegram-dm-7')).toBe('connected')
  expect(hub.deliver('telegram-dm-7', [envelope('still', 'telegram-dm-7')])).toBe(true)
  expect((await live.done).map(e => e.envelopeId)).toEqual(['still'])

  live.stop()
  hub.close()
  await closeServer(hub.server)
})

test('authorize 回 true 時照常訂閱', async () => {
  const registry = new ScopeRegistry({ maxScopes: 5, maxQueue: 10 })
  registry.admit('telegram-dm-8', envelope('q', 'telegram-dm-8'))
  const hub = createSubscribeServer({ registry, authorize: () => true })
  const port = await listen(hub)
  const sub = collect(port, 'telegram-dm-8', 1)
  expect((await sub.done).map(e => e.envelopeId)).toEqual(['q'])
  sub.stop()
  hub.close()
  await closeServer(hub.server)
})
