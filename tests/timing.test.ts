/**
 * The timing helpers themselves (tests/timing.ts): strict numbers on a developer's machine and with SPAWN_PERF=1,
 * wider ones on a CI runner. STRICT is read once when the module loads, so each case loads it again under its own
 * environment.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'

const saved = { CI: process.env.CI, SPAWN_PERF: process.env.SPAWN_PERF }

function setEnv(name: 'CI' | 'SPAWN_PERF', value: string | undefined): void {
  if (value === undefined) delete process.env[name]
  else process.env[name] = value
}

/** tests/timing.ts loaded fresh under CI and SPAWN_PERF as given (undefined: unset) */
async function load(env: { CI?: string; SPAWN_PERF?: string }): Promise<typeof import('./timing')> {
  setEnv('CI', env.CI)
  setEnv('SPAWN_PERF', env.SPAWN_PERF)
  vi.resetModules()
  return import('./timing')
}

afterEach(() => {
  setEnv('CI', saved.CI)
  setEnv('SPAWN_PERF', saved.SPAWN_PERF)
  vi.resetModules()
})

describe('timing budgets', () => {
  it('a developer\'s machine (CI unset): the strict numbers', async () => {
    const t = await load({})
    expect(t.STRICT).toBe(true)
    expect(t.budget(40)).toBe(40)
    expect(t.growthLimit()).toBe(8)
    expect(t.memoryBudget(50 << 20)).toBe(50 << 20)
  })

  it('a CI runner (CI=true): ×4 wall clock and memory, growth ×12', async () => {
    const t = await load({ CI: 'true' })
    expect(t.STRICT).toBe(false)
    expect(t.budget(40)).toBe(160)
    expect(t.growthLimit()).toBe(12)
    expect(t.memoryBudget(50 << 20)).toBe(200 << 20)
  })

  it('a CI runner with SPAWN_PERF=1: the strict numbers again', async () => {
    const t = await load({ CI: 'true', SPAWN_PERF: '1' })
    expect(t.STRICT).toBe(true)
    expect(t.budget(40)).toBe(40)
    expect(t.growthLimit()).toBe(8)
    expect(t.memoryBudget(50 << 20)).toBe(50 << 20)
  })

  it('the growth limit stays below quadratic (×16) in every case', async () => {
    for (const env of [{}, { CI: 'true' }, { CI: 'true', SPAWN_PERF: '1' }]) {
      const t = await load(env)
      expect(t.growthLimit(), JSON.stringify(env)).toBeLessThan(16)
    }
  })
})
