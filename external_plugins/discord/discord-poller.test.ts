/**
 * The discord poller's wiring: routeMessage feeding a real subscription hub over
 * loopback SSE.
 *
 * discord-poller.ts itself cannot be imported — it exits at import time when
 * half-configured and opens a gateway connection when it is not. What is worth
 * pinning is the seam it assembles, exercised here exactly as the poller does:
 * registry + hub + routeMessage, with discord scope-ids.
 */
import { expect, test } from 'bun:test'
import { request, type Server } from 'node:http'
import { ScopeRegistry } from './poller-registry'
import { createSubscribeServer, type SubscribeHub } from './subscribe-server'
import { createSseParser, type InboundEnvelope } from './subscribe-protocol'
import { routeMessage, type DiscordPayload, type RouteContext, type RouteInput } from './route-message'

const SUBSCRIBE_SETTLE_MS = 100

const dmMessage = (text: string, overrides: Partial<RouteInput> = {}): RouteInput => ({
  kind: 'messageCreate',
  isDm: true,
  channelId: '999',
  parentId: undefined,
  authorId: '555',
  data: { content: text },
  ...overrides,
})

function pollerContext(registry: ScopeRegistry, hub: SubscribeHub): RouteContext {
  return {
    registry,
    deliver: hub.deliver,
    spawn: () => Promise.resolve('ok'),
    notify: () => Promise.resolve(),
    setTimer: () => {},
  }
}

async function listen(hub: SubscribeHub): Promise<number> {
  await new Promise<void>(r => hub.server.listen(0, '127.0.0.1', r))
  return (hub.server.address() as { port: number }).port
}

function subscribe(
  port: number,
  scope: string,
  want: number,
): { done: Promise<InboundEnvelope[]>; stop: () => void } {
  let stop = (): void => {}
  const done = new Promise<InboundEnvelope[]>((resolve, reject) => {
    const out: InboundEnvelope[] = []
    const timer = setTimeout(() => reject(new Error('補送逾時')), 3000)
    const req = request({ host: '127.0.0.1', port, path: `/subscribe?scope=${scope}` }, res => {
      res.setEncoding('utf8')
      const feed = createSseParser(e => {
        out.push(e)
        if (out.length === want) {
          clearTimeout(timer)
          resolve(out)
        }
      })
      res.on('data', feed)
    })
    req.on('error', reject)
    req.end()
    stop = () => {
      clearTimeout(timer)
      req.destroy()
    }
  })
  return { done, stop }
}

const closeServer = (server: Server): Promise<void> => new Promise(r => server.close(() => r()))

const contentOf = (envelope: InboundEnvelope): unknown =>
  ((envelope.payload as DiscordPayload).data as { content: string }).content

test('scope 還在開機時進來的訊息排隊，等它訂閱上來後依序補送', async () => {
  const registry = new ScopeRegistry({ maxScopes: 5, maxQueue: 10 })
  const hub = createSubscribeServer({ registry })
  const ctx = pollerContext(registry, hub)
  const port = await listen(hub)

  await routeMessage(dmMessage('first'), ctx)
  await routeMessage(dmMessage('second'), ctx)

  const sub = subscribe(port, 'discord-dm-555', 2)
  expect((await sub.done).map(contentOf)).toEqual(['first', 'second'])

  sub.stop()
  hub.close()
  await closeServer(hub.server)
})

test('scope 參數不合法時拒絕訂閱（400），不建立連線', async () => {
  const registry = new ScopeRegistry({ maxScopes: 5, maxQueue: 10 })
  const hub = createSubscribeServer({ registry })
  const port = await listen(hub)

  const status = await new Promise<number>((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path: '/subscribe?scope=discord-dm-../etc' }, res => {
      res.resume()
      resolve(res.statusCode ?? 0)
    })
    req.on('error', reject)
    req.end()
  })

  expect(status).toBe(400)
  expect(registry.state('discord-dm-../etc')).toBeUndefined()
  hub.close()
  await closeServer(hub.server)
})

test('同一個 scope 重複訂閱時踢掉舊連線，之後的訊息只進新連線', async () => {
  const registry = new ScopeRegistry({ maxScopes: 5, maxQueue: 10 })
  const hub = createSubscribeServer({ registry })
  const ctx = pollerContext(registry, hub)
  const port = await listen(hub)

  const firstClosed = new Promise<void>(resolve => {
    const req = request({ host: '127.0.0.1', port, path: '/subscribe?scope=discord-dm-555' }, res => {
      res.resume()
      res.on('end', () => resolve())
      res.on('close', () => resolve())
    })
    req.end()
  })
  await new Promise(r => setTimeout(r, SUBSCRIBE_SETTLE_MS))

  const second = subscribe(port, 'discord-dm-555', 1)
  await firstClosed
  await new Promise(r => setTimeout(r, SUBSCRIBE_SETTLE_MS))

  await routeMessage(dmMessage('after-takeover'), ctx)
  expect(contentOf((await second.done)[0])).toBe('after-takeover')

  second.stop()
  hub.close()
  await closeServer(hub.server)
})

test('thread 的訊息推給父頻道的 scope', async () => {
  const registry = new ScopeRegistry({ maxScopes: 5, maxQueue: 10 })
  const hub = createSubscribeServer({ registry })
  const ctx = pollerContext(registry, hub)
  const port = await listen(hub)

  const sub = subscribe(port, 'discord-group-111', 1)
  await new Promise(r => setTimeout(r, SUBSCRIBE_SETTLE_MS))

  await routeMessage(dmMessage('in thread', { isDm: false, channelId: '222', parentId: '111' }), ctx)
  const got = await sub.done
  expect(got[0].scopeId).toBe('discord-group-111')
  expect(contentOf(got[0])).toBe('in thread')

  sub.stop()
  hub.close()
  await closeServer(hub.server)
})

test('已送出但未 ack 的訊息在斷線後回佇列，重連補送', async () => {
  const registry = new ScopeRegistry({ maxScopes: 5, maxQueue: 10 })
  const hub = createSubscribeServer({ registry })
  const ctx = pollerContext(registry, hub)
  const port = await listen(hub)

  const first = subscribe(port, 'discord-dm-555', 1)
  await new Promise(r => setTimeout(r, SUBSCRIBE_SETTLE_MS))
  await routeMessage(dmMessage('unacked'), ctx)
  await first.done
  first.stop()
  await new Promise(r => setTimeout(r, SUBSCRIBE_SETTLE_MS))

  const second = subscribe(port, 'discord-dm-555', 1)
  expect(contentOf((await second.done)[0])).toBe('unacked')

  second.stop()
  hub.close()
  await closeServer(hub.server)
})
