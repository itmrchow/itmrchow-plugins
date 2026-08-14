#!/usr/bin/env bash
# im-send <source> <recipient> <text>
# Channel-agnostic IM sender. Token resolution mirrors the channel plugin
# server.ts convention: real env var wins, else read <STATE_DIR>/.env.
# Set IM_SEND_DRY_RUN=1 to print the resolved request as JSON instead of
# performing the HTTP call (used by im-send.test.sh).
set -euo pipefail

SOURCE="${1:?usage: im-send <source> <recipient> <text>}"
RECIPIENT="${2:?usage: im-send <source> <recipient> <text>}"
TEXT="${3:?usage: im-send <source> <recipient> <text>}"

# Resolve a token: real env var first, then <state_dir>/.env.
resolve_token() {
  local token_var="$1" state_dir="$2" val
  val="${!token_var:-}"
  if [ -z "$val" ]; then
    val="$(grep -E "^${token_var}=" "${state_dir}/.env" 2>/dev/null | head -1 | cut -d= -f2-)"
  fi
  printf '%s' "$val"
}

case "$SOURCE" in
  telegram)
    state_dir="${TELEGRAM_STATE_DIR:-$HOME/.claude/channels/telegram}"
    token="$(resolve_token TELEGRAM_BOT_TOKEN "$state_dir")"
    [ -n "$token" ] || { echo "im-send: TELEGRAM_BOT_TOKEN not found (env or $state_dir/.env)" >&2; exit 1; }
    url="https://api.telegram.org/bot${token}/sendMessage"
    body="$(jq -nc --arg cid "$RECIPIENT" --arg t "$TEXT" '{chat_id:$cid, text:$t}')"
    if [ "${IM_SEND_DRY_RUN:-}" = "1" ]; then
      jq -nc --arg url "$url" --arg body "$body" '{channel:"telegram", method:"POST", url:$url, auth:"url", body:$body}'
      exit 0
    fi
    curl -fsS -X POST "$url" -H 'Content-Type: application/json' -d "$body" >/dev/null
    ;;
  discord)
    state_dir="${DISCORD_STATE_DIR:-$HOME/.claude/channels/discord}"
    token="$(resolve_token DISCORD_BOT_TOKEN "$state_dir")"
    [ -n "$token" ] || { echo "im-send: DISCORD_BOT_TOKEN not found (env or $state_dir/.env)" >&2; exit 1; }
    url="https://discord.com/api/v10/channels/${RECIPIENT}/messages"
    body="$(jq -nc --arg c "$TEXT" '{content:$c}')"
    if [ "${IM_SEND_DRY_RUN:-}" = "1" ]; then
      jq -nc --arg url "$url" --arg body "$body" '{channel:"discord", method:"POST", url:$url, auth:"header", body:$body}'
      exit 0
    fi
    curl -fsS -X POST "$url" -H "Authorization: Bot ${token}" -H 'Content-Type: application/json' -d "$body" >/dev/null
    ;;
  *)
    echo "im-send: unknown source '$SOURCE'" >&2
    exit 1
    ;;
esac
