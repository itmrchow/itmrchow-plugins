/**
 * The wire shape of a discord inbound event, and the reduction that produces it.
 *
 * WHY THIS EXISTS. The poller holds the gateway and owns discord.js; every
 * scope's server.ts receives JSON over SSE and holds no discord.js objects at
 * all. Something has to define what survives that hop, and neither of the two
 * obvious candidates works:
 *
 *  - `msg.toJSON()` is discord.js's *flatten*, not the raw gateway JSON. It
 *    emits discord.js's own camelCase property names and — the part that bites —
 *    rewrites `author` to `authorId` and drops `member` / `reactions` entirely.
 *    A subscriber reading `data.author.username` off it gets `undefined`.
 *  - The raw gateway JSON is snake_case (`channel_id`, `content_type`,
 *    `filename`) and still lacks the two facts routing needs: whether the
 *    channel is a DM, and a thread's parent id. Both are channel properties, not
 *    message properties.
 *
 * So the payload is neither: it is this explicit, named shape. The reduction is
 * kept here rather than inline in the poller so the property mapping — the part
 * that fails silently rather than loudly — is unit-testable against plain
 * objects, with no gateway and no discord.js instances.
 *
 * The parameter types are structural on purpose: a discord.js `Message` is
 * assignable to `SourceMessage`, and so is a hand-written object in a test.
 */

/** One attachment, in the single shape used everywhere downstream of the wire. */
export type InboundAttachment = {
  id: string
  /** File name. discord.js calls this `name`, the raw API calls it `filename`. */
  name: string
  size: number
  url: string
  /** MIME type, or null when Discord reports none. */
  contentType: string | null
}

/** A user reduced to what the channel server needs. */
export type InboundUser = { id: string; username: string }

/** One inbound chat message, as it travels from poller to subscriber. */
export type InboundMessage = {
  id: string
  channelId: string
  /** True for a direct message; the subscriber cannot look the channel up cheaply. */
  isDm: boolean
  /** Parent channel of a thread; null for anything that is not a thread. */
  parentId: string | null
  content: string
  /** ISO 8601, already normalised to the `Z` form. */
  timestamp: string
  author: InboundUser
  attachments: InboundAttachment[]
  /** Ids directly @mentioned in this message. */
  mentionIds: string[]
  /** Whether the message carried an @everyone / @here mention. */
  mentionsEveryone: boolean
  /** The quote-replied message's id, or null. */
  replyToMessageId: string | null
  /** Author of the quote-replied message when Discord embedded it, else null. */
  replyToUser: InboundUser | null
}

/**
 * One button click, as it travels from poller to subscriber.
 *
 * `token` + `applicationId` are what make the click answerable over REST, and
 * `messageContent` is carried so the answer can append its outcome to the
 * original prompt without a second REST round-trip to read it back.
 */
export type InboundInteraction = {
  id: string
  token: string
  applicationId: string
  customId: string
  userId: string
  channelId: string | null
  guildId: string | null
  messageId: string | null
  messageContent: string
}

/** The discord.js `Attachment` surface this reduction reads. */
export type SourceAttachment = {
  id: string
  name: string | null
  size: number
  url: string
  contentType: string | null
}

/** The discord.js `Message` surface this reduction reads. */
export type SourceMessage = {
  id: string
  channelId: string
  content: string
  createdAt: Date
  author: { id: string; username: string }
  attachments: { values(): Iterable<SourceAttachment> }
  mentions: {
    users: { values(): Iterable<{ id: string }> }
    everyone: boolean
    repliedUser: { id: string; username: string } | null
  }
  /** discord.js leaves `messageId` undefined on a forwarded/crosspost reference. */
  reference: { messageId?: string | null } | null
}

/** Channel facts the poller has already resolved for routing. */
export type ChannelFacts = { isDm: boolean; parentId: string | null | undefined }

/**
 * Reduce one gateway message to the wire shape.
 *
 * Role mentions are deliberately not represented: matching one needs the bot's
 * own role list in that guild, which came from the gateway's member cache and no
 * subscriber has. Direct mentions and @everyone are carried; a channel that
 * triggered only on a role mention now needs a direct @bot instead.
 *
 * @param msg - The gateway message.
 * @param facts - Channel facts the poller resolved while routing.
 * @returns The payload to put on the wire.
 */
export function toInboundMessage(msg: SourceMessage, facts: ChannelFacts): InboundMessage {
  return {
    id: msg.id,
    channelId: msg.channelId,
    isDm: facts.isDm,
    parentId: facts.parentId ?? null,
    content: msg.content,
    timestamp: msg.createdAt.toISOString(),
    author: { id: msg.author.id, username: msg.author.username },
    attachments: [...msg.attachments.values()].map(att => ({
      id: att.id,
      name: att.name ?? att.id,
      size: att.size,
      url: att.url,
      contentType: att.contentType,
    })),
    mentionIds: [...msg.mentions.users.values()].map(u => u.id),
    mentionsEveryone: msg.mentions.everyone,
    replyToMessageId: msg.reference?.messageId ?? null,
    replyToUser: msg.mentions.repliedUser
      ? { id: msg.mentions.repliedUser.id, username: msg.mentions.repliedUser.username }
      : null,
  }
}
