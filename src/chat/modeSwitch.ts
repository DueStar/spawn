/**
 * The chat's mode menu (2026-11-17): Claude Code changes its permission mode with Shift+Tab, one step of its cycle
 * at a time, and draws the mode in its footer (promptRow.ts footerMode). So: read the footer, press once, wait until
 * the footer shows the next mode, and again, until the chosen mode is there. Back at the mode it started from
 * without meeting it: that mode is not in this session's cycle (auto or bypass needs the session launched for it).
 * Nothing is pressed while the footer cannot be read; a footer that does not change stops it. Pure: the screen,
 * the key and the clock are injected.
 */

import { footerMode, type FooterMode } from './promptRow'

export interface ModeDeps {
  read(): string | null
  /** one Shift+Tab into the terminal (main checks the session); false: not typed */
  press(): Promise<boolean>
  sleep(ms: number): Promise<void>
}

export type ModeResult =
  | { ok: true; mode: FooterMode }
  | { ok: false; reason: 'screen' | 'unreachable' | 'press'; mode: FooterMode | null }

export const MODE_LIMITS = Object.freeze({ presses: 6, stepMs: 120, waitMs: 1500 })

export async function switchMode(target: FooterMode, d: ModeDeps, limits = MODE_LIMITS): Promise<ModeResult> {
  const start = footerMode(d.read())
  if (!start) return { ok: false, reason: 'screen', mode: null }
  let cur: FooterMode = start
  for (let i = 0; i <= limits.presses; i++) {
    if (cur === target) return { ok: true, mode: cur }
    if (i === limits.presses) break
    if (!(await d.press())) return { ok: false, reason: 'press', mode: cur }
    let next: FooterMode | null = cur
    for (let waited = 0; waited < limits.waitMs && next === cur; waited += limits.stepMs) {
      await d.sleep(limits.stepMs)
      next = footerMode(d.read())
      if (next === null) return { ok: false, reason: 'screen', mode: null }
    }
    if (next === cur) return { ok: false, reason: 'screen', mode: cur }
    cur = next
    if (cur === start && cur !== target) return { ok: false, reason: 'unreachable', mode: cur }
  }
  return { ok: false, reason: 'unreachable', mode: cur }
}
