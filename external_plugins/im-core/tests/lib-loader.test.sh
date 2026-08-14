#!/usr/bin/env bash
# im-core lib-loader 的契約測試。純 bash，與 skills.test.sh 同風格。
# Run: bash tests/lib-loader.test.sh
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
LIB="$HERE/../scripts/lib"
fail=0
ok()  { echo "ok:   $1"; }
bad() { echo "FAIL: $1"; fail=1; }

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# --- 1. AGENT_SCOPES_DIR 未設時 loader 失敗，且訊息說得出缺什麼 ---
out="$(env -u AGENT_SCOPES_DIR bash -c "source '$LIB/lib-loader.sh'" 2>&1)"
rc=$?
if [ "$rc" -ne 0 ] && printf '%s' "$out" | grep -q 'AGENT_SCOPES_DIR'; then
  ok "loader fails fast and names AGENT_SCOPES_DIR when it is unset"
else
  bad "loader did not fail on missing AGENT_SCOPES_DIR (rc=$rc): $out"
fi

# --- 2. 環境齊全時 loader 載齊 manifest 列出的全部 lib ---
out="$(AGENT_SCOPES_DIR="$TMP/scopes" bash -c "
  source '$LIB/lib-loader.sh' || exit 1
  for fn in scope_session_flag im_is_admin channels_resolve scope_is_valid; do
    declare -F \"\$fn\" >/dev/null || { echo \"missing: \$fn\"; exit 1; }
  done
  [ \"\${SPAWN_EXIT_INVALID_SCOPE:-}\" = 3 ] || { echo 'missing SPAWN_EXIT_INVALID_SCOPE'; exit 1; }
" 2>&1)"
if [ $? -eq 0 ]; then
  ok "loader loads every lib in the manifest"
else
  bad "loader did not load the full manifest: $out"
fi

# --- 3. manifest 少一支檔案時 loader 失敗並指名該檔 ---
cp -R "$LIB" "$TMP/lib"
rm -f "$TMP/lib/scope.sh"
out="$(AGENT_SCOPES_DIR="$TMP/scopes" bash -c "source '$TMP/lib/lib-loader.sh'" 2>&1)"
rc=$?
if [ "$rc" -ne 0 ] && printf '%s' "$out" | grep -q 'scope.sh'; then
  ok "a missing lib file fails the load and is named in the message"
else
  bad "a missing lib file did not fail the load (rc=$rc): $out"
fi

# --- 4. manifest 是唯一清單來源：loader 內不得再寫死第二份檔名列表 ---
# 兩份清單一定會漂移，而漂移的症狀是 preflight 放行一個載不起來的版本。
if ! grep -qE '^[A-Za-z_]+=\(.*\.sh' "$LIB/lib-loader.sh"; then
  ok "loader keeps no second hardcoded file list"
else
  bad "loader has a hardcoded file list beside manifest.txt"
fi

# --- 5. spawn exit code 契約常數齊全且值正確 ---
# 這四個值是 poller（TS）與 scope-spawn.sh（shell）之間的契約。值寫在這裡、
# 兩邊都引用，是 parity.test.sh 能比對的前提。
out="$(AGENT_SCOPES_DIR="$TMP/scopes" bash -c "
  source '$LIB/lib-loader.sh' || exit 1
  printf '%s %s %s %s' \"\$SPAWN_EXIT_OK\" \"\$SPAWN_EXIT_TRANSIENT\" \"\$SPAWN_EXIT_CAP_REACHED\" \"\$SPAWN_EXIT_INVALID_SCOPE\"
" 2>&1)"
if [ "$out" = "0 1 2 3" ]; then
  ok "spawn exit code contract constants are loaded with the agreed values"
else
  bad "spawn exit code constants wrong or missing: '$out'"
fi

exit $fail
