#!/bin/sh
# Pick the runtime by platform, then exec server.ts.
#
# Why a launcher: .mcp.json is static JSON — Claude Code cannot branch on
# platform. This script does, then exec's so the server process REPLACES the
# shell: MCP stdin/stdout pass through natively, signals reach the server
# directly, and no wrapper process lingers.
#
# Runtime rule: tsx(node) on arm64-linux, bun everywhere else. bun's event loop
# starves this process's timers on arm64-linux once the MCP stdin watcher is
# running, which breaks the subscription's reconnect backoff and idle timer.
#
# There is no poll-mode switch any more: inbound messages always arrive over a
# subscription to the platform poller, on every platform.
DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)

OS=$(uname -s)
ARCH=$(uname -m)

is_arm_linux() {
  [ "$OS" = "Linux" ] && { [ "$ARCH" = "aarch64" ] || [ "$ARCH" = "arm64" ]; }
}

if is_arm_linux; then
  if ! command -v tsx >/dev/null 2>&1; then
    echo "telegram channel: arm64-linux needs 'tsx' but it is not on PATH." >&2
    exit 1
  fi
  exec tsx "$DIR/server.ts"
else
  if ! command -v bun >/dev/null 2>&1; then
    echo "telegram channel: needs 'bun' but it is not on PATH." >&2
    echo "  Install bun (x86 / GCP hosts run the server under bun, not tsx)." >&2
    exit 1
  fi
  exec bun "$DIR/server.ts"
fi
