# external_plugins/im-core/scripts/reauth/lib-reauth.sh
# shellcheck shell=bash
# 重新驗證執行器的純函式。token 只經 bash 內建處理，不當任何外部命令的參數 ——
# argv 對同機所有使用者可見（ps / /proc/<pid>/cmdline）。

REAUTH_TOKEN_RE='sk-ant-oat01-[A-Za-z0-9_-]{80,200}'
REAUTH_URL_RE='https://[^[:space:]]+/oauth/authorize\?[^[:space:]]+'
# 長度上限另外比：BSD regex（macOS）的重複次數上限是 255，{1,512} 會直接編譯失敗。
REAUTH_CODE_RE='^[A-Za-z0-9_#-]+$'
REAUTH_CODE_MAX_LENGTH=512
REAUTH_ID_RE='^-?[0-9]{1,32}$'
REAUTH_DATE_RE='^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
REAUTH_TOKEN_KEY="CLAUDE_CODE_OAUTH_TOKEN"
# 驗證輸出的失敗字樣。carrier 的 watchdog signals.sh（CLAUDE_401_MARKERS）是同一類事實，
# 兩邊各自維護；Claude Code 升級改字時兩處都要看。
REAUTH_AUTH_FAILURE_MARKERS=('API Error: 401' 'OAuth token' 'Please run /login' 'Invalid API key' 'Failed to authenticate')
REAUTH_ISSUED_SOURCES_RE='^(reauth|manual)$'

# reauth_extract_url <pane>: 印第一個授權 URL。Returns: 0 / 1。
reauth_extract_url() {
  local line
  while IFS= read -r line; do
    if [[ "$line" =~ $REAUTH_URL_RE ]]; then
      printf '%s' "${BASH_REMATCH[0]}"
      return 0
    fi
  done <<< "$1"
  return 1
}

# reauth_extract_token <pane>: 印唯一 token；0 個或多個不同值都視為失敗。Returns: 0 / 1。
reauth_extract_token() {
  local line found=""
  local token_line="^[[:space:]]*($REAUTH_TOKEN_RE)[[:space:]]*$"
  while IFS= read -r line; do
    [[ "$line" =~ $token_line ]] || continue
    if [[ -n "$found" && "$found" != "${BASH_REMATCH[1]}" ]]; then
      return 1
    fi
    found="${BASH_REMATCH[1]}"
  done <<< "$1"
  [[ -n "$found" ]] || return 1
  printf '%s' "$found"
}

# reauth_code_is_valid <code>: 驗證碼字元白名單與長度。Returns: 0 / 1。
reauth_code_is_valid() {
  local LC_ALL=C
  (( ${#1} <= REAUTH_CODE_MAX_LENGTH )) && [[ "$1" =~ $REAUTH_CODE_RE ]]
}

# reauth_id_is_valid <id>: 平台 user / chat id（群組可為負數）。Returns: 0 / 1。
reauth_id_is_valid() { local LC_ALL=C; [[ "$1" =~ $REAUTH_ID_RE ]]; }

# reauth_date_is_valid <YYYY-MM-DD>: 格式 + 月日範圍。Returns: 0 / 1。
reauth_date_is_valid() {
  [[ "$1" =~ $REAUTH_DATE_RE ]] || return 1
  local month="${1:5:2}" day="${1:8:2}"
  (( 10#$month >= 1 && 10#$month <= 12 && 10#$day >= 1 && 10#$day <= 31 ))
}

# reauth_env_value <file> <key>: 與 carrier deploy/oci/lib-env-guard.sh 的 env_guard_value_of
# 同語意（最後一次賦值、去 export、去空白含 \r、去一對引號）。Returns: 0。
reauth_env_value() {
  local file="$1" key="$2" line value=""
  local assignment="^[[:space:]]*(export[[:space:]]+)?${key}=(.*)$"
  local double_quoted='^"(.*)"$' single_quoted="^'(.*)'$"
  while IFS= read -r line || [[ -n "$line" ]]; do
    [[ "$line" =~ $assignment ]] || continue
    value="${BASH_REMATCH[2]}"
  done < "$file"
  value="${value#"${value%%[![:space:]]*}"}"
  value="${value%"${value##*[![:space:]]}"}"
  if [[ "$value" =~ $double_quoted ]] || [[ "$value" =~ $single_quoted ]]; then
    value="${BASH_REMATCH[1]}"
  fi
  printf '%s' "$value"
}

# reauth_env_render <file> <token>: 印出替換 token 後的完整 .env 內容。Returns: 0。
reauth_env_render() {
  local file="$1" token="$2" line
  local key_line="^[[:space:]]*(export[[:space:]]+)?${REAUTH_TOKEN_KEY}="
  while IFS= read -r line || [[ -n "$line" ]]; do
    [[ "$line" =~ $key_line ]] && continue
    printf '%s\n' "$line"
  done < "$file"
  printf '%s=%s\n' "$REAUTH_TOKEN_KEY" "$token"
}

# reauth_output_has_auth_failure <text>: 輸出含任一登入失敗字樣。Returns: 0 含 / 1 不含。
reauth_output_has_auth_failure() {
  local marker
  for marker in "${REAUTH_AUTH_FAILURE_MARKERS[@]}"; do
    case "$1" in *"$marker"*) return 0 ;; esac
  done
  return 1
}

# reauth_write_issued <state_dir> <date> <source>: 原子寫產生日記錄（不含 token）。Returns: 0 / 1。
reauth_write_issued() {
  local dir="$1" date="$2" source="$3" tmp
  reauth_date_is_valid "$date" || return 1
  [[ "$source" =~ $REAUTH_ISSUED_SOURCES_RE ]] || return 1
  mkdir -p "$dir" || return 1
  tmp="$(umask 077; mktemp "$dir/.token-issued.XXXXXX")" || return 1
  printf '{"version":1,"issued_on":"%s","source":"%s"}\n' "$date" "$source" > "$tmp" || { rm -f "$tmp"; return 1; }
  mv -f "$tmp" "$dir/${REAUTH_ISSUED_FILE_NAME:-token-issued.json}"
}
