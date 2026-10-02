/**
 * Approval requests over Telegram inline buttons (JP-315).
 *
 * Ties the store to the Bot API: sends a request as a message with buttons,
 * turns callback_query / quote-reply updates into decisions, and rewrites the
 * message to its final state. The Bot API is injected so everything here runs
 * against a fake in tests.
 *
 * Two entry points, on purpose kept apart:
 * - create / get / cancel — reachable from the loopback interface;
 * - interceptUpdate — reachable only from the getUpdates loop.
 * Only the second one can produce a decision.
 */
import type { Update } from 'grammy/types'
import {
  ACTIONS_BY_KIND,
  ALL_ACTIONS,
  type ApprovalAction,
  type ApprovalKind,
  type ApprovalRequest,
  type ApprovalStore,
  type SentMessage,
} from './approval-store'

/** Prefix of every callback_data this feature owns. `perm:` belongs to server.ts. */
export const APPROVAL_CALLBACK_PREFIX = 'appr:'
/** Request ids: short enough that the longest callback_data stays under Telegram's 64 bytes. */
export const APPROVAL_ID_PATTERN = '[A-Za-z0-9_-]{1,40}'
export const APPROVAL_ID_RE = new RegExp(`^${APPROVAL_ID_PATTERN}$`)
const CALLBACK_RE = new RegExp(`^${APPROVAL_CALLBACK_PREFIX}(${ALL_ACTIONS.join('|')}):(${APPROVAL_ID_PATTERN})$`)

/** Telegram caps a message at 4096 UTF-16 code units. */
const TELEGRAM_MESSAGE_LIMIT = 4096
/** Display text cap; the remainder is kept free for the outcome line and comment. */
export const MAX_APPROVAL_TEXT_LENGTH = 3500
/** Requests held at once (settled ones included) before create is refused. */
export const MAX_APPROVAL_REQUESTS = 200
/** How often the clock is applied when nobody is querying. */
export const SWEEP_INTERVAL_MS = 1000
const MS_PER_SECOND = 1000
const SECONDS_PER_MINUTE = 60
const TRUNCATION_MARK = '…'

const BUTTON_LABELS: Readonly<Record<ApprovalAction, string>> = {
  allow: '允許',
  deny: '拒絕',
  approve: 'approve',
  reject: '退回',
}

const DECIDED_LABELS: Readonly<Record<ApprovalAction, string>> = {
  allow: '[已允許]',
  deny: '[已拒絕]',
  approve: '[已 approve]',
  reject: '[已退回]',
}
const CANCELLED_LABEL = '[已在電腦處理]'
const EXPIRED_LABEL = '[已逾時]'
const AWAITING_COMMENT_LABEL = '[已按退回] 等待意見中'
const NO_COMMENT_SUFFIX = '（無意見）'
const COMMENT_PREFIX = ' 意見：'

const NOT_AUTHORIZED_TEXT = '沒有權限。'
const INVALID_BUTTON_TEXT = '無效的按鈕。'
const NOT_FOUND_TEXT = '找不到這筆請求（可能已過期）。'
const ALREADY_SETTLED_TEXT = '這筆請求已經處理過了。'
const COMMENT_REQUESTED_TEXT = '請回覆意見'
const TEXT_ONLY_COMMENT_TEXT = '請用文字回覆意見。'
const COMMENT_TOO_LATE_TEXT = '這筆請求已經結案，這則意見沒有被記錄。'
/** Bot commands are never comments: a /restart typed into the forced reply box must still reach its handler. */
const COMMAND_PREFIX = '/'

export type ApprovalButton = { text: string; callbackData: string }

/** The slice of the Bot API this feature uses. */
export type ApprovalTelegramApi = {
  /** Send a request message with one row of buttons. @returns The message id. */
  sendRequest: (chatId: number, text: string, buttons: readonly ApprovalButton[]) => Promise<number>
  /** Send a force-reply prompt threaded under a request message. @returns The message id. */
  sendPrompt: (chatId: number, text: string, replyToMessageId: number) => Promise<number>
  /** Replace a message's text and drop its buttons. */
  editText: (chatId: number, messageId: number, text: string) => Promise<void>
  answerCallback: (callbackQueryId: string, text?: string) => Promise<void>
  sendText: (chatId: number, text: string) => Promise<void>
}

export type CreateApprovalInput = {
  id: string
  kind: ApprovalKind
  text: string
  timeoutSeconds: number
  commentTimeoutSeconds: number
}

export type CreateApprovalError = 'duplicate_id' | 'no_recipient' | 'telegram_send_failed' | 'too_many_requests'

export type CreateApprovalResult =
  | { ok: true; request: ApprovalRequest }
  /** `request` is the existing one on duplicate_id, when it is already stored. */
  | { ok: false; error: CreateApprovalError; request?: ApprovalRequest }

export type ApprovalServiceDeps = {
  store: ApprovalStore
  api: ApprovalTelegramApi
  /** Current access.allowFrom, read fresh each time; empty when unreadable. */
  loadAllowFrom: () => string[]
  now?: () => number
  log?: (line: string) => void
}

export type ApprovalService = {
  /** Send a new request to every allowlisted DM and start tracking it. */
  create: (input: CreateApprovalInput) => Promise<CreateApprovalResult>
  /** Look a request up, with the clock applied first. */
  get: (id: string) => ApprovalRequest | undefined
  /** Cancel an open request and mark its message as handled locally. */
  cancel: (id: string) => Promise<ApprovalRequest | undefined>
  /**
   * Handle an update that belongs to this feature.
   *
   * @returns true when the update was consumed and must NOT be routed to a session.
   */
  interceptUpdate: (update: Update) => Promise<boolean>
  /** Apply the clock now and rewrite the messages of whatever just timed out. */
  sweep: () => Promise<void>
  /** Start the background sweep. @returns A function that stops it. */
  start: () => () => void
}

function buttonsFor(request: Pick<ApprovalRequest, 'id' | 'kind'>): ApprovalButton[] {
  return ACTIONS_BY_KIND[request.kind].map(action => ({
    text: BUTTON_LABELS[action],
    callbackData: `${APPROVAL_CALLBACK_PREFIX}${action}:${request.id}`,
  }))
}

function outcomeLabel(request: ApprovalRequest): string {
  if (request.status === 'cancelled') return CANCELLED_LABEL
  if (request.status === 'expired') return EXPIRED_LABEL
  if (request.status === 'awaiting_comment') return AWAITING_COMMENT_LABEL
  if (request.decision === null) return ''
  const label = DECIDED_LABELS[request.decision]
  if (request.decision !== 'reject') return label
  return request.comment ? `${label}${COMMENT_PREFIX}${request.comment}` : `${label}${NO_COMMENT_SUFFIX}`
}

/**
 * The text a request message shows once it is no longer plain pending: the
 * original text followed by its outcome, cut to Telegram's message limit.
 *
 * @param request - The request in its current state.
 * @returns Message text.
 */
export function renderApprovalText(request: ApprovalRequest): string {
  const rendered = `${request.text}\n\n${outcomeLabel(request)}`
  if (rendered.length <= TELEGRAM_MESSAGE_LIMIT) return rendered
  return `${rendered.slice(0, TELEGRAM_MESSAGE_LIMIT - TRUNCATION_MARK.length)}${TRUNCATION_MARK}`
}

function describeCommentWindow(commentTimeoutMs: number): string {
  const seconds = Math.ceil(commentTimeoutMs / MS_PER_SECOND)
  if (seconds < SECONDS_PER_MINUTE) return `${seconds} 秒`
  return `${Math.ceil(seconds / SECONDS_PER_MINUTE)} 分鐘`
}

/**
 * Build the approval service.
 *
 * @param deps - Store, Bot API slice, allowlist reader, optional clock and log.
 * @returns The service.
 */
export function createApprovalService(deps: ApprovalServiceDeps): ApprovalService {
  const { store, api } = deps
  const now = deps.now ?? Date.now
  const log = deps.log ?? ((line: string) => void process.stderr.write(`${line}\n`))
  /** Ids whose first message is still going out; closes the create/create race. */
  const creating = new Set<string>()

  // A failed edit never undoes a decision: the callback is the record, the
  // message is only its display (and may have been deleted by the user).
  const rewriteMessages = async (request: ApprovalRequest): Promise<void> => {
    const text = renderApprovalText(request)
    await Promise.all(
      request.messages.map(sent =>
        api.editText(sent.chatId, sent.messageId, text).catch(err => {
          log(`telegram poller: approval ${request.id} edit failed chat=${sent.chatId}: ${err}`)
        }),
      ),
    )
  }

  const sweep = async (): Promise<void> => {
    for (const request of store.sweep()) await rewriteMessages(request)
  }

  const answer = (callbackQueryId: string, text?: string): Promise<void> =>
    api.answerCallback(callbackQueryId, text).catch(err => {
      log(`telegram poller: approval answerCallbackQuery failed: ${err}`)
    })

  const create = async (input: CreateApprovalInput): Promise<CreateApprovalResult> => {
    await sweep()
    const existing = store.get(input.id)
    if (existing) return { ok: false, error: 'duplicate_id', request: existing }
    if (creating.has(input.id)) return { ok: false, error: 'duplicate_id' }
    if (store.size() + creating.size >= MAX_APPROVAL_REQUESTS) return { ok: false, error: 'too_many_requests' }

    const recipients = deps.loadAllowFrom().map(Number).filter(Number.isSafeInteger)
    if (recipients.length === 0) return { ok: false, error: 'no_recipient' }

    creating.add(input.id)
    try {
      const buttons = buttonsFor(input)
      const messages: SentMessage[] = []
      for (const chatId of recipients) {
        try {
          messages.push({ chatId, messageId: await api.sendRequest(chatId, input.text, buttons) })
        } catch (err) {
          log(`telegram poller: approval ${input.id} send to ${chatId} failed: ${err}`)
        }
      }
      // Nothing reached anyone: storing it would leave a request no one can answer.
      if (messages.length === 0) return { ok: false, error: 'telegram_send_failed' }

      const createdAtMs = now()
      const request = store.add({
        id: input.id,
        kind: input.kind,
        text: input.text,
        createdAtMs,
        expiresAtMs: createdAtMs + input.timeoutSeconds * MS_PER_SECOND,
        commentTimeoutMs: input.commentTimeoutSeconds * MS_PER_SECOND,
        messages,
      })
      return { ok: true, request }
    } finally {
      creating.delete(input.id)
    }
  }

  const get = (id: string): ApprovalRequest | undefined => {
    for (const request of store.sweep()) void rewriteMessages(request)
    return store.get(id)
  }

  const cancel = async (id: string): Promise<ApprovalRequest | undefined> => {
    await sweep()
    const result = store.cancel(id)
    if (result.outcome === 'not_found') return undefined
    if (result.outcome === 'cancelled') await rewriteMessages(result.request)
    return result.request
  }

  const askForComment = async (request: ApprovalRequest, chatId: number, messageId: number): Promise<void> => {
    await rewriteMessages(request)
    const prompt =
      `請「回覆」這則訊息寫下退回意見。` +
      `${describeCommentWindow(request.commentTimeoutMs)}內沒有回覆，會記為無意見退回。`
    try {
      store.addPrompt(request.id, { chatId, messageId: await api.sendPrompt(chatId, prompt, messageId) })
    } catch (err) {
      // The reviewer can still quote-reply to the request message itself.
      log(`telegram poller: approval ${request.id} comment prompt failed: ${err}`)
    }
  }

  const handleCallback = async (query: NonNullable<Update['callback_query']>): Promise<void> => {
    const match = CALLBACK_RE.exec(query.data ?? '')
    if (!match) return answer(query.id, INVALID_BUTTON_TEXT)
    // Authorised by who pressed, not by where the message sits: a forwarded or
    // group-visible message must not lend its buttons to someone else.
    if (!deps.loadAllowFrom().includes(String(query.from.id))) return answer(query.id, NOT_AUTHORIZED_TEXT)
    const message = query.message
    if (!message) return answer(query.id, INVALID_BUTTON_TEXT)

    await sweep()
    const action = match[1] as ApprovalAction
    const pressedOn: SentMessage = { chatId: message.chat.id, messageId: message.message_id }
    const result = store.press(match[2], action, pressedOn)

    if (result.outcome === 'not_found') return answer(query.id, NOT_FOUND_TEXT)
    if (!('request' in result)) return answer(query.id, INVALID_BUTTON_TEXT)
    if (result.outcome === 'already_settled') return answer(query.id, ALREADY_SETTLED_TEXT)
    if (result.outcome === 'awaiting_comment') {
      await answer(query.id, COMMENT_REQUESTED_TEXT)
      return askForComment(result.request, pressedOn.chatId, pressedOn.messageId)
    }
    await answer(query.id, DECIDED_LABELS[action])
    await rewriteMessages(result.request)
  }

  /** @returns true when the message was a comment (or an attempt at one) and is consumed. */
  const handleReply = async (message: NonNullable<Update['message']>): Promise<boolean> => {
    const repliedTo = message.reply_to_message
    if (!repliedTo || !message.from || message.from.is_bot) return false
    if (message.text?.startsWith(COMMAND_PREFIX)) return false
    await sweep()
    const target: SentMessage = { chatId: message.chat.id, messageId: repliedTo.message_id }
    const request = store.findAwaitingComment(target)
    const closed = request ? undefined : store.findClosedByPrompt(target)
    if (!request && !closed) return false
    // Not ours to swallow: an outsider's reply takes today's route, where
    // server.ts's gate applies the access policy as it always has.
    if (!deps.loadAllowFrom().includes(String(message.from.id))) return false

    // Too late: routing it would hand a session the prompt text plus an
    // orphaned comment, which reads like an instruction. Say so instead.
    if (!request) {
      await api.sendText(message.chat.id, COMMENT_TOO_LATE_TEXT).catch(err => {
        log(`telegram poller: approval ${closed?.id} late-comment notice failed: ${err}`)
      })
      return true
    }

    if (message.text === undefined) {
      await api.sendText(message.chat.id, TEXT_ONLY_COMMENT_TEXT).catch(err => {
        log(`telegram poller: approval ${request.id} text-only notice failed: ${err}`)
      })
      return true
    }
    const settled = store.recordComment(request.id, message.text)
    if (settled) await rewriteMessages(settled)
    return true
  }

  const interceptUpdate = async (update: Update): Promise<boolean> => {
    const query = update.callback_query
    if (query) {
      if (!query.data?.startsWith(APPROVAL_CALLBACK_PREFIX)) return false
      await handleCallback(query)
      return true
    }
    if (update.message) return handleReply(update.message)
    return false
  }

  const start = (): (() => void) => {
    const timer = setInterval(() => void sweep(), SWEEP_INTERVAL_MS)
    // unref: a bare interval would keep the process alive past a clean shutdown.
    timer.unref?.()
    return () => clearInterval(timer)
  }

  return { create, get, cancel, interceptUpdate, sweep, start }
}
