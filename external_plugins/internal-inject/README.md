# internal-inject

A Claude Code channel with no messaging app behind it. Internal backend services
POST a message to a token-authenticated localhost endpoint, and it arrives in the
agent's session as a channel message.

There is **no IM gateway, no outbound path, and no reply tool**. The agent reports
back through the reply tool of whichever IM channel the caller names in
`reply_via` — so this plugin is only useful alongside a channel that has one
(telegram, discord).

[繁體中文](README.zh-TW.md)

## Contract

```http
POST /inject HTTP/1.1
Host: 127.0.0.1:7844
Authorization: Bearer <token>
Content-Type: application/json

{ "text": "<message>", "chat_id": "<target chat>", "reply_via": "telegram" }
```

All three body fields are required. The endpoint binds `127.0.0.1` only.

| Situation | HTTP | Body |
|---|---|---|
| Delivered | 200 | `ok` |
| `Authorization` missing, malformed, or token unknown | 401 | `unauthorized` |
| Body is not JSON | 400 | `invalid json` |
| Missing `text` / `chat_id` / `reply_via` | 400 | `missing text, chat_id or reply_via` |
| `chat_id` outside `[A-Za-z0-9_:-]{1,64}` | 400 | `invalid chat_id` |
| `reply_via` not `telegram` or `discord` | 400 | `invalid reply_via (expected: telegram, discord)` |
| Anything but `POST /inject` | 404 | `not found` |
| Body over 64 KiB | 413 | `payload too large` |

The message reaches the agent as:

```
<channel source="internal-inject" chat_id="..." reply_via="telegram" user="service:mgmt" user_id="service:mgmt" ts="...">
```

`chat_id` is validated against a whitelist because it is rendered as a tag
attribute. `reply_via` is validated against a whitelist because this plugin has no
reply tool: a typo would surface as an agent hunting for a tool that does not
exist, which is far more expensive to diagnose than a 400.

## Identity comes from the token

`user_id` is `service:<name>`, where `<name>` is looked up from the bearer token —
never read from the request body. A `service` field in the body is ignored: an
identity a caller asserts about itself is worth nothing.

## Tokens

`~/.claude/channels/internal-inject/tokens.json` (mode 0600), holding the **sha256
of each token, not the token itself**. This server only ever verifies a token, it
never has to present one, so the plaintext has no reason to be on disk — a leaked
file is then not a leaked credential.

```json
{
  "tokens": [
    { "service": "stock-monitor", "token_sha256": "9f86d0…", "issued_at": "2026-07-14T12:00:00Z" }
  ]
}
```

Issue tokens with the operator script in the deployment repo
(`claude-tg-agent`), which is the only thing that ever sees the plaintext:

```bash
bash scripts/internal-inject-token.sh issue stock-monitor   # prints the token once
bash scripts/internal-inject-token.sh list
bash scripts/internal-inject-token.sh revoke stock-monitor
```

It is deliberately **not** a plugin skill. A token-minting tool inside the agent's
own toolbox is a tool a prompt injection can talk the agent into using.

The file is re-read on every request, so issuing or revoking a token takes effect
without restarting the agent.

**A missing or broken `tokens.json` is not fatal.** The server warns, stays bound
to its port, and rejects every request with 401. Exiting would leave the inject
port unbound, which the `claude-tg-agent` watchdog reads as a dead agent — a
missing token file would otherwise turn into an endless restart loop.

## Configuration

| Env | Default | Purpose |
|---|---|---|
| `INTERNAL_INJECT_PORT` | `7844` | Port for the `/inject` listener. Must match `INTERNAL_INJECT_PORT` in `claude-tg-agent/scripts/lib-channels.sh`, which the watchdog probes. |
| `INTERNAL_INJECT_HOST` | `127.0.0.1` | Interface the `/inject` listener binds to. Defaults to loopback; binding beyond localhost (e.g. a VM-internal IP) is a deliberate deployment decision — the token is an identity, not a firewall, so a non-loopback bind must be paired with a network-level source restriction (JP-153/OP-8688). |
| `INTERNAL_INJECT_STATE_DIR` | `~/.claude/channels/internal-inject` | Where `tokens.json` lives. |

The token itself is **never** passed through the environment: the launcher exports
its `.env` into every channel plugin's MCP server, so an env-carried token would be
readable by the telegram and discord servers too.

## Development

```bash
bun install
bun test
```
