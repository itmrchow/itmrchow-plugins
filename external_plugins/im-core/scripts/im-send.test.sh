#!/usr/bin/env bash
# Dry-run unit tests for im-send.sh. No network. Run: bash scripts/im-send.test.sh
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
SEND="$HERE/im-send.sh"
fail=0
ok()   { echo "ok:   $1"; }
bad()  { echo "FAIL: $1"; fail=1; }
check(){ if eval "$2"; then ok "$1"; else bad "$1"; fi; }

# --- telegram dry-run ---
out="$(TELEGRAM_BOT_TOKEN=tg-test IM_SEND_DRY_RUN=1 "$SEND" telegram 12345 'hi there')"
check "telegram url has token path" '[[ "$out" == *"api.telegram.org/bottg-test/sendMessage"* ]]'
check "telegram chat_id in body"    'echo "$out" | jq -e ".body|fromjson|.chat_id==\"12345\"" >/dev/null'
check "telegram text field"         'echo "$out" | jq -e ".body|fromjson|.text==\"hi there\"" >/dev/null'

# --- discord dry-run ---
out="$(DISCORD_BOT_TOKEN=dc-test IM_SEND_DRY_RUN=1 "$SEND" discord 999 'yo')"
check "discord url has channel path" '[[ "$out" == *"discord.com/api/v10/channels/999/messages"* ]]'
check "discord content field"        'echo "$out" | jq -e ".body|fromjson|.content==\"yo\"" >/dev/null'
check "discord auth header mode"     'echo "$out" | jq -e ".auth==\"header\"" >/dev/null'

# --- token from .env fallback (discord style) ---
tmp="$(mktemp -d)"; printf 'DISCORD_BOT_TOKEN=env-file-tok\n' > "$tmp/.env"
out="$(DISCORD_STATE_DIR="$tmp" IM_SEND_DRY_RUN=1 "$SEND" discord 5 'x')"
check "discord token from .env file" '[[ "$out" == *"\"channel\":\"discord\""* ]]'
rm -rf "$tmp"

# --- token from .env fallback (telegram style) ---
tmp="$(mktemp -d)"; printf 'TELEGRAM_BOT_TOKEN=tg-env-file-tok\n' > "$tmp/.env"
out="$(env -u TELEGRAM_BOT_TOKEN TELEGRAM_STATE_DIR="$tmp" IM_SEND_DRY_RUN=1 "$SEND" telegram 7 'x')"
check "telegram token from .env file" '[[ "$out" == *"api.telegram.org/bottg-env-file-tok/sendMessage"* ]]'
rm -rf "$tmp"

# --- unknown source errors ---
if TELEGRAM_BOT_TOKEN=x "$SEND" slack 1 hi 2>/dev/null; then bad "unknown source should error"; else ok "unknown source errors"; fi

# --- missing token errors ---
if env -u TELEGRAM_BOT_TOKEN TELEGRAM_STATE_DIR=/nonexistent "$SEND" telegram 1 hi >/dev/null 2>&1; then
  bad "missing token should error"; else ok "missing token errors"; fi

exit $fail
