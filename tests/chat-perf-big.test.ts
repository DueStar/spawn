/**
 * A 300 MB transcript, through the lens as the chat worker runs it:
 *
 *   open: the event loop's longest lag ≤ 50 ms; the reset emitted ≤ 2 s after open; ≤ 16 MB read for it
 *   the change scan over the whole file ≤ 20 s; heap growth during it ≤ 120 MB; a hook posted during it emitted ≤ 250 ms
 *
 * The file is written to the temp folder for the run and deleted after it (a free-disk check skips the run with a
 * message under 2 GB free). Runs only with SPAWN_PERF=1:
 *   SPAWN_PERF=1 npx vitest run tests/chat-perf-big.test.ts
 */

import fs, { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { freeBytes, writeSynthTranscript } from './helpers'

const require = createRequire(import.meta.url)
const { createLens } = require('../electron/chatLens.cjs')
const { callKey } = require('../hooks/spawn-hook.cjs')

const PERF = process.env.SPAWN_PERF === '1'
const PROJECT = 'C--Users-user-work-demo'
const CWD = 'C:\\Users\\user\\work\\demo'
const T1 = '11111111-1111-4111-8111-111111111111'
const MB = 1024 * 1024
const dirs: string[] = []
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }) })
const enough = (freeBytes(tmpdir()) ?? Infinity) >= 2 * 1024 * MB
if (PERF && !enough) console.log('[perf-big] skipped: under 2 GB free in the temp folder')

describe.skipIf(!PERF || !enough)('a 300 MB transcript (SPAWN_PERF=1)', () => {
  it('open and the change scan within their budgets', async () => {
    const claudeDir = mkdtempSync(join(tmpdir(), 'spawn-chat-big-')); dirs.push(claudeDir)
    const userDataDir = mkdtempSync(join(tmpdir(), 'spawn-chat-big-ud-')); dirs.push(userDataDir)
    mkdirSync(join(claudeDir, 'projects', PROJECT), { recursive: true })
    mkdirSync(join(userDataDir, 'session-links'), { recursive: true })
    const file = join(claudeDir, 'projects', PROJECT, `${T1}.jsonl`)
    const w0 = performance.now()
    const edits = writeSynthTranscript(file, 300 * MB)
    const size = fs.statSync(file).size
    console.log(`[perf-big] wrote ${(size / MB).toFixed(0)} MB, ${edits} edits in ${((performance.now() - w0) / 1000).toFixed(1)} s`)
    expect(size).toBeGreaterThanOrEqual(300 * MB)

    // every byte the lens reads from the transcript (fs.promises handles and the sync reads)
    let read = 0
    const countRead = (n: unknown) => { if (typeof n === 'number' && n > 0) read += n }
    const spyFs = {
      ...fs,
      readSync: (...a: any[]) => { const n = (fs.readSync as any)(...a); countRead(n); return n },
      promises: {
        ...fs.promises,
        open: async (...a: any[]) => {
          const h: any = await (fs.promises.open as any)(...a)
          const orig = h.read.bind(h)
          h.read = async (...b: any[]) => { const r = await orig(...b); countRead(r.bytesRead); return r }
          return h
        },
      },
    }
    const updates: { at: number; ops: any[] }[] = []
    const lens = createLens({ claudeDir, userDataDir, fs: spyFs, emit: (u: any) => updates.push({ at: performance.now(), ops: u.ops }), callKey, watch: () => null, log: () => {} })
    const changes = () => updates.flatMap(u => u.ops).filter((o: any) => o.op === 'status' || o.op === 'reset').map((o: any) => o.status.changes).filter(Boolean).at(-1)

    // the event loop's lag: a 10 ms timer's lateness, all through
    let lag = 0
    let last = performance.now()
    const ticker = setInterval(() => { const now = performance.now(); lag = Math.max(lag, now - last - 10); last = now }, 10)
    ;(globalThis as any).gc?.()
    const heap0 = process.memoryUsage().heapUsed
    let heapMax = heap0
    const heapTimer = setInterval(() => { heapMax = Math.max(heapMax, process.memoryUsage().heapUsed) }, 50)
    try {
      lens.setTerminals([{ id: T1, cwd: CWD, armed: true, status: 'running' }])
      const t0 = performance.now()
      lens.open(T1)
      const until = async (cond: () => boolean, ms: number, what: string) => {
        const end = performance.now() + ms
        while (!cond()) { if (performance.now() > end) throw new Error(`timed out: ${what}`); await new Promise(r => setTimeout(r, 5)) }
      }
      await until(() => updates.some(u => u.ops.some((o: any) => o.op === 'reset')), 10_000, 'the reset')
      const resetMs = updates.find(u => u.ops.some((o: any) => o.op === 'reset'))!.at - t0
      const readForReset = read
      const lagOpen = lag
      console.log(`[perf-big] open: reset after ${resetMs.toFixed(0)} ms (budget 2000), ${(readForReset / MB).toFixed(1)} MB read for it (budget 16), longest lag ${lagOpen.toFixed(0)} ms (budget 50)`)
      // a hook while the scan runs
      await new Promise(r => setTimeout(r, 300))
      const posted = performance.now()
      lens.hook('PreToolUse', { session_id: T1, transcript_path: file, cwd: CWD, hook_event_name: 'PreToolUse', tool_name: 'Read', tool_use_id: 'toolu_live_big', tool_input: { file_path: 'x' } }, Date.now())
      await until(() => updates.some(u => u.at >= posted && u.ops.some((o: any) => o.op === 'upsert' && o.items.some((i: any) => i.id === 'toolu_live_big'))), 5_000, 'the hook row')
      const hookMs = updates.find(u => u.ops.some((o: any) => o.op === 'upsert' && o.items.some((i: any) => i.id === 'toolu_live_big')))!.at - posted
      const scanningThen = changes()?.state
      await until(() => ['ready', 'partial'].includes(changes()?.state), 120_000, 'the scan')
      const scanMs = performance.now() - t0
      const growth = (heapMax - heap0) / MB
      const summary = changes()
      console.log(`[perf-big] scan: ${(scanMs / 1000).toFixed(1)} s (budget 20), heap growth ${growth.toFixed(0)} MB at most (budget 120), a hook during it emitted in ${hookMs.toFixed(0)} ms (budget 250, scan ${scanningThen}), longest lag ${lag.toFixed(0)} ms; ${JSON.stringify(summary)}`)
      expect(resetMs).toBeLessThanOrEqual(2000)
      expect(readForReset).toBeLessThanOrEqual(16 * MB)
      expect(lagOpen).toBeLessThanOrEqual(50)
      expect(scanMs).toBeLessThanOrEqual(20_000)
      expect(growth).toBeLessThanOrEqual(120)
      expect(hookMs).toBeLessThanOrEqual(250)
      expect(scanningThen).toBe('scanning')
      expect(summary).toMatchObject({ state: 'ready', edits })
    } finally {
      clearInterval(ticker)
      clearInterval(heapTimer)
      lens.dispose()
      rmSync(file, { force: true })
    }
  }, 300_000)
})
