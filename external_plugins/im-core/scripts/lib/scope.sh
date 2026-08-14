# external_plugins/im-core/scripts/lib/scope.sh
# shellcheck shell=bash
# Single source of truth for the SCOPE value domain.
#
# A scope is one fully independent execution unit: its own tmux window, its own
# claude process, and its own session pointer. Scopes run side by side off ONE
# bot token; which messages reach which scope is decided by the platform poller,
# not by any routing code of ours.
#
# The value domain is DYNAMIC: a scope is born the moment an unseen identity
# sends a message, so there is no list to enumerate. What can be checked is the
# SHAPE (SCOPE_ID_RE) and what is currently ALIVE (scopes_live). Everything that
# used to be per-scope-but-finite — inject ports above all — is gone with the
# fixed list, because a value allocated per scope needs a scope count to
# allocate from.

# AGENT_SCOPES_DIR 由宿主提供，本檔不給預設值 —— 理由見 lib-loader.sh 的 im_core_load。

# How long a pointer stays valid. Past this the scope starts a NEW session
# instead of resuming — the "two days of silence means a new conversation" rule.
#
# The clock is the pointer's own updatedAt, which the launcher refreshes on every
# claude launch — NOT the transcript's mtime. A scope that is up but idle (nobody
# talked to it) still has a fresh pointer, so it keeps its conversation; only a
# scope that has not been LAUNCHED in two days rolls over.
SCOPE_POINTER_TTL_SECONDS="${SCOPE_POINTER_TTL_SECONDS:-172800}"

# The line claude prints when `--resume <id>` names a session it cannot find.
# This is the ONLY positive proof that a pointer is dead rather than the launch
# having failed for some unrelated reason, which is why the heal path below
# matches it plus the session id it names — a marker alone would also match the
# previous boot's line still sitting in the pane's scrollback.
#
# CC-version-dependent wording, same class of coupling as the markers in
# scripts/watchdog/signals.sh. It is matched separately from the id so a change
# in the punctuation between them does not break the match.
SCOPE_DEAD_SESSION_MARKER='No conversation found with session ID'

# How many consecutive fast exits of a `--resume` boot are read as "this pointer
# is dead" even when the marker never appeared.
#
# The marker match is exact but string-coupled; this one is neither, and exists
# so a CC release that reworded the line degrades to "heals one boot later"
# instead of back to the JP-194 wedge. Rolling to a new session is the right
# answer for ANY cause that makes a resume die instantly — the transcript is
# untouched and /resume can still reach it.
SCOPE_RESUME_FAIL_LIMIT="${SCOPE_RESUME_FAIL_LIMIT:-3}"

# The legal shape of a scope-id: <platform>-(dm|group)-<normalized id>.
#
# Every scope-id that reaches a tmux target, a file path or a command string is
# checked against this FIRST. With a dynamic value domain there is no known-good
# list left to compare against, so this regex is the whole injection defence and
# must not be loosened. 同一個 repo 內的 external_plugins/telegram/scope-id.ts
# 持有同一條算式，tests/parity.test.sh 逐字元釘住兩者 —— 改一邊沒改另一邊，
# 測試當場紅。
#
# The id segment is [a-z0-9]+ only, which is why a telegram group's negative
# chat id is normalized to an `n` prefix rather than kept: a leading `-` reads as
# a flag in `tmux new-window -n <name>`.
SCOPE_ID_RE='^[a-z][a-z0-9]*-(dm|group)-[a-z0-9]+$'

# scope_is_valid <scope-id>: 0 when <scope-id> has the legal shape, else 1.
scope_is_valid() { [[ "$1" =~ $SCOPE_ID_RE ]]; }

# scope_platform <scope-id>: echo the platform (telegram / discord).
# Returns: 0, or 1 on an invalid scope-id.
scope_platform() {
  scope_is_valid "$1" || return 1
  printf '%s' "${1%%-*}"
}

# scope_kind <scope-id>: echo dm or group.
# Returns: 0, or 1 on an invalid scope-id.
scope_kind() {
  local rest
  scope_is_valid "$1" || return 1
  rest="${1#*-}"
  printf '%s' "${rest%%-*}"
}

# tmux 相關的三個函式（_scope_tmux_windows / scopes_live / scope_tmux_target）
# 留在 carrier 的 scripts/lib-scope-tmux.sh：它們的知識是「這台機器怎麼開視窗」，
# 不是 scope 的值域。本檔到 scope-id 這一層為止。

# scope_resolve: echo the scope this process runs as, from AGENT_SCOPE.
#
# There is deliberately NO implicit default. A scope is now minted from the
# identity that sent a message, so a launcher with no AGENT_SCOPE has no way to
# guess whose conversation it is about to resume; defaulting would attach a
# stranger's window to somebody else's session pointer.
# Returns: 0 with the scope on stdout, 1 with the reason on stderr.
scope_resolve() {
  local scope="${AGENT_SCOPE:-}"
  if [ -z "$scope" ]; then
    echo "[lib-scope] AGENT_SCOPE is not set (expected shape: $SCOPE_ID_RE)" >&2
    return 1
  fi
  if ! scope_is_valid "$scope"; then
    echo "[lib-scope] invalid AGENT_SCOPE '$scope' (expected shape: $SCOPE_ID_RE)" >&2
    return 1
  fi
  printf '%s' "$scope"
}

# scope_env_prefix <channel>: echo the env var prefix a channel uses —
# discord -> DISCORD, internal-inject -> INTERNAL_INJECT. Both
# <PREFIX>_INJECT_PORT and <PREFIX>_STATE_DIR are built from it, which is
# precisely how the plugins name them.
# Returns: 0.
scope_env_prefix() {
  local channel="$1"
  channel="${channel//-/_}"
  printf '%s' "$(echo "$channel" | tr '[:lower:]' '[:upper:]')"
}

# scope_state_dir <platform>: echo the channel state dir of <platform>, shared by
# every scope of that platform.
#
# It takes a platform and NOT a scope on purpose. A per-scope state dir is self
# contradictory once scopes are born from messages: the directory of a brand new
# scope is necessarily empty, so its server.ts reads a default access.json
# (dmPolicy=pairing, allowFrom empty) and rejects the very user whose message
# spawned it — while handing a pairing code to someone who paired long ago.
# Returns: 0.
scope_state_dir() {
  printf '%s' "$HOME/.claude/channels/$1"
}

# scope_pointer_file <scope>: echo the path of the scope's session pointer.
# Returns: 0, or 1 on an invalid scope-id.
scope_pointer_file() {
  local scope="$1"
  scope_is_valid "$scope" || return 1
  printf '%s' "$AGENT_SCOPES_DIR/${scope}.json"
}

# scope_sessions_file <scope>: echo the path of the scope's session-id ledger.
#
# All scopes share ONE ~/.claude/projects/<encoded-cwd>/ directory, so a
# transcript file alone does not say which scope it belongs to. This ledger is
# the only trustworthy answer to that question, and /resume's per-scope listing
# is built on it.
# Returns: 0, or 1 on an invalid scope-id.
scope_sessions_file() {
  local scope="$1"
  scope_is_valid "$scope" || return 1
  printf '%s' "$AGENT_SCOPES_DIR/${scope}.sessions"
}

# scope_intent_file <scope> <kind>: echo the path of a one-shot intent file
# written by an agent skill and consumed by the launcher on its next loop.
#   resume      -> switch this scope to an existing session id
#   new-session -> start this scope on a brand new session id
# Returns: 0, or 1 on an invalid scope-id / kind.
scope_intent_file() {
  local scope="$1" kind="$2"
  scope_is_valid "$scope" || return 1
  case "$kind" in
    resume|new-session) ;;
    *) return 1 ;;
  esac
  printf '%s' "$AGENT_SCOPES_DIR/${scope}.${kind}"
}

# ── session pointer ──────────────────────────────────────────────────────────
# The pointer is what makes a scope keep its conversation across a restart, and
# what makes `--continue` unnecessary. `--continue` picks the most RECENTLY
# MODIFIED session in ~/.claude/projects/<encoded-cwd>/ — one directory shared by
# every scope — so it hands whichever scope restarts last somebody else's
# conversation. It is not used anywhere any more, on purpose.

# _scope_is_uuid <value>: 0 when <value> is a canonical uuid.
#
# Every session id read off disk lands in the launcher's `exec claude ... --resume
# <id>` command string, and the intent files are written by an agent skill acting
# on a user's message. This is the gate that keeps a session id a session id.
_scope_is_uuid() {
  [[ "$1" =~ ^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$ ]]
}

# scope_new_uuid: echo a fresh uuid for a new session.
# Returns: 0.
scope_new_uuid() {
  if command -v uuidgen >/dev/null 2>&1; then
    uuidgen | tr '[:upper:]' '[:lower:]'
    return 0
  fi
  if [ -r /proc/sys/kernel/random/uuid ]; then
    cat /proc/sys/kernel/random/uuid
    return 0
  fi
  python3 -c 'import uuid; print(uuid.uuid4())'
}

# scope_pointer_get <pointer file> <key>: echo one field of the pointer, or ""
# when the file is missing, unparseable, or has no such key. A corrupt pointer is
# deliberately indistinguishable from an absent one — the caller's answer to both
# is the same (start a new session), and a hard failure here would strand the
# scope with no agent at all.
# Returns: 0.
scope_pointer_get() {
  python3 - "$1" "$2" <<'PY' 2>/dev/null
import json, sys
try:
    with open(sys.argv[1]) as f:
        data = json.load(f)
except (OSError, ValueError):
    sys.exit(0)
if isinstance(data, dict):
    value = data.get(sys.argv[2])
    if value is not None:
        print(value)
PY
}

# scope_pointer_write <pointer file> <session id>: write the scope's pointer with
# updatedAt = now, preserving any other field already there.
#
# updatedAt is refreshed on EVERY launch including a --resume one: it is the TTL
# clock, so a long one-way conversation would otherwise expire itself.
# Returns: 0.
scope_pointer_write() {
  mkdir -p "$(dirname "$1")"
  python3 - "$1" "$2" <<'PY'
import json, os, sys, time, tempfile
path, session_id = sys.argv[1], sys.argv[2]
try:
    with open(path) as f:
        data = json.load(f)
    if not isinstance(data, dict):
        data = {}
except (OSError, ValueError):
    data = {}
data["version"] = 1
data["sessionId"] = session_id
data["updatedAt"] = int(time.time() * 1000)
# Write through a temp file in the same directory: the launcher writes this on
# every boot while an agent skill may be reading it, and a half-written pointer
# reads as corrupt, i.e. silently drops the conversation.
fd, tmp = tempfile.mkstemp(dir=os.path.dirname(path) or ".")
with os.fdopen(fd, "w") as f:
    json.dump(data, f, indent=2)
    f.write("\n")
os.replace(tmp, path)
PY
}

# scope_pointer_is_fresh <pointer file>: 0 when the pointer's updatedAt is within
# SCOPE_POINTER_TTL_SECONDS of now. Non-zero when it is stale, missing or corrupt.
# Returns: 0 / 1.
scope_pointer_is_fresh() {
  local updated_at now_ms
  updated_at="$(scope_pointer_get "$1" updatedAt)"
  [[ "$updated_at" =~ ^[0-9]+$ ]] || return 1
  now_ms=$(( $(date +%s) * 1000 ))
  [ "$(( now_ms - updated_at ))" -le "$(( SCOPE_POINTER_TTL_SECONDS * 1000 ))" ]
}

# scope_session_is_dead <pane text> <session id>: 0 when <pane text> carries
# claude's "no conversation found" line FOR <session id>.
#
# Both halves must be on the SAME line. Matching them anywhere in the pane is not
# enough: the launcher prints `session mode: --resume <this boot's id>` itself, so
# this id is always somewhere in the pane, and last boot's failure line for a
# DIFFERENT id stays in the scrollback. Whole-pane matching turns any unrelated
# fast exit into a quarantine of a perfectly healthy pointer.
# Returns: 0 / 1.
scope_session_is_dead() {
  # grep -qF '' matches every line, so an empty id would report every pane dead.
  [ -n "$2" ] || return 1
  printf '%s\n' "$1" | grep -F -- "$SCOPE_DEAD_SESSION_MARKER" | grep -qF -- "$2"
}

# scope_pointer_quarantine <scope>: move a pointer naming a session claude
# refuses to resume out of the way, echoing where it went.
#
# Renamed, never deleted: the pointer is the only record of which conversation a
# scope was on, and "which session id was wedged" is the first question asked
# afterwards. Removing it is what makes the next boot mint a new session — see
# scope_session_flag, whose pointer branch is otherwise unreachable-to-escape:
# it REWRITES updatedAt on every boot, so a dead pointer keeps refreshing its own
# TTL and can never expire its way out (JP-194).
# Returns: 0 with the backup path on stdout, 1 when there was no pointer to move.
scope_pointer_quarantine() {
  local pointer backup
  pointer="$(scope_pointer_file "$1")" || return 1
  [ -f "$pointer" ] || return 1
  backup="${pointer}.dead-$(date +%s).bak"
  mv "$pointer" "$backup" || return 1
  printf '%s' "$backup"
}

# scope_sessions_append <scope> <session id>: record that <session id> belongs to
# <scope>, deduped.
#
# All scopes share one ~/.claude/projects/<encoded-cwd>/ directory, so the
# transcript files alone cannot say which scope owns which conversation. This
# ledger is the only trustworthy answer, and /resume's per-scope listing (and its
# cross-scope permission check) is built on it.
# Returns: 0.
scope_sessions_append() {
  local file
  file="$(scope_sessions_file "$1")" || return 1
  mkdir -p "$(dirname "$file")"
  grep -qxF "$2" "$file" 2>/dev/null && return 0
  printf '%s\n' "$2" >> "$file"
}

# scope_session_flag <scope>: echo the claude session flag this boot should use,
# and persist the decision (pointer + ledger).
#
# Precedence, highest first:
#   1. a `resume` intent file      -> --resume <id>      (user asked for that one)
#   2. a `new-session` intent file -> --session-id <id>  (user asked for a fresh one)
#   3. a fresh pointer             -> --resume <id>      (carry on where we were)
#   4. anything else               -> --session-id <new uuid>
#
# Intent files are one-shot: consumed (deleted) whether or not their content was
# usable, so a malformed one cannot pin the scope to a broken boot forever.
#
# An expired pointer starts a new session but deletes NOTHING — the old
# transcript stays on disk under claude's own cleanupPeriodDays.
#
# The pointer branch cannot expire ITSELF out of a bad id: the write at the end
# refreshes updatedAt on every call, so a relaunch loop that keeps failing keeps
# the pointer permanently fresh. Escaping a dead pointer therefore has to come
# from outside this function — the launcher calls scope_pointer_quarantine when
# claude reports the session is gone (JP-194).
# Returns: 0 with the flag on stdout; diagnostics go to stderr.
scope_session_flag() {
  local scope="$1" pointer intent file sid="" flag=""
  pointer="$(scope_pointer_file "$scope")" || return 1

  for intent in resume new-session; do
    file="$(scope_intent_file "$scope" "$intent")"
    [ -f "$file" ] || continue
    sid="$(tr -d '[:space:]' < "$file")"
    rm -f "$file"
    if ! _scope_is_uuid "$sid"; then
      echo "[lib-scope] ignoring $intent intent for '$scope': not a uuid" >&2
      sid=""
      continue
    fi
    [ "$intent" = "resume" ] && flag="--resume" || flag="--session-id"
    break
  done

  if [ -z "$sid" ]; then
    sid="$(scope_pointer_get "$pointer" sessionId)"
    if _scope_is_uuid "$sid" && scope_pointer_is_fresh "$pointer"; then
      flag="--resume"
    else
      sid="$(scope_new_uuid)"
      flag="--session-id"
    fi
  fi

  scope_pointer_write "$pointer" "$sid"
  scope_sessions_append "$scope" "$sid"
  printf '%s %s' "$flag" "$sid"
}
