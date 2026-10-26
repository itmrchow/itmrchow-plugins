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
source "$IM_CORE_DIR/scripts/lib/lib-loader.sh" || exit 1

SEND="$IM_SEND_BIN"
SCOPE="$AGENT_SCOPE"

# tmux 函式住在宿主的 lib，由 IM_TMUX_LIB 定址；缺值或載不起來就回報失敗並停下。
if ! ( : "${IM_TMUX_LIB:?IM_TMUX_LIB not set — launcher 未匯出，應指向 carrier 的 scripts/lib-scope-tmux.sh}" ) \
   || ! source "$IM_TMUX_LIB"; then
  "$SEND" "<SRC>" "<CID>" "切換失敗：IM_TMUX_LIB 未設定或載入失敗，請聯絡管理員"
  exit 0
fi

# 先取得 window；取不到就停在這裡，intent 一個字都還沒寫。
if ! TARGET="$(scope_tmux_target "$SCOPE")" || [ -z "$TARGET" ]; then
  "$SEND" "<SRC>" "<CID>" "切換失敗，請稍後再試或聯絡管理員"
  exit 0
fi

NEW_ID="$(scope_new_uuid)"
if ! im_write_intent "$SCOPE" new-session "$NEW_ID"; then
  "$SEND" "<SRC>" "<CID>" "切換失敗，請稍後再試或聯絡管理員"
  exit 0
fi

# /exit 送不出去就撤回剛寫的 intent，讓下次重啟維持原本的 session。
if ! tmux send-keys -t "$TARGET" "/exit" Enter; then
  rm -f "$(scope_intent_file "$SCOPE" new-session)"
  "$SEND" "<SRC>" "<CID>" "切換失敗，請稍後再試或聯絡管理員"
  exit 0
fi

# /exit 已送出，確認交給背景進程送（本 skill 在 /exit 後不再執行）。
( sleep 3 && "$SEND" "<SRC>" "<CID>" "已開始新的對話，先前的內容仍可用 /resume 找回" >/dev/null 2>&1 ) &
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
- 執行順序固定如下，任一步失敗就回報「切換失敗…」並停下（`IM_TMUX_LIB` 那一步的訊息點名該變數，因為重試無效、要管理員修宿主設定）：
  - [ ] source `$IM_TMUX_LIB`（宿主 launcher 匯出，值是 carrier 的 `scripts/lib-scope-tmux.sh`
        完整路徑）
  - [ ] 以 `scope_tmux_target` 取得 window（回非 0 或空字串都算失敗）
  - [ ] `im_write_intent` 寫 `new-session` intent
  - [ ] `tmux send-keys` 送 `/exit`；回非 0 時先刪掉剛寫的 intent（`scope_intent_file` 給路徑）
  - [ ] 送出成功後才由背景進程發「已開始新的對話」
  這個順序讓 intent 只在 `/exit` 確實送出時留下，確認訊息也只在送出成功後才發；曾發生
  `/exit` 沒送出、intent 卻已寫入、使用者照樣收到「已開始新的對話」的誤報。
- `scope_tmux_target` 一律來自 `$IM_TMUX_LIB`：window 怎麼命名是宿主的知識，plugin 端
  只負責 source 宿主給的那份 lib。
- `/exit` 送出後 context 立即消失，後續步驟不會執行 —— 任何要回覆的話都得在這之前發出，
  或交給背景進程。
