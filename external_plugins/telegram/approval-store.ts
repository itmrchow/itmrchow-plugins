/**
 * Approval requests and the decisions made on them (JP-315).
 *
 * The decision lives here, inside the poller process, and nowhere else: there
 * is deliberately NO method that sets a request to approved or denied from a
 * caller-supplied value. The only ways a request leaves `pending` are a button
 * press, a written comment, a cancel and the clock — and the first two are only
 * ever called from the Telegram update path. That is what keeps a session from
 * approving its own request: the loopback interface can reach create(), get()
 * and cancel(), none of which can produce `approved`.
 *
 * IO is limited to the one state file, so every transition can be pinned by
 * plain tests with an injected clock.
 */
import { chmodSync, existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'

export type ApprovalKind = 'allow_deny' | 'approve_reject'
export type ApprovalAction = 'allow' | 'deny' | 'approve' | 'reject'
export type ApprovalStatus =
  | 'pending'
  | 'awaiting_comment'
  | 'approved'
  | 'denied'
  | 'cancelled'
  | 'expired'

/** One Telegram message this request owns. */
export type SentMessage = { chatId: number; messageId: number }

export type ApprovalRequest = {
  id: string
  kind: ApprovalKind
  text: string
  status: ApprovalStatus
  /** The button that settled it; null until one does, and for cancelled / expired. */
  decision: ApprovalAction | null
  /** The reviewer's comment on a reject; '' when none came, null otherwise. */
  comment: string | null
  createdAtMs: number
  expiresAtMs: number
  commentTimeoutMs: number
  /** Set when reject is pressed: the moment the reject stands without a comment. */
  commentDeadlineMs: number | null
  resolvedAtMs: number | null
  /** The request message, one copy per recipient. */
  messages: SentMessage[]
  /** "Reply with your comment" prompts sent after a reject. */
  prompts: SentMessage[]
}

export type NewApproval = Pick<
  ApprovalRequest,
  'id' | 'kind' | 'text' | 'createdAtMs' | 'expiresAtMs' | 'commentTimeoutMs' | 'messages'
>

export type PressOutcome =
  | { outcome: 'resolved' | 'awaiting_comment' | 'already_settled'; request: ApprovalRequest }
  | { outcome: 'not_found' | 'wrong_action' | 'wrong_message' }

export type CancelOutcome =
  | { outcome: 'cancelled' | 'unchanged'; request: ApprovalRequest }
  | { outcome: 'not_found' }

/** Buttons each kind offers; a press outside this set is forged or stale. */
export const ACTIONS_BY_KIND: Readonly<Record<ApprovalKind, readonly ApprovalAction[]>> = {
  allow_deny: ['allow', 'deny'],
  approve_reject: ['approve', 'reject'],
}

const APPROVING_ACTIONS: ReadonlySet<ApprovalAction> = new Set(['allow', 'approve'])
const OPEN_STATUSES: ReadonlySet<ApprovalStatus> = new Set(['pending', 'awaiting_comment'])
const ALL_STATUSES: ReadonlySet<string> = new Set([
  'pending', 'awaiting_comment', 'approved', 'denied', 'cancelled', 'expired',
])
/** Every button there is, derived from the kinds so the two cannot drift apart. */
export const ALL_ACTIONS: readonly ApprovalAction[] = Object.values(ACTIONS_BY_KIND).flat()
const KNOWN_ACTIONS: ReadonlySet<string> = new Set(ALL_ACTIONS)

const STATE_FILE_VERSION = 1
const STATE_FILE_MODE = 0o600
/** Settled requests stay queryable this long, then are dropped so the file stays small. */
export const SETTLED_RETENTION_MS = 86_400_000
const NO_COMMENT = ''

type StateFile = { version: number; requests: ApprovalRequest[] }

/**
 * Tell an open request from a settled one.
 *
 * @param status - A request status.
 * @returns true while the request can still be decided, commented on or cancelled.
 */
export function isOpenStatus(status: ApprovalStatus): boolean {
  return OPEN_STATUSES.has(status)
}

function isSentMessageList(value: unknown): value is SentMessage[] {
  return (
    Array.isArray(value) &&
    value.every(
      entry =>
        typeof entry === 'object' && entry !== null &&
        typeof (entry as SentMessage).chatId === 'number' &&
        typeof (entry as SentMessage).messageId === 'number',
    )
  )
}

function isNumberOrNull(value: unknown): value is number | null {
  return value === null || typeof value === 'number'
}

function isApprovalRequest(value: unknown): value is ApprovalRequest {
  if (typeof value !== 'object' || value === null) return false
  const request = value as Record<string, unknown>
  return (
    typeof request.id === 'string' &&
    typeof request.kind === 'string' && Object.hasOwn(ACTIONS_BY_KIND, request.kind) &&
    typeof request.text === 'string' &&
    typeof request.status === 'string' && ALL_STATUSES.has(request.status) &&
    (request.decision === null || (typeof request.decision === 'string' && KNOWN_ACTIONS.has(request.decision))) &&
    (request.comment === null || typeof request.comment === 'string') &&
    typeof request.createdAtMs === 'number' &&
    typeof request.expiresAtMs === 'number' &&
    typeof request.commentTimeoutMs === 'number' &&
    isNumberOrNull(request.commentDeadlineMs) &&
    isNumberOrNull(request.resolvedAtMs) &&
    isSentMessageList(request.messages) &&
    isSentMessageList(request.prompts)
  )
}

function ownsMessage(messages: readonly SentMessage[], target: SentMessage): boolean {
  return messages.some(sent => sent.chatId === target.chatId && sent.messageId === target.messageId)
}

/**
 * The poller's approval requests, kept in memory and mirrored to one state file
 * so they outlive a poller restart.
 */
export class ApprovalStore {
  readonly #requests = new Map<string, ApprovalRequest>()
  readonly #filePath: string
  readonly #now: () => number
  readonly #log: (line: string) => void

  /**
   * Open the store, loading whatever the state file holds.
   *
   * @param opts.filePath - State file. Read once here, rewritten on every change.
   * @param opts.now - Clock in epoch milliseconds; injectable for tests.
   * @param opts.log - Sink for load / save problems.
   */
  constructor(opts: { filePath: string; now?: () => number; log?: (line: string) => void }) {
    this.#filePath = opts.filePath
    this.#now = opts.now ?? Date.now
    this.#log = opts.log ?? (line => void process.stderr.write(`${line}\n`))
    this.#load()
  }

  /**
   * Look a request up by id.
   *
   * @param id - Request id.
   * @returns The request, or undefined when unknown.
   */
  get(id: string): ApprovalRequest | undefined {
    return this.#requests.get(id)
  }

  /**
   * Count the requests held, for the capacity check.
   *
   * @returns Number of requests currently held, settled ones included.
   */
  size(): number {
    return this.#requests.size
  }

  /**
   * Record a request whose message has already gone out. Always starts `pending`.
   *
   * @param input - The request as created.
   * @returns The stored request.
   * @throws When the id is already taken — the caller must check first, so an
   *   existing decision can never be overwritten.
   */
  add(input: NewApproval): ApprovalRequest {
    if (this.#requests.has(input.id)) throw new Error(`approval ${input.id} already exists`)
    const request: ApprovalRequest = {
      ...input,
      status: 'pending',
      decision: null,
      comment: null,
      commentDeadlineMs: null,
      resolvedAtMs: null,
      prompts: [],
    }
    this.#requests.set(request.id, request)
    this.#save()
    return request
  }

  /**
   * Apply a button press. Called only from the Telegram callback_query path.
   *
   * @param id - Request id carried in the callback data.
   * @param action - Button carried in the callback data.
   * @param pressedOn - The message the button was attached to.
   * @returns What the press did. Anything but `resolved` / `awaiting_comment`
   *   left the request untouched.
   */
  press(id: string, action: ApprovalAction, pressedOn: SentMessage): PressOutcome {
    const request = this.#requests.get(id)
    if (!request) return { outcome: 'not_found' }
    if (!ACTIONS_BY_KIND[request.kind].includes(action)) return { outcome: 'wrong_action' }
    if (!ownsMessage(request.messages, pressedOn)) return { outcome: 'wrong_message' }
    if (request.status !== 'pending') return { outcome: 'already_settled', request }

    request.decision = action
    if (action === 'reject') {
      request.status = 'awaiting_comment'
      request.commentDeadlineMs = this.#now() + request.commentTimeoutMs
      this.#save()
      return { outcome: 'awaiting_comment', request }
    }
    request.status = APPROVING_ACTIONS.has(action) ? 'approved' : 'denied'
    request.resolvedAtMs = this.#now()
    this.#save()
    return { outcome: 'resolved', request }
  }

  /**
   * Find the request that is waiting for a comment and owns the given message
   * (its request message or its comment prompt).
   *
   * @param repliedTo - The message a user quote-replied to.
   * @returns The waiting request, or undefined.
   */
  findAwaitingComment(repliedTo: SentMessage): ApprovalRequest | undefined {
    for (const request of this.#requests.values()) {
      if (request.status !== 'awaiting_comment') continue
      if (ownsMessage(request.messages, repliedTo) || ownsMessage(request.prompts, repliedTo)) return request
    }
    return undefined
  }

  /**
   * Find the request whose comment window has closed but whose comment prompt
   * is the given message — a reply that arrived too late.
   *
   * @param repliedTo - The message a user quote-replied to.
   * @returns The no-longer-waiting request, or undefined.
   */
  findClosedByPrompt(repliedTo: SentMessage): ApprovalRequest | undefined {
    for (const request of this.#requests.values()) {
      if (request.status !== 'awaiting_comment' && ownsMessage(request.prompts, repliedTo)) return request
    }
    return undefined
  }

  /**
   * Remember a comment prompt so a reply to it can be matched back.
   *
   * @param id - Request id.
   * @param prompt - The prompt message that was sent.
   */
  addPrompt(id: string, prompt: SentMessage): void {
    const request = this.#requests.get(id)
    if (!request || request.status !== 'awaiting_comment') return
    request.prompts.push(prompt)
    this.#save()
  }

  /**
   * Settle a rejected request with the reviewer's comment. Called only from the
   * Telegram reply path.
   *
   * @param id - Request id.
   * @param comment - The comment text.
   * @returns The settled request, or undefined when it was not waiting for one.
   */
  recordComment(id: string, comment: string): ApprovalRequest | undefined {
    const request = this.#requests.get(id)
    if (!request || request.status !== 'awaiting_comment') return undefined
    request.status = 'denied'
    request.comment = comment
    request.resolvedAtMs = this.#now()
    this.#save()
    return request
  }

  /**
   * Cancel a request that is still open. A settled request keeps its result.
   *
   * @param id - Request id.
   * @returns Whether anything changed.
   */
  cancel(id: string): CancelOutcome {
    const request = this.#requests.get(id)
    if (!request) return { outcome: 'not_found' }
    if (!isOpenStatus(request.status)) return { outcome: 'unchanged', request }
    request.status = 'cancelled'
    request.decision = null
    request.resolvedAtMs = this.#now()
    this.#save()
    return { outcome: 'cancelled', request }
  }

  /**
   * Apply the clock: expire overdue pending requests, settle rejects whose
   * comment never came, and drop settled requests past their retention.
   *
   * @returns Requests that changed status in this call, each exactly once.
   */
  sweep(): ApprovalRequest[] {
    const now = this.#now()
    const changed: ApprovalRequest[] = []
    let dropped = false
    for (const request of this.#requests.values()) {
      if (request.status === 'pending' && now >= request.expiresAtMs) {
        request.status = 'expired'
        request.resolvedAtMs = now
        changed.push(request)
        continue
      }
      if (request.status === 'awaiting_comment' && now >= (request.commentDeadlineMs ?? 0)) {
        request.status = 'denied'
        request.comment = NO_COMMENT
        request.resolvedAtMs = now
        changed.push(request)
        continue
      }
      if (request.resolvedAtMs !== null && now - request.resolvedAtMs >= SETTLED_RETENTION_MS) {
        this.#requests.delete(request.id)
        dropped = true
      }
    }
    if (changed.length > 0 || dropped) this.#save()
    return changed
  }

  #load(): void {
    if (!existsSync(this.#filePath)) return
    try {
      const parsed = JSON.parse(readFileSync(this.#filePath, 'utf8')) as Partial<StateFile>
      if (parsed.version !== STATE_FILE_VERSION || !Array.isArray(parsed.requests)) {
        throw new Error('unexpected shape')
      }
      if (!parsed.requests.every(isApprovalRequest)) throw new Error('invalid request entry')
      for (const request of parsed.requests) this.#requests.set(request.id, request)
    } catch (err) {
      // Starting empty is the safe direction: a request nobody can find is
      // answered "not found", never "approved". The bad file is moved aside
      // rather than overwritten so it can still be inspected.
      this.#requests.clear()
      const aside = `${this.#filePath}.corrupt-${this.#now()}`
      this.#log(`telegram poller: approvals state unreadable (${err}), moving to ${aside} and starting empty`)
      try {
        renameSync(this.#filePath, aside)
      } catch {}
    }
  }

  // Synchronous and atomic (tmp + rename), and called before the Telegram
  // message is rewritten: in the normal case a decision is on disk before the
  // user is shown it, so a crash in between cannot bring it back as pending.
  //
  // A failed write (disk full, permissions) is only logged: the decision stands
  // in memory and the message is still rewritten. If the poller then restarts,
  // that request comes back in its last saved state — never as approved, since
  // nothing but a button press writes that. There is no fsync either, so power
  // loss can likewise roll a request back to its previous saved state.
  #save(): void {
    const state: StateFile = { version: STATE_FILE_VERSION, requests: [...this.#requests.values()] }
    const tmp = `${this.#filePath}.tmp`
    try {
      writeFileSync(tmp, JSON.stringify(state), { mode: STATE_FILE_MODE })
      chmodSync(tmp, STATE_FILE_MODE)
      renameSync(tmp, this.#filePath)
    } catch (err) {
      this.#log(`telegram poller: approvals state save failed: ${err}`)
    }
  }
}
