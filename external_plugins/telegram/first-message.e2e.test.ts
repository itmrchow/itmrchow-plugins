/**
 * End-to-end regression for JP-190: a brand-new identity's FIRST message.
 *
 * The bug was found on discord, but the subscription hub, the registry and the
 * boot sequence are the same design here, so the same test has to hold on this
 * side — otherwise the next telegram change is free to reintroduce it.
 *
 * See discord/first-message.e2e.test.ts and channel-ready.ts for the reasoning
 * and the production measurements.
 */
import { expect, test } from 'bun:test'
import type { Update } from 'grammy/types'
import { createReadyGate } from './channel-ready'
import { ScopeRegistry } from './poller-registry'
import { routeUpdate, type RouteContext } from './route-update'
import { createSubscribeServer } from './subscribe-server'
import { startSubscribeClient } from './subscribe-client'

/** Client reports `initialized` this long after its transport is up. */
const INITIALIZED_AFTER_MS = 10
/** …and only registers the channel handler this long after that. */
const HANDLER_REGISTERED_AFTER_MS = 150
/** Grace the gate holds the subscription for. Must outlast the line above. */
const TEST_GRACE_MS = 250

const FIRST_MESSAGE = '我是新來的，請記住這句話'

const firstDm = {
  update_id: 1,
  message: {
    message_id: 1,
    date: 0,
    text: FIRST_MESSAGE,
    from: { id: 6083473232, is_bot: false, first_name: 'u' },
    chat: { id: 6083473232, type: 'private', first_name: 'u' },
  },
} as unknown as Update

const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))

async function waitUntil(cond: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!cond()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for the first message')
    await sleep(5)
  }
}

test('全新身分的第一則訊息：spawn 完成前入佇列，且要等訂閱端能收通知後才送達', async () => {
  const registry = new ScopeRegistry({ maxScopes: 5, maxQueue: 20 })
  const hub = createSubscribeServer({ registry })
  await new Promise<void>(r => hub.server.listen(0, '127.0.0.1', r))
  const port = (hub.server.address() as { port: number }).port

  // Stands in for Claude Code: the handler that turns an envelope into a session
  // turn exists only from this moment on. Before it, an envelope is dropped.
  let handlerRegistered = false
  const seen: string[] = []
  const lost: string[] = []

  // The carrier's scope-spawn.sh, plus the boot of the scope it starts.
  const spawn = async (scopeId: string): Promise<'ok'> => {
    void (async () => {
      const gate = createReadyGate({ graceMs: TEST_GRACE_MS, setTimer: (fn, ms) => void setTimeout(fn, ms) })
      setTimeout(() => gate.markInitialized(), INITIALIZED_AFTER_MS)
      setTimeout(() => { handlerRegistered = true }, HANDLER_REGISTERED_AFTER_MS)
      await gate.ready
      startSubscribeClient({
        host: '127.0.0.1',
        port,
        scopeId,
        onEnvelope: async envelope => {
          const update = envelope.payload as Update
          ;(handlerRegistered ? seen : lost).push(update.message?.text ?? '')
        },
      })
    })()
    return 'ok'
  }

  const ctx: RouteContext = {
    registry,
    deliver: hub.deliver,
    spawn,
    notify: () => Promise.resolve(),
    setTimer: () => {},
  }

  await routeUpdate(firstDm, ctx)

  // The spawn decision must not eat the update that caused it.
  expect(registry.state('telegram-dm-6083473232')).toBe('connecting')

  await waitUntil(() => seen.length + lost.length > 0)

  expect(lost).toEqual([])
  expect(seen).toEqual([FIRST_MESSAGE])
  hub.close()
})
