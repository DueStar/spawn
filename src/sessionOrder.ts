/**
 * The left panel's order by what each session is doing (2026-11-17, the owner's call), when 자동 정렬 is on:
 *
 *   1. 확인 필요 (waiting on the user): always on top
 *   2. working: below them
 *   3. resting: below the working ones
 *   4. ended: at the bottom
 *
 * (2026-11-19, the owner: "the session I used last always on top") inside each group the session the user last
 * used — showed, picked or typed in, not merely the one Claude last touched — comes first, newest first. Sessions
 * not used since that record began follow, by the 1.7.0 rule: 확인 필요 the newest first, working in the order they
 * started, resting the latest to rest first. Ties keep the list's own order.
 *
 * 직접 정렬 (자동 정렬 off): the order the user dragged, kept per PC; a session not in it yet goes on top.
 *
 * Pure: the moods, the times and the saved order in, the order out. Widget.tsx keeps the times and the stores.
 */

export type Bucket = 0 | 1 | 2 | 3

export interface OrderInput { id: string; mood: string; asking?: boolean }

export function bucketOf(r: OrderInput): Bucket {
  if (r.asking || r.mood === 'needs-you') return 0
  if (r.mood === 'working') return 1
  if (r.mood === 'ended') return 3
  return 2
}

/**
 * `since`: when each id came into its bucket (0: before the app knew, the base order decides);
 * `used`: when the user last used each id (none: not used, after the used ones)
 */
export function statusOrder(rows: OrderInput[], since: ReadonlyMap<string, number>, used: ReadonlyMap<string, number> = new Map()): string[] {
  const base = new Map(rows.map((r, i) => [r.id, i]))
  const keyed = rows.map(r => ({ id: r.id, b: bucketOf(r), at: since.get(r.id) ?? 0, u: used.get(r.id) ?? 0 }))
  keyed.sort((x, y) => {
    if (x.b !== y.b) return x.b - y.b
    if (x.u !== y.u) return y.u - x.u
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

// ---------------------------------------------------------------- last used, 직접 정렬

/** How many ids the two stores keep (the newest; the list never holds more than a few dozen) */
export const ORDER_CAP = 64
export const USED_KEY = 'spawn-list-used'
export const MANUAL_KEY = 'spawn-list-order'

type Store = Pick<Storage, 'getItem'> | null | undefined

/** The saved last-used times ({ id: ms }), anything odd dropped */
export function readUsed(store: Store): Map<string, number> {
  try {
    const v = JSON.parse(store?.getItem(USED_KEY) || '{}')
    if (!v || typeof v !== 'object' || Array.isArray(v)) return new Map()
    return new Map(Object.entries(v).filter((e): e is [string, number] => typeof e[1] === 'number' && Number.isFinite(e[1])))
  } catch { return new Map() }
}

/** `id` used at `now`: a new map with the newest ORDER_CAP */
export function markUsed(used: ReadonlyMap<string, number>, id: string, now: number): Map<string, number> {
  const next = new Map(used)
  next.set(id, now)
  return next.size <= ORDER_CAP ? next : new Map([...next].sort((a, b) => b[1] - a[1]).slice(0, ORDER_CAP))
}

/** The saved 직접 정렬 order; null: none saved yet (the list's own order then) */
export function readManual(store: Store): string[] | null {
  try {
    const v = JSON.parse(store?.getItem(MANUAL_KEY) || 'null')
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').slice(0, ORDER_CAP) : null
  } catch { return null }
}

/** 직접 정렬: the saved order of the ids open now; a session not in it goes on top (in the list's own order) */
export function manualOrder(ids: readonly string[], saved: readonly string[] | null): string[] {
  if (!saved) return [...ids]
  const have = new Set(ids)
  const known = new Set(saved)
  return [...ids.filter(id => !known.has(id)), ...saved.filter(id => have.has(id))]
}

/**
 * What to save for the order shown: it, then the saved ids not open now (a session still reopening at the start,
 * or one closed that may come back) in their saved order, at most ORDER_CAP
 */
export function keepOrder(shown: readonly string[], saved: readonly string[] | null): string[] {
  const on = new Set(shown)
  return [...shown, ...(saved ?? []).filter(id => !on.has(id))].slice(0, ORDER_CAP)
}

/** `id` put before the row at `slot` (0..n in `order` as it is; n: the end). The same array when it stays put */
export function moveTo(order: readonly string[], id: string, slot: number): readonly string[] {
  const from = order.indexOf(id)
  if (from < 0) return order
  const at = Math.max(0, Math.min(order.length, Math.round(slot)))
  if (at === from || at === from + 1) return order
  const next = order.filter(x => x !== id)
  next.splice(at > from ? at - 1 : at, 0, id)
  return next
}

/** Where a row dragged to `y` goes: before the first row whose middle is below it (`mids`: each row's middle, top down) */
export function dropSlot(mids: readonly number[], y: number): number {
  let slot = 0
  for (const m of mids) if (m < y) slot++
  return slot
}
