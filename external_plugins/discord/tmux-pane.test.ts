import { describe, expect, test } from 'bun:test'
import { BUSY_PATTERN, capturePaneBusy, isPaneBusy } from './tmux-pane'

/**
 * Auto-mode footer line, always present idle or busy (JP-79 always-busy trap).
 *
 * Contains the OLD marker 'esc to interrupt' but NOT 'tokens'. Auto mode shows
 * it permanently, so an idle-vs-busy probe MUST key off the parenthesised timer.
 */
const AUTO_MODE_FOOTER = '⏵⏵ auto mode on (shift+tab to cycle) · esc to interrupt'

const IDLE_PANE = [
  '❯ ',
  AUTO_MODE_FOOTER,
].join('\n')

// Generating footer: the live token-counter line that only appears mid-turn.
const BUSY_PANE = [
  '❯ ',
  '✶ Working… (6m 49s · ↓ 16.0k tokens)',
  AUTO_MODE_FOOTER,
].join('\n')

/**
 * Idle main session with a background agent status panel pinned in the footer.
 *
 * The panel line carries its own `tokens` counter with NO parenthesised timer.
 * This is the JP-84 second always-busy regression marker: a bare `tokens`
 * substring reads busy here forever; BUSY_PATTERN must read idle.
 */
const BG_AGENT_IDLE_PANE = [
  '❯ ',
  '◯ jeff-core:backend-dev  JP-83 wiring repo   13s · ↓ 45.3k tokens',
  AUTO_MODE_FOOTER,
].join('\n')

/** Generating spinner variant that also reports a thought timer. */
const BUSY_THOUGHT_PANE = [
  '❯ ',
  '· Working… (8s · ↓ 172 tokens · thought for 1s)',
  AUTO_MODE_FOOTER,
].join('\n')

describe('isPaneBusy', () => {
  test('detects busy on the main-generation spinner timer', () => {
    expect(isPaneBusy(BUSY_PANE)).toBe(true)
  })

  test('detects busy on the thought-timer spinner variant', () => {
    expect(isPaneBusy(BUSY_THOUGHT_PANE)).toBe(true)
  })

  test('detects idle on a pure idle footer (no spinner)', () => {
    expect(isPaneBusy(IDLE_PANE)).toBe(false)
  })

  test('background-agent panel token counter reads idle (JP-84 regression)', () => {
    // Main session is idle; a background agent panel pins its own `tokens`
    // counter with no parenthesised timer. A bare `tokens` substring read this
    // busy forever. BUSY_PATTERN must not match.
    expect(isPaneBusy(BG_AGENT_IDLE_PANE)).toBe(false)
  })

  test('JP-79 regression: auto-mode idle footer (has "esc to interrupt", no "tokens") is idle', () => {
    expect(IDLE_PANE).toContain('esc to interrupt')
    expect(IDLE_PANE).not.toContain('tokens')
    expect(isPaneBusy(IDLE_PANE)).toBe(false)
  })

  test('treats empty capture as idle', () => {
    expect(isPaneBusy('')).toBe(false)
  })

  test('ignores a spinner timer outside the footer region (false-positive guard)', () => {
    // Agent output echoing a spinner-shaped string, then 5+ idle footer lines below.
    const pane = [
      'user pasted a log line: Working… (12s · ↓ 3.4k tokens)',
      'line 1',
      'line 2',
      'line 3',
      'line 4',
      '❯ ',
    ].join('\n')
    expect(isPaneBusy(pane)).toBe(false)
  })

  test('does not stitch a stray opener to a tokens line across newlines', () => {
    // A `(12s` opener and a `tokens` word split across two footer lines must
    // NOT be joined into a match: isPaneBusy tests each line individually.
    const pane = [
      '❯ (12s elapsed since',
      'last run · 45.3k tokens streamed',
      AUTO_MODE_FOOTER,
    ].join('\n')
    expect(isPaneBusy(pane)).toBe(false)
  })

  test('BUSY_PATTERN matches only the parenthesised spinner timer', () => {
    expect(BUSY_PATTERN.test('(6m 49s · ↓ 16.0k tokens)')).toBe(true)
    expect(BUSY_PATTERN.test('◯ backend-dev  13s · ↓ 45.3k tokens')).toBe(false)
  })
})

describe('capturePaneBusy', () => {
  test('capture failure is treated as idle (fail-open)', async () => {
    // Non-existent tmux target -> execFile rejects -> caught -> false.
    expect(await capturePaneBusy('definitely-no-such-session:0')).toBe(false)
  })
})
