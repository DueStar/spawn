import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { dropSpot, placeTab } from '../src/paneDrop'

describe('dropSpot: where a session let go over the right side goes (the half of the pane under the pointer)', () => {
  it('one session shown: its left half puts the new one on the left, its right half on the right', () => {
    expect(dropSpot(0.2, [1])).toEqual({ pane: 0, side: 'left', at: 0, left: 0, width: 0.5 })
    expect(dropSpot(0.7, [1])).toEqual({ pane: 0, side: 'right', at: 1, left: 0.5, width: 0.5 })
  })
  it('panes of different widths: the half of the pane the pointer is over', () => {
    const fr = [0.25, 0.75]
    expect(dropSpot(0.1, fr)).toMatchObject({ pane: 0, side: 'left', at: 0, left: 0, width: 0.125 })
    expect(dropSpot(0.2, fr)).toMatchObject({ pane: 0, side: 'right', at: 1, left: 0.125, width: 0.125 })
    expect(dropSpot(0.5, fr)).toMatchObject({ pane: 1, side: 'left', at: 1, left: 0.25, width: 0.375 })
    expect(dropSpot(0.99, fr)).toMatchObject({ pane: 1, side: 'right', at: 2, left: 0.625, width: 0.375 })
  })
  it('past the edges: the nearest half', () => {
    expect(dropSpot(-0.1, [0.5, 0.5])).toMatchObject({ pane: 0, side: 'left', at: 0 })
    expect(dropSpot(1.2, [0.5, 0.5])).toMatchObject({ pane: 1, side: 'right', at: 2 })
  })
})

describe('placeTab: a session put at a place among the panes', () => {
  it('a new one goes in at that place', () => {
    expect(placeTab(['a', 'b'], 'c', 0)).toEqual({ tabs: ['c', 'a', 'b'], ok: true })
    expect(placeTab(['a', 'b'], 'c', 1)).toEqual({ tabs: ['a', 'c', 'b'], ok: true })
    expect(placeTab(['a'], 'c', 5)).toEqual({ tabs: ['a', 'c'], ok: true })
  })
  it('one already open moves there (a pane dragged by its head), its own place counted out', () => {
    expect(placeTab(['a', 'b', 'c'], 'a', 3)).toEqual({ tabs: ['b', 'c', 'a'], ok: true })
    expect(placeTab(['a', 'b', 'c'], 'c', 0)).toEqual({ tabs: ['c', 'a', 'b'], ok: true })
    expect(placeTab(['a', 'b', 'c'], 'b', 1)).toEqual({ tabs: ['a', 'b', 'c'], ok: true })
    expect(placeTab(['a', 'b', 'c'], 'b', 2)).toEqual({ tabs: ['a', 'b', 'c'], ok: true })
  })
  it('a fourth is refused (full)', () => {
    expect(placeTab(['a', 'b', 'c'], 'd', 1)).toEqual({ tabs: ['a', 'b', 'c'], ok: false, full: true })
  })
})

describe('the drop in the app', () => {
  const w = readFileSync(join(__dirname, '..', 'src/Widget.tsx'), 'utf8')
  it('shows the half where it would open, and opens it there; a pane dragged by its head moves; the folded rail drags too', () => {
    expect(w).toContain('dropSpot(')
    expect(w).toContain('placeTab(')
    expect(w).toContain('w-pane-drop')
    // the pane head takes a pointer drag
    expect(w).toMatch(/className=\{`w-pane-head[\s\S]{0,400}trackPointerDrag\(/)
    // the folded rail's sessions start the same drag as the list's rows
    expect(w).toMatch(/w-rail-session[\s\S]{0,600}onPointerDown=\{e => startRowDrag\(/)
  })
})

// 2026-11-23: a session not open yet, dragged from the left panel, goes into one of n + 1 even slots of the area
// (two open: left end, middle, right end, each a third), not into half of a pane
describe('addSpot: the slot a new session goes into', () => {
  it('one open: halves; two open: thirds (left end, middle, right end)', async () => {
    const { addSpot } = await import('../src/paneDrop')
    expect(addSpot(0.2, 1)).toEqual({ at: 0, left: 0, width: 0.5 })
    expect(addSpot(0.7, 1)).toEqual({ at: 1, left: 0.5, width: 0.5 })
    expect(addSpot(0.1, 2)).toMatchObject({ at: 0, left: 0 })
    expect(addSpot(0.5, 2)).toMatchObject({ at: 1 })
    expect(addSpot(0.9, 2)).toMatchObject({ at: 2 })
    expect(addSpot(0.5, 2).left).toBeCloseTo(1 / 3)
    expect(addSpot(0.5, 2).width).toBeCloseTo(1 / 3)
  })
  it('the pointer past either edge stays in the end slots; none open is one slot', async () => {
    const { addSpot } = await import('../src/paneDrop')
    expect(addSpot(-0.3, 2).at).toBe(0)
    expect(addSpot(1.4, 2).at).toBe(2)
    expect(addSpot(0.5, 0)).toEqual({ at: 0, left: 0, width: 1 })
  })
  it('the widget uses it for a session not open yet, and dropSpot (halves) for one moved', () => {
    const w = readFileSync(join(__dirname, '..', 'src', 'Widget.tsx'), 'utf8')
    expect(w).toMatch(/addSpot\(/)
  })
})
