# itmrchow-plugins

fork 自 Anthropic 官方 plugin 目錄的個人 marketplace。`plugins/` 多為官方 vendored、`external_plugins/` 原為第三方 MCP wrapper，但其中數個（`telegram` / `discord` 等）本 repo 已有自己的改動，跟 upstream 分家了。

## Version Bump 規則

Plugin 改動 merge 進 main 後**不會自動生效**：agent 讀的是本機 plugin 快取，快取以 `plugin.json` 的 `version` 為 key。漏 bump 則 `claude plugin update` 判定「已是最新」直接跳過，快取原封不動 —— 成果對任何 agent 都不生效。

**判準是一個事實問題：本次 PR 的 diff 有沒有動到 `<plugin 目錄>/` 底下的檔案？**

- 有 → **同一個 PR 內**必須 bump 該 plugin 的 `<plugin 目錄>/.claude-plugin/plugin.json` 的 `version`。不分目錄（`plugins/` 或 `external_plugins/` 一樣算）、不分改動大小（單行 typo 一樣算）、不分檔案類型（code、SKILL.md、README 一樣算）。
- 沒有，只是把 upstream 的版本原樣同步下來 → 不 bump，版本跟 upstream 走。

一個 PR 動了幾個 plugin 就 bump 幾個，各自獨立判 semver。

曾發生：`external_plugins/telegram` 改完沒 bump（當時本檔寫著「`external_plugins/` 不由本 repo 手動 bump」），成果在 VM 上完全不生效，事後補一個 PR 只為了改版號。下一次動 `external_plugins/discord` 時 dev 明知本檔這樣寫、還是照 bump 了才對。規則錯兩次，所以改掉。

版號規則（semver）：破壞相容改 major；新增能力改 minor；純修字 / bugfix 改 patch。判準單位：major = 破壞相容；minor = 新增功能；patch = 非新功能、對既有功能的調整。

自我檢查（開 PR 前）：`git diff --name-only main...HEAD` 列出的路徑，逐一往上找最近的 `.claude-plugin/plugin.json`；每個被命中的 plugin，該檔的 `version` 是否也在這份 diff 裡？

## PR base 防呆（本 repo 是 fork）

發 PR 前必明確指定 base repo 為本 fork：`gh pr create --repo itmrchow/itmrchow-plugins`。裸跑 `gh pr create` 會把 base 打到 anthropics upstream，導致 PR 誤發上游 + diff 外洩。發完 `gh pr view` 確認 base。
