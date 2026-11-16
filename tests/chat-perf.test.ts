/**
 * The chat view's budgets for a long session, page side (Phase 6, Task 6.1; the numbers in docs/HANDOFF.md 7-51).
 * Each measure prints its number and fails only past its budget: the median of several runs after a warm-up, so a
 * busy machine's one slow run does not fail it.
 *
 *   buildRows over 4,000 items, each density            ≤ 25 ms
 *   findMatches over 4,000 items, 1- and 6-character     ≤ 40 ms
 *
 * These are the page's own numbers, so they stay wall-clock: strict on a developer's machine and with SPAWN_PERF=1,
 * ×4 on a CI runner (budget(), tests/timing.ts), where the whole suite shares a slower machine (the macos-15-intel
 * runner measured 40.2 ms for what takes 4 ms here alone, 10 ms here under the whole suite).
 */

import { describe, expect, it, vi } from 'vitest'
import { buildRows } from '../src/chat/rows'
import { findMatches } from '../src/chat/find'
import { DENSITIES } from '../src/chat/density'
import { synthItems } from './helpers'
import { budget } from './timing'

vi.mock('../src/i18n', async (orig) => ({
  ...(await orig<typeof import('../src/i18n')>()),
  t: (k: string, v?: Record<string, unknown>) => k.replace(/\{(\w+)\}/g, (_, n) => String(v?.[n] ?? '')),
}))

const dayLabel = (at: number) => new Date(at).toISOString().slice(0, 10)
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]
/** The median time of `runs` calls of fn (after two unmeasured ones) */
function time(fn: () => unknown, runs = 7): number {
  fn(); fn()
  const xs: number[] = []
  for (let i = 0; i < runs; i++) { const t0 = performance.now(); fn(); xs.push(performance.now() - t0) }
  return median(xs)
}

describe('page budgets over 4,000 items', () => {
  const items = synthItems(4000)

  it('buildRows: ≤ 25 ms at every density', () => {
    for (const density of DENSITIES) {
      // a fresh copy each run: no cache keyed by the array may answer for it
      const ms = time(() => buildRows(items.slice(), { dayLabel, density }))
      console.log(`[perf] buildRows 4000 items, ${density}: ${ms.toFixed(1)} ms (budget ${budget(25)})`)
      expect(ms).toBeLessThanOrEqual(budget(25))
    }
  })

  it('findMatches: ≤ 40 ms for a 1- and a 6-character query, at every density; the needle found once', () => {
    for (const density of DENSITIES) {
      const rows = buildRows(items, { dayLabel, density })
      for (const q of ['a', 'rivers']) {
        // warm: the same items again (the plain text of each is cached by item); cold: new item objects every run
        const ms = time(() => findMatches(items, rows, q, density))
        const cold = time(() => { const fresh = items.map((i) => ({ ...i })); return findMatches(fresh, buildRows(fresh, { dayLabel, density }), q, density) }, 5)
        console.log(`[perf] findMatches 4000 items, ${density}, "${q}": ${ms.toFixed(1)} ms warm, ${cold.toFixed(1)} ms cold incl. rows (budget ${budget(40)})`)
        expect(ms).toBeLessThanOrEqual(budget(40))
        expect(cold).toBeLessThanOrEqual(budget(40))
      }
      expect(findMatches(items, rows, 'quartzriver', density).matches).toHaveLength(1)
    }
  })
})
