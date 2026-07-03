---
name: im-session-clear
description: 任一 IM channel（Telegram / Discord 等）收到 /clear 斜線指令時清空當前對話 context。透過 tmux 送 /clear 給 claude-tg-agent，並把確認訊息送回原 IM。
---

## 目的

清空 Claude Code 的對話 context（不刪 session 歷史），讓下一輪對話從乾淨狀態開始，確認訊息回到發出指令的 IM。

## 執行步驟

1. 從入站 `<channel>` tag 取 `source` 與 `chat_id`（例：`<channel source="discord" chat_id="123" ...>` → SRC=discord、CID=123）。

2. 執行 Bash（一次執行，順序如下）。`SRC` / `CID` 由本 skill 依步驟 1 填入：

```bash
# 背景：等 3 秒（讓 /clear 完成）再送確認到原 IM。
# context 一清本 skill 後續不執行，故確認必須由背景進程送。
( sleep 3 && "${CLAUDE_PLUGIN_ROOT}/bin/im-send" "<SRC>" "<CID>" "Context 已清除，新對話從乾淨狀態開始" >/dev/null 2>&1 ) &

# 送出 /clear（context 立即重置，後續步驟不再執行）
tmux send-keys -t "${IM_AGENT_TMUX_SESSION:-claude-tg-agent}" "/clear" Enter
```

**重要**：`<SRC>` / `<CID>` 必須替換為入站 `<channel>` tag 的實際 `source` / `chat_id`。

## 注意

- `/clear` 送出後當前 session 立即重置 context，本 skill 後續步驟不會被執行
- 確認訊息由背景 `im-send` 直接打對應 IM API 發送，不依賴 Claude context、不綁單一 channel
- im-send 路徑由 `${CLAUDE_PLUGIN_ROOT}/bin/im-send` 提供（Claude Code 給 plugin 的環境變數，指向本 plugin 根目錄）；token 解析失敗時背景進程靜默退出（stderr 已重導），不阻斷 /clear
- 若 tmux session 不存在會報錯，可忽略（代表 agent 不在 tmux 中執行）
- `IM_AGENT_TMUX_SESSION` 的預設值為 load-bearing（描述性說法：預設值本身就是正確行為的一部分，不能亂改）：agent 的 restart loop（`start-tg-agent.sh`）目前仍硬編此 session 名、尚未讀此 env。單獨覆寫此 env 會與 loop 端失步（send-keys 送到別的 tmux session -> /clear 打錯目標）。loop 端接線待 JP-96 rename 時一併處理；目前請維持預設、不要覆寫。
- session 歷史 JSONL 不受影響，只有記憶體 context 被清除
