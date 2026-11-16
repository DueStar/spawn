/**
 * electron/chatLens.cjs, Phase 3 — what the composer's strip and control row read from the
 * lens: the prompts Claude Code itself queued (the transcript's `queue-operation` lines and
 * the `queued_command` attachment), the permission mode the hooks report, and a signal to main
 * when UserPromptSubmit says a terminal's prompt row was taken. A strip that is not Claude
 * Code's is worse than none: an operation not known clears it, 10 s idle clears it.
 */

import fs, { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fixture, hooksOf } from './chat-helpers'

const require = createRequire(import.meta.url)
const { createLens } = require('../electron/chatLens.cjs')
const { quickSkip, queueOp } = require('../electron/chatSchema.cjs')
const { callKey } = require('../hooks/spawn-hook.cjs')

const PROJECT = 'C--Users-user-work-demo'
const CWD = 'C:\\Users\\user\\work\\demo'
const SID = '00000000-0000-4000-8000-000000000499'

const dirs: string[] = []
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }) })
const tempDir = () => { const d = mkdtempSync(join(tmpdir(), 'spawn-chat-queue-')); dirs.push(d); return d }

beforeEach(() => { vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] }); vi.setSystemTime(new Date('2026-11-15T02:04:00Z')) })
afterEach(() => { vi.useRealTimers() })

function setup() {
  const claudeDir = tempDir()
  const userDataDir = tempDir()
  mkdirSync(join(claudeDir, 'projects', PROJECT), { recursive: true })
  mkdirSync(join(userDataDir, 'session-links'), { recursive: true })
  const updates: any[] = []
  const prompts: string[] = []
  const asking: [string, boolean][] = []
  const logs: string[] = []
  const lens = createLens({ claudeDir, userDataDir, fs, emit: (u: any) => updates.push(u), callKey, watch: () => null, onPrompt: (id: string) => prompts.push(id), onAsking: (id: string, on: boolean) => asking.push([id, on]), log: (_l: string, m: string) => logs.push(m) })
  const file = join(claudeDir, 'projects', PROJECT, `${SID}.jsonl`)
  const run = async (ms: number) => { for (let t = 0; t < ms; t += 10) { vi.advanceTimersByTime(Math.min(10, ms - t)); await lens.idle() } await lens.idle() }
  const status = () => {
    let st: any = null
    for (const u of updates) for (const op of u.ops) if (op.op === 'reset' || op.op === 'status') st = op.status
    return st
  }
  return { lens, file, run, status, prompts, asking, updates, logs }
}

const term = (id: string) => ({ id, cwd: CWD, armed: true, status: 'running' })
const body = (event: string, extra: Record<string, unknown> = {}) => ({ session_id: SID, transcript_path: 'C:\\Users\\user\\.claude\\projects\\x.jsonl', cwd: CWD, hook_event_name: event, ...extra })
const LINES = fixture('queue.jsonl').split('\n').filter(Boolean)
const op = (operation: string, content?: string) => JSON.stringify({ type: 'queue-operation', operation, timestamp: '2026-11-15T02:05:00.000Z', sessionId: SID, ...(content === undefined ? {} : { content }) })
const userLine = (n: number, text: string) => JSON.stringify({ parentUuid: null, isSidechain: false, type: 'user', message: { role: 'user', content: text }, uuid: `00000000-0000-4000-8000-0000000004${n}`, timestamp: '2026-11-15T02:05:01.000Z' })

async function opened() {
  const s = setup()
  writeFileSync(s.file, LINES[0] + '\n')
  s.lens.setTerminals([term(SID)])
  s.lens.open(SID)
  await s.run(20)
  s.lens.hook('UserPromptSubmit', body('UserPromptSubmit', { prompt: 'Read src/math.js and say what it does in one sentence.' }), Date.now())
  await s.run(50)
  return s
}
const add = async (s: Awaited<ReturnType<typeof opened>>, ...lines: string[]) => { appendFileSync(s.file, lines.join('\n') + '\n'); await s.run(1100) }

describe('queueOp', () => {
  it('enqueue, remove, dequeue; anything else unknown; the text capped', () => {
    expect(queueOp({ type: 'queue-operation', operation: 'enqueue', content: 'hi' })).toEqual({ op: 'enqueue', text: 'hi' })
    expect(queueOp({ type: 'queue-operation', operation: 'remove', content: 'hi', reason: 'absorbed_mid_turn' })).toEqual({ op: 'remove', text: 'hi' })
    expect(queueOp({ type: 'queue-operation', operation: 'dequeue' })).toEqual({ op: 'dequeue', text: null })
    expect(queueOp({ type: 'queue-operation', operation: 'shuffle', content: 'hi' })).toEqual({ op: 'unknown', text: 'hi' })
    expect(queueOp({ type: 'queue-operation', operation: 'enqueue', content: 'x'.repeat(500) }).text).toHaveLength(400)
    expect(queueOp({ type: 'queue-operation', operation: 'enqueue', content: [{ type: 'text', text: 'hi' }] })).toEqual({ op: 'enqueue', text: null })
  })

  it('quickSkip lets queue-operation lines through and still skips the other bookkeeping unparsed', () => {
    expect(quickSkip(LINES[1])).toBe(false)
    const spy = vi.spyOn(JSON, 'parse')
    for (const l of ['{"type":"last-prompt","x":1}', '{"type":"file-history-snapshot","x":1}', '{"type":"ai-title","x":1}', '{"type":"bridge-session","sessionId":"REDACTED"}']) expect(quickSkip(l)).toBe(true)
    expect(spy).not.toHaveBeenCalled()
    spy.mockRestore()
  })
})

describe('the queue strip\'s source', () => {
  it('queue.jsonl: two enqueued, one taken in, the rest taken as the next turn; an operation not known clears it', async () => {
    const s = await opened()
    expect(s.status().queuedCount).toBeUndefined()
    await add(s, LINES[1], LINES[2])
    expect(s.status()).toMatchObject({ queuedCount: 2, queued: [{ text: 'Also, which rivers are the longest?', truncated: false }, { text: 'Then list the js files.', truncated: false }] })
    await add(s, LINES[3])
    expect(s.status()).toMatchObject({ queuedCount: 1, queued: [{ text: 'Then list the js files.' }] })
    await add(s, LINES[4], LINES[5], LINES[6])
    expect(s.status().queuedCount).toBeUndefined()
    expect(s.status().queued).toBeUndefined()
    // an operation the lens does not know: cleared (and logged), nothing until the next enqueue
    await add(s, op('enqueue', 'one more'))
    expect(s.status().queuedCount).toBe(1)
    await add(s, LINES[7])
    expect(s.status().queuedCount).toBeUndefined()
    expect(s.logs.some(m => /queue/.test(m))).toBe(true)
    await add(s, op('remove', 'x'))
    expect(s.status().queuedCount).toBeUndefined()
    await add(s, op('enqueue', 'after the unknown'))
    expect(s.status().queuedCount).toBe(1)
  })

  it('a queued_command or a user line with the same text takes the entry; remove without text takes the first', async () => {
    const s = await opened()
    await add(s, op('enqueue', 'first prompt in the queue, long enough'), op('enqueue', 'second'), op('enqueue', 'third'))
    expect(s.status().queuedCount).toBe(3)
    await add(s, JSON.stringify({ parentUuid: null, isSidechain: false, type: 'attachment', uuid: '00000000-0000-4000-8000-000000000481', timestamp: '2026-11-15T02:05:02.000Z', attachment: { type: 'queued_command', prompt: 'first prompt in the queue, long enough', commandMode: 'prompt', origin: { kind: 'human' } } }))
    expect(s.status().queued.map((q: any) => q.text)).toEqual(['second', 'third'])
    await add(s, userLine(82, 'third'))
    expect(s.status().queued.map((q: any) => q.text)).toEqual(['second'])
    await add(s, op('dequeue'))
    expect(s.status().queuedCount).toBeUndefined()
  })

  it('at most 3 texts sent (capped at 200), the count of all; at most 10 kept', async () => {
    const s = await opened()
    await add(s, op('enqueue', 'y'.repeat(300)), ...Array.from({ length: 11 }, (_, i) => op('enqueue', `q${i}`)))
    expect(s.status().queuedCount).toBe(10)
    expect(s.status().queued).toHaveLength(3)
    // the oldest went past ten
    expect(s.status().queued[0]).toEqual({ text: 'q1', truncated: false })
    const t = await opened()
    await add(t, op('enqueue', 'y'.repeat(300)))
    expect(t.status().queued[0]).toEqual({ text: 'y'.repeat(200), truncated: true })
  })

  it('idle for 10 s with entries left: cleared (a queue the lens lost track of says nothing)', async () => {
    const s = await opened()
    await add(s, op('enqueue', 'left behind'))
    s.lens.hook('Stop', body('Stop', { last_assistant_message: '' }), Date.now())
    await s.run(9000)
    expect(s.status().queuedCount).toBe(1)
    await s.run(1500)
    expect(s.status().queuedCount).toBeUndefined()
    // a new prompt within the 10 s keeps it
    const t = await opened()
    await add(t, op('enqueue', 'kept'))
    t.lens.hook('Stop', body('Stop', { last_assistant_message: '' }), Date.now())
    await t.run(4000)
    t.lens.hook('UserPromptSubmit', body('UserPromptSubmit', { prompt: 'next' }), Date.now())
    await t.run(8000)
    expect(t.status().queuedCount).toBe(1)
  })

  it('older pages never touch the queue; the tail first read does', async () => {
    const s = setup()
    writeFileSync(s.file, [LINES[0], op('enqueue', 'from the tail')].join('\n') + '\n')
    s.lens.setTerminals([term(SID)])
    s.lens.hook('UserPromptSubmit', body('UserPromptSubmit', { prompt: 'Read src/math.js and say what it does in one sentence.' }), Date.now())
    s.lens.open(SID)
    await s.run(50)
    expect(s.status().queuedCount).toBe(1)
  })

  it('queued.jsonl (2.1.325): the same conversation as in Phase 2, and no strip at the end', async () => {
    const s = setup()
    const lines = fixture('queued.jsonl').split('\n').filter(Boolean)
    const sid = '00000000-0000-4000-8000-000000000399'
    const file = s.file.replace(SID, sid)
    writeFileSync(file, '')
    s.lens.setTerminals([term(sid)])
    s.lens.open(sid)
    await s.run(20)
    s.lens.hook('UserPromptSubmit', { ...body('UserPromptSubmit', { prompt: 'Read src/math.js and say what it does in one sentence.' }), session_id: sid }, Date.now())
    appendFileSync(file, lines.join('\n') + '\n')
    await s.run(300)
    const st = s.status()
    expect(st.queuedCount).toBeUndefined()
    const users = s.updates.flatMap(u => u.ops).filter((o: any) => o.op === 'upsert' || o.op === 'reset').flatMap((o: any) => o.items).filter((i: any) => i.kind === 'user').map((i: any) => i.text)
    expect([...new Set(users)]).toEqual(['Read src/math.js and say what it does in one sentence.', 'Also, which rivers are the longest?'])
  })
})

describe('the permission mode', () => {
  it('hooks-input.jsonl: default → acceptEdits → null (not known) → plan; absent before any hook says', async () => {
    const s = setup()
    writeFileSync(s.file, '')
    s.lens.setTerminals([term(SID)])
    s.lens.open(SID)
    await s.run(20)
    expect('mode' in s.status()).toBe(false)
    const seen: unknown[] = []
    for (const h of hooksOf('hooks-input.jsonl')) {
      s.lens.hook(h.event, h.body, Date.now())
      await s.run(20)
      seen.push(s.status().mode)
    }
    expect(seen).toEqual(['default', 'acceptEdits', null, 'plan'])
  })
})

describe('the prompt signal', () => {
  it('once per UserPromptSubmit with the terminal id; never for a session not mapped', async () => {
    const s = setup()
    writeFileSync(s.file, '')
    s.lens.setTerminals([term(SID)])
    for (const h of hooksOf('hooks-input.jsonl')) s.lens.hook(h.event, h.body, Date.now())
    expect(s.prompts).toEqual([SID, SID, SID])
    s.lens.hook('UserPromptSubmit', { ...body('UserPromptSubmit', { prompt: 'x' }), session_id: '00000000-0000-4000-8000-000000000777' }, Date.now())
    expect(s.prompts).toHaveLength(3)
  })

  it('the worker posts it to main', () => {
    const src = readFileSync(join(__dirname, '..', 'electron', 'chatWorker.cjs'), 'utf8')
    expect(src).toMatch(/onPrompt: \(id\) => post\(\{ t: 'prompt', id \}\)/)
  })
})

describe('a question or a plan open in a terminal (review I-6: the composer holds its Enter)', () => {
  it('AskUserQuestion and ExitPlanMode open one from their PreToolUse to their PostToolUse or the turn\'s end; other tools and sub-agents never do', async () => {
    const s = await opened()
    s.lens.hook('PreToolUse', body('PreToolUse', { tool_name: 'Read', tool_use_id: 'toolu_r1', tool_input: { file_path: 'a' } }), Date.now())
    expect(s.asking).toEqual([])
    s.lens.hook('PreToolUse', body('PreToolUse', { tool_name: 'AskUserQuestion', tool_use_id: 'toolu_q1', tool_input: { questions: [] } }), Date.now())
    expect(s.asking).toEqual([[SID, true]])
    s.lens.hook('PostToolUse', body('PostToolUse', { tool_name: 'AskUserQuestion', tool_use_id: 'toolu_q1', tool_input: {}, tool_response: {} }), Date.now())
    expect(s.asking).toEqual([[SID, true], [SID, false]])
    s.lens.hook('PreToolUse', body('PreToolUse', { tool_name: 'ExitPlanMode', tool_use_id: 'toolu_p1', tool_input: {} }), Date.now())
    s.lens.hook('Stop', body('Stop'), Date.now())
    expect(s.asking).toEqual([[SID, true], [SID, false], [SID, true], [SID, false]])
    s.lens.hook('PreToolUse', body('PreToolUse', { tool_name: 'AskUserQuestion', tool_use_id: 'toolu_q2', tool_input: {}, agent_id: 'a1b2c3d4e5f6a7b8c' }), Date.now())
    expect(s.asking).toHaveLength(4)
  })

  it('the worker posts it to main', () => {
    const src = readFileSync(join(__dirname, '..', 'electron', 'chatWorker.cjs'), 'utf8')
    expect(src).toMatch(/onAsking: \(id, on\) => post\(\{ t: 'asking', id, on: on === true \}\)/)
  })
})
