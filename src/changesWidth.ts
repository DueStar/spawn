/**
 * The 변경 사항 panel's width and room (the chat view, Phase 5): dragged by its left edge between
 * 260 and 560px (320 by default; 288 in a window under 1200 with nothing remembered, as the lab's
 * `tight`), remembered per PC in page storage, as the left panel's (src/sideWidth.ts). Double-click
 * the edge (or Home on it) for the default.
 *
 * The conversation keeps at least CONVO_FLOOR. While the left panel, the conversation (at CONVO_FIT)
 * and the open panel do not fit side by side, the left panel folds to the rail by itself (`autoFold`,
 * the lab's `narrow` at the default widths: 300 + 320 + 620 = 1240). That fold is derived, never
 * stored: closing the panel or widening the window brings the left panel back. A window too narrow
 * even folded has no panel (`canOpen`).
 */

export const CH_MIN = 260
export const CH_MAX = 560
export const CH_DEFAULT = 320
/** The default in a window under TIGHT_W with no remembered width */
export const CH_TIGHT = 288
export const TIGHT_W = 1200
export const CH_KEY = 'spawn-changes-w'
export const OPEN_KEY = 'spawn-changes-open'
/** The conversation's width the left panel folds for */
export const CONVO_FIT = 620
/** The conversation never gets less than this */
export const CONVO_FLOOR = 400
/** The folded left panel (--rail-w) */
export const RAIL_W = 56

/** A width the panel may take beside a conversation in `room` px: 260–560, the conversation keeping 400, never under 260 */
export function clampChangesWidth(px: number, room: number): number {
  return Math.round(Math.max(CH_MIN, Math.min(px, CH_MAX, room - CONVO_FLOOR)))
}

/** The panel's width before any clamp: the remembered one, else the default for this window */
export function changesWidthFor(remembered: number | null, winW: number): number {
  return remembered ?? (winW < TIGHT_W ? CH_TIGHT : CH_DEFAULT)
}

/** Whether the left panel shows as the rail for the open panel (derived on every render, never stored) */
export function autoFold({ winW, sideW, chW, open, chat, userHidden }: { winW: number; sideW: number; chW: number; open: boolean; chat: boolean; userHidden: boolean }): boolean {
  return chat && open && !userHidden && winW < sideW + chW + CONVO_FIT
}

/** Whether the panel can open at all: even with the left panel folded the conversation keeps 400 */
export function canOpen({ winW }: { winW: number }): boolean {
  return winW - RAIL_W - CH_MIN >= CONVO_FLOOR
}

/** The remembered width: a number 260–560, else nothing (the window's default then) */
export function readChangesWidth(store: Pick<Storage, 'getItem'> | null | undefined): number | null {
  try {
    const raw = store?.getItem(CH_KEY)
    if (raw == null || raw.trim() === '') return null
    const v = Number(raw)
    return Number.isFinite(v) && v >= CH_MIN && v <= CH_MAX ? v : null
  } catch {
    return null
  }
}

/** Remembers a width; null forgets it (back to the default) */
export function writeChangesWidth(px: number | null): void {
  try {
    if (px === null) localStorage.removeItem(CH_KEY)
    else localStorage.setItem(CH_KEY, String(Math.round(px)))
  } catch { /* no storage: the width lasts until the window closes */ }
}

/** Whether the panel was left open (one switch for every session); closed by default */
export function readOpen(store: Pick<Storage, 'getItem'> | null | undefined): boolean {
  try {
    return store?.getItem(OPEN_KEY) === '1'
  } catch {
    return false
  }
}

export function writeOpen(open: boolean): void {
  try {
    localStorage.setItem(OPEN_KEY, open ? '1' : '0')
  } catch { /* no storage: it lasts until the window closes */ }
}
