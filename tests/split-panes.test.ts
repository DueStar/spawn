/**
 * The split view (src/splitPanes.ts): which open tabs are shown side by side, and where.
 */

import { describe, expect, it } from 'vitest'
import { evenFracs, fracsFor, MIN_PANE_W, moveEdge, paneBox, paneStyle, panesFor, SNAP_PX, snapEdge } from '../src/splitPanes'

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

describe('the panes\' widths (dragged edges)', () => {
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

describe('snapEdge: a dragged edge catches on the even split (2026-11-27)', () => {
  it('two panes: within SNAP_PX of the half, the half; past it, where the pointer is', () => {
    expect(SNAP_PX).toBe(8)
    const w = 1000
    expect(snapEdge(0.505, 2, w)).toEqual({ at: 0.5, snapped: true })
    expect(snapEdge(0.492, 2, w)).toEqual({ at: 0.5, snapped: true })
    expect(snapEdge(0.509, 2, w)).toEqual({ at: 0.509, snapped: false })
  })
  it('three panes: a third and two thirds, for either edge', () => {
    const w = 1200
    expect(snapEdge(1 / 3 + 5 / w, 3, w)).toEqual({ at: 1 / 3, snapped: true })
    expect(snapEdge(2 / 3 - 7 / w, 3, w)).toEqual({ at: 2 / 3, snapped: true })
    expect(snapEdge(0.5, 3, w)).toEqual({ at: 0.5, snapped: false })
  })
  it('the range is pixels: a wider area catches a smaller fraction', () => {
    expect(snapEdge(0.505, 2, 2000).snapped).toBe(false)
    expect(snapEdge(0.505, 2, 1000).snapped).toBe(true)
  })
  it('one pane or no width: nothing to catch on', () => {
    expect(snapEdge(0.5, 1, 1000)).toEqual({ at: 0.5, snapped: false })
    expect(snapEdge(0.5, 2, 0)).toEqual({ at: 0.5, snapped: false })
  })
})

describe('PaneEdge uses snapEdge', () => {
  it('the edge passes the pane count and lights while caught', async () => {
    const { readFileSync } = await import('node:fs')
    const w = readFileSync(new URL('../src/Widget.tsx', import.meta.url), 'utf8')
    expect(w).toMatch(/snapEdge\(\(e\.clientX - b\.left\) \/ Math\.max\(1, b\.width\), panes, b\.width\)/)
    expect(w).toMatch(/<PaneEdge [^\n]*panes=\{paneSids\.length\}/)
    const css = readFileSync(new URL('../src/styles/widget-expanded.css', import.meta.url), 'utf8')
    expect(css).toMatch(/\.w-pane-edge\.snapped::after \{ background: var\(--ink-2\); \}/)
  })
})
