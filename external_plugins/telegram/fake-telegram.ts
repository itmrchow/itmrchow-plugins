/**
 * A local stand-in for the Telegram Bot API, for tests that run the real
 * poller process (JP-315). Point the poller at it with TELEGRAM_API_ROOT.
 *
 * It queues updates for getUpdates the way Telegram does — an update stays
 * queued until a later call's offset confirms it — and records every other
 * call so a test can assert on what the poller sent.
 */
import { createServer, type Server } from 'node:http'
import type { Update } from 'grammy/types'

export const FAKE_BOT_TOKEN = '123456:FAKE-TOKEN-FOR-TESTS'
export const FAKE_BOT_ID = 123456
const FAKE_BOT_USERNAME = 'fake_test_bot'
/** How long an empty getUpdates is held; short so a test never waits on the poller's 25s long-poll. */
const EMPTY_POLL_HOLD_MS = 50
const FIRST_MESSAGE_ID = 1000
const HTTP_OK = 200
const HTTP_SERVER_ERROR = 500
const LOOPBACK = '127.0.0.1'
/** Calls every poller makes on its own schedule; recording them would make call logs timing-dependent. */
const UNRECORDED_METHODS: ReadonlySet<string> = new Set(['getMe', 'getUpdates'])

export type RecordedCall = { method: string; params: Record<string, unknown> }

export type FakeTelegram = {
  /** Value for TELEGRAM_API_ROOT. */
  apiRoot: string
  /** Every Bot API call received, in order, except getMe / getUpdates. */
  calls: RecordedCall[]
  /** Methods that answer with an error while present. */
  failing: Set<string>
  /** Queue an update; update_id is assigned here. @returns The assigned id. */
  inject: (update: Omit<Update, 'update_id'>) => number
  /** @returns Number of injected updates no getUpdates offset has confirmed yet. */
  unconfirmed: () => number
  /** @returns Recorded calls of one method. */
  callsOf: (method: string) => RecordedCall[]
  close: () => Promise<void>
}

/**
 * Start a fake Bot API server on a free loopback port.
 *
 * @returns The fake, already listening.
 */
export async function startFakeTelegram(): Promise<FakeTelegram> {
  const calls: RecordedCall[] = []
  const failing = new Set<string>()
  let queue: Update[] = []
  let nextUpdateId = 1
  let nextMessageId = FIRST_MESSAGE_ID

  const respond = (method: string, params: Record<string, unknown>): unknown => {
    if (method === 'getMe') {
      return { id: FAKE_BOT_ID, is_bot: true, first_name: 'fake', username: FAKE_BOT_USERNAME }
    }
    if (method === 'sendMessage') {
      return {
        message_id: nextMessageId++,
        date: 0,
        chat: { id: params.chat_id, type: 'private' },
        text: params.text,
      }
    }
    if (method === 'editMessageText') {
      return { message_id: params.message_id, date: 0, chat: { id: params.chat_id, type: 'private' }, text: params.text }
    }
    return true
  }

  const server: Server = createServer((req, res) => {
    const method = (req.url ?? '').split('/').pop()?.split('?')[0] ?? ''
    let raw = ''
    req.on('data', (chunk: Buffer | string) => void (raw += chunk))
    req.on('end', () => {
      let params: Record<string, unknown> = {}
      try {
        params = raw ? (JSON.parse(raw) as Record<string, unknown>) : {}
      } catch {}
      const send = (status: number, body: Record<string, unknown>): void => {
        res.writeHead(status, { 'content-type': 'application/json' })
        res.end(JSON.stringify(body))
      }
      if (!UNRECORDED_METHODS.has(method)) calls.push({ method, params })
      if (failing.has(method)) {
        send(HTTP_SERVER_ERROR, { ok: false, error_code: HTTP_SERVER_ERROR, description: `fake failure: ${method}` })
        return
      }
      if (method !== 'getUpdates') {
        send(HTTP_OK, { ok: true, result: respond(method, params) })
        return
      }
      const offset = typeof params.offset === 'number' ? params.offset : 0
      queue = queue.filter(update => update.update_id >= offset)
      if (queue.length > 0) {
        send(HTTP_OK, { ok: true, result: queue })
        return
      }
      setTimeout(() => send(HTTP_OK, { ok: true, result: queue }), EMPTY_POLL_HOLD_MS)
    })
  })

  await new Promise<void>(resolve => server.listen(0, LOOPBACK, resolve))
  const { port } = server.address() as { port: number }

  return {
    apiRoot: `http://${LOOPBACK}:${port}`,
    calls,
    failing,
    inject: update => {
      const updateId = nextUpdateId++
      queue.push({ ...update, update_id: updateId } as Update)
      return updateId
    },
    unconfirmed: () => queue.length,
    callsOf: method => calls.filter(call => call.method === method),
    close: () =>
      new Promise<void>(resolve => {
        server.closeAllConnections()
        server.close(() => resolve())
      }),
  }
}
