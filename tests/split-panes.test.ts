/**
 * The split view (src/splitPanes.ts): which open tabs are shown side by side, and where.
 */

import { describe, expect, it } from 'vitest'
import { evenFracs, fracsFor, MIN_PANE_W, moveEdge, paneBox, paneStyle, panesFor } from '../src/splitPanes'

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

describe('the panes\' widths (dragged edges, 2026-11-19)', () => {
  it('keeps widths only when they fit the pane count', () => {
    expect(fracsFor([0.6, 0.4], 2)).toEqual([0.6, 0.4])
    expect(fracsFor([0.6, 0.4], 3)).toEqual(evenFracs(3))
    expect(fracsFor([0.6, 0.5], 2)).toEqual([0.5, 0.5])
    expect(fracsFor('x', 2)).toEqual([0.5, 0.5])
  })

  it('moves one edge, the two panes beside it give and take, none narrower than min', () => {
    expect(moveEdge([0.5, 0.5], 0, 0.7, 0.2)).toEqual([0.7, 0.30000000000000004])
    expect(moveEdge([0.5, 0.5], 0, 0.95, 0.2)[0]).toBeCloseTo(0.8)
    const three = moveEdge([1 / 3, 1 / 3, 1 / 3], 1, 0.9, 0.2)
    expect(three[0]).toBeCloseTo(1 / 3)
    expect(three[1]).toBeCloseTo(0.8 - 1 / 3)
    expect(three[2]).toBeCloseTo(0.2)
    expect(three.reduce((a, b) => a + b, 0)).toBeCloseTo(1)
  })

  it('places panes by the widths', () => {
    expect(paneStyle(1, 2, [0.6, 0.4])).toEqual({ left: '60.0000%', width: '40.0000%' })
  })
})
