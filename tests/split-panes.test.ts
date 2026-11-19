/**
 * The split view (src/splitPanes.ts): which open tabs are shown side by side, and where.
 */

import { describe, expect, it } from 'vitest'
import { MIN_PANE_W, paneBox, paneStyle, panesFor } from '../src/splitPanes'

describe('panesFor', () => {
  it('shows nothing split with fewer than two tabs', () => {
    expect(panesFor([], 'a', 2000)).toEqual([])
    expect(panesFor(['a'], 'a', 2000)).toEqual([])
  })

  it('shows every open tab side by side when the room holds them (up to three)', () => {
    expect(panesFor(['a', 'b'], 'a', 2 * MIN_PANE_W)).toEqual(['a', 'b'])
    expect(panesFor(['a', 'b', 'c'], 'b', 3 * MIN_PANE_W)).toEqual(['a', 'b', 'c'])
  })

  it('shows as many as fit, never narrower than MIN_PANE_W; the session in view keeps a pane', () => {
    expect(panesFor(['a', 'b', 'c'], 'a', 2 * MIN_PANE_W + 10)).toEqual(['a', 'b'])
    expect(panesFor(['a', 'b', 'c'], 'c', 2 * MIN_PANE_W + 10)).toEqual(['a', 'c'])
  })

  it('falls back to one session (the tab row) when two do not fit', () => {
    expect(panesFor(['a', 'b'], 'a', 2 * MIN_PANE_W - 1)).toEqual([])
  })
})

describe('paneBox / paneStyle', () => {
  it('splits the area evenly, left to right', () => {
    expect(paneBox(0, 2)).toEqual({ left: 0, width: 0.5 })
    expect(paneBox(1, 2)).toEqual({ left: 0.5, width: 0.5 })
    expect(paneStyle(2, 3)).toEqual({ left: '66.6667%', width: '33.3333%' })
  })
})
