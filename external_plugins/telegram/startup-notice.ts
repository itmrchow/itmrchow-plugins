/**
 * Startup notice after an agent restart (JP-38).
 *
 * Flow:
 *   1. restart-agent writes a marker + plugin-version snapshot into the shared
 *      restart state dir right before it kills/restarts the agent.
 *   2. When a bot server boots, it checks the marker; if present it messages
 *      the paired owner(s) "the agent is back", listing the plugin versions
 *      now loaded and flagging any that changed across the restart
 *      (e.g. `discord@itmrchow-plugins 0.0.7 -> 0.0.8`).
 *   3. The marker is claimed atomically (rename) before sending, so a boot
 *      race between the telegram and discord servers yields exactly ONE
 *      notice to the owner, never one per channel and never a repeat on the
 *      next ordinary boot.
 *
 * Messages are plain text: no markdown, no emoji (IM clients don't render
 * markdown in default mode).
 */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * Shared restart state directory — same location restart-agent uses for its
 * lockfile/counter. Re-derived here (same env override, same default) instead
 * of imported from restart-agent to avoid a circular import: restart-agent
 * imports the marker writer from this module.
 */
const RESTART_STATE_DIR =
  process.env.AGENT_RESTART_STATE_DIR ?? join(homedir(), '.claude', 'agent-restart')

/** Marker file signalling "a bot-initiated restart just happened". */
const MARKER_FILE = join(RESTART_STATE_DIR, 'restart-notice.json')

/** Claude's installed-plugins registry (version + git sha per plugin). */
const INSTALLED_PLUGINS_FILE =
  process.env.CLAUDE_INSTALLED_PLUGINS_FILE ??
  join(homedir(), '.claude', 'plugins', 'installed_plugins.json')

/** Version info for one installed plugin. */
export type PluginVersion = { version: string; sha: string }

/** Map of plugin key (`name@marketplace`) to its installed version. */
export type PluginSnapshot = Record<string, PluginVersion>

/** Marker payload written before a restart and consumed on the next boot. */
export type RestartMarker = { ts: number; reason: string; plugins: PluginSnapshot }

/** Shape of installed_plugins.json (version 2) — one entry array per plugin. */
type InstalledPluginsFile = {
  plugins?: Record<string, Array<{ version?: string; gitCommitSha?: string }>>
}

/**
 * Parse the raw contents of installed_plugins.json into a PluginSnapshot.
 *
 * Pure (no IO) so the format handling is unit-testable. Tolerant: corrupt
 * JSON, a missing `plugins` map, or malformed entries degrade to an empty /
 * partial snapshot — a version list is a nicety, never worth failing a boot
 * notice over.
 *
 * Args:
 *   raw: file contents of installed_plugins.json.
 * Returns:
 *   Snapshot of plugin key -> {version, sha}; empty object on unparsable input.
 */
export function parseInstalledPlugins(raw: string): PluginSnapshot {
  let parsed: InstalledPluginsFile
  try {
    parsed = JSON.parse(raw) as InstalledPluginsFile
  } catch {
    return {}
  }
  if (typeof parsed?.plugins !== 'object' || parsed.plugins === null) return {}

  const snapshot: PluginSnapshot = {}
  for (const [key, entries] of Object.entries(parsed.plugins)) {
    const first = Array.isArray(entries) ? entries[0] : undefined
    if (!first || typeof first.version !== 'string') continue
    snapshot[key] = { version: first.version, sha: first.gitCommitSha ?? '' }
  }
  return snapshot
}

/**
 * Read the current plugin versions from Claude's installed-plugins registry.
 *
 * Args:
 *   path: registry file path. Defaults to INSTALLED_PLUGINS_FILE.
 * Returns:
 *   Current PluginSnapshot; empty object when the file is missing/unreadable.
 */
export function readInstalledPlugins(path: string = INSTALLED_PLUGINS_FILE): PluginSnapshot {
  try {
    return parseInstalledPlugins(readFileSync(path, 'utf8'))
  } catch {
    return {}
  }
}

/**
 * Write the restart marker + plugin snapshot. Called by restart-agent right
 * before it performs a restart, so the next bot boot knows to announce.
 *
 * Args:
 *   reason: human-readable restart trigger (mirrors restartAgent's reason).
 *   nowMs: current time in ms. Defaults to Date.now().
 *   plugins: plugin snapshot to embed. Defaults to the live registry read.
 *   dir: state directory override (tests). Defaults to RESTART_STATE_DIR.
 * Returns:
 *   None. Never throws — a failed marker write must not block the restart.
 */
export function writeRestartMarker(
  reason: string,
  nowMs: number = Date.now(),
  plugins: PluginSnapshot = readInstalledPlugins(),
  dir: string = RESTART_STATE_DIR,
): void {
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    const marker: RestartMarker = { ts: nowMs, reason, plugins }
    writeFileSync(join(dir, 'restart-notice.json'), JSON.stringify(marker), { mode: 0o600 })
  } catch (err) {
    process.stderr.write(`startup-notice: marker write failed (notice skipped): ${err}\n`)
  }
}

/**
 * Remove the restart marker without consuming it (restart failed — the agent
 * never went down, so announcing "I'm back" next boot would be a lie).
 *
 * Args:
 *   dir: state directory override (tests). Defaults to RESTART_STATE_DIR.
 * Returns:
 *   None.
 */
export function clearRestartMarker(dir: string = RESTART_STATE_DIR): void {
  rmSync(join(dir, 'restart-notice.json'), { force: true })
}

/**
 * Atomically claim and consume the restart marker.
 *
 * rename() is atomic on POSIX, so when telegram and discord boot concurrently
 * exactly one claim succeeds; the loser sees ENOENT and stays silent. The
 * claimed file is deleted after reading, so the notice can never repeat.
 *
 * Args:
 *   dir: state directory override (tests). Defaults to RESTART_STATE_DIR.
 * Returns:
 *   The marker, or null when there is no marker / it was already claimed /
 *   its contents are unreadable.
 */
export function claimRestartMarker(dir: string = RESTART_STATE_DIR): RestartMarker | null {
  const marker = join(dir, 'restart-notice.json')
  const claimed = marker + '.claimed'
  if (!existsSync(marker)) return null
  try {
    renameSync(marker, claimed)
  } catch {
    return null // lost the claim race
  }
  try {
    const parsed = JSON.parse(readFileSync(claimed, 'utf8')) as Partial<RestartMarker>
    if (typeof parsed.ts !== 'number') return null
    return {
      ts: parsed.ts,
      reason: typeof parsed.reason === 'string' ? parsed.reason : '',
      plugins: typeof parsed.plugins === 'object' && parsed.plugins !== null ? parsed.plugins : {},
    }
  } catch {
    return null
  } finally {
    rmSync(claimed, { force: true })
  }
}

/**
 * Build the plain-text "the agent is back" notice with a plugin version list.
 *
 * Pure formatter (unit-testable). Compares the pre-restart snapshot against
 * the currently loaded versions and annotates differences:
 *   - version changed:            `discord@m 0.0.7 -> 0.0.8`
 *   - same version, new git sha:  `discord@m 0.0.7 (updated)`
 *   - newly installed:            `foo@m 1.0.0 (new)`
 *   - removed since snapshot:     `bar@m 0.2.0 (removed)`
 * Plain text only — no markdown, no emoji.
 *
 * Args:
 *   snapshot: plugin versions captured before the restart.
 *   current: plugin versions loaded now.
 * Returns:
 *   The full notice message.
 */
export function buildStartupNotice(snapshot: PluginSnapshot, current: PluginSnapshot): string {
  const lines = ['回來了，agent 重啟完成。']

  const keys = Object.keys(current).sort()
  if (keys.length > 0) lines.push('plugin 版本：')
  for (const key of keys) {
    const cur = current[key]
    const prev = snapshot[key]
    if (!prev) {
      lines.push(`${key} ${cur.version} (new)`)
    } else if (prev.version !== cur.version) {
      lines.push(`${key} ${prev.version} -> ${cur.version}`)
    } else if (prev.sha !== cur.sha) {
      lines.push(`${key} ${cur.version} (updated)`)
    } else {
      lines.push(`${key} ${cur.version}`)
    }
  }

  for (const key of Object.keys(snapshot).sort()) {
    if (!(key in current)) lines.push(`${key} ${snapshot[key].version} (removed)`)
  }

  return lines.join('\n')
}

/**
 * One-call boot hook: claim the marker and, if this server won the claim,
 * return the ready-to-send notice text.
 *
 * Args:
 *   dir: state directory override (tests). Defaults to RESTART_STATE_DIR.
 *   currentPlugins: currently loaded plugin versions. Defaults to the live
 *     registry read.
 * Returns:
 *   The notice text, or null when there is nothing to announce.
 */
export function consumeStartupNotice(
  dir: string = RESTART_STATE_DIR,
  currentPlugins: PluginSnapshot = readInstalledPlugins(),
): string | null {
  const marker = claimRestartMarker(dir)
  if (marker === null) return null
  return buildStartupNotice(marker.plugins, currentPlugins)
}
