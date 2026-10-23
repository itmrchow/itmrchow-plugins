# Telegram

English | [繁體中文](./README.zh-TW.md)

Connect a Telegram bot to your Claude Code with an MCP server.

The MCP server logs into Telegram as a bot and provides tools to Claude to reply, react, or edit messages. When you message the bot, the server forwards the message to your Claude Code session.

## Prerequisites

- [Bun](https://bun.sh) — the MCP server runs on Bun. Install with `curl -fsSL https://bun.sh/install | bash`.

## Quick Setup
> Default pairing flow for a single-user DM bot. See [ACCESS.md](./ACCESS.md) for groups and multi-user setups.

**1. Create a bot with BotFather.**

Open a chat with [@BotFather](https://t.me/BotFather) on Telegram and send `/newbot`. BotFather asks for two things:

- **Name** — the display name shown in chat headers (anything, can contain spaces)
- **Username** — a unique handle ending in `bot` (e.g. `my_assistant_bot`). This becomes your bot's link: `t.me/my_assistant_bot`.

BotFather replies with a token that looks like `123456789:AAHfiqksKZ8...` — that's the whole token, copy it including the leading number and colon.

**2. Install the plugin.**

These are Claude Code commands — run `claude` to start a session first.

Install the plugin:
```
/plugin install telegram@itmrchow-plugins
/reload-plugins
```

**3. Give the server the token.**

```
/telegram:configure 123456789:AAHfiqksKZ8...
```

Writes `TELEGRAM_BOT_TOKEN=...` to `~/.claude/channels/telegram/.env` (this path when `$TELEGRAM_STATE_DIR` is unset; if set, the `.env` lives in that env-specified directory). You can also write that file by hand, or set the variable in your shell environment — shell takes precedence.

> To run multiple bots on one machine (different tokens, separate allowlists), point `TELEGRAM_STATE_DIR` at a different per-instance directory.

**4. Relaunch with the channel flag.**

The server won't connect without this — exit your session and start a new one:

```sh
claude --channels plugin:telegram@itmrchow-plugins
```

**5. Pair.**

With Claude Code running from the previous step, DM your bot on Telegram — it replies with a 6-character pairing code. If the bot doesn't respond, make sure your session is running with `--channels`. In your Claude Code session:

```
/telegram:access pair <code>
```

Your next DM reaches the assistant.

> Unlike Discord, there's no server invite step — Telegram bots accept DMs immediately. Pairing handles the user-ID lookup so you never touch numeric IDs.

**6. Lock it down.**

Pairing is for capturing IDs. Once you're in, switch to `allowlist` so strangers don't get pairing-code replies. Ask Claude to do it, or `/telegram:access policy allowlist` directly.

## Access control

See **[ACCESS.md](./ACCESS.md)** for DM policies, groups, mention detection, delivery config, skill commands, and the `access.json` schema.

Quick reference: IDs are **numeric user IDs** (get yours from [@userinfobot](https://t.me/userinfobot)). Default policy is `pairing`. `ackReaction` only accepts Telegram's fixed emoji whitelist.

## Fork additions

This fork extends the upstream plugin with operational features for running the bot as an always-on agent (e.g. inside a tmux session on a VM):

- **Subscription-based inbound (`poller.ts`)** — the standalone poller is the token's only `getUpdates` consumer. It works out which conversation each update belongs to, and pushes it over Server-Sent Events to whichever server process serves that conversation. The server binds no port of its own; it connects out to `127.0.0.1:7852` (override with `TELEGRAM_POLLER_PORT`) and reconnects with exponential backoff, so several conversations can each run their own agent session against one bot token.
  - `TELEGRAM_STATE_DIR` is **required by the poller** and has no default: it exits immediately when unset, so a stray or test run cannot inherit the default path and long-poll with the live bot token. The server process still defaults to `~/.claude/channels/telegram`.
  - `AGENT_SCOPE` names the conversation this process serves (e.g. `telegram-dm-12345`). Without a valid value the server still serves its MCP tools but receives no messages, and says so on stderr.
  - `MAX_SCOPES` (default 10) caps how many sessions may exist at once; over the cap, new senders get a "capacity full" reply rather than starting another agent.
  - `SCOPE_SPAWN_BIN` points at the host script that starts a session for a conversation that has none. Unset means no session is ever started, and senders are told the service is not fully configured.
  - The launcher (`launch.sh`, invoked from `.mcp.json`) picks the runtime: `tsx`(node) on arm64-linux, `bun` elsewhere.
  - Scheduled/synthetic message injection now belongs to the separate `internal-inject` channel; this plugin no longer listens on an inject port.
- **Bot-layer control commands** — `/ctx` (context usage), `/clear` (clear context), `/restart` (restart the agent). The bot process drives these directly via tmux, so they keep working even when the agent is wedged or dead. Restricted to paired owners. Set `TELEGRAM_CONTROL_COMMANDS` (comma-separated, e.g. `ctx,restart`) to narrow which of them the bot layer intercepts — the rest are relayed to the agent as ordinary messages, so a skill can give them its own meaning. Unset means all three, matching earlier behaviour.
- **Startup notice** — after a restart, the bot messages the paired owner(s) that the agent is back, listing loaded plugin versions and flagging any that changed across the restart. Claimed atomically, so multi-channel setups send exactly one notice.
- **Read receipt** — inbound messages get an emoji reaction (default 👀) as a "seen" ack. Configure via `ackReaction` in `access.json` (see [ACCESS.md](./ACCESS.md)); only Telegram's fixed emoji whitelist is accepted.
- **Orphan watchdog** — the server exits when its parent agent process dies (plus SIGHUP handling), so no stale bot process lingers holding the token.

## Re-authenticating Claude Code over IM (`/reauth`)

When the poller has `REAUTH_BIN` set (path to im-core `scripts/reauth.sh`), it
intercepts two commands before routing, so they never reach the agent:

- `/reauth` — admin, private chat only: starts `claude setup-token` on the host
  and DMs you the authorization link.
- `/authcode <code>` — paste the code shown after authorizing (within the time
  stated in the link message). Telegram deletes your message after reading it.

An edited message that reads as /reauth or /authcode is dropped (not run, no
reply, not routed to the agent). Send a new message instead.

Non-admins get no reply. Admins in a group are told to use a private chat. The
admin list, timers and every write to the host live in the im-core executor;
see im-core's README. Without `REAUTH_BIN` both commands route like any text.

## First line of every message (JP-379)

Messages the bot sends the user open with a fixed first line,
`[<status>] <session name>: <content>` (half-width brackets, half-width colon
and one space), so the user can tell at a glance which session a message
belongs to. Statuses come from a fixed list: `[等核准]` `[等 approve]` `[等你]`
`[已停下]` `[異常結束]` `[已被擋下]` `[等你回覆]` `[回報]` `[系統]`.

On every first line the plugin writes, the session name is shown with
half-width `:` `[` `]` replaced by full-width `：` `［` `］` (display only — such a
name is accepted, never refused). So the first `] ` and the first `: ` are
always the format's separators and a name like `x] y: git status` cannot pose
as the content: it shows as `[已被擋下] x］ y： git status: <summary>`. Callers
that write their own first line (unbound requests, see below) must apply the
same replacement. A session name is still not unique: never trust a message on
its first line alone.

What the plugin writes itself:

| Message | First line | Switch |
| --- | --- | --- |
| Blocked request (an approval request with a binding) | `[已被擋下] <session_name>: <summary>`, see "Binding" below | always on (part of the approval feature) |
| Reject-comment prompt, "reply with text" notice | `[等你回覆] <session_name>: ...` | always on |
| "Already closed, comment not recorded" notice | `[系統] <session_name>: ...` | always on |
| Poller notices (capacity full, cannot respond, not configured, reauth replies) | `[系統] tg-hub: ...` | `TELEGRAM_FIRST_LINE_FORMAT` |
| server.ts system replies (pairing, /start /help /status, /ctx /clear /restart, the startup notice) | `[系統] tg-hub: ...` | `TELEGRAM_FIRST_LINE_FORMAT` |
| server.ts permission relay | `[等核准] tg-hub: 權限確認 <tool_name>` (replaces `🔐 Permission: <tool_name>`; buttons and the outcome label unchanged) | `TELEGRAM_FIRST_LINE_FORMAT` |

Everything else is the caller's: an unbound approval request is sent exactly
as its `text` (the caller writes its own first line), and the session's own
`reply` / `edit_message` text is never touched. Outcome labels
(`[已允許]`, `[已在電腦處理]`, `[已逾時]`, ...) are still appended at the end; the
first line keeps the status the message was sent with.

| Variable | Default | Meaning |
| --- | --- | --- |
| `TELEGRAM_FIRST_LINE_FORMAT` | unset (off) | Read by both `poller.ts` and `server.ts`. `1` or `true` (trimmed, case-insensitive) adds the first line to the rows marked above; anything else leaves those messages exactly as before, so other bots sharing this plugin are unaffected. Set it on both processes. Each prints its reading at startup: `telegram poller: first-line format on|off (unset)|off (value is not 1 / true) (TELEGRAM_FIRST_LINE_FORMAT)` on stderr (`telegram channel:` for server.ts). |

## Replies straight to a session (session-direct mode)

Off by default, on both sides. When on, a DM that **quote-replies** to a message
some Claude session sent goes straight to that session instead of to the hub
(the conversation scope `telegram-dm-<user id>`). The session sees it as an
ordinary `<channel source="telegram">` message. In every other case the message
is routed exactly as before.

**How a reply is routed.** After the existing interceptions (`/reauth`
`/authcode`, then approval buttons and reject-comment replies), the poller goes
direct only when all of these hold; otherwise it routes as before:

- a new message (not an edit, not a button press) in a private chat, from a
  sender in `access.json` `allowFrom`, not starting with `/` (commands stay
  with the hub);
- it quote-replies to a message this bot sent, and that message's `message_id`
  is in the message map with a `session_id`. An entry that also records
  `chat_id` must match the chat (Telegram numbers messages per chat);
- that session's scope is subscribed right now and the write succeeds.

The poller never starts a session for this: an offline session means the hub
gets the message, and waking sessions stays the hub's job.

**Which sessions subscribe.** A server started with neither `AGENT_SCOPE` nor
`TELEGRAM_STATE_DIR` in its environment — which is how `claude --bg` and
`claude respawn` always start it — reads the pointer file below. When it is on,
the server uses the pointer's state dir (bot token, `access.json`, poller port
from its `.env`) and subscribes as `telegram-dm-s<session id, 32 hex>`, but only
once it is certain the session shows channel messages: its own claude process
was started with `--channels plugin:telegram@<marketplace>`, read from that
process's argv, or for a background session from Claude Code's job record. If
that cannot be told, it does not subscribe (a session without `--channels` would
ack every message and drop it silently). The hub and every carrier scope set
`AGENT_SCOPE`, so they never read the pointer and behave exactly as before.

In this mode the server does not declare the permission relay
(`claude/channel/permission`), skips the pairing confirmation and the startup
notice (the hub's server does those), and adds instructions asking the session
to start each reply with `[回報] <session_name>: ` (or `[等你回覆] ...` when it
needs an answer); every inbound tag carries `session_name`, read fresh from the
session's record.

Each message the session sends through `reply` (every chunk and attachment;
`edit_message` adds nothing) is appended to the message map in tg-send's line
format, `{message_id, session_id, session_name, sent_at}`, so a reply to it
comes back to the same session. A failed write is logged and never fails the
reply. The hub's own replies are not recorded, so replies to them stay with the
hub. When the same `message_id` appears more than once, the last valid line wins.

| Setting | Read by | Meaning |
| --- | --- | --- |
| `TELEGRAM_SESSION_DIRECT` | `poller.ts` (environment or `$TELEGRAM_STATE_DIR/.env`) | `1` / `true` turns routing on. Off also refuses every `telegram-dm-s…` subscription (HTTP 503), so a session configured on its own takes no slots. Startup prints `telegram poller: session-direct on (map <path>)\|off (<reason>)`. |
| `TELEGRAM_MESSAGE_MAP_FILE` | `poller.ts`, and `server.ts` in session-direct mode (from the pointer's `<stateDir>/.env`) | Absolute path of the message map (JSON Lines `{message_id, session_id, ...}`, optional `chat_id`). Required when the switch is on; no default. Put it in the state dir's `.env` so both processes read the same value: a background session never sees the poller's launch environment. The poller reads it incrementally (only bytes appended since the last lookup); malformed lines, including valid JSON without `message_id` / `session_id`, are skipped. |
| `~/.claude/channels/telegram-session-direct.json` | `server.ts` | `{"enabled": true, "stateDir": "<absolute path>"}`. A file, not an env var, because background and respawned sessions do not get the launch environment. Missing, invalid, or `enabled` not `true` = off. |

**Slots.** Session scopes do not count toward `MAX_SCOPES` when the poller
decides whether to start a session, so they can never lock the hub out. A new
session scope may subscribe only while the live total stays under `MAX_SCOPES`;
over it the poller answers 503, the session retries with backoff, and replies to
it reach the hub meanwhile.

Limits: the pointer and the "can show channel" check read Claude Code's own
files (`~/.claude/sessions/<pid>.json`, `~/.claude/jobs/*/state.json`), which are
not a public interface; if they change, sessions stop subscribing and replies go
to the hub. The message map is trusted as written by any local process, the same
boundary as the rest of this plugin. A session started by hand without
`--channels` stays on the hub; add `--channels plugin:telegram@<marketplace>` to
opt in.

## Approval requests over inline buttons (loopback interface)

Off by default. When the poller has `TELEGRAM_APPROVAL_BUTTONS` set to `1` or
`true`, a local process can ask the bot's owner a yes/no question as a Telegram
message with two buttons, and read back what was pressed.

The decision is made in Telegram and kept inside the poller process. The
interface below can create a request, read it, cancel it and consume a bound
approval — **there is no call that sets a decision**, and extra fields in a
request body are ignored.

### Environment variables (read by `poller.ts`, from the environment or `$TELEGRAM_STATE_DIR/.env`)

| Variable | Default | Meaning |
| --- | --- | --- |
| `TELEGRAM_APPROVAL_BUTTONS` | unset (off) | `1` or `true` (trimmed, case-insensitive) turns the feature on. Unset, empty, `0`, `false` and any other value leave it off. |
| `TELEGRAM_APPROVAL_TIMEOUT_SECONDS` | `86400` | How long a request waits for a button when the create call names no `timeout_seconds`. |
| `TELEGRAM_APPROVAL_COMMENT_TIMEOUT_SECONDS` | `300` | How long a "reject" waits for a written comment when the create call names no `comment_timeout_seconds`. |
| `TELEGRAM_POLLER_PORT` | `7852` | Existing variable; the interface lives on the poller's port. |
| `TELEGRAM_API_ROOT` | unset | Test hook: Bot API base URL, used to point the poller at a local fake. **Only a loopback host is accepted** (`127.0.0.1`, `localhost`, `[::1]`; `http` or `https`; no credentials in the URL; a trailing `/` is dropped), so the bot token cannot leave the machine through it. An accepted value prints `WARNING TELEGRAM_API_ROOT is set` on stderr at startup. Any other value — another host, an unparsable URL — is ignored: the poller prints `TELEGRAM_API_ROOT ignored (<reason>)` (never the value itself) and talks to Telegram's servers as usual. Independent of `TELEGRAM_APPROVAL_BUTTONS`. `server.ts` honours the same variable with the same rules (from its environment or state `.env`), so its tests can run without Telegram. |

Both timeouts accept fractions and must be above 0 and at most 604800 (7 days);
an unusable value falls back to the default with a warning on stderr.

With the switch off, the poller behaves exactly as before: the four paths
below answer the server's ordinary `404 not found` (plain text), no update is
intercepted, `access.json` is not read and no state file is written. `server.ts`
is unchanged by this feature, so any mix of poller and server versions is fine.

### Calls

Base URL: `http://127.0.0.1:<TELEGRAM_POLLER_PORT>` (bound to loopback only, no
authentication). A request carrying an `Origin` header — which is what a web
page sends — is refused with `403 {"error":"forbidden_origin"}`; `curl` and
scripts do not send one. Bodies and replies are JSON (`content-type: application/json`);
the only non-JSON reply is the plain-text `404 not found` you get when the
feature is off.

**Create — `POST /approvals`**

| Body field | Required | Meaning |
| --- | --- | --- |
| `id` | yes | Chosen by the caller. `[A-Za-z0-9_-]{1,40}`. **Must be unpredictable** — see "Rules for callers". |
| `text` | yes | Message shown to the user. Non-blank, at most 3500 characters. Sent as plain text (no `parse_mode`), so no escaping is needed. |
| `kind` | yes | `allow_deny` (buttons 允許 / 拒絕) or `approve_reject` (buttons approve / 退回). |
| `timeout_seconds` | no | Number, `0 < n <= 604800`. |
| `comment_timeout_seconds` | no | Number, `0 < n <= 604800`. |
| `binding_session` | with `binding_subject` | The caller's session id, `[A-Za-z0-9_-]{1,128}` (so it can hold no newline). |
| `binding_subject` | with `binding_session` | What the approval is for — for a Bash call, the full command. Non-blank. Send both binding fields or neither; neither = unbound, never consumable. A `binding_key` in the body is ignored: the caller cannot choose the key. |
| `session_name` | no | (JP-379) The session the request belongs to, as `claude agents --json` / ListAgents shows it. A string of at most 3500 characters with no line break or control character (C0 incl. tab / CR / LF, DEL, C1, U+2028 / U+2029, zero-width and bidi characters, and the invisible U+00AD / U+061C / U+180E / U+E0000-E007F; one shared list with the binding block's escaping, see `invisible-chars.ts`): anything else is refused with `400` (bound or not, any `kind`), never cut or cleaned. Absent, `null`, empty or spaces-only = `tg-hub`. Shown with `:` `[` `]` turned full-width. Used on the first line of a blocked request and of the request's follow-up messages; stored with the request, so it survives a poller restart. Not returned by the query. |

**Binding (JP-374).** For a bound request the poller derives the key itself,
`sha256(binding_session + "\n" + binding_subject)` (hex), and shows the subject
in a block it writes at the **top** of the message, before the caller's `text`.
A bound request is a blocked action (JP-379), so the poller also writes the
first line, entirely by itself — nothing the caller sends can reach it:

```
[已被擋下] <session_name>: <summary>
【綁定內容】由 poller 顯示，每行以「┃ 」開頭，機密已遮罩：
┃ <subject, line 1>
┃ <subject, line 2>
────────────
<text>
```

For example, `session_name: "OP-8820"`, `binding_subject: "git push --force origin main"`,
`text: "分類器擋下了這個指令"`:

```
[已被擋下] OP-8820: git push --force origin main
【綁定內容】由 poller 顯示，每行以「┃ 」開頭，機密已遮罩：
┃ git push --force origin main
────────────
分類器擋下了這個指令
```

- `<summary>` is every non-blank line of the masked subject, in order, joined
  into one line with ` ⏎ ` (space, U+23CE, space), then cut to 200 characters
  (code points) with `…`. When the subject has several non-blank lines and the
  cut hid some of them, `（共 N 行）` follows (N = non-blank lines); uncut, all
  lines are already shown and no count is added. Blank lines, a trailing
  newline included, do not count. For example subject `ls` + newline +
  `rm -rf ~` shows `[已被擋下] OP-8820: ls ⏎ rm -rf ~`; a 250-character first
  line plus `rm -rf ~` shows the first 200 characters, then `…（共 2 行）`. A
  literal `⏎` inside the subject cannot be told apart from the separator; it is
  still the bound content itself, never caller text. The block below always
  shows the whole subject, line by line.

- Every subject line starts with `┃ `, so nothing in `text` (a look-alike
  block, a fake separator) can pass for part of the subject, and a subject line
  that looks like the separator still carries the marker.
- Secrets are masked first, with the same rules as tg-notify's permission
  notice (`secret-mask.ts`); then control, zero-width and bidi characters are
  written out as `[U+XXXX]` so they cannot hide or reorder what is shown. The
  key is computed from the raw subject, so two subjects that differ only inside
  a masked secret get different keys but look the same.
- Masking can also hide a part that is not a secret: `TOKEN=$(some command)`
  shows as `TOKEN=*** command)`. A `***` where no secret is expected is a reason
  to deny.
- The raw subject is not stored: the poller keeps the key and the masked
  display only.
- The message is never cut: if the first line, the block and `text` together
  do not fit in one Telegram message (4096 characters), the create is refused
  with `400`.

| Reply | Body | When |
| --- | --- | --- |
| `201` | the request (see below), `status: "pending"` | Sent to at least one recipient. |
| `400` | `{"error":"invalid_request","detail":"..."}` | Missing / invalid field (including a `session_name` with a line break or control character), a bound message that would not fit in one Telegram message, malformed JSON, or a body over 32 KB. Nothing was sent. |
| `409` | `{"error":"duplicate_id","request":{...}}` | The id exists. The existing request is returned untouched (never reset, never re-sent). `request` is absent only if the same id is still being created. **This is not your request** — see "Rules for callers". |
| `502` | `{"error":"telegram_send_failed"}` | Telegram refused every send. Nothing is stored; the id stays free. |
| `503` | `{"error":"no_recipient"}` | `access.json` has no `allowFrom` entry (or is unreadable). |
| `503` | `{"error":"too_many_requests"}` | 200 requests are already held. |
| `404` plain text `not found` | | The feature is off (or the poller predates it). |

#### Rules for callers

Any local process can call this interface, and the id is picked by the caller.
Two rules keep someone else's request from being mistaken for yours:

1. **Generate an unpredictable id per request** — at least 128 bits of
   randomness, e.g. `appr_$(openssl rand -hex 16)` or a UUID without dashes.
   Put anything human-readable (ticket key, PR number) in `text`, never in `id`.
   A guessable id such as `spec-<ticket>` lets another process create that id
   first with harmless-looking text; the user approves *that* text, and a caller
   that then reads the id would take the approval as its own.
2. **`409` means the request is not yours.** Do not poll it, do not use its
   result, do not cancel it. Treat the create as failed and retry with a fresh
   id. Only ever `GET` or cancel an id for which *you* received `201`
   (when resuming a wait, use the id you stored at that moment).

The message goes to the DM of **every** user in `access.json`'s `allowFrom`;
the first decision wins and every copy is rewritten to the outcome.

**Query — `GET /approvals/<id>`**

`200` with the request, or `404 {"error":"not_found"}` (never created, creation
failed, state file lost, or dropped 24 hours after it settled).

```json
{
  "id": "appr_3f9c1e7a5b2d4c6e8a0b1d2f3a4c5e6f",
  "kind": "approve_reject",
  "status": "denied",
  "decision": "reject",
  "comment": "narrow the scope, drop X",
  "created_at_ms": 1790927386899,
  "expires_at_ms": 1791013786899,
  "resolved_at_ms": 1790927400000
}
```

A bound request carries its key back as one more field, `"binding_key": "<key>"`,
in every reply that returns the request (never the subject). An unbound request
has exactly the fields above.

| `status` | Meaning | `decision` | `comment` |
| --- | --- | --- | --- |
| `pending` | Waiting for a button. | `null` | `null` |
| `awaiting_comment` | 退回 was pressed; waiting for the written comment. Not final yet — keep polling. It can only end as `denied` or `cancelled`. | `reject` | `null` |
| `approved` | 允許 or approve was pressed. | `allow` / `approve` | `null` |
| `denied` | 拒絕 was pressed, or a 退回 was completed. | `deny` / `reject` | `null` for `deny`; for `reject` the comment text, or `""` when none came in time |
| `cancelled` | Cancelled through this interface. | `null` | `null` |
| `expired` | Nobody pressed a button in time. | `null` | `null` |
| `consumed` | Was `approved`, then used up through Consume. Final; no longer counts as approved. | `allow` / `approve` (the button that approved it, kept as the record) | `null` |

Judge by `status`, not by `decision`: a `consumed` request still shows the
button that approved it.

**Cancel — `POST /approvals/<id>/cancel`** (no body needed)

| Reply | When |
| --- | --- |
| `200` with the request, `status: "cancelled"` | It was `pending` or `awaiting_comment`. The Telegram message is rewritten to `[已在電腦處理]` and loses its buttons. |
| `200` with the request, status unchanged | It had already settled (`approved` / `denied` / `expired` / `cancelled` / `consumed`). The result is kept and the message is not touched, so repeating a cancel is safe. |
| `404 {"error":"not_found"}` | Unknown id. |

**Consume — `POST /approvals/<id>/consume`** (JP-374)

Uses up an approval once. Body: `{"binding_session":"...","binding_subject":"..."}`
(both required, same format as on create; other fields, `binding_key` included,
are ignored). The poller recomputes the key from them; the check and the change
are one step: the request turns `consumed` only if that key equals the stored
one **and** its status is `approved`. Consume can only take an
approval away — it never produces `approved`. The Telegram message is not
touched.

| Reply | When |
| --- | --- |
| `200` with the request, `status: "consumed"` | It was `approved` for this session and subject. It now no longer counts as approved. |
| `409 {"error":"binding_mismatch","request":{...}}` | The request is unbound, or was bound to another session or subject (one character is enough). Nothing changed — an approval cannot be borrowed for something else. |
| `409 {"error":"already_consumed","request":{...}}` | It was consumed before. |
| `409 {"error":"not_approved","request":{...}}` | It is `pending`, `awaiting_comment`, `denied`, `cancelled` or `expired`. Nothing changed. |
| `503 {"error":"persist_failed","request":{...}}` | It was `approved` for this session and subject, but the state file could not be written. **Do not act on the approval.** It stays used up while the poller runs; after a restart it may read `approved` again (the last saved state) and can then be consumed once. Either way it is used at most once. |
| `400 {"error":"invalid_request","detail":"..."}` | Missing / invalid `binding_session` or `binding_subject`, malformed JSON, or a body over 32 KB. |
| `404 {"error":"not_found"}` | Unknown id. |

The checks run in that order (key, then consumed, then approved). An approved
request that is never consumed stays `approved` until it is dropped, 24 hours
after the button was pressed. Only `200` means the caller may go ahead.

Any local process that knows the session id and the subject can consume an
approval it did not ask for. That only ever takes an approval away (the real
caller then gets `already_consumed` and does not proceed); it cannot grant one.
What it cannot do is get the user to approve one thing and consume the approval
for another: the subject the key stands for is the one shown at the top of the
message the user pressed on.

**Anything else** under `/approvals`: a known path with the wrong method answers
`405 {"error":"method_not_allowed"}`; an unknown path answers
`404 {"error":"not_found"}`.

```sh
curl -s -X POST http://127.0.0.1:7852/approvals \
  -d '{"id":"appr_3f9c1e7a5b2d4c6e8a0b1d2f3a4c5e6f","text":"JP-123 Spec 可以 approve 嗎？","kind":"approve_reject"}'
curl -s http://127.0.0.1:7852/approvals/appr_3f9c1e7a5b2d4c6e8a0b1d2f3a4c5e6f
curl -s -X POST http://127.0.0.1:7852/approvals/appr_3f9c1e7a5b2d4c6e8a0b1d2f3a4c5e6f/cancel
curl -s -X POST http://127.0.0.1:7852/approvals/appr_3f9c1e7a5b2d4c6e8a0b1d2f3a4c5e6f/consume \
  -d '{"binding_session":"<session id>","binding_subject":"<the subject sent on create>"}'
```

### What the user sees, and what counts as a decision

- A button only counts when the person pressing it is in `allowFrom` (the
  presser is checked, not the chat), the button belongs to that request's
  `kind`, and it sits on a message the poller sent for that request. Anything
  else is answered and ignored.
- Once a request has left `pending`, later presses change nothing — including
  approve after 退回.
- 允許 / 拒絕 / approve settle at once; the message becomes the original text
  plus `[已允許]`, `[已拒絕]` or `[已 approve]`, without buttons.
- 退回 moves the request to `awaiting_comment` and the bot sends a prompt asking
  for a reply. The comment is the text of a **quote-reply** to that prompt (or to
  the request message) from someone in `allowFrom`. That reply is consumed by
  the poller and is **not** delivered to any session. A non-text reply gets
  "[等你回覆] <session_name>: 請用文字回覆意見。" and the wait continues. No reply within the comment
  timeout settles it as `denied` with `comment: ""`.
- A reply that starts with `/` is never a comment: it is routed as usual, so
  bot commands such as `/restart` keep working while a comment is awaited.
- A quote-reply to the prompt that arrives after the request has settled
  (comment timeout, cancel) is not recorded and not delivered to a session; the
  bot answers "[系統] <session_name>: 這筆請求已經結案，這則意見沒有被記錄。".
- Ordinary messages, replies to anything else, and other callback data
  (`perm:` permission buttons included) are routed to sessions as before.
- An expired request's message becomes `[已逾時]`.
- A failed message edit never undoes a decision; the query result is the record.

### Restarts and state

Requests are mirrored to `$TELEGRAM_STATE_DIR/approvals.json` (mode 0600,
written and fsynced before the Telegram message is updated; a failed write is
logged and the in-memory result still stands until the next restart — except
for Consume, which answers `503 persist_failed` instead of `200`), read only by
the poller. After
a poller restart, results are kept and pending requests stay answerable through
their original buttons — nothing is re-sent. A button pressed while the poller
was down is handled when it comes back; a request whose deadline passed
meanwhile becomes `expired`. If the file is missing or unreadable the poller
starts with no requests (the unreadable file is kept as
`approvals.json.corrupt-<timestamp>`), so earlier ids answer `not_found`.
The binding key, the masked display and `consumed` are kept across restarts like every other field.
A file written before JP-374 loads as-is (its requests are unbound); a poller
older than JP-374 reading a file that holds a `consumed` request treats the file
as unreadable and starts empty — never as approved.

## Tools exposed to the assistant

| Tool | Purpose |
| --- | --- |
| `reply` | Send to a chat. Takes `chat_id` + `text`, optionally `reply_to` (message ID) for native threading and `files` (absolute paths) for attachments. Images (`.jpg`/`.png`/`.gif`/`.webp`) send as photos with inline preview; other types send as documents. Max 50MB each. Auto-chunks text; files send as separate messages after the text. Returns the sent message ID(s). |
| `react` | Add an emoji reaction to a message by ID. **Only Telegram's fixed whitelist** is accepted (👍 👎 ❤ 🔥 👀 etc). |
| `edit_message` | Edit a message the bot previously sent. Useful for "working…" → result progress updates. Only works on the bot's own messages. |

Inbound messages trigger a typing indicator automatically — Telegram shows
"botname is typing…" while the assistant works on a response.

## Inbound message fields

Each inbound message arrives as a `<channel source="telegram" ...>` notification
whose attributes carry structured metadata:

| Field | Meaning |
| --- | --- |
| `chat_id` | Chat ID — pass it back to `reply`. |
| `message_id` | ID of this message — usable as `reply_to` for native threading. |
| `user` / `user_id` | Sender's username (or numeric ID when no username) and numeric ID. |
| `ts` | ISO 8601 timestamp. |
| `image_path` | Present when the message has a photo — local path to `Read`. |
| `attachment_kind` / `attachment_file_id` / `attachment_size` / `attachment_mime` / `attachment_name` | Present when the message has a non-photo attachment — pass `attachment_file_id` to `download_attachment`. |
| `reply_to_message_id` | Present when the sender quote-replied — ID of the referenced message. |
| `reply_to_user` | Author of the referenced message (`me` = the bot itself). |
| `reply_to_text` | Full body of the referenced message. |

The quote-reply reference lives in metadata (not message text) so it can't be
forged by a sender typing a look-alike string. Field names mirror the Discord
channel, but the body-delivery strategy differs: Discord's gateway payload omits
the quoted body (so it carries only the ID + author, and the assistant calls
`get_message` on demand), whereas Telegram embeds the full referenced message in
the same update and exposes no history API — so `reply_to_text` ships the
**complete** quoted body up front (no fetch, no truncated preview).
`reply_to_user`, `reply_to_text`, and `user` are sender-controlled: control
chars (incl. newlines) collapse to spaces and `"`/`<`/`>` become look-alikes so
the value can't break the single-line `<channel>` tag.

## Photos

Inbound photos are downloaded to `~/.claude/channels/telegram/inbox/` (this path when `$TELEGRAM_STATE_DIR` is unset; if set, the `inbox/` lives under that env-specified directory) and the
local path is included in the `<channel>` notification so the assistant can
`Read` it. Telegram compresses photos — if you need the original file, send it
as a document instead (long-press → Send as File).

## No history or search

Telegram's Bot API exposes **neither** message history nor search. The bot
only sees messages as they arrive — no `fetch_messages` tool exists. If the
assistant needs earlier context, it will ask you to paste or summarize.

This also means there's no `download_attachment` tool for historical messages
— photos are downloaded eagerly on arrival since there's no way to fetch them
later.
