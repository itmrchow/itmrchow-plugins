# scripts/reauth.sh 的 driver 整合：真 tmux（驗 -x 500 / capture -J / send-keys -l）
# + 假 claude / sudo / direnv / im-send（tests/fixtures/reauth/bin）。
#
# 每條失敗路徑都斷言 .env 未被動、tmux server 已消失、暫存目錄已清、token 沒出現在
# state / driver stderr / IM 錄製 / sudo 錄製 —— 這些是驗收條件本身，不是實作細節。
#
# 需要本機 tmux；沒有就 skip（skip 不等於 pass）。
# Run from the plugin root: bats tests/

setup() {
  command -v tmux >/dev/null || skip "tmux not installed"
  TMP="$(mktemp -d)"
  PLUGIN="$(cd "${BATS_TEST_DIRNAME}/.." && pwd)"
  BIN="$PLUGIN/scripts/reauth.sh"
  cp -R "${BATS_TEST_DIRNAME}/fixtures/reauth/bin" "$TMP/bin"
  chmod +x "$TMP/bin"/*
  export PATH="$TMP/bin:$PATH"
  export AGENT_SCOPES_DIR="$TMP/scopes" REAUTH_STATE_DIR="$TMP/reauth"
  export REAUTH_ENV_FILE="$TMP/agent/.env" REAUTH_AGENT_SERVICE=claude-tg-agent
  export REAUTH_CLAUDE_BIN="$TMP/bin/claude" REAUTH_DIRENV_BIN="$TMP/bin/direnv" IM_SEND_BIN="$TMP/bin/im-send"
  export REAUTH_TMUX_SOCKET="reauth-test-$$-$BATS_TEST_NUMBER" REAUTH_POLL_INTERVAL_SECONDS=0.2
  export REAUTH_CODE_TTL_SECONDS=20 REAUTH_URL_WAIT_SECONDS=5 REAUTH_EXCHANGE_WAIT_SECONDS=5 REAUTH_PROBE_TIMEOUT_SECONDS=5
  # 模擬 poller 行程環境內的其他秘密：不得流進 setup-token / probe 子行程
  export TELEGRAM_BOT_TOKEN=tg-secret-in-poller-env
  mkdir -p "$AGENT_SCOPES_DIR" "$TMP/agent"
  printf '{"version":1,"admins":["777"]}' > "$AGENT_SCOPES_DIR/telegram-admins.json"
  OLD="sk-ant-oat01-$(printf 'O%.0s' $(seq 1 95))"
  NEW="sk-ant-oat01-$(printf 'N%.0s' $(seq 1 95))"
  printf '# agent env\nA=1\nCLAUDE_CODE_OAUTH_TOKEN=%s\n' "$OLD" > "$REAUTH_ENV_FILE"
  chmod 600 "$REAUTH_ENV_FILE"
  # 約 450 字元：pane 寬度若不是 500，URL 會被折行（-J 以外的擷取會拿到殘缺連結）
  printf 'https://claude.ai/oauth/authorize?code=true&client_id=%s&state=st_-9' "$(printf 'c%.0s' $(seq 1 380))" > "$TMP/bin/url.txt"
  printf 'goodcode#st_-9' > "$TMP/bin/good-code.txt"
  printf '%s' "$NEW" > "$TMP/bin/token.txt"
  printf '%s' "$NEW" > "$TMP/bin/probe-good-token.txt"
  DRIVER_LOG="$TMP/driver.stderr"
}
teardown() {
  [ -n "${TMP:-}" ] || return 0
  pkill -f "$BIN _driver" 2>/dev/null || true
  tmux -L "$REAUTH_TMUX_SOCKET" kill-server 2>/dev/null || true
  rm -rf "$TMP"
}

start_flow() { "$BIN" start --platform telegram --sender 777 --chat 777 --chat-type dm 2>>"$DRIVER_LOG"; }
send_code() { printf '%s\n' "$1" | "$BIN" code --platform telegram --sender 777 --chat 777 --chat-type dm 2>>"$DRIVER_LOG"; }
wait_for() { local i; for i in $(seq 1 150); do eval "$1" && return 0; sleep 0.2; done; return 1; }
wait_idle() { wait_for '[ "$("$BIN" status)" = idle ]'; }
wait_phase() { wait_for "\"$BIN\" status | grep -q 'phase=$1'"; }
sent() { cat "$TMP/bin/sent.log" 2>/dev/null; }
# bash 的 set -e 不理會 `! cmd` 的失敗，測試中段的 `! grep` 永遠不會讓測試變紅。
refute() { if "$@"; then echo "unexpectedly succeeded: $*" >&2; return 1; fi; }
mode_of() { stat -c %a "$1" 2>/dev/null || stat -f %Lp "$1"; }

assert_no_token_leak() {
  local t
  for t in "$NEW" "$OLD"; do
    refute grep -rqF "$t" "$REAUTH_STATE_DIR" "$DRIVER_LOG" "$TMP/bin/sent.log" "$TMP/bin/sudo.log" 2>/dev/null
  done
  refute grep -rqE 'sk-ant-oat01-' "$REAUTH_STATE_DIR" "$DRIVER_LOG" "$TMP/bin/sent.log" 2>/dev/null
  refute tmux -L "$REAUTH_TMUX_SOCKET" list-sessions 2>/dev/null
  refute ls -d "$REAUTH_STATE_DIR"/cfg.* "$REAUTH_STATE_DIR"/probe.* "$REAUTH_STATE_DIR"/flow.lock 2>/dev/null
  refute ls "$TMP/agent"/.env.reauth.* 2>/dev/null
}

@test "happy path: url sent, code accepted, token written with backup, restart, verified, recorded" {
  # 整個流程期間取樣所有行程的 argv：token 不得出現在任何一支的參數裡
  ( while :; do ps -Ao args= >> "$TMP/ps.log" 2>/dev/null; sleep 0.05; done ) & sampler=$!
  run start_flow; [ "$status" -eq 0 ]
  wait_phase WAIT_CODE
  grep -qF "$(cat "$TMP/bin/url.txt")" <(sent)
  [ "$(sent | head -1 | cut -f1,2)" = "telegram"$'\t'"777" ]
  [ "$(sent | head -1 | cut -f3)" = "1" ]   # telegram 關預覽
  run send_code 'goodcode#st_-9'; [ "$status" -eq 0 ]
  wait_idle
  kill "$sampler"
  [ "$(grep -c '^CLAUDE_CODE_OAUTH_TOKEN=' "$REAUTH_ENV_FILE")" -eq 1 ]
  grep -qx "CLAUDE_CODE_OAUTH_TOKEN=$NEW" "$REAUTH_ENV_FILE"
  grep -qx 'A=1' "$REAUTH_ENV_FILE"
  grep -qx '# agent env' "$REAUTH_ENV_FILE"
  [ "$(mode_of "$REAUTH_ENV_FILE")" = "600" ]
  backup="$(ls "$TMP/agent"/.env.bak.*)"
  grep -qx "CLAUDE_CODE_OAUTH_TOKEN=$OLD" "$backup"
  [ "$(mode_of "$backup")" = "600" ]
  [ "$(cat "$TMP/bin/sudo.log")" = 'systemctl restart claude-tg-agent' ]
  [ "$(jq -r .source "$REAUTH_STATE_DIR/token-issued.json")" = "reauth" ]
  [ "$(jq -r .issued_on "$REAUTH_STATE_DIR/token-issued.json")" = "$(date -u +%Y-%m-%d)" ]
  refute grep -qF 'sk-ant' "$REAUTH_STATE_DIR/token-issued.json"
  sent | grep -q '新 token 已驗證可用'
  sent | tail -1 | grep -q '重新驗證完成'
  sent | tail -1 | grep -q "產生日 $(date -u +%Y-%m-%d)"
  [ "$(sent | cut -f2 | sort -u)" = "777" ]
  assert_no_token_leak
  # 驗證碼與授權連結也不進 driver 的 log（journal）
  refute grep -qF 'goodcode' "$DRIVER_LOG"
  refute grep -qF 'oauth/authorize' "$DRIVER_LOG"
  [ -s "$TMP/ps.log" ]
  refute grep -qF "$NEW" "$TMP/ps.log"
}
@test "setup-token and probes run with a scrubbed environment" {
  start_flow; wait_phase WAIT_CODE; send_code 'goodcode#st_-9'; wait_idle
  sent | tail -1 | grep -q '重新驗證完成'
  refute grep -qE '^(TELEGRAM_BOT_TOKEN|CLAUDE_CODE_OAUTH_TOKEN|REAUTH_|AGENT_SCOPES_DIR|TMUX)' "$TMP/bin/setup-token.env-names"
  grep -qx CLAUDE_CONFIG_DIR "$TMP/bin/setup-token.env-names"
  for f in "$TMP/bin"/probe.*.env-names; do
    refute grep -qE '^(TELEGRAM_BOT_TOKEN|REAUTH_|AGENT_SCOPES_DIR)' "$f"
    grep -qx CLAUDE_CODE_OAUTH_TOKEN "$f"
  done
  [ "$(ls "$TMP/bin"/probe.*.env-names | wc -l)" -eq 2 ]
}
@test "a code that is exactly a tmux key name is typed literally (Enter)" {
  printf 'Enter' > "$TMP/bin/good-code.txt"
  start_flow; wait_phase WAIT_CODE
  run send_code 'Enter'; [ "$status" -eq 0 ]
  wait_idle
  [ "$(cat "$TMP/bin/received-code")" = 'Enter' ]
  sent | tail -1 | grep -q '重新驗證完成'
}
@test "a code that is exactly a tmux key name is typed literally (C-c)" {
  printf 'C-c' > "$TMP/bin/good-code.txt"
  start_flow; wait_phase WAIT_CODE
  run send_code 'C-c'; [ "$status" -eq 0 ]
  wait_idle
  [ "$(cat "$TMP/bin/received-code")" = 'C-c' ]
  sent | tail -1 | grep -q '重新驗證完成'
}
@test "a code that starts with - is not taken as a tmux option" {
  printf -- '-t#-l' > "$TMP/bin/good-code.txt"
  start_flow; wait_phase WAIT_CODE
  run send_code '-t#-l'; [ "$status" -eq 0 ]
  wait_idle
  [ "$(cat "$TMP/bin/received-code")" = '-t#-l' ]
  sent | tail -1 | grep -q '重新驗證完成'
}
@test "url and token wrapped in terminal colour codes are still extracted cleanly" {
  touch "$TMP/bin/scenario-ansi"
  start_flow; wait_phase WAIT_CODE
  sent | head -1 | grep -qF "$(cat "$TMP/bin/url.txt")"
  [ "$(sent | head -1 | grep -c $'\e')" -eq 0 ]
  send_code 'goodcode#st_-9'; wait_idle
  grep -qx "CLAUDE_CODE_OAUTH_TOKEN=$NEW" "$REAUTH_ENV_FILE"
  sent | tail -1 | grep -q '重新驗證完成'
}
@test "timeout: no code within TTL -> flow voided, session gone, env untouched, later code refused" {
  export REAUTH_CODE_TTL_SECONDS=3
  before="$(cksum < "$REAUTH_ENV_FILE")"
  run start_flow; [ "$status" -eq 0 ]
  wait_idle
  sent | tail -1 | grep -q '已逾時'
  [ "$(cksum < "$REAUTH_ENV_FILE")" = "$before" ]
  [ ! -e "$TMP/bin/sudo.log" ]
  [ ! -e "$REAUTH_STATE_DIR/token-issued.json" ]
  run send_code 'goodcode#st_-9'; [ "$status" -eq 13 ]
  assert_no_token_leak
}
@test "wrong code: setup-token rejects -> failure message, env untouched, no restart, retry possible" {
  before="$(cksum < "$REAUTH_ENV_FILE")"
  start_flow; wait_phase WAIT_CODE
  run send_code 'badcode#st_-9'; [ "$status" -eq 0 ]
  wait_idle
  sent | tail -1 | grep -q '驗證碼無效或已過期'
  [ "$(cksum < "$REAUTH_ENV_FILE")" = "$before" ]
  [ ! -e "$TMP/bin/sudo.log" ]
  refute ls "$TMP/agent"/.env.bak.* 2>/dev/null
  assert_no_token_leak
  run send_code 'goodcode#st_-9'; [ "$status" -eq 13 ]
  run start_flow; [ "$status" -eq 0 ]
  wait_phase WAIT_CODE
}
@test "no url within wait -> failure, session gone" {
  touch "$TMP/bin/scenario-no-url"
  start_flow; wait_idle
  sent | tail -1 | grep -q '未輸出授權連結'
  [ "$(sent | grep -c 'https://')" -eq 0 ]
  assert_no_token_leak
}
@test "setup-token exits before a code arrives -> flow ends, env untouched" {
  touch "$TMP/bin/scenario-exit-early"
  before="$(cksum < "$REAUTH_ENV_FILE")"
  start_flow; wait_idle
  [ "$(sent | wc -l)" -eq 2 ]
  [ "$(cksum < "$REAUTH_ENV_FILE")" = "$before" ]
  run send_code 'goodcode#st_-9'; [ "$status" -eq 13 ]
  assert_no_token_leak
}
@test "probe before write fails -> env untouched, no restart" {
  printf 'something-else' > "$TMP/bin/probe-good-token.txt"
  before="$(cksum < "$REAUTH_ENV_FILE")"
  start_flow; wait_phase WAIT_CODE; send_code 'goodcode#st_-9'; wait_idle
  sent | tail -1 | grep -q '新 token 驗證未通過'
  [ "$(cksum < "$REAUTH_ENV_FILE")" = "$before" ]
  [ ! -e "$TMP/bin/sudo.log" ]
  [ ! -e "$REAUTH_STATE_DIR/token-issued.json" ]
  assert_no_token_leak
}
@test "post-restart injection probe fails -> restore backup, restart again, report" {
  touch "$TMP/bin/scenario-break-injection-on-restart"
  cp "$REAUTH_ENV_FILE" "$TMP/original.env"
  start_flow; wait_phase WAIT_CODE; send_code 'goodcode#st_-9'; wait_idle
  cmp "$REAUTH_ENV_FILE" "$TMP/original.env"
  [ "$(grep -c 'systemctl restart claude-tg-agent' "$TMP/bin/sudo.log")" -eq 2 ]
  sent | tail -1 | grep -q '已還原備份'
  sent | tail -1 | grep -q '仍是登出狀態'
  [ ! -e "$REAUTH_STATE_DIR/token-issued.json" ]
  assert_no_token_leak
}
@test "restart non-zero but injection probe passes -> keep new token, warn" {
  printf '1' > "$TMP/bin/restart-rc"
  start_flow; wait_phase WAIT_CODE; send_code 'goodcode#st_-9'; wait_idle
  grep -qx "CLAUDE_CODE_OAUTH_TOKEN=$NEW" "$REAUTH_ENV_FILE"
  sent | tail -1 | grep -q '重啟失敗（systemctl rc=1）'
  [ -e "$REAUTH_STATE_DIR/token-issued.json" ]
  assert_no_token_leak
}
@test "env file cannot be replaced -> original intact, no restart" {
  # 目錄唯讀：備份 / 暫存檔都建不出來
  chmod 500 "$TMP/agent"
  before="$(cksum < "$REAUTH_ENV_FILE")"
  start_flow; wait_phase WAIT_CODE; send_code 'goodcode#st_-9'; wait_idle
  chmod 700 "$TMP/agent"
  [ "$(cksum < "$REAUTH_ENV_FILE")" = "$before" ]
  [ ! -e "$TMP/bin/sudo.log" ]
  sent | tail -1 | grep -q '重新驗證失敗'
  [ ! -e "$REAUTH_STATE_DIR/token-issued.json" ]
  assert_no_token_leak
}
@test "SIGTERM while waiting for code -> session and temp dirs cleaned, lock released" {
  start_flow; wait_phase WAIT_CODE
  pid="$(sed -n 's/^pid=//p' "$REAUTH_STATE_DIR/flow.lock/state")"
  kill -TERM "$pid"
  wait_idle
  sent | tail -1 | grep -q '被中斷（WAIT_CODE 階段）。.env 未變更'
  assert_no_token_leak
  [ ! -d "$REAUTH_STATE_DIR/flow.lock" ]
}
@test "leftover session with the same name is replaced, the code never reaches it" {
  tmux -L "$REAUTH_TMUX_SOCKET" -f /dev/null new-session -d -s claude-reauth "cat > '$TMP/leftover-typed'"
  start_flow; wait_phase WAIT_CODE; send_code 'goodcode#st_-9'; wait_idle
  sent | tail -1 | grep -q '重新驗證完成'
  refute grep -q goodcode "$TMP/leftover-typed" 2>/dev/null
}
@test "discord url is wrapped in <> and sent to the requesting dm" {
  printf '{"version":1,"admins":["777"]}' > "$AGENT_SCOPES_DIR/discord-admins.json"
  DISCORD_BOT_TOKEN=x "$BIN" start --platform discord --sender 777 --chat 42 --chat-type dm 2>>"$DRIVER_LOG"
  wait_phase WAIT_CODE
  sent | head -1 | grep -qF "<$(cat "$TMP/bin/url.txt")>"
  [ "$(sent | head -1 | cut -f1,2)" = "discord"$'\t'"42" ]
}
@test "only one flow box-wide: telegram start then discord start -> busy; discord admin cannot send the code" {
  printf '{"version":1,"admins":["777"]}' > "$AGENT_SCOPES_DIR/discord-admins.json"
  start_flow; wait_phase WAIT_CODE
  run "$BIN" start --platform discord --sender 777 --chat 42 --chat-type dm
  [ "$status" -eq 12 ]
  run bash -c "printf 'goodcode#st_-9\n' | '$BIN' code --platform discord --sender 777 --chat 42 --chat-type dm"
  [ "$status" -eq 13 ]
  [ ! -e "$REAUTH_STATE_DIR/flow.lock/code.in" ]
}
@test "racing starts from both pollers -> exactly one flow, one tmux session" {
  printf '{"version":1,"admins":["777"]}' > "$AGENT_SCOPES_DIR/discord-admins.json"
  local round
  for round in 1 2 3; do
    "$BIN" start --platform telegram --sender 777 --chat 777 --chat-type dm 2>/dev/null & tg=$!
    "$BIN" start --platform discord --sender 777 --chat 42 --chat-type dm 2>/dev/null & dc=$!
    rc_tg=0; wait "$tg" || rc_tg=$?
    rc_dc=0; wait "$dc" || rc_dc=$?
    echo "round $round: telegram=$rc_tg discord=$rc_dc"
    [ "$(printf '%s\n' "$rc_tg" "$rc_dc" | sort -n | tr '\n' ' ')" = "0 12 " ]
    wait_phase WAIT_CODE
    [ "$(tmux -L "$REAUTH_TMUX_SOCKET" list-sessions | wc -l)" -eq 1 ]
    [ "$(pgrep -f "$BIN _driver" | wc -l)" -eq 1 ]
    kill -TERM "$(sed -n 's/^pid=//p' "$REAUTH_STATE_DIR/flow.lock/state")"
    wait_idle
    rm -f "$TMP/bin/sent.log"
  done
}
@test "no token in any argv: executor never passes the token as a command argument" {
  # 靜態守門：REAUTH_TOKEN 不得出現在 env / sudo / tmux / 可執行檔呼叫的同一行
  run grep -nE '(^|[^_])(env |sudo |_reauth_tmux |tmux |"\$claude_bin"|"\$direnv_bin")[^#]*REAUTH_TOKEN' "$BIN"
  [ "$status" -ne 0 ]
}
