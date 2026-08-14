---
name: im-help
description: 任一 IM channel 收到 /help 指令時，依發話者身分回覆可用指令清單（一般使用者版 / 管理員版）。
---

## 目的

回覆這個 bot 支援哪些指令。清單依身分不同：管理員多看到 `/restart` 與 `/create-token`。

## 執行步驟

先讀 `.claude/skills/im-common.md`（前置載入、`SRC` / `CID` / `UID` 取法、身分判定）。

```bash
IM_LIB="$(dirname "${IM_SEND_BIN:-$HOME/claude-tg-agent/scripts/im-send.sh}")"
source "$IM_LIB/lib-channels.sh"; source "$IM_LIB/lib-scope.sh"; source "$IM_LIB/lib-im.sh"

if im_is_admin "<SRC>" "<UID>"; then IS_ADMIN=0; else IS_ADMIN=1; fi
"${IM_SEND_BIN:-$HOME/claude-tg-agent/scripts/im-send.sh}" "<SRC>" "<CID>" "$(im_help_text "$IS_ADMIN")"
```

`<SRC>` / `<CID>` / `<UID>` 換成入站 `<channel>` tag 的實際值。

## 注意

- 清單內容由 `im_help_text` 產生，**不要**在這裡另外手寫一份 —— 兩份清單會分岔，而分岔
  的症狀是 help 說有的指令實際上不存在。
- `/start` 兩個版本都不列：列了等於告訴陌生人邀請機制存在，與 gate 靜默丟棄的原則相反。
- `/ctx` 由 plugin 提供、不歸這裡管，同樣不列（假設 A-6）。
- telegram 的 `bot.command('help')` 會先攔截，所以本 skill 目前只在 discord 生效；
  telegram 要等 plugin 的 control-command 開關一併放行 `help`。
