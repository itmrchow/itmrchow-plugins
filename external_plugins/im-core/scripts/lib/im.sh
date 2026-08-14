# external_plugins/im-core/scripts/lib/im.sh
# shellcheck shell=bash
# The decision logic behind the agent-side IM commands (JP-4 Task 5/6).
#
# The commands themselves are skills (the im-core plugin's im-*), i.e. prose the model
# follows. Everything here is the part that must NOT be re-derived by a model on
# each invocation: who counts as an admin, which sessions a caller may see, what
# an invite record looks like. A prose-only version of these would be re-read and
# re-interpreted every time, and the failure mode of a misread admin gate is
# someone getting /restart and /create-token.
#
# 由 lib-loader.sh 載入，不單獨 source：本檔用到 scope.sh 的 scope_is_valid /
# scope_kind / scope_intent_file，載入順序由 manifest.txt 決定。

INVITE_TTL_SECONDS="${INVITE_TTL_SECONDS:-604800}" # 7 days. Spec: fixed, no parameter.
INVITE_TOKEN_BYTES=16                              # 32 hex chars, matching the plugins' generateInviteToken.

# im_encode_workspace <path>: echo the transcripts-directory name claude uses for
# <path>.
#
# Two things this must copy exactly, and both were wrong before (JP-199):
#   - the REAL path. claude reads its cwd through node's process.cwd(), which is
#     getcwd(3) — symlinks are already resolved by the time claude sees it. The
#     launcher cd's into /home/agent/workspace, a symlink to
#     /home/agent/.claude/workspace, and only the latter ever names a directory.
#   - EVERY non-alphanumeric character becomes "-", not just the slashes. The dot
#     of ".claude" is why the real directory has a double dash in it.
# A near-miss here is silent: the glob simply matches nothing and /resume answers
# "there are no conversations" while every transcript sits intact next door.
# Not copied: claude truncates names past 200 chars and appends a hash. This
# workspace encodes to 29, so that branch is unreachable here — a workspace moved
# somewhere deep would need it.
# Returns: 0.
im_encode_workspace() {
  python3 - "$1" <<'PY'
import os, re, sys
print(re.sub(r"[^a-zA-Z0-9]", "-", os.path.realpath(sys.argv[1])))
PY
}

# Where transcripts live. Only the workspace segment is encoded; the
# $HOME/.claude/projects prefix keeps its slashes.
#
# The workspace comes from AGENT_WORKSPACE_DIR (exported by the launcher), not
# from $PWD: this file is sourced by skills that may run from anywhere, and $PWD
# is evaluated at source time — one `cd` earlier in the skill and the encoded
# name points at a transcripts directory that does not exist, which reads as
# "there are no sessions".
#
# The ${IM_PROJECTS_DIR:-...} form is deliberate: bash skips the default when the
# variable is already set, so an injected path (the tests) costs no python3 fork.
_IM_WORKSPACE="${AGENT_WORKSPACE_DIR:-$PWD}"
IM_PROJECTS_DIR="${IM_PROJECTS_DIR:-$HOME/.claude/projects/$(im_encode_workspace "$_IM_WORKSPACE")}"

# The shared invite file — ONE file for every platform and both scopes. Same
# path and env override the channel plugins use (invites-file.ts), because
# interop with the plugins' own /start redemption is the whole point.
IM_INVITES_FILE="${INVITES_FILE:-$HOME/.claude/channels/invites.json}"

# im_admins_file <platform>: echo the admins file shared by every scope of that
# platform.
#
# JP-4 kept the list in each scope's own access.json, which had to be copied by
# hand. Once scopes are born from messages there is no fixed set to copy to:
# "remember to add the admin list to every new conversation" is a rule that gets
# forgotten exactly once, and the cost of forgetting is a scope where nobody can
# run /restart. One file per platform instead.
# Returns: 0.
im_admins_file() {
  printf '%s' "${AGENT_SCOPES_DIR:-$HOME/.claude/agent-scopes}/$1-admins.json"
}

# im_is_admin <platform> <sender id>: 0 when the sender is an admin of that
# platform, 1 otherwise.
#
# The only source is the `admins` array of im_admins_file — a file no automated
# writer touches, and none creates either (see lib-access.sh): it exists only if
# a human made it. An id claimed in the message body is never consulted, and an
# empty / missing sender id is never an admin: the gate must fail closed, since
# the caller of a failing gate is /restart and /create-token.
# Returns: 0 / 1.
im_is_admin() {
  local platform="$1" sender="$2" file
  [ -n "$platform" ] || return 1
  [ -n "$sender" ] || return 1
  file="$(im_admins_file "$platform")"
  IM_SENDER="$sender" python3 - "$file" <<'PY'
import json, os, sys
try:
    with open(sys.argv[1]) as f:
        data = json.load(f)
except (OSError, ValueError):
    sys.exit(1)
admins = data.get("admins") if isinstance(data, dict) else None
sys.exit(0 if isinstance(admins, list) and os.environ["IM_SENDER"] in [str(i) for i in admins] else 1)
PY
}

# im_help_text <is_admin 0|1>: print the /help body for that audience.
#
# /start is absent from BOTH versions on purpose: listing it tells a stranger the
# invite mechanism exists, which is the one thing the silent-drop gate is there
# to avoid. /ctx is absent because the plugin owns it (assumption A-6) — a help
# text that promises behaviour we do not implement is worse than a missing line.
# Returns: 0.
im_help_text() {
  local is_admin="$1"
  cat <<'EOF'
可用指令：

/clear - 結束目前對話，開一個全新的
/rename <名稱> - 替目前對話命名
/resume - 列出對話並切換
/help - 顯示這份說明
EOF
  [ "$is_admin" = "0" ] || return 0
  cat <<'EOF'
/restart - 重啟 agent（管理員）
/create-token <備註> - 產生邀請碼（管理員，限私訊）
EOF
}

# im_sessions_rows <viewer scope> <is_admin 0|1>: print the sessions the caller
# may see, newest first, as TSV: <sid>\t<scope>\t<label>\t<mm/dd HH:MM>.
#
# A non-admin sees only rows their own ledger claims. That check is here rather
# than in the skill prose because it is also the /resume switch gate: a row the
# caller cannot see is a row they cannot switch to.
# Returns: 0.
im_sessions_rows() {
  local viewer="$1" is_admin="$2" scope sid file rows=""
  local -a claimed=()
  # The ledgers on disk, not the scopes that are up: a conversation whose window
  # was closed is exactly what someone runs /resume to get back.
  for file in "$AGENT_SCOPES_DIR"/*.sessions; do
    [ -f "$file" ] || continue
    scope="$(basename "$file" .sessions)"
    scope_is_valid "$scope" || continue
    while IFS= read -r sid; do
      [ -n "$sid" ] && claimed+=("$sid	$scope")
    done < "$file"
  done
  rows="$(printf '%s\n' "${claimed[@]+"${claimed[@]}"}")"
  IM_VIEWER="$viewer" IM_IS_ADMIN="$is_admin" IM_ROWS="$rows" python3 - "$IM_PROJECTS_DIR" <<'PY'
import glob, json, os, sys
from datetime import datetime

owner = {}
for line in os.environ["IM_ROWS"].splitlines():
    if "\t" in line:
        sid, scope = line.split("\t", 1)
        owner[sid] = scope

viewer, is_admin = os.environ["IM_VIEWER"], os.environ["IM_IS_ADMIN"] == "0"
for path in sorted(glob.glob(os.path.join(sys.argv[1], "*.jsonl")), key=os.path.getmtime, reverse=True):
    sid = os.path.basename(path)[: -len(".jsonl")]
    scope = owner.get(sid, "")
    if not is_admin and scope != viewer:
        continue
    title = ""
    try:
        with open(path) as f:
            for line in f:
                try:
                    obj = json.loads(line)
                except ValueError:
                    continue
                if isinstance(obj, dict) and obj.get("type") == "ai-title":
                    title = obj.get("aiTitle") or ""
    except OSError:
        continue
    stamp = datetime.fromtimestamp(os.path.getmtime(path)).strftime("%m/%d %H:%M")
    print("\t".join([sid, scope, title or "（未命名）", stamp]))
PY
}

# im_format_list <rows> <char limit> [show scope 0|1]: turn the TSV rows of
# im_sessions_rows into the numbered list sent to the user, cut at the last WHOLE
# line that fits.
#
# Rows come in as an argument rather than on stdin because the python body is
# itself a heredoc on stdin — piping into this would feed the script, not data.
#
# Discord's 2000-char cap truncates mid-character otherwise, and a half-printed
# row is a row the user will pick by a number that no longer means what it shows.
# Returns: 0.
im_format_list() {
  IM_ROWS="$1" IM_LIMIT="$2" IM_SHOW_SCOPE="${3:-1}" python3 <<'PY'
import os

limit = int(os.environ["IM_LIMIT"])
show_scope = os.environ["IM_SHOW_SCOPE"] == "0"
out, used = [], 0
for n, line in enumerate(os.environ["IM_ROWS"].splitlines(), 1):
    if not line.strip():
        continue
    sid, scope, label, stamp = (line.split("\t") + ["", "", "", ""])[:4]
    prefix = f"[{scope or '?'}] " if show_scope else ""
    row = f"{n}. {prefix}{label}  [{sid[:8]}]  {stamp}"
    if used + len(row) + 1 > limit:
        break
    out.append(row)
    used += len(row) + 1
print("\n".join(out))
PY
}

# im_row_sid <rows> <n>: echo the session id of the nth row, "" when the number is
# out of range. Rows are an argument for the same reason as im_format_list.
#
# Out of range returns nothing rather than an error because that is also the
# answer for "a row this caller may not see": im_sessions_rows already dropped
# those, so no number can address another scope's session.
# Returns: 0.
im_row_sid() {
  im_row_field "$1" "$2" 1
}

# im_row_scope <rows> <n>: echo the scope owning the nth row, "" when out of
# range. /resume needs it when an admin switches to a row of the other scope: the
# intent file and the /exit both have to go to THAT scope's window, not this one.
# Returns: 0.
im_row_scope() {
  im_row_field "$1" "$2" 2
}

# im_row_field <rows> <n> <1-based column>: one TSV cell of the nth row.
# Returns: 0.
im_row_field() {
  IM_ROWS="$1" IM_N="$2" IM_FIELD="$3" python3 <<'PY'
import os
rows = [r for r in os.environ["IM_ROWS"].splitlines() if r.strip()]
try:
    n = int(os.environ["IM_N"])
except ValueError:
    raise SystemExit(0)
if 1 <= n <= len(rows):
    fields = rows[n - 1].split("\t")
    index = int(os.environ["IM_FIELD"]) - 1
    if index < len(fields):
        print(fields[index])
PY
}

# im_sid_visible <viewer scope> <is_admin 0|1> <session id>: 0 when this caller
# may switch to <session id> right now.
#
# /resume hands the user a numbered list in one turn and reads the number in the
# next. The rows behind those numbers were produced for whoever asked FIRST, and
# in a scope whose allowFrom holds more than one person that need not be the same
# human — an admin's listing (which spans both scopes) followed by a non-admin's
# reply would otherwise switch a scope the replier cannot even see.
#
# So the number is resolved against the stored rows, and the resulting id is then
# re-checked here against a listing recomputed for the REPLIER. Membership only:
# recomputing renumbers (the order is by mtime and moves between turns), and
# taking the nth row of the fresh listing would silently select someone else's.
# Returns: 0 / 1.
im_sid_visible() {
  local viewer="$1" is_admin="$2" sid="$3"
  [ -n "$sid" ] || return 1
  im_sessions_rows "$viewer" "$is_admin" | cut -f1 | grep -qxF "$sid"
}

# im_resume_allowed <viewer scope> <is_admin 0|1>: 0 when this caller may run
# /resume here at all.
#
# A group is a shared room: listing conversations there tells everyone present
# WHO has been talking to the bot in private, which is a leak even when every
# row belongs to the person who asked. So a non-admin in a group is refused
# before any listing is computed. An admin may still use it there, since the
# whole listing is already theirs to see.
# Returns: 0 / 1.
im_resume_allowed() {
  local viewer="$1" is_admin="$2"
  [ "$is_admin" = "0" ] || [ "$(scope_kind "$viewer")" = "dm" ]
}

# im_write_intent <scope> <kind> <session id>: leave a one-shot instruction for
# the launcher's next loop (kind: resume | new-session).
#
# Creates the directory first. On a machine where no scope has launched yet —
# or right after someone cleaned ~/.claude — a bare redirect fails, and the
# skill's next line sends /exit anyway: the agent restarts having lost the
# instruction, which reads to the user as "the command did nothing".
# Returns: 0, or 1 on an unknown scope / kind, or on a failed write.
im_write_intent() {
  local file
  file="$(scope_intent_file "$1" "$2")" || return 1
  mkdir -p "$(dirname "$file")" || return 1
  printf '%s\n' "$3" > "$file"
}

# im_invite_create <platform> <admin id> [note]: mint an invite and append it to
# the shared invites file. Echoes the token.
#
# Read-modify-write of the whole file, re-read at call time: the channel servers
# edit `usedBy` in place and prune revoked tombstones, so anything this process
# read earlier in the conversation is already stale. Written through a temp file
# for the same reason the plugins do — three unlocked writers share this file, so
# a reader must never see it half-written.
#
# It writes ONLY the invite. Never access.json, never admins: an invite that
# could grant admin would let its holder promote themselves, which is the exact
# thing the invite gate exists to prevent.
# Returns: 0 with the token on stdout.
im_invite_create() {
  local platform="$1" admin_id="$2" note="${3:-}" token
  token="$(openssl rand -hex "$INVITE_TOKEN_BYTES")"
  IM_TTL="$INVITE_TTL_SECONDS" python3 - "$IM_INVITES_FILE" "$token" "$platform:$admin_id" "$note" <<'PY'
import json, os, sys, tempfile, time
path, token, created_by, note = sys.argv[1:5]
try:
    with open(path) as f:
        data = json.load(f)
    if not isinstance(data, dict):
        data = {}
except (OSError, ValueError):
    data = {}
invites = data.get("invites")
if not isinstance(invites, dict):
    invites = {}
now = int(time.time() * 1000)
entry = {
    "createdAt": now,
    "createdBy": created_by,
    "expiresAt": now + int(os.environ["IM_TTL"]) * 1000,
    "usedBy": {},
    "revokedAt": None,
}
if note:
    entry["note"] = note
invites[token] = entry
data["version"] = 1
data["invites"] = invites
os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
fd, tmp = tempfile.mkstemp(dir=os.path.dirname(path) or ".")
with os.fdopen(fd, "w") as f:
    json.dump(data, f, indent=2)
    f.write("\n")
os.replace(tmp, path)
PY
  printf '%s' "$token"
}
