/**
 * The message -> session map (JP-380).
 *
 * The file is JSON Lines, one object per sent message:
 * `{message_id, session_id, session_name, sent_at}` and optionally `chat_id`.
 * Two kinds of writer append to it: the carrier's tg-send, and a session-direct
 * server's reply tool (appendMessageMapEntries below). The poller only reads.
 *
 * The file is append-only and never rotated, so a full re-read per lookup
 * would grow without bound; instead the reader keeps what it parsed and on each
 * lookup reads only the bytes appended since — a full reload happens only when
 * the file shrank or was replaced. When a message_id appears more than once,
 * the last valid line wins, the same as the carrier's find-session.
 *
 * Truncating the file in place and letting it grow back past the read offset
 * (copytruncate-style rotation) is NOT detected: clear or rotate it by
 * replacing the file (a new inode) instead.
 *
 * Any read failure reads as "not found", which sends the reply to the hub as before.
 */
import { appendFileSync, closeSync, openSync, readSync, statSync } from 'node:fs'

export type MessageMapEntry = { sessionId: string; chatId?: string }

/** Look a sent message up by its Telegram message_id. */
export type MessageMapLookup = (messageId: number) => MessageMapEntry | undefined

/** The two filesystem calls the reader needs; injectable for tests. */
export type MessageMapFs = {
  /** @returns size and inode, or undefined when the file cannot be stat'ed. */
  stat: (path: string) => { size: number; ino: number } | undefined
  /** @returns bytes [start, end) of the file. Throws on IO failure. */
  readRange: (path: string, start: number, end: number) => Buffer
}

const NEWLINE = 0x0a

/**
 * Build a cached lookup over one map file.
 *
 * Only complete lines are consumed: a writer caught mid-append leaves a tail
 * without its newline, which stays unread until the next lookup finds it
 * finished. The newline byte never occurs inside a UTF-8 multi-byte sequence,
 * so cutting the buffer there cannot split a character.
 *
 * @param opts.filePath - Absolute path of the map file.
 * @param opts.fs - Filesystem access; defaults to node:fs.
 * @returns The lookup.
 */
export function createMessageMapLookup(opts: { filePath: string; fs?: MessageMapFs }): MessageMapLookup {
  const fs = opts.fs ?? nodeFs
  let entries = new Map<number, MessageMapEntry>()
  let offset = 0
  let inode: number | undefined

  const refresh = (): boolean => {
    const st = fs.stat(opts.filePath)
    if (!st) return false
    if (st.ino !== inode || st.size < offset) {
      entries = new Map()
      offset = 0
      inode = st.ino
    }
    if (st.size === offset) return true
    let chunk: Buffer
    try {
      chunk = fs.readRange(opts.filePath, offset, st.size)
    } catch {
      return false
    }
    const lastNewline = chunk.lastIndexOf(NEWLINE)
    if (lastNewline === -1) return true
    for (const line of chunk.subarray(0, lastNewline).toString('utf8').split('\n')) {
      const parsed = parseLine(line)
      if (parsed) entries.set(parsed[0], parsed[1])
    }
    offset += lastNewline + 1
    return true
  }

  return messageId => {
    if (!refresh()) return undefined
    return entries.get(messageId)
  }
}

/**
 * One message a session sent, as appendMessageMapEntries records it. chatId is
 * optional in the format (tg-send lines may lack it) and lets the poller
 * reject a same-numbered message from another chat.
 */
export type SentMessage = { messageId: number; sessionId: string; sessionName: string; chatId?: string }

/**
 * Record messages a session just sent, in the same line format as tg-send, so
 * a reply to any of them can be routed back to that session.
 *
 * All lines go out in ONE append: the map has other writers, and a single
 * small O_APPEND write lands whole, where line-by-line writes could interleave
 * with another writer's. Throws on IO failure — the caller decides that a
 * failed record must not fail the send.
 *
 * @param filePath - Absolute path of the map file.
 * @param messages - Sent messages; nothing is written when empty.
 * @param nowMs - Clock, injectable for tests.
 */
export function appendMessageMapEntries(
  filePath: string,
  messages: readonly SentMessage[],
  nowMs: number = Date.now(),
): void {
  if (messages.length === 0) return
  const sentAt = Math.floor(nowMs / 1000)
  const lines = messages.map(message =>
    JSON.stringify({
      message_id: message.messageId,
      session_id: message.sessionId,
      session_name: message.sessionName,
      sent_at: sentAt,
      ...(message.chatId === undefined ? {} : { chat_id: message.chatId }),
    }),
  )
  appendFileSync(filePath, `${lines.join('\n')}\n`)
}

const nodeFs: MessageMapFs = {
  stat: path => {
    try {
      const st = statSync(path)
      return { size: st.size, ino: st.ino }
    } catch {
      return undefined
    }
  },
  readRange: (path, start, end) => {
    const fd = openSync(path, 'r')
    try {
      const buffer = Buffer.alloc(end - start)
      let filled = 0
      while (filled < buffer.length) {
        const read = readSync(fd, buffer, filled, buffer.length - filled, start + filled)
        if (read === 0) break
        filled += read
      }
      return buffer.subarray(0, filled)
    } finally {
      closeSync(fd)
    }
  },
}

/**
 * Parse one map line. Malformed lines are skipped, not fatal: one bad write
 * must not hide every entry after it.
 *
 * @param line - One line, without its newline.
 * @returns The message id and entry, or undefined.
 */
function parseLine(line: string): [number, MessageMapEntry] | undefined {
  if (line.trim() === '') return undefined
  let raw: { message_id?: unknown; session_id?: unknown; chat_id?: unknown }
  try {
    raw = JSON.parse(line) as typeof raw
  } catch {
    return undefined
  }
  if (typeof raw !== 'object' || raw === null) return undefined
  if (typeof raw.message_id !== 'number' || !Number.isInteger(raw.message_id)) return undefined
  if (typeof raw.session_id !== 'string' || raw.session_id === '') return undefined
  const entry: MessageMapEntry = { sessionId: raw.session_id }
  if (typeof raw.chat_id === 'number' || typeof raw.chat_id === 'string') entry.chatId = String(raw.chat_id)
  return [raw.message_id, entry]
}
