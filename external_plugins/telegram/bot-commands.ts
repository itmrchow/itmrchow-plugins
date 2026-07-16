/**
 * Bot command menu, shared by poller.ts (decoupled mode) and server.ts (builtin
 * mode). Both call setMyCommands with this list.
 *
 * A single source keeps the two modes from drifting: a duplicated inline array
 * in each file would "work" until someone edits one copy, at which point the two
 * poll paths advertise different command menus depending on the host platform.
 */
import type { BotCommand } from 'grammy/types'

/** Command menu shown in Telegram's UI, set via setMyCommands on startup. */
export const BOT_COMMANDS: readonly BotCommand[] = [
  { command: 'start', description: 'Welcome and setup guide' },
  { command: 'help', description: 'What this bot can do' },
  { command: 'status', description: 'Check your pairing status' },
  { command: 'ctx', description: 'Show context usage' },
  { command: 'clear', description: 'Clear the agent context' },
  { command: 'restart', description: 'Restart the agent' },
]
