# JP-76 telegram plugin 雙模式跨平台（x86 內建 poll / aarch64 decoupled）開發計劃

- Ticket: JP-76（label OncallAgent）
- 目標 repo: `itmrchow/itmrchow-plugins`（fork，upstream=`anthropics/claude-plugins-official`）
- 標的: `external_plugins/telegram/`
- 等級: L3
- 執行者: dev subagent（本檔僅計劃，不含 production code 改動）

> PR base 防呆（強制）：本 repo 是 fork，`git remote` 有 `upstream=anthropics/claude-plugins-official`。開 PR 一律 `gh pr create --repo itmrchow/itmrchow-plugins ...`，**禁止**裸跑 `gh pr create`（預設 base 會打到 upstream anthropics）。

---

## 1. 背景與現行架構（decoupled，aarch64 專用）

現行 fork 0.1.x telegram 是「解耦式輪詢（通用術語：decoupled polling）」架構，起因是繞開 **aarch64 上 bun/node 事件迴圈餓死 grammy 長輪詢（通用術語：event-loop starvation）** 的 bug：MCP 的 `StdioServerTransport` stdin watcher 一旦被 Claude 驅動，會餓死同進程內的 grammy `getUpdates` 迴圈（連 `setTimeout` 都停擺），inbound 更新永遠收不到。

三個角色：

| 檔案 | 角色 | 關鍵行為 |
|---|---|---|
| `.mcp.json` | 啟動宣告 | `command: "tsx"`, `args: ["${CLAUDE_PLUGIN_ROOT}/server.ts"]` — Claude Code 用 tsx(node) 起 MCP server |
| `server.ts` | MCP server（**不 poll**） | 建 `bot = new Bot(TOKEN)` 但**不 init、不 poll**；連 stdio MCP；起 HTTP `127.0.0.1:7842`（`/inject` 排程注入 + `/update` 收 poller forward）；註冊所有 `bot.command` / `bot.on` handler；`/update` 收到時設 `bot.botInfo=me` 後呼 `bot.handleUpdate(update)`（network-driven，不會餓死） |
| `poller.ts` | 獨立 poll 進程（a1-b 用 systemd `claude-tg-poller.service` 拉） | idle stdin → 不受餓死影響；`bot.init()`→getMe→me；`setMyCommands`；迴圈 `getUpdates({offset,timeout:25})`，每筆 POST `/update` 帶 `{update, me}`；是 token 的**唯一** getUpdates consumer（無 409 衝突） |
| `inject-port.ts` | 共用 port 解析 | `resolveInjectPort()`，server（bind）與 poller（POST 目標）共用同一 key 避免漂移 |

現行行為關鍵點（dev 動工前務必守住）：

- server.ts **末端沒有** in-process polling（`server.ts:1211-1218` 註解明說「NO in-process polling here」）。
- server.ts 在 aarch64 上刻意用 **tsx(node) 而非 bun** 執行（`server.ts:494` 註解：node 的 libuv 對 stdin/timers/HTTP 排程公平，避開 bun aarch64 餓死；連 HTTP `/update`→`handleUpdate` 路徑在 bun aarch64 都會被餓死）。
- `setMyCommands`（6 個指令）**目前只在 poller.ts:108-118**，server 端沒有。
- `/inject`（排程文字注入為合成 channel 訊息）與 `/update`（poller forward）**共用同一個 HTTP listener**。

## 2. 問題（GCP x86）

GCP x86 環境：只有 `bun`、沒有 `tsx`；launcher 也不起 poller。結果：

1. `.mcp.json` 的 `tsx server.ts` → **tsx 不存在，MCP server 根本起不來**。
2. 就算起得來，**沒人 poll**（poller 未部署）→ bot 收不到任何訊息。

而 decoupled 架構本是繞 **aarch64 餓死 bug**；x86 無此 bug（官方 0.0.6 單進程內建 `bot.start()` 一直正常）。

## 3. 方案（已定，方案 A，不重新發散選型）

telegram plugin 改**雙模式跨平台超集（描述性說法：同一份 code 依平台走兩條 poll 路徑）**：

- **x86 / 無餓死 bug 平台**：`builtin` 模式 — 單進程 bun，等同官方 `bot.start()` 內建長輪詢，繞開 `:7842` 的 `/update` HTTP 收 update 路徑。
- **aarch64-linux（a1-b）**：`decoupled` 模式 — 維持既有 server + poller.ts + `:7842`。

---

## 4. 模式切換機制設計

### 4.1 關鍵事實（決定設計的硬約束）

1. **餓死 bug 不分 bun/node，只看 aarch64**：`poller.ts:6-11` 明寫「on bun/node (aarch64)」。→ 在 aarch64-linux 上，**builtin 模式無論用哪個 runtime 都不可能成立**（in-process poll 一定餓死）。
2. **runtime 選擇必須在啟動前決定**：server.ts 一旦被某 runtime 執行就無法自己換 runtime。→ runtime 由 launcher（launch.sh）依平台/模式選定。
3. **decoupled 模式需要外部 poller 進程在跑**（a1-b 是 systemd）。→ 在沒部署 poller 的平台自動選 decoupled = bot 收不到訊息（靜默失效）。builtin 無此依賴。
4. **x86 GCP 沒有 tsx**：→ 在 GCP 上不可能走 tsx(node) runtime。

### 4.2 取捨：純 env 開關 vs 純 `process.arch` 自動偵測 vs 混合

| 方案 | 優點 | 缺點 |
|---|---|---|
| 純 env（`TELEGRAM_POLL_MODE`） | 明確、可測試、可強制 | 每台都要手設；漏設 = 用錯模式靜默失效 |
| 純 `process.arch` 自動偵測 | 兩個生產目標零設定即正確 | 無法覆寫；arm64-darwin（Mac 開發機）誤判成需 poller |
| **混合（建議）** | 生產目標零設定正確 + 邊角可覆寫 | 需一條 clamp 防呆規則 |

### 4.3 建議：混合（env 覆寫 + 平台預設 + clamp）

**單一決策函式** `resolvePollMode(arch, platform, rawEnv)`（抽到新檔 `poll-mode.ts`，鏡像 `inject-port.ts` 的純函式 + 單元測試模式）：

```
預設（rawEnv 未設）:
  decoupled  iff  (arch === 'arm64' && platform === 'linux')   # 只有 arm64-linux 有已證實的餓死 bug
  否則       builtin

env 覆寫（rawEnv 已設，值 'builtin' | 'decoupled'）:
  以 rawEnv 為準
  但 clamp: rawEnv==='builtin' 且 (arch==='arm64' && platform==='linux')
            → 強制回 decoupled + stderr 大聲警告（builtin 在 arm64-linux 證實不可行）

無效 env 值 → 回退平台預設 + 警告（比照 resolveInjectPort 的容錯風格）
```

決策表（含 runtime，見 §6 launch.sh）：

| 平台 | `TELEGRAM_POLL_MODE` | 解析模式 | runtime | 需外部 poller? | 說明 |
|---|---|---|---|---|---|
| aarch64-linux（a1-b） | 未設 | decoupled | tsx(node) | 是（systemd） | 生產，零設定正確 |
| x86-linux（GCP） | 未設 | builtin | bun | 否 | 生產，零設定正確，**修好本 ticket** |
| arm64-darwin（Mac 開發） | 未設 | builtin | bun | 否 | 假設 Mac 無 bug（比照 upstream 單進程在 Mac 一直可用）→ 見待確認 #1 |
| x86/其他 | 未設 | builtin | bun | 否 | 同上 |
| aarch64-linux | `builtin` | decoupled（clamp）| tsx(node) | 是 | 防呆：警告後仍走 decoupled |
| 任一 | `decoupled` | decoupled | tsx(node) | 是 | 測試/強制；x86-GCP 無 tsx 會失敗（見待確認 #4） |
| 任一 | `builtin` | builtin | bun | 否 | 強制單進程 |

**預設值**：`TELEGRAM_POLL_MODE` 未設，由平台自動偵測（arm64-linux→decoupled，否則 builtin）。

**env 與自動偵測如何互動**：env 已設則覆寫自動偵測；唯一例外是「builtin on arm64-linux」被 clamp 回 decoupled（該組合證實不可行）。

## 5. x86 builtin 分支如何接回現有 server（且不破壞 aarch64 decoupled）

### 5.1 改動位置：`server.ts` 末端（現 `1211-1218` 註解區）

現行末端是「不 poll」的說明註解。改為依 `mode` 分支：

- `mode === 'decoupled'`：**完全維持現狀**（不 init、不 poll，靠 poller + `/update`）。這段程式路徑一個字都不動。
- `mode === 'builtin'`：新增內建 poll 分支：
  1. `await bot.init()`（x86 不餓死，getMe 正常）
  2. `botUsername = bot.botInfo.username`（`isMentioned()` 依賴此值，必須在收 update 前設好）
  3. `await bot.api.setMyCommands(BOT_COMMANDS, { scope: { type: 'all_private_chats' } })`（改用共用清單，見 §7）
  4. `bot.start({ onStart })` **不 await**（`bot.start()` 回傳的 promise 直到 stop 才 resolve；await 會卡住 top-level）。`bot.catch`（`server.ts:1207`）已接住 handler 例外，polling 續跑。

> 註：所有 `bot.command`/`bot.on` handler 在 `server.ts:810-1209` 於 module 求值時（`await mcp.connect` 之後）已註冊，都在末端 `bot.start()` 之前 → handler 一定先於 poll 註冊完成，無時序風險。

### 5.2 `:7842` HTTP listener 在 builtin 模式的處置

**保留、不動**。理由：`/inject`（排程注入）在兩個模式都要用；只有 `/update` 在 builtin 模式沒人來打（poller 不跑）。留著 `/update` handler 無害（無 caller）。→ HTTP listener 維持無條件啟動（`server.ts:497-569` 不改）。

### 5.3 回歸風險點（逐一列，dev 自測必覆蓋）

| # | 風險 | 防護 |
|---|---|---|
| R1 | builtin 分支的 `bot.init()`/`bot.start()` 誤在 decoupled 模式執行 → aarch64 餓死 | 嚴格 `if (mode === 'builtin')` 包住 init/start；decoupled 路徑零改動 |
| R2 | 兩個 getUpdates consumer 同時存在 → 409 Conflict | 模式互斥：builtin 由 server poll、decoupled 由 poller poll，絕不同時。**部署層**（JP-72）須確保 x86 上 poller systemd 停用/不部署 |
| R3 | builtin 模式若殘留 `/update` 進來（例如誤啟 poller）→ 重複處理 | `/update` 內 `if (body.me && !bot.isInited())` 已 guard：builtin 已 inited → 不重設 botInfo，`handleUpdate` 仍會跑（只在 poller 誤啟時才發生，屬部署誤配，低風險） |
| R4 | `setMyCommands` 清單 server/poller 兩處漂移 | 抽共用 `bot-commands.ts`，兩邊 import（§7） |
| R5 | `botUsername` 在 builtin 未設好就收 update → group `isMentioned` 判斷失準 | init 後、start 前設定（§5.1 步驟 2） |
| R6 | shutdown 時 builtin 的 poll 未停 → 殘留 zombie 佔 token → 下次 409 | 現有 `shutdown()`（`server.ts:775-786`）已呼 `bot.stop()`，builtin 沿用即可，無需新增 |
| R7 | PID 檔語意 | 維持現狀：server 寫 `bot.pid`（builtin 時它就是 poll holder，stale-kill 正確）；poller 寫 `poller.pid`。不動 |

## 6. `.mcp.json` 適平台（runtime 選擇）

### 6.1 取捨：單檔條件 / 兩份 / wrapper 腳本

- **單檔條件**：`.mcp.json` 是靜態 JSON，Claude Code 讀固定路徑、無法條件分歧 → 不可行。
- **兩份檔**：需外部機制決定讀哪份，Claude Code 不支援 → 不可行。
- **wrapper 腳本（建議）**：`.mcp.json` 的 `command` 指向一個兩平台都有的 runner，由它偵測平台後 `exec` 對的 runtime。

### 6.2 建議：`sh` + `launch.sh`（用 `exec`）

`.mcp.json` 改為：

```json
{
  "mcpServers": {
    "telegram": {
      "command": "sh",
      "args": ["${CLAUDE_PLUGIN_ROOT}/launch.sh"]
    }
  }
}
```

新增 `launch.sh`（POSIX sh，Linux/macOS 都有；`exec` 直接用 server 進程取代 shell，stdio（MCP stdin/stdout）原生穿透、訊號直達 server、無 wrapper 進程殘留）：

```sh
#!/bin/sh
# JP-76: 依平台/模式選 runtime。決策須與 server.ts 的 resolvePollMode 一致。
DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
MODE="$TELEGRAM_POLL_MODE"
if [ -z "$MODE" ]; then
  if [ "$(uname -s)" = "Linux" ] && { [ "$(uname -m)" = "aarch64" ] || [ "$(uname -m)" = "arm64" ]; }; then
    MODE=decoupled
  else
    MODE=builtin
  fi
fi
# runtime 規則：arm64-linux 或 decoupled → tsx(node)；否則 → bun。
# （arm64-linux 一律 tsx，即便 env 誤設 builtin，與 server.ts 的 clamp 對齊）
if { [ "$(uname -s)" = "Linux" ] && { [ "$(uname -m)" = "aarch64" ] || [ "$(uname -m)" = "arm64" ]; }; } || [ "$MODE" = "decoupled" ]; then
  exec tsx "$DIR/server.ts"
else
  exec bun "$DIR/server.ts"
fi
```

**runtime 規則**：`tsx(node)` iff（arm64-linux）OR（mode=decoupled）；否則 `bun`。等價：只有「x86/其他 + builtin」才用 bun。此規則與 §4.3 clamp 對齊，保證 arm64-linux 一律 tsx（即使誤設 builtin，server 端也 clamp 回 decoupled，runtime/mode 一致）。

> **漂移風險（重要）**：平台預設規則同時存在於 launch.sh（shell）與 poll-mode.ts（TS）兩處。規則刻意寫到最簡（`decoupled iff env=decoupled OR (未設 AND arm64-linux)`）讓兩邊都能無腦實作。dev 改動時務必兩邊同步；`poll-mode.test.ts` 覆蓋 TS 側，launch.sh 側靠 review + §9 手測。

## 7. 共用指令清單抽出（`bot-commands.ts`）

`setMyCommands` 的 6 個指令目前只在 `poller.ts:108-118`。builtin 模式 server 也要送同一份。依 CLAUDE.md「magic-string 抽具名常數 / DRY」規範，抽到新檔 `bot-commands.ts`：

```ts
export const BOT_COMMANDS = [
  { command: 'start', description: 'Welcome and setup guide' },
  { command: 'help', description: 'What this bot can do' },
  { command: 'status', description: 'Check your pairing status' },
  { command: 'ctx', description: 'Show context usage' },
  { command: 'clear', description: 'Clear the agent context' },
  { command: 'restart', description: 'Restart the agent' },
] as const
```

`poller.ts` 與 `server.ts`（builtin 分支）都 import 使用，避免漂移（R4）。

## 8. 檔案清單 + 每檔變更摘要

| 檔案 | 動作 | 變更摘要 |
|---|---|---|
| `poll-mode.ts` | 新增 | `resolvePollMode(arch, platform, rawEnv)` 純函式，回 `'builtin' \| 'decoupled'`，含 clamp + 無效值回退 + stderr 警告。鏡像 `inject-port.ts` 風格（含完整 doc + 型別） |
| `poll-mode.test.ts` | 新增 | bun test 覆蓋 §4.3 決策表全矩陣（見 §9） |
| `bot-commands.ts` | 新增 | 匯出共用 `BOT_COMMANDS` 常數 |
| `server.ts` | 修改 | (1) import `resolvePollMode`、`BOT_COMMANDS`；(2) 頂部解析 `const POLL_MODE = resolvePollMode(process.arch, process.platform, process.env.TELEGRAM_POLL_MODE)`；(3) 末端註解區改為 `if (POLL_MODE==='builtin'){ await bot.init(); botUsername=bot.botInfo.username; await setMyCommands(BOT_COMMANDS...); bot.start({onStart}) }`；decoupled 路徑不動；HTTP listener 不動 |
| `poller.ts` | 修改（小） | 只把 inline 指令陣列換成 import `BOT_COMMANDS`；poll 邏輯不動 |
| `.mcp.json` | 修改 | `command: "tsx"` → `command: "sh"`, `args: ["${CLAUDE_PLUGIN_ROOT}/launch.sh"]` |
| `launch.sh` | 新增 | §6.2 平台/模式→runtime 選擇，`exec` 對的 runtime；`chmod +x` |
| `.claude-plugin/plugin.json` | 修改 | version bump（建議 `0.1.4` → `0.2.0`，跨平台新能力；dev/user 確認要不要 0.1.5）|
| `README.md` / `README.zh-TW.md` / `ACCESS.md` | 修改（docs） | 記錄 `TELEGRAM_POLL_MODE` 語意、平台預設、x86 不需 poller |

## 9. 測試（bun `*.test.ts`）新增/修改

### 9.1 新增 `poll-mode.test.ts`（純函式全矩陣）

覆蓋（比照 `inject-port.test.ts` 的 describe/test 風格）：

- arm64+linux+未設 → `decoupled`
- x64+linux+未設 → `builtin`
- arm64+darwin+未設 → `builtin`（Mac 走 builtin；連動待確認 #1）
- x64+darwin+未設 → `builtin`
- arm64+linux+`'builtin'` → `decoupled`（clamp）
- arm64+linux+`'decoupled'` → `decoupled`
- x64+`'decoupled'` → `decoupled`
- x64+`'builtin'` → `builtin`
- 無效值（`''` / `'foo'`）→ 回退平台預設
- 大小寫/空白容錯（若採用，需與 resolveInjectPort 一致的嚴格度；dev 決定是否 trim/lower，列 §10 待確認 #5）

### 9.2 現有測試

- `inject-port.test.ts` / `control-plane.test.ts` / `restart-agent.test.ts` / `startup-notice.test.ts` / `tmux-pane.test.ts`：**不受影響**，回歸跑一次確認全綠。
- `server.ts` 本身有頂層副作用（連 MCP、bind port、poll），不做整檔單元測試 → 邏輯全抽到純函式（`resolvePollMode`）測；server 整合行為走 §9.3 手測。

### 9.3 手動整合驗證（review/自測點）

- **x86 builtin（GCP-like 或本機 x86/Mac）**：`.env` 放 token，`sh launch.sh`（不設 env）→ 確認 (a) MCP server 起得來（bun runtime）(b) DM bot 收得到訊息（單進程 poll）(c) `/inject` 排程注入仍動 (d) 指令選單（setMyCommands）出現。
- **aarch64 decoupled 回歸（a1-b）**：確認 (a) launch.sh 走 tsx (b) server 不 in-process poll (c) 外部 poller→`/update`→handleUpdate 仍通 (d) 無 409。
- **clamp 驗證**：arm64-linux 設 `TELEGRAM_POLL_MODE=builtin` → 確認警告輸出 + 實際走 decoupled + tsx。
- **launch.sh**：`uname -m`（aarch64/arm64/x86_64）分支正確；`exec` 後無殘留 wrapper 進程。

## 10. dev 開工前待確認點（不臆造，需先釐清）

1. **【最關鍵】arm64-darwin（Apple Silicon Mac）是否也餓死？** 決定 Mac 開發機預設走 builtin 還是 decoupled。本計劃預設 Mac→builtin（假設 bug 僅 arm64-linux，比照 upstream 單進程在 Mac 一直可用）。若 Mac 也餓死，需把平台預設改為「arch==='arm64' 一律 decoupled」，並處理 Mac 本機 poller/tsx 供應。→ 影響 §4.3 / §6.2 / §9.1。
2. **bun 在 a1-b 是否在 PATH**（供 launch.sh 的 `command: "sh"` 能被 Claude Code 以 PATH 解析，且 a1-b 分支實際 `exec tsx`——tsx 現行 `.mcp.json` 已用，PATH 應已就緒）。確認 Claude Code spawn MCP `command` 走 PATH 解析。
3. **`bot.start()` 與 MCP `StdioServerTransport` 在 x86 單進程共存**是否確如官方 0.0.6 正常（premise 說正常）。dev 用真 token 在 x86 跑一次確認無餓死。
4. **x86-GCP 強制 `TELEGRAM_POLL_MODE=decoupled` 會失敗**（GCP 無 tsx，launch.sh 走 tsx 分支會找不到）。此為刻意的 unsupported 組合（GCP 本就該 builtin）→ 確認是否要在 launch.sh 加「tsx 不存在則報明確錯誤」的 friendly 提示，或留給部署層。
5. **`TELEGRAM_POLL_MODE` 值的容錯嚴格度**：是否 trim/lowercase、無效值行為，需與 `resolveInjectPort` 的風格一致（後者用 `Number()` 嚴格拒絕 trailing garbage）。dev 定案並反映到 test。
6. **plugin.json 版本號**：建議 `0.2.0`（新能力），或 user 偏好 `0.1.5`。
7. **`onStart` callback 內容**：是否需 log「polling as @username / builtin mode」對齊 poller 的 stderr 訊息風格。

## 11. 回歸測試點速查（給 reviewer）

- [ ] decoupled 程式路徑（server 不 init/poll、`/update`→handleUpdate、`/inject`）一字未改
- [ ] builtin init/start 嚴格包在 `if (POLL_MODE==='builtin')`
- [ ] 兩模式互斥、無雙 getUpdates consumer（409）
- [ ] `setMyCommands` 清單改共用常數、兩處無漂移
- [ ] launch.sh 與 poll-mode.ts 平台預設規則一致
- [ ] arm64-linux clamp（env=builtin→decoupled+warn）
- [ ] HTTP listener 無條件保留（`/inject` 兩模式可用）
- [ ] shutdown `bot.stop()` 在 builtin 一樣清乾淨（無殘留 token holder）
- [ ] 全 bun test 綠 + x86 手測 + a1-b 回歸手測

---

## 附：實作順序建議（dev）

1. `bot-commands.ts` → 改 `poller.ts` import（最小、可先綠）
2. `poll-mode.ts` + `poll-mode.test.ts`（純函式，TDD）
3. `server.ts` builtin 分支（守住 decoupled 零改動）
4. `launch.sh` + `.mcp.json`（`chmod +x launch.sh`）
5. docs + plugin.json version bump
6. 全 test + 手測（§9.3）→ push → `gh pr create --repo itmrchow/itmrchow-plugins --draft`
