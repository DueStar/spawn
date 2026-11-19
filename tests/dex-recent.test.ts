/** The side panel's latest catches: as many as fit whole, the oldest go first (DexRecent.tsx) */
import { describe, expect, it } from 'vitest'
import { fitCount } from '../src/components/DexRecent'

describe('fitCount', () => {
  it('counts only whole icons, at most max', () => {
    expect(fitCount(95, 20, 3, 4)).toBe(4)
    expect(fitCount(89, 20, 3, 4)).toBe(4) // 4×20 + 3×3 = 89 exactly
    expect(fitCount(88, 20, 3, 4)).toBe(3)
    expect(fitCount(42, 20, 3, 4)).toBe(1)
    expect(fitCount(19, 20, 3, 4)).toBe(0)
    expect(fitCount(500, 20, 3, 4)).toBe(4)
    expect(fitCount(0, 20, 3, 4)).toBe(0)
  })
})
