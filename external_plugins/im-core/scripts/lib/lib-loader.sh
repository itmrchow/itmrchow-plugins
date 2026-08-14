# external_plugins/im-core/scripts/lib/lib-loader.sh
# shellcheck shell=bash
# im-core shell lib 的單一入口。
#
# 宿主（carrier）只需要知道兩件事：這個檔在哪，以及要先設好哪些環境變數。
# 個別 lib 的檔名、數量、載入順序都是本 plugin 的內部細節 —— 宿主直接 source
# 個別 lib 會在下次新增 lib 時靜默漏載，所以入口只有這一個。
#
# 失敗一律 return 非 0 並在 stderr 說明缺什麼。**呼叫端必須檢查回傳值** ——
# 沒檢查的話缺檔會退化成「函式未定義」，症狀出現在很遠的地方。

IM_CORE_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
IM_CORE_LIB_MANIFEST_FILE="$IM_CORE_LIB_DIR/manifest.txt"

# im_core_lib_fail <訊息>: 把失敗原因寫到 stderr。
# Returns: 1，方便 `im_core_lib_fail ... || return 1` 的寫法。
im_core_lib_fail() {
  printf '[im-core/lib-loader] %s\n' "$1" >&2
  return 1
}

# im_core_load: 驗環境契約，然後依 manifest 依序載入全部 lib。
#
# 契約只有 AGENT_SCOPES_DIR 一項是硬性的：它是 pointer / ledger / intent /
# admins 四種檔案的根，本 plugin 刻意不給預設值 —— 給了預設值就會在宿主漏設時
# 靜默去讀另一個目錄，看起來一切正常但 /resume 什麼都找不到。
#
# AGENT_WORKSPACE_DIR 未設時 im.sh 會退回 $PWD（沿用既有語意）。強烈建議設定，
# 見 README 的環境契約表。
# Returns: 0 全部載入成功；1 並在 stderr 說明缺什麼。
im_core_load() {
  local name file
  if [ -z "${AGENT_SCOPES_DIR:-}" ]; then
    im_core_lib_fail "AGENT_SCOPES_DIR 未設 —— 宿主必須指定 scope 狀態目錄（例：\$HOME/.claude/agent-scopes）。本 plugin 刻意不給預設值。" || return 1
  fi
  if [ ! -r "$IM_CORE_LIB_MANIFEST_FILE" ]; then
    im_core_lib_fail "載入清單缺檔：$IM_CORE_LIB_MANIFEST_FILE" || return 1
  fi
  while IFS= read -r name; do
    case "$name" in ''|'#'*) continue ;; esac
    file="$IM_CORE_LIB_DIR/$name"
    if [ ! -r "$file" ]; then
      im_core_lib_fail "manifest 列出的 lib 缺檔：$file" || return 1
    fi
    # shellcheck disable=SC1090  # 路徑來自 manifest，靜態分析看不到
    source "$file" || im_core_lib_fail "載入 $name 失敗" || return 1
  done < "$IM_CORE_LIB_MANIFEST_FILE"
}

im_core_load
