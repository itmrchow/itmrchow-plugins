import { expect, test } from 'bun:test'
import { nextBackoffMs, startSubscribeClient } from './subscribe-client'
import { ScopeRegistry } from './poller-registry'
import { createSubscribeServer, type SubscribeHub } from './subscribe-server'
import type { InboundEnvelope } from './subscribe-protocol'

const SCOPE = 'telegram-dm-1'

const envelope = (id: string): InboundEnvelope => ({
  envelopeId: id,
  scopeId: SCOPE,
  platform: 'telegram',
  payload: { n: id },
  ts: 1,
})

async function waitFor(predicate: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 5000
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`逾時等待：${label}`)
    await new Promise(r => setTimeout(r, 20))
  }
}

function startHub(registry: ScopeRegistry, port: number): Promise<SubscribeHub> {
  const hub = createSubscribeServer({ registry })
  return new Promise(resolve => hub.server.listen(port, '127.0.0.1', () => resolve(hub)))
}

test('退避從 1 秒起，每次加倍', () => {
  expect(nextBackoffMs(0, () => 0.5)).toBe(1000)
  expect(nextBackoffMs(1, () => 0.5)).toBe(2000)
  expect(nextBackoffMs(2, () => 0.5)).toBe(4000)
  expect(nextBackoffMs(3, () => 0.5)).toBe(8000)
})

test('退避上限 30 秒', () => {
  expect(nextBackoffMs(20, () => 0.5)).toBe(30000)
})

test('加 ±20% jitter：全域重啟時 N 個 server 不會同時撞上來', () => {
  expect(nextBackoffMs(0, () => 0)).toBe(800)
  expect(nextBackoffMs(0, () => 1)).toBe(1200)
})

test('端對端：訂閱收訊並 ack，poller 重啟後自動重連續收', async () => {
  const registry = new ScopeRegistry({ maxScopes: 5, maxQueue: 10 })
  let hub = await startHub(registry, 0)
  const port = (hub.server.address() as { port: number }).port
  registry.admit(SCOPE, envelope('first'))

  const got: InboundEnvelope[] = []
  const client = startSubscribeClient({
    host: '127.0.0.1',
    port,
    scopeId: SCOPE,
    onEnvelope: async e => void got.push(e),
  })

  await waitFor(() => got.length === 1, '收到排隊中的第一則')
  expect(got[0].envelopeId).toBe('first')

  // poller 整個重啟：舊連線斷、同一個 port 起新的 hub
  hub.close()
  await new Promise<void>(r => hub.server.close(() => r()))
  const registry2 = new ScopeRegistry({ maxScopes: 5, maxQueue: 10 })
  registry2.admit(SCOPE, envelope('after-restart'))
  hub = await startHub(registry2, port)

  await waitFor(() => got.length === 2, '重連後收到新訊息')
  expect(got[1].envelopeId).toBe('after-restart')
  // ack 過的第一則沒有被重送
  expect(got.map(e => e.envelopeId)).toEqual(['first', 'after-restart'])

  client.stop()
  hub.close()
  await new Promise<void>(r => hub.server.close(() => r()))
}, 20000)

test('onEnvelope 拋錯時不 ack，重連後會重送', async () => {
  const registry = new ScopeRegistry({ maxScopes: 5, maxQueue: 10 })
  const hub = await startHub(registry, 0)
  const port = (hub.server.address() as { port: number }).port
  registry.admit(SCOPE, envelope('poison'))

  const attempts: string[] = []
  const client = startSubscribeClient({
    host: '127.0.0.1',
    port,
    scopeId: SCOPE,
    onEnvelope: async e => {
      attempts.push(e.envelopeId)
      throw new Error('handler boom')
    },
  })

  await waitFor(() => attempts.length === 1, '第一次處理')
  // 沒 ack -> 還在 in-flight -> 斷線後回佇列 -> 重連補送
  await waitFor(() => registry.state(SCOPE) === 'connected', '訂閱建立')
  client.stop()
  await waitFor(() => registry.state(SCOPE) === 'disconnected', '連線斷開')
  expect(registry.onSubscribed(SCOPE).map(e => e.envelopeId)).toEqual(['poison'])

  hub.close()
  await new Promise<void>(r => hub.server.close(() => r()))
}, 20000)
