# scripts/lib/im.sh — the agent-side IM command logic (JP-4 Task 5/6).
#
# What is worth testing here is what a mistake actually costs: an admin gate that
# fails open hands out /restart and /create-token, and a /resume listing that
# leaks across scopes shows a private conversation to a group channel. Formatting
# is tested only where a wrong render makes the user pick the wrong session.
#
# Run from the plugin root: bats tests/

setup() {
  TMP="$(mktemp -d)"
  export HOME="$TMP"
  export AGENT_SCOPES_DIR="$TMP/agent-scopes"
  export IM_PROJECTS_DIR="$TMP/projects"
  export INVITES_FILE="$TMP/channels/invites.json"
  export DISCORD_STATE_DIR="$TMP/channels/discord"
  export AGENT_SCOPE=telegram-dm-1
  mkdir -p "$AGENT_SCOPES_DIR" "$IM_PROJECTS_DIR" "$DISCORD_STATE_DIR"
  # 一個入口，不逐支 source：逐支 source 會在新增 lib 時靜默漏載，
  # 而測試通過但 production 少一支函式是最糟的組合。
  source "${BATS_TEST_DIRNAME}/../scripts/lib/lib-loader.sh"
}

teardown() { rm -rf "$TMP"; }

write_access() { printf '%s' "$1" > "$DISCORD_STATE_DIR/access.json"; }

write_admins() { printf '%s' "$2" > "$AGENT_SCOPES_DIR/$1-admins.json"; }

# A transcript for <sid>, optionally named <title>, aged <n> seconds.
make_session() {
  local sid="$1" title="${2:-}" age="${3:-0}" file="$IM_PROJECTS_DIR/$1.jsonl"
  printf '{"type":"user"}\n' > "$file"
  [ -n "$title" ] && printf '{"type":"ai-title","aiTitle":"%s"}\n' "$title" >> "$file"
  touch -t "$(date -r "$(( $(date +%s) - age ))" +%Y%m%d%H%M.%S)" "$file"
}

claim_session() { printf '%s\n' "$2" >> "$AGENT_SCOPES_DIR/$1.sessions"; }

pick_visible() { im_row_sid "$(im_sessions_rows "$1" "$2")" "$3"; }

# ── admin gate ────────────────────────────────────────────────────────────────

@test "the admins file is per platform, shared by every scope of it" {
  # Not per scope: scopes are created by incoming messages, so a per-scope list
  # would have to be copied by hand to a set nobody knows in advance.
  run im_admins_file telegram
  [ "$output" = "$AGENT_SCOPES_DIR/telegram-admins.json" ]
}

@test "an id listed in the platform admins file is an admin" {
  write_admins discord '{"version":1,"admins":["777"]}'
  run im_is_admin discord 777
  [ "$status" -eq 0 ]
}

@test "an id that is not listed is not an admin" {
  write_admins discord '{"version":1,"admins":["777"]}'
  run im_is_admin discord 778
  [ "$status" -ne 0 ]
}

@test "admins of another platform do not carry over" {
  # One file per platform precisely because a telegram id and a discord id are
  # different people who happen to share a number.
  write_admins telegram '{"version":1,"admins":["777"]}'
  run im_is_admin discord 777
  [ "$status" -ne 0 ]
}

@test "an empty sender id is never an admin" {
  # A dropped user_id must fail closed: the caller of this gate is /restart.
  write_admins discord '{"version":1,"admins":["777"]}'
  run im_is_admin discord ""
  [ "$status" -ne 0 ]
}

@test "a missing or corrupt admins file is not an admin" {
  run im_is_admin discord 777
  [ "$status" -ne 0 ]
  write_admins discord 'not json{'
  run im_is_admin discord 777
  [ "$status" -ne 0 ]
}

@test "no admins array at all means nobody is an admin" {
  write_admins discord '{"version":1}'
  run im_is_admin discord 777
  [ "$status" -ne 0 ]
}

@test "the gate ignores the admins field left behind in access.json" {
  # What a pre-JP-177 box has on disk. Still reading it would mean the migration
  # step that creates the new file could be skipped without anyone noticing —
  # until the day someone edits the new file and nothing changes.
  write_access '{"admins":{"discord":["999"]}}'
  run im_is_admin discord 999
  [ "$status" -ne 0 ]
}

# ── /help ─────────────────────────────────────────────────────────────────────

@test "the user help lists the four open commands and no admin ones" {
  run im_help_text 1
  [[ "$output" == *"/clear"* && "$output" == *"/rename"* && "$output" == *"/resume"* && "$output" == *"/help"* ]]
  [[ "$output" != *"/restart"* && "$output" != *"/create-token"* ]]
}

@test "the admin help adds the admin commands" {
  run im_help_text 0
  [[ "$output" == *"/restart"* && "$output" == *"/create-token"* ]]
}

@test "neither version mentions /start" {
  # Listing it advertises the invite mechanism to strangers, which is what the
  # silent-drop gate exists to avoid.
  run im_help_text 1
  [[ "$output" != *"/start"* ]]
  run im_help_text 0
  [[ "$output" != *"/start"* ]]
}

# ── /resume listing ───────────────────────────────────────────────────────────

@test "a normal user sees only their own scope's sessions" {
  make_session aaaaaaaa-1111 "私訊對話" 10
  make_session bbbbbbbb-2222 "群組對話" 5
  claim_session telegram-dm-1 aaaaaaaa-1111
  claim_session telegram-group-n2 bbbbbbbb-2222
  run im_sessions_rows telegram-dm-1 1
  [[ "$output" == *"aaaaaaaa-1111"* ]]
  [[ "$output" != *"bbbbbbbb-2222"* ]]
}

@test "an admin sees both scopes, each row carrying its scope" {
  make_session aaaaaaaa-1111 "私訊對話" 10
  make_session bbbbbbbb-2222 "群組對話" 5
  claim_session telegram-dm-1 aaaaaaaa-1111
  claim_session telegram-group-n2 bbbbbbbb-2222
  run im_sessions_rows telegram-dm-1 0
  [[ "$output" == *"aaaaaaaa-1111	telegram-dm-1"* ]]
  [[ "$output" == *"bbbbbbbb-2222	telegram-group-n2"* ]]
}

@test "a session no ledger claims is hidden from normal users" {
  # Sharing one transcripts directory means unclaimed files exist (hand-run
  # claude, a pre-scope session). Defaulting them to the viewer would show the
  # group channel whatever the private agent once discussed.
  make_session cccccccc-3333 "來路不明" 5
  run im_sessions_rows telegram-dm-1 1
  [ -z "$output" ]
  run im_sessions_rows telegram-dm-1 0
  [[ "$output" == *"cccccccc-3333"* ]]
}

@test "rows come out newest first" {
  make_session aaaaaaaa-1111 "舊的" 600
  make_session bbbbbbbb-2222 "新的" 5
  claim_session telegram-dm-1 aaaaaaaa-1111
  claim_session telegram-dm-1 bbbbbbbb-2222
  run im_sessions_rows telegram-dm-1 1
  [[ "${lines[0]}" == bbbbbbbb-2222* ]]
}

@test "an unnamed session still gets a label" {
  make_session aaaaaaaa-1111 "" 5
  claim_session telegram-dm-1 aaaaaaaa-1111
  run im_sessions_rows telegram-dm-1 1
  [[ "$output" == *"（未命名）"* ]]
}

@test "a ledger whose filename is not a legal scope id is skipped entirely" {
  # The listing walks whatever *.sessions files exist, and the scope it derives
  # from each filename goes on to name a tmux target and an intent file. A file
  # nobody legitimately creates must not be able to put an arbitrary string
  # there — the admin view is the one that would show it, since a non-admin's
  # scope filter hides unknown scopes for an unrelated reason.
  make_session dddddddd-4444 "來路不明的帳本" 5
  claim_session "bad scope" dddddddd-4444
  run im_sessions_rows telegram-dm-1 0
  [[ "$output" != *"bad scope"* ]]
}

# ── /resume 的第零道檢查（這個場合能不能用這個指令）─────────────────────────

@test "a normal user cannot run /resume in a group" {
  run im_resume_allowed telegram-group-n100123 1
  [ "$status" -ne 0 ]
}

@test "an admin may still run /resume in a group" {
  run im_resume_allowed telegram-group-n100123 0
  [ "$status" -eq 0 ]
}

@test "a normal user may run /resume in a dm" {
  run im_resume_allowed telegram-dm-1 1
  [ "$status" -eq 0 ]
}

# ── list rendering ────────────────────────────────────────────────────────────

@test "the numbered list is cut at a whole row, never mid-row" {
  rows="$(printf 'aaaaaaaa-1111\ttelegram-dm-1\t第一\t08/07 10:00\nbbbbbbbb-2222\ttelegram-dm-1\t第二\t08/07 11:00\n')"
  run im_format_list "$rows" 40 1
  [ "${#lines[@]}" -eq 1 ]
  [[ "${lines[0]}" == "1. 第一"* ]]
}

@test "the admin list marks each row's scope, the user list does not" {
  rows="$(printf 'bbbbbbbb-2222\ttelegram-group-n2\t群組\t08/07 11:00\n')"
  run im_format_list "$rows" 2000 0
  [[ "$output" == *"[telegram-group-n2]"* ]]
  run im_format_list "$rows" 2000 1
  [[ "$output" != *"[telegram-group-n2]"* ]]
}

@test "picking a number returns that row's session id, out of range returns nothing" {
  rows="$(printf 'aaaaaaaa-1111\ttelegram-dm-1\t第一\t08/07 10:00\nbbbbbbbb-2222\ttelegram-group-n2\t第二\t08/07 11:00\n')"
  run im_row_sid "$rows" 2
  [ "$output" = "bbbbbbbb-2222" ]
  run im_row_sid "$rows" 9
  [ -z "$output" ]
  run im_row_sid "$rows" abc
  [ -z "$output" ]
}

@test "a number a normal user cannot see is not selectable" {
  # The listing IS the permission check: rows the caller may not see never reach
  # im_row_sid, so there is no number that maps to another scope's session.
  make_session aaaaaaaa-1111 "私訊" 10
  make_session bbbbbbbb-2222 "群組" 5
  claim_session telegram-dm-1 aaaaaaaa-1111
  claim_session telegram-group-n2 bbbbbbbb-2222
  run pick_visible telegram-dm-1 1 2
  [ -z "$output" ]
}

# ── /resume 的第二道檢查（回編號者自己的身分）───────────────────────────────

@test "a normal user cannot switch to a session outside their scope" {
  # The attack the second check exists for: an admin runs /resume (rows span both
  # scopes), a non-admin in the same chat replies with a number. The stored rows
  # are not that person's, so the id has to be re-checked against a listing
  # recomputed for the replier.
  make_session aaaaaaaa-1111 "私訊" 10
  make_session bbbbbbbb-2222 "群組" 5
  claim_session telegram-dm-1 aaaaaaaa-1111
  claim_session telegram-group-n2 bbbbbbbb-2222
  run im_sid_visible telegram-dm-1 1 bbbbbbbb-2222
  [ "$status" -ne 0 ]
  run im_sid_visible telegram-dm-1 1 aaaaaaaa-1111
  [ "$status" -eq 0 ]
}

@test "an admin may switch to the other scope's session" {
  make_session bbbbbbbb-2222 "群組" 5
  claim_session telegram-group-n2 bbbbbbbb-2222
  run im_sid_visible telegram-dm-1 0 bbbbbbbb-2222
  [ "$status" -eq 0 ]
}

@test "an unknown or empty session id is never visible" {
  make_session aaaaaaaa-1111 "私訊" 5
  claim_session telegram-dm-1 aaaaaaaa-1111
  run im_sid_visible telegram-dm-1 0 nosuchsid
  [ "$status" -ne 0 ]
  run im_sid_visible telegram-dm-1 0 ""
  [ "$status" -ne 0 ]
}

@test "the check matches whole ids, not prefixes" {
  # grep without -x would let "aaaa" pass for "aaaaaaaa-1111", i.e. a truncated
  # id from the displayed list would be accepted as the real one.
  make_session aaaaaaaa-1111 "私訊" 5
  claim_session telegram-dm-1 aaaaaaaa-1111
  run im_sid_visible telegram-dm-1 1 aaaaaaaa
  [ "$status" -ne 0 ]
}

# ── /create-token ─────────────────────────────────────────────────────────────

@test "a minted invite has the plugins' schema and a 7-day expiry" {
  token="$(im_invite_create discord 777 "給小明")"
  [[ "$token" =~ ^[0-9a-f]{32}$ ]]
  run python3 -c "
import json,sys
d = json.load(open('$INVITES_FILE'))
assert d['version'] == 1, d
inv = d['invites']['$token']
assert inv['createdBy'] == 'discord:777', inv
assert inv['note'] == '給小明', inv
assert inv['usedBy'] == {} and inv['revokedAt'] is None, inv
assert 6.9*86400*1000 < inv['expiresAt'] - inv['createdAt'] < 7.1*86400*1000, inv
"
  [ "$status" -eq 0 ]
}

@test "minting preserves invites already in the file" {
  # Three unlocked writers share this file; replacing it instead of merging drops
  # tokens the servers or the im-invite skill just wrote.
  mkdir -p "$(dirname "$INVITES_FILE")"
  printf '%s' '{"version":1,"invites":{"old":{"createdAt":1,"createdBy":"x","expiresAt":2,"usedBy":{},"revokedAt":null}}}' > "$INVITES_FILE"
  token="$(im_invite_create discord 777)"
  run python3 -c "
import json
inv = json.load(open('$INVITES_FILE'))['invites']
assert 'old' in inv and '$token' in inv, inv
"
  [ "$status" -eq 0 ]
}

@test "a missing invites file is a cold start, not an error" {
  token="$(im_invite_create discord 777)"
  [ -f "$INVITES_FILE" ]
  [ -n "$token" ]
}

@test "an invite without a note omits the field rather than writing an empty one" {
  token="$(im_invite_create discord 777)"
  run python3 -c "
import json
assert 'note' not in json.load(open('$INVITES_FILE'))['invites']['$token']
"
  [ "$status" -eq 0 ]
}

@test "minting never writes admins or access.json" {
  # The rule an invite exists to enforce: redeeming one must not be a path to
  # promoting yourself.
  write_access '{"dmPolicy":"allowlist","allowFrom":[]}'
  before="$(cat "$DISCORD_STATE_DIR/access.json")"
  im_invite_create discord 777 >/dev/null
  [ "$(cat "$DISCORD_STATE_DIR/access.json")" = "$before" ]
  run python3 -c "
import json
assert 'admins' not in json.load(open('$INVITES_FILE'))
"
  [ "$status" -eq 0 ]
}

@test "two invites minted in a row are different tokens" {
  a="$(im_invite_create discord 777)"
  b="$(im_invite_create discord 777)"
  [ "$a" != "$b" ]
}

@test "picking a number also yields its scope, so an admin switch targets the right window" {
  rows="$(printf 'aaaaaaaa-1111\ttelegram-dm-1\t第一\t08/07 10:00\nbbbbbbbb-2222\ttelegram-group-n2\t第二\t08/07 11:00\n')"
  run im_row_scope "$rows" 2
  [ "$output" = "telegram-group-n2" ]
  run im_row_scope "$rows" 9
  [ -z "$output" ]
}

@test "writing an intent creates the scopes directory if it is not there yet" {
  # First boot on a fresh machine, or a cleaned ~/.claude. A bare redirect fails
  # here, and /clear sends /exit regardless — the restart then loses the
  # instruction and the user sees a command that did nothing.
  rm -rf "$AGENT_SCOPES_DIR"
  im_write_intent telegram-dm-1 new-session 11111111-2222-3333-4444-555555555555
  [ "$(cat "$AGENT_SCOPES_DIR/telegram-dm-1.new-session")" = "11111111-2222-3333-4444-555555555555" ]
}

@test "an unknown scope or intent kind is refused rather than written somewhere odd" {
  run im_write_intent nosuchscope new-session abc
  [ "$status" -ne 0 ]
  run im_write_intent telegram-dm-1 nosuchkind abc
  [ "$status" -ne 0 ]
}

# sudoers 的兩條 parity 測試留在 carrier：它們比對的 deploy/oci/claude-watchdog.sudoers
# 與 scripts/watchdog/lib.sh 都在那個 repo，從這裡讀不到。

@test "an unwritable intent path reports failure instead of pretending it wrote" {
  # The skills branch on this return value: a silent failure here means the agent
  # gets /exit anyway and restarts on the OLD session — "the command did nothing".
  mkdir -p "$AGENT_SCOPES_DIR"
  chmod 500 "$AGENT_SCOPES_DIR"
  run im_write_intent telegram-dm-1 new-session 11111111-2222-3333-4444-555555555555
  chmod 700 "$AGENT_SCOPES_DIR"
  [ "$status" -ne 0 ]
}

@test "the transcripts dir follows the launcher's workspace, not the cwd" {
  # Skills are sourced from wherever the model happens to be; $PWD at source time
  # would encode the wrong directory and the listing would come back empty.
  mkdir -p "$TMP/ws"
  ( cd /
    export AGENT_WORKSPACE_DIR="$TMP/ws"
    unset IM_PROJECTS_DIR
    source "${BATS_TEST_DIRNAME}/../scripts/lib/im.sh"
    A="$IM_PROJECTS_DIR"
    cd "$TMP"
    unset IM_PROJECTS_DIR
    source "${BATS_TEST_DIRNAME}/../scripts/lib/im.sh"
    [ "$IM_PROJECTS_DIR" = "$A" ]
    # Only the wiring is asserted here (projects root + the encoder's output);
    # the encoding's own correctness is pinned by the non-alphanumeric test.
    [ "$IM_PROJECTS_DIR" = "$HOME/.claude/projects/$(im_encode_workspace "$TMP/ws")" ] )
}

@test "the workspace is encoded from its real path, not through the symlink" {
  # The deployed workspace IS a symlink (/home/agent/workspace ->
  # /home/agent/.claude/workspace) and claude only ever names the target: it
  # reads its cwd via getcwd(3), which has already resolved the link. Encoding
  # the link name points the glob at a directory that does not exist.
  mkdir -p "$TMP/real-ws"
  ln -s "$TMP/real-ws" "$TMP/link-ws"
  [ "$(im_encode_workspace "$TMP/link-ws")" = "$(im_encode_workspace "$TMP/real-ws")" ]
  ( export AGENT_WORKSPACE_DIR="$TMP/link-ws"
    unset IM_PROJECTS_DIR
    source "${BATS_TEST_DIRNAME}/../scripts/lib/im.sh"
    [[ "$IM_PROJECTS_DIR" != *link-ws* ]] )
}

@test "every non-alphanumeric character is encoded, not just the slashes" {
  # The dot of ".claude" is the whole bug: on vm-a1b the workspace resolves to
  # /home/agent/.claude/workspace and the transcripts really live in
  # "-home-agent--claude-workspace". The old formula replaced slashes only, asked
  # for "-home-agent-workspace", and that directory has never existed.
  # Asserted as a suffix because the leading segments differ per machine (macOS
  # resolves /home through /System/Volumes/Data).
  mkdir -p "$TMP/.claude/workspace"
  local encoded
  encoded="$(im_encode_workspace "$TMP/.claude/workspace")"
  [[ "$encoded" == *--claude-workspace ]]
  # The line above only reaches "/" and ".": the input holds no other character
  # and the suffix match drops the mktemp prefix, the one part that might. A
  # mutant replacing just those two passed all 47 tests. The prefix borrows the
  # function under test on purpose — only the hardcoded tail is being asserted.
  mkdir -p "$TMP/a b_c+d,e"
  [ "$(im_encode_workspace "$TMP/a b_c+d,e")" = "$(im_encode_workspace "$TMP")-a-b-c-d-e" ]
}

@test "without AGENT_WORKSPACE_DIR the transcripts dir falls back to the cwd" {
  # A deliberate degraded path: running the skill by hand outside tmux leaves
  # AGENT_WORKSPACE_DIR unset. Dropping the fallback would not change the
  # behaviour anyway — realpath("") returns the cwd — it would only hide it, so
  # pin "falls back to cwd" as intended rather than untested.
  mkdir -p "$TMP/ws"
  ( cd "$TMP/ws"
    unset AGENT_WORKSPACE_DIR IM_PROJECTS_DIR
    source "${BATS_TEST_DIRNAME}/../scripts/lib/im.sh"
    [[ "$IM_PROJECTS_DIR" == "$HOME/.claude/projects/"*-ws ]] )
}

@test "a listing comes back from the directory the encoding points at" {
  # The one test that walks the whole chain — encode, glob, print a row. A wrong
  # encoding shows up here as the empty listing the user reads as "there are no
  # conversations", with every transcript sitting intact next door.
  mkdir -p "$TMP/ws"
  unset IM_PROJECTS_DIR
  export AGENT_WORKSPACE_DIR="$TMP/ws"
  source "${BATS_TEST_DIRNAME}/../scripts/lib/im.sh"
  mkdir -p "$IM_PROJECTS_DIR"
  make_session 11111111-2222-3333-4444-555555555555 "舊對話"
  claim_session telegram-dm-1 11111111-2222-3333-4444-555555555555
  run im_sessions_rows telegram-dm-1 1
  [ "${#lines[@]}" -eq 1 ]
  [[ "$output" == *"舊對話"* ]]
}
