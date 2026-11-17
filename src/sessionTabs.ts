/**
 * The session tabs over the right side (2026-11-17, the owner's ask: up to three, a session dragged from the left list
 * opens in one). Pure: the tabs are session ids in order; which one is shown is the app's `target`.
 *
 *   show    a session chosen in the left list: shown in the tab in view (its tab already open: that one)
 *   open    a session dropped on the right side (or Ctrl+clicked): a tab of its own, while there are fewer than three
 *   close   a tab's ×: the tab goes (the session goes on); the one next to it is shown
 *   prune   sessions that ended leave their tabs
 */

export const MAX_TABS = 3

/** The tabs once `sid` is shown, `active` being the tab in view before */
export function showIn(tabs: string[], active: string | null | undefined, sid: string): string[] {
  if (tabs.includes(sid)) return tabs
  if (!tabs.length) return [sid]
  const at = active ? tabs.indexOf(active) : -1
  const i = at >= 0 ? at : tabs.length - 1
  return tabs.map((t, k) => (k === i ? sid : t))
}

/** A tab of its own for `sid`: `full` when three are open already */
export function openTab(tabs: string[], sid: string): { tabs: string[]; ok: boolean; full?: true } {
  if (tabs.includes(sid)) return { tabs, ok: true }
  if (tabs.length >= MAX_TABS) return { tabs, ok: false, full: true }
  return { tabs: [...tabs, sid], ok: true }
}

/** Without `sid`'s tab; `next`: the tab to show when it was the one in view (its right neighbour, else its left) */
export function closeTab(tabs: string[], active: string | null | undefined, sid: string): { tabs: string[]; next: string | null } {
  const i = tabs.indexOf(sid)
  if (i < 0) return { tabs, next: null }
  const rest = tabs.filter(t => t !== sid)
  if (sid !== active) return { tabs: rest, next: null }
  return { tabs: rest, next: rest[Math.min(i, rest.length - 1)] ?? null }
}

/** Only the tabs of sessions still there (at most three) */
export function pruneTabs(tabs: string[], alive: ReadonlySet<string>): string[] {
  const kept = tabs.filter(t => alive.has(t)).slice(0, MAX_TABS)
  return kept.length === tabs.length && kept.every((t, i) => t === tabs[i]) ? tabs : kept
}
