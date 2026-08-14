---
name: im-session-clear
description: 任一 IM channel（Telegram / Discord 等）收到 /clear 斜線指令時結束目前對話、以新的 session id 重開一個。確認訊息送回原 IM。
---

## 目的

結束目前這個 scope 的對話、換一個**全新的 session id** 重開，確認訊息回到發出指令的 IM。

與舊行為的差別：舊版只送 `/clear` 清 context，session id 不變，所以 `/resume` 列表上
還是同一筆、舊對話與新對話混在同一個 transcript 裡。現在換 id，新舊對話是兩筆。
**舊 transcript 不刪**，`/resume` 仍找得回來。

## 執行步驟

先讀 `$IM_CORE_DIR/skills/im-common.md`（前置載入、`SRC` / `CID` 取法）。無需 admin。

```bash
: "${IM_CORE_DIR:?IM_CORE_DIR not set — launcher 未匯出，im-core plugin 環境不完整}"
: "${IM_SEND_BIN:?IM_SEND_BIN not set — 應指向 im-core 的 scripts/im-send.sh}"
: "${IM_LIB_DIR:?IM_LIB_DIR not set — 需指向 claude-tg-agent 的 scripts 目錄}"
source "$IM_LIB_DIR/lib-channels.sh"; source "$IM_LIB_DIR/lib-scope.sh"; source "$IM_LIB_DIR/lib-im.sh"

SEND="$IM_SEND_BIN"
SCOPE="$AGENT_SCOPE"
NEW_ID="$(scope_new_uuid)"

# 寫失敗就停在這裡：底下的 /exit 照送的話，agent 會重啟回原本那個 session。
if ! im_write_intent "$SCOPE" new-session "$NEW_ID"; then
  "$SEND" "<SRC>" "<CID>" "切換失敗，請稍後再試或聯絡管理員"
  exit 0
fi

# 背景送確認：/exit 之後本 skill 不再執行，確認只能由背景進程送。
# 一定要排在上面那個失敗檢查之後 —— 先發的話，失敗時使用者會收到「已開始新的對話」。
( sleep 3 && "$SEND" "<SRC>" "<CID>" "已開始新的對話，先前的內容仍可用 /resume 找回" >/dev/null 2>&1 ) &

tmux send-keys -t "$(scope_tmux_target "$SCOPE")" "/exit" Enter
```

`<SRC>` / `<CID>` 換成入站 `<channel>` tag 的實際值。

## 注意

- intent 檔是**一次性**的：launcher 讀完就刪，所以就算這次重啟出了問題，也不會把這個
  scope 永遠釘在同一個 id 上。
- 送的是 `/exit` 不是 `/clear`：換 session id 只能靠重啟時帶 `--session-id`，claude
  進程活著的時候換不了。
- `tmux send-keys` 的目標一律用 `scope_tmux_target "$SCOPE"`（本 scope 的 window），與
  `/resume` 同一套寫法。**不要**退回 session 名（例如 `${TMUX_TARGET:-claude-tg-agent}`
  這種 fallback）：`send-keys` 對 session 名會送到當下的 active window，也就是可能打斷
  另一個 scope。未知 scope 時 `scope_tmux_target` 回非 0，寧可中止也不要打錯 window。
- **`im_write_intent` 失敗就停**，而且背景確認訊息要排在檢查之後：順序寫反的話，使用者
  會收到「已開始新的對話」但實際上還在原本那個。
- `/exit` 送出後 context 立即消失，後續步驟不會執行 —— 任何要回覆的話都得在這之前發出，
  或交給背景進程。
