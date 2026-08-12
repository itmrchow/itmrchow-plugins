/**
 * End-to-end regression for JP-190: a brand-new identity's FIRST message.
 *
 * The existing suites cover an already-connected scope and a takeover of a live
 * one. Neither covers the combination this bug lives in — the message that
 * triggers the spawn is queued, and the queue is flushed the instant the new
 * scope subscribes, i.e. while its Claude client is still coming up. Everything
 * from routeMessage through the real SSE hub down to the subscriber's handler
 * runs here; only the two ends are stubbed (the carrier's spawn script, and the
 * MCP client's channel-notification handler).
 *
 * The subscriber models the production ordering measured on a1-b: the MCP client
 * reports itself initialized first and registers the handler that receives
 * channel notifications a moment later. An envelope arriving before that second
 * point is not "late", it is LOST — the MCP client drops it silently — so the
 * test scores those separately instead of just asserting arrival.
 */
import { expect, test } from 'bun:test'
import { createReadyGate } from './channel-ready'
import { ScopeRegistry } from './poller-registry'
import { routeMessage, type DiscordPayload, type RouteContext, type RouteInput } from './route-message'
import { createSubscribeServer } from './subscribe-server'
import { startSubscribeClient } from './subscribe-client'

/** Client reports `initialized` this long after its transport is up. */
const INITIALIZED_AFTER_MS = 10
/** …and only registers the channel handler this long after that. */
const HANDLER_REGISTERED_AFTER_MS = 150
/** Grace the gate holds the subscription for. Must outlast the line above. */
const TEST_GRACE_MS = 250

const FIRST_MESSAGE = '我是 discord 個人，請記住這句話'

const firstDm: RouteInput = {
  kind: 'messageCreate',
  isDm: true,
  channelId: '830680811401379870',
  parentId: undefined,
  authorId: '830680811401379870',
  data: { content: FIRST_MESSAGE },
}

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
          const text = (envelope.payload as DiscordPayload).data as { content: string }
          ;(handlerRegistered ? seen : lost).push(text.content)
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
    log: () => {},
  }

  await routeMessage(firstDm, ctx)

  // The spawn decision must not eat the message that caused it.
  expect(registry.state('discord-dm-830680811401379870')).toBe('connecting')

  await waitUntil(() => seen.length + lost.length > 0)

  expect(lost).toEqual([])
  expect(seen).toEqual([FIRST_MESSAGE])
  hub.close()
})
