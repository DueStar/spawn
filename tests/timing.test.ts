/**
 * steadyGrowth: a ratio over the limit is measured again before a test fails on
 * it (a busy runner stalls one try), and a truly quadratic path still fails.
 */
import { describe, expect, it } from 'vitest'
import { growthLimit, steadyGrowth } from './timing'

const spin = (ms: number): void => { const end = performance.now() + ms; while (performance.now() < end) { /* busy */ } }

describe('steadyGrowth', () => {
  it('a stall during the first try is measured again, not failed on', () => {
    let calls = 0
    const g = steadyGrowth(n => n, (n: number) => { calls++; spin(n > 1 && calls <= 12 ? 40 : 2) }, 1)
    expect(g.ratio).toBeLessThan(growthLimit())
  })
  it('a quadratic path still comes back over the limit', () => {
    const g = steadyGrowth(n => n, (n: number) => spin(n * n * 0.5), 4)
    expect(g.ratio).toBeGreaterThanOrEqual(growthLimit())
  })
})
