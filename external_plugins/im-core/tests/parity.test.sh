#!/usr/bin/env bash
# shell lib 與 channel plugin（TS）之間的契約 parity。
#
# 三組值必須逐字相同，因為它們描述的是同一件事實：
#   1. SCOPE_ID_RE   —— 兩邊各自鑄造 scope-id，形狀不同 = 同一個人被拆成兩個 scope
#   2. port 預設     —— 不同 = watchdog 探一個沒人聽的 port -> 判定 agent 死掉 -> 無限重啟
#   3. spawn exit code —— 不同 = poller 把「機器滿了」讀成「id 不合法」，訊息被丟掉
#
# 以前這三組跨兩個 repo，只能靠註解互相提醒。lib 搬進本 repo 之後可以直接比。
# 需要 sibling plugin 在場（repo checkout 有，安裝後的 im-core 沒有），
# 不在場就跳過而不是失敗 —— 這是 repo 測試，不是 runtime 檢查。
# Run: bash tests/parity.test.sh
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
LIB="$HERE/../scripts/lib"
PLUGINS="$HERE/../.."
fail=0
ok()   { echo "ok:   $1"; }
bad()  { echo "FAIL: $1"; fail=1; }
skip() { echo "skip: $1"; }

TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT

shell_value() {
  AGENT_SCOPES_DIR="$TMP/scopes" bash -c "source '$LIB/lib-loader.sh' >/dev/null || exit 1; $1"
}

# --- 1. SCOPE_ID_RE ---
# shell 端是 '^...$' 的裸字串，TS 端是 /^...$/ 的 regex literal。
# 去掉各自的定界符之後必須逐字元相同。
TS_SCOPE_ID="$PLUGINS/telegram/scope-id.ts"
if [ ! -r "$TS_SCOPE_ID" ]; then
  skip "telegram/scope-id.ts not present (installed plugin, not a repo checkout)"
else
  sh_re="$(shell_value 'printf "%s" "$SCOPE_ID_RE"')"
  ts_re="$(sed -n "s|^export const SCOPE_ID_RE = /\(.*\)/\$|\1|p" "$TS_SCOPE_ID")"
  if [ -n "$sh_re" ] && [ "$sh_re" = "$ts_re" ]; then
    ok "SCOPE_ID_RE matches between scope.sh and telegram/scope-id.ts"
  else
    bad "SCOPE_ID_RE drifted: shell='$sh_re' ts='$ts_re'"
  fi
fi

# --- 2. port 預設 ---
# 本段只保證「每個 port 的 shell 值 == TS 值」，不保證兩個不同的 port 不會被同時
# 改成同一號碼 —— 那條由 channels.bats 的 "no default port is shared between the
# inject and poller domains" 守（同語言內唯一）。兩條合起來才推得出 TS 側也唯一。
# 不要把撞號斷言複製到這裡：職責不同，複製後改一個 port 要改兩個檔。
#
# 格式：<shell 取值表達式>|<TS 檔>|<TS 內取值的 sed 表達式>|<說明>
check_port() {
  local label="$1" expr="$2" file="$3" pattern="$4" sh_port ts_port
  if [ ! -r "$file" ]; then skip "$label: $(basename "$file") not present"; return; fi
  sh_port="$(shell_value "$expr")"
  ts_port="$(sed -n "$pattern" "$file" | head -1)"
  if [ -n "$sh_port" ] && [ "$sh_port" = "$ts_port" ]; then
    ok "$label default port matches ($sh_port)"
  else
    bad "$label default port drifted: shell='$sh_port' ts='$ts_port'"
  fi
}

check_port "internal-inject inject" \
  'printf "%s" "$(channel_inject_port internal-inject)"' \
  "$PLUGINS/internal-inject/server.ts" \
  's|^const DEFAULT_PORT = \([0-9]\{1,\}\)$|\1|p'

check_port "telegram poller" \
  'printf "%s" "$(channel_poller_port telegram)"' \
  "$PLUGINS/telegram/poller.ts" \
  's|^const DEFAULT_POLLER_PORT = \([0-9]\{1,\}\)$|\1|p'

check_port "discord poller" \
  'printf "%s" "$(channel_poller_port discord)"' \
  "$PLUGINS/discord/discord-poller.ts" \
  's|^const DEFAULT_POLLER_PORT = \([0-9]\{1,\}\)$|\1|p'

# --- 3. spawn exit code ---
check_exit() {
  local name="$1" file="$2" sh_val ts_val
  if [ ! -r "$file" ]; then skip "$name: $(basename "$file") not present"; return; fi
  sh_val="$(shell_value "printf '%s' \"\$$name\"")"
  ts_val="$(sed -n "s|^const $name = \([0-9]\{1,\}\)\$|\1|p" "$file" | head -1)"
  if [ -n "$sh_val" ] && [ "$sh_val" = "$ts_val" ]; then
    ok "$name matches $(basename "$file") ($sh_val)"
  else
    bad "$name drifted: shell='$sh_val' ts='$ts_val' ($file)"
  fi
}

for f in "$PLUGINS/telegram/poller.ts" "$PLUGINS/discord/discord-poller.ts"; do
  check_exit SPAWN_EXIT_OK "$f"
  check_exit SPAWN_EXIT_TRANSIENT "$f"
  check_exit SPAWN_EXIT_CAP_REACHED "$f"
  check_exit SPAWN_EXIT_INVALID_SCOPE "$f"
done

exit $fail
