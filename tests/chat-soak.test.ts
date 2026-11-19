/**
 * An hour of streaming through the lens, on a fake clock: 600 turns, each a prompt, three tool
 * calls (PreToolUse → the call and its result in the transcript → PostToolUse), a provisional answer streamed by
 * MessageDisplay every 200 ms (30 batches: six seconds a turn), the answer line, Stop and the turn's end.
 *
 *   heap growth after gc()                                   ≤ 25 MB
 *   every per-terminal map bounded: items ≤ 4000, live empty between turns, streams, calls, logged, asks ≤ 16, the
 *   change index under its caps
 *
 * Runs only with SPAWN_PERF=1 and gc exposed:
 *   SPAWN_PERF=1 NODE_OPTIONS=--expose-gc npx vitest run tests/chat-soak.test.ts
 */

import fs, { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'

const require = createRequire(import.meta.url)
const { createLens } = require('../electron/chatLens.cjs')
const { CHANGE_CAPS } = require('../electron/chatChanges.cjs')
const { callKey } = require('../hooks/spawn-hook.cjs')

const PERF = process.env.SPAWN_PERF === '1'
const PROJECT = 'C--Users-user-work-demo'
const CWD = 'C:\\Users\\user\\work\\demo'
const T1 = '11111111-1111-4111-8111-111111111111'
const dirs: string[] = []
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }) })

const TURNS = 600
const MD_PER_TURN = 30
const MB = 1024 * 1024
const gc = () => { const g = (globalThis as any).gc; if (typeof g === 'function') { g(); g() } }
const heap = () => { gc(); return process.memoryUsage().heapUsed }

describe.skipIf(!PERF)('an hour of streaming through the lens (SPAWN_PERF=1)', () => {
  it('600 turns: the heap grows ≤ 25 MB after gc, every map stays bounded, nothing live is left between turns', async () => {
    expect(typeof (globalThis as any).gc, 'run with NODE_OPTIONS=--expose-gc').toBe('function')
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] })
    vi.setSystemTime(new Date('2026-11-14T12:00:00Z'))
    try {
      const claudeDir = mkdtempSync(join(tmpdir(), 'spawn-chat-soak-')); dirs.push(claudeDir)
      const userDataDir = mkdtempSync(join(tmpdir(), 'spawn-chat-soak-ud-')); dirs.push(userDataDir)
      mkdirSync(join(claudeDir, 'projects', PROJECT), { recursive: true })
      mkdirSync(join(userDataDir, 'session-links'), { recursive: true })
      const file = join(claudeDir, 'projects', PROJECT, `${T1}.jsonl`)
      let n = 0
      const uuid = () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`
      const iso = () => new Date(Date.now()).toISOString()
      const line = (o: unknown) => appendFileSync(file, JSON.stringify(o) + '\n')
      writeFileSync(file, JSON.stringify({ type: 'user', uuid: uuid(), timestamp: iso(), message: { role: 'user', content: 'Start.' } }) + '\n')
      let emitted = 0
      const lens = createLens({ claudeDir, userDataDir, fs, emit: () => { emitted++ }, callKey, watch: () => null, log: () => {} })
      const base = (event: string, extra: Record<string, unknown> = {}) => ({ session_id: T1, transcript_path: file, cwd: CWD, hook_event_name: event, ...extra })
      const step = async (ms: number) => { vi.advanceTimersByTime(ms); await lens.idle() }
      lens.setTerminals([{ id: T1, cwd: CWD, armed: true, status: 'running' }])
      lens.open(T1)
      await step(50)

      const samples: { turn: number; mb: number }[] = []
      let start = 0
      let worst = { items: 0, calls: 0, streams: 0, logged: 0, asks: 0, agentPaths: 0, queued: 0, soft: 0 }
      for (let turn = 0; turn < TURNS; turn++) {
        if (turn === 20) start = heap()
        const prompt = `Tidy river${turn}.`
        lens.hook('UserPromptSubmit', base('UserPromptSubmit', { prompt }), Date.now())
        line({ type: 'user', uuid: uuid(), timestamp: iso(), promptId: uuid(), message: { role: 'user', content: prompt } })
        await step(100)
        for (let k = 0; k < 3; k++) {
          const id = `toolu_soak_${turn}_${k}`
          const input = k === 2 ? { file_path: `${CWD}\\src\\river${turn % 40}.js`, old_string: 'a', new_string: 'b' } : { command: `npm test -- river${turn}` }
          const name = k === 2 ? 'Edit' : 'Bash'
          lens.hook('PreToolUse', base('PreToolUse', { tool_name: name, tool_use_id: id, tool_input: input }), Date.now())
          await step(200)
          line({ type: 'assistant', uuid: uuid(), timestamp: iso(), message: { role: 'assistant', id: `msg_soak_${turn}_${k}`, stop_reason: 'tool_use', content: [{ type: 'tool_use', id, name, input }] } })
          const result = k === 2
            ? { filePath: input.file_path, oldString: 'a', newString: 'b', structuredPatch: [{ oldStart: turn + 1, oldLines: 1, newStart: turn + 1, newLines: 1, lines: ['-a', '+b'] }], userModified: false, replaceAll: false }
            : { stdout: `ok river${turn}\n`.repeat(20), stderr: '', interrupted: false, isImage: false }
          line({ type: 'user', uuid: uuid(), timestamp: iso(), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] }, toolUseResult: result })
          lens.hook('PostToolUse', base('PostToolUse', { tool_name: name, tool_use_id: id, tool_input: input, tool_response: {} }), Date.now())
          await step(200)
        }
        const mid = `msg_soak_text_${turn}`
        let said = ''
        for (let i = 0; i < MD_PER_TURN; i++) {
          const delta = `River ${turn} flows on, part ${i} of the long answer.\n`
          said += delta
          lens.hook('MessageDisplay', base('MessageDisplay', { message_id: mid, index: i, final: i === MD_PER_TURN - 1, delta }), Date.now())
          await step(200)
        }
        line({ type: 'assistant', uuid: uuid(), timestamp: iso(), message: { role: 'assistant', id: mid, stop_reason: 'end_turn', content: [{ type: 'text', text: said }] } })
        lens.hook('Stop', base('Stop', { last_assistant_message: said }), Date.now())
        line({ type: 'system', subtype: 'turn_duration', durationMs: 7000, uuid: uuid(), timestamp: iso() })
        await step(1500)
        const sz = lens.sizes(T1)
        // between turns: no provisional bubble left
        expect(sz.live, `turn ${turn}: live bubbles left`).toBe(0)
        for (const k of Object.keys(worst) as (keyof typeof worst)[]) worst[k] = Math.max(worst[k], sz[k])
        expect(sz.items).toBeLessThanOrEqual(4000)
        expect(sz.asks).toBeLessThanOrEqual(16)
        expect(sz.changeFiles).toBeLessThanOrEqual(CHANGE_CAPS.files)
        if (turn % 100 === 99) samples.push({ turn: turn + 1, mb: (heap() - start) / MB })
      }
      const growth = (heap() - start) / MB
      const sz = lens.sizes(T1)
      console.log(`[soak] 600 turns, ${emitted} updates: heap growth after gc ${growth.toFixed(1)} MB (budget 25); per 100 turns ${samples.map(s => `${s.turn}:${s.mb.toFixed(1)}`).join(' ')}`)
      console.log(`[soak] largest maps: ${JSON.stringify(worst)}; at the end ${JSON.stringify(sz)}`)
      expect(growth).toBeLessThanOrEqual(25)
      // bounded: the items window, and nothing that grows with the turns (calls, streams, logged lines) beyond the window
      expect(worst.items).toBeLessThanOrEqual(4000)
      expect(worst.calls).toBeLessThanOrEqual(4000)
      expect(worst.streams).toBeLessThanOrEqual(64)
      expect(worst.logged).toBeLessThanOrEqual(64)
      expect(sz.changeEdits).toBeLessThanOrEqual(CHANGE_CAPS.calls)
      lens.dispose()
    } finally {
      vi.useRealTimers()
    }
  }, 900_000)
})
