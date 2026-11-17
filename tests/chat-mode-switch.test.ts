import { describe, expect, it } from 'vitest'
import { switchMode, MODE_LIMITS } from '../src/chat/modeSwitch'

const R = '─'.repeat(40)
const FOOT: Record<string, string> = {
  default: '  ⏸ manual mode on · ? for shortcuts',
  acceptEdits: '  ⏵⏵ accept edits on (shift+tab to cycle)',
  plan: '  ⏸ plan mode on (shift+tab to cycle)',
  auto: '  ⏵⏵ auto mode on (shift+tab to cycle)',
}
const screenOf = (mode: string) => ['x', R, '❯ ', R, '  Opus 5.5 · ctx 3%', FOOT[mode]].join('\n')

/** A terminal whose Shift+Tab steps through `cycle`, drawing the next mode after `lag` reads */
function term(cycle: string[], start: string, lag = 1) {
  let at = cycle.indexOf(start)
  let pending = 0
  let presses = 0
  return {
    presses: () => presses,
    deps: {
      read: () => { if (pending > 0 && --pending === 0) at = (at + 1) % cycle.length; return screenOf(cycle[at]) },
      press: async () => { presses++; pending = lag; return true },
      sleep: async () => {},
    },
  }
}

describe('the chat\'s mode menu: Shift+Tab until the footer shows the mode', () => {
  it('steps to the chosen mode', async () => {
    const t = term(['default', 'acceptEdits', 'plan'], 'default')
    expect(await switchMode('plan', t.deps)).toEqual({ ok: true, mode: 'plan' })
    expect(t.presses()).toBe(2)
  })
  it('already there: nothing pressed', async () => {
    const t = term(['default', 'acceptEdits', 'plan'], 'plan')
    expect(await switchMode('plan', t.deps)).toEqual({ ok: true, mode: 'plan' })
    expect(t.presses()).toBe(0)
  })
  it('a mode not in the cycle: back where it started, said so', async () => {
    const t = term(['default', 'acceptEdits', 'plan'], 'acceptEdits')
    expect(await switchMode('auto', t.deps)).toEqual({ ok: false, reason: 'unreachable', mode: 'acceptEdits' })
    expect(t.presses()).toBe(3)
  })
  it('the footer redrawn a few reads late is waited for', async () => {
    const t = term(['default', 'acceptEdits', 'plan', 'auto'], 'default', 4)
    expect(await switchMode('auto', t.deps)).toEqual({ ok: true, mode: 'auto' })
  })
  it('a footer that never changes, or cannot be read: stops, nothing more pressed', async () => {
    let presses = 0
    const still = { read: () => screenOf('default'), press: async () => { presses++; return true }, sleep: async () => {} }
    expect(await switchMode('plan', still)).toEqual({ ok: false, reason: 'screen', mode: 'default' })
    expect(presses).toBe(1)
    const none = { read: () => null, press: async () => true, sleep: async () => {} }
    expect(await switchMode('plan', none)).toEqual({ ok: false, reason: 'screen', mode: null })
    expect(MODE_LIMITS.presses).toBeGreaterThanOrEqual(5)
  })
})
