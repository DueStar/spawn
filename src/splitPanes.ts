/**
 * The split view (two or three chats side by side, not one tab at a time): the open session
 * tabs (src/sessionTabs.ts) shown at once, side by side, each pane with its own header, conversation and composer (or
 * its terminal). Pure: which sessions get a pane, and where each pane sits.
 *
 *   panesFor   the tabs that fit the room (a pane is never narrower than MIN_PANE_W); the session in view always has one
 *   paneBox    a pane's left edge and width, as fractions of the area (even, or the widths the user dragged)
 *   fracsFor   the widths kept for n panes (even when none were kept, or they no longer fit n)
 *   moveEdge   the widths once the edge after pane `edge` is dragged to `at` (a fraction of the area), no pane
 *              narrower than `min`
 */

import { MAX_TABS } from './sessionTabs'

/** The narrowest pane worth reading a conversation in (its composer and control row still fit) */
export const MIN_PANE_W = 360

/** The sessions shown side by side, in tab order: [] when there are fewer than two (one session: the usual view) */
export function panesFor(tabs: readonly string[], shown: string | null | undefined, room: number): string[] {
  const open = tabs.slice(0, MAX_TABS)
  if (open.length < 2) return []
  const fit = Math.max(1, Math.min(open.length, Math.floor(room / MIN_PANE_W)))
  if (fit < 2) return []
  let panes = open.slice(0, fit)
  // the session in view always keeps its pane: it takes the last one that fits
  if (shown && open.includes(shown) && !panes.includes(shown)) panes = [...panes.slice(0, fit - 1), shown]
  return panes
}

/** n even widths */
export function evenFracs(n: number): number[] {
  const k = Math.max(1, n)
  return Array.from({ length: k }, () => 1 / k)
}

/** The widths kept for n panes, when there are n of them, all positive and adding up to 1 (else even) */
export function fracsFor(saved: unknown, n: number): number[] {
  if (!Array.isArray(saved) || saved.length !== n || !saved.every(x => typeof x === 'number' && Number.isFinite(x) && x > 0)) return evenFracs(n)
  const sum = (saved as number[]).reduce((a, b) => a + b, 0)
  return Math.abs(sum - 1) < 0.001 ? (saved as number[]).slice() : evenFracs(n)
}

/** The widths once the edge between pane `edge` and pane `edge + 1` is at `at` (0–1 of the area); `min`: a pane's least */
export function moveEdge(fracs: readonly number[], edge: number, at: number, min: number): number[] {
  if (edge < 0 || edge >= fracs.length - 1) return fracs.slice()
  const start = fracs.slice(0, edge).reduce((a, b) => a + b, 0)
  const end = start + fracs[edge] + fracs[edge + 1]
  const lo = start + min, hi = end - min
  if (lo > hi) return fracs.slice()
  const b = Math.min(hi, Math.max(lo, at))
  const next = fracs.slice()
  next[edge] = b - start
  next[edge + 1] = end - b
  return next
}

/**
 * The widths for the room there is now: kept ones while every pane still gets MIN_PANE_W, else even (a window made
 * narrower, the left panel opened: a pane dragged narrow would fall under the least)
 */
export function fitFracs(fracs: readonly number[], room: number): number[] {
  return fracs.every(f => f * room >= MIN_PANE_W - 0.5) ? fracs.slice() : evenFracs(fracs.length)
}

/** Pane `i` of `n`: its left edge and width as fractions (0–1) of the area */
export function paneBox(i: number, n: number, fracs?: readonly number[]): { left: number; width: number } {
  const f = fracs && fracs.length === n ? fracs : evenFracs(n)
  return { left: f.slice(0, i).reduce((a, b) => a + b, 0), width: f[i] ?? 0 }
}

/** A pane's box as CSS: `left` and `width` in % (for the chat pane and the terminal's host) */
export function paneStyle(i: number, n: number, fracs?: readonly number[]): { left: string; width: string } {
  const b = paneBox(i, n, fracs)
  return { left: `${(b.left * 100).toFixed(4)}%`, width: `${(b.width * 100).toFixed(4)}%` }
}
