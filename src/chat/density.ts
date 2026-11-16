/**
 * How much of the conversation the chat view draws (Phase 5): 기본 (tools in one line; failures and
 * questions always shown), 생각 포함 (also the thinking before each answer: src/chat/rows.ts makes its rows),
 * 전부 (every file read and every output opened). One level for the whole app, remembered as one word
 * (`spawn-chat-density`), like the text size. The virtual list's estimate for a row it has not measured
 * yet, and whether runs of tool rows sit tight, come from the one table here (ChatList takes them as props).
 * A row's open state starts from the level (`initialOpen`) until the user opens or closes it: 전부 never
 * overrides a row the user closed (src/components/chat/context.ts useRowOpen keeps the user's choice).
 */

import { useSyncExternalStore } from 'react'

export type Density = 'default' | 'thinking' | 'all'
export const DENSITIES: readonly Density[] = ['default', 'thinking', 'all']
export const DENSITY_KEY = 'spawn-chat-density'

/** The level's name (a Korean key; 기본 is read with tSense(…, DENSITY_SENSE): '기본#density' in the dictionaries) */
export const DENSITY_LABEL: Record<Density, string> = { default: '기본', thinking: '생각 포함', all: '전부' }
export const DENSITY_SENSE = 'density'
/** The level's one-line hint in the menu */
export const DENSITY_HINT: Record<Density, string> = {
  default: '도구는 한 줄 요약, 실패와 질문은 늘 펼침',
  thinking: '답하기 전에 생각한 내용도 보기',
  all: '읽은 파일과 출력까지 모두 펼치기',
}

/** A row's height before it is measured, per level (전부 opens rows: they are taller) */
export const ESTIMATE: Record<Density, number> = { default: 44, thinking: 48, all: 140 }
/** Runs of tool rows sit tight (no gap between them); in 전부 each opened row keeps its gap */
export const TIGHT: Record<Density, boolean> = { default: true, thinking: true, all: false }

/** What a row starts as before the user chooses: open in 전부, closed otherwise */
export function initialOpen(density: Density, kind: 'tool' | 'group' | 'agent' | 'diff'): boolean {
  void kind
  return density === 'all'
}

const isDensity = (v: unknown): v is Density => typeof v === 'string' && (DENSITIES as readonly string[]).includes(v)

/** The remembered level; a bad value, none, or a storage that cannot be read gives 기본 */
export function readDensity(): Density {
  try {
    const v = typeof localStorage === 'undefined' ? null : localStorage.getItem(DENSITY_KEY)
    return isDensity(v) ? v : 'default'
  } catch {
    return 'default'
  }
}

const listeners = new Set<() => void>()
let current: Density | null = null

/** Choose a level: remembered (when the storage lets it) and heard by every view at once */
export function writeDensity(d: Density): void {
  if (!isDensity(d)) return
  current = d
  try { if (typeof localStorage !== 'undefined') localStorage.setItem(DENSITY_KEY, d) } catch { /* not remembered: still this page's level */ }
  for (const l of [...listeners]) l()
}

export function subscribeDensity(fn: () => void): () => void {
  listeners.add(fn)
  return () => { listeners.delete(fn) }
}

const snapshot = (): Density => (current ??= readDensity())

/** The level now, following every change */
export function useDensity(): Density {
  return useSyncExternalStore(subscribeDensity, snapshot, () => 'default')
}
