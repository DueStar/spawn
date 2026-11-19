/**
 * electron/chatLens.cjs, the held requests: a held request is bound to its terminal, call key and
 * the data an answer needs, or passed back; the cards that wait on the user are in the status; what
 * Claude Code did (a PostToolUse, a rejected call, Stop, a new turn) settles them. Fake timers, a temp
 * Claude folder; `onHold` collects what the lens tells main about holds.
 */

import fs, { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fixture, hooksOf } from './chat-helpers'

const require = createRequire(import.meta.url)
const { createLens } = require('../electron/chatLens.cjs')
const { sessionRules, permissionDiff } = require('../electron/chatItems.cjs')
const { callKey } = require('../hooks/spawn-hook.cjs')

const PROJECT = 'C--Users-user-work-demo'
const CWD = 'C:\\Users\\user\\work\\demo'
const T1 = '11111111-1111-4111-8111-111111111111'
const T2 = '22222222-2222-4222-8222-222222222222'
const S = '00000000-0000-4000-8000-000000000941'
const R = '00000000-0000-4000-8000-000000000960'

const dirs: string[] = []
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }) })
const tempDir = () => { const d = mkdtempSync(join(tmpdir(), 'spawn-chat-asks-')); dirs.push(d); return d }

beforeEach(() => { vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] }); vi.setSystemTime(new Date('2026-11-15T12:00:00Z')) })
afterEach(() => { vi.useRealTimers() })

function setup(conversation = S) {
  const claudeDir = tempDir()
  const userDataDir = tempDir()
  mkdirSync(join(claudeDir, 'projects', PROJECT), { recursive: true })
  mkdirSync(join(userDataDir, 'session-links'), { recursive: true })
  writeFileSync(join(userDataDir, 'session-links', T1), conversation)
  const updates: any[] = []
  const holds: any[] = []
  const lens = createLens({ claudeDir, userDataDir, fs, emit: (u: any) => updates.push(u), callKey, watch: () => null, onHold: (m: any) => holds.push(m) })
  lens.setTerminals([{ id: T1, cwd: CWD, armed: true, status: 'running' }, { id: T2, cwd: CWD, armed: true, status: 'running' }])
  const run = async (ms: number) => { for (let t = 0; t < ms; t += 10) { vi.advanceTimersByTime(Math.min(10, ms - t)); await lens.idle() } await lens.idle() }
  /** the last status sent for T1 */
  const status = () => {
    let s: any = null
    for (const u of updates) if (u.id === T1) for (const o of u.ops) if (o.op === 'status' || o.op === 'reset') s = o.status
    return s
  }
  const transcript = (sid: string) => join(claudeDir, 'projects', PROJECT, `${sid}.jsonl`)
  return { lens, updates, holds, run, status, transcript, claudeDir }
}

const P = hooksOf('hooks-permission.jsonl')
const Q = hooksOf('hooks-question.jsonl')
const perm = (tool: string, nth = 0) => P.filter(h => h.event === 'PermissionRequest' && h.body.tool_name === tool)[nth]
const pre = (tool: string, nth = 0) => P.filter(h => h.event === 'PreToolUse' && h.body.tool_name === tool)[nth]

describe('sessionRules and permissionDiff', () => {
  it('only addRules suggestions that allow: their rules, deduplicated, four at most; setMode and the rest are not used', () => {
    expect(sessionRules(perm('Bash').body.permission_suggestions)).toEqual([{ toolName: 'Bash', ruleContent: 'node -e "console.log(6*7)"' }])
    expect(sessionRules(perm('Edit').body.permission_suggestions)).toEqual([])
    expect(sessionRules([{ type: 'addRules', rules: [{ toolName: 'Bash' }, { toolName: 'Bash' }], behavior: 'allow' }])).toEqual([{ toolName: 'Bash' }])
    expect(sessionRules([{ type: 'addRules', rules: [{ toolName: 'Bash' }], behavior: 'deny' }])).toEqual([])
    expect(sessionRules([{ type: 'addDirectories', directories: ['x'] }, { type: 'mystery' }])).toEqual([])
    expect(sessionRules([{ type: 'addRules', rules: [1, 2, 3, 4, 5].map(n => ({ toolName: `T${n}` })), behavior: 'allow' }])).toEqual([])
    expect(sessionRules([{ type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 7 }], behavior: 'allow' }])).toEqual([])
    expect(sessionRules('nope')).toEqual([])
  })

  it('an Edit: the changed lines; a Write: the new file; anything else none; too big: null (not answerable)', () => {
    const d = permissionDiff('Edit', perm('Edit').body.tool_input, CWD)
    expect(d).toMatchObject({ file: 'src/math.js', kind: 'edit', added: 5, removed: 1 })
    expect(d.hunks[0].lines.filter((l: any) => l.t === '+').map((l: any) => l.text)).toContain('function mul(a, b) {')
    const w = permissionDiff('Write', { file_path: `${CWD}\\a.txt`, content: 'one\ntwo\n' }, CWD)
    expect(w).toMatchObject({ file: 'a.txt', kind: 'create', added: 2, removed: 0 })
    expect(permissionDiff('Bash', { command: 'ls' }, CWD)).toBeUndefined()
    expect(permissionDiff('Edit', { file_path: 'a', old_string: 'x\n'.repeat(500), new_string: 'y' }, CWD)).toBeNull()
    expect(permissionDiff('Write', { file_path: 'a', content: 'x\n'.repeat(401) }, CWD)).toBeNull()
  })
})

describe('binding and passing', () => {
  it('the Bash request binds with its rule; its card offers 항상 허용 and shows the whole command', async () => {
    const { lens, holds, status, run } = setup()
    lens.hook('PreToolUse', pre('Bash').body, 0)
    lens.hook('PermissionRequest', perm('Bash').body, 100, 'h1', T1)
    await run(10)
    expect(holds).toEqual([{ t: 'hold-bind', holdId: 'h1', id: T1, kind: 'permission', key: callKey('Bash', perm('Bash').body.tool_input), data: { rules: [{ toolName: 'Bash', ruleContent: 'node -e "console.log(6*7)"' }] } }])
    const card = status().asks[0]
    expect(card).toMatchObject({ key: 'h1', holdId: 'h1', kind: 'permission', toolId: 'toolu_fixture0941', agent: false, tool: 'Bash', state: 'open', always: { rule: 'Bash(node -e "console.log(6*7)")' } })
    expect(card.input).toEqual({ command: 'node -e "console.log(6*7)"', description: 'Run node to print 6*7' })
    expect(JSON.stringify(status())).not.toMatch(/localSettings/)
  })

  it('the Edit request binds with no rules (no 항상 허용) and a diff; the sub-agent\'s says so', async () => {
    const { lens, holds, status, run } = setup()
    lens.hook('PreToolUse', pre('Edit').body, 0)
    lens.hook('PermissionRequest', perm('Edit').body, 100, 'h2', T1)
    lens.hook('PermissionRequest', perm('PowerShell').body, 200, 'h3', T1)
    await run(10)
    expect(holds.map(h => [h.t, h.holdId, h.data])).toEqual([['hold-bind', 'h2', { rules: [] }], ['hold-bind', 'h3', { rules: [{ toolName: 'PowerShell', ruleContent: '(Get-Content notes.txt | Measure-Object -Line).Lines' }] }]])
    const [edit, agent] = status().asks
    expect(edit).toMatchObject({ kind: 'permission', tool: 'Edit', always: null, input: { file: `${CWD}\\src\\math.js` } })
    expect(edit.diff).toMatchObject({ kind: 'edit', added: 5, removed: 1 })
    expect(agent).toMatchObject({ agent: true, tool: 'PowerShell', toolId: null })
  })

  // (a whole plan of the main thread binds, answered from the chat with 승인 / 계속 계획하기)
  it('a plan binds as a permission with no rules; a question as a PermissionRequest passes, with no card; an unmapped session passes', async () => {
    const { lens, holds, status, run } = setup()
    lens.hook('PermissionRequest', perm('ExitPlanMode').body, 0, 'h4', T1)
    lens.hook('PermissionRequest', perm('AskUserQuestion').body, 10, 'h5', T1)
    lens.hook('PermissionRequest', { ...perm('Bash').body, session_id: '00000000-0000-4000-8000-000000000999' }, 20, 'h6', T1)
    lens.hook('PermissionRequest', { ...perm('Bash').body, session_id: 'not-a-session' }, 30, 'h7', T1)
    lens.hook('PermissionRequest', 'not an object' as any, 40, 'h8', T1)
    await run(10)
    expect(holds.map(h => [h.t, h.holdId ?? h.holdIds, h.why])).toEqual([['hold-bind', 'h4', undefined], ['hold-pass', 'h5', 'question'], ['hold-pass', 'h6', 'unmapped'], ['hold-pass', 'h7', 'unmapped'], ['hold-pass', 'h8', 'shape']])
    expect(holds[0]).toMatchObject({ kind: 'permission', data: { rules: [] } })
    expect(status().asks).toHaveLength(1)
    expect(status().asks[0]).toMatchObject({ kind: 'plan', holdId: 'h4', state: 'open', tool: 'ExitPlanMode' })
    expect(status().asks[0].input.plan).toMatch(/^# Plan: rename/)
  })

  it("a plan longer than the card shows, or a sub-agent's: passed, answered in the terminal", async () => {
    const { lens, holds, status, run } = setup()
    const body = perm('ExitPlanMode').body
    lens.hook('PermissionRequest', { ...body, tool_input: { ...body.tool_input, plan: 'x'.repeat(20_001) } }, 0, 'p1', T1)
    lens.hook('PermissionRequest', { ...body, agent_id: 'a1' }, 10, 'p2', T1)
    await run(10)
    expect(holds.map(h => [h.t, h.why])).toEqual([['hold-pass', 'plan'], ['hold-pass', 'plan']])
    expect(status().asks.map((a: any) => [a.holdId, a.state, a.cut ?? false])).toEqual([[null, 'terminal', true], [null, 'terminal', false]])
  })

  it('a request whose URL names another terminal than its session maps to: passed', async () => {
    const { lens, holds, run } = setup()
    lens.hook('PermissionRequest', perm('Bash').body, 0, 'h9', T2)
    await run(10)
    expect(holds).toEqual([{ t: 'hold-pass', holdId: 'h9', why: 'other-terminal' }])
  })

  it('a command too long to show whole: passed, and the card says it is answered in the terminal', async () => {
    const { lens, holds, status, run } = setup()
    const body = { ...perm('Bash').body, tool_input: { command: `echo ${'x'.repeat(20_001)}` } }
    lens.hook('PermissionRequest', body, 0, 'h10', T1)
    await run(10)
    expect(holds).toEqual([{ t: 'hold-pass', holdId: 'h10', why: 'too-long' }])
    expect(status().asks[0]).toMatchObject({ holdId: null, state: 'terminal', cut: true })
  })

  // (a multi-select and two questions are answered from the chat too)
  it('a single-select, a multi-select and two questions all bind, each with its labels per question', async () => {
    const { lens, holds, status, run } = setup()
    lens.hook('PreToolUse', Q[0].body, 0, 'q1', T1)
    lens.hook('PreToolUse', Q[1].body, 10, 'q2', T1)
    lens.hook('PreToolUse', Q[2].body, 20, 'q3', T1)
    await run(10)
    expect(holds[0]).toEqual({ t: 'hold-bind', holdId: 'q1', id: T1, kind: 'question', key: callKey('AskUserQuestion', Q[0].body.tool_input), data: { questions: Q[0].body.tool_input.questions, labels: ['Yes', 'No'], sets: [['Yes', 'No']], input: Q[0].body.tool_input } })
    for (const [k, h] of holds.slice(1).entries()) {
      const input = Q[k + 1].body.tool_input
      expect(h).toMatchObject({ t: 'hold-bind', holdId: `q${k + 2}`, kind: 'question', data: { sets: input.questions.map((q: any) => q.options.map((o: any) => o.label)) } })
    }
    const [one, multi, two] = status().asks
    expect(one).toMatchObject({ kind: 'question', holdId: 'q1', state: 'open', toolId: 'toolu_fixture0951', question: { text: 'Should README.md be updated too?', header: 'README', options: [{ label: 'Yes', description: 'Update the references to notes.txt.' }, { label: 'No', description: 'Only rename the file.' }] } })
    expect(one.questions).toBeUndefined()
    expect(multi).toMatchObject({ kind: 'question', holdId: 'q2', state: 'open', questions: [{ multiSelect: true }] })
    expect(two).toMatchObject({ kind: 'question', holdId: 'q3', state: 'open' })
    expect(two.questions).toHaveLength(2)
  })

  it('without a hold (a version out of the verified range), a request makes no card: the read-only lens as before', async () => {
    const { lens, holds, status, run } = setup()
    lens.hook('PreToolUse', pre('Bash').body, 0)
    lens.hook('PermissionRequest', perm('Bash').body, 100)
    await run(10)
    expect(holds).toEqual([])
    expect(status().asks).toBeUndefined()
    expect(status().state).toBe('waiting')
  })
})

describe('settled by what Claude Code did', () => {
  it('PostToolUse(Bash) resolves its hold; the card goes', async () => {
    const { lens, holds, status, run } = setup()
    lens.hook('PreToolUse', pre('Bash').body, 0)
    lens.hook('PermissionRequest', perm('Bash').body, 100, 'h1', T1)
    lens.hook('PostToolUse', P.find(h => h.event === 'PostToolUse')!.body, 9000)
    await run(10)
    expect(holds.at(-1)).toEqual({ t: 'hold-resolved', holdIds: ['h1'], why: 'post' })
    expect(status().asks).toBeUndefined()
  })

  it('two requests with one call key are both resolved by one PostToolUse', async () => {
    const { lens, holds, status, run } = setup()
    lens.hook('PreToolUse', pre('Bash', 1).body, 0)
    lens.hook('PermissionRequest', perm('Bash', 1).body, 10, 'a', T1)
    lens.hook('PermissionRequest', perm('Bash', 2).body, 20, 'b', T1)
    expect(status().asks).toHaveLength(2)
    lens.hook('PostToolUse', { ...pre('Bash', 1).body, hook_event_name: 'PostToolUse', tool_response: {} }, 30)
    await run(10)
    expect(holds.at(-1)).toEqual({ t: 'hold-resolved', holdIds: ['a', 'b'], why: 'post' })
    expect(status().asks).toBeUndefined()
  })

  it('a rejected call in the transcript resolves its card and the row is rejected', async () => {
    const { lens, holds, status, run, transcript, updates } = setup(R)
    writeFileSync(transcript(R), fixture('rejected.jsonl').split('\n').slice(0, 2).join('\n') + '\n')
    lens.open(T1)
    await run(50)
    const body = { ...perm('Bash').body, session_id: R, tool_input: { command: 'node -e "console.log(2)"', description: 'Print 2' } }
    lens.hook('PreToolUse', { ...body, hook_event_name: 'PreToolUse', tool_use_id: 'toolu_fixture0961' }, 0)
    lens.hook('PermissionRequest', body, 10, 'r1', T1)
    await run(10)
    expect(status().asks).toHaveLength(1)
    fs.appendFileSync(transcript(R), fixture('rejected.jsonl').split('\n').slice(2).join('\n'))
    await run(3000)
    expect(holds.some(h => h.t === 'hold-resolved' && h.holdIds.includes('r1'))).toBe(true)
    expect(status().asks).toBeUndefined()
    const row = updates.flatMap(u => u.ops).filter((o: any) => o.op === 'upsert').flatMap((o: any) => o.items).filter((i: any) => i.id === 'toolu_fixture0961').at(-1)
    expect(row.state).toBe('rejected')
  })

  it('Stop resolves everything open; a new turn too', async () => {
    const { lens, holds, status, run } = setup()
    lens.hook('PermissionRequest', perm('Bash').body, 0, 'x1', T1)
    lens.hook('PermissionRequest', perm('Edit').body, 0, 'x2', T1)
    lens.hook('Stop', { session_id: S, hook_event_name: 'Stop', last_assistant_message: '' }, 10)
    await run(10)
    expect(holds.at(-1)).toEqual({ t: 'hold-resolved', holdIds: ['x1', 'x2'], why: 'stop' })
    expect(status().asks).toBeUndefined()
    lens.hook('PermissionRequest', perm('Bash').body, 20, 'x3', T1)
    lens.hook('UserPromptSubmit', { session_id: S, hook_event_name: 'UserPromptSubmit', prompt: 'next' }, 30)
    await run(10)
    expect(holds.at(-1)).toEqual({ t: 'hold-resolved', holdIds: ['x3'], why: 'turn' })
  })

  it('the terminal leaving the list resolves its holds', async () => {
    const { lens, holds, run } = setup()
    lens.hook('PermissionRequest', perm('Bash').body, 0, 'g1', T1)
    lens.setTerminals([{ id: T2, cwd: CWD, armed: true, status: 'running' }])
    await run(10)
    expect(holds.at(-1)).toEqual({ t: 'hold-resolved', holdIds: ['g1'], why: 'gone' })
  })

  it('hold-state changes only the card\'s state', async () => {
    const { lens, status, run } = setup()
    lens.hook('PermissionRequest', perm('Bash').body, 0, 's1', T1)
    lens.hook('PermissionRequest', perm('Edit').body, 0, 's2', T1)
    lens.hook('PermissionRequest', perm('PowerShell').body, 0, 's3', T1)
    await run(10)
    const before = status().asks.map((c: any) => ({ ...c, state: undefined, sent: undefined }))
    lens.holdState('s1', 'sent', 'always')
    lens.holdState('s2', 'timeout')
    lens.holdState('s3', 'terminal')
    lens.holdState('nobody', 'sent', 'allow')
    await run(10)
    const after = status().asks
    expect(after.map((c: any) => [c.state, c.sent])).toEqual([['sent', 'always'], ['timeout', undefined], ['terminal', undefined]])
    expect(after.map((c: any) => ({ ...c, state: undefined, sent: undefined }))).toEqual(before)
  })
})
