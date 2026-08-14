---
name: im-restart
description: 任一 IM channel 收到 /restart 指令時重啟整個 agent 服務（限管理員）。重啟後兩個 scope 各自自動接回原本的對話。
---

## 目的

重啟 agent 服務。這是**單一全域重啟** —— 一次把整個 systemd unit 重啟，兩個 scope 都會
重來，不分「只重啟我這個 scope」。

重啟後兩個 scope 各自讀自己的 pointer 檔 `--resume` 回原本的對話，所以對話不會丟。

## 執行步驟

先讀 `.claude/skills/im-common.md`（前置載入、身分判定、拒絕說法）。

```bash
IM_LIB="$(dirname "${IM_SEND_BIN:-$HOME/claude-tg-agent/scripts/im-send.sh}")"
source "$IM_LIB/lib-channels.sh"; source "$IM_LIB/lib-scope.sh"; source "$IM_LIB/lib-im.sh"

if ! im_is_admin "<SRC>" "<UID>"; then
  "${IM_SEND_BIN:-$HOME/claude-tg-agent/scripts/im-send.sh}" "<SRC>" "<CID>" "這個指令需要管理員權限"
  exit 0
fi

# 先回覆再動作：restart 會殺掉自己，之後沒有任何機會發訊息。
"${IM_SEND_BIN:-$HOME/claude-tg-agent/scripts/im-send.sh}" "<SRC>" "<CID>" "重啟中，稍後回來"
sudo systemctl restart claude-tg-agent
```

`<SRC>` / `<CID>` / `<UID>` 換成入站 `<channel>` tag 的實際值。

## 注意

- **回覆一定要在 `systemctl restart` 之前**。順序寫反的話使用者不會收到任何東西，只會
  看到 bot 安靜幾十秒。
- 非 admin 只回一句「需要管理員權限」，不解釋是誰、不列出誰是 admin。
- **unit 名不得加 `.service`**。sudoers 是字面 argv 比對，授權的字串是
  `/usr/bin/systemctl restart claude-tg-agent`；寫成 `claude-tg-agent.service` 比對不上，sudo 會
  轉去要密碼，而這裡沒有 tty —— 症狀是指令靜默失敗、使用者只看到 bot 不動。
  `scripts/watchdog/lib.sh` 的 `wd_restart` 用的也是無副檔名版本，兩邊要一致（有測試釘住）。
- `sudo` 走 `deploy/oci/claude-watchdog.sudoers` 的 scoped NOPASSWD 規則，只准這一條
  unit。若回報 sudo 需要密碼，代表該規則沒涵蓋 agent 帳號 —— 回報「重啟失敗，請檢查
  sudoers 設定」，不要嘗試用別的方式繞過去重啟。
- 重啟不需要（也不應該）寫任何 intent 檔：pointer 檔本來就在，launcher 會自己 `--resume`。
  多寫一個 intent 檔反而會把還沒過期的對話換掉。
- 這個指令要能進到 agent，前提是 plugin 端的 control-command 開關已放行 `restart`
  （JP-175）。開關沒放行時 plugin 會自己攔截處理，本 skill 收不到。
