# /clear 與 /resume 兩個 skill 的 bash 流程，在「只載 plugin lib」的環境下實跑。
#
# skill 在 agent 的 Bash 工具裡執行：那裡只有 lib-loader 載進來的函式，tmux 函式
# 要靠宿主匯出的 IM_TMUX_LIB 自己 source。曾發生 skill 直接呼叫 scope_tmux_target，
# 在 agent 裡得到 command not found，/exit 沒送出，intent 卻已寫入、確認訊息照發。
# 這裡從 SKILL.md 取出實際的 bash 區塊來跑，文件與測試是同一份東西。
#
# tmux / im-send / sleep 以 PATH stub 替換，兩個 stub 寫同一份事件紀錄，順序可比；
# IM_TMUX_LIB 指向照 carrier 契約寫的 stub lib，不複製 carrier 的檔案進來。
#
# Run from the plugin root: bats tests/

setup() {
  TMP="$(mktemp -d)"
  export HOME="$TMP"
  export AGENT_SCOPES_DIR="$TMP/agent-scopes"
  export IM_PROJECTS_DIR="$TMP/projects"
  export IM_CORE_DIR="${BATS_TEST_DIRNAME}/.."
  export IM_SEND_BIN="$TMP/bin/im-send"
  export AGENT_SCOPE=telegram-dm-1
  export EVENTS="$TMP/events.log"
  mkdir -p "$AGENT_SCOPES_DIR" "$IM_PROJECTS_DIR" "$TMP/bin"
  : > "$EVENTS"

  # 每次呼叫記一行 `tmux <args> | intents=<當下存在的 intent 檔>`，用來驗 intent 先於 /exit
  cat > "$TMP/bin/tmux" <<'SH'
#!/usr/bin/env bash
intents="$(cd "$AGENT_SCOPES_DIR" && ls -- *.new-session *.resume 2>/dev/null | tr '\n' ',')"
printf 'tmux %s | intents=%s\n' "$*" "$intents" >> "$EVENTS"
exit "${FAKE_TMUX_RC:-0}"
SH
  cat > "$TMP/bin/im-send" <<'SH'
#!/usr/bin/env bash
printf 'send %s|%s|%s\n' "$1" "$2" "$3" >> "$EVENTS"
SH
  # 背景確認訊息前的 sleep 不必真的等
  printf '#!/usr/bin/env bash\nexit 0\n' > "$TMP/bin/sleep"
  chmod +x "$TMP/bin/tmux" "$TMP/bin/im-send" "$TMP/bin/sleep"

  # carrier 的 scope_tmux_target 契約：驗 scope 形狀後印 session:window
  cat > "$TMP/lib-scope-tmux.sh" <<'SH'
scope_tmux_target() {
  scope_is_valid "$1" || return 1
  printf '%s' "claude-tg-agent:$1"
}
SH
  # 取不到 target 的兩種宿主：回 0 但印空字串 / 回非 0
  printf 'scope_tmux_target() { return 0; }\n' > "$TMP/lib-empty-target.sh"
  printf 'scope_tmux_target() { return 1; }\n' > "$TMP/lib-fail-target.sh"
  export IM_TMUX_LIB="$TMP/lib-scope-tmux.sh"
}

teardown() { rm -rf "$TMP"; }

# skill_block <skill> <n>: SKILL.md 中第 n 個 ```bash 區塊，占位符換成測試值。
skill_block() {
  awk -v want="$2" '
    /^```bash$/ { n++; inside = (n == want); next }
    /^```$/     { inside = 0; next }
    inside      { print }
  ' "${BATS_TEST_DIRNAME}/../skills/$1/SKILL.md" \
    | sed -e 's/<SRC>/telegram/g' -e 's/<CID>/123/g' -e 's/<UID>/42/g' \
          -e 's/<用戶回覆的數字>/1/g'
}

# run_skill <skill> <n>: 只帶 stub PATH 跑該區塊，等背景確認訊息送完再返回。
run_skill() {
  local script
  script="$(skill_block "$1" "$2")"
  [ -n "$script" ] || { echo "no bash block $2 in $1" >&2; return 99; }
  run env PATH="$TMP/bin:$PATH" bash -c "$script"$'\nwait'
}

# resume 第二輪的前置：<scope> 的 ledger 認領 <sid>、有 transcript、第一輪 rows 已存。
seed_resume_rows() {
  local scope="$1" sid="$2"
  printf '%s\n' "$sid" >> "$AGENT_SCOPES_DIR/$scope.sessions"
  printf '{"type":"user"}\n' > "$IM_PROJECTS_DIR/$sid.jsonl"
  printf '%s\t%s\t%s\t%s\n' "$sid" "$scope" "t" "01/01 00:00" \
    > "$AGENT_SCOPES_DIR/$AGENT_SCOPE.resume-rows"
}

# line_of <fixed string>: 該字串在事件紀錄中第一次出現的行號（沒有就空字串）。
line_of() { grep -nF -- "$1" "$EVENTS" | head -1 | cut -d: -f1; }

# no_exit_sent: tmux stub 沒收到任何呼叫。
no_exit_sent() { ! grep -q '^tmux ' "$EVENTS"; }

SID=11111111-2222-3333-4444-555555555555
OTHER_SCOPE=telegram-group-n100

# ── /clear 成功 ──────────────────────────────────────────────────────────────

@test "clear: 只送一次 /exit 到本 scope 的 window，送出時 intent 已寫好" {
  run_skill im-session-clear 1
  [ "$status" -eq 0 ]
  [ "$(grep -c '^tmux ' "$EVENTS")" -eq 1 ]
  grep -qxF "tmux send-keys -t claude-tg-agent:telegram-dm-1 /exit Enter | intents=telegram-dm-1.new-session," "$EVENTS"
  [ -s "$AGENT_SCOPES_DIR/telegram-dm-1.new-session" ]
}

@test "clear: 不再出現 command not found，確認訊息排在 /exit 之後" {
  run_skill im-session-clear 1
  [[ "$output" != *"command not found"* ]]
  exit_line="$(line_of "tmux send-keys")"
  ack_line="$(line_of "send telegram|123|已開始新的對話")"
  [ -n "$exit_line" ] && [ -n "$ack_line" ]
  [ "$ack_line" -gt "$exit_line" ]
}

@test "clear: cwd 在 plugin 以外也照常送出 /exit" {
  cd "$TMP"
  run_skill im-session-clear 1
  grep -qF "tmux send-keys -t claude-tg-agent:telegram-dm-1 /exit Enter" "$EVENTS"
}

# ── /clear：IM_TMUX_LIB 缺值 / 無效 ────────────────────────────────────────

@test "clear: IM_TMUX_LIB 未設時點名該變數回報失敗，不寫 intent、不送 /exit、不發確認" {
  unset IM_TMUX_LIB
  run_skill im-session-clear 1
  [[ "$output" == *"IM_TMUX_LIB not set"* ]]
  [ ! -e "$AGENT_SCOPES_DIR/telegram-dm-1.new-session" ]
  no_exit_sent
  grep -qF "send telegram|123|切換失敗：IM_TMUX_LIB" "$EVENTS"
  ! grep -qF "已開始新的對話" "$EVENTS"
}

@test "clear: IM_TMUX_LIB 為空字串時視同未設" {
  export IM_TMUX_LIB=""
  run_skill im-session-clear 1
  [ ! -e "$AGENT_SCOPES_DIR/telegram-dm-1.new-session" ]
  no_exit_sent
  grep -qF "切換失敗：IM_TMUX_LIB" "$EVENTS"
}

@test "clear: IM_TMUX_LIB 指向不存在的檔時回報失敗且不寫 intent" {
  export IM_TMUX_LIB="$TMP/nope.sh"
  run_skill im-session-clear 1
  [ ! -e "$AGENT_SCOPES_DIR/telegram-dm-1.new-session" ]
  no_exit_sent
  grep -qF "切換失敗：IM_TMUX_LIB" "$EVENTS"
}

# ── /clear：target 取不到 ────────────────────────────────────────────────────

@test "clear: scope_tmux_target 回非 0 時回報失敗、不寫 intent、不發確認" {
  export IM_TMUX_LIB="$TMP/lib-fail-target.sh"
  run_skill im-session-clear 1
  [ ! -e "$AGENT_SCOPES_DIR/telegram-dm-1.new-session" ]
  no_exit_sent
  grep -qF "send telegram|123|切換失敗" "$EVENTS"
  ! grep -qF "已開始新的對話" "$EVENTS"
}

@test "clear: scope_tmux_target 印空字串時回報失敗且不寫 intent" {
  export IM_TMUX_LIB="$TMP/lib-empty-target.sh"
  run_skill im-session-clear 1
  [ ! -e "$AGENT_SCOPES_DIR/telegram-dm-1.new-session" ]
  no_exit_sent
  grep -qF "切換失敗" "$EVENTS"
}

@test "clear: scope 不合法時中止，scope 目錄一個檔都不寫" {
  export AGENT_SCOPE="BAD scope"
  run_skill im-session-clear 1
  [ -z "$(ls -A "$AGENT_SCOPES_DIR")" ]
  no_exit_sent
  grep -qF "切換失敗" "$EVENTS"
}

# ── /clear：/exit 送出失敗 ───────────────────────────────────────────────────

@test "clear: /exit 送出失敗時刪掉 intent、回報失敗、不發確認" {
  export FAKE_TMUX_RC=1
  run_skill im-session-clear 1
  grep -qF "tmux send-keys" "$EVENTS"
  [ ! -e "$AGENT_SCOPES_DIR/telegram-dm-1.new-session" ]
  grep -qF "send telegram|123|切換失敗" "$EVENTS"
  ! grep -qF "已開始新的對話" "$EVENTS"
}

@test "clear: /exit 失敗的回滾只刪本 scope 的 intent，其他 scope 的原樣保留" {
  printf '%s\n' "$SID" > "$AGENT_SCOPES_DIR/$OTHER_SCOPE.new-session"
  printf '%s\n' "$SID" > "$AGENT_SCOPES_DIR/$OTHER_SCOPE.resume"
  export FAKE_TMUX_RC=1
  run_skill im-session-clear 1
  [ ! -e "$AGENT_SCOPES_DIR/telegram-dm-1.new-session" ]
  [ "$(cat "$AGENT_SCOPES_DIR/$OTHER_SCOPE.new-session")" = "$SID" ]
  [ "$(cat "$AGENT_SCOPES_DIR/$OTHER_SCOPE.resume")" = "$SID" ]
}

# ── /resume 第二輪 ───────────────────────────────────────────────────────────

@test "resume: 送 /exit 到目標 scope，送出時 intent 已寫好，確認排在 /exit 之後" {
  seed_resume_rows telegram-dm-1 "$SID"
  run_skill im-session-resume 2
  [ "$status" -eq 0 ]
  [ "$(grep -c '^tmux ' "$EVENTS")" -eq 1 ]
  grep -qxF "tmux send-keys -t claude-tg-agent:telegram-dm-1 /exit Enter | intents=telegram-dm-1.resume," "$EVENTS"
  [ "$(cat "$AGENT_SCOPES_DIR/telegram-dm-1.resume")" = "$SID" ]
  exit_line="$(line_of "tmux send-keys")"
  ack_line="$(line_of "send telegram|123|切換中，重啟後進入該對話")"
  [ -n "$ack_line" ] && [ "$ack_line" -gt "$exit_line" ]
  [ ! -e "$AGENT_SCOPES_DIR/telegram-dm-1.resume-rows" ]
}

@test "resume: admin 切別的 scope 時 /exit 送到目標 scope，確認訊息說明切的是哪個 scope" {
  printf '{"admins":["42"]}' > "$AGENT_SCOPES_DIR/telegram-admins.json"
  seed_resume_rows "$OTHER_SCOPE" "$SID"
  run_skill im-session-resume 2
  grep -qF "tmux send-keys -t claude-tg-agent:$OTHER_SCOPE /exit Enter" "$EVENTS"
  [ "$(cat "$AGENT_SCOPES_DIR/$OTHER_SCOPE.resume")" = "$SID" ]
  grep -qF "send telegram|123|已切換 group 的對話，重啟後生效" "$EVENTS"
  ! grep -qF "切換中" "$EVENTS"
}

@test "resume: IM_TMUX_LIB 未設時點名該變數回報失敗，不寫 intent、不送 /exit、不發確認" {
  seed_resume_rows telegram-dm-1 "$SID"
  unset IM_TMUX_LIB
  run_skill im-session-resume 2
  [ ! -e "$AGENT_SCOPES_DIR/telegram-dm-1.resume" ]
  no_exit_sent
  grep -qF "send telegram|123|切換失敗：IM_TMUX_LIB" "$EVENTS"
  ! grep -qF "切換中" "$EVENTS"
}

@test "resume: scope_tmux_target 回非 0 時回報失敗且不寫 intent" {
  seed_resume_rows telegram-dm-1 "$SID"
  export IM_TMUX_LIB="$TMP/lib-fail-target.sh"
  run_skill im-session-resume 2
  [ ! -e "$AGENT_SCOPES_DIR/telegram-dm-1.resume" ]
  no_exit_sent
  grep -qF "切換失敗" "$EVENTS"
}

@test "resume: scope_tmux_target 印空字串時回報失敗且不寫 intent" {
  seed_resume_rows telegram-dm-1 "$SID"
  export IM_TMUX_LIB="$TMP/lib-empty-target.sh"
  run_skill im-session-resume 2
  [ ! -e "$AGENT_SCOPES_DIR/telegram-dm-1.resume" ]
  no_exit_sent
  grep -qF "切換失敗" "$EVENTS"
}

@test "resume: /exit 送出失敗時刪掉 intent、回報失敗、不發確認" {
  seed_resume_rows telegram-dm-1 "$SID"
  export FAKE_TMUX_RC=1
  run_skill im-session-resume 2
  grep -qF "tmux send-keys" "$EVENTS"
  [ ! -e "$AGENT_SCOPES_DIR/telegram-dm-1.resume" ]
  grep -qF "send telegram|123|切換失敗" "$EVENTS"
  ! grep -qF "切換中" "$EVENTS"
}

@test "resume: 跨 scope 切換時 /exit 送出失敗，不發跨 scope 說明且刪掉目標 scope 的 intent" {
  printf '{"admins":["42"]}' > "$AGENT_SCOPES_DIR/telegram-admins.json"
  seed_resume_rows "$OTHER_SCOPE" "$SID"
  export FAKE_TMUX_RC=1
  run_skill im-session-resume 2
  [ ! -e "$AGENT_SCOPES_DIR/$OTHER_SCOPE.resume" ]
  grep -qF "切換失敗" "$EVENTS"
  ! grep -qF "已切換" "$EVENTS"
}

@test "resume: 看不到的編號回「找不到該對話」，不載 tmux lib 也不送 /exit" {
  seed_resume_rows telegram-dm-1 "$SID"
  : > "$AGENT_SCOPES_DIR/telegram-dm-1.sessions"   # ledger 不再認領 -> 不可見
  unset IM_TMUX_LIB
  run_skill im-session-resume 2
  no_exit_sent
  grep -qF "找不到該對話" "$EVENTS"
  [ ! -e "$AGENT_SCOPES_DIR/telegram-dm-1.resume-rows" ]
}
