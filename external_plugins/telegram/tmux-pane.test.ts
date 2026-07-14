import { describe, expect, test } from 'bun:test'
import { BUSY_MARKER, capturePaneBusy, isPaneBusy } from './tmux-pane'

const IDLE_PANE = [
  '❯ ',
  '⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents',
].join('\n')

const BUSY_PANE = [
  '❯ ',
  '✻ Working… (12s · ↑ 3.4k tokens · esc to interrupt)',
].join('\n')

describe('isPaneBusy', () => {
  test('detects busy when the marker is present', () => {
    expect(isPaneBusy(BUSY_PANE)).toBe(true)
  })

  test('detects idle when the marker is absent', () => {
    expect(isPaneBusy(IDLE_PANE)).toBe(false)
  })

  test('treats empty capture as idle', () => {
    expect(isPaneBusy('')).toBe(false)
  })

  test('ignores the marker outside the footer region (false-positive guard)', () => {
    // Agent output echoing the literal marker, then 5+ idle footer lines below.
    const pane = [
      'user pasted: run with "esc to interrupt" disabled',
      'line 1',
      'line 2',
      'line 3',
      'line 4',
      '❯ ',
    ].join('\n')
    expect(isPaneBusy(pane)).toBe(false)
  })

  test('BUSY_MARKER is the documented substring', () => {
    expect(BUSY_MARKER).toBe('esc to interrupt')
  })
})

describe('capturePaneBusy', () => {
  test('capture failure is treated as idle (fail-open)', async () => {
    // Non-existent tmux target -> execFile rejects -> caught -> false.
    expect(await capturePaneBusy('definitely-no-such-session:0')).toBe(false)
  })
})
