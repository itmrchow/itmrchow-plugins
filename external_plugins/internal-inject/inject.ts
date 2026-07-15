/**
 * /inject request parsing for the internal-inject channel server.
 *
 * Split out from server.ts (which has top-level side effects: MCP connect, port
 * bind) so the HTTP contract is unit-testable in isolation.
 */

/** Channels an agent can be told to answer back on. */
export const REPLY_CHANNELS = ['telegram', 'discord'] as const

/**
 * Accepted shape of chat_id.
 *
 * chat_id is rendered as an ATTRIBUTE of the <channel …> tag the agent reads, so
 * an unconstrained string is an injection surface. A whitelist regex is cheaper
 * and tighter than stripping characters after the fact.
 */
const CHAT_ID_PATTERN = /^[A-Za-z0-9_:-]{1,64}$/

const HTTP_BAD_REQUEST = 400

/** Synthetic channel message handed to the MCP notification. */
export type ChannelDelivery = {
  content: string
  meta: Record<string, string>
}

/** Outcome of parsing a raw /inject request body. */
export type InjectParse =
  | { ok: true; delivery: ChannelDelivery }
  | { ok: false; status: number; message: string }

/**
 * Parse and validate a raw /inject body into a channel delivery.
 *
 * The service POSTs `{ text, chat_id, reply_via }`. The sender identity is NOT
 * taken from the body — it is passed in, having been derived from the caller's
 * token — because a self-declared identity is worth nothing. A `service` field in
 * the body is ignored.
 *
 * reply_via is validated against REPLY_CHANNELS: this plugin has no reply tool, so
 * a typo ("telgram") would surface as an agent hunting for a reply tool that does
 * not exist and quietly giving up — the most expensive kind of failure to trace.
 * A 400 at the HTTP boundary costs one constant.
 *
 * @param raw - Raw request body, expected to be JSON `{ text, chat_id, reply_via }`.
 * @param service - Service name resolved from the caller's bearer token.
 * @returns `{ ok: true, delivery }` on success, else `{ ok: false, status, message }`
 *   carrying the HTTP status and reason to write back.
 */
export function parseInjectBody(raw: string, service: string): InjectParse {
  let body: { text?: unknown; chat_id?: unknown; reply_via?: unknown }
  try {
    body = JSON.parse(raw)
  } catch {
    return { ok: false, status: HTTP_BAD_REQUEST, message: 'invalid json' }
  }

  const { text, chat_id, reply_via } = body
  if (
    typeof text !== 'string' || !text ||
    typeof chat_id !== 'string' || !chat_id ||
    typeof reply_via !== 'string' || !reply_via
  ) {
    return { ok: false, status: HTTP_BAD_REQUEST, message: 'missing text, chat_id or reply_via' }
  }
  if (!CHAT_ID_PATTERN.test(chat_id)) {
    return { ok: false, status: HTTP_BAD_REQUEST, message: 'invalid chat_id' }
  }
  if (!(REPLY_CHANNELS as readonly string[]).includes(reply_via)) {
    return {
      ok: false,
      status: HTTP_BAD_REQUEST,
      message: `invalid reply_via (expected: ${REPLY_CHANNELS.join(', ')})`,
    }
  }

  return {
    ok: true,
    delivery: {
      content: text,
      meta: {
        chat_id,
        reply_via,
        user: `service:${service}`,
        user_id: `service:${service}`,
        ts: new Date().toISOString(),
      },
    },
  }
}
