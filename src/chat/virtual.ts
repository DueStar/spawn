/**
 * The chat view's virtual list, as arithmetic (src/components/chat/ChatList.tsx draws it):
 * which rows to render for a scroll position, how far to move the scroll when rows arrive
 * above, and whether the view is at the bottom. A row not measured yet counts as `estimate`.
 */

export interface Range { start: number; end: number; padTop: number; padBottom: number }

/** The rows [start, end) in view (with `overscan` px above and below), and the space before and after them */
export function visibleRange({ heights, estimate, scrollTop, viewport, overscan = 600 }: {
  heights: (number | undefined)[]; estimate: number; scrollTop: number; viewport: number; overscan?: number
}): Range {
  const n = heights.length
  if (!n) return { start: 0, end: 0, padTop: 0, padBottom: 0 }
  const top = scrollTop - overscan
  const bottom = scrollTop + viewport + overscan
  let y = 0
  let start = n
  let padTop = 0
  for (let i = 0; i < n; i++) {
    const h = heights[i] ?? estimate
    if (y + h > top) { start = i; padTop = y; break }
    y += h
  }
  if (start === n) { // scrolled past the end: the last row
    start = n - 1
    padTop = y - (heights[n - 1] ?? estimate)
    y = padTop
  }
  let end = start
  while (end < n && y < bottom) { y += heights[end] ?? estimate; end++ }
  if (end === start) end = start + 1
  let rest = 0
  for (let i = end; i < n; i++) rest += heights[i] ?? estimate
  return { start, end, padTop, padBottom: rest }
}

const sum = (hs: number[], to: number) => { let s = 0; for (let i = 0; i < to && i < hs.length; i++) s += hs[i]; return s }

/**
 * How far to move the scroll when `added` rows arrive above, so the row that was first in
 * view (index `anchor` in the old list) stays where it was: its offset in the new list less
 * its offset in the old one.
 */
export function prependAnchor(oldHeights: number[], newHeights: number[], added: number, anchor = 0): number {
  return sum(newHeights, anchor + added) - sum(oldHeights, anchor)
}

/**
 * A per-row map (the list's measured heights, its ref callbacks) kept the size of the rows: once it holds more than
 * `slack` keys beyond the rows, every key that is neither a row now nor mounted (`keep`) goes. A streaming bubble's
 * `live:<id>` key and every row a reload or a density change dropped go with them (so an all-day
 * session never grows it without bound). Returns how many went.
 */
export function pruneToRows<V>(map: Map<string, V>, rows: readonly { key: string }[], keep: { has(key: string): boolean }, slack = 64): number {
  if (map.size <= rows.length + slack) return 0
  const keys = new Set(rows.map(r => r.key))
  let n = 0
  for (const k of [...map.keys()]) if (!keys.has(k) && !keep.has(k)) { map.delete(k); n++ }
  return n
}

/** The view is at the bottom: no more than `slack` px left below */
export function atBottom(scrollTop: number, scrollHeight: number, clientHeight: number, slack = 160): boolean {
  return scrollHeight - scrollTop - clientHeight <= slack
}
