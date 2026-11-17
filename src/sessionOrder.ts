/**
 * The left panel's order by what each session is doing (2026-11-17, the owner's call), when 자동 정렬 is on:
 *
 *   1. 확인 필요 (waiting on the user): always on top, the newest first
 *   2. working: below them, in the order they started working — one that starts goes to the end of the
 *      working ones, and those already working never change places
 *   3. resting: below the working ones, the one that came to rest most recently first
 *   4. ended: at the bottom
 *
 * Ties (the state each had when the app opened) keep the list's own order. Pure: the moods, the times each came
 * into its state and the base order in, the order out. The hook in Widget.tsx keeps the times.
 */

export type Bucket = 0 | 1 | 2 | 3

export interface OrderInput { id: string; mood: string; asking?: boolean }

export function bucketOf(r: OrderInput): Bucket {
  if (r.asking || r.mood === 'needs-you') return 0
  if (r.mood === 'working') return 1
  if (r.mood === 'ended') return 3
  return 2
}

/** `since`: when each id came into its bucket (0: before the app knew, the base order decides) */
export function statusOrder(rows: OrderInput[], since: ReadonlyMap<string, number>): string[] {
  const base = new Map(rows.map((r, i) => [r.id, i]))
  const keyed = rows.map(r => ({ id: r.id, b: bucketOf(r), at: since.get(r.id) ?? 0 }))
  keyed.sort((x, y) => {
    if (x.b !== y.b) return x.b - y.b
    // working: the earlier start first (a new one joins the end); 확인 필요 and resting: the latest first
    const byTime = x.b === 1 ? x.at - y.at : x.b === 3 ? 0 : y.at - x.at
    return byTime || base.get(x.id)! - base.get(y.id)!
  })
  return keyed.map(k => k.id)
}

/** The times each id came into its bucket, updated from this render's rows (a new bucket: now) */
export function nextSince(prev: ReadonlyMap<string, { b: Bucket; at: number }>, rows: OrderInput[], now: number): Map<string, { b: Bucket; at: number }> {
  const out = new Map<string, { b: Bucket; at: number }>()
  for (const r of rows) {
    const b = bucketOf(r)
    const was = prev.get(r.id)
    // (what was there when the app opened: as old as can be, so the list's own order holds; a session opened since
    // comes into its state now, as a change would)
    out.set(r.id, was && was.b === b ? was : { b, at: was || prev.size ? now : 0 })
  }
  return out
}
