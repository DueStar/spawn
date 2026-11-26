import { describe, it, expect } from 'vitest'
import { blankLine, type BlankState, type BlankDom } from '../src/blankWatch'

const S: BlankState = { view: 'terminal', mode: 'window', lensMode: 'chat', rows: 5, withTerminal: 3, targetHasTerm: true, shownHasTerm: true, split: false, panes: 0 }
const EMPTY: BlankDom = { headKids: 0, chatPanes: 0, liveTerms: 0, body: { w: 900.4, h: 700 }, topAt: 'div w-term-body' }

describe('blankLine', () => {
  it('says the state when sessions are open and nothing is drawn on the right', () => {
    const line = blankLine({ ...S, shownHasTerm: false }, EMPTY)!
    expect(line).toContain('shown has terminal false')
    expect(line).toContain('body 900x700')
    expect(line).toContain('top div w-term-body')
  })
  it('null when something is drawn, or nothing should be', () => {
    expect(blankLine(S, { ...EMPTY, headKids: 1 })).toBeNull()
    expect(blankLine(S, { ...EMPTY, chatPanes: 1 })).toBeNull()
    expect(blankLine(S, { ...EMPTY, liveTerms: 1 })).toBeNull()
    expect(blankLine({ ...S, view: 'dex' }, EMPTY)).toBeNull()
    expect(blankLine({ ...S, mode: 'widget' }, EMPTY)).toBeNull()
    expect(blankLine({ ...S, withTerminal: 0 }, EMPTY)).toBeNull()
  })
  it('no words from the page beyond a class name', () => {
    expect(blankLine(S, { ...EMPTY, topAt: 'div "my secret" /path' })).toContain('top div my secret path')
  })
})
