/**
 * What a real-session trial of the answer buttons showed (Claude Code 2.1.325),
 * replayed from hand-redacted real hook bodies (tests/fixtures/chat/real-holds-4.jsonl): the Bash
 * body carries timeout, run_in_background and dangerouslyDisableSandbox when Claude passes them; a
 * Write over a file and an Edit carry a setMode suggestion; a sub-agent's request carries agent_id
 * and agent_type; a question held and released (no decision) comes back as a PermissionRequest for
 * AskUserQuestion, which is passed at once.
 */

import fs, { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { hooksOf } from './chat-helpers'

const require = createRequire(import.meta.url)
const { createLens } = require('../electron/chatLens.cjs')
const { callKey } = require('../hooks/spawn-hook.cjs')

const PROJECT = 'C--Users-user-work-demo'
const CWD = 'C:\\Users\\user\\work\\demo'
const T1 = '11111111-1111-4111-8111-111111111111'
const S = '00000000-0000-4000-8000-000000000990'

const dirs: string[] = []
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }) })
const tempDir = () => { const d = mkdtempSync(join(tmpdir(), 'spawn-chat-real4-')); dirs.push(d); return d }

beforeEach(() => { vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] }); vi.setSystemTime(new Date('2026-11-15T12:00:00Z')) })
afterEach(() => { vi.useRealTimers() })

function setup(cwd = CWD) {
  const claudeDir = tempDir()
  const userDataDir = tempDir()
  mkdirSync(join(claudeDir, 'projects', PROJECT), { recursive: true })
  mkdirSync(join(userDataDir, 'session-links'), { recursive: true })
  writeFileSync(join(userDataDir, 'session-links', T1), S)
  const updates: any[] = []
  const holds: any[] = []
  const lens = createLens({ claudeDir, userDataDir, fs, emit: (u: any) => updates.push(u), callKey, watch: () => null, onHold: (m: any) => holds.push(m) })
  lens.setTerminals([{ id: T1, cwd, armed: true, status: 'running' }])
  const run = async (ms: number) => { for (let t = 0; t < ms; t += 10) { vi.advanceTimersByTime(Math.min(10, ms - t)); await lens.idle() } await lens.idle() }
  const status = () => {
    let s: any = null
    for (const u of updates) if (u.id === T1) for (const o of u.ops) if (o.op === 'status' || o.op === 'reset') s = o.status
    return s
  }
  return { lens, holds, run, status }
}

const REAL = hooksOf('real-holds-4.jsonl') as { at: number; event: string; route: string; body: any }[]
const real = (pred: (b: any, r: { route: string }) => boolean) => REAL.find(r => pred(r.body, r))!

describe('the real bodies of 2.1.325', () => {
  it('a Bash request with the optional fields: every one shown; sandbox off means no 항상 허용 (the rule could not say it)', async () => {
    const r = real(b => b.tool_name === 'Bash' && b.tool_input.dangerouslyDisableSandbox === true)
    expect(Object.keys(r.body.tool_input).sort()).toEqual(['command', 'dangerouslyDisableSandbox', 'description', 'run_in_background', 'timeout'])
    const { lens, holds, status, run } = setup()
    lens.hook('PermissionRequest', r.body, 0, 'x1', T1)
    await run(10)
    expect(holds[0]).toMatchObject({ t: 'hold-bind', holdId: 'x1', data: { rules: [] } })
    const card = status().asks[0]
    expect(card).toMatchObject({ holdId: 'x1', state: 'open', sandboxOff: true, timeoutMs: 60000, cwd: CWD, always: null })
    expect(card.background).toBeUndefined()
  })

  it('the same command without sandbox-off: 항상 허용 offered with its exact rule', async () => {
    const r = real(b => b.tool_name === 'Bash' && b.tool_input.dangerouslyDisableSandbox === true)
    const { dangerouslyDisableSandbox: _, ...input } = r.body.tool_input
    const { lens, status, run } = setup()
    lens.hook('PermissionRequest', { ...r.body, tool_input: input }, 0, 'x2', T1)
    await run(10)
    expect(status().asks[0].always).toEqual({ rule: 'Bash(node -e "console.log(7*8)")' })
  })

  it('a Write over a file that is there: an overwrite card; its setMode suggestion offers nothing', async () => {
    const dir = tempDir()
    mkdirSync(join(dir, 'src'))
    writeFileSync(join(dir, 'notes.txt'), 'first line\nsecond line\nthird line\n')
    const r = real(b => b.tool_name === 'Write')
    const body = { ...r.body, cwd: dir, tool_input: { ...r.body.tool_input, file_path: join(dir, 'notes.txt') } }
    expect(r.body.permission_suggestions).toEqual([{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }])
    const { lens, holds, status, run } = setup(dir)
    lens.hook('PermissionRequest', body, 0, 'w1', T1)
    await run(10)
    expect(holds[0]).toMatchObject({ t: 'hold-bind', data: { rules: [] } })
    expect(status().asks[0]).toMatchObject({ overwrite: true, always: null, diff: { kind: 'write', added: 2 } })
  })

  it('a real Edit: replace_all false shows nothing extra; the diff is − then +', async () => {
    const r = real(b => b.tool_name === 'Edit')
    const { lens, status, run } = setup()
    lens.hook('PermissionRequest', r.body, 0, 'e1', T1)
    await run(10)
    const card = status().asks[0]
    expect(card.replaceAll).toBeUndefined()
    expect(card.diff.hunks[0].lines.map((l: any) => `${l.t}${l.text}`)).toEqual(['-  return a + b', '+  return a + b + 0'])
  })

  it('a sub-agent\'s request (agent_id, agent_type): its card says so and binds', async () => {
    const r = real(b => typeof b.agent_id === 'string')
    const { lens, holds, status, run } = setup()
    lens.hook('PermissionRequest', r.body, 0, 'a1', T1)
    await run(10)
    expect(holds[0]).toMatchObject({ t: 'hold-bind', holdId: 'a1' })
    expect(status().asks[0]).toMatchObject({ agent: true, state: 'open' })
  })

  it('a question held, then (released) asked again as a PermissionRequest for AskUserQuestion: bound once, the second passed at once', async () => {
    const q = real((b, x) => x.route === 'AskUserQuestion')
    const pr = real((b, x) => x.route === 'PermissionHold' && b.tool_name === 'AskUserQuestion')
    const { lens, holds, run } = setup()
    lens.hook('PreToolUse', q.body, 0, 'q1', T1)
    lens.hook('PermissionRequest', pr.body, 10, 'q2', T1)
    await run(10)
    expect(holds.map(h => [h.t, h.holdId, h.why])).toEqual([['hold-bind', 'q1', undefined], ['hold-pass', 'q2', 'question']])
    expect(holds[0].data.labels).toEqual(['small', 'large'])
    expect(holds[0].data.input).toEqual(q.body.tool_input)
  })
})
