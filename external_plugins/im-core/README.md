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
| `AGENT_SCOPE` | 宿主 | 是（agent 內） | 本進程服務的 scope-id |
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
IM_CORE_DIR="$(jq -r --arg key "im-core@itmrchow-plugins" '
    (.plugins[$key] // [])
    | map(select(.scope == "user"))
    | (.[0].installPath // empty)
  ' "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/plugins/installed_plugins.json")"
```

拿不到就**當場失敗**，不要退回別的路徑：退回 = 跑到另一份 code，而且看起來一切正常。

### 3. 設好環境契約再 source loader

```bash
export AGENT_SCOPES_DIR="${AGENT_SCOPES_DIR:-$HOME/.claude/agent-scopes}"
export IM_SEND_BIN="$IM_CORE_DIR/scripts/im-send.sh"
source "$IM_CORE_DIR/scripts/lib/lib-loader.sh" || {
  echo "im-core lib 載入失敗，見上方訊息" >&2
  exit 1
}
```

必填變數見上面的環境變數契約表。缺任何一項 loader 都會在 stderr 說明缺什麼。

### 4.（建議）更新前先 preflight

`claude plugin update` 會直接移動 pin，沒有「先驗後移」的鉤子。宿主若在意「壞掉的
新版本讓服務開不了機」，在呼叫 `plugin update` **之前**先驗 marketplace clone 內的候選版本：

```bash
CANDIDATE="${CLAUDE_CONFIG_DIR:-$HOME/.claude}/plugins/marketplaces/itmrchow-plugins/external_plugins/im-core"
# 1. manifest 與 loader 在
[ -r "$CANDIDATE/scripts/lib/manifest.txt" ] && [ -r "$CANDIDATE/scripts/lib/lib-loader.sh" ] || exit 1
# 2. manifest 列出的檔案都在，且語法過
bash -n "$CANDIDATE/scripts/lib/lib-loader.sh" || exit 1
grep -v '^\s*#' "$CANDIDATE/scripts/lib/manifest.txt" | grep -v '^\s*$' | while read -r f; do
  bash -n "$CANDIDATE/scripts/lib/$f" || exit 1
done
# 3. 冒煙載入
( AGENT_SCOPES_DIR="$(mktemp -d)" bash -c "source '$CANDIDATE/scripts/lib/lib-loader.sh' && declare -F im_is_admin >/dev/null" ) || exit 1
```

驗過才 `claude plugin update`；沒過就跳過更新，pin 留在舊版繼續服務。
參考實作：claude-tg-agent 的 `scripts/lib-plugins.sh`。

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
