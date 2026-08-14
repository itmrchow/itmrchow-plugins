---
name: im-session-resume
description: 任一 IM channel 收到 /resume 斜線指令時列出可切換的對話（一般使用者只看自己 scope、管理員看全部；群組裡對一般使用者不受理），用戶回覆編號後切換。列表與確認皆回原 IM。
---

## 目的

列出這個發話者**看得到**的對話，回覆編號即切換過去。

看得到的範圍依身分而定：一般使用者只有自己這個 scope 的對話；管理員看得到全部 scope，
每列標注它屬於哪個 scope。

在**群組**裡，一般使用者一律不受理（回「這個指令只能在私訊使用」）；管理員仍可用。

## 執行步驟

先讀 `$IM_CORE_DIR/skills/im-common.md`（前置載入、`SRC` / `CID` / `UID` 取法、身分判定）。

### 第一輪：用戶送 /resume

```bash
: "${IM_CORE_DIR:?IM_CORE_DIR not set — launcher 未匯出，im-core plugin 環境不完整}"
: "${IM_SEND_BIN:?IM_SEND_BIN not set — 應指向 im-core 的 scripts/im-send.sh}"
source "$IM_CORE_DIR/scripts/lib/lib-loader.sh" || exit 1

if im_is_admin "<SRC>" "<UID>"; then IS_ADMIN=0; else IS_ADMIN=1; fi

# 第零道：這個場合能不能用這個指令。群組對一般使用者直接不受理，連清單都不算
if ! im_resume_allowed "$AGENT_SCOPE" "$IS_ADMIN"; then
  "$IM_SEND_BIN" "<SRC>" "<CID>" "這個指令只能在私訊使用"
  exit 0
fi

ROWS="$(im_sessions_rows "$AGENT_SCOPE" "$IS_ADMIN")"

# 暫存檔逐 scope 分開，且不放 /tmp（world-writable，本機任何人都能覆蓋）
ROWS_FILE="${AGENT_SCOPES_DIR:-$HOME/.claude/agent-scopes}/${AGENT_SCOPE}.resume-rows"
mkdir -p "$(dirname "$ROWS_FILE")"
printf '%s' "$ROWS" > "$ROWS_FILE"

if [ -z "$ROWS" ]; then
  "$IM_SEND_BIN" "<SRC>" "<CID>" "目前沒有可切換的對話"
else
  LIST="$(im_format_list "$ROWS" 1900 "$IS_ADMIN")"
  "$IM_SEND_BIN" "<SRC>" "<CID>" "請選擇要切換的對話（回覆編號）：

$LIST"
fi
```

**本輪結束，等待用戶回覆編號。**

### 第二輪：用戶回覆編號

用戶回覆純數字、且上下文顯示剛才列過清單時：

```bash
: "${IM_CORE_DIR:?IM_CORE_DIR not set — launcher 未匯出，im-core plugin 環境不完整}"
: "${IM_SEND_BIN:?IM_SEND_BIN not set — 應指向 im-core 的 scripts/im-send.sh}"
source "$IM_CORE_DIR/scripts/lib/lib-loader.sh" || exit 1
SEND="$IM_SEND_BIN"

ROWS_FILE="${AGENT_SCOPES_DIR:-$HOME/.claude/agent-scopes}/${AGENT_SCOPE}.resume-rows"
ROWS="$(cat "$ROWS_FILE" 2>/dev/null)"

# 編號只對「第一輪存下來的那份」解析
SID="$(im_row_sid "$ROWS" "<用戶回覆的數字>")"
TARGET_SCOPE="$(im_row_scope "$ROWS" "<用戶回覆的數字>")"

# 第二道檢查：用「回這個編號的人」自己的身分重算一次可見範圍，確認這筆真的看得到
if im_is_admin "<SRC>" "<UID>"; then IS_ADMIN=0; else IS_ADMIN=1; fi
if ! im_resume_allowed "$AGENT_SCOPE" "$IS_ADMIN" || [ -z "$SID" ] || [ -z "$TARGET_SCOPE" ] || ! im_sid_visible "$AGENT_SCOPE" "$IS_ADMIN" "$SID"; then
  "$SEND" "<SRC>" "<CID>" "找不到該對話"
  rm -f "$ROWS_FILE"
  exit 0
fi

if ! im_write_intent "$TARGET_SCOPE" resume "$SID"; then
  "$SEND" "<SRC>" "<CID>" "切換失敗，請稍後再試或聯絡管理員"
  rm -f "$ROWS_FILE"
  exit 0
fi

"$SEND" "<SRC>" "<CID>" "切換中，重啟後進入該對話…"
tmux send-keys -t "$(scope_tmux_target "$TARGET_SCOPE")" "/exit" Enter
rm -f "$ROWS_FILE"
```

切到的是**別的** scope 時（只有 admin 有這種列），確認訊息改成明說切的是哪個 scope，
例如「已切換 group 的對話，重啟後生效」—— 因為發話者自己這邊的對話不會有任何變化，
不講清楚會看起來像指令沒生效。

## 注意

- **權限檢查有三道，三道都必要**：
  0. 場合檢查（`im_resume_allowed`）—— 群組裡對一般使用者直接不受理。群組是共享空間，
     列出對話清單等於把「有哪些人在跟 bot 私訊」洩漏給整個群組；即使每一列都屬於發問者
     本人，這件事本身就是洩漏。admin 在群組裡仍可用，因為他本來就看得到全部。
     **第二輪也要再檢查一次**：admin 在群組裡列了清單之後，非 admin 可以直接回一個編號，
     那條路徑不經過第一輪。
  1. 產列表時的過濾（`im_sessions_rows`）—— 決定這個人「當下看得到什麼」。
  2. 切換前的成員檢查（`im_sid_visible`）—— 用**回編號那個人**的身分重算一次，確認選中的
     sid 真的在他看得到的範圍內。
  為什麼第一道不夠：列表是「第一個送 /resume 的人」的產物，而同一個 scope 的 `allowFrom`
  可以有不只一人。admin 送 `/resume`（列表橫跨兩個 scope）→ 另一個非 admin 回編號，讀到
  的就是別人的列表。路徑一樣、scope 一樣，第一道完全擋不住。
- **編號只對第一輪存下的那份 rows 解析，絕對不要拿重算的結果取第 n 筆**。重算的排序依
  transcript mtime，兩輪之間會變動，用新序號會切到別人那筆。重算出來的那份**只當作
  「可見 sid 的集合」**做成員檢查。這條看起來可以簡化成「直接用新 rows 取第 n 筆」，
  簡化下去就把上面那個越權漏洞重新裝回來。
- 暫存 rows 檔逐 scope 分開放在 `~/.claude/agent-scopes/<scope>.resume-rows`，不放 `/tmp`：
  `/tmp` 是 world-writable，固定路徑等於讓本機任何人偽造列表內容。
- 看不到 / 超出範圍的編號一律回「找不到該對話」，**不要**回「那是別的 scope 的」——
  後者等於告訴一般使用者另一個 scope 存在。
- intent 檔路徑由 `scope_intent_file` 決定（`~/.claude/agent-scopes/<scope>.resume`）。
  舊版寫的 `/tmp/claude-tg-next-session` 已經沒有人讀了。
- **`im_write_intent` 失敗就停**，不要繼續送 `/exit`：那會讓 agent 重啟後停在原本的對話，
  使用者看到的是「指令沒反應」。
- `/exit` 要送到**目標 scope 的 window**（`scope_tmux_target`），不是自己的。admin 在
  私訊裡切 group 的對話時，該重啟的是 group 那個 window。
- 列表上限 1900 字（Discord 單則 2000 的安全邊界），`im_format_list` 會切在完整一列。
- 切換後 launcher 需要幾秒重啟，屬正常現象。
