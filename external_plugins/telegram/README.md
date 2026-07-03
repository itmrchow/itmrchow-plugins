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

- **`/inject` HTTP endpoint** — `POST /inject` on `127.0.0.1:7842` (override with `INJECT_PORT`) delivers text from schedulers or other local processes into the session as a synthetic channel message. Body: `{"text": "...", "chat_id": "..."}`. Bound to loopback only.
- **External poller mode** — `poller.ts` runs Telegram long-polling as a standalone process and forwards raw updates to `POST /update` on the same port. Needed on aarch64 hosts, where the in-process long-poll loop starves under the MCP stdio watcher; on x86 the built-in poll works as-is.
- **Bot-layer control commands** — `/ctx` (context usage), `/clear` (clear context), `/restart` (restart the agent). The bot process drives these directly via tmux, so they keep working even when the agent is wedged or dead. Restricted to paired owners.
- **Startup notice** — after a restart, the bot messages the paired owner(s) that the agent is back, listing loaded plugin versions and flagging any that changed across the restart. Claimed atomically, so multi-channel setups send exactly one notice.
- **Busy-gate delivery** — inbound and scheduler messages are queued and flushed one at a time, only when the agent's pane is idle. Prevents mid-turn deliveries from orphaning unsubmitted in the input box.
- **Read receipt** — inbound messages get an emoji reaction (default 👀) as a "seen" ack. Configure via `ackReaction` in `access.json` (see [ACCESS.md](./ACCESS.md)); only Telegram's fixed emoji whitelist is accepted.
- **Orphan watchdog** — the server exits when its parent agent process dies (plus SIGHUP handling), so no stale bot process lingers holding the token.

## Tools exposed to the assistant

| Tool | Purpose |
| --- | --- |
| `reply` | Send to a chat. Takes `chat_id` + `text`, optionally `reply_to` (message ID) for native threading and `files` (absolute paths) for attachments. Images (`.jpg`/`.png`/`.gif`/`.webp`) send as photos with inline preview; other types send as documents. Max 50MB each. Auto-chunks text; files send as separate messages after the text. Returns the sent message ID(s). |
| `react` | Add an emoji reaction to a message by ID. **Only Telegram's fixed whitelist** is accepted (👍 👎 ❤ 🔥 👀 etc). |
| `edit_message` | Edit a message the bot previously sent. Useful for "working…" → result progress updates. Only works on the bot's own messages. |

Inbound messages trigger a typing indicator automatically — Telegram shows
"botname is typing…" while the assistant works on a response.

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
