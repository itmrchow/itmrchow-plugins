#!/bin/sh
# JP-76: pick the runtime by platform/mode, then exec server.ts.
#
# Why a launcher: .mcp.json is static JSON — Claude Code cannot branch on
# platform. This script does, then exec's so the server process REPLACES the
# shell: MCP stdin/stdout pass through natively, signals reach the server
# directly, and no wrapper process lingers.
#
# The platform default here MUST match resolvePollMode() in poll-mode.ts:
#   decoupled iff (arch is arm64/aarch64 AND os is Linux), else builtin.
# Runtime rule: tsx(node) iff (arm64-linux OR mode=decoupled), else bun.
#   - arm64-linux always needs tsx: bun's event loop starves the poll there, and
#     even a clamped-to-decoupled server must not run under bun.
#   - x86/other + builtin uses bun (GCP x86 ships bun, not tsx).
DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)

OS=$(uname -s)
ARCH=$(uname -m)

is_arm_linux() {
  [ "$OS" = "Linux" ] && { [ "$ARCH" = "aarch64" ] || [ "$ARCH" = "arm64" ]; }
}

MODE="$TELEGRAM_POLL_MODE"
if [ -z "$MODE" ]; then
  if is_arm_linux; then
    MODE=decoupled
  else
    MODE=builtin
  fi
fi

if is_arm_linux || [ "$MODE" = "decoupled" ]; then
  if ! command -v tsx >/dev/null 2>&1; then
    echo "telegram channel: decoupled/arm64-linux needs 'tsx' but it is not on PATH." >&2
    echo "  On x86 (e.g. GCP) do not force TELEGRAM_POLL_MODE=decoupled — use builtin (bun)." >&2
    exit 1
  fi
  exec tsx "$DIR/server.ts"
else
  if ! command -v bun >/dev/null 2>&1; then
    echo "telegram channel: builtin mode needs 'bun' but it is not on PATH." >&2
    echo "  Install bun (x86 / GCP hosts run the server under bun, not tsx)." >&2
    exit 1
  fi
  exec bun "$DIR/server.ts"
fi
