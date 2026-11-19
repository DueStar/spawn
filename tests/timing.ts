/**
 * Time in the unit suite: wall-clock budgets, and growth for the "no catastrophic work" tests.
 *
 * budget(ms) — a budget that is a product number (the page finds a word in 4,000 items within 40 ms). It is that
 * number on a developer's machine and in the SPAWN_PERF=1 runs. On a CI runner (process.env.CI, which GitHub
 * Actions sets) it is CI_SLOWDOWN (×4) wider: a shared runner running the whole suite is slower and noisier than a
 * desktop (in run 43775891062 the macos-15-intel runner took 2–4× what a desktop PC takes under the whole suite,
 * up to 10× what it takes alone, and missed the 40 ms find by 0.2 ms), and the claim is about the code, not the
 * runner. Run with SPAWN_PERF=1 to hold a CI runner to the strict numbers.
 *
 * memoryBudget(bytes) — the same for memory (a process's RSS growth while it reads a decompression bomb): `bytes`
 * here, ×CI_SLOWDOWN on a CI runner, where a process's RSS under the whole suite moves more than on a desktop (the
 * macos-15-intel runner went past 50 MB on the brotli bomb). The bombs are 1 GB inside, so a few hundred MB still
 * proves the inflater stopped.
 *
 * growth(make, run, n) — for a test that exists to prove there is no super-linear (catastrophic) work: the best
 * time of an input of size n and of one of size 4n, measured in turns so a busy spell of the machine falls on
 * both. Linear work grows ×4 (n·log n a little more), quadratic ×16: GROWTH_LINEAR (8) sits between, so a
 * quadratic path fails it on any machine however fast, and a slow machine passes it if the work is linear. Each
 * such test keeps a generous absolute cap on the large input too (a quadratic path over these sizes takes
 * seconds to minutes).
 *
 * growthLimit() — the ratio such a test holds a growth to: GROWTH_LINEAR here, ×1.5 (12) on a CI runner. When the
 * small input takes only a few ms, one busy spell of a shared runner during the large input's turns moves the
 * ratio a lot (the macos-15-intel runner measured ×8.7 on a 2.5 ms input); 12 is still below quadratic's ×16.
 */

/** How much wider a budget is on a CI runner */
export const CI_SLOWDOWN = 4
/** The strict numbers: a developer's machine, or SPAWN_PERF=1 anywhere */
export const STRICT = !process.env.CI || process.env.SPAWN_PERF === '1'
/** A wall-clock budget in ms: `ms` here, ×CI_SLOWDOWN on a CI runner */
export const budget = (ms: number): number => (STRICT ? ms : ms * CI_SLOWDOWN)
/** A memory budget in bytes: `bytes` here, ×CI_SLOWDOWN on a CI runner */
export const memoryBudget = (bytes: number): number => (STRICT ? bytes : bytes * CI_SLOWDOWN)

/** The growth from n to 4n above which work is not linear (linear 4, quadratic 16) */
export const GROWTH_LINEAR = 8
/** The growth a test holds work to: GROWTH_LINEAR here, ×1.5 (12) on a CI runner, still below quadratic's 16 */
export const growthLimit = (): number => (STRICT ? GROWTH_LINEAR : GROWTH_LINEAR * 1.5)
/** Below this a time is the timer's and the machine's noise, not the work's: a ratio's floor */
const FLOOR_MS = 1

export interface Growth { small: number; large: number; ratio: number }

/**
 * The best time of run(make(n)) and of run(make(4n)) over `runs` turns (after one unmeasured run of each), and
 * their ratio. make builds the input outside the timing.
 */
export function growth<T>(make: (n: number) => T, run: (input: T) => unknown, n: number, runs = 5): Growth {
  const small = make(n)
  const large = make(4 * n)
  run(small); run(large)
  let s = Infinity
  let l = Infinity
  for (let i = 0; i < runs; i++) {
    let t0 = performance.now(); run(small); s = Math.min(s, performance.now() - t0)
    t0 = performance.now(); run(large); l = Math.min(l, performance.now() - t0)
  }
  return { small: s, large: l, ratio: l / Math.max(s, FLOOR_MS) }
}

/** "small → large ms (×ratio)" for a failure message or a log line */
export const showGrowth = (g: Growth): string => `${g.small.toFixed(1)} → ${g.large.toFixed(1)} ms (×${g.ratio.toFixed(1)})`
