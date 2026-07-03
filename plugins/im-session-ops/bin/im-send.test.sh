#!/usr/bin/env bash
# Dry-run unit tests for im-send. No network. Run: bash im-send.test.sh
#
# im-send builds JSON with python3 (json.dumps), whose spacing / non-ASCII
# escaping differs from jq. Assertions therefore parse the JSON and compare
# field values (semantic compare), never byte-compare the raw output. Parsing
# uses python3 so the tests introduce no jq dependency (matching im-send).
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
SEND="$HERE/im-send"
fail=0
ok()   { echo "ok:   $1"; }
bad()  { echo "FAIL: $1"; fail=1; }
check(){ if eval "$2"; then ok "$1"; else bad "$1"; fi; }

# Extract a field from im-send dry-run JSON on stdin.
# Arg is a top-level key, or "body.<key>" to parse the nested body string first.
field() {
  python3 -c '
import json, sys
obj = json.load(sys.stdin)
path = sys.argv[1]
if path.startswith("body."):
    print(json.loads(obj["body"])[path[len("body."):]])
else:
    print(obj[path])
' "$1"
}

# --- telegram dry-run ---
out="$(TELEGRAM_BOT_TOKEN=tg-test IM_SEND_DRY_RUN=1 "$SEND" telegram 12345 'hi there')"
check "telegram url has token path" '[[ "$(echo "$out" | field url)" == "https://api.telegram.org/bottg-test/sendMessage" ]]'
check "telegram chat_id in body"    '[[ "$(echo "$out" | field body.chat_id)" == "12345" ]]'
check "telegram text field"         '[[ "$(echo "$out" | field body.text)" == "hi there" ]]'
check "telegram auth mode url"      '[[ "$(echo "$out" | field auth)" == "url" ]]'

# --- discord dry-run ---
out="$(DISCORD_BOT_TOKEN=dc-test IM_SEND_DRY_RUN=1 "$SEND" discord 999 'yo')"
check "discord url has channel path" '[[ "$(echo "$out" | field url)" == "https://discord.com/api/v10/channels/999/messages" ]]'
check "discord content field"        '[[ "$(echo "$out" | field body.content)" == "yo" ]]'
check "discord auth header mode"      '[[ "$(echo "$out" | field auth)" == "header" ]]'

# --- non-ASCII text survives round-trip (json.dumps ensure_ascii escapes, parse restores) ---
out="$(TELEGRAM_BOT_TOKEN=tg-test IM_SEND_DRY_RUN=1 "$SEND" telegram 12345 '中文 test')"
check "telegram non-ascii text field" '[[ "$(echo "$out" | field body.text)" == "中文 test" ]]'

# --- token from .env fallback (discord style) ---
tmp="$(mktemp -d)"; printf 'DISCORD_BOT_TOKEN=env-file-tok\n' > "$tmp/.env"
out="$(DISCORD_STATE_DIR="$tmp" IM_SEND_DRY_RUN=1 "$SEND" discord 5 'x')"
check "discord token from .env file" '[[ "$(echo "$out" | field channel)" == "discord" ]]'
rm -rf "$tmp"

# --- token from .env fallback (telegram style) ---
tmp="$(mktemp -d)"; printf 'TELEGRAM_BOT_TOKEN=tg-env-file-tok\n' > "$tmp/.env"
out="$(env -u TELEGRAM_BOT_TOKEN TELEGRAM_STATE_DIR="$tmp" IM_SEND_DRY_RUN=1 "$SEND" telegram 7 'x')"
check "telegram token from .env file" '[[ "$(echo "$out" | field url)" == "https://api.telegram.org/bottg-env-file-tok/sendMessage" ]]'
rm -rf "$tmp"

# --- unknown source errors ---
if TELEGRAM_BOT_TOKEN=x "$SEND" slack 1 hi 2>/dev/null; then bad "unknown source should error"; else ok "unknown source errors"; fi

# --- missing token errors ---
if env -u TELEGRAM_BOT_TOKEN TELEGRAM_STATE_DIR=/nonexistent "$SEND" telegram 1 hi >/dev/null 2>&1; then
  bad "missing token should error"; else ok "missing token errors"; fi

exit $fail
