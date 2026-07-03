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

- **`/inject` HTTP endpoint** — `POST /inject` 到 `127.0.0.1:7842`（可用 `INJECT_PORT` 覆寫），把排程器或其他本機程序的文字以合成 channel 訊息注入 session。Body：`{"text": "...", "chat_id": "..."}`。僅綁定 loopback。
- **外部 poller 模式** — `poller.ts` 以獨立程序跑 Telegram long-polling，把原始 update 轉發到同一 port 的 `POST /update`。aarch64 主機必需（同程序的 long-poll 迴圈會被 MCP stdio watcher 餓死）；x86 用內建 poll 即可。
- **Bot 層控制指令** — `/ctx`（context 用量）、`/clear`（清空 context）、`/restart`（重啟 agent）。由 bot 程序直接透過 tmux 驅動，agent 卡死或掛掉時仍然可用。僅限已配對的 owner。
- **啟動通知** — 重啟後 bot 會通知已配對 owner「agent 回來了」，列出載入的 plugin 版本並標記跨重啟有變動的項目。通知採原子 claim，多 channel 部署也只會發一次。
- **Busy-gate 投遞** — inbound 與排程訊息進佇列，僅在 agent pane 閒置時逐筆送出，避免訊息在回合中途送達、孤兒化在輸入框內未送出。
- **已讀回應** — inbound 訊息會收到 emoji reaction（預設 👀）作為「已讀」確認。在 `access.json` 用 `ackReaction` 設定（見 [ACCESS.md](./ACCESS.md)）；只接受 Telegram 固定的 emoji 白名單。
- **孤兒看門狗** — 父 agent 程序死亡時 server 自行退出（並處理 SIGHUP），不會殘留霸佔 token 的殭屍 bot 程序。

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
