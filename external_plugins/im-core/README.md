# im-core

`claude-tg-agent` 六個 IM 維運指令的共用核心：六個 skill 加一支平台無關的送訊器 `im-send.sh`。

**這不是 channel plugin**。它不提供 MCP server、不收發 gateway 事件，所以只進 carrier
`.claude/settings.json` 的 `enabledPlugins`，**不進** `allowedChannelPlugins`、**不進** `--channels`。

## 內容

| 路徑 | 用途 |
|---|---|
| `scripts/im-send.sh` | 平台無關送訊器。`im-send <source> <recipient> <text>`，`source` 為 `telegram` / `discord` |
| `scripts/im-send.test.sh` | `im-send.sh` 的 dry-run 單元測試，不打網路 |
| `skills/im-common.md` | 六個 skill 共用的前置載入、欄位取法、身分判定、拒絕說法。**判定規則只寫在這一份** |
| `skills/im-help/` | `/help`，依身分回一般使用者版 / 管理員版清單 |
| `skills/im-restart/` | `/restart`，重啟整個 agent 服務（限管理員） |
| `skills/im-create-token/` | `/create-token`，產生 7 天效期邀請碼（限管理員、限私訊） |
| `skills/im-session-clear/` | `/clear`，結束目前對話、換新 session id 重開 |
| `skills/im-session-rename/` | `/rename <name>`，替當前 session 命名 |
| `skills/im-session-resume/` | `/resume`，列出可切換的對話並切過去 |
| `tests/skills.test.sh` | skill 內容的靜態衛生測試（見下） |

## 環境變數契約

三個變數**全部由 carrier 的 launcher 匯出，本 plugin 不提供任何預設值**。
未設時 skill 的第一行 `: "${VAR:?...}"` 就會中止。

| 變數 | 值 | 為什麼要獨立一個 |
|---|---|---|
| `IM_CORE_DIR` | 本 plugin 根目錄（marketplace clone 內的 `external_plugins/im-core`） | skill 要 `Read` 的 `im-common.md` 不是可執行檔，無法從 `IM_SEND_BIN` 推導而不做字串切割 |
| `IM_SEND_BIN` | `$IM_CORE_DIR/scripts/im-send.sh` | 沿用既有名（carrier 的 watchdog 與 bats stub 都靠它） |
| `IM_LIB_DIR` | carrier repo 的 `scripts/` | `lib-channels.sh` / `lib-scope.sh` / `lib-im.sh` 的所在。這是 JP-203 的接縫 |

三者刻意分開，不再靠 `dirname "$IM_SEND_BIN"` 互推：lib 尋址與 im-send 位置是兩件事，
綁在一起的話任一邊搬家都會靜默弄壞另一邊。

**沒有預設值是刻意的。** 舊版用 `${VAR:-<carrier 內的舊路徑>}` 帶預設值，環境不完整時會靜默
去跑 carrier 內那份舊檔 —— 測起來全過，跑的卻不是你以為的那份。改動時不要把預設值加回來。

## 相依：階段1 仍需要 carrier

`IM_LIB_DIR` 指向 `claude-tg-agent` 的 `scripts/`，也就是 **im-core 目前還不能獨立安裝在
沒有 carrier 的機器上**。這是階段1（JP-202）已知且刻意接受的限制，不是缺陷。

`lib-*.sh` 的搬遷屬 **JP-203**，完成後這層相依才會消失、`IM_LIB_DIR` 才會退場。
在那之前，把本 plugin 裝到沒有 carrier 的環境只會得到「skill 一執行就報 `IM_LIB_DIR not set`」。

## 測試

```bash
bash scripts/im-send.test.sh    # im-send dry-run 單元測試（不打網路）
bash tests/skills.test.sh       # skill 內容靜態衛生測試
```

`tests/skills.test.sh` 釘住三件事：

1. `im-restart` 的 sudo 行必須是字面值 `sudo systemctl restart claude-tg-agent`
   —— carrier 的 sudoers 是**字面 argv 比對**，加了 `.service` 就比對不上，sudo 會轉去要密碼，
   而那裡沒有 tty，症狀是指令靜默失敗。carrier 側 `scripts/watchdog/tests/im.bats` 有一條
   對稱的測試釘同一個字串，**兩側任一漂移，該側自己會紅**。
2. skill 內不得出現 `/tmp` 路徑 —— world-writable 且路徑固定，本機任何人都能覆蓋。
   暫存檔一律放 `~/.claude/agent-scopes/<scope>.*`。
3. 不得用 `$PWD` 推 `~/.claude/projects/` 路徑 —— skill 可能在任何目錄執行，
   要用 launcher 匯出的 `$AGENT_WORKSPACE_DIR`。
