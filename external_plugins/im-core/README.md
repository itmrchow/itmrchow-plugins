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
| `scripts/lib/lib-loader.sh` | 全部 shell lib 的單一入口，驗環境契約後依 manifest 載入 |
| `scripts/lib/manifest.txt` | 載入清單唯一真相來源（loader 與宿主 preflight 共讀） |
| `scripts/lib/{scope,im,channels,spawn-contract}.sh` | scope 值域 / 六指令判定 / channel 值域 / spawn exit code 契約 |
| `tests/parity.test.sh` | shell lib 與 channel plugin（TS）的契約 parity |

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

## 測試

```bash
bash scripts/im-send.test.sh    # im-send dry-run 單元測試（不打網路）
bash tests/skills.test.sh       # skill 內容靜態衛生測試
bash tests/lib-loader.test.sh   # loader 契約
bash tests/parity.test.sh       # shell 與 TS 的契約 parity（需 sibling plugin 在場）
bats tests/                     # lib 的行為測試（scope / im / channels）
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
