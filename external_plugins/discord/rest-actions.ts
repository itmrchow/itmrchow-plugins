/**
 * Discord REST calls, as free functions over a minimal injectable client.
 *
 * server.ts no longer holds a gateway connection — the poller is the single
 * holder for the whole platform — so it no longer receives discord.js `Message`
 * instances and cannot call `msg.react()` / `msg.channel.send()`. Everything it
 * used to do through those objects is expressed here as an explicit route plus
 * ids.
 *
 * The functions take `RestLike` rather than `@discordjs/rest`'s `REST` so tests
 * can inject a recorder and assert the exact route: a wrong route is a 404 at
 * runtime, which is precisely the class of mistake this rewrite can introduce.
 *
 * Return types are RAW Discord API JSON (snake_case: `channel_id`, `content_type`,
 * `filename`), NOT discord.js's camelCase view of it. Callers must not assume the
 * discord.js names — see `normalizeAttachment` in server.ts for the one place
 * that translation happens.
 */

/** A REST path, always absolute — matches @discordjs/rest's `RouteLike`. */
export type RestRoute = `/${string}`

/** One multipart upload part. */
export type RestFile = { name: string; data: Buffer }

/** The request options shape @discordjs/rest accepts. */
export type RestOptions = { body?: unknown; files?: RestFile[] }

/**
 * The slice of `@discordjs/rest`'s `REST` this module uses.
 *
 * Declared structurally so a real `REST` is assignable and a fake is too.
 */
export interface RestLike {
  get(route: RestRoute, options?: RestOptions): Promise<unknown>
  post(route: RestRoute, options?: RestOptions): Promise<unknown>
  patch(route: RestRoute, options?: RestOptions): Promise<unknown>
  put(route: RestRoute, options?: RestOptions): Promise<unknown>
}

/** A user as the API returns it. */
export type RawUser = {
  id: string
  username: string
  bot?: boolean
}

/**
 * An attachment as the API returns it.
 *
 * `filename` and `content_type`, not discord.js's `name` / `contentType` — the
 * two silently differ, and a missing `contentType` reads as `undefined` rather
 * than failing.
 */
export type RawAttachment = {
  id: string
  filename: string
  size: number
  url: string
  content_type?: string | null
}

/** A message as the API returns it. */
export type RawMessage = {
  id: string
  channel_id: string
  author: RawUser
  content: string
  /** ISO 8601 with offset; not necessarily the `Z` form. */
  timestamp: string
  attachments: RawAttachment[]
  mentions?: RawUser[]
  message_reference?: { message_id?: string } | null
}

/** A channel as the API returns it. */
export type RawChannel = {
  id: string
  type: number
  guild_id?: string
  parent_id?: string | null
  /** Present on DM channels; the bot itself is not listed. */
  recipients?: RawUser[]
}

/** Interaction response type: send a new (optionally ephemeral) message. */
export const INTERACTION_CALLBACK_MESSAGE = 4
/** Interaction response type: edit the message the component sits on. */
export const INTERACTION_CALLBACK_UPDATE_MESSAGE = 7
/** Message flag making an interaction response visible only to the clicker. */
export const MESSAGE_FLAG_EPHEMERAL = 64

// discord.js resolved `<:name:id>` for us; the raw route wants the bare
// `name:id`. Sending the angle-bracket form yields an "Unknown Emoji" 400.
const CUSTOM_EMOJI_PATTERN = /^<a?:([^:]+):(\d+)>$/

/**
 * Encode one emoji for the reaction route's path segment.
 *
 * Unicode emoji must be percent-encoded (raw bytes in a path segment 400), and
 * custom emoji must first be reduced from `<:name:id>` to `name:id`.
 *
 * @param emoji - Either a unicode emoji or the `<:name:id>` / `<a:name:id>` form.
 * @returns The path-segment-safe encoding.
 */
export function encodeReactionEmoji(emoji: string): string {
  const custom = CUSTOM_EMOJI_PATTERN.exec(emoji)
  return encodeURIComponent(custom ? `${custom[1]}:${custom[2]}` : emoji)
}

/**
 * Post a message to a channel.
 *
 * @param rest - REST client.
 * @param channelId - Target channel.
 * @param body - Raw message payload (`content`, `components`, `message_reference`…).
 * @param files - Optional attachments, uploaded as multipart.
 * @returns The created message.
 */
export async function sendMessage(
  rest: RestLike,
  channelId: string,
  body: Record<string, unknown>,
  files?: RestFile[],
): Promise<RawMessage> {
  const options: RestOptions = files && files.length > 0 ? { body, files } : { body }
  return (await rest.post(`/channels/${channelId}/messages`, options)) as RawMessage
}

/**
 * Add the bot's own reaction to a message.
 *
 * @param rest - REST client.
 * @param channelId - Channel the message lives in.
 * @param messageId - Message to react to.
 * @param emoji - Unicode emoji or `<:name:id>` custom form.
 */
export async function addReaction(
  rest: RestLike,
  channelId: string,
  messageId: string,
  emoji: string,
): Promise<void> {
  await rest.put(
    `/channels/${channelId}/messages/${messageId}/reactions/${encodeReactionEmoji(emoji)}/@me`,
  )
}

/**
 * Edit a message the bot sent.
 *
 * @param rest - REST client.
 * @param channelId - Channel the message lives in.
 * @param messageId - Message to edit.
 * @param body - Raw edit payload (`content`, `components`…).
 * @returns The edited message.
 */
export async function editMessage(
  rest: RestLike,
  channelId: string,
  messageId: string,
  body: Record<string, unknown>,
): Promise<RawMessage> {
  return (await rest.patch(`/channels/${channelId}/messages/${messageId}`, {
    body,
  })) as RawMessage
}

/**
 * Fetch one message by id.
 *
 * @param rest - REST client.
 * @param channelId - Channel the message lives in.
 * @param messageId - Message to fetch.
 * @returns The message.
 */
export async function fetchMessage(
  rest: RestLike,
  channelId: string,
  messageId: string,
): Promise<RawMessage> {
  return (await rest.get(`/channels/${channelId}/messages/${messageId}`)) as RawMessage
}

/**
 * Fetch a page of recent messages, newest first.
 *
 * @param rest - REST client.
 * @param channelId - Channel to read.
 * @param limit - Page size; Discord caps this at 100.
 * @returns The page, newest first.
 */
export async function fetchMessages(
  rest: RestLike,
  channelId: string,
  limit: number,
): Promise<RawMessage[]> {
  return (await rest.get(`/channels/${channelId}/messages?limit=${limit}`)) as RawMessage[]
}

/**
 * Fetch one channel's metadata.
 *
 * @param rest - REST client.
 * @param channelId - Channel to look up.
 * @returns The channel.
 */
export async function fetchChannel(rest: RestLike, channelId: string): Promise<RawChannel> {
  return (await rest.get(`/channels/${channelId}`)) as RawChannel
}

/**
 * Show the typing indicator in a channel for ~10 seconds.
 *
 * @param rest - REST client.
 * @param channelId - Channel to type in.
 */
export async function triggerTyping(rest: RestLike, channelId: string): Promise<void> {
  await rest.post(`/channels/${channelId}/typing`)
}

/**
 * Open (or reuse) the DM channel with one user.
 *
 * Discord returns the existing channel when there is one, so this is safe to
 * call before every DM rather than caching.
 *
 * @param rest - REST client.
 * @param userId - The recipient.
 * @returns The DM channel.
 */
export async function createDmChannel(rest: RestLike, userId: string): Promise<RawChannel> {
  return (await rest.post('/users/@me/channels', {
    body: { recipient_id: userId },
  })) as RawChannel
}

/**
 * Answer a component interaction within its 3-second callback window.
 *
 * @param rest - REST client.
 * @param interactionId - The interaction's id.
 * @param token - The interaction's single-use token.
 * @param body - `{ type, data }`; see the INTERACTION_CALLBACK_* constants.
 */
export async function respondInteraction(
  rest: RestLike,
  interactionId: string,
  token: string,
  body: Record<string, unknown>,
): Promise<void> {
  await rest.post(`/interactions/${interactionId}/${encodeURIComponent(token)}/callback`, {
    body,
  })
}
