# internal-inject

背後沒有任何通訊軟體的 Claude Code channel。內部後端服務把訊息 POST 到一個需要
token 認證的 localhost endpoint，訊息就會以 channel message 的形式進到 agent 的
session。

**沒有 IM gateway、沒有 outbound、沒有 reply tool**。agent 要回報時，用 caller 在
`reply_via` 指定的那個 IM channel 的 reply tool —— 所以本 plugin 必須搭配一個有
reply tool 的 channel（telegram / discord）才有用。

[English](README.md)

## 契約

```http
POST /inject HTTP/1.1
Host: 127.0.0.1:7844
Authorization: Bearer <token>
Content-Type: application/json

{ "text": "<訊息內容>", "chat_id": "<目標對話 id>", "reply_via": "telegram" }
```

三個 body 欄位都是必填。endpoint 只綁 `127.0.0.1`。

| 狀況 | HTTP | body |
|---|---|---|
| 投遞成功 | 200 | `ok` |
| `Authorization` 缺少 / 格式錯 / token 不在表內 | 401 | `unauthorized` |
| body 不是合法 JSON | 400 | `invalid json` |
| 缺 `text` / `chat_id` / `reply_via` | 400 | `missing text, chat_id or reply_via` |
| `chat_id` 不符 `[A-Za-z0-9_:-]{1,64}` | 400 | `invalid chat_id` |
| `reply_via` 不是 `telegram` 或 `discord` | 400 | `invalid reply_via (expected: telegram, discord)` |
| 非 `POST /inject` | 404 | `not found` |
| body 超過 64 KiB | 413 | `payload too large` |

訊息進到 agent 的形狀：

```
<channel source="internal-inject" chat_id="..." reply_via="telegram" user="service:mgmt" user_id="service:mgmt" ts="...">
```

`chat_id` 走白名單正則，因為它會被渲染成 tag 的 attribute。`reply_via` 走白名單，
是因為本 plugin 沒有 reply tool：打錯字的症狀是 agent 去找一個不存在的 tool 然後
無聲卡住，比在 HTTP 層回 400 難查太多。

## 身分來自 token，不來自 caller

`user_id` 是 `service:<name>`，`<name>` 由 bearer token 查表得出，**絕不讀 body**。
body 裡若帶 `service` 欄位一律忽略：caller 自己主張的身分在信任判斷上等於零。

## Token

存在 `~/.claude/channels/internal-inject/tokens.json`（權限 0600），裡面放的是每個
token 的 **sha256，不是 token 明文**。本 server 只需要「驗證」token，從不需要「出示」
token，所以明文沒有理由留在磁碟上 —— 檔案外洩因此不等於憑證外洩。

```json
{
  "tokens": [
    { "service": "stock-monitor", "token_sha256": "9f86d0…", "issued_at": "2026-07-14T12:00:00Z" }
  ]
}
```

發放 token 用部署 repo（`claude-tg-agent`）的 operator 腳本，那是唯一看得到明文的
地方：

```bash
bash scripts/internal-inject-token.sh issue stock-monitor   # 明文只印這一次
bash scripts/internal-inject-token.sh list
bash scripts/internal-inject-token.sh revoke stock-monitor
```

**刻意不做成 plugin skill**：把「鑄造 token」放進 agent 自己的工具箱，等於留一個可以
被 prompt injection 誘導去用的工具。

檔案每次請求都重讀，所以發放 / 撤銷 token 不需要重啟 agent。

**`tokens.json` 缺檔或壞檔不會讓 server 死掉**：印警告、照樣 bind port、每個請求回
401。若改成 exit，inject port 就沒人 listen，而 `claude-tg-agent` 的 watchdog 會把
「port 沒人聽」判定成 agent 死了 —— 一個缺檔會變成無限重啟迴圈。

## 設定

| Env | 預設 | 用途 |
|---|---|---|
| `INTERNAL_INJECT_PORT` | `7844` | `/inject` listener 的 port。必須與 `claude-tg-agent/scripts/lib-channels.sh` 的 `INTERNAL_INJECT_PORT` 一致，watchdog 探測的就是這個號。 |
| `INTERNAL_INJECT_STATE_DIR` | `~/.claude/channels/internal-inject` | `tokens.json` 的位置。 |

token 本身**絕不走 env**：launcher 會把 `.env` export 進每一個 channel plugin 的 MCP
server，token 放 env 等於 telegram 與 discord 的 server 也讀得到。

## 開發

```bash
bun install
bun test
```
