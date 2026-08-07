import { describe, expect, test } from 'bun:test'
import { BOT_COMMANDS, buildBotCommands } from './bot-commands'
import { CONTROL_COMMANDS } from './control-plane'

const names = (list: readonly { command: string }[]): string[] => list.map(c => c.command)

describe('buildBotCommands', () => {
  test('keeps the full menu when every control command is enabled', () => {
    expect(buildBotCommands(CONTROL_COMMANDS)).toEqual(BOT_COMMANDS)
  })

  test('drops control commands handed to the agent', () => {
    expect(names(buildBotCommands(['ctx']))).toEqual(['start', 'help', 'status', 'ctx'])
  })

  test('never drops non-control commands', () => {
    expect(names(buildBotCommands([]))).toEqual(['start', 'help', 'status'])
  })
})
