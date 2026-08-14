setup() {
  # 一個入口，不逐支 source：channels.sh 需要 scope.sh 的 scope_platform，
  # 而逐支 source 會在新增 lib 時靜默漏載。
  export AGENT_SCOPES_DIR="${BATS_TEST_TMPDIR:-$BATS_TMPDIR}/agent-scopes"
  source "${BATS_TEST_DIRNAME}/../scripts/lib/lib-loader.sh"
  unset CHANNELS CHANNEL INTERNAL_INJECT_PORT TELEGRAM_POLLER_PORT DISCORD_POLLER_PORT
  unset BOOTSTRAP_SCOPE BOOTSTRAP_EXTRA_CHANNELS
}

@test "CHANNELS resolves to a list, in the order given" {
  CHANNELS="telegram,discord" run channels_resolve
  [ "$status" -eq 0 ]
  [ "${lines[0]}" = "telegram" ]
  [ "${lines[1]}" = "discord" ]
  [ "${#lines[@]}" -eq 2 ]
}
@test "CHANNELS tolerates surrounding whitespace" {
  CHANNELS=" telegram , discord " run channels_resolve
  [ "$status" -eq 0 ]
  [ "${lines[0]}" = "telegram" ]
  [ "${lines[1]}" = "discord" ]
}
@test "inner whitespace is NOT stripped away — a typo stays a typo" {
  # Deleting all whitespace instead of trimming the ends would repair "tele gram"
  # into a working "telegram", i.e. silently accept a value nobody wrote.
  CHANNELS="tele gram" run channels_resolve
  [ "$status" -ne 0 ]
  [[ "$output" == *"tele gram"* ]]
}
@test "CHANNELS drops duplicates (one plugin tag per channel)" {
  CHANNELS="discord,discord" run channels_resolve
  [ "$status" -eq 0 ]
  [ "${#lines[@]}" -eq 1 ]
  [ "${lines[0]}" = "discord" ]
}
@test "CHANNEL (singular) still works for older deployments" {
  CHANNEL=telegram run channels_resolve
  [ "$status" -eq 0 ]
  [ "${lines[0]}" = "telegram" ]
  [ "${#lines[@]}" -eq 1 ]
}
@test "CHANNELS wins over CHANNEL when both are set" {
  CHANNELS="discord,telegram" CHANNEL=telegram run channels_resolve
  [ "$status" -eq 0 ]
  [ "${lines[0]}" = "discord" ]
  [ "${#lines[@]}" -eq 2 ]
}
@test "neither CHANNELS nor CHANNEL set: non-zero, no implicit discord default" {
  run channels_resolve
  [ "$status" -ne 0 ]
  [[ "$output" != *"discord"$'\n'* ]]
}
@test "unknown channel: non-zero and the message lists the valid values" {
  CHANNELS="telegran" run channels_resolve
  [ "$status" -ne 0 ]
  [[ "$output" == *"telegran"* ]]
  [[ "$output" == *"discord"* ]]
  [[ "$output" == *"telegram"* ]]
}
@test "whitespace/comma-only CHANNELS: non-zero" {
  CHANNELS=" , " run channels_resolve
  [ "$status" -ne 0 ]
}
@test "channel_inject_port falls back to the plugin-side default" {
  # 7844 must match external_plugins/internal-inject/server.ts's DEFAULT_PORT: the
  # watchdog probes THIS number, and a channel whose port nobody listens on is read
  # as a dead agent and restarted every cycle.
  run channel_inject_port internal-inject; [ "$output" = "7844" ]
}
@test "channel_inject_port honors the per-channel env override" {
  INTERNAL_INJECT_PORT=9003 run channel_inject_port internal-inject; [ "$output" = "9003" ]
}
@test "the IM platforms have NO inject port left — they subscribe, they do not listen" {
  # Their server.ts binds nothing now. Leaving them in the inject spec would make
  # the watchdog probe a port no process on the box ever opens, read that as a
  # dead channel, and restart the agent every single cycle forever.
  run channel_inject_port telegram; [ -z "$output" ]
  run channel_inject_port discord;  [ -z "$output" ]
}
@test "channel_poller_port falls back to the plugin-side defaults" {
  run channel_poller_port telegram; [ "$output" = "7852" ]
  run channel_poller_port discord;  [ "$output" = "7853" ]
}
@test "channel_poller_port honors the per-platform env override" {
  TELEGRAM_POLLER_PORT=9001 run channel_poller_port telegram; [ "$output" = "9001" ]
  DISCORD_POLLER_PORT=9002 run channel_poller_port discord;   [ "$output" = "9002" ]
}
@test "internal-inject has no poller: empty, which callers skip (not an error)" {
  run channel_poller_port internal-inject
  [ "$status" -eq 0 ]
  [ -z "$output" ]
}
@test "channels_for_scope keeps only the scope's own platform when no bootstrap is configured" {
  CHANNELS="telegram,discord,internal-inject" run channels_for_scope telegram-dm-1
  [ "$status" -eq 0 ]
  [ "${lines[0]}" = "telegram" ]
  [ "${#lines[@]}" -eq 1 ]
}
@test "channels_for_scope gives the service channels to the BOOTSTRAP scope" {
  BOOTSTRAP_SCOPE=telegram-dm-1 BOOTSTRAP_EXTRA_CHANNELS=internal-inject \
    CHANNELS="telegram,discord,internal-inject" run channels_for_scope telegram-dm-1
  [ "$status" -eq 0 ]
  [ "${lines[0]}" = "telegram" ]
  [ "${lines[1]}" = "internal-inject" ]
  [ "${#lines[@]}" -eq 2 ]
}
@test "channels_for_scope withholds the service channels from every OTHER scope" {
  # One box-wide port, one holder. Handing internal-inject to a second scope
  # would put two servers on 7844 and make "which session does an injected
  # message reach" a matter of who opened a window first.
  BOOTSTRAP_SCOPE=telegram-dm-1 BOOTSTRAP_EXTRA_CHANNELS=internal-inject \
    CHANNELS="telegram,internal-inject" run channels_for_scope telegram-dm-2
  [ "$status" -eq 0 ]
  [ "${lines[0]}" = "telegram" ]
  [ "${#lines[@]}" -eq 1 ]
}
@test "channels_for_scope is non-zero when BOOTSTRAP_EXTRA_CHANNELS names a platform" {
  BOOTSTRAP_SCOPE=telegram-dm-1 BOOTSTRAP_EXTRA_CHANNELS=discord \
    CHANNELS="telegram,discord" run channels_for_scope telegram-dm-1
  [ "$status" -ne 0 ]
  [[ "$output" == *"must not name a platform channel"* ]]
}
@test "channels_bootstrap_extra is empty for a non-bootstrap scope and for no bootstrap at all" {
  BOOTSTRAP_SCOPE=telegram-dm-1 BOOTSTRAP_EXTRA_CHANNELS=internal-inject \
    run channels_bootstrap_extra telegram-dm-2
  [ "$status" -eq 0 ]
  [ -z "$output" ]
  BOOTSTRAP_EXTRA_CHANNELS=internal-inject run channels_bootstrap_extra telegram-dm-1
  [ "$status" -eq 0 ]
  [ -z "$output" ]
}
@test "channels_bootstrap_extra rejects an unknown channel name" {
  BOOTSTRAP_SCOPE=telegram-dm-1 BOOTSTRAP_EXTRA_CHANNELS=inject \
    run channels_bootstrap_extra telegram-dm-1
  [ "$status" -ne 0 ]
  [[ "$output" == *"invalid channel 'inject'"* ]]
}
@test "the bootstrap guard passes on the default deployment (IM platforms only)" {
  # .env.example ships CHANNELS=telegram with both bootstrap values empty. That
  # combination must never be the one the new check refuses.
  CHANNELS="telegram" run channels_bootstrap_guard
  [ "$status" -eq 0 ]
}
@test "the bootstrap guard rejects a service channel nobody would load, naming both fixes" {
  CHANNELS="discord,internal-inject" run channels_bootstrap_guard
  [ "$status" -ne 0 ]
  [[ "$output" == *"remove 'internal-inject' from CHANNELS"* ]]
  [[ "$output" == *"BOOTSTRAP_EXTRA_CHANNELS=internal-inject"* ]]
}
@test "the bootstrap guard rejects a bootstrap scope whose extras do not cover CHANNELS" {
  # Half-configured is still unserved: the scope exists, but it loads nothing
  # that would bind 7844.
  BOOTSTRAP_SCOPE=telegram-dm-1 BOOTSTRAP_EXTRA_CHANNELS= \
    CHANNELS="telegram,internal-inject" run channels_bootstrap_guard
  [ "$status" -ne 0 ]
}
@test "the bootstrap guard passes once the scope and its extras are both set" {
  BOOTSTRAP_SCOPE=telegram-dm-1 BOOTSTRAP_EXTRA_CHANNELS=internal-inject \
    CHANNELS="telegram,internal-inject" run channels_bootstrap_guard
  [ "$status" -eq 0 ]
}
@test "the bootstrap guard rejects a BOOTSTRAP_SCOPE that is not a scope-id" {
  # A malformed id gets skipped at spawn time with a warning, so the box boots
  # with nobody on 7844 and the watchdog restart-loops it. Refuse here instead.
  BOOTSTRAP_SCOPE="not a scope!!" BOOTSTRAP_EXTRA_CHANNELS=internal-inject \
    CHANNELS="telegram,internal-inject" run channels_bootstrap_guard
  [ "$status" -ne 0 ]
  [[ "$output" == *"is not a scope-id"* ]]
}
@test "the bootstrap guard rejects a BOOTSTRAP_SCOPE on a platform absent from CHANNELS" {
  # channels_for_scope would hand that window a list with no platform channel in
  # it, and start-tg-agent.sh exits 1 on that — again nobody holds 7844.
  BOOTSTRAP_SCOPE=discord-dm-123 BOOTSTRAP_EXTRA_CHANNELS=internal-inject \
    CHANNELS="telegram,internal-inject" run channels_bootstrap_guard
  [ "$status" -ne 0 ]
  [[ "$output" == *"not in CHANNELS"* ]]
}
@test "the bootstrap guard stays out of the way when the channel list is unusable" {
  # channels_resolve's own error is the launcher's to report; two scripts
  # refusing the same misconfiguration for different reasons only confuses.
  unset CHANNELS CHANNEL
  run channels_bootstrap_guard
  [ "$status" -eq 0 ]
}
@test "channels_for_scope drops the OTHER platform (one platform per scope)" {
  CHANNELS="telegram,discord" run channels_for_scope discord-group-n9
  [ "$status" -eq 0 ]
  [ "${lines[0]}" = "discord" ]
  [ "${#lines[@]}" -eq 1 ]
}
@test "channels_for_scope is non-zero on an invalid scope-id" {
  # It feeds both the --channels flag and the orphan reap. Answering "everything"
  # for a scope-id nobody could parse would hand a caller the box-wide list under
  # the name of a single scope.
  CHANNELS="telegram" run channels_for_scope "not a scope"
  [ "$status" -ne 0 ]
}
@test "internal-inject is a known channel and resolves alongside an IM channel" {
  # It has no reply tool, so it is only ever deployed next to one that has.
  CHANNELS="discord,internal-inject" run channels_resolve
  [ "$status" -eq 0 ]
  [ "${lines[0]}" = "discord" ]
  [ "${lines[1]}" = "internal-inject" ]
  [ "${#lines[@]}" -eq 2 ]
}
@test "only the IM channels count as a platform" {
  # The launcher loads exactly ONE platform per scope (the one its scope-id
  # names); the rest are service channels only the bootstrap scope carries.
  # Getting internal-inject onto the platform side of that line would drop it
  # from every scope, including the bootstrap one — 7844 unbound and the
  # watchdog restarting the agent forever.
  channels_is_platform telegram
  channels_is_platform discord
  ! channels_is_platform internal-inject
  ! channels_is_platform some-future-channel
}
@test "channel_inject_port is empty for a channel with no inject endpoint" {
  run channel_inject_port some-future-channel
  [ "$status" -eq 0 ]
  [ -z "$output" ]
}
@test "no default port is shared between the inject and poller domains" {
  # Two things binding one number is the failure that never announces itself: the
  # second one just does not come up. The poller ports sit a decade above the
  # inject ones for exactly that reason.
  run bash -c 'source '"${BATS_TEST_DIRNAME}"'/../../lib-channels.sh
    for c in "${KNOWN_CHANNELS[@]}"; do channel_inject_port "$c"; echo; channel_poller_port "$c"; echo; done | grep .'
  [ "$(printf '%s\n' "$output" | sort | uniq -d)" = "" ]
}
