# Telegram

[English](./README.md) | 繁體中文

透過 MCP server 把 Telegram bot 接上你的 Claude Code。

MCP server 以 bot 身分登入 Telegram，提供 Claude 回覆、加 reaction、編輯訊息等工具。你傳訊息給 bot 時，server 會把訊息轉發到你的 Claude Code session。

## 前置需求

- [Bun](https://bun.sh) — MCP server 跑在 Bun 上。安裝：`curl -fsSL https://bun.sh/install | bash`。

## 快速設定
> 以下是單一使用者 DM bot 的預設配對流程。群組與多使用者設定見 [ACCESS.md](./ACCESS.md)。

**1. 用 BotFather 建 bot。**

在 Telegram 開 [@BotFather](https://t.me/BotFather) 對話，送出 `/newbot`。BotFather 會問兩件事：

- **Name** — 顯示在聊天標題的名稱（隨意，可含空白）
- **Username** — 以 `bot` 結尾的唯一 handle（例：`my_assistant_bot`），會成為 bot 連結：`t.me/my_assistant_bot`

BotFather 回覆的 token 長得像 `123456789:AAHfiqksKZ8...` — 整串都是 token，含開頭數字與冒號一起複製。

**2. 安裝 plugin。**

以下是 Claude Code 指令 — 先執行 `claude` 進入 session。

安裝 plugin：
```
/plugin install telegram@itmrchow-plugins
/reload-plugins
```

**3. 把 token 交給 server。**

```
/telegram:configure 123456789:AAHfiqksKZ8...
```

會把 `TELEGRAM_BOT_TOKEN=...` 寫入 `~/.claude/channels/telegram/.env`（未設 `$TELEGRAM_STATE_DIR` 時的路徑；有設則 `.env` 放該目錄下）。也可以手動寫該檔案，或直接在 shell 環境設變數 — shell 優先。

> 要在同一台機器跑多個 bot（不同 token、各自的 allowlist），為每個實例把 `TELEGRAM_STATE_DIR` 指到不同目錄。

**4. 帶 channel 旗標重新啟動。**

不帶這個旗標 server 不會連線 — 離開 session 後重開：

```sh
claude --channels plugin:telegram@itmrchow-plugins
```

**5. 配對。**

Claude Code 用上一步方式跑起來後，在 Telegram DM 你的 bot — 它會回一組 6 字元配對碼。如果 bot 沒回應，確認 session 有帶 `--channels`。在 Claude Code session 內執行：

```
/telegram:access pair <code>
```

你的下一則 DM 就會送達 assistant。

> 與 Discord 不同，Telegram 沒有邀請進伺服器的步驟 — bot 直接接受 DM。配對流程會處理 user ID 查找，你完全不用碰數字 ID。

**6. 鎖起來。**

配對只是為了取得 ID。進得來之後就切到 `allowlist`，陌生人才不會收到配對碼回覆。請 Claude 幫你做，或直接 `/telegram:access policy allowlist`。

## 存取控制

見 **[ACCESS.md](./ACCESS.md)**：DM 政策、群組、mention 偵測、投遞設定、skill 指令、`access.json` schema。

速查：ID 是**數字 user ID**（用 [@userinfobot](https://t.me/userinfobot) 查自己的）。預設政策為 `pairing`。`ackReaction` 只接受 Telegram 固定的 emoji 白名單。

## Fork 增補功能

本 fork 在 upstream plugin 之上加了常駐 agent（例如跑在 VM tmux session 內）需要的運維功能：

- **訂閱式收訊（`poller.ts`）** — 獨立的 poller 是該 token 唯一的 `getUpdates` 消費者。它判斷每則 update 屬於哪個對話，再以 Server-Sent Events 推給服務該對話的 server 程序。server 本身不綁任何 port，改為主動連到 `127.0.0.1:7852`（可用 `TELEGRAM_POLLER_PORT` 覆寫）並以指數退避自動重連 —— 因此同一個 bot token 底下，多個對話可以各自跑自己的 agent session。
  - `TELEGRAM_STATE_DIR` 是 **poller 的必填項**且沒有預設值：未設就直接結束，避免測試或誤啟動的 process 繼承到預設路徑、用正式 bot token 長輪詢。server 程序仍維持預設 `~/.claude/channels/telegram`。
  - `AGENT_SCOPE` 指明本程序服務哪個對話（例：`telegram-dm-12345`）。值不合法時 server 仍照常提供 MCP 工具，但收不到任何訊息，並於 stderr 明講。
  - `MAX_SCOPES`（預設 10）限制同時存在的 session 數；超過上限時新的發話者會收到「目前容量已滿」，而不是再開一個 agent。
  - `SCOPE_SPAWN_BIN` 指向 host 端用來替尚無 session 的對話開 session 的腳本。未設則永遠不開新 session，並回覆發話者服務未完整設定。
  - launcher（`launch.sh`，由 `.mcp.json` 呼叫）選 runtime：arm64-linux 用 `tsx`(node)，其餘用 `bun`。
  - 排程 / 合成訊息注入已改由獨立的 `internal-inject` channel 負責，本 plugin 不再監聽 inject port。
- **Bot 層控制指令** — `/ctx`（context 用量）、`/clear`（清空 context）、`/restart`（重啟 agent）。由 bot 程序直接透過 tmux 驅動，agent 卡死或掛掉時仍然可用。僅限已配對的 owner。可用 `TELEGRAM_CONTROL_COMMANDS`（逗號分隔，例 `ctx,restart`）縮小 bot 層攔截的範圍 —— 未列入的指令會當成一般訊息轉給 agent，讓 skill 自行定義語意。未設 = 三個全攔，與先前行為相同。
- **啟動通知** — 重啟後 bot 會通知已配對 owner「agent 回來了」，列出載入的 plugin 版本並標記跨重啟有變動的項目。通知採原子 claim，多 channel 部署也只會發一次。
- **已讀回應** — inbound 訊息會收到 emoji reaction（預設 👀）作為「已讀」確認。在 `access.json` 用 `ackReaction` 設定（見 [ACCESS.md](./ACCESS.md)）；只接受 Telegram 固定的 emoji 白名單。
- **孤兒看門狗** — 父 agent 程序死亡時 server 自行退出（並處理 SIGHUP），不會殘留霸佔 token 的殭屍 bot 程序。

## 經 IM 重新驗證 Claude Code（`/reauth`）

poller 設了 `REAUTH_BIN`（指向 im-core 的 `scripts/reauth.sh`）時，會在分派前攔下兩個
指令，它們不會送進 agent：

- `/reauth` —— 限管理員、限私訊：在主機上啟動 `claude setup-token`，並把授權連結私訊給你。
- `/authcode <驗證碼>` —— 授權完成後，把頁面顯示的驗證碼貼回來（須在連結訊息寫明的時限內）。
  Telegram 會在讀取後刪除你這則訊息。

編輯後內容變成 /reauth、/authcode 的訊息會直接丟棄（不執行、不回話、不送進 agent）。要重送請傳新訊息。

非管理員不會收到任何回覆；管理員在群組送出會被告知改用私訊。管理員名單、計時與所有對主機的
寫入都在 im-core 執行器內，見 im-core 的 README。未設 `REAUTH_BIN` 時，兩個指令照一般文字分派。

## 核准請求（inline 按鈕，loopback 介面）

預設關閉。poller 的 `TELEGRAM_APPROVAL_BUTTONS` 設為 `1` 或 `true` 時，本機程序可以請
bot 的擁有者用兩顆按鈕回答一個是非題，並讀回按了哪一顆。

決定在 Telegram 上產生、保管在 poller 程序內。下面的介面只能建立、查詢、取消 ——
**沒有任何寫入決定的呼叫**，請求 body 內多帶的欄位一律忽略。

### 環境變數（`poller.ts` 讀取；可放環境或 `$TELEGRAM_STATE_DIR/.env`）

| 變數 | 預設 | 意思 |
| --- | --- | --- |
| `TELEGRAM_APPROVAL_BUTTONS` | 未設（關閉） | `1` 或 `true`（去空白、不分大小寫）才啟用。未設、空字串、`0`、`false` 與其他值一律關閉。 |
| `TELEGRAM_APPROVAL_TIMEOUT_SECONDS` | `86400` | 建立時沒帶 `timeout_seconds` 時，等按鈕的時間。 |
| `TELEGRAM_APPROVAL_COMMENT_TIMEOUT_SECONDS` | `300` | 建立時沒帶 `comment_timeout_seconds` 時，按「退回」後等意見的時間。 |
| `TELEGRAM_POLLER_PORT` | `7852` | 既有變數；介面掛在 poller 的埠上。 |
| `TELEGRAM_API_ROOT` | 未設 | 測試用：Bot API 位址，用來把 poller 指向本機的假伺服器。**只接受本機位址**（`127.0.0.1`、`localhost`、`[::1]`；`http` 或 `https`；URL 內不得帶帳密；尾端的 `/` 會自動去掉），所以 bot token 不可能經這個變數被送到機器以外。被採用時啟動會在 stderr 印 `WARNING TELEGRAM_API_ROOT is set`。其他值（別的主機、無法解析的 URL）一律忽略：poller 印 `TELEGRAM_API_ROOT ignored (<原因>)`（不印出該值本身），照舊連 Telegram 官方伺服器。與 `TELEGRAM_APPROVAL_BUTTONS` 開關無關。 |

兩個逾時都接受小數，須大於 0 且不超過 604800（7 天）；不合法時在 stderr 警告並退回預設值。

開關關閉時 poller 行為與先前完全相同：下面三個路徑回 server 原本的 `404 not found`（純文字）、
不攔截任何 update、不讀 `access.json`、不寫狀態檔。本功能沒有改 `server.ts`，poller 與 server
新舊版本任意混搭都不受影響。

### 呼叫

位址：`http://127.0.0.1:<TELEGRAM_POLLER_PORT>`（只綁 loopback，無認證）。帶 `Origin` header 的請求（網頁發出的請求才會帶）
一律回 `403 {"error":"forbidden_origin"}`；`curl` 與腳本不會帶。請求與回應皆為 JSON
（`content-type: application/json`）；唯一的非 JSON 回應是功能關閉時的純文字 `404 not found`。

**建立 —— `POST /approvals`**

| body 欄位 | 必填 | 意思 |
| --- | --- | --- |
| `id` | 是 | 由呼叫方產生。`[A-Za-z0-9_-]{1,40}`。**必須不可預測**，見「呼叫方必須遵守的規則」。 |
| `text` | 是 | 顯示給 user 的文字。不可空白，最多 3500 字元。以純文字送出（不帶 `parse_mode`），不需跳脫。 |
| `kind` | 是 | `allow_deny`（按鈕：允許 / 拒絕）或 `approve_reject`（按鈕：approve / 退回）。 |
| `timeout_seconds` | 否 | 數字，`0 < n <= 604800`。 |
| `comment_timeout_seconds` | 否 | 數字，`0 < n <= 604800`。 |

| 回應 | body | 何時 |
| --- | --- | --- |
| `201` | 該請求（格式見下），`status: "pending"` | 至少發給一位收件人。 |
| `400` | `{"error":"invalid_request","detail":"..."}` | 欄位缺漏 / 不合法、JSON 格式錯誤、body 超過 32 KB。沒有發出任何訊息。 |
| `409` | `{"error":"duplicate_id","request":{...}}` | id 已存在。回傳既有請求的現況，不重置、不重發。只有同一 id 仍在建立中時才沒有 `request`。**這不是你的請求**，見「呼叫方必須遵守的規則」。 |
| `502` | `{"error":"telegram_send_failed"}` | Telegram 全部發送失敗。不留下請求，該 id 可再用。 |
| `503` | `{"error":"no_recipient"}` | `access.json` 的 `allowFrom` 為空（或讀不到）。 |
| `503` | `{"error":"too_many_requests"}` | 已保有 200 筆請求。 |
| `404` 純文字 `not found` | | 功能關閉（或 poller 版本尚無此功能）。 |

#### 呼叫方必須遵守的規則

本機任何程序都能呼叫這個介面，而 id 是呼叫方自己選的。下面兩條規則用來避免把別人建立的請求當成自己的：

1. **每筆請求產生不可預測的 id** —— 至少 128 bit 隨機值，例如 `appr_$(openssl rand -hex 16)` 或去掉連字號的 UUID。
   給人看的字樣（ticket 編號、PR 編號）放在 `text`，不要放在 `id`。像 `spec-<ticket>` 這種猜得到的 id，
   別的程序可以搶先用同一個 id、配上看似無害的文字建立請求；user 核准的是那段文字，之後讀這個 id 的呼叫方
   卻會把它當成自己那件事的核准。
2. **`409` 代表這筆請求不是你建立的。** 不得輪詢它、不得採用它的結果、不得取消它。把這次建立視為失敗，換一個新的 id 重試。
   只對**自己拿到 `201`** 的 id 做 `GET` 或取消（續等時用當時記下的 id）。

訊息會發到 `access.json` 的 `allowFrom` 內**每一位** user 的私訊；先到的決定為準，所有副本一起改寫成結果。

**查詢 —— `GET /approvals/<id>`**

`200` 與該請求，或 `404 {"error":"not_found"}`（從未建立、建立失敗、狀態檔遺失、或結束滿 24 小時已清除）。

```json
{
  "id": "appr_3f9c1e7a5b2d4c6e8a0b1d2f3a4c5e6f",
  "kind": "approve_reject",
  "status": "denied",
  "decision": "reject",
  "comment": "範圍要再縮小，拿掉 X",
  "created_at_ms": 1790927386899,
  "expires_at_ms": 1791013786899,
  "resolved_at_ms": 1790927400000
}
```

| `status` | 意思 | `decision` | `comment` |
| --- | --- | --- | --- |
| `pending` | 等按鈕。 | `null` | `null` |
| `awaiting_comment` | 已按「退回」，等文字意見。尚未定案，請繼續輪詢；最後只會變成 `denied` 或 `cancelled`。 | `reject` | `null` |
| `approved` | 按了「允許」或 approve。 | `allow` / `approve` | `null` |
| `denied` | 按了「拒絕」，或「退回」已完成。 | `deny` / `reject` | `deny` 為 `null`；`reject` 為意見文字，逾時沒寫則為 `""` |
| `cancelled` | 經本介面取消。 | `null` | `null` |
| `expired` | 期限內沒人按。 | `null` | `null` |

**取消 —— `POST /approvals/<id>/cancel`**（不需 body）

| 回應 | 何時 |
| --- | --- |
| `200` 與該請求，`status: "cancelled"` | 原為 `pending` 或 `awaiting_comment`。Telegram 訊息改為 `[已在電腦處理]` 並移除按鈕。 |
| `200` 與該請求，狀態不變 | 已有結果（`approved` / `denied` / `expired` / `cancelled`）。保留原結果、不動訊息，重複取消是安全的。 |
| `404 {"error":"not_found"}` | 查無此 id。 |

**其他** `/approvals` 底下的請求：路徑對但方法錯回 `405 {"error":"method_not_allowed"}`；路徑不存在回
`404 {"error":"not_found"}`。

```sh
curl -s -X POST http://127.0.0.1:7852/approvals \
  -d '{"id":"appr_3f9c1e7a5b2d4c6e8a0b1d2f3a4c5e6f","text":"JP-123 Spec 可以 approve 嗎？","kind":"approve_reject"}'
curl -s http://127.0.0.1:7852/approvals/appr_3f9c1e7a5b2d4c6e8a0b1d2f3a4c5e6f
curl -s -X POST http://127.0.0.1:7852/approvals/appr_3f9c1e7a5b2d4c6e8a0b1d2f3a4c5e6f/cancel
```

### user 看到什麼、什麼才算決定

- 按鈕要同時符合三件事才算數：按的人在 `allowFrom` 內（驗的是按的人，不是訊息所在的聊天室）、
  該按鈕屬於這筆請求的 `kind`、按鈕掛在 poller 為這筆請求發出的訊息上。其餘一律只回應、不採用。
- 請求離開 `pending` 之後再按都不會改變結果，包含按「退回」後改按 approve。
- 「允許」/「拒絕」/ approve 立即定案；訊息變成原文加上 `[已允許]`、`[已拒絕]` 或 `[已 approve]`，按鈕移除。
- 「退回」讓請求進入 `awaiting_comment`，bot 另發一則提示請 user 回覆。意見 = `allowFrom` 內的人
  **引用回覆**該提示（或原請求訊息）的文字。這則回覆由 poller 吃掉，**不會**轉給任何 session。
  非文字的回覆會收到「請用文字回覆意見。」並繼續等。等意見逾時則記為 `denied`、`comment: ""`。
- 以 `/` 開頭的回覆一律不算意見、照常轉送，所以等意見期間 `/restart` 這類 bot 指令照樣有效。
- 請求已結案（等意見逾時、被取消）後才引用回覆提示訊息：不記錄、也不轉給 session，bot 回一句
  「這筆請求已經結案，這則意見沒有被記錄。」。
- 一般訊息、回覆其他訊息、其他 callback data（含 `perm:` 權限按鈕）照舊轉給 session。
- 逾時的請求訊息改為 `[已逾時]`。
- 改訊息失敗不會讓決定消失；以查詢結果為準。

### 重啟與狀態

請求同步寫入 `$TELEGRAM_STATE_DIR/approvals.json`（權限 0600，先落檔再改 Telegram 訊息；寫檔失敗只記 log，
記憶體內的結果在下次重啟前仍有效），只有 poller 讀寫。poller 重啟後結果保留，等待中的請求仍可用原本的按鈕完成，不重發訊息。停機期間按下的按鈕在
重啟後處理；期間跨過期限的請求變成 `expired`。檔案遺失或讀不了時 poller 從空狀態啟動（壞檔保留為
`approvals.json.corrupt-<時間戳>`），先前的 id 查詢為 `not_found`。

## 提供給 assistant 的工具

| 工具 | 用途 |
| --- | --- |
| `reply` | 發訊息到聊天室。帶 `chat_id` + `text`，可選 `reply_to`（訊息 ID，原生引用回覆）與 `files`（絕對路徑附件）。圖片（`.jpg`/`.png`/`.gif`/`.webp`）以照片形式發送、有行內預覽；其他類型以文件發送。單檔上限 50MB。文字自動分段；檔案在文字之後以獨立訊息送出。回傳送出的訊息 ID。 |
| `react` | 對訊息（依 ID）加 emoji reaction。**只接受 Telegram 固定白名單**（👍 👎 ❤ 🔥 👀 等）。 |
| `edit_message` | 編輯 bot 先前發出的訊息。適合「處理中…」→ 結果的進度更新。僅限 bot 自己的訊息。 |

Inbound 訊息會自動觸發輸入指示 — assistant 處理回應期間，Telegram 會顯示「botname 正在輸入…」。

## 照片

Inbound 照片會下載到 `~/.claude/channels/telegram/inbox/`（未設 `$TELEGRAM_STATE_DIR` 時的路徑；有設則 `inbox/` 放該目錄下），且本機路徑會附在 `<channel>` 通知內，assistant 可直接 `Read`。Telegram 會壓縮照片 — 需要原始檔時，改用文件方式傳送（長按 → Send as File）。

## 沒有歷史與搜尋

Telegram Bot API **不提供**訊息歷史與搜尋。bot 只看得到抵達當下的訊息 — 沒有 `fetch_messages` 工具。assistant 需要更早的上下文時，會請你貼上或摘要。

也因此沒有針對歷史訊息的 `download_attachment` 工具 — 照片在抵達時就立即下載，因為之後沒有辦法再取。
