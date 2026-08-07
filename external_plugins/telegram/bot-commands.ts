/**
 * Bot command menu, shared by poller.ts (decoupled mode) and server.ts (builtin
 * mode). Both call setMyCommands with this list.
 *
 * A single source keeps the two modes from drifting: a duplicated inline array
 * in each file would "work" until someone edits one copy, at which point the two
 * poll paths advertise different command menus depending on the host platform.
 */
import type { BotCommand } from 'grammy/types'
import { CONTROL_COMMANDS, type ControlCommand } from './control-plane'

/** Command menu shown in Telegram's UI, set via setMyCommands on startup. */
export const BOT_COMMANDS: readonly BotCommand[] = [
  { command: 'start', description: 'Welcome and setup guide' },
  { command: 'help', description: 'What this bot can do' },
  { command: 'status', description: 'Check your pairing status' },
  { command: 'ctx', description: 'Show context usage' },
  { command: 'clear', description: 'Clear the agent context' },
  { command: 'restart', description: 'Restart the agent' },
]

/**
 * The menu with control commands the bot layer no longer handles removed.
 *
 * A control command that has been handed to the agent must not stay advertised
 * here: Telegram's menu would still describe the bot-layer behaviour ("Clear
 * the agent context") for something the bot no longer does.
 *
 * @param enabled - Control commands the bot layer still intercepts.
 * @returns The filtered command menu.
 */
export function buildBotCommands(enabled: readonly ControlCommand[]): readonly BotCommand[] {
  return BOT_COMMANDS.filter(
    entry =>
      !(CONTROL_COMMANDS as readonly string[]).includes(entry.command) ||
      (enabled as readonly string[]).includes(entry.command),
  )
}
