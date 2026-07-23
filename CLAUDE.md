# itmrchow-plugins

fork 自 Anthropic 官方 plugin 目錄的個人 marketplace。`plugins/` 多為官方 vendored、`external_plugins/` 為第三方 MCP wrapper，兩者**不由本 repo 手動 bump**（版本跟 upstream）。本 repo **唯一自維護、需手動 bump 的 plugin 是 `im-session-ops`**。

## Version Bump 規則（僅適用自維護 plugin）

自維護 plugin（目前只有 `im-session-ops`）的改動 merge 進 main 後**不會自動生效**：agent 讀的是本機 plugin 快取，快取以 `plugin.json` 的 `version` 為 key。

**merge 前必須 bump 版本號**：在該次 PR 內改 `plugins/im-session-ops/.claude-plugin/plugin.json` 的 `version`。漏 bump 則 `claude plugin update` 判定「已是最新」直接跳過，快取原封不動 —— 成果對任何 agent 都不生效。

版號規則（semver）：破壞相容改 major；新增能力改 minor；純修字 / bugfix 改 patch。判準單位：major = 破壞相容；minor = 新增功能；patch = 非新功能、對既有功能的調整。

## PR base 防呆（本 repo 是 fork）

發 PR 前必明確指定 base repo 為本 fork：`gh pr create --repo itmrchow/itmrchow-plugins`。裸跑 `gh pr create` 會把 base 打到 anthropics upstream，導致 PR 誤發上游 + diff 外洩。發完 `gh pr view` 確認 base。
