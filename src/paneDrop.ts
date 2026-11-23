/**
 * Where a session let go over the right side goes. The pane under the pointer is cut in two: over its left
 * half the session opens (or, a pane dragged by its head, moves) to that pane's left, over its right half to its
 * right. Pure: the pointer as a fraction of the area, the panes' widths as fractions (one session shown: [1]).
 *
 *   dropSpot   the pane and half under the pointer, the place among the panes it stands for (`at`), and the
 *              half's box (left, width) to draw
 *   placeTab   the tabs with `sid` at that place (a new one in, one open already moved; never a fourth)
 */

import { MAX_TABS } from './sessionTabs'

export type DropSpot = { pane: number; side: 'left' | 'right'; at: number; left: number; width: number }

export function dropSpot(x: number, fracs: readonly number[]): DropSpot {
  const n = Math.max(1, fracs.length)
  let left = 0
  for (let i = 0; i < n; i++) {
    const w = fracs[i] ?? 1 / n
    if (x < left + w || i === n - 1) {
      const right = x >= left + w / 2
      return right
        ? { pane: i, side: 'right', at: i + 1, left: left + w / 2, width: w / 2 }
        : { pane: i, side: 'left', at: i, left, width: w / 2 }
    }
    left += w
  }
  return { pane: 0, side: 'left', at: 0, left: 0, width: (fracs[0] ?? 1) / 2 }
}

export function placeTab(tabs: readonly string[], sid: string, at: number): { tabs: string[]; ok: boolean; full?: true } {
  const from = tabs.indexOf(sid)
  if (from < 0 && tabs.length >= MAX_TABS) return { tabs: [...tabs], ok: false, full: true }
  const rest = tabs.filter(t => t !== sid)
  // (its own place counted out: dropped right after itself, it stays)
  const to = Math.max(0, Math.min(rest.length, from >= 0 && from < at ? at - 1 : at))
  return { tabs: [...rest.slice(0, to), sid, ...rest.slice(to)], ok: true }
}
