# scripts/reauth/lib-reauth.sh — 重新驗證執行器的純函式。
#
# 值得測的是錯了會付出什麼：URL / token 擷取錯 = 送出殘缺連結或寫入錯 token；
# .env render 錯 = 舊 token 仍生效或其他設定被改掉；失敗 marker 漏判 = 把壞 token 寫進去。
#
# Run from the plugin root: bats tests/

setup() {
  TMP="$(mktemp -d)"
  # shellcheck source=../scripts/lib/reauth-contract.sh
  source "${BATS_TEST_DIRNAME}/../scripts/lib/reauth-contract.sh"
  # shellcheck source=../scripts/reauth/lib-reauth.sh
  source "${BATS_TEST_DIRNAME}/../scripts/reauth/lib-reauth.sh"
  TOKEN="sk-ant-oat01-$(printf 'A%.0s' $(seq 1 95))"
}
teardown() { rm -rf "$TMP"; }

@test "url: extracts the authorize url from a joined pane" {
  pane=$'Browser didn\'t open? Use the url below to sign in:\n\nhttps://claude.ai/oauth/authorize?code=true&client_id=abc&state=xyz_-1\n\nPaste code here if prompted >'
  run reauth_extract_url "$pane"
  [ "$status" -eq 0 ]
  [ "$output" = "https://claude.ai/oauth/authorize?code=true&client_id=abc&state=xyz_-1" ]
}
@test "url: the prompt on the next line is not glued onto the url" {
  pane=$'https://claude.ai/oauth/authorize?code=true&state=s\nPaste code here if prompted >'
  run reauth_extract_url "$pane"
  [ "$output" = "https://claude.ai/oauth/authorize?code=true&state=s" ]
}
@test "url: no url -> 1" {
  run reauth_extract_url $'Welcome\n>'
  [ "$status" -eq 1 ]
  [ -z "$output" ]
}
@test "token: single token line is extracted" {
  pane=$'Long-lived authentication token created successfully!\n\nYour OAuth token (valid for 1 year):\n\n'"$TOKEN"$'\n\nStore this token securely.'
  run reauth_extract_token "$pane"
  [ "$status" -eq 0 ]; [ "$output" = "$TOKEN" ]
}
@test "token: trailing CR / padding around the line is stripped" {
  run reauth_extract_token "  $TOKEN"$'\r'
  [ "$status" -eq 0 ]; [ "$output" = "$TOKEN" ]
}
@test "token: same token twice counts as one" {
  run reauth_extract_token "$TOKEN"$'\n'"$TOKEN"
  [ "$status" -eq 0 ]; [ "$output" = "$TOKEN" ]
}
@test "token: two different tokens -> 1" {
  other="sk-ant-oat01-$(printf 'B%.0s' $(seq 1 95))"
  run reauth_extract_token "$TOKEN"$'\n'"$other"
  [ "$status" -eq 1 ]
  [ -z "$output" ]
}
@test "token: prefix without body, wrong prefix, illegal char -> 1" {
  run reauth_extract_token 'sk-ant-oat01-short'; [ "$status" -eq 1 ]
  run reauth_extract_token "sk-ant-api03-$(printf 'A%.0s' $(seq 1 95))"; [ "$status" -eq 1 ]
  run reauth_extract_token "${TOKEN}!"; [ "$status" -eq 1 ]
}
@test "code: accepts <code>#<state> charset" {
  run reauth_code_is_valid 'aB3_-x#St4te-_'; [ "$status" -eq 0 ]
}
@test "code: rejects empty, whitespace, shell / control chars, non-ascii, over 512" {
  local bad
  for bad in '' 'ab cd' 'ab;rm' 'abc#$(id)' 'abc#`id`' 'abc#x|sh' 'abc#x&&reboot' \
             $'abc#x\nrm' $'abc\r' $'abc\x03' $'abc\x1b' $'ab\tcd' "abc'" 'abc"' 'abc\' \
             'ａbc' $'ab​cd'; do
    run reauth_code_is_valid "$bad"
    [ "$status" -eq 1 ] || { echo "accepted: $(printf '%q' "$bad")"; return 1; }
  done
  run reauth_code_is_valid "$(printf 'a%.0s' $(seq 1 512))"; [ "$status" -eq 0 ]
  run reauth_code_is_valid "$(printf 'a%.0s' $(seq 1 513))"; [ "$status" -eq 1 ]
}
@test "id: digits and negative group ids only" {
  run reauth_id_is_valid '123456'; [ "$status" -eq 0 ]
  run reauth_id_is_valid '-1001234567890'; [ "$status" -eq 0 ]
  run reauth_id_is_valid '12a'; [ "$status" -eq 1 ]
  run reauth_id_is_valid ''; [ "$status" -eq 1 ]
  run reauth_id_is_valid '1;id'; [ "$status" -eq 1 ]
}
@test "date: format and month/day range" {
  run reauth_date_is_valid 2026-09-15; [ "$status" -eq 0 ]
  run reauth_date_is_valid 2026-13-01; [ "$status" -eq 1 ]
  run reauth_date_is_valid 2026-00-10; [ "$status" -eq 1 ]
  run reauth_date_is_valid 2026-01-32; [ "$status" -eq 1 ]
  run reauth_date_is_valid 20260915; [ "$status" -eq 1 ]
}
@test "env render: replaces every existing token line, keeps the rest verbatim" {
  printf '# c\nA=1\nCLAUDE_CODE_OAUTH_TOKEN=old1\nexport CLAUDE_CODE_OAUTH_TOKEN=old2\nB="x y"\n' > "$TMP/.env"
  run reauth_env_render "$TMP/.env" "$TOKEN"
  [ "$status" -eq 0 ]
  [ "$output" = "# c"$'\n'"A=1"$'\n'"B=\"x y\""$'\n'"CLAUDE_CODE_OAUTH_TOKEN=$TOKEN" ]
}
@test "env render: key absent -> appended, blank lines and comments kept" {
  printf '# head\n\nA=1\n' > "$TMP/.env"
  run reauth_env_render "$TMP/.env" "$TOKEN"
  [ "$output" = "# head"$'\n\n'"A=1"$'\n'"CLAUDE_CODE_OAUTH_TOKEN=$TOKEN" ]
}
@test "env render: look-alike keys are not touched" {
  printf 'X_CLAUDE_CODE_OAUTH_TOKEN=keep1\n#CLAUDE_CODE_OAUTH_TOKEN=keep2\nCLAUDE_CODE_OAUTH_TOKEN_OLD=keep3\n' > "$TMP/.env"
  run reauth_env_render "$TMP/.env" "$TOKEN"
  [ "$output" = "X_CLAUDE_CODE_OAUTH_TOKEN=keep1"$'\n'"#CLAUDE_CODE_OAUTH_TOKEN=keep2"$'\n'"CLAUDE_CODE_OAUTH_TOKEN_OLD=keep3"$'\n'"CLAUDE_CODE_OAUTH_TOKEN=$TOKEN" ]
}
@test "env render: file without trailing newline keeps its last line" {
  printf 'A=1' > "$TMP/.env"
  run reauth_env_render "$TMP/.env" "$TOKEN"
  [ "$output" = "A=1"$'\n'"CLAUDE_CODE_OAUTH_TOKEN=$TOKEN" ]
}
@test "env render: CRLF lines are kept byte for byte" {
  printf 'A=1\r\nCLAUDE_CODE_OAUTH_TOKEN=old\r\n' > "$TMP/.env"
  reauth_env_render "$TMP/.env" "$TOKEN" > "$TMP/out"
  [ "$(head -1 "$TMP/out")" = $'A=1\r' ]
  [ "$(grep -c 'old' "$TMP/out")" -eq 0 ]
}
@test "env value: last assignment, export prefix, quotes, CRLF" {
  printf 'K=a\nexport K="b"\r\n' > "$TMP/.env"
  run reauth_env_value "$TMP/.env" K
  [ "$output" = "b" ]
}
@test "auth failure markers" {
  run reauth_output_has_auth_failure 'Failed to authenticate. API Error: 401 OAuth access token is invalid.'; [ "$status" -eq 0 ]
  run reauth_output_has_auth_failure 'OAuth token has expired'; [ "$status" -eq 0 ]
  run reauth_output_has_auth_failure 'Invalid API key · Please run /login'; [ "$status" -eq 0 ]
  run reauth_output_has_auth_failure 'OK'; [ "$status" -eq 1 ]
}
@test "issued record: writes version/date/source, mode 600, rejects bad date / source" {
  run reauth_write_issued "$TMP" 2026-09-15 manual
  [ "$status" -eq 0 ]
  [ "$(jq -r .issued_on "$TMP/token-issued.json")" = "2026-09-15" ]
  [ "$(jq -r .source "$TMP/token-issued.json")" = "manual" ]
  [ "$(jq -r .version "$TMP/token-issued.json")" = "1" ]
  [ "$(stat -c %a "$TMP/token-issued.json" 2>/dev/null || stat -f %Lp "$TMP/token-issued.json")" = "600" ]
  run reauth_write_issued "$TMP" 2026-13-40 manual; [ "$status" -eq 1 ]
  run reauth_write_issued "$TMP" 2026-09-15 other; [ "$status" -eq 1 ]
  [ "$(jq -r .issued_on "$TMP/token-issued.json")" = "2026-09-15" ]
  ! ls "$TMP"/.token-issued.* 2>/dev/null
}
