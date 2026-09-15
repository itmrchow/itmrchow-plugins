# scripts/reauth.sh 的短命 CLI —— 授權判定、鎖、exit code。
#
# poller 依 exit code 決定回話或沉默，所以這裡每一個 exit code 都是對外行為：
# 判定順序錯 = 對陌生人洩漏指令存在，或讓群組裡的人開流程。driver 本身見 reauth-flow.bats。
#
# Run from the plugin root: bats tests/

setup() {
  TMP="$(mktemp -d)"
  PLUGIN="${BATS_TEST_DIRNAME}/.."
  BIN="$PLUGIN/scripts/reauth.sh"
  FIX="$TMP/bin"; mkdir -p "$FIX"
  for tool in claude direnv sudo; do printf '#!/usr/bin/env bash\nexit 0\n' > "$FIX/$tool"; chmod +x "$FIX/$tool"; done
  # tmux 一律失敗：start 成功時背景 driver 會立刻在 new-session 收尾，不在測試之間殘留
  printf '#!/usr/bin/env bash\nexit 1\n' > "$FIX/tmux"; chmod +x "$FIX/tmux"
  export PATH="$FIX:$PATH"
  export AGENT_SCOPES_DIR="$TMP/scopes" REAUTH_STATE_DIR="$TMP/reauth"
  export REAUTH_ENV_FILE="$TMP/agent/.env" REAUTH_AGENT_SERVICE=claude-tg-agent
  export REAUTH_CLAUDE_BIN="$FIX/claude" REAUTH_DIRENV_BIN="$FIX/direnv"
  export IM_SEND_BIN="$FIX/claude"   # 任一可執行檔即可；本檔不測送訊
  mkdir -p "$AGENT_SCOPES_DIR" "$TMP/agent"
  printf 'A=1\n' > "$REAUTH_ENV_FILE"
  printf '{"version":1,"admins":["777"]}' > "$AGENT_SCOPES_DIR/discord-admins.json"
}
teardown() {
  local i
  # start 成功的測試會留下一支正在收尾的背景 driver；等它結束再刪目錄
  for i in $(seq 1 50); do pgrep -f "$BIN _driver" >/dev/null || break; sleep 0.1; done
  pkill -f "$TMP" 2>/dev/null || true
  rm -rf "$TMP"
}

start() { "$BIN" start --platform discord --sender "$1" --chat 555 --chat-type "${2:-dm}"; }
code()  { printf '%s\n' "$2" | "$BIN" code --platform discord --sender "$1" --chat 555 --chat-type "${3:-dm}"; }

@test "usage: unknown subcommand / bad id / bad platform / dangling flag -> 2" {
  run "$BIN" nope; [ "$status" -eq 2 ]
  run "$BIN"; [ "$status" -eq 2 ]
  run "$BIN" start --platform discord --sender 12a --chat 555 --chat-type dm; [ "$status" -eq 2 ]
  run "$BIN" start --platform slack --sender 1 --chat 555 --chat-type dm; [ "$status" -eq 2 ]
  run "$BIN" start --platform discord --sender 777 --chat 555 --chat-type channel; [ "$status" -eq 2 ]
  run "$BIN" start --platform discord --sender 777 --chat 555 --chat-type; [ "$status" -eq 2 ]
  run "$BIN" start --platform discord --sender 777 --chat 555 --chat-type dm --extra 1; [ "$status" -eq 2 ]
}
@test "no AGENT_SCOPES_DIR -> unauthorizable (4), never reaches the lock" {
  unset AGENT_SCOPES_DIR
  run start 777; [ "$status" -eq 4 ]
  [ ! -d "$REAUTH_STATE_DIR/flow.lock" ]
}
@test "non-admin -> 10, in dm and in group, even with the config broken" {
  run start 778; [ "$status" -eq 10 ]
  run start 778 group; [ "$status" -eq 10 ]
  rm "$REAUTH_ENV_FILE"
  run start 778; [ "$status" -eq 10 ]
  run code 778 'abc#def'; [ "$status" -eq 10 ]
  [ ! -d "$REAUTH_STATE_DIR/flow.lock" ]
}
@test "admin of the other platform only -> 10" {
  run "$BIN" start --platform telegram --sender 777 --chat 777 --chat-type dm
  [ "$status" -eq 10 ]
}
@test "admin in group -> 11, no flow started" {
  run start 777 group; [ "$status" -eq 11 ]
  run code 777 'abc#def' group; [ "$status" -eq 11 ]
  [ ! -d "$REAUTH_STATE_DIR/flow.lock" ]
}
@test "admin in dm but env file missing -> 3" {
  rm "$REAUTH_ENV_FILE"
  run start 777; [ "$status" -eq 3 ]
}
@test "admin in dm but env file is a symlink -> 3" {
  mv "$REAUTH_ENV_FILE" "$TMP/real.env"; ln -s "$TMP/real.env" "$REAUTH_ENV_FILE"
  run start 777; [ "$status" -eq 3 ]
}
@test "second start while a live flow holds the lock -> 12" {
  mkdir -p "$REAUTH_STATE_DIR/flow.lock"
  sleep 300 & live=$!
  printf 'pid=%s\nphase=WAIT_CODE\nstarted_at=%s\n' "$live" "$(date +%s)" > "$REAUTH_STATE_DIR/flow.lock/state"
  run start 777; kill "$live"
  [ "$status" -eq 12 ]
}
@test "stale lock (dead pid) is reclaimed" {
  mkdir -p "$REAUTH_STATE_DIR/flow.lock"
  printf 'pid=999999\nphase=APPLYING\nstarted_at=%s\nbackup=.env.bak.X\n' "$(date +%s)" > "$REAUTH_STATE_DIR/flow.lock/state"
  run start 777
  [ "$status" -eq 0 ]
}
@test "stale lock (older than REAUTH_FLOW_MAX_SECONDS) is reclaimed" {
  mkdir -p "$REAUTH_STATE_DIR/flow.lock"
  sleep 300 & live=$!
  printf 'pid=%s\nphase=WAIT_CODE\nstarted_at=1\n' "$live" > "$REAUTH_STATE_DIR/flow.lock/state"
  run start 777
  # 活著但不是 driver 的行程（pid 可能被重用）不得被殺
  kill -0 "$live"; kill "$live"
  [ "$status" -eq 0 ]
}
@test "code: no flow -> 13; wrong admin -> 13; not WAIT_CODE -> 12; past deadline -> 13; bad format -> 14; ok -> 0" {
  printf '{"version":1,"admins":["777","888"]}' > "$AGENT_SCOPES_DIR/discord-admins.json"
  run code 777 'abc#def'; [ "$status" -eq 13 ]
  mkdir -p "$REAUTH_STATE_DIR/flow.lock"
  sleep 300 & live=$!
  now="$(date +%s)"
  write_state() { printf 'pid=%s\nphase=%s\nplatform=discord\nsender=777\nchat=555\nstarted_at=%s\ndeadline=%s\n' "$live" "$1" "$now" "$2" > "$REAUTH_STATE_DIR/flow.lock/state"; }
  write_state WAIT_CODE $((now + 300))
  run code 888 'abc#def'; [ "$status" -eq 13 ]
  run "$BIN" code --platform telegram --sender 777 --chat 555 --chat-type dm <<< 'abc#def'; [ "$status" -eq 10 ]
  write_state EXCHANGING $((now + 300))
  run code 777 'abc#def'; [ "$status" -eq 12 ]
  write_state WAIT_CODE $((now - 1))
  run code 777 'abc#def'; [ "$status" -eq 13 ]
  write_state WAIT_CODE $((now + 300))
  run code 777 'abc; rm -rf /'; [ "$status" -eq 14 ]
  run code 777 ''; [ "$status" -eq 14 ]
  [ ! -e "$REAUTH_STATE_DIR/flow.lock/code.in" ]
  run code 777 'abc#def'; kill "$live"
  [ "$status" -eq 0 ]
  [ "$(cat "$REAUTH_STATE_DIR/flow.lock/code.in")" = 'abc#def' ]
  [ "$(stat -c %a "$REAUTH_STATE_DIR/flow.lock/code.in" 2>/dev/null || stat -f %Lp "$REAUTH_STATE_DIR/flow.lock/code.in")" = "600" ]
}
@test "code: a 64KB line is rejected as invalid without hanging" {
  mkdir -p "$REAUTH_STATE_DIR/flow.lock"
  sleep 300 & live=$!
  now="$(date +%s)"
  printf 'pid=%s\nphase=WAIT_CODE\nplatform=discord\nsender=777\nchat=555\nstarted_at=%s\ndeadline=%s\n' "$live" "$now" $((now + 300)) > "$REAUTH_STATE_DIR/flow.lock/state"
  run bash -c "head -c 65536 /dev/zero | tr '\\0' a | '$BIN' code --platform discord --sender 777 --chat 555 --chat-type dm"
  kill "$live"
  [ "$status" -eq 14 ]
}
@test "code: the code never appears in argv of the executor (read from stdin)" {
  run bash -c "grep -n 'code_arg\|--code' '$BIN'"
  [ "$status" -ne 0 ]
}
@test "a lock just taken by another start (no pid yet) is not reclaimed" {
  mkdir -p "$REAUTH_STATE_DIR/flow.lock"
  printf 'started_at=%s\n' "$(date +%s)" > "$REAUTH_STATE_DIR/flow.lock/state"
  run start 777; [ "$status" -eq 12 ]
}
@test "a lock dir created a moment ago with no state yet is not reclaimed" {
  mkdir -p "$REAUTH_STATE_DIR/flow.lock"
  run start 777; [ "$status" -eq 12 ]
}
@test "status: idle without a lock, phase only with one" {
  run "$BIN" status; [ "$output" = "idle" ]
  mkdir -p "$REAUTH_STATE_DIR/flow.lock"
  sleep 300 & live=$!
  printf 'pid=%s\nphase=WAIT_CODE\nsender=777\nchat=555\nstarted_at=%s\ndeadline=%s\n' "$live" "$(date +%s)" "$(date +%s)" > "$REAUTH_STATE_DIR/flow.lock/state"
  run "$BIN" status; kill "$live"
  [[ "$output" == *"phase=WAIT_CODE"* ]]
  [[ "$output" != *"777"* ]]; [[ "$output" != *"555"* ]]
}
@test "check: all present -> 0; missing service name -> 3 and names it" {
  run "$BIN" check; [ "$status" -eq 0 ]
  unset REAUTH_AGENT_SERVICE
  run "$BIN" check; [ "$status" -eq 3 ]
  [[ "$output" == *"missing: REAUTH_AGENT_SERVICE"* ]]
}
@test "check: values that would be spliced into a command are refused" {
  REAUTH_AGENT_SERVICE='claude-tg-agent; reboot' run "$BIN" check; [ "$status" -eq 3 ]
  REAUTH_TMUX_SESSION='a b' run "$BIN" check; [ "$status" -eq 3 ]
  REAUTH_TMUX_SOCKET='../x' run "$BIN" check; [ "$status" -eq 3 ]
  mkdir -p "$TMP/it's"
  REAUTH_STATE_DIR="$TMP/it's/reauth" run "$BIN" check; [ "$status" -eq 3 ]
  REAUTH_CODE_TTL_SECONDS=abc run "$BIN" check; [ "$status" -eq 3 ]
  REAUTH_NOTIFY_TIMEOUT_SECONDS=abc run "$BIN" check; [ "$status" -eq 3 ]
  [[ "$output" == *"missing: REAUTH_NOTIFY_TIMEOUT_SECONDS as whole seconds"* ]]
}
@test "check: without AGENT_SCOPES_DIR names it" {
  unset AGENT_SCOPES_DIR
  run "$BIN" check; [ "$status" -eq 3 ]
  [[ "$output" == *"missing: AGENT_SCOPES_DIR"* ]]
}
@test "mark-issued writes the record; bad date -> 2" {
  run "$BIN" mark-issued 2026-09-15; [ "$status" -eq 0 ]
  [ "$(jq -r .source "$REAUTH_STATE_DIR/token-issued.json")" = "manual" ]
  [ "$(jq -r .issued_on "$REAUTH_STATE_DIR/token-issued.json")" = "2026-09-15" ]
  run "$BIN" mark-issued 20260915; [ "$status" -eq 2 ]
  run "$BIN" mark-issued; [ "$status" -eq 2 ]
}
@test "internal driver refuses to run without a flow lock" {
  run "$BIN" _driver; [ "$status" -ne 0 ]
  [ ! -d "$REAUTH_STATE_DIR/flow.lock" ]
}
