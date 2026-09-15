#!/usr/bin/env bash
# external_plugins/im-core/scripts/reauth.sh
# Claude Code OAuth token 的 IM 重新驗證執行器。由 channel poller spawn，不經 Claude Code。
#
# 兩個角色：
#   start / code / status / check / mark-issued —— 短命 CLI，poller 依 exit code 回話
#   _driver                                    —— 每個流程一支背景行程，擁有計時與狀態機
# 契約（exit code、檔名）見 lib/reauth-contract.sh；env 見 README「重新驗證執行器」。
#
# token 規則：只經 bash 內建處理；給子行程一律 export 後 exec，絕不放進任何 argv。
# 整個主體包在函式裡、檔尾才呼叫 —— marketplace update 可能在流程中改寫本檔，
# bash 必須在執行前就讀完全部內容。
# shellcheck source-path=SCRIPTDIR
set -uo pipefail
set +x

REAUTH_SELF="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/$(basename "${BASH_SOURCE[0]}")"
REAUTH_SCRIPTS_DIR="$(dirname "$REAUTH_SELF")"
# shellcheck source=lib/reauth-contract.sh
source "$REAUTH_SCRIPTS_DIR/lib/reauth-contract.sh"
# shellcheck source=reauth/lib-reauth.sh
source "$REAUTH_SCRIPTS_DIR/reauth/lib-reauth.sh"

REAUTH_CODE_TTL_SECONDS="${REAUTH_CODE_TTL_SECONDS:-300}"
REAUTH_URL_WAIT_SECONDS="${REAUTH_URL_WAIT_SECONDS:-45}"
REAUTH_EXCHANGE_WAIT_SECONDS="${REAUTH_EXCHANGE_WAIT_SECONDS:-60}"
REAUTH_PROBE_TIMEOUT_SECONDS="${REAUTH_PROBE_TIMEOUT_SECONDS:-90}"
REAUTH_RESTART_TIMEOUT_SECONDS="${REAUTH_RESTART_TIMEOUT_SECONDS:-480}"
REAUTH_FLOW_MAX_SECONDS="${REAUTH_FLOW_MAX_SECONDS:-1500}"
REAUTH_POLL_INTERVAL_SECONDS="${REAUTH_POLL_INTERVAL_SECONDS:-1}"
REAUTH_TMUX_SOCKET="${REAUTH_TMUX_SOCKET:-claude-reauth}"
REAUTH_TMUX_SESSION="${REAUTH_TMUX_SESSION:-claude-reauth}"
REAUTH_TMUX_WIDTH=500
REAUTH_TMUX_HEIGHT=50
REAUTH_CAPTURE_LINES=1000
# 驗證碼上限 512（lib）；多讀一截，超長的輸入才判得出「超長」而不是被截成合法長度。
REAUTH_MAX_CODE_BYTES=1024
# 剛取鎖、還沒寫入 pid 的幾秒內（start 正在起 driver）也算活著，
# 否則 Telegram 與 Discord 幾乎同時的兩個 /reauth 會互相回收對方的鎖。
REAUTH_LOCK_GRACE_SECONDS=10
REAUTH_PLATFORM_RE='^(telegram|discord)$'
REAUTH_CHAT_TYPE_RE='^(dm|group)$'
# 會被拼進 tmux / sudo 參數的設定值只接受這個字元集（systemd unit 名另可含 @ .）。
REAUTH_NAME_RE='^[A-Za-z0-9_-]+$'
REAUTH_SERVICE_RE='^[A-Za-z0-9@._-]+$'
REAUTH_SECONDS_RE='^[0-9]+$'
REAUTH_ENV_WHITELIST_RE='^(HOME|PATH|LANG|LC_ALL|USER|LOGNAME|TERM)$'
IM_SEND_BIN="${IM_SEND_BIN:-$REAUTH_SCRIPTS_DIR/im-send.sh}"

_reauth_log() { printf 'reauth: event=%s %s\n' "$1" "${*:2}" >&2; }
_reauth_lock_dir() { printf '%s/flow.lock' "$REAUTH_STATE_DIR"; }
_reauth_state_file() { printf '%s/state' "$(_reauth_lock_dir)"; }
_reauth_code_file() { printf '%s/code.in' "$(_reauth_lock_dir)"; }

# _reauth_state_get <key>: 印 state 檔內該 key 的值。Returns: 0 / 1（無檔或無 key）。
_reauth_state_get() {
  local file line
  file="$(_reauth_state_file)"
  [ -f "$file" ] || return 1
  while IFS= read -r line; do
    [ "${line%%=*}" = "$1" ] && { printf '%s' "${line#*=}"; return 0; }
  done < "$file"
  return 1
}

# _reauth_state_set <key> <value>: 原子重寫整份 state 檔。
# 同一時間只有一個寫者：start 在起 driver 之前寫完，之後只有 driver 寫。Returns: 0 / 1。
_reauth_state_set() {
  local key="$1" value="$2" file tmp line
  file="$(_reauth_state_file)"
  tmp="$(umask 077; mktemp "$(_reauth_lock_dir)/.state.XXXXXX")" || return 1
  if [ -f "$file" ]; then
    while IFS= read -r line; do
      [ "${line%%=*}" = "$key" ] || printf '%s\n' "$line"
    done < "$file" > "$tmp"
  fi
  printf '%s=%s\n' "$key" "$value" >> "$tmp"
  mv -f "$tmp" "$file"
}

# _reauth_lock_is_fresh: 鎖目錄建立不到一分鐘（state 檔都還沒寫出來的那一瞬間用）。
_reauth_lock_is_fresh() {
  [ -n "$(find "$(_reauth_lock_dir)" -maxdepth 0 -mmin -1 2>/dev/null)" ]
}

# _reauth_flow_is_live: 鎖內 pid 活著且未超過流程上限。Returns: 0 / 1。
_reauth_flow_is_live() {
  local pid started now
  [ -d "$(_reauth_lock_dir)" ] || return 1
  now="$(date +%s)"
  started="$(_reauth_state_get started_at)" || started=""
  [[ "$started" =~ $REAUTH_SECONDS_RE ]] || started=""
  if ! pid="$(_reauth_state_get pid)"; then
    if [ -n "$started" ]; then
      (( now - started <= REAUTH_LOCK_GRACE_SECONDS ))
      return
    fi
    _reauth_lock_is_fresh
    return
  fi
  [ -n "$started" ] && [[ "$pid" =~ $REAUTH_SECONDS_RE ]] || return 1
  kill -0 "$pid" 2>/dev/null || return 1
  (( now - started <= REAUTH_FLOW_MAX_SECONDS ))
}

_reauth_tmux() { tmux -L "$REAUTH_TMUX_SOCKET" -f /dev/null "$@"; }

# _reauth_pid_is_driver <pid>: 該 pid 確實是本執行器的 driver（pid 可能已被重用）。
_reauth_pid_is_driver() {
  local args
  args="$(ps -p "$1" -o args= 2>/dev/null)" || return 1
  [[ "$args" == *"$REAUTH_SELF _driver"* ]]
}

# _reauth_lock_reclaim <state 內容>: 把 stale 鎖改名移走再刪。改名是原子的；移走後內容
# 若與判定時看到的不同，代表另一支 start 搶先回收並建了新鎖 —— 放回去、當作被佔用。
# Returns: 0 回收成功 / 1 放棄。
_reauth_lock_reclaim() {
  local seen="$1" lock graveyard pid
  lock="$(_reauth_lock_dir)"
  graveyard="$(umask 077; mktemp -d "$REAUTH_STATE_DIR/.stale.XXXXXX")" || return 1
  if ! mv "$lock" "$graveyard/lock" 2>/dev/null; then
    rm -rf "$graveyard"
    return 1
  fi
  if [ "$(cat "$graveyard/lock/state" 2>/dev/null)" != "$seen" ]; then
    mv "$graveyard/lock" "$lock" 2>/dev/null || true
    rm -rf "$graveyard"
    return 1
  fi
  pid="$(sed -n 's/^pid=//p' "$graveyard/lock/state" 2>/dev/null)"
  # 超時但還活著的舊 driver 必須停掉，否則它之後會繼續寫 .env。用 KILL：它的 TERM handler
  # 會清 tmux server 與暫存目錄，而那些已經屬於新流程。
  if [[ "$pid" =~ $REAUTH_SECONDS_RE ]] && _reauth_pid_is_driver "$pid"; then
    kill -KILL "$pid" 2>/dev/null || true
  fi
  _reauth_tmux kill-server 2>/dev/null || true
  rm -rf "$graveyard" "$REAUTH_STATE_DIR"/cfg.* "$REAUTH_STATE_DIR"/probe.*
}

# _reauth_lock_acquire: 取鎖；stale 就回收。Returns: 0 取得 / 1 被活流程佔用 / 2 目錄不可用。
_reauth_lock_acquire() {
  local lock seen stale_phase="" stale_backup=""
  lock="$(_reauth_lock_dir)"
  (umask 077; mkdir -p "$REAUTH_STATE_DIR") 2>/dev/null || return 2
  if ! mkdir -m 700 "$lock" 2>/dev/null; then
    _reauth_flow_is_live && return 1
    seen="$(cat "$(_reauth_state_file)" 2>/dev/null)"
    stale_phase="$(_reauth_state_get phase || true)"
    stale_backup="$(_reauth_state_get backup || true)"
    _reauth_lock_reclaim "$seen" || return 1
    _reauth_log stale_flow_reclaimed "phase=${stale_phase:-unknown}"
    mkdir -m 700 "$lock" 2>/dev/null || return 1
  fi
  _reauth_state_set started_at "$(date +%s)"
  [ -z "$stale_phase" ] || _reauth_state_set stale_phase "$stale_phase"
  [ -z "$stale_backup" ] || _reauth_state_set stale_backup "$stale_backup"
}

_reauth_lock_release() { rm -rf "$(_reauth_lock_dir)"; }

# _reauth_resolve_bin <name> <override>: 印絕對路徑。systemd 的 PATH 很窄，補常見安裝位置。
_reauth_resolve_bin() {
  local name="$1" override="$2"
  if [ -n "$override" ]; then
    [ -x "$override" ] && { printf '%s' "$override"; return 0; }
    return 1
  fi
  PATH="$HOME/.local/bin:/usr/local/bin:$PATH" command -v "$name"
}

# _reauth_parse_request "$@": 設定 REQ_PLATFORM / REQ_SENDER / REQ_CHAT / REQ_CHAT_TYPE。
# Returns: 0 / 1（未知旗標、缺值、值域不符）。
_reauth_parse_request() {
  REQ_PLATFORM="" REQ_SENDER="" REQ_CHAT="" REQ_CHAT_TYPE=""
  while [ $# -gt 0 ]; do
    [ $# -ge 2 ] || return 1
    case "$1" in
      --platform)  REQ_PLATFORM="$2" ;;
      --sender)    REQ_SENDER="$2" ;;
      --chat)      REQ_CHAT="$2" ;;
      --chat-type) REQ_CHAT_TYPE="$2" ;;
      *) return 1 ;;
    esac
    shift 2
  done
  [[ "$REQ_PLATFORM" =~ $REAUTH_PLATFORM_RE ]] && [[ "$REQ_CHAT_TYPE" =~ $REAUTH_CHAT_TYPE_RE ]] \
    && reauth_id_is_valid "$REQ_SENDER" && reauth_id_is_valid "$REQ_CHAT"
}

# _reauth_authorize: 管理員名單只由 im-core 的 im_is_admin 判（判定規則只有一份）。
# Returns: 0 / REAUTH_EXIT_UNAUTHORIZABLE / REAUTH_EXIT_NOT_ADMIN / REAUTH_EXIT_NOT_DM。
_reauth_authorize() {
  [ -n "${AGENT_SCOPES_DIR:-}" ] || return "$REAUTH_EXIT_UNAUTHORIZABLE"
  # shellcheck source=lib/lib-loader.sh
  source "$REAUTH_SCRIPTS_DIR/lib/lib-loader.sh" 2>/dev/null || return "$REAUTH_EXIT_UNAUTHORIZABLE"
  im_is_admin "$REQ_PLATFORM" "$REQ_SENDER" || return "$REAUTH_EXIT_NOT_ADMIN"
  [ "$REQ_CHAT_TYPE" = "dm" ] || return "$REAUTH_EXIT_NOT_DM"
}

# _reauth_check_config [verbose]: 逐項檢查設定；verbose 時印 ok: / missing:。Returns: 0 齊全 / 1 不齊。
_reauth_check_config() {
  local verbose="${1:-}" missing=0 item
  _reauth_report() { [ -z "$verbose" ] || printf '%s: %s\n' "$1" "$2"; [ "$1" = ok ] || missing=1; }
  for item in AGENT_SCOPES_DIR REAUTH_ENV_FILE REAUTH_AGENT_SERVICE REAUTH_STATE_DIR; do
    if [ -n "${!item:-}" ]; then _reauth_report ok "$item"; else _reauth_report missing "$item"; fi
  done
  if [ -n "${REAUTH_ENV_FILE:-}" ] && [ -f "$REAUTH_ENV_FILE" ] && [ ! -L "$REAUTH_ENV_FILE" ] && [ -w "$REAUTH_ENV_FILE" ]; then
    _reauth_report ok "REAUTH_ENV_FILE is a writable regular file"
  else
    _reauth_report missing "REAUTH_ENV_FILE as a writable regular file (not a symlink)"
  fi
  if [[ "${REAUTH_AGENT_SERVICE:-}" =~ $REAUTH_SERVICE_RE ]]; then
    _reauth_report ok "REAUTH_AGENT_SERVICE value"
  else
    _reauth_report missing "REAUTH_AGENT_SERVICE matching $REAUTH_SERVICE_RE"
  fi
  # 路徑會被放進 tmux new-session 的單引號命令字串內
  if [[ "${REAUTH_STATE_DIR:-}" == *"'"* || "$REAUTH_SELF" == *"'"* ]]; then
    _reauth_report missing "REAUTH_STATE_DIR and executor path without a single quote"
  else
    _reauth_report ok "paths without a single quote"
  fi
  for item in REAUTH_TMUX_SOCKET REAUTH_TMUX_SESSION; do
    if [[ "${!item}" =~ $REAUTH_NAME_RE ]]; then _reauth_report ok "$item value"; else _reauth_report missing "$item matching $REAUTH_NAME_RE"; fi
  done
  for item in REAUTH_CODE_TTL_SECONDS REAUTH_URL_WAIT_SECONDS REAUTH_EXCHANGE_WAIT_SECONDS REAUTH_PROBE_TIMEOUT_SECONDS \
              REAUTH_RESTART_TIMEOUT_SECONDS REAUTH_FLOW_MAX_SECONDS; do
    if [[ "${!item}" =~ $REAUTH_SECONDS_RE ]]; then _reauth_report ok "$item value"; else _reauth_report missing "$item as whole seconds"; fi
  done
  if _reauth_resolve_bin claude "${REAUTH_CLAUDE_BIN:-}" >/dev/null; then _reauth_report ok claude; else _reauth_report missing claude; fi
  if _reauth_resolve_bin direnv "${REAUTH_DIRENV_BIN:-}" >/dev/null; then _reauth_report ok direnv; else _reauth_report missing direnv; fi
  for item in tmux sudo jq; do
    if command -v "$item" >/dev/null; then _reauth_report ok "$item"; else _reauth_report missing "$item"; fi
  done
  if [ -x "$IM_SEND_BIN" ]; then _reauth_report ok IM_SEND_BIN; else _reauth_report missing IM_SEND_BIN; fi
  return "$missing"
}

_reauth_cmd_start() {
  _reauth_parse_request "$@" || return "$REAUTH_EXIT_USAGE"
  local rc=0 started
  _reauth_authorize || return $?
  _reauth_check_config || return "$REAUTH_EXIT_NOT_CONFIGURED"
  _reauth_lock_acquire || rc=$?
  [ "$rc" -eq 0 ] || { [ "$rc" -eq 1 ] && return "$REAUTH_EXIT_BUSY"; return "$REAUTH_EXIT_NOT_CONFIGURED"; }
  started="$(_reauth_state_get started_at)"
  _reauth_state_set phase STARTING
  _reauth_state_set platform "$REQ_PLATFORM"
  _reauth_state_set sender "$REQ_SENDER"
  _reauth_state_set chat "$REQ_CHAT"
  _reauth_state_set deadline "$(( started + REAUTH_CODE_TTL_SECONDS ))"
  # pid 由 driver 自己寫：它一起來就會寫 state，這裡再寫一次會和它搶同一個檔。
  "$REAUTH_SELF" _driver </dev/null >/dev/null &
  disown "$!" 2>/dev/null || true
  _reauth_log flow_started "platform=$REQ_PLATFORM"
  return "$REAUTH_EXIT_OK"
}

_reauth_cmd_code() {
  _reauth_parse_request "$@" || return "$REAUTH_EXIT_USAGE"
  local code="" tmp deadline
  _reauth_authorize || return $?
  _reauth_check_config || return "$REAUTH_EXIT_NOT_CONFIGURED"
  IFS= read -r -n "$REAUTH_MAX_CODE_BYTES" code || true
  code="${code%$'\r'}"
  code="${code#"${code%%[![:space:]]*}"}"; code="${code%"${code##*[![:space:]]}"}"
  _reauth_flow_is_live || return "$REAUTH_EXIT_NO_PENDING"
  [ "$(_reauth_state_get platform)" = "$REQ_PLATFORM" ] && [ "$(_reauth_state_get sender)" = "$REQ_SENDER" ] \
    || return "$REAUTH_EXIT_NO_PENDING"
  [ "$(_reauth_state_get phase)" = "WAIT_CODE" ] || return "$REAUTH_EXIT_BUSY"
  deadline="$(_reauth_state_get deadline)" || deadline=""
  [[ "$deadline" =~ $REAUTH_SECONDS_RE ]] && (( $(date +%s) < deadline )) || return "$REAUTH_EXIT_NO_PENDING"
  reauth_code_is_valid "$code" || return "$REAUTH_EXIT_INVALID_CODE"
  tmp="$(umask 077; mktemp "$(_reauth_lock_dir)/.code.XXXXXX")" || return "$REAUTH_EXIT_NOT_CONFIGURED"
  if ! { printf '%s' "$code" > "$tmp" && mv -f "$tmp" "$(_reauth_code_file)"; }; then
    rm -f "$tmp"
    return "$REAUTH_EXIT_NOT_CONFIGURED"
  fi
  _reauth_log code_accepted "platform=$REQ_PLATFORM"
  return "$REAUTH_EXIT_OK"
}

_reauth_cmd_status() {
  [ -n "${REAUTH_STATE_DIR:-}" ] || { echo idle; return 0; }
  if _reauth_flow_is_live; then
    printf 'phase=%s\n' "$(_reauth_state_get phase || printf 'STARTING')"
  else
    echo idle
  fi
}

_reauth_cmd_mark_issued() {
  [ -n "${REAUTH_STATE_DIR:-}" ] || return "$REAUTH_EXIT_NOT_CONFIGURED"
  reauth_date_is_valid "${1:-}" || return "$REAUTH_EXIT_USAGE"
  reauth_write_issued "$REAUTH_STATE_DIR" "$1" manual || return "$REAUTH_EXIT_NOT_CONFIGURED"
}

# Task A5 取代以下兩個 stub
_reauth_driver() { [ -d "$(_reauth_lock_dir)" ] || return 1; _reauth_lock_release; }
_reauth_exec_setup_token() { return 1; }

main() {
  local sub="${1:-}"
  [ $# -gt 0 ] && shift
  case "$sub" in
    start)             _reauth_cmd_start "$@" ;;
    code)              _reauth_cmd_code "$@" ;;
    status)            _reauth_cmd_status ;;
    check)             _reauth_check_config verbose || return "$REAUTH_EXIT_NOT_CONFIGURED" ;;
    mark-issued)       _reauth_cmd_mark_issued "$@" ;;
    _driver)           [ -n "${REAUTH_STATE_DIR:-}" ] || return "$REAUTH_EXIT_NOT_CONFIGURED"; _reauth_driver ;;
    _exec_setup_token) _reauth_exec_setup_token "$@" ;;
    *)                 return "$REAUTH_EXIT_USAGE" ;;
  esac
}

main "$@"
exit $?
