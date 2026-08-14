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
  for fn in scope_is_valid scope_session_flag; do
    declare -F \"\$fn\" >/dev/null || { echo \"missing: \$fn\"; exit 1; }
  done
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

exit $fail
