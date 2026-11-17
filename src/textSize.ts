/**
 * One text size for the whole app: the lists, the panels and the terminal change together, as a percent of
 * 100% in steps of 10 (80–130%; the owner's call of 2026-11-17, named 작게 / 보통 / 크게 / 아주 크게 until then).
 * The UI reads the step as a class on <html> (ts-80 … ts-130; 100% has none) that switches the type scale in
 * src/styles/tokens.css; the terminal reads its px from TERM_PX (src/termFont.ts).
 *
 * Kept per PC in page storage (spawn-text-size). A step stored by its old name moves to its percent (작게 90,
 * 크게 110, 아주 크게 120). The first time, the old terminal-only size (spawn-term-font, 10–24px) picks the
 * nearest step, a tie going to the larger one; nothing is written until the user changes the step, and the old
 * key is left as it is. The catch toast and the status card do not follow it: they are fixed-size windows.
 */

import { useSyncExternalStore } from 'react'

export const TEXT_STEPS = ['80', '90', '100', '110', '120', '130'] as const
export type TextStep = typeof TEXT_STEPS[number]
export const DEFAULT_STEP: TextStep = '100'

/** The step as it is shown: its percent, the same in every language */
export const textStepLabel = (s: TextStep): string => `${s}%`
/** The UI's name size per step (--t-name in tokens.css) */
export const UI_PX: Record<TextStep, number> = { 80: 10, 90: 11, 100: 12, 110: 13, 120: 14, 130: 16 }
/** The terminal's font size per step: 13px at 100%, scaled and rounded */
export const TERM_PX: Record<TextStep, number> = { 80: 10, 90: 12, 100: 13, 110: 14, 120: 16, 130: 17 }
/** A step stored by its old name (before 2026-11-17) */
const OLD_NAMES: Record<string, TextStep> = { small: '90', normal: '100', large: '110', xlarge: '120' }

export const TEXT_KEY = 'spawn-text-size'
/** The terminal's own size before there was one step for everything (10–24px) */
export const OLD_TERM_KEY = 'spawn-term-font'

const isStep = (v: unknown): v is TextStep => typeof v === 'string' && (TEXT_STEPS as readonly string[]).includes(v)

/** The step whose terminal size is nearest to px; a tie goes to the larger step */
export function stepFromTermPx(px: number): TextStep {
  let best: TextStep = DEFAULT_STEP
  let bestD = Infinity
  for (const s of TEXT_STEPS) {
    const d = Math.abs(TERM_PX[s] - px)
    if (d <= bestD) { best = s; bestD = d }
  }
  return best
}

/** One step bigger (1) or smaller (-1), held at both ends */
export function nextStep(step: TextStep, delta: -1 | 1): TextStep {
  const i = TEXT_STEPS.indexOf(step) + delta
  return TEXT_STEPS[Math.max(0, Math.min(TEXT_STEPS.length - 1, i))]
}

/** The step to start with: the one picked (an old name moved to its percent), else the old terminal size's nearest, else 100%. Never writes */
export function readInitialStep(store: Pick<Storage, 'getItem'> | null | undefined): TextStep {
  try {
    const picked = store?.getItem(TEXT_KEY)
    if (isStep(picked)) return picked
    if (picked && Object.prototype.hasOwnProperty.call(OLD_NAMES, picked)) return OLD_NAMES[picked]
    const old = store?.getItem(OLD_TERM_KEY)
    if (old != null && old.trim() !== '') {
      const px = Number(old)
      if (Number.isFinite(px) && px >= 10 && px <= 24) return stepFromTermPx(px)
    }
  } catch { /* no storage */ }
  return DEFAULT_STEP
}

// ---------------------------------------------------------------- the store

const pageStorage = (): Storage | null => { try { return typeof localStorage === 'undefined' ? null : localStorage } catch { return null } }

let step: TextStep = readInitialStep(pageStorage())
const listeners = new Set<() => void>()

/** The <html> class for the step: none for 100% */
function applyClass(s: TextStep) {
  if (typeof document === 'undefined') return
  const cl = document.documentElement.classList
  for (const x of TEXT_STEPS) cl.toggle(`ts-${x}`, x === s && x !== DEFAULT_STEP)
}

function apply(next: TextStep) {
  if (next === step) return
  step = next
  applyClass(step)
  for (const l of listeners) l()
}

export function getTextStep(): TextStep { return step }

/** Picks a step: remembered, put on <html>, and every listener (each terminal) told */
export function setTextStep(next: TextStep) {
  if (!isStep(next)) return
  try { pageStorage()?.setItem(TEXT_KEY, next) } catch { /* the step lasts until the page goes */ }
  apply(next)
}

export function stepTextSize(delta: -1 | 1) { setTextStep(nextStep(step, delta)) }
export function resetTextSize() { setTextStep(DEFAULT_STEP) }

export function subscribeTextStep(fn: () => void): () => void {
  listeners.add(fn)
  return () => { listeners.delete(fn) }
}

export function useTextStep(): TextStep {
  return useSyncExternalStore(subscribeTextStep, getTextStep, getTextStep)
}

// On load: the class at once (before the first paint), and a step picked in another window followed here
applyClass(step)
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (e) => {
    if (e.key === TEXT_KEY || e.key === null) apply(readInitialStep(pageStorage()))
  })
}
