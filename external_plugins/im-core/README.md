# im-core

`claude-tg-agent` 六個 IM 維運指令的共用核心：六個 skill、一支平台無關的送訊器 `im-send.sh`，以及 IM 重新驗證執行器 `reauth.sh`。

**這不是 channel plugin**。它不提供 MCP server、不收發 gateway 事件，所以只進 carrier
`.claude/settings.json` 的 `enabledPlugins`，**不進** `allowedChannelPlugins`、**不進** `--channels`。

## 內容

| 路徑 | 用途 |
|---|---|
| `scripts/im-send.sh` | 平台無關送訊器。`im-send <source> <recipient> <text>`，`source` 為 `telegram` / `discord`；`IM_SEND_NO_LINK_PREVIEW=1` 關閉 Telegram 連結預覽（discord 忽略） |
| `scripts/im-send.test.sh` | `im-send.sh` 的 dry-run 單元測試，不打網路 |
| `skills/im-common.md` | 六個 skill 共用的前置載入、欄位取法、身分判定、拒絕說法。**判定規則只寫在這一份** |
| `skills/im-help/` | `/help`，依身分回一般使用者版 / 管理員版清單 |
| `skills/im-restart/` | `/restart`，重啟整個 agent 服務（限管理員） |
| `skills/im-create-token/` | `/create-token`，產生 7 天效期邀請碼（限管理員、限私訊） |
| `skills/im-session-clear/` | `/clear`，結束目前對話、換新 session id 重開 |
| `skills/im-session-rename/` | `/rename <name>`，替當前 session 命名 |
| `skills/im-session-resume/` | `/resume`，列出可切換的對話並切過去 |
| `tests/skills.test.sh` | skill 內容的靜態衛生測試（見下） |
| `scripts/lib/lib-loader.sh` | 全部 shell lib 的單一入口，驗環境契約後依 manifest 載入 |
| `scripts/lib/manifest.txt` | 載入清單唯一真相來源（loader 與宿主 preflight 共讀） |
| `scripts/lib/{scope,im,channels,spawn-contract}.sh` | scope 值域 / 六指令判定 / channel 值域 / spawn exit code 契約 |
| `tests/parity.test.sh` | shell lib 與 channel plugin（TS）的契約 parity |
| `scripts/reauth.sh` | IM 重新驗證執行器（`/reauth`、`/authcode`），見下方「重新驗證執行器」 |
| `scripts/reauth/lib-reauth.sh` | 執行器的純函式：URL / token 擷取、驗證碼值域、`.env` render、產生日記錄 |
| `scripts/lib/reauth-contract.sh` | 執行器與 poller 之間的 exit code 契約、產生日記錄檔名 |
| `tests/reauth-{lib,cli,flow}.bats` | 執行器的純函式 / CLI 判定 / driver 整合測試（flow 需 tmux） |

## 環境變數契約

必填變數**全部由宿主的 launcher 匯出，本 plugin 不提供任何預設值**。
未設時 skill 的第一行 `: "${VAR:?...}"`、或 loader 自己，就會中止。

| 變數 | 誰提供 | 必填 | 說明 |
|---|---|---|---|
| `IM_CORE_DIR` | 宿主 | 是 | 本 plugin 根目錄（pinned installPath）。skill 由此定址 `im-common.md` 與 `scripts/lib/lib-loader.sh` |
| `IM_SEND_BIN` | 宿主 | 是 | `$IM_CORE_DIR/scripts/im-send.sh` |
| `AGENT_SCOPES_DIR` | 宿主 | 是 | pointer / ledger / intent / admins 四種檔案的根。**本 plugin 刻意不給預設值** |
| `AGENT_SCOPE` | 宿主 | 是（agent 內） | 本進程服務的 scope-id。由 `scope_resolve` 在呼叫時驗，不由 loader 驗 —— 見下方 §3 的守衛對照表 |
| `AGENT_WORKSPACE_DIR` | 宿主 | 強烈建議 | transcripts 目錄的來源。未設時退回 `$PWD`，而 `$PWD` 不對就等於「沒有任何對話」 |
| `CHANNELS` / `CHANNEL` | 宿主 | 呼叫 `channels_resolve` 時 | 本機跑哪些 channel。兩者皆未設時 `channels_resolve` 回非 0 |
| `BOOTSTRAP_SCOPE` / `BOOTSTRAP_EXTRA_CHANNELS` | 宿主 | 否 | 綁定 box-wide port 的 channel 由哪個 scope 承載 |
| `SCOPE_POINTER_TTL_SECONDS` / `SCOPE_RESUME_FAIL_LIMIT` / `INVITE_TTL_SECONDS` | 宿主 | 否 | 有預設值，覆寫用 |

`IM_CORE_DIR` 與 `IM_SEND_BIN` 刻意分開，不再靠 `dirname "$IM_SEND_BIN"` 互推：
lib 尋址與 im-send 位置是兩件事，綁在一起的話任一邊搬家都會靜默弄壞另一邊。

**沒有預設值是刻意的。** 舊版用 `${VAR:-<舊路徑>}` 帶預設值，環境不完整時會靜默
去跑另一份舊檔 —— 測起來全過，跑的卻不是你以為的那份。改動時不要把預設值加回來。

## 宿主接入步驟（新 carrier / 新機器照這份做）

im-core 現在**不需要 carrier repo**：shell lib 住在本 plugin 內。宿主要做的只有四件事。

### 1. 安裝並 pin 版本

```bash
claude plugin marketplace add itmrchow/itmrchow-plugins
claude plugin install im-core@itmrchow-plugins --scope user
```

### 2. 解析 pinned installPath

版本化 cache 目錄的路徑不可寫死（含版號，每次 bump 就變），執行時查 `installed_plugins.json`：

```bash
export IM_CORE_DIR="$(jq -r --arg key "im-core@itmrchow-plugins" '
    (.plugins[$key] // [])
    | map(select(.scope == "user"))
    | (.[0].installPath // empty)
  ' "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/plugins/installed_plugins.json")"
```

拿不到就**當場失敗**，不要退回別的路徑：退回 = 跑到另一份 code，而且看起來一切正常。

`export` 不能省：`IM_CORE_DIR` 要傳進 agent 進程，六個 `im-*` skill 的第一行
`: "${IM_CORE_DIR:?...}"` 都靠它定址。只在 launcher 的 shell 內賦值，launcher 自己
跑得起來，但每個指令都會回報「IM_CORE_DIR not set — launcher 未匯出」。

### 3. 設好環境契約再 source loader

```bash
export AGENT_SCOPES_DIR="${AGENT_SCOPES_DIR:-$HOME/.claude/agent-scopes}"
export IM_SEND_BIN="$IM_CORE_DIR/scripts/im-send.sh"
source "$IM_CORE_DIR/scripts/lib/lib-loader.sh" || {
  echo "im-core lib 載入失敗，見上方訊息" >&2
  exit 1
}
```

必填變數見上面的環境變數契約表。**三種變數由三個不同的關卡守，不是全部由 loader 守**：

| 變數 | 誰在擋 | 何時擋 | 訊息長相 |
|---|---|---|---|
| `AGENT_SCOPES_DIR` | `im_core_load`（本檔的 loader） | source loader 當下 | `[im-core/lib-loader] AGENT_SCOPES_DIR 未設 —— ...` |
| `IM_CORE_DIR` / `IM_SEND_BIN` | 各 skill preamble 的 `: "${VAR:?...}"` | skill 執行第一行 | `IM_CORE_DIR not set — launcher 未匯出...` |
| `AGENT_SCOPE` | `scope_resolve`（`scripts/lib/scope.sh`） | 呼叫它的時候（launcher 開機即呼叫） | `[lib-scope] AGENT_SCOPE is not set (expected shape: ...)` |

`AGENT_SCOPE` 刻意**不**進 loader：`setup.sh` 這類部署腳本會 source 同一批 lib，但執行時根本
沒有 scope，強制必填會讓它們開頭就死。它是「呼叫時才用的入參」，守衛待在使用點才對。

### 4.（建議）更新前先 preflight

`claude plugin update` 會直接移動 pin，沒有「先驗後移」的鉤子。宿主若在意「壞掉的
新版本讓服務開不了機」，在呼叫 `plugin update` **之前**先驗 marketplace clone 內的候選版本：

```bash
CANDIDATE="${CLAUDE_CONFIG_DIR:-$HOME/.claude}/plugins/marketplaces/itmrchow-plugins/external_plugins/im-core"
# 1. manifest 與 loader 在
[ -r "$CANDIDATE/scripts/lib/manifest.txt" ] && [ -r "$CANDIDATE/scripts/lib/lib-loader.sh" ] || exit 1
# 2. manifest 列出的檔案都在，且語法過
bash -n "$CANDIDATE/scripts/lib/lib-loader.sh" || exit 1
# while 一定要吃 process substitution，不能掛在 pipe 右側：pipe 右側跑在 subshell，
# 裡面的 exit 只殺 subshell，外層照樣往下走去呼叫 plugin update —— 這一關等於不存在。
while read -r f; do
  bash -n "$CANDIDATE/scripts/lib/$f" || exit 1
done < <(grep -v '^[[:space:]]*#' "$CANDIDATE/scripts/lib/manifest.txt" | grep -v '^[[:space:]]*$')
# 3. 冒煙載入
( AGENT_SCOPES_DIR="$(mktemp -d)" bash -c "source '$CANDIDATE/scripts/lib/lib-loader.sh' && declare -F im_is_admin >/dev/null" ) || exit 1
```

驗過才 `claude plugin update`；沒過就跳過更新，pin 留在舊版繼續服務。
參考實作：claude-tg-agent 的 `scripts/lib-plugins.sh`。

## 5. 故障排除與退版

### 常見失敗

| 症狀 | 原因 | 處置 |
|---|---|---|
| `[im-core/lib-loader] AGENT_SCOPES_DIR 未設 ...` | 宿主沒 export 這個變數 | 照 §3 補上；本 plugin 刻意不給預設值 |
| `[im-core/lib-loader] manifest 列出的 lib 缺檔：...` | 安裝不完整，或 manifest 與實際檔案漂移 | 重跑 `claude plugin update im-core@itmrchow-plugins`；仍缺就是該版本壞了，照下方退版 |
| skill 回報 `IM_CORE_DIR not set — launcher 未匯出` | §2 的賦值漏了 `export` | 見 §2；只賦值不 export 時 launcher 自己會過、agent 內每個指令都會掛 |
| `/resume` 找不到任何東西、pointer / ledger 都是空的 | `AGENT_SCOPES_DIR` 指到打錯字的路徑 | loader 只驗非空、不驗路徑是否是你想的那個（那是宿主的設定責任）。用 `ls "$AGENT_SCOPES_DIR"` 對一次 |

### 退版（pin 回舊版）

`installPath` 是版本化 cache 目錄，舊版**不會**被刪，所以退版就是把 `IM_CORE_DIR` 指回去：

```bash
ls "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/plugins/cache/itmrchow-plugins/im-core/"   # 可用版本
export IM_CORE_DIR="${CLAUDE_CONFIG_DIR:-$HOME/.claude}/plugins/cache/itmrchow-plugins/im-core/<舊版號>"
```

宿主重啟後即以舊版服務。這是 §4 preflight「不過就不動 pin」的手動版本 —— 兩者都靠同一件事：
cache 保留多版本。

## 重新驗證執行器（reauth.sh）

讓管理員不進 VM、只在 Telegram / Discord 私訊 bot，就能為 agent 換發一年期
`CLAUDE_CODE_OAUTH_TOKEN`。channel poller 攔下 `/reauth`、`/authcode` 後 spawn 本執行器，
依 exit code 回一句話或沉默；**判定、計時、狀態、所有對主機的寫入都只在這裡**。

```
管理員私訊 -> poller（解析、spawn、依 exit code 回話）
                 |  argv 只有身分；驗證碼走 stdin
                 v
             reauth.sh start / code（授權判定 + 全機單一流程鎖）
                 |  start 背景起一支 driver
                 v
             reauth.sh _driver（tmux 內跑 claude setup-token -> 自己用 im-send 回報
                                -> 寫入前驗證 -> 備份 + 原子寫 .env -> 重啟 -> 經 direnv 再驗證）
```

- 執行器由 poller 從 **marketplace clone** 呼叫（與 poller 同一份 checkout），不走 pinned installPath。
- poller 重啟（含 discord gateway 自救退出）會以 SIGTERM 中斷流程；driver 依當下階段還原或回報。中斷若發生在 .env 已寫入之後（RESTARTING / VERIFYING），不會寫產生日記錄；確認 agent 正常後請手動 `reauth.sh mark-issued <產生日>`，否則到期提醒會沿用舊的產生日。
- 測試：`bats tests/reauth-lib.bats tests/reauth-cli.bats tests/reauth-flow.bats`（flow 需本機 tmux，沒有會 skip —— skip 不等於通過）。執行器依賴 `timeout`（GNU coreutils）：Linux 內建；macOS 需 `brew install coreutils`，否則 `check` 會回 `missing: timeout`。

### CLI

```
reauth.sh start --platform <telegram|discord> --sender <id> --chat <id> --chat-type <dm|group>
reauth.sh code  --platform <telegram|discord> --sender <id> --chat <id> --chat-type <dm|group>   # 驗證碼從 stdin 讀一行
reauth.sh status        # 印 phase=<...> 或 idle；不印 id / URL / code
reauth.sh check         # 逐項印 ok:/missing: 設定檢查；全過 exit 0，否則 exit 3
reauth.sh mark-issued <YYYY-MM-DD>   # 手動補記產生日（source=manual）
reauth.sh _driver       # 內部，勿直接呼叫
reauth.sh _exec_setup_token <config dir>   # 內部，tmux 內執行
```

`--sender` / `--chat` 必須符合 `^-?[0-9]{1,32}$`；不符 -> exit 2。

### exit code（`scripts/lib/reauth-contract.sh`，與 poller 的 `reauth-command.ts` 由 `tests/parity.test.sh` 比對）

| 常數 | 值 | 誰會回 | poller 回覆 |
|---|---|---|---|
| `REAUTH_EXIT_OK` | 0 | start / code | start:「已開始重新驗證，授權連結稍後私訊給你。」code:「已收到驗證碼，處理中，完成或失敗都會再通知你。」 |
| `REAUTH_EXIT_USAGE` | 2 | 全部 | 沉默 |
| `REAUTH_EXIT_NOT_CONFIGURED` | 3 | start / code（已確認是管理員之後） | 「重新驗證功能未完整設定，請到 VM 查看 poller 的 journal。」 |
| `REAUTH_EXIT_UNAUTHORIZABLE` | 4 | start / code（`AGENT_SCOPES_DIR` 缺 / lib 載不起來） | 沉默 |
| `REAUTH_EXIT_NOT_ADMIN` | 10 | start / code | 沉默 |
| `REAUTH_EXIT_NOT_DM` | 11 | start / code（管理員但在群組） | 「這個指令只能在私訊使用」 |
| `REAUTH_EXIT_BUSY` | 12 | start：已有流程；code：流程非 WAIT_CODE | start:「已有進行中的重新驗證流程，請等它結束後再試。」code:「驗證碼已收過，流程處理中，請等候結果通知。」 |
| `REAUTH_EXIT_NO_PENDING` | 13 | code | 「目前沒有等待驗證碼的流程（可能已逾時），需要時請重新 /reauth。」 |
| `REAUTH_EXIT_INVALID_CODE` | 14 | code | 「驗證碼格式不正確，請貼上授權頁顯示的完整驗證碼：/authcode <驗證碼>」 |
| spawn 失敗 / 逾時 / 其他 | — | — | 沉默 |

沉默的那幾個值代表「還不知道對方是不是管理員」，回話等於告訴陌生人這個指令存在。

判定順序（start / code 相同前段）：參數（2） -> 載入 admin 判定（4） -> `im_is_admin`（10） -> chat-type=dm（11） -> 設定完整（3） -> start：取鎖（12）；code：有進行中流程且 platform+sender 相符（否則 13） -> phase=WAIT_CODE（否則 12） -> 未過 deadline（否則 13） -> 格式（14；多行訊息整則視為格式錯） -> 寫入 code 檔（0）。

### 環境變數

| 變數 | 必填 | a1-b 值（poller unit 設定） | 說明 |
|---|---|---|---|
| `AGENT_SCOPES_DIR` | 是 | `/home/agent/.claude/agent-scopes` | `im_is_admin` 讀 `<platform>-admins.json` |
| `REAUTH_ENV_FILE` | 是 | `/home/agent/claude-tg-agent/.env` | 必須是一般檔（非 symlink）、可讀寫 |
| `REAUTH_AGENT_SERVICE` | 是 | `claude-tg-agent` | 必須與 sudoers 字面值一致（不可加 `.service`） |
| `REAUTH_STATE_DIR` | 是 | `/home/agent/.claude/reauth` | 0700；鎖、狀態、code 檔、隔離 config、`token-issued.json`。路徑不得含 `'` |
| `REAUTH_CLAUDE_BIN` | 否 | （不設） | 未設時以 `PATH=$HOME/.local/bin:/usr/local/bin:$PATH` 找 `claude` |
| `REAUTH_DIRENV_BIN` | 否 | （不設） | 未設時同上找 `direnv` |
| `REAUTH_TMUX_SOCKET` / `REAUTH_TMUX_SESSION` | 否 | 預設 `claude-reauth` / `claude-reauth` | 專用 socket，與 agent 的 tmux server 完全隔離；值域 `[A-Za-z0-9_-]` |
| `REAUTH_CODE_TTL_SECONDS` | 否 | 預設 300 | 從 `/reauth` 受理時起算 |
| `REAUTH_URL_WAIT_SECONDS` | 否 | 預設 45 | |
| `REAUTH_EXCHANGE_WAIT_SECONDS` | 否 | 預設 60 | |
| `REAUTH_PROBE_TIMEOUT_SECONDS` | 否 | 預設 90 | |
| `REAUTH_RESTART_TIMEOUT_SECONDS` | 否 | 預設 480 | 高於 unit `TimeoutStartSec=420` |
| `REAUTH_FLOW_MAX_SECONDS` | 否 | 預設 1800 | stale 判定上限；須大於最慢失敗路徑（約 1600 秒，含通知上限） |
| `REAUTH_NOTIFY_TIMEOUT_SECONDS` | 否 | 預設 45 | 單則 IM 通知上限（`timeout` 包住 im-send）；須大於 im-send 的 curl 上限（30 秒）；測試調小 |
| `REAUTH_POLL_INTERVAL_SECONDS` | 否 | 預設 1 | 測試調小 |
| `IM_SEND_BIN` | 否 | （不設） | 預設同目錄 `im-send.sh`；測試替換為錄製 stub |
| `TELEGRAM_BOT_TOKEN` / `DISCORD_BOT_TOKEN` | 由 poller 行程環境繼承 | — | im-send 送訊用 |

poller 端另需：`REAUTH_BIN=<marketplace clone>/external_plugins/im-core/scripts/reauth.sh`。未設 = 完全不攔截。
poller unit **不得**加 `NoNewPrivileges=yes`（driver 需要 `sudo -n systemctl restart <service>`）。

### state 檔

- 路徑 `$REAUTH_STATE_DIR/flow.lock/state`，格式 `key=value` 一行一個，值域受限（數字 / 固定字串 / 檔名），**不含 token / URL / code**。僅執行器內部讀寫，poller 不讀。
- 鎖 = `mkdir flow.lock`（原子、跨平台）。pid 已死、超過 `REAUTH_FLOW_MAX_SECONDS`，或（尚無 pid 時）建立超過寬限時間 -> 視為 stale 並回收；回收時若前一個流程停在 `APPLYING|RESTARTING|VERIFYING`，新流程會先私訊提醒確認 `.env`。
- 驗證碼暫存：`$REAUTH_STATE_DIR/flow.lock/code.in`（0600，`code` 子指令原子寫入、driver 讀後立即刪除）。
- 隔離 config：`$REAUTH_STATE_DIR/cfg.XXXXXX/`（setup-token 用）、`$REAUTH_STATE_DIR/probe.XXXXXX/`（probe 用），流程結束刪除。

### 產生日記錄（執行器寫、carrier watchdog 讀）

- 路徑：`$REAUTH_STATE_DIR/token-issued.json`（檔名常數 `REAUTH_ISSUED_FILE_NAME`；carrier 端 `TOKEN_ISSUED_FILE_NAME` 必須同值）
- 內容（單行 JSON，mode 600）：`{"version":1,"issued_on":"2026-09-15","source":"reauth"}`；`source ∈ {reauth, manual}`；`issued_on` 為 UTC 日期；效期以 365 天計。
- 只在「重啟後經 .env 注入路徑驗證通過」後寫入（或 `mark-issued`）。

### token 不外洩的手段

| 管道 | 手段 |
|---|---|
| argv（`ps` 可見） | token 只以 bash 內建（`printf` / `[[ ]]` / 變數賦值）處理；傳給 claude 一律在 subshell 內 `export CLAUDE_CODE_OAUTH_TOKEN` 後執行；禁止 `env VAR=token cmd`、禁止當任何命令參數 |
| tmux scrollback | 專用 socket `-L claude-reauth`；抓到 token 後立即 `clear-history` + `kill-server` |
| log | driver 只記 `phase=` / `event=` / `rc=`；capture 內容、URL、驗證碼、token 都不記；`set -x` 禁用 |
| 檔案 | token 只寫入 `REAUTH_ENV_FILE`（同目錄 mktemp、umask 077、`mv -f` 原子替換）與其 `.bak.<UTC>` 備份（600）；state 目錄不得出現 token |
| IM | 訊息模板不含 token；整合測試對 im-send 錄製檔斷言 |
| setup-token / probe 子行程環境 | 白名單 `HOME PATH LANG LC_ALL USER LOGNAME TERM` 以外全部取消 export，只加 `CLAUDE_CONFIG_DIR=<隔離目錄>` |
| 驗證碼注入 | `tmux send-keys -l -- <code>`：當純文字打字，`Enter` / `C-c` 不會被當按鍵，`-` 開頭不會被當選項 |
| Claude Code 工具 | 執行器由 poller spawn 在 VM 本機跑，不經 Claude Code |
| 腳本被 marketplace update 中途改寫 | 主體包在函式內、檔尾 `main "$@"; exit`，bash 已完整 parse 才執行 |

每次換發會留下一份含舊 token 的 `.env.bak.<UTC>`（600），不自動清理；確認新 token 正常後可手動刪除。

## 測試

```bash
bash scripts/im-send.test.sh    # im-send dry-run 單元測試（不打網路；curl 以 stub 驗逾時參數）
bash tests/skills.test.sh       # skill 內容靜態衛生測試
bash tests/lib-loader.test.sh   # loader 契約
bash tests/parity.test.sh       # shell 與 TS 的契約 parity（需 sibling plugin 在場）
bats tests/                     # lib 的行為測試（scope / im / channels）與重新驗證執行器（reauth-*，flow 需 tmux）
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
