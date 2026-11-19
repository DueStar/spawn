/**
 * electron/chatLens.cjs — regression tests for reviewed issues (IDs label the tests): a
 * provisional bubble ends with its turn (C1), the canary is anchored at the
 * turn's own prompt and compares strictly (I1), a tab reopened under the same
 * id starts afresh (I2), resync keeps the banners (I5), and the minor ones
 * (M2–M5, M9, M12, M14, M16–M18, M20). Each test reproduces its issue.
 */

import fs, { appendFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fixture, hooksOf, linesOf } from './chat-helpers'

const require = createRequire(import.meta.url)
const { createLens, transcriptAllowed } = require('../electron/chatLens.cjs')
const { callKey } = require('../hooks/spawn-hook.cjs')

const PROJECT = 'C--Users-user-work-demo'
const CWD = 'C:\\Users\\user\\work\\demo'
const T1 = '11111111-1111-4111-8111-111111111111'
const T2 = '22222222-2222-4222-8222-222222222222'
const X = '00000000-0000-4000-8000-000000000990'

const dirs: string[] = []
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }) })
const tempDir = () => { const d = mkdtempSync(join(tmpdir(), 'spawn-chat-review-')); dirs.push(d); return d }

beforeEach(() => { vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] }); vi.setSystemTime(new Date('2026-11-14T12:00:00Z')) })
afterEach(() => { vi.useRealTimers() })

function setup(opts: Record<string, unknown> = {}) {
  const claudeDir = tempDir()
  const userDataDir = tempDir()
  mkdirSync(join(claudeDir, 'projects', PROJECT), { recursive: true })
  mkdirSync(join(userDataDir, 'session-links'), { recursive: true })
  const updates: any[] = []
  const logs: any[] = []
  const realpaths: string[] = []
  const spyFs = { ...fs, promises: { ...fs.promises, realpath: (p: string) => { realpaths.push(String(p)); return fs.promises.realpath(p) } } }
  const lens = createLens({ claudeDir, userDataDir, fs: spyFs, emit: (u: any) => updates.push(u), callKey, watch: () => null, log: (level: string, msg: string) => logs.push({ level, msg }), ...opts })
  const transcript = (sid: string) => join(claudeDir, 'projects', PROJECT, `${sid}.jsonl`)
  const link = (term: string, sid: string) => writeFileSync(join(userDataDir, 'session-links', term), sid)
  const run = async (ms: number) => { for (let t = 0; t < ms; t += 10) { vi.advanceTimersByTime(Math.min(10, ms - t)); await lens.idle() } await lens.idle() }
  /** what a page holding every update would show now (reset / upsert / remove replayed), per terminal */
  const view = (id: string) => {
    const items = new Map<string, any>()
    let status: any = null
    for (const u of updates.filter(x => x.id === id)) {
      for (const op of u.ops) {
        if (op.op === 'reset') { items.clear(); for (const i of op.items) items.set(i.id, i); status = op.status }
        if (op.op === 'upsert') for (const i of op.items) items.set(i.id, i)
        if (op.op === 'remove') for (const i of op.ids) items.delete(i)
        if (op.op === 'status') status = op.status
      }
    }
    return { items: [...items.values()], status }
  }
  return { claudeDir, userDataDir, updates, logs, realpaths, lens, transcript, link, run, view }
}

const term = (id: string, extra: Record<string, unknown> = {}) => ({ id, cwd: CWD, armed: true, status: 'running', ...extra })
const user = (uuid: string, text: string) => JSON.stringify({ parentUuid: null, isSidechain: false, type: 'user', message: { role: 'user', content: text }, uuid, timestamp: '2026-11-14T12:00:01.000Z' }) + '\n'
const said = (uuid: string, text: string, stop: string | null = 'end_turn') => JSON.stringify({ parentUuid: null, isSidechain: false, message: { model: 'm', id: 'msg_fixture90', type: 'message', role: 'assistant', content: [{ type: 'text', text }], stop_reason: stop }, type: 'assistant', uuid, timestamp: '2026-11-14T12:00:02.000Z' }) + '\n'
const calls = (uuid: string, id: string, name = 'Bash', extra: Record<string, unknown> = {}) => JSON.stringify({ parentUuid: null, isSidechain: false, message: { model: 'm', id: 'msg_fixture91', type: 'message', role: 'assistant', content: [{ type: 'tool_use', id, name, input: { command: 'npm test' } }], stop_reason: 'tool_use' }, type: 'assistant', uuid, timestamp: '2026-11-14T12:00:02.000Z', ...extra }) + '\n'
const interruptLine = (uuid: string) => JSON.stringify({ parentUuid: null, isSidechain: false, type: 'user', message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user]' }] }, uuid, timestamp: '2026-11-14T12:00:03.000Z' }) + '\n'
const turnEnd = (uuid: string) => JSON.stringify({ parentUuid: null, isSidechain: false, type: 'system', subtype: 'turn_duration', durationMs: 1000, uuid, timestamp: '2026-11-14T12:00:04.000Z' }) + '\n'
const U = (n: number) => `00000000-0000-4000-8000-0000000007${String(n).padStart(2, '0')}`

const base = (sid: string, event: string, extra: Record<string, unknown> = {}) => ({ session_id: sid, transcript_path: 'C:\\Users\\user\\.claude\\projects\\x.jsonl', cwd: CWD, hook_event_name: event, ...extra })
const md = (sid: string, mid: string, index: number, delta: string, extra: Record<string, unknown> = {}) => base(sid, 'MessageDisplay', { message_id: mid, index, final: false, delta, ...extra })

/** a session open in the lens, its file starting with `start` */
async function openWith(start: string, sid = T1, opts: Record<string, unknown> = {}) {
  const s = setup(opts)
  writeFileSync(s.transcript(sid), start)
  s.lens.setTerminals([term(sid)])
  s.lens.open(sid)
  await s.run(20)
  return s
}
const liveItems = (s: ReturnType<typeof setup>, id = T1) => s.view(id).items.filter((i: any) => i.kind === 'live')

describe('C1: a provisional bubble lives only within its turn', () => {
  it('StopFailure after MessageDisplay (an API error instead of the answer): no bubble left, a remove sent', async () => {
    const s = await openWith(user(U(1), 'hi') + said(U(2), 'First answer, long enough to be a real one.'))
    s.lens.hook('UserPromptSubmit', base(T1, 'UserPromptSubmit', { prompt: 'q' }), Date.now())
    appendFileSync(s.transcript(T1), user(U(3), 'q'))
    s.lens.hook('MessageDisplay', md(T1, 'm1', 0, 'Here is the start of an answer that was cut off\n'), Date.now())
    await s.run(10)
    expect(liveItems(s)).toHaveLength(1)
    s.lens.hook('StopFailure', base(T1, 'StopFailure', { error: 'overloaded', last_assistant_message: 'API Error: 529 overloaded' }), Date.now())
    appendFileSync(s.transcript(T1), said(U(4), 'API Error: 529 overloaded'))
    await s.run(4000)
    expect(liveItems(s)).toEqual([])
    expect(s.updates.flatMap(u => u.ops).some((o: any) => o.op === 'remove' && o.ids.includes('live:m1'))).toBe(true)
    // a later turn: nothing provisional below it
    s.lens.hook('UserPromptSubmit', base(T1, 'UserPromptSubmit', { prompt: 'next' }), Date.now())
    appendFileSync(s.transcript(T1), user(U(5), 'next') + said(U(6), 'A completely different later answer.'))
    await s.run(1500)
    expect(s.view(T1).items.map((i: any) => i.kind).at(-1)).toBe('text')
  })

  it('Esc early in a reply (a short line): the bubble goes with the interrupt', async () => {
    const s = await openWith(user(U(1), 'hi'))
    s.lens.hook('UserPromptSubmit', base(T1, 'UserPromptSubmit', { prompt: 'go' }), Date.now())
    s.lens.hook('MessageDisplay', md(T1, 'm2', 0, 'Sure, let me check.\n'), Date.now())
    await s.run(10)
    expect(liveItems(s)).toHaveLength(1)
    appendFileSync(s.transcript(T1), user(U(2), 'go') + said(U(3), 'Sure, let me', null) + interruptLine(U(4)))
    await s.run(1100)
    expect(liveItems(s)).toEqual([])
  })

  it('a bubble left over from an earlier turn goes at the next prompt; a turn end takes one too', async () => {
    const s = await openWith(user(U(1), 'hi'))
    s.lens.hook('MessageDisplay', md(T1, 'm3', 0, 'Streaming text that never lands anywhere.\n'), Date.now())
    await s.run(10)
    expect(liveItems(s)).toHaveLength(1)
    s.lens.hook('UserPromptSubmit', base(T1, 'UserPromptSubmit', { prompt: 'again' }), Date.now())
    await s.run(10)
    expect(liveItems(s)).toEqual([])
    s.lens.hook('MessageDisplay', md(T1, 'm4', 0, 'Another stream that never lands either.\n'), Date.now())
    await s.run(10)
    appendFileSync(s.transcript(T1), turnEnd(U(9)))
    await s.run(1100)
    expect(liveItems(s)).toEqual([])
  })

  it('MessageDisplay from a sub-agent (agent_id) makes no bubble in the main conversation', async () => {
    const s = await openWith(user(U(1), 'hi'))
    s.lens.hook('MessageDisplay', md(T1, 'm5', 0, 'A sub-agent talking to itself here.\n', { agent_id: 'afixture01' }), Date.now())
    await s.run(10)
    expect(liveItems(s)).toEqual([])
  })
})

describe('I1: the canary is anchored at the turn\'s own prompt and compares strictly', () => {
  const EARLIER = 'All tests pass now and the build is green again.'

  for (const withPromptLine of [true, false]) {
    it(`opened mid-turn, an earlier identical answer does not satisfy it (${withPromptLine ? 'the prompt line written' : 'no prompt line yet'})`, async () => {
      const s = setup()
      writeFileSync(s.transcript(T1), user(U(1), 'run the tests') + said(U(2), EARLIER))
      s.lens.setTerminals([term(T1)])
      // the prompt while the view is closed
      s.lens.hook('UserPromptSubmit', base(T1, 'UserPromptSubmit', { prompt: 'run them again' }), Date.now())
      if (withPromptLine) appendFileSync(s.transcript(T1), user(U(3), 'run them again'))
      s.lens.open(T1)
      await s.run(20)
      s.lens.hook('Stop', base(T1, 'Stop', { last_assistant_message: EARLIER }), Date.now())
      await s.run(3200)
      expect(s.view(T1).status.banner).toEqual({ reason: 'canary' })
    })
  }

  it('the same, with the view open before the prompt (the control): the canary banner', async () => {
    const s = await openWith(user(U(1), 'run the tests') + said(U(2), EARLIER))
    s.lens.hook('UserPromptSubmit', base(T1, 'UserPromptSubmit', { prompt: 'run them again' }), Date.now())
    appendFileSync(s.transcript(T1), user(U(3), 'run them again'))
    await s.run(300)
    s.lens.hook('Stop', base(T1, 'Stop', { last_assistant_message: EARLIER }), Date.now())
    await s.run(3200)
    expect(s.view(T1).status.banner).toEqual({ reason: 'canary' })
  })

  it('an earlier text of the turn that is a prefix of the final message does not satisfy it', async () => {
    const s = await openWith(user(U(1), 'hi'))
    s.lens.hook('UserPromptSubmit', base(T1, 'UserPromptSubmit', { prompt: 'test it' }), Date.now())
    appendFileSync(s.transcript(T1), user(U(2), 'test it') + said(U(3), "I'll run the whole test suite now."))
    await s.run(300)
    s.lens.hook('Stop', base(T1, 'Stop', { last_assistant_message: "I'll run the whole test suite now. All 42 tests pass." }), Date.now())
    await s.run(3200)
    expect(s.view(T1).status.banner).toEqual({ reason: 'canary' })
  })

  it('opened mid-turn, the real answer arriving after Stop still passes', async () => {
    const s = setup()
    writeFileSync(s.transcript(T1), user(U(1), 'run the tests') + said(U(2), EARLIER))
    s.lens.setTerminals([term(T1)])
    s.lens.hook('UserPromptSubmit', base(T1, 'UserPromptSubmit', { prompt: 'and now?' }), Date.now())
    s.lens.open(T1)
    await s.run(20)
    s.lens.hook('Stop', base(T1, 'Stop', { last_assistant_message: 'Now 43 tests pass and the build is green.' }), Date.now())
    await s.run(200)
    appendFileSync(s.transcript(T1), user(U(3), 'and now?') + said(U(4), 'Now 43 tests pass and the build is green.'))
    await s.run(3200)
    expect(s.view(T1).status.banner).toBeNull()
  })

  it('a tool-only turn: the prompt line alone is not growth (M7)', async () => {
    const s = await openWith(user(U(1), 'hi'))
    s.lens.hook('UserPromptSubmit', base(T1, 'UserPromptSubmit', { prompt: 'just run it' }), Date.now())
    appendFileSync(s.transcript(T1), user(U(2), 'just run it'))
    await s.run(300)
    s.lens.hook('Stop', base(T1, 'Stop', { last_assistant_message: '' }), Date.now())
    await s.run(3200)
    expect(s.view(T1).status.banner).toEqual({ reason: 'canary' })
  })
})

describe('I2: a tab reopened under the same id starts afresh', () => {
  it('running → exited → running: not "ended" any more; a prompt makes it working', async () => {
    const s = setup()
    writeFileSync(s.transcript(T1), user(U(1), 'hi'))
    s.lens.setTerminals([term(T1)])
    s.lens.setTerminals([term(T1, { status: 'exited' })])
    s.lens.setTerminals([term(T1)])
    s.lens.open(T1)
    await s.run(20)
    s.lens.hook('UserPromptSubmit', base(T1, 'UserPromptSubmit', { prompt: 'go' }), Date.now())
    await s.run(10)
    expect(s.view(T1).status.state).toBe('working')
  })

  it('a new createdAt for the same id is a new session: an open view gets a fresh reset', async () => {
    const s = setup()
    writeFileSync(s.transcript(T1), user(U(1), 'hi'))
    s.lens.setTerminals([term(T1, { createdAt: 1 })])
    s.lens.open(T1)
    await s.run(20)
    s.lens.hook('UserPromptSubmit', base(T1, 'UserPromptSubmit', { prompt: 'x' }), Date.now())
    await s.run(10)
    const resets = () => s.updates.flatMap(u => u.ops).filter((o: any) => o.op === 'reset').length
    const before = resets()
    s.lens.setTerminals([term(T1, { createdAt: 2 })])
    await s.run(20)
    expect(resets()).toBe(before + 1)
    expect(s.view(T1).status.state).toBe('idle')
  })
})

describe('I5: resync re-sends the current view and keeps the banners; reload clears them', () => {
  it('a canary banner survives a resync, not a reload', async () => {
    const s = await openWith(user(U(1), 'hi'))
    s.lens.hook('UserPromptSubmit', base(T1, 'UserPromptSubmit', { prompt: 'q' }), Date.now())
    s.lens.hook('Stop', base(T1, 'Stop', { last_assistant_message: 'An answer that never reaches the file.' }), Date.now())
    await s.run(3200)
    expect(s.view(T1).status.banner).toEqual({ reason: 'canary' })
    const n = s.updates.length
    expect(await s.lens.resync(T1)).toEqual({ ok: true })
    await s.run(10)
    const reset = s.updates.slice(n).flatMap(u => u.ops).find((o: any) => o.op === 'reset')
    expect(reset.status.banner).toEqual({ reason: 'canary' })
    expect(reset.items.map((i: any) => i.id)).toEqual(s.view(T1).items.map((i: any) => i.id))
    await s.lens.reload(T1)
    await s.run(10)
    expect(s.view(T1).status.banner).toBeNull()
  })

  it('resync of a view not open sends its status', async () => {
    const s = setup()
    s.lens.setTerminals([term(T1)])
    const n = s.updates.length
    await s.lens.resync(T1)
    expect(s.updates.slice(n).flatMap(u => u.ops).map((o: any) => o.op)).toEqual(['status'])
  })
})

describe('minor ones', () => {
  it('M2: an exited tab that had the same conversation does not put a mapping banner on the live one', async () => {
    const s = setup()
    s.link(T1, X); s.link(T2, X)
    writeFileSync(s.transcript(X), user(U(1), 'hi'))
    s.lens.setTerminals([term(T1, { status: 'exited' }), term(T2)])
    s.lens.open(T2)
    await s.run(20)
    s.lens.hook('UserPromptSubmit', base(X, 'UserPromptSubmit', { prompt: 'go' }), Date.now())
    await s.run(10)
    expect(s.view(T2).status).toMatchObject({ banner: null, state: 'working' })
  })

  it('M3: an older page never deletes a streaming bubble behind the page\'s back', async () => {
    const REPEAT = 'This answer appears early in the file and again now.'
    let file = user(U(1), 'first') + said(U(2), REPEAT)
    for (let i = 0; i < 160; i++) file += user(`00000000-0000-4000-8000-00000001${String(i).padStart(4, '0')}`, `filler ${i}`)
    const s = await openWith(file)
    s.lens.hook('MessageDisplay', md(T1, 'm6', 0, REPEAT + '\n'), Date.now())
    await s.run(10)
    expect(liveItems(s)).toHaveLength(1)
    await s.lens.older(T1)
    await s.run(10)
    expect(liveItems(s)).toHaveLength(1)
    // flipped away and back within the minute: the view kept is the one the page had
    s.lens.close(T1)
    s.lens.open(T1)
    await s.run(10)
    const reset = s.updates.flatMap(u => u.ops).filter((o: any) => o.op === 'reset').at(-1)
    expect(reset.items.some((i: any) => i.id === 'live:m6')).toBe(true)
  })

  it('M4: an interrupt leaves a sub-agent\'s rows alone', async () => {
    const s = setup()
    const sid = '00000000-0000-4000-8000-000000000904'
    writeFileSync(s.transcript(sid), linesOf('agent.jsonl').slice(0, 3).map(l => l.text).join('\n') + '\n')
    const sub = join(s.claudeDir, 'projects', PROJECT, sid, 'subagents')
    mkdirSync(sub, { recursive: true })
    // bookkeeping first, so the row's offset in its own file is past the main file's turn start (an order from another file)
    writeFileSync(join(sub, 'agent-afixture01.jsonl'), JSON.stringify({ type: 'attachment', attachment: { type: 'skill_listing', content: 's'.repeat(20000) } }) + '\n' + calls(U(30), 'toolu_fixture77', 'PowerShell', { isSidechain: true }))
    s.lens.setTerminals([term(sid)])
    s.lens.open(sid)
    await s.run(20)
    await s.lens.agent(sid, 'toolu_fixture41')
    await s.run(10)
    expect(s.view(sid).items.find((i: any) => i.id === 'toolu_fixture77').state).toBe('running')
    s.lens.hook('UserPromptSubmit', base(sid, 'UserPromptSubmit', { prompt: 'x' }), Date.now())
    appendFileSync(s.transcript(sid), user(U(31), 'x') + interruptLine(U(32)))
    await s.run(1100)
    expect(s.view(sid).items.find((i: any) => i.id === 'toolu_fixture77').state).toBe('running')
  })

  it('M5: a partial text alone (no interrupt line) neither interrupts the rows nor ends the turn', async () => {
    const s = await openWith(user(U(1), 'hi'))
    s.lens.hook('UserPromptSubmit', base(T1, 'UserPromptSubmit', { prompt: 'go' }), Date.now())
    appendFileSync(s.transcript(T1), user(U(2), 'go') + calls(U(3), 'toolu_fixture78'))
    await s.run(300)
    appendFileSync(s.transcript(T1), said(U(4), 'Part of a reply cut by a retry', null))
    await s.run(1100)
    const v = s.view(T1)
    expect(v.items.find((i: any) => i.id === 'toolu_fixture78').state).toBe('running')
    expect(v.status.state).toBe('working')
  })

  it('M6: PostToolUseFailure with is_interrupt marks the row interrupted', async () => {
    const s = await openWith(user(U(1), 'hi'))
    const pre = hooksOf('hooks-tools.jsonl')[4].body
    s.lens.hook('PreToolUse', { ...pre, session_id: T1 }, Date.now())
    s.lens.hook('PostToolUseFailure', { ...hooksOf('hooks-tools.jsonl')[5].body, session_id: T1, is_interrupt: true }, Date.now())
    await s.run(10)
    expect(s.view(T1).items.find((i: any) => i.id === 'toolu_fixture05').state).toBe('interrupted')
  })

  it('M8: one unknown line in a new session is not yet a schema banner; a window of 20 is', async () => {
    const odd = (n: number) => JSON.stringify({ type: 'hologram', uuid: `00000000-0000-4000-8000-0000000008${String(n).padStart(2, '0')}` }) + '\n'
    const s = await openWith(odd(0))
    expect(s.view(T1).status.banner).toBeNull()
    let more = ''
    for (let i = 1; i < 25; i++) more += odd(i)
    appendFileSync(s.transcript(T1), more)
    await s.run(1100)
    expect(s.view(T1).status.banner?.reason).toBe('schema')
  })

  it('M9: a transcript that disappears: the missing banner, logged once, without its path', async () => {
    const s = await openWith(user(U(1), 'hi'))
    unlinkSync(s.transcript(T1))
    await s.run(5000)
    expect(s.view(T1).status.banner).toEqual({ reason: 'missing' })
    const errs = s.logs.filter(l => l.level === 'error')
    expect(errs.length).toBeLessThanOrEqual(1)
    for (const l of s.logs) expect(l.msg).not.toContain(PROJECT)
  })

  it('M9: a load that fails sends a reset with a banner (the page never waits forever)', async () => {
    const s = setup({ fs: { ...fs, promises: { ...fs.promises, open: async () => { throw Object.assign(new Error('EACCES: denied, open \'x\''), { code: 'EACCES' }) } } } })
    writeFileSync(s.transcript(T1), user(U(1), 'hi'))
    s.lens.setTerminals([term(T1)])
    s.lens.open(T1)
    await s.run(20)
    const reset = s.updates.flatMap(u => u.ops).find((o: any) => o.op === 'reset')
    expect(reset).toBeTruthy()
    expect(reset.status.banner).toBeTruthy()
  })

  it('M12: the worker keeps at most 4000 items of a view (the oldest go, hasOlder says so)', async () => {
    const s = await openWith(user(U(1), 'hi'))
    let lots = ''
    for (let i = 0; i < 4100; i++) lots += user(`00000000-0000-4000-8000-0000002${String(i).padStart(5, '0')}`, `line ${i}`)
    appendFileSync(s.transcript(T1), lots)
    await s.run(1100)
    const v = s.view(T1)
    expect(v.items.length).toBeLessThanOrEqual(4000)
    expect(v.status.hasOlder).toBe(true)
    expect(v.items.at(-1).text).toBe('line 4099')
  })

  it('M14: a UNC or outside path is refused before any realpath', async () => {
    const s = setup()
    expect(await transcriptAllowed('\\\\host\\share\\x.jsonl', s.claudeDir, { ...fs, promises: { ...fs.promises, realpath: (p: string) => { s.realpaths.push(p); return fs.promises.realpath(p) } } })).toBe(false)
    expect(await transcriptAllowed(join(tmpdir(), 'elsewhere.jsonl'), s.claudeDir, { ...fs, promises: { ...fs.promises, realpath: (p: string) => { s.realpaths.push(p); return fs.promises.realpath(p) } } })).toBe(false)
    expect(s.realpaths).toEqual([])
  })

  it('M16: Stop clears a waiting row; a new prompt forgets old calls', async () => {
    const s = await openWith(user(U(1), 'hi'))
    const hooks = hooksOf('hooks-tools.jsonl')
    s.lens.hook('PreToolUse', { ...hooks[1].body, session_id: T1 }, Date.now())
    s.lens.hook('PermissionRequest', { ...hooks[2].body, session_id: T1 }, Date.now())
    await s.run(10)
    expect(s.view(T1).items.find((i: any) => i.id === 'toolu_fixture07').waiting).toBe('permission')
    s.lens.hook('Stop', base(T1, 'Stop', { last_assistant_message: '' }), Date.now())
    await s.run(10)
    expect(s.view(T1).items.find((i: any) => i.id === 'toolu_fixture07').waiting).toBeUndefined()
    s.lens.hook('UserPromptSubmit', base(T1, 'UserPromptSubmit', { prompt: 'q' }), Date.now())
    s.lens.hook('PermissionRequest', { ...hooks[2].body, session_id: T1 }, Date.now())
    await s.run(10)
    expect(s.view(T1).items.find((i: any) => i.id === 'toolu_fixture07').waiting).toBeUndefined()
  })

  it('M17: a reload in the middle of a stream: the rest of the message still shows', async () => {
    const s = await openWith(user(U(1), 'hi'))
    s.lens.hook('MessageDisplay', md(T1, 'm7', 0, 'Line one of a long message.\n'), Date.now())
    s.lens.hook('MessageDisplay', md(T1, 'm7', 1, 'Line two of a long message.\n'), Date.now())
    await s.run(10)
    await s.lens.reload(T1)
    await s.run(10)
    s.lens.hook('MessageDisplay', md(T1, 'm7', 2, 'Line three of a long message.\n'), Date.now())
    await s.run(10)
    expect(liveItems(s).map((i: any) => i.text)).toEqual(['Line three of a long message.\n'])
  })

  it('M18: a hook body that throws in a handler is dropped, the lens goes on', async () => {
    const s = await openWith(user(U(1), 'hi'))
    const evil = { session_id: T1, tool_name: 'Read', tool_use_id: 'toolu_fixture79', get tool_input() { throw new Error('boom') } }
    expect(() => s.lens.hook('PreToolUse', evil, Date.now())).not.toThrow()
    expect(() => s.lens.hook('PreToolUse', evil, Date.now())).not.toThrow()
    expect(s.logs.filter(l => l.msg.includes('PreToolUse')).length).toBe(1)
    s.lens.hook('UserPromptSubmit', base(T1, 'UserPromptSubmit', { prompt: 'still here' }), Date.now())
    await s.run(10)
    expect(s.view(T1).status.state).toBe('working')
  })
})

describe('M20: links out of the projects folder', () => {
  it('a junction (or directory link) inside projects pointing outside is refused; a file symlink too', async () => {
    const s = setup()
    const outside = tempDir()
    writeFileSync(join(outside, `${X}.jsonl`), fixture('basic.jsonl'))
    symlinkSync(outside, join(s.claudeDir, 'projects', 'escape'), 'junction')
    expect(await transcriptAllowed(join(s.claudeDir, 'projects', 'escape', `${X}.jsonl`), s.claudeDir, fs)).toBe(false)
    let fileLink = true
    try { symlinkSync(join(outside, `${X}.jsonl`), join(s.claudeDir, 'projects', PROJECT, `${X}.jsonl`), 'file') } catch { fileLink = false }
    if (fileLink) expect(await transcriptAllowed(join(s.claudeDir, 'projects', PROJECT, `${X}.jsonl`), s.claudeDir, fs)).toBe(false)
  })
})

// ---------------------------------------------------------------- a second round of fixes

const summaryLine = (uuid: string, extra: Record<string, unknown> = { isCompactSummary: true, isVisibleInTranscriptOnly: true }) => JSON.stringify({ parentUuid: null, isSidechain: false, type: 'user', message: { role: 'user', content: 'This session is being continued from a previous conversation that ran out of context. The summary below covers the earlier portion.\n\nSummary: made-up work.' }, uuid, timestamp: '2026-11-14T12:00:01.000Z', ...extra }) + '\n'

describe('re-review: a prompt typed while Claude works (UserPromptSubmit mid-turn)', () => {
  it('keeps the message streaming now: its bubble, its stream position, no remove', async () => {
    const s = await openWith(user(U(1), 'hi'))
    s.lens.hook('UserPromptSubmit', base(T1, 'UserPromptSubmit', { prompt: 'go' }), Date.now())
    appendFileSync(s.transcript(T1), user(U(2), 'go'))
    s.lens.hook('MessageDisplay', md(T1, 'm1', 0, 'Part one of a long answer that keeps going.\n'), Date.now())
    await s.run(10)
    expect(liveItems(s).map((i: any) => i.text)).toEqual(['Part one of a long answer that keeps going.\n'])
    const before = s.updates.length
    // the user types and sends while the answer streams
    s.lens.hook('UserPromptSubmit', base(T1, 'UserPromptSubmit', { prompt: 'and also this' }), Date.now())
    s.lens.hook('MessageDisplay', md(T1, 'm1', 1, 'Part two of the same answer.\n'), Date.now())
    await s.run(10)
    expect(liveItems(s).map((i: any) => i.text)).toEqual(['Part one of a long answer that keeps going.\nPart two of the same answer.\n'])
    expect(s.updates.slice(before).flatMap(u => u.ops).some((o: any) => o.op === 'remove')).toBe(false)
    expect(s.view(T1).status.state).toBe('working')
  })

  it('keeps the turn\'s open calls (a permission after it still finds its row) and arms no missing check', async () => {
    const s = await openWith(user(U(1), 'hi'))
    const hooks = hooksOf('hooks-tools.jsonl')
    s.lens.hook('UserPromptSubmit', base(T1, 'UserPromptSubmit', { prompt: 'go' }), Date.now())
    appendFileSync(s.transcript(T1), user(U(2), 'go'))
    await s.run(300)
    s.lens.hook('PreToolUse', { ...hooks[1].body, session_id: T1 }, Date.now())
    s.lens.hook('UserPromptSubmit', base(T1, 'UserPromptSubmit', { prompt: 'queued' }), Date.now())
    s.lens.hook('PermissionRequest', { ...hooks[2].body, session_id: T1 }, Date.now())
    await s.run(10)
    expect(s.view(T1).items.find((i: any) => i.id === 'toolu_fixture07').waiting).toBe('permission')
    // a long wait on the user: the file stands still, and no missing banner comes of the queued prompt
    await s.run(8000)
    expect(s.view(T1).status.banner).toBeNull()
  })

  it('after the turn ends a prompt is a new turn again: the last turn\'s bubble goes', async () => {
    const s = await openWith(user(U(1), 'hi'))
    s.lens.hook('UserPromptSubmit', base(T1, 'UserPromptSubmit', { prompt: 'go' }), Date.now())
    s.lens.hook('StopFailure', base(T1, 'StopFailure', { error: 'x' }), Date.now())
    s.lens.hook('MessageDisplay', md(T1, 'm3', 0, 'A stray bubble with no turn of its own.\n'), Date.now())
    await s.run(10)
    expect(liveItems(s)).toHaveLength(1)
    s.lens.hook('UserPromptSubmit', base(T1, 'UserPromptSubmit', { prompt: 'next' }), Date.now())
    await s.run(10)
    expect(liveItems(s)).toEqual([])
  })
})

describe('re-review: a compaction summary is a quiet notice, never the user\'s message', () => {
  it('marked isCompactSummary, or known by its words: a summary notice', async () => {
    const s = await openWith(user(U(1), 'hi') + summaryLine(U(2)) + summaryLine(U(3), {}) + said(U(4), 'Carrying on.'))
    const items = s.view(T1).items
    expect(items.filter((i: any) => i.kind === 'user').map((i: any) => i.text)).toEqual(['hi'])
    expect(items.filter((i: any) => i.kind === 'notice').map((i: any) => i.notice)).toEqual(['summary', 'summary'])
  })
})

describe('re-review m-1: a poll that fails once is not a stopped reader', () => {
  it('two failed polls: no banner, reading goes on; three in a row: the worker banner', async () => {
    let fail = 0
    const s = setup({ fs: { ...fs, promises: { ...fs.promises, stat: async (p: string) => { if (fail > 0) { fail--; throw Object.assign(new Error('EBUSY: resource busy'), { code: 'EBUSY' }) } return fs.promises.stat(p) } } } })
    writeFileSync(s.transcript(T1), user(U(1), 'hi'))
    s.lens.setTerminals([term(T1)])
    s.lens.open(T1)
    await s.run(20)
    fail = 2
    appendFileSync(s.transcript(T1), said(U(2), 'An answer that arrives while the file is held.'))
    await s.run(2100)
    expect(s.view(T1).status.banner).toBeNull()
    await s.run(1100)
    expect(s.view(T1).items.some((i: any) => i.kind === 'text')).toBe(true)
    expect(s.view(T1).status.banner).toBeNull()
    fail = 3
    await s.run(3100)
    expect(s.view(T1).status.banner).toEqual({ reason: 'worker' })
    expect(s.logs.filter(l => l.msg.includes('EBUSY'))).toHaveLength(1)
  })
})

describe('re-review m-4: a relaunched terminal\'s old state is let go', () => {
  it('a load in flight on the old state sends nothing and follows nothing', async () => {
    let release: () => void = () => {}
    const gate = new Promise<void>(r => { release = r })
    let gated = true
    let stats = 0
    const s = setup({ fs: { ...fs, promises: { ...fs.promises,
      open: async (...a: any[]) => { if (gated) { gated = false; await gate } return (fs.promises.open as any)(...a) },
      stat: async (p: string) => { stats++; return fs.promises.stat(p) },
    } } })
    writeFileSync(s.transcript(T1), user(U(1), 'hi'))
    s.lens.setTerminals([term(T1, { createdAt: 1 })])
    s.lens.open(T1)
    // (not s.run: lens.idle would wait for the held load) the old load waits inside open()
    while (gated) await new Promise(r => setImmediate(r))
    s.lens.setTerminals([term(T1, { createdAt: 2 })])
    release()
    await s.run(50)
    const resets = s.updates.flatMap(u => u.ops).filter((o: any) => o.op === 'reset')
    expect(resets).toHaveLength(1)
    stats = 0
    await s.run(5000)
    // one state polls (about once a second while idle), not two
    expect(stats).toBeLessThanOrEqual(6)
    expect(stats).toBeGreaterThanOrEqual(4)
  })
})

describe('re-review m-10: whose wait it is', () => {
  it('a sub-agent\'s permission names the sub-agent; the main thread\'s own does not; the end of the wait clears it', async () => {
    const s = await openWith(user(U(1), 'hi'))
    s.lens.hook('UserPromptSubmit', base(T1, 'UserPromptSubmit', { prompt: 'go' }), Date.now())
    s.lens.hook('PermissionRequest', base(T1, 'PermissionRequest', { agent_id: 'afixture01', tool_name: 'Bash', tool_input: { command: 'ls' } }), Date.now())
    await s.run(10)
    expect(s.view(T1).status).toMatchObject({ state: 'waiting', waitingAgent: 'afixture01' })
    s.lens.hook('PermissionRequest', base(T1, 'PermissionRequest', { tool_name: 'Bash', tool_input: { command: 'pwd' } }), Date.now())
    await s.run(10)
    expect(s.view(T1).status.waitingAgent).toBeUndefined()
    s.lens.hook('PermissionRequest', base(T1, 'PermissionRequest', { agent_id: 'afixture01', tool_name: 'Bash', tool_input: { command: 'ls' } }), Date.now())
    s.lens.hook('Stop', base(T1, 'Stop', { last_assistant_message: '' }), Date.now())
    await s.run(10)
    expect(s.view(T1).status.state).toBe('idle')
    expect(s.view(T1).status.waitingAgent).toBeUndefined()
  })
})
