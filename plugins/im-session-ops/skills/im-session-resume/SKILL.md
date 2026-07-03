---
name: im-session-resume
description: 任一 IM channel 收到 /resume 斜線指令時列出近期 sessions，用戶回覆編號後切換。列表與切換確認皆回原 IM。
---

## 目的

列出當前 workspace 的所有 Claude Code sessions（含名稱與 ID），用戶回覆編號後切換到該 session。

## 執行步驟

### 第一輪：用戶送 /resume

1. 掃描 session 目錄，建立列表（Bash）：

```bash
SESSION_DIR="${HOME}/.claude/projects/${PWD//\//-}"
python3 - <<'EOF'
import os, json, glob

session_dir = os.path.expandvars("${HOME}/.claude/projects/" + os.environ.get("PWD","").replace("/","-"))
files = sorted(glob.glob(f"{session_dir}/*.jsonl"), key=os.path.getmtime, reverse=True)

sessions = []
for f in files:
    sid = os.path.basename(f).replace(".jsonl","")
    title = None
    try:
        for line in open(f):
            try:
                obj = json.loads(line)
                if obj.get("type") == "ai-title":
                    title = obj.get("aiTitle")
            except: pass
    except: pass
    mtime = os.path.getmtime(f)
    from datetime import datetime
    date = datetime.fromtimestamp(mtime).strftime("%m/%d %H:%M")
    label = title if title else "（未命名）"
    sessions.append((sid, label, date))

for i, (sid, label, date) in enumerate(sessions, 1):
    print(f"{i}. {label}  [{sid[:8]}]  {date}")
EOF
```

2. 先從入站 `<channel>` tag 取 `source`（SRC）/ `chat_id`（CID），把列表字串透過 `"${CLAUDE_PLUGIN_ROOT}/bin/im-send" "<SRC>" "<CID>" "<列表文字>"` 送出（取代原 Telegram reply）。列表文字格式如下：

```
請選擇要切換的 Session（回覆編號）：

1. TG Bot Debug & Setup  [c77e4674]  06/01 10:40
2. （未命名）  [3ae4f3a5]  06/01 09:30
```

   Discord 單則訊息上限 2000 字：列表過長時截斷至最後完整一行（不要在行中間切斷），確保送出的內容是完整的若干列。

3. **本輪結束，等待用戶回覆。**

---

### 第二輪：用戶回覆編號

當 agent 看到用戶回覆純數字（且上下文顯示剛才列了 session 列表）時，執行以下動作：

1. 對照列表取得對應 session ID。
2. 寫入 intent file：`echo "<session-id>" > "${IM_SESSION_INTENT_FILE:-/tmp/claude-tg-next-session}"`
3. 同步送確認到原 IM（必須在 /exit 之前）：
   `"${CLAUDE_PLUGIN_ROOT}/bin/im-send" "<SRC>" "<CID>" "切換中，重啟後進入 Session「<name>」..."`
4. 送 /exit 給 tmux：`tmux send-keys -t "${IM_AGENT_TMUX_SESSION:-claude-tg-agent}" "/exit" Enter`

`<SRC>` / `<CID>` 取自第二輪當下的入站 `<channel>` tag（用戶回覆編號那則訊息），與第一輪同 channel。restart loop 讀取 intent file 後用 `--resume <session-id>` 重啟。

## 注意

- 若列表為空，回覆「找不到任何 session，請確認 workspace 路徑正確」
- 用戶回覆超出範圍的數字，回覆「編號無效，請重新選擇」
- 切換後 restart loop 需幾秒重啟，屬正常現象
