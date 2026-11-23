import { describe, expect, it } from 'vitest'
import { closeTab, MAX_TABS, openTab, pruneTabs, showIn } from '../src/sessionTabs'

describe('the session tabs', () => {
  it('a session chosen in the list takes the tab in view; one already open is just shown', () => {
    expect(showIn([], null, 'a')).toEqual(['a'])
    expect(showIn(['a', 'b'], 'b', 'c')).toEqual(['a', 'c'])
    expect(showIn(['a', 'b'], 'a', 'b')).toEqual(['a', 'b'])
    expect(showIn(['a', 'b'], 'gone', 'c')).toEqual(['a', 'c'])
  })
  it('a dropped session opens a tab of its own, up to three', () => {
    expect(MAX_TABS).toBe(3)
    expect(openTab(['a'], 'b')).toEqual({ tabs: ['a', 'b'], ok: true })
    expect(openTab(['a', 'b'], 'a')).toEqual({ tabs: ['a', 'b'], ok: true })
    expect(openTab(['a', 'b', 'c'], 'd')).toEqual({ tabs: ['a', 'b', 'c'], ok: false, full: true })
  })
  it('closing the tab in view shows its right neighbour, else its left', () => {
    expect(closeTab(['a', 'b', 'c'], 'b', 'b')).toEqual({ tabs: ['a', 'c'], next: 'c' })
    expect(closeTab(['a', 'b', 'c'], 'c', 'c')).toEqual({ tabs: ['a', 'b'], next: 'b' })
    expect(closeTab(['a', 'b'], 'a', 'b')).toEqual({ tabs: ['a'], next: null })
    expect(closeTab(['a'], 'a', 'a')).toEqual({ tabs: [], next: null })
  })
  it('ended sessions leave; the same list when nothing changed', () => {
    const tabs = ['a', 'b']
    expect(pruneTabs(tabs, new Set(['a', 'b', 'c']))).toBe(tabs)
    expect(pruneTabs(['a', 'b', 'c'], new Set(['a', 'c']))).toEqual(['a', 'c'])
  })
})

// 2026-11-23: a session chosen in the left list that is not open is added beside the others when the room
// still gives every pane its least width; only when it would not fit does it take the place of the one in view
describe('showIn with room: added, not swapped', () => {
  it('added at the right end while it fits and fewer than three are open', () => {
    expect(showIn(['a'], 'a', 'b', true)).toEqual(['a', 'b'])
    expect(showIn(['a', 'b'], 'a', 'c', true)).toEqual(['a', 'b', 'c'])
  })
  it('three open, or no room: swapped into the tab in view, as before', () => {
    expect(showIn(['a', 'b', 'c'], 'b', 'd', true)).toEqual(['a', 'd', 'c'])
    expect(showIn(['a', 'b'], 'b', 'c', false)).toEqual(['a', 'c'])
    expect(showIn(['a', 'b'], 'a', 'b', true)).toEqual(['a', 'b'])
  })
})
describe('only a click in the list or the rail adds a pane', () => {
  it('the widget marks those clicks (addPane) and the shown-session effect reads the mark for that session only', () => {
    const w = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'src', 'Widget.tsx'), 'utf8')
    expect(w).toMatch(/const add = addPane\.current === lensSid; addPane\.current = null/)
    expect(w.match(/addPane\.current = (r\.sessionId|expanded \? r\.sessionId : null)/g)?.length).toBe(2)
  })
})
