#!/usr/bin/env bash
# Static hygiene tests for the im-core skills. No network, no agent, no bats.
# Ported from claude-tg-agent scripts/watchdog/tests/im.bats (JP-202); kept as
# plain bash so the plugin carries no test-framework dependency.
# Run: bash tests/skills.test.sh
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
SKILLS="$HERE/../skills"
fail=0
ok()  { echo "ok:   $1"; }
bad() { echo "FAIL: $1"; fail=1; }

# The unit string carrier's sudoers authorises, verbatim. sudoers compares argv
# literally, so appending ".service" makes sudo fall through to a password
# prompt on a tty that does not exist -- the restart fails silently and the user
# just sees a bot that never came back. carrier's im.bats pins this same string
# against deploy/oci/claude-watchdog.sudoers; if either side drifts, that side
# goes red on its own. Do NOT add ".service".
RESTART_CMD="sudo systemctl restart claude-tg-agent"

# --- 1. restart skill's sudo line matches carrier's sudoers grant ---
# Match the executable command line only (line-initial sudo), not the counter
# example quoted in the skill's 注意 section.
actual="$(sed -n 's|^\(sudo systemctl restart .*\)$|\1|p' "$SKILLS/im-restart/SKILL.md")"
if [ "$actual" = "$RESTART_CMD" ]; then
  ok "restart skill sudo line is the literal sudoers grant"
else
  bad "restart skill sudo line drifted: expected '$RESTART_CMD', got '$actual'"
fi

# --- 2. no skill parks user-controlled state in /tmp ---
# /tmp is world-writable and these paths are fixed, so any local account could
# pre-create or overwrite them -- the /resume rows file most of all, since its
# content decides which session the agent switches to.
out="$(grep -rn 'file_path`: `/tmp/\|> */tmp/\|cat */tmp/\|rm -f */tmp/' "$SKILLS")"
if [ -z "$out" ]; then
  ok "no skill uses a /tmp path for state"
else
  bad "skill state found in /tmp:"$'\n'"$out"
fi

# --- 3. no skill derives the transcripts path from the cwd ---
# $PWD is whatever directory the model happened to be in; the launcher exports
# AGENT_WORKSPACE_DIR for exactly this. Getting it wrong points at a directory
# that does not exist, and the symptom is a command that silently does nothing.
out="$(grep -rn 'projects/\${PWD' "$SKILLS")"
if [ -z "$out" ]; then
  ok "no skill derives the transcripts path from \$PWD"
else
  bad "transcripts path derived from \$PWD:"$'\n'"$out"
fi

# --- 4. no skill builds the transcripts path itself ---
# JP-199 是同一條路徑公式活在兩處：lib-im.sh 與 /rename skill。修了一邊，另一邊
# 仍指向不存在的目錄，而且兩次的失敗都是無聲的。skills 一律從 lib-im.sh 取
# IM_PROJECTS_DIR。carrier 側的同名 bats 測試隨 skills 一起搬走，本條是它的接班人。
out="$(grep -rn 'claude/projects' "$SKILLS")"
if [ -z "$out" ]; then
  ok "no skill builds the transcripts path itself"
else
  bad "skill builds the transcripts path itself:"$'\n'"$out"
fi

exit $fail
