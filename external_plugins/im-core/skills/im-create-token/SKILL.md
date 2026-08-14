---
name: im-create-token
description: 任一 IM channel 收到 /create-token 指令時產生一組 7 天效期的邀請碼（限管理員、限私訊 scope），回覆可直接轉發的 /start <token> 全文。
---

## 目的

產生邀請碼給還沒有權限的人。對方拿到後在 bot 私訊送 `/start <token>` 即可被加進
allowlist。

效期固定 **7 天**，不開放參數。指令參數只當備註（記給人看的，例如給誰）。

## 執行步驟

先讀 `$IM_CORE_DIR/skills/im-common.md`（前置載入、身分判定、拒絕說法）。

```bash
: "${IM_CORE_DIR:?IM_CORE_DIR not set — launcher 未匯出，im-core plugin 環境不完整}"
: "${IM_SEND_BIN:?IM_SEND_BIN not set — 應指向 im-core 的 scripts/im-send.sh}"
: "${IM_LIB_DIR:?IM_LIB_DIR not set — 需指向 claude-tg-agent 的 scripts 目錄}"
source "$IM_LIB_DIR/lib-channels.sh"; source "$IM_LIB_DIR/lib-scope.sh"; source "$IM_LIB_DIR/lib-im.sh"

if ! im_is_admin "<SRC>" "<UID>"; then
  "$IM_SEND_BIN" "<SRC>" "<CID>" "這個指令需要管理員權限"
  exit 0
fi
if [ "$(scope_kind "$AGENT_SCOPE")" != "dm" ]; then
  "$IM_SEND_BIN" "<SRC>" "<CID>" "這個指令只能在私訊使用"
  exit 0
fi

NOTE_FILE="${AGENT_SCOPES_DIR:-$HOME/.claude/agent-scopes}/${AGENT_SCOPE}.token-note"
TOKEN="$(im_invite_create "<SRC>" "<UID>" "$(cat "$NOTE_FILE" 2>/dev/null)")"
"$IM_SEND_BIN" "<SRC>" "<CID>" "邀請碼已產生（7 天內有效），把下面這行轉給對方：

/start $TOKEN"
rm -f "$NOTE_FILE"
```

備註（`/create-token` 後面的文字）與 `/rename` 的名稱一樣可能含 `` ` ``、`$( )` 等字元，
所以**先用 Write tool 把原始字串寫進 `~/.claude/agent-scopes/<AGENT_SCOPE 的值>.token-note`**
（例如 `~/.claude/agent-scopes/telegram-dm-123456789.token-note`），再由上面的 `$(cat …)` 以參數傳入。
不放 `/tmp`：那裡 world-writable 且路徑固定。備註為空時不必建這個檔（`cat` 失敗會得到空
字串，函式會直接省略 `note` 欄）。

## 注意

- 回的是**純文字 `/start <token>`**，不組 telegram deep-link：Spec 定案「通用不分平台」，
  deep-link 只有 telegram 有，組了在 discord 是壞連結。
- token 寫進 `~/.claude/channels/invites.json`，與 channel plugin、`im-invite` skill 是
  **同一份檔、同一套 schema**，所以三邊產的碼互通、也互相看得到。
- `im_invite_create` 每次都重新讀整份檔再整份寫回：channel server 隨時可能就地改
  `usedBy` 或清掉過期墓碑，用對話裡稍早讀到的內容寫回去會把那些改動洗掉。
- **永不寫 `admins`、永不寫 `access.json`**。邀請碼只讓人進得來，不讓人變成管理員 ——
  否則「拿到 invite 的人靠對話自我提權」這條路就通了。
- 非 admin 或非私訊 scope 一律只回一句話，不解釋為什麼、不透露這個指令在別的地方
  可用。
