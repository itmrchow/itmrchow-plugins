# external_plugins/im-core/scripts/lib/channels.sh
# shellcheck shell=bash
# channel 值域的唯一真相來源，宿主的 launcher 與 watchdog 共用。新增一個
# channel = 改 KNOWN_CHANNELS 加下面兩張表，其餘不動。
#
# 本檔與 channel plugin 現在住在同一個 repo：_channel_inject_spec /
# _channel_poller_spec 的預設 port 必須與 internal-inject/server.ts、
# telegram/poller.ts、discord/discord-poller.ts 的字面值相同，
# tests/parity.test.sh 釘住這條。以前這是跨 repo 的口頭約定，現在是測試。
#
# Channel name == plugin name in itmrchow-plugins, so the launcher maps a
# channel to its plugin tag with an identity mapping (plugin:<name>@...).

# Channel names MUST stay [a-z0-9-]: the launcher interpolates them unquoted
# into the `claude --channels` command string, so a name with whitespace or
# shell metacharacters would break the expansion.
KNOWN_CHANNELS=(discord internal-inject telegram)

# The channels that ARE an IM platform, i.e. the ones that can appear as the
# <platform> segment of a scope-id. The distinction matters because a scope
# loads exactly ONE of these — its own, named by its scope-id — while the rest
# (internal-inject) are platform-agnostic services carried by the bootstrap
# scope alone (see channels_bootstrap_extra).
PLATFORM_CHANNELS=(discord telegram)

# channels_known_list: echo the accepted channel names, space separated.
# Returns: 0.
channels_known_list() { printf '%s' "${KNOWN_CHANNELS[*]}"; }

# channels_is_platform <channel>: 0 when <channel> is an IM platform, else 1.
channels_is_platform() {
  local candidate="$1" platform
  for platform in "${PLATFORM_CHANNELS[@]}"; do
    [ "$candidate" = "$platform" ] && return 0
  done
  return 1
}

# channels_is_known <channel>: 0 when <channel> is in KNOWN_CHANNELS, else 1.
channels_is_known() {
  local candidate="$1" known
  for known in "${KNOWN_CHANNELS[@]}"; do
    [ "$candidate" = "$known" ] && return 0
  done
  return 1
}

# _channel_inject_spec <channel>: echo "<port env var>:<default port>" for that
# channel, or "" when it has no inject endpoint (callers skip those, they are
# not an error). Var name and default live on ONE line so they cannot drift
# apart, and so adding a channel touches exactly two places: KNOWN_CHANNELS and
# this case.
#
# The defaults MUST match the plugin-side fallbacks in itmrchow-plugins
# (internal-inject server.ts 7844). A mismatch means the watchdog probes a port
# nothing ever listens on, reads that as a dead agent, and restarts the box
# every cycle forever.
#
# ONLY internal-inject is left here. The IM platforms used to listen on an
# inject port of their own; their server.ts now SUBSCRIBES to its platform
# poller instead and binds nothing at all, so an entry for them would name a
# port no process on this box ever opens — which is precisely the restart loop
# above. Their liveness is probed through _channel_poller_spec now.
# 由 tests/parity.test.sh 自動比對。
_channel_inject_spec() {
  case "$1" in
    internal-inject) printf '%s' "INTERNAL_INJECT_PORT:7844" ;;
    *)               printf '%s' "" ;;
  esac
}

# _channel_poller_spec <platform>: echo "<port env var>:<default port>" for that
# platform's poller, or "" for a channel that has no poller (callers skip those,
# not an error). Same one-line shape as _channel_inject_spec, and under the same
# constraint: the defaults MUST match the plugin-side fallbacks, or the watchdog
# probes a port nobody listens on.
#
# One poller per PLATFORM, not per scope: the poller holds the single connection
# to the IM and fans messages out to however many scopes exist, so its port is
# the one fixed port left on the box.
# 由 tests/parity.test.sh 自動比對。
_channel_poller_spec() {
  case "$1" in
    discord)  printf '%s' "DISCORD_POLLER_PORT:7853" ;;
    telegram) printf '%s' "TELEGRAM_POLLER_PORT:7852" ;;
    *)        printf '%s' "" ;;
  esac
}

# _channel_port_from_spec <spec>: echo the port a "<var>:<default>" spec resolves
# to — the env var's value when set, else the default. "" for an empty spec.
# Returns: 0.
_channel_port_from_spec() {
  local spec="$1" var value
  [ -n "$spec" ] || return 0
  var="${spec%%:*}"
  value="${!var:-}"
  [ -n "$value" ] || value="${spec##*:}"
  printf '%s' "$value"
}

# channel_inject_port <channel>: echo the inject port in effect for <channel> —
# the value of its port env var, else its default. Echoes "" for a channel with
# no inject endpoint (caller skips it).
# Returns: 0.
channel_inject_port() { _channel_port_from_spec "$(_channel_inject_spec "$1")"; }

# channel_poller_port <platform>: echo the subscribe port of that platform's
# poller — the value of its port env var, else its default. Echoes "" for a
# channel with no poller (caller skips it).
# Returns: 0.
channel_poller_port() { _channel_port_from_spec "$(_channel_poller_spec "$1")"; }

# channels_resolve: echo the channels this host runs, one per line.
#
# Source of truth: CHANNELS (comma-separated list) wins; CHANNEL (singular) is
# the compatibility path for deployments predating multi-channel. Order is the
# order given, duplicates are dropped, surrounding whitespace is trimmed.
#
# Neither set -> non-zero (caller fails fast). There is deliberately no implicit
# default: an unset CHANNEL used to silently boot discord, which hides a
# half-configured deploy (bot online, wrong channel, no inbound messages).
# An unknown name is also non-zero, listing the accepted values.
#
# Returns: 0 with the list on stdout, 1 with the reason on stderr.
channels_resolve() {
  local raw="${CHANNELS:-${CHANNEL:-}}"
  if [ -z "$raw" ]; then
    echo "[lib-channels] neither CHANNELS nor CHANNEL is set (e.g. CHANNELS=$(channels_known_list | tr ' ' ','))" >&2
    return 1
  fi

  local parts=() item seen=" " out=""
  IFS=',' read -r -a parts <<< "$raw"
  for item in "${parts[@]}"; do
    # Trim the ends only. Stripping ALL whitespace would silently repair typos
    # ("tele gram" -> a working "telegram"), which is exactly the kind of quiet
    # input correction the allowlist below is meant to prevent.
    item="${item#"${item%%[![:space:]]*}"}"
    item="${item%"${item##*[![:space:]]}"}"
    [ -n "$item" ] || continue
    if ! channels_is_known "$item"; then
      echo "[lib-channels] invalid channel '$item' (expected: $(channels_known_list))" >&2
      return 1
    fi
    case "$seen" in *" $item "*) continue ;; esac
    seen="$seen$item "
    out="$out$item"$'\n'
  done

  if [ -z "$out" ]; then
    echo "[lib-channels] channel list is empty (expected: $(channels_known_list))" >&2
    return 1
  fi
  printf '%s' "$out"
}

# ── the bootstrap scope ──────────────────────────────────────────────────────
# A non-platform channel binds ONE box-wide port (internal-inject: 7844), so it
# cannot be loaded by every scope: N windows would race for that port, the first
# would win, and which session an injected message lands in would come down to
# who opened a window first. Exactly ONE scope carries them — BOOTSTRAP_SCOPE,
# spawned at boot by tmux-start.sh — which keeps the JP-4 semantics of "inject
# goes to the operator's own session" without a fixed identity in the code.
#
# Both variables empty = the mechanism is off (a new deployment's default).

# _channels_bootstrap_extra_list: echo the validated BOOTSTRAP_EXTRA_CHANNELS
# entries, one per line, regardless of which scope is asking. Empty when the
# variable is unset or blank.
# Returns: 0, or 1 with the reason on stderr for an unknown name or a platform
# name — a scope's platform comes from its scope-id, so a platform listed here
# is a configuration mistake, and swallowing it would load a second platform's
# plugin into one window.
_channels_bootstrap_extra_list() {
  local parts=() item out=""
  IFS=',' read -r -a parts <<< "${BOOTSTRAP_EXTRA_CHANNELS:-}"
  for item in "${parts[@]}"; do
    item="${item#"${item%%[![:space:]]*}"}"
    item="${item%"${item##*[![:space:]]}"}"
    [ -n "$item" ] || continue
    if ! channels_is_known "$item"; then
      echo "[lib-channels] invalid channel '$item' in BOOTSTRAP_EXTRA_CHANNELS (expected: $(channels_known_list))" >&2
      return 1
    fi
    if channels_is_platform "$item"; then
      echo "[lib-channels] BOOTSTRAP_EXTRA_CHANNELS must not name a platform channel ('$item') — every scope already loads the platform its scope-id names" >&2
      return 1
    fi
    case $'\n'"$out" in *$'\n'"$item"$'\n'*) continue ;; esac
    out="$out$item"$'\n'
  done
  printf '%s' "$out"
}

# channels_bootstrap_extra <scope-id>: echo the channels that scope loads ON TOP
# of its own platform, one per line — the BOOTSTRAP_EXTRA_CHANNELS list for the
# bootstrap scope, nothing at all for any other scope.
# Returns: 0, or 1 with the reason on stderr on an invalid list.
channels_bootstrap_extra() {
  [ -n "${BOOTSTRAP_SCOPE:-}" ] || return 0
  [ "$1" = "$BOOTSTRAP_SCOPE" ] || return 0
  _channels_bootstrap_extra_list
}

# channels_bootstrap_guard: 0 when the bootstrap scope is one that can actually
# be spawned AND every non-platform channel in CHANNELS is one it will load, 1
# with the reason on stderr otherwise. Checked before the tmux session is
# created, so a host in this state does not boot at all. Requires scope.sh
# (scope_is_valid / scope_platform) sourced.
#
# WHY refuse to boot instead of dropping the channel from the list: the operator
# asked for internal-inject on purpose, and the cost of quietly removing it is
# that the services POSTing to 7844 stop being delivered with nobody — not the
# caller, not the agent — seeing an error. The other alternative is worse still:
# leaving 7844 unbound makes the watchdog read inject_down and restart the agent
# forever, which says nothing about why.
#
# The same reasoning is why the scope-id itself is checked here rather than left
# to spawn time. A malformed id is skipped by scope-spawn.sh with a warning, and
# a well-formed id whose platform is absent from CHANNELS spawns a window that
# exits 1 on _platform_loaded — both end with nobody holding 7844, i.e. the
# restart loop above, reported far from its cause.
#
# ...but only when BOOTSTRAP_EXTRA_CHANNELS is non-empty, which is exactly when
# something depends on that scope actually starting. With no extras, a typo'd
# BOOTSTRAP_SCOPE strands nothing: scope-spawn.sh warns, skips it, and the IM
# channels — which are fine — boot as usual. Refusing there would take a healthy
# host down over an unused field.
# Returns: 0 or 1.
channels_bootstrap_guard() {
  local channels extra channel platform
  # An unresolvable channel list is not this check's business: the launcher
  # already refuses to start on it, with a message about that.
  channels="$(channels_resolve 2>/dev/null)" || return 0
  extra="$(_channels_bootstrap_extra_list)" || return 1

  if [ -n "${BOOTSTRAP_SCOPE:-}" ] && [ -n "$extra" ]; then
    if ! scope_is_valid "$BOOTSTRAP_SCOPE"; then
      echo "[lib-channels] BOOTSTRAP_SCOPE='$BOOTSTRAP_SCOPE' is not a scope-id — expected <platform>-<kind>-<id>, e.g. telegram-dm-123456789 (get the id by messaging the bot and reading the chat_id in the incoming channel tag)" >&2
      return 1
    fi
    platform="$(scope_platform "$BOOTSTRAP_SCOPE")"
    if ! grep -qxF "$platform" <<< "$channels"; then
      echo "[lib-channels] BOOTSTRAP_SCOPE='$BOOTSTRAP_SCOPE' names platform '$platform', which is not in CHANNELS ($(tr '\n' ',' <<< "$channels" | sed 's/,$//')) — that scope could never start. Fix it either way: add '$platform' to CHANNELS, or point BOOTSTRAP_SCOPE at a scope on a platform you already run" >&2
      return 1
    fi
  fi

  while IFS= read -r channel; do
    [ -n "$channel" ] || continue
    if channels_is_platform "$channel"; then
      continue
    fi
    if [ -z "${BOOTSTRAP_SCOPE:-}" ] || ! grep -qxF "$channel" <<< "$extra"; then
      echo "[lib-channels] '$channel' is in CHANNELS but no scope would load it — it binds one box-wide port, so exactly one scope may carry it. Fix it either way: remove '$channel' from CHANNELS, or set BOOTSTRAP_SCOPE (your personal scope-id, e.g. telegram-dm-123456789) together with BOOTSTRAP_EXTRA_CHANNELS=$channel" >&2
      return 1
    fi
  done <<< "$channels"
  return 0
}

# channels_for_scope <scope-id>: echo the channels THAT scope loads, one per
# line — its own platform (the one its scope-id names), plus, for the bootstrap
# scope only, its BOOTSTRAP_EXTRA_CHANNELS. Requires scope.sh
# (scope_platform) sourced.
#
# ONE PLATFORM PER SCOPE: the scope-id already names the platform this process
# serves, so another platform's plugin would only add an MCP server nothing ever
# talks to.
#
# This is also the answer to "which ports may this scope reap". A scope must
# never reap a port bound by a channel it does not itself load: that port
# belongs to another scope's LIVE server, and killing it is the box-wide-reap
# bug — one scope restarting takes another scope's channel down with it. Keeping
# both callers (the launcher's --channels and the reap) on this one function is
# what makes those two sets equal by construction rather than by review.
# Returns: 0 with the list on stdout, 1 on an invalid scope-id or channel list.
channels_for_scope() {
  local scope="$1" platform channels extra channel out=""
  platform="$(scope_platform "$scope")" || return 1
  channels="$(channels_resolve)" || return 1
  extra="$(channels_bootstrap_extra "$scope")" || return 1
  while IFS= read -r channel; do
    [ -n "$channel" ] || continue
    if channels_is_platform "$channel"; then
      [ "$channel" = "$platform" ] || continue
    elif ! grep -qxF "$channel" <<< "$extra"; then
      continue
    fi
    out="$out$channel"$'\n'
  done <<< "$channels"
  printf '%s' "$out"
}
