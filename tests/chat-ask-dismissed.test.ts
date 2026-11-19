/**
 * A question dismissed in the terminal (seen on Claude Code 2.1.328): the AskUserQuestion's
 * hold went back to the terminal (the chat was not shown), Esc there dismissed it — no PostToolUse, no Stop — and a
 * prompt typed in the terminal started new work. The chat kept refusing every send ("… is waiting for your answer")
 * for minutes: the lens still said a question was open (`asking`), main's waitingNow believed it. Now whatever proves
 * the dialog gone ends it: a prompt, the session idle, the transcript's result or interrupt.
 */

import fs, { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
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
const S = '00000000-0000-4000-8000-000000000941'

const dirs: string[] = []
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }) })
const tempDir = () => { const d = mkdtempSync(join(tmpdir(), 'spawn-chat-dismissed-')); dirs.push(d); return d }

beforeEach(() => { vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] }); vi.setSystemTime(new Date('2026-11-19T08:18:00Z')) })
afterEach(() => { vi.useRealTimers() })

function setup() {
  const claudeDir = tempDir()
  const userDataDir = tempDir()
  mkdirSync(join(claudeDir, 'projects', PROJECT), { recursive: true })
  mkdirSync(join(userDataDir, 'session-links'), { recursive: true })
  writeFileSync(join(userDataDir, 'session-links', T1), S)
  const updates: any[] = []
  const holds: any[] = []
  const asking: boolean[] = []
  const lens = createLens({ claudeDir, userDataDir, fs, emit: (u: any) => updates.push(u), callKey, watch: () => null, onHold: (m: any) => holds.push(m), onAsking: (_id: string, on: boolean) => asking.push(on) })
  lens.setTerminals([{ id: T1, cwd: CWD, armed: true, status: 'running' }])
  const run = async (ms: number) => { for (let t = 0; t < ms; t += 10) { vi.advanceTimersByTime(Math.min(10, ms - t)); await lens.idle() } await lens.idle() }
  const status = () => {
    let s: any = null
    for (const u of updates) if (u.id === T1) for (const o of u.ops) if (o.op === 'status' || o.op === 'reset') s = o.status
    return s
  }
  const transcript = join(claudeDir, 'projects', PROJECT, `${S}.jsonl`)
  return { lens, holds, asking, run, status, transcript, updates }
}

const Q = hooksOf('hooks-question.jsonl')
const ask = Q[0].body
const prompt = (text: string) => ({ session_id: S, hook_event_name: 'UserPromptSubmit', prompt: text, transcript_path: ask.transcript_path })

/** The sequence up to the Esc: a prompt, the question (both PreToolUse routes), its hold handed back, its PermissionRequest passed */
async function questionHandedBack() {
  const s = setup()
  s.lens.hook('UserPromptSubmit', prompt('ask me something'), 0)
  s.lens.hook('PreToolUse', ask, 10)
  s.lens.hook('PreToolUse', ask, 10, 'q1', T1)
  await s.run(10)
  // main released it: the chat was not the shown view (spawn.log "a question hold released (hidden)")
  s.lens.holdState('q1', 'terminal')
  s.lens.hook('PermissionRequest', { ...ask, hook_event_name: 'PermissionRequest' }, 20, 'p1', T1)
  await s.run(10)
  expect(s.holds.find(h => h.holdId === 'p1')).toEqual({ t: 'hold-pass', holdId: 'p1', why: 'question' })
  expect(s.status().state).toBe('waiting')
  expect(s.status().asks).toHaveLength(1)
  expect(s.asking.at(-1)).toBe(true)
  return s
}

describe('a question dismissed in the terminal', () => {
  it('the prompt typed there next ends it: no question open, no card, working (a send is let through)', async () => {
    const s = await questionHandedBack()
    // Esc in the terminal: no hook at all. A minute later a prompt typed in the terminal
    await s.run(60_000)
    s.lens.hook('UserPromptSubmit', prompt('a new request'), 71_000)
    await s.run(10)
    expect(s.asking.at(-1)).toBe(false)
    expect(s.status().asks).toBeUndefined()
    expect(s.status().state).toBe('working')
  })

  it('the session going idle ends it too (a Stop that did come, or a StopFailure)', async () => {
    const s = await questionHandedBack()
    s.lens.hook('StopFailure', { session_id: S, hook_event_name: 'StopFailure', error: 'x' }, 100)
    await s.run(10)
    expect(s.asking.at(-1)).toBe(false)
    expect(s.status().asks).toBeUndefined()
  })

  it('the record\'s rejected result and interrupt, read live, end it', async () => {
    const s = setup()
    writeFileSync(s.transcript, JSON.stringify({ parentUuid: null, isSidechain: false, type: 'user', message: { role: 'user', content: 'ask me something' }, uuid: '00000000-0000-4000-8000-000000000001', timestamp: '2026-11-19T08:17:59.000Z', sessionId: S }) + '\n')
    s.lens.open(T1)
    await s.run(50)
    s.lens.hook('UserPromptSubmit', prompt('ask me something'), 0)
    s.lens.hook('PreToolUse', ask, 10)
    s.lens.hook('PreToolUse', ask, 10, 'q1', T1)
    await s.run(10)
    expect(s.asking.at(-1)).toBe(true)
    const tu = { parentUuid: '00000000-0000-4000-8000-000000000001', isSidechain: false, type: 'assistant', message: { id: 'msg_1', role: 'assistant', model: 'claude', content: [{ type: 'tool_use', id: ask.tool_use_id, name: 'AskUserQuestion', input: ask.tool_input }] }, uuid: '00000000-0000-4000-8000-000000000002', timestamp: '2026-11-19T08:18:05.000Z', sessionId: S }
    const rejected = { parentUuid: '00000000-0000-4000-8000-000000000002', isSidechain: false, type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: ask.tool_use_id, is_error: true, content: "The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file). STOP what you are doing and wait for the user to tell you how to proceed." }] }, uuid: '00000000-0000-4000-8000-000000000003', timestamp: '2026-11-19T08:18:24.018Z', sessionId: S }
    const interrupt = { parentUuid: '00000000-0000-4000-8000-000000000003', isSidechain: false, type: 'user', message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user for tool use]' }] }, uuid: '00000000-0000-4000-8000-000000000004', timestamp: '2026-11-19T08:18:24.021Z', sessionId: S }
    appendFileSync(s.transcript, [tu, rejected, interrupt].map(l => JSON.stringify(l)).join('\n') + '\n')
    await s.run(3000)
    expect(s.asking.at(-1)).toBe(false)
    expect(s.status().asks).toBeUndefined()
    expect(s.status().state).toBe('idle')
  })

  it('a prompt queued while the question is still held by the chat keeps the card (its hold is pending)', async () => {
    const s = setup()
    s.lens.hook('UserPromptSubmit', prompt('ask me something'), 0)
    s.lens.hook('PreToolUse', ask, 10)
    s.lens.hook('PreToolUse', ask, 10, 'q1', T1)
    await s.run(10)
    s.lens.hook('UserPromptSubmit', prompt('queued meanwhile'), 20)
    await s.run(10)
    expect(s.status().asks).toHaveLength(1)
    expect(s.status().asks[0].state).toBe('open')
  })

  it("AskUserQuestion's own PermissionRequest keeps its row a question, never a permission", async () => {
    const s = setup()
    writeFileSync(s.transcript, JSON.stringify({ parentUuid: null, isSidechain: false, type: 'user', message: { role: 'user', content: 'hi' }, uuid: '00000000-0000-4000-8000-000000000001', timestamp: '2026-11-19T08:17:59.000Z', sessionId: S }) + '\n')
    s.lens.open(T1)
    await s.run(50)
    s.lens.hook('UserPromptSubmit', prompt('ask me something'), 0)
    s.lens.hook('PreToolUse', ask, 10)
    s.lens.hook('PermissionRequest', { ...ask, hook_event_name: 'PermissionRequest' }, 20)
    await s.run(10)
    const row = s.updates.flatMap(u => u.ops).filter((o: any) => o.op === 'upsert').flatMap((o: any) => o.items).filter((i: any) => i.id === ask.tool_use_id).at(-1)
    expect(row.waiting).toBe('question')
  })
})
