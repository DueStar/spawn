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
