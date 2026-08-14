---
name: im-session-rename
description: 任一 IM channel 收到 /rename <name> 斜線指令時替當前 session 命名，寫入 ai-title 到 session JSONL，確認回原 IM。
---

## 目的

把用戶傳來的 `/rename <name>` 中的 `<name>` 寫入當前 session JSONL，使 /resume 列表立刻顯示新名稱。

## 執行步驟

1. 從入站 `<channel>` tag 取 `source`（SRC）與 `chat_id`（CID）。從訊息文字去掉 `/rename ` 前綴取得 `<name>`；若沒有名稱則 `"${IM_SEND_BIN:-$HOME/claude-tg-agent/scripts/im-send.sh}" "<SRC>" "<CID>" "請提供名稱，例如：/rename 我的工作 Session"` 後停止。

2. 取得當前 session 資訊：

   - Session ID: `$CLAUDE_CODE_SESSION_ID`
   - Workspace path: `$AGENT_WORKSPACE_DIR`（launcher 匯出的 workspace；**不要用 `$PWD`**，
     skill 可能在任何目錄執行，算出來的目錄不存在時症狀是「改名沒反應」）
   - JSONL 路徑計算：將 workspace 的 `/` 替換為 `-`，組成
     `~/.claude/projects/${AGENT_WORKSPACE_DIR//\//-}/${CLAUDE_CODE_SESSION_ID}.jsonl`

3. 把 `<name>` 寫入暫存檔（以 **Write tool** 執行，不要用 Bash）。`<name>` 可能含 `"`、`$`、
   反引號、`$( )`、換行等字元；若把 `<name>` 放進任何 bash 字串（即使是賦值 `VAR="<name>"`），
   在 shell 解析該行時就可能被 break out 造成命令注入。故 `<name>` 全程不得進入被 shell 解析
   的位置。用 Write tool 把**原始 `<name>` 字串**（不加引號、不轉義、不加額外內容）寫入固定暫存檔：

   - Write tool `file_path`: `~/.claude/agent-scopes/<AGENT_SCOPE 的值>.rename-title`
     （例如 scope 是 `telegram-dm-123456789` 就是 `~/.claude/agent-scopes/telegram-dm-123456789.rename-title`。
     不放 `/tmp`：那裡 world-writable 且路徑固定，本機任何人都能覆蓋掉這個檔）
   - Write tool `content`: 原始 `<name>` 字串本身

   Write tool 參數為結構化傳遞、不經 shell 解析，含特殊字元的 `<name>` 只會被當成純文字檔內容。

4. Append ai-title 到 JSONL（以 Bash 執行）。`<name>` 從暫存檔讀進環境變數再交 python `json.dumps`
   安全組裝物件；`VAR="$(cat file)"` 的值直接賦入變數、不會被重新 tokenize，命令列上無 `<name>` 字面：

```bash
WORKSPACE="${AGENT_WORKSPACE_DIR:-$PWD}"
SESSION_JSONL="${HOME}/.claude/projects/${WORKSPACE//\//-}/${CLAUDE_CODE_SESSION_ID}.jsonl"
TITLE_FILE="${AGENT_SCOPES_DIR:-$HOME/.claude/agent-scopes}/${AGENT_SCOPE}.rename-title"
RENAME_TITLE="$(cat "$TITLE_FILE" 2>/dev/null)" python3 -c '
import json, os
title = os.environ["RENAME_TITLE"]
session_id = os.environ["CLAUDE_CODE_SESSION_ID"]
print(json.dumps({"type": "ai-title", "aiTitle": title, "sessionId": session_id}))
' >> "$SESSION_JSONL"
```

5. 回覆用戶（同步，rename 不毀 context）。`<name>` 從暫存檔讀入、不進 shell 字面，避免注入：

   ```bash
   TITLE_FILE="${AGENT_SCOPES_DIR:-$HOME/.claude/agent-scopes}/${AGENT_SCOPE}.rename-title"
   RENAME_TITLE="$(cat "$TITLE_FILE" 2>/dev/null)" \
     "${IM_SEND_BIN:-$HOME/claude-tg-agent/scripts/im-send.sh}" "<SRC>" "<CID>" "Session 已命名為「${RENAME_TITLE}」"
   rm -f "$TITLE_FILE"
   ```

## 注意

- 直接 append，不修改既有內容，Claude Code 讀取時取最後一筆 ai-title
- 若 JSONL 路徑不存在，回覆「找不到 session 檔案，請確認 CLAUDE_CODE_SESSION_ID 已設定」
- 名稱**只寫 JSONL 的 `ai-title` 這一處**。claude 自己的 `/resume` 介面與本專案的
  `/resume` skill（`im_sessions_rows`）讀的都是它，沒有第二份要同步
- 不需要 admin：改名只影響自己 scope 的對話
