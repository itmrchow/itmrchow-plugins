# scripts/lib/scope.sh — the SCOPE value domain.
#
# A scope-id is minted from an IM identity and then flows straight into a tmux
# window name, a file path and a launcher command string. There is no known-good
# list left to compare it against, so the shape check (scope_is_valid) is the
# only defence — which is why most of this file tests what it REJECTS.
#
# The rest asserts NON-OVERLAP: two scopes that resolve to one pointer file or
# one tmux target do not crash, they silently merge two people's conversations.
#
# Run from the plugin root: bats tests/
#
# tmux（scopes_live / scope_tmux_target）與 launcher 的測試留在 carrier：
# 它們斷言的是「這台機器怎麼開視窗 / 怎麼啟動」，不是 scope 的值域。

setup() {
  TMP="$(mktemp -d)"
  export HOME="$TMP/home"
  mkdir -p "$HOME"
  export AGENT_SCOPES_DIR="$TMP/agent-scopes"
  unset AGENT_SCOPE TMUX_SESSION TMUX_LIST_CMD CHANNELS TELEGRAM_POLLER_PORT
  unset BOOTSTRAP_SCOPE BOOTSTRAP_EXTRA_CHANNELS
  source "${BATS_TEST_DIRNAME}/../scripts/lib/lib-loader.sh"
}

teardown() { rm -rf "$TMP"; }

# A dm scope and a group scope, used throughout. Not constants for their own
# sake: the negative telegram chat id normalized to `n...` is the shape most
# likely to be broken by a careless regex edit.
DM="telegram-dm-12345"
GRP="telegram-group-n1001234567890"

@test "AGENT_SCOPE resolves to the scope" {
  AGENT_SCOPE="$GRP" run scope_resolve
  [ "$status" -eq 0 ]
  [ "$output" = "$GRP" ]
}

@test "an unset AGENT_SCOPE is an error, NOT an implicit default scope" {
  # A default would attach a half-configured window to somebody else's session
  # pointer — two identities answering from one conversation.
  run scope_resolve
  [ "$status" -ne 0 ]
  [[ "$output" == *"not set"* ]]
}

@test "a malformed AGENT_SCOPE is an error and names the expected shape" {
  AGENT_SCOPE=personal run scope_resolve
  [ "$status" -ne 0 ]
  [[ "$output" == *"personal"* ]]
  [[ "$output" == *"dm|group"* ]]
}

@test "scope_is_valid accepts a semantic scope id" {
  run scope_is_valid "$DM"
  [ "$status" -eq 0 ]
  run scope_is_valid "discord-group-830680811401379870"
  [ "$status" -eq 0 ]
  run scope_is_valid "$GRP"
  [ "$status" -eq 0 ]
}

@test "scope_is_valid rejects tmux and path metacharacters" {
  # Each of these reaches `tmux new-window -n <name>` or a file path verbatim.
  run scope_is_valid "telegram-dm-123:0";      [ "$status" -ne 0 ]
  run scope_is_valid "telegram-dm-../etc";     [ "$status" -ne 0 ]
  run scope_is_valid "-telegram-dm-123";       [ "$status" -ne 0 ]
  run scope_is_valid "telegram-dm-1; tmux kill-server"; [ "$status" -ne 0 ]
  run scope_is_valid "telegram-other-123";     [ "$status" -ne 0 ]
  run scope_is_valid "telegram-group--100123"; [ "$status" -ne 0 ]
  run scope_is_valid "TELEGRAM-dm-123";        [ "$status" -ne 0 ]
  run scope_is_valid "";                       [ "$status" -ne 0 ]
}

@test "scope_platform / scope_kind split the id into its parts" {
  [ "$(scope_platform "$GRP")" = "telegram" ]
  [ "$(scope_kind "$GRP")" = "group" ]
  [ "$(scope_platform "$DM")" = "telegram" ]
  [ "$(scope_kind "$DM")" = "dm" ]
  run scope_platform "nonsense"
  [ "$status" -ne 0 ]
}

@test "state dirs are per PLATFORM, shared by every scope of that platform" {
  # Per-scope would hand a freshly spawned scope an empty access.json, i.e. it
  # would reject the very message that spawned it.
  [ "$(scope_state_dir telegram)" = "$HOME/.claude/channels/telegram" ]
  [ "$(scope_state_dir discord)" = "$HOME/.claude/channels/discord" ]
  [ "$(scope_state_dir telegram)" != "$(scope_state_dir discord)" ]
}

@test "path helpers reject an invalid scope id instead of building one" {
  # scope_tmux_target 的同一條斷言留在 carrier —— 該函式沒有搬進本 plugin。
  run scope_pointer_file "../../etc/passwd";  [ "$status" -ne 0 ]
  run scope_sessions_file "nosuchscope";      [ "$status" -ne 0 ]
  run scope_intent_file "nosuchscope" resume; [ "$status" -ne 0 ]
}

@test "pointer and sessions files are per scope, under AGENT_SCOPES_DIR" {
  [ "$(scope_pointer_file "$DM")" = "$AGENT_SCOPES_DIR/$DM.json" ]
  [ "$(scope_pointer_file "$GRP")" = "$AGENT_SCOPES_DIR/$GRP.json" ]
  [ "$(scope_sessions_file "$GRP")" = "$AGENT_SCOPES_DIR/$GRP.sessions" ]
}

@test "intent files are per scope and per kind, and no other kind is accepted" {
  [ "$(scope_intent_file "$GRP" resume)" = "$AGENT_SCOPES_DIR/$GRP.resume" ]
  [ "$(scope_intent_file "$GRP" new-session)" = "$AGENT_SCOPES_DIR/$GRP.new-session" ]
  run scope_intent_file "$GRP" rm-rf
  [ "$status" -ne 0 ]
}

@test "env prefixes match the names the plugins actually read" {
  [ "$(scope_env_prefix discord)" = "DISCORD" ]
  [ "$(scope_env_prefix telegram)" = "TELEGRAM" ]
  [ "$(scope_env_prefix internal-inject)" = "INTERNAL_INJECT" ]
}

# settings.json 的 cleanupPeriodDays 斷言留在 carrier：它讀的是那個 repo 的
# .claude/settings.json，本 plugin 沒有那個檔。

# ── session pointer ──────────────────────────────────────────────────────────

@test "no pointer yet -> a brand new session id" {
  run scope_session_flag $DM
  [ "$status" -eq 0 ]
  [[ "$output" =~ ^--session-id\ [0-9a-f-]{36}$ ]]
}

@test "a fresh pointer is resumed, keeping the same session id" {
  first="$(scope_session_flag $DM)"
  sid="${first##* }"
  second="$(scope_session_flag $DM)"
  [ "$second" = "--resume $sid" ]
}

@test "a pointer past its TTL rolls over to a new session" {
  first="$(scope_session_flag $DM)"
  sid="${first##* }"
  # Three days ago, i.e. beyond the 2-day TTL.
  python3 - "$(scope_pointer_file $DM)" <<'PY'
import json, sys, time
p = sys.argv[1]
d = json.load(open(p))
d["updatedAt"] = int((time.time() - 3 * 86400) * 1000)
json.dump(d, open(p, "w"))
PY
  run scope_session_flag $DM
  [[ "$output" == --session-id\ * ]]
  [ "${output##* }" != "$sid" ]
}

@test "the TTL is driven by the pointer's updatedAt, refreshed on every launch" {
  # A scope that is UP but idle must keep its conversation: the clock is "when did
  # this scope last launch", not "when was the transcript last written". So a
  # resume has to bump updatedAt, otherwise a long one-way conversation expires
  # itself two days in.
  scope_session_flag $DM >/dev/null
  pointer="$(scope_pointer_file $DM)"
  python3 - "$pointer" <<'PY'
import json, sys, time
p = sys.argv[1]
d = json.load(open(p))
d["updatedAt"] = int((time.time() - 86400) * 1000)
json.dump(d, open(p, "w"))
PY
  before="$(scope_pointer_get "$pointer" updatedAt)"
  scope_session_flag $DM >/dev/null
  [ "$(scope_pointer_get "$pointer" updatedAt)" -gt "$before" ]
}

@test "an expired pointer deletes no transcript" {
  # TTL expires a POINTER. The conversation itself stays on disk until claude's
  # own cleanupPeriodDays takes it — /resume must still be able to find it.
  transcripts="$TMP/projects"
  mkdir -p "$transcripts"
  touch "$transcripts/old-session.jsonl"
  scope_session_flag $DM >/dev/null
  python3 - "$(scope_pointer_file $DM)" <<'PY'
import json, sys, time
p = sys.argv[1]
d = json.load(open(p))
d["updatedAt"] = 0
json.dump(d, open(p, "w"))
PY
  scope_session_flag $DM >/dev/null
  [ -f "$transcripts/old-session.jsonl" ]
}

@test "a corrupt pointer is treated as absent, not as a hard failure" {
  # A scope with no agent at all is a worse outcome than a scope that lost its
  # scrollback, so a broken pointer must degrade to 'start fresh'.
  pointer="$(scope_pointer_file $DM)"
  mkdir -p "$(dirname "$pointer")"
  printf 'not json{' > "$pointer"
  run scope_session_flag $DM
  [ "$status" -eq 0 ]
  [[ "$output" == --session-id\ * ]]
}

@test "a resume intent file wins over the pointer, and is consumed" {
  scope_session_flag $DM >/dev/null
  wanted="11111111-2222-3333-4444-555555555555"
  printf '%s\n' "$wanted" > "$(scope_intent_file $DM resume)"
  run scope_session_flag $DM
  [ "$output" = "--resume $wanted" ]
  [ ! -f "$(scope_intent_file $DM resume)" ]
  # One-shot: the next boot goes back to the pointer, which now holds it.
  run scope_session_flag $DM
  [ "$output" = "--resume $wanted" ]
}

@test "a new-session intent file starts that exact id" {
  wanted="aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"
  mkdir -p "$AGENT_SCOPES_DIR"
  printf '%s' "$wanted" > "$(scope_intent_file $DM new-session)"
  run scope_session_flag $DM
  [ "$output" = "--session-id $wanted" ]
}

@test "an intent file that is not a uuid is discarded, not interpolated" {
  # The intent file is written by a skill acting on a user's message, and its
  # content lands in the launcher's `exec claude ... --resume <id>` string.
  mkdir -p "$AGENT_SCOPES_DIR"
  printf '%s' 'x; touch /tmp/pwned-jp4' > "$(scope_intent_file $DM resume)"
  run scope_session_flag $DM
  [ "$status" -eq 0 ]
  # stderr is part of $output under `run`, hence the substring match: the point is
  # that a NEW id was minted and the junk never became a session id.
  [[ "$output" == *"--session-id "* ]]
  [[ "$output" != *"touch"* ]]
  [ ! -e /tmp/pwned-jp4 ]
  [ ! -f "$(scope_intent_file $DM resume)" ]
}

# ── dead session pointer (JP-194) ────────────────────────────────────────────

@test "a dead-session line is only recognized together with the id it names" {
  # The marker alone still sits in the pane from the PREVIOUS boot, and the id
  # alone appears in every launch log line. Either half on its own would either
  # re-quarantine a healthy pointer or never fire.
  sid="11111111-2222-3333-4444-555555555555"
  other="99999999-8888-7777-6666-555555555555"
  run scope_session_is_dead "No conversation found with session ID: $sid" "$sid"
  [ "$status" -eq 0 ]
  run scope_session_is_dead "No conversation found with session ID: $other" "$sid"
  [ "$status" -ne 0 ]
  run scope_session_is_dead "boot_seq=3 --resume $sid" "$sid"
  [ "$status" -ne 0 ]
  run scope_session_is_dead "" "$sid"
  [ "$status" -ne 0 ]
  run scope_session_is_dead "No conversation found with session ID: $other" ""
  [ "$status" -ne 0 ]
}

@test "the marker and the id must be on the SAME line to count as dead" {
  # The realistic pane: last boot's failure for ANOTHER id is still in the
  # scrollback, and the launcher itself prints THIS boot's id every time. Both
  # halves are therefore present in almost every pane — matching them
  # independently would quarantine a healthy pointer on any unrelated fast exit.
  sid="11111111-2222-3333-4444-555555555555"
  other="99999999-8888-7777-6666-555555555555"
  pane="$(printf '%s\n' \
    "No conversation found with session ID: $other" \
    "session mode: --resume $sid" \
    "claude exited (boot_seq=7 elapsed 1s), relaunching in 3s")"
  run scope_session_is_dead "$pane" "$sid"
  [ "$status" -ne 0 ]
  # Same pane plus the line that really names this id: now it is dead.
  run scope_session_is_dead "$pane
No conversation found with session ID: $sid" "$sid"
  [ "$status" -eq 0 ]
}

@test "quarantining a pointer keeps it on disk and frees the scope to start fresh" {
  first="$(scope_session_flag $DM)"
  sid="${first##* }"
  backup="$(scope_pointer_quarantine $DM)"
  [ ! -f "$(scope_pointer_file $DM)" ]
  [ -f "$backup" ]
  [[ "$backup" == "$(scope_pointer_file $DM).dead-"*.bak ]]
  # The wedged id must still be answerable afterwards — it is the first thing
  # asked in the post-mortem, and the ledger keeps it too.
  grep -q "$sid" "$backup"
  grep -qxF "$sid" "$(scope_sessions_file $DM)"
  run scope_session_flag $DM
  [[ "$output" == --session-id\ * ]]
  [ "${output##* }" != "$sid" ]
}

@test "quarantining reports failure when there is no pointer to move" {
  run scope_pointer_quarantine $DM
  [ "$status" -ne 0 ]
}

@test "each launched session id is recorded against its own scope" {
  # Both scopes share ONE ~/.claude/projects dir, so this ledger is the only way
  # to tell whose conversation a transcript is.
  p="$(scope_session_flag $DM)"; g="$(scope_session_flag $GRP)"
  grep -qxF "${p##* }" "$(scope_sessions_file $DM)"
  grep -qxF "${g##* }" "$(scope_sessions_file $GRP)"
  ! grep -qxF "${g##* }" "$(scope_sessions_file $DM)"
}

@test "the ledger does not grow a duplicate line per boot" {
  scope_session_flag $DM >/dev/null
  scope_session_flag $DM >/dev/null
  scope_session_flag $DM >/dev/null
  [ "$(wc -l < "$(scope_sessions_file $DM)" | tr -d ' ')" -eq 1 ]
}

@test "the two scopes never share a session id" {
  p="$(scope_session_flag $DM)"; g="$(scope_session_flag $GRP)"
  [ "${p##* }" != "${g##* }" ]
}

# launcher（scripts/start-tg-agent.sh）的測試整段留在 carrier：它們實際執行
# 那支腳本，plugin repo 內沒有它，也不該有 —— 開機流程是宿主的知識。
