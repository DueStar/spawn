/**
 * The split view (2026-11-19, the owner: "not one tab at a time — two or three chats side by side"): the open session
 * tabs (src/sessionTabs.ts) shown at once, side by side, each pane with its own header, conversation and composer (or
 * its terminal). Pure: which sessions get a pane, and where each pane sits.
 *
 *   panesFor   the tabs that fit the room (a pane is never narrower than MIN_PANE_W); the session in view always has one
 *   paneBox    a pane's left edge and width, as fractions of the area
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

/** Pane `i` of `n`: its left edge and width as fractions (0–1) of the area */
export function paneBox(i: number, n: number): { left: number; width: number } {
  const w = 1 / Math.max(1, n)
  return { left: i * w, width: w }
}

/** A pane's box as CSS: `left` and `width` in % (for the chat pane and the terminal's host) */
export function paneStyle(i: number, n: number): { left: string; width: string } {
  const b = paneBox(i, n)
  return { left: `${(b.left * 100).toFixed(4)}%`, width: `${(b.width * 100).toFixed(4)}%` }
}
