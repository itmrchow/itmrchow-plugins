# Discord

[English](./README.md) | 繁體中文

透過 MCP server 把 Discord bot 接上你的 Claude Code。

Bot 收到訊息時，MCP server 會轉發給 Claude，並提供回覆、加 reaction、編輯訊息等工具。

## 前置需求

- [Bun](https://bun.sh) — MCP server 跑在 Bun 上。安裝：`curl -fsSL https://bun.sh/install | bash`。

## 快速設定
> 以下是單一使用者 DM bot 的預設配對流程。群組與多使用者設定見 [ACCESS.md](./ACCESS.md)。

**1. 建立 Discord application 與 bot。**

到 [Discord Developer Portal](https://discord.com/developers/applications) 點 **New Application**，取個名字。

側欄進 **Bot**，給 bot 一個 username。

往下捲到 **Privileged Gateway Intents**，開啟 **Message Content Intent** — 不開的話 bot 收到的訊息內容會是空的。

**2. 產生 bot token。**

同樣在 **Bot** 頁面，往上捲到 **Token** 按 **Reset Token**。複製 token — 只會顯示一次，留到步驟 5 使用。

**3. 邀請 bot 進一個伺服器。**

Discord 不允許你 DM 一個與你沒有共同伺服器的 bot。

進 **OAuth2** → **URL Generator**，勾選 `bot` scope。在 **Bot Permissions** 勾選：

- View Channels
- Send Messages
- Send Messages in Threads
- Read Message History
- Attach Files
- Add Reactions

Integration type 選 **Guild Install**。複製 **Generated URL** 開啟，把 bot 加進任一個你所在的伺服器。

> 純 DM 使用理論上不需要任何權限 — 但現在先開好，之後要用伺服器頻道時就不用回頭補。

**4. 安裝 plugin。**

以下是 Claude Code 指令 — 先執行 `claude` 進入 session。

安裝 plugin：
```
/plugin install discord@itmrchow-plugins
/reload-plugins
```

**5. 把 token 交給 server。**

```
/discord:configure MTIz...
```

會把 `DISCORD_BOT_TOKEN=...` 寫入 `~/.claude/channels/discord/.env`。也可以手動寫該檔案，或直接在 shell 環境設變數 — shell 優先。

> 要在同一台機器跑多個 bot（不同 token、各自的 allowlist），為每個實例把 `DISCORD_STATE_DIR` 指到不同目錄。

**6. 帶 channel 旗標重新啟動。**

不帶這個旗標 server 不會連線 — 離開 session 後重開：

```sh
claude --channels plugin:discord@itmrchow-plugins
```

**7. 配對。**

Claude Code 用上一步方式跑起來後，在 Discord DM 你的 bot — 它會回一組配對碼。如果 bot 沒回應，確認 session 有帶 `--channels`。在 Claude Code session 內執行：

```
/discord:access pair <code>
```

你的下一則 DM 就會送達 assistant。

**8. 鎖起來。**

配對只是為了取得 ID。進得來之後就切到 `allowlist`，陌生人才不會收到配對碼回覆。請 Claude 幫你做，或直接 `/discord:access policy allowlist`。

## 存取控制

見 **[ACCESS.md](./ACCESS.md)**：DM 政策、伺服器頻道、mention 偵測、投遞設定、skill 指令、`access.json` schema。

速查：ID 是 Discord **snowflake**（純數字 — 開 Developer Mode 後右鍵 → Copy ID）。預設政策為 `pairing`。伺服器頻道採逐頻道 ID 手動開通。

## Fork 增補功能

本 fork 在 upstream plugin 之上加了常駐 agent（例如跑在 VM tmux session 內）需要的運維功能：

- **`/inject` HTTP endpoint** — `POST /inject` 到 `127.0.0.1:7843`（可用 `INJECT_PORT` 覆寫），把排程器或其他本機程序的文字以合成 channel 訊息注入 session。Body：`{"text": "...", "chat_id": "..."}`。僅綁定 loopback。
- **Bot 層控制指令** — `/ctx`（context 用量）、`/clear`（清空 context）、`/restart`（重啟 agent）。由 bot 程序直接透過 tmux 驅動，agent 卡死或掛掉時仍然可用。僅限已配對的 owner。
- **啟動通知** — 重啟後 bot 會通知已配對 owner「agent 回來了」，列出載入的 plugin 版本並標記跨重啟有變動的項目。通知採原子 claim，多 channel 部署也只會發一次。
- **Busy-gate 投遞** — inbound 與排程訊息進佇列，僅在 agent pane 閒置時逐筆送出，避免訊息在回合中途送達、孤兒化在輸入框內未送出。
- **已讀回應** — inbound 訊息會收到 emoji reaction（預設 👀）作為「已讀」確認。在 `access.json` 用 `ackReaction` 設定（見 [ACCESS.md](./ACCESS.md)）。
- **孤兒看門狗** — 父 agent 程序死亡時 server 自行退出（並處理 SIGHUP），不會殘留霸佔 token 的殭屍 bot 程序。

## 提供給 assistant 的工具

| 工具 | 用途 |
| --- | --- |
| `reply` | 發訊息到頻道。帶 `chat_id` + `text`，可選 `reply_to`（訊息 ID，原生引用回覆）與 `files`（絕對路徑附件）— 最多 10 檔、各 25MB。自動分段；附件掛在第一段。回傳送出的訊息 ID。 |
| `react` | 對任一訊息（依 ID）加 emoji reaction。Unicode emoji 直接用；自訂 emoji 需 `<:name:id>` 格式。 |
| `edit_message` | 編輯 bot 先前發出的訊息。適合「處理中…」→ 結果的進度更新。僅限 bot 自己的訊息。 |
| `fetch_messages` | 拉取頻道近期歷史（由舊到新），每次上限 100 則。每行含訊息 ID 供 `reply_to` 使用；帶附件的訊息標記 `+Natt`。Discord 不對 bot 開放搜尋 API，這是唯一的回看方式。 |
| `download_attachment` | 依訊息 ID 下載該訊息全部附件到 `~/.claude/channels/discord/inbox/`。回傳檔案路徑 + 中繼資料。`fetch_messages` 顯示某訊息有附件時使用。 |

Inbound 訊息會自動觸發輸入指示 — assistant 處理回應期間，Discord 會顯示「botname 正在輸入…」。

## 附件

附件**不會**自動下載。`<channel>` 通知會列出每個附件的名稱、類型、大小 — assistant 真的需要檔案時再呼叫 `download_attachment(chat_id, message_id)`。下載落在 `~/.claude/channels/discord/inbox/`。

透過 `fetch_messages` 找到的歷史訊息附件同樣走此路徑（帶附件的訊息標記 `+Natt`）。
