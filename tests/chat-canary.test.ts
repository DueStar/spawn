/**
 * electron/chatLens.cjs, part two — when the lens cannot be sure, it says so:
 * the canary (a finished turn's text must show up in the transcript), a
 * missing or stalled transcript, a schema problem, a rewritten file, a
 * version outside the checked range; an interrupt ends the turn without a
 * canary; sub-agent rows come from their own transcript. Fake timers.
 */

import fs, { appendFileSync, cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FIX, fixture, hooksOf, itemProblems, linesOf } from './chat-helpers'

const require = createRequire(import.meta.url)
const { createLens } = require('../electron/chatLens.cjs')
const { callKey } = require('../hooks/spawn-hook.cjs')

const PROJECT = 'C--Users-user-work-demo'
const CWD = 'C:\\Users\\user\\work\\demo'
const SID = (n: number) => `00000000-0000-4000-8000-000000000${n}`

const dirs: string[] = []
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }) })
const tempDir = () => { const d = mkdtempSync(join(tmpdir(), 'spawn-chat-canary-')); dirs.push(d); return d }

beforeEach(() => { vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] }); vi.setSystemTime(new Date('2026-11-14T12:00:00Z')) })
afterEach(() => { vi.useRealTimers() })

function setup(opts: Record<string, unknown> = {}) {
  const claudeDir = tempDir()
  const userDataDir = tempDir()
  mkdirSync(join(claudeDir, 'projects', PROJECT), { recursive: true })
  mkdirSync(join(userDataDir, 'session-links'), { recursive: true })
  const updates: any[] = []
  const opened: string[] = []
  const spyFs = { ...fs, promises: { ...fs.promises, open: (p: string, f?: string) => { opened.push(String(p)); return fs.promises.open(p, f) } } }
  const lens = createLens({ claudeDir, userDataDir, fs: spyFs, emit: (u: any) => updates.push(u), callKey, watch: () => null, ...opts })
  const transcript = (sid: string) => join(claudeDir, 'projects', PROJECT, `${sid}.jsonl`)
  const run = async (ms: number) => { for (let t = 0; t < ms; t += 10) { vi.advanceTimersByTime(Math.min(10, ms - t)); await lens.idle() } await lens.idle() }
  const status = () => updates.flatMap(u => u.ops).filter((o: any) => o.op === 'status' || o.op === 'reset').at(-1)?.status
  const upserted = () => updates.flatMap(u => u.ops).filter((o: any) => o.op === 'upsert').flatMap((o: any) => o.items)
  const item = (id: string) => upserted().filter((i: any) => i.id === id).at(-1)
  return { claudeDir, userDataDir, updates, opened, lens, transcript, run, status, upserted, item }
}

const term = (id: string) => ({ id, cwd: CWD, armed: true, status: 'running' })
/** The fixture's first lines, through the first one matching `until` */
function head(name: string, until: (text: string) => boolean) {
  const out: string[] = []
  for (const l of linesOf(name)) { out.push(l.text); if (until(l.text)) break }
  return out.join('\n') + '\n'
}
const firstUser = (t: string) => t.includes('"type":"user"')
const stream = hooksOf('hooks-stream.jsonl')
const ANSWER: string = stream[4].body.last_assistant_message

/** An assistant text line of a later turn */
const textLine = (uuid: string, text: string, extra: Record<string, unknown> = {}) => JSON.stringify({
  parentUuid: null, isSidechain: false, message: { model: 'm', id: 'msg_fixture99', type: 'message', role: 'assistant', content: [{ type: 'text', text }], stop_reason: 'end_turn' },
  type: 'assistant', uuid, timestamp: '2026-11-14T12:00:10.000Z', ...extra,
}) + '\n'
const userLine = (uuid: string, text: string, extra: Record<string, unknown> = {}) => JSON.stringify({ parentUuid: null, isSidechain: false, type: 'user', message: { role: 'user', content: text }, uuid, timestamp: '2026-11-14T12:00:09.000Z', ...extra }) + '\n'

/** basic's session, open, its prompt submitted; the answer not written yet */
async function promptSubmitted() {
  const s = setup()
  writeFileSync(s.transcript(SID(901)), head('basic.jsonl', firstUser))
  s.lens.setTerminals([term(SID(901))])
  s.lens.open(SID(901))
  await s.run(20)
  s.lens.hook('UserPromptSubmit', stream[0].body, Date.now())
  await s.run(10)
  return s
}

describe('the canary', () => {
  it('Stop, and the matching text lands 250 ms later: no banner', async () => {
    const s = await promptSubmitted()
    s.lens.hook('Stop', stream[4].body, Date.now())
    await s.run(250)
    writeFileSync(s.transcript(SID(901)), fixture('basic.jsonl'))
    await s.run(4000)
    expect(s.status().banner).toBeNull()
    expect(s.status().state).toBe('idle')
  })

  it('Stop, and no text by 3 s: the canary banner; a later turn whose canary passes clears it', async () => {
    const s = await promptSubmitted()
    s.lens.hook('Stop', stream[4].body, Date.now())
    await s.run(2900)
    expect(s.status().banner).toBeNull()
    await s.run(200)
    expect(s.status().banner).toEqual({ reason: 'canary' })
    // the items are still there (the page dims them)
    expect(s.upserted().length + s.updates.flatMap(u => u.ops).filter((o: any) => o.op === 'reset').flatMap((o: any) => o.items).length).toBeGreaterThan(0)

    s.lens.hook('UserPromptSubmit', { ...stream[0].body, prompt: 'again' }, Date.now())
    await s.run(10)
    appendFileSync(s.transcript(SID(901)), userLine(SID(191), 'again') + textLine(SID(192), 'The second answer, long enough to be matched.'))
    s.lens.hook('Stop', { ...stream[4].body, last_assistant_message: 'The second answer, long enough to be matched.' }, Date.now())
    await s.run(1500)
    expect(s.status().banner).toBeNull()
  })

  // (seen in a real session: the banner came, and 다시 읽기 showed the answer; it had landed late)
  it('the answer lands after the 3 s: the canary banner goes by itself', async () => {
    const s = await promptSubmitted()
    const answer = 'An answer written down a little late, long enough to be matched.'
    s.lens.hook('Stop', { ...stream[4].body, last_assistant_message: answer }, Date.now())
    await s.run(3100)
    expect(s.status().banner).toEqual({ reason: 'canary' })
    appendFileSync(s.transcript(SID(901)), textLine(SID(193), answer))
    await s.run(1100)
    expect(s.status().banner).toBeNull()
  })

  it('a late check is dropped at the next prompt: that turn\'s own check decides', async () => {
    const s = await promptSubmitted()
    s.lens.hook('Stop', { ...stream[4].body, last_assistant_message: 'Never written at all, and long enough to be matched.' }, Date.now())
    await s.run(3100)
    expect(s.status().banner).toEqual({ reason: 'canary' })
    s.lens.hook('UserPromptSubmit', { ...stream[0].body, prompt: 'next' }, Date.now())
    await s.run(10)
    appendFileSync(s.transcript(SID(901)), userLine(SID(194), 'next') + textLine(SID(195), 'Something else'))
    await s.run(1100)
    expect(s.status().banner).toEqual({ reason: 'canary' })
  })

  it('Stop says "A" but the transcript has "B": the canary banner', async () => {
    const s = await promptSubmitted()
    s.lens.hook('Stop', { ...stream[4].body, last_assistant_message: 'A completely different answer that was never written down.' }, Date.now())
    await s.run(100)
    writeFileSync(s.transcript(SID(901)), fixture('basic.jsonl'))
    await s.run(3500)
    expect(s.status().banner).toEqual({ reason: 'canary' })
  })

  it('a turn with only tools (empty last message): the transcript must have grown', async () => {
    const s = await promptSubmitted()
    s.lens.hook('Stop', { ...stream[4].body, last_assistant_message: '' }, Date.now())
    await s.run(3200)
    expect(s.status().banner).toEqual({ reason: 'canary' })

    const t = await promptSubmitted()
    appendFileSync(t.transcript(SID(901)), '{"type":"ai-title","aiTitle":"x"}\n' + textLine(SID(193), 'Done.'))
    t.lens.hook('Stop', { ...stream[4].body, last_assistant_message: '' }, Date.now())
    await t.run(3200)
    expect(t.status().banner).toBeNull()
  })

  it('a turn with only tools: a thinking line alone (an item of its own) is not the turn in the transcript', async () => {
    const t = await promptSubmitted()
    const thinking = JSON.stringify({
      parentUuid: null, isSidechain: false, thinkingDurationMs: 500, message: { model: 'm', id: 'msg_fixture98', type: 'message', role: 'assistant', content: [{ type: 'thinking', thinking: '' }], stop_reason: 'end_turn' },
      type: 'assistant', uuid: SID(194), timestamp: '2026-11-14T12:00:10.000Z',
    }) + '\n'
    appendFileSync(t.transcript(SID(901)), thinking)
    t.lens.hook('Stop', { ...stream[4].body, last_assistant_message: '' }, Date.now())
    await t.run(3200)
    expect(t.item(SID(194))).toMatchObject({ kind: 'thinking', text: '', durationMs: 500 })
    expect(t.status().banner).toEqual({ reason: 'canary' })
  })

  it('StopFailure (a usage limit) arms no canary: its message is not an answer', async () => {
    const s = await promptSubmitted()
    s.lens.hook('StopFailure', { ...stream[4].body, hook_event_name: 'StopFailure', error: 'rate_limit', last_assistant_message: 'You have hit your limit' }, Date.now())
    await s.run(4000)
    expect(s.status().banner).toBeNull()
    expect(s.status().state).toBe('idle')
  })
})

describe('missing and stalled', () => {
  it('a prompt, and no transcript for 15 s: missing', async () => {
    const s = setup()
    s.lens.setTerminals([term(SID(901))])
    s.lens.open(SID(901))
    await s.run(20)
    s.lens.hook('UserPromptSubmit', stream[0].body, Date.now())
    await s.run(14_900)
    expect(s.status().banner).toBeNull()
    await s.run(200)
    expect(s.status().banner).toEqual({ reason: 'missing' })
  })

  it('a prompt, and the transcript does not grow for 15 s: missing', async () => {
    const s = await promptSubmitted()
    await s.run(15_100)
    expect(s.status().banner).toEqual({ reason: 'missing' })
  })

  // Claude Code writes the prompt only after every UserPromptSubmit hook is done; another plugin's
  // hook took 12 s (claude-mem) while spawn's own arrived at once
  it('the prompt lands 12 s after its hook (a slow hook of another plugin): no banner', async () => {
    const s = await promptSubmitted()
    await s.run(12_000)
    appendFileSync(s.transcript(SID(901)), '{"type":"queue-operation","operation":"enqueue"}\n')
    await s.run(1100)
    await s.run(5000)
    expect(s.status().banner).toBeNull()
  })

  it('the prompt lands after the missing banner: the banner goes by itself', async () => {
    const s = await promptSubmitted()
    await s.run(15_100)
    expect(s.status().banner).toEqual({ reason: 'missing' })
    appendFileSync(s.transcript(SID(901)), '{"type":"queue-operation","operation":"enqueue"}\n')
    await s.run(1100)
    expect(s.status().banner).toBeNull()
  })

  it('tool hooks keep coming while the file stays still for 30 s: stalled', async () => {
    const s = setup()
    writeFileSync(s.transcript(SID(902)), head('tools.jsonl', firstUser))
    s.lens.setTerminals([term(SID(902))])
    s.lens.open(SID(902))
    await s.run(20)
    const pre = hooksOf('hooks-tools.jsonl')[1].body
    // the prompt was written already: the file grew for this turn, so missing stays quiet
    for (let i = 0; i < 3; i++) {
      s.lens.hook('PreToolUse', { ...pre, tool_use_id: `toolu_fixture9${i}` }, Date.now())
      await s.run(i < 2 ? 15_500 : 10)
    }
    expect(s.status().banner).toEqual({ reason: 'stalled' })
  })

  it('tool hooks with the file growing in between: not stalled', async () => {
    const s = setup()
    const file = s.transcript(SID(902))
    writeFileSync(file, head('tools.jsonl', firstUser))
    s.lens.setTerminals([term(SID(902))])
    s.lens.open(SID(902))
    await s.run(20)
    const pre = hooksOf('hooks-tools.jsonl')[1].body
    for (let i = 0; i < 4; i++) {
      s.lens.hook('PreToolUse', { ...pre, tool_use_id: `toolu_fixture9${i}` }, Date.now())
      await s.run(15_500)
      appendFileSync(file, '{"type":"tools-used","tools":["Edit"]}\n')
      await s.run(1100)
    }
    expect(s.status().banner).toBeNull()
  })
})

describe('the file itself', () => {
  it('bad.jsonl: the schema banner', async () => {
    const s = setup()
    writeFileSync(s.transcript(SID(901)), fixture('bad.jsonl'))
    s.lens.setTerminals([term(SID(901))])
    s.lens.open(SID(901))
    await s.run(20)
    expect(s.status().banner?.reason).toBe('schema')
  })

  it('soft problems on more than half of the kept lines: the schema banner; on fewer, none', async () => {
    const odd = (n: number) => JSON.stringify({ type: 'hologram', uuid: SID(800 + n) }) + '\n'
    const s = setup()
    const odds = (from: number, n: number) => Array.from({ length: n }, (_, i) => odd(from + i)).join('')
    const said = (n: number) => JSON.stringify({ type: 'user', uuid: SID(700 + n), message: { role: 'user', content: `line ${n}` } }) + '\n'
    const saids = (from: number, n: number) => Array.from({ length: n }, (_, i) => said(from + i)).join('')
    // the ratio counts only once 20 kept lines were seen: 5 basic lines + 9 unknown, no banner yet
    writeFileSync(s.transcript(SID(901)), fixture('basic.jsonl') + odds(10, 9))
    s.lens.setTerminals([term(SID(901))])
    s.lens.open(SID(901))
    await s.run(20)
    expect(s.status().banner).toBeNull()
    // 24 kept lines, 9 unknown: under half
    appendFileSync(s.transcript(SID(901)), saids(30, 10))
    await s.run(1100)
    expect(s.status().banner).toBeNull()
    // 40 kept lines, 25 unknown: more than half
    appendFileSync(s.transcript(SID(901)), odds(50, 16))
    await s.run(1100)
    expect(s.status().banner?.reason).toBe('schema')
  })

  it('a rewritten file: the rewrite banner, nothing more read until 다시 읽기', async () => {
    const s = setup()
    const file = s.transcript(SID(901))
    writeFileSync(file, fixture('basic.jsonl'))
    s.lens.setTerminals([term(SID(901))])
    s.lens.open(SID(901))
    await s.run(20)
    writeFileSync(file, fixture('tools.jsonl').slice(0, 300) + '\n')
    await s.run(1100)
    expect(s.status().banner).toEqual({ reason: 'rewrite' })
    const n = s.updates.length
    const reads = s.opened.length
    writeFileSync(file, fixture('tools.jsonl'))
    await s.run(3000)
    expect(s.updates.length).toBe(n)
    expect(s.opened.length).toBe(reads)
    // 다시 읽기: a fresh read, the banner gone
    await s.lens.reload(SID(901))
    await s.run(20)
    const reset = s.updates.at(-1).ops.find((o: any) => o.op === 'reset')
    expect(reset.status.banner).toBeNull()
    expect(reset.items.some((i: any) => i.id === 'toolu_fixture07')).toBe(true)
  })
})

describe('versions', () => {
  it('a transcript written by a Claude Code older than the checked range: the version banner', async () => {
    const s = setup()
    writeFileSync(s.transcript(SID(901)), userLine(SID(181), 'hello', { version: '2.1.200' }) + textLine(SID(182), 'hi', { version: '2.1.200' }))
    s.lens.setTerminals([term(SID(901))])
    s.lens.open(SID(901))
    await s.run(20)
    expect(s.status().banner).toEqual({ reason: 'version' })
    expect(s.status().version).toBe('2.1.200')
  })

  // a long session resumed across updates (seen in a real session): its early lines by 2.1.319, the
  // rest by 2.1.325; the banner said "2.1.325 hasn't been checked" for good
  it('older lines first, then lines by a checked version: no banner, the checked version shown', async () => {
    const s = setup()
    writeFileSync(s.transcript(SID(901)), userLine(SID(181), 'hello', { version: '2.1.200' }) + textLine(SID(182), 'hi', { version: '2.1.200' })
      + userLine(SID(183), 'again', { version: '2.1.325' }) + textLine(SID(184), 'yes', { version: '2.1.325' }))
    s.lens.setTerminals([term(SID(901))])
    s.lens.open(SID(901))
    await s.run(20)
    expect(s.status().banner).toBeNull()
    expect(s.status().version).toBe('2.1.325')
  })

  it('newer than the range: a quiet note, no banner (from the transcript or from the host)', async () => {
    const s = setup()
    writeFileSync(s.transcript(SID(901)), userLine(SID(181), 'hello', { version: '2.3.0' }))
    s.lens.setTerminals([term(SID(901))])
    s.lens.open(SID(901))
    await s.run(20)
    expect(s.status()).toMatchObject({ banner: null, note: 'new-version', version: '2.3.0' })

    const h = setup({ version: '2.4.1 (Claude Code)' })
    writeFileSync(h.transcript(SID(901)), fixture('basic.jsonl'))
    h.lens.setTerminals([term(SID(901))])
    h.lens.open(SID(901))
    await h.run(20)
    expect(h.status()).toMatchObject({ banner: null, note: 'new-version' })
  })
})

describe('versions: one log line per version newly seen in a transcript', () => {
  it('its number and verdict only, once however many lines and sessions carry it; another version, one more line', async () => {
    const logs: { level: string; msg: string }[] = []
    const s = setup({ log: (level: string, msg: string) => logs.push({ level, msg }) })
    writeFileSync(s.transcript(SID(901)), userLine(SID(181), 'the secret river', { version: '2.3.0' }) + textLine(SID(182), 'a private answer', { version: '2.3.0' }))
    writeFileSync(s.transcript(SID(902)), userLine(SID(183), 'another secret', { version: '2.3.0' }) + textLine(SID(184), 'older words', { version: '2.1.200' }))
    s.lens.setTerminals([term(SID(901)), term(SID(902))])
    s.lens.open(SID(901))
    s.lens.open(SID(902))
    await s.run(40)
    const lines = logs.filter(l => /Claude Code \d/.test(l.msg))
    expect(lines).toEqual([
      { level: 'info', msg: 'chat lens: a transcript of Claude Code 2.3.0 (new)' },
      { level: 'info', msg: 'chat lens: a transcript of Claude Code 2.1.200 (old)' },
    ])
    for (const l of logs) expect(l.msg).not.toMatch(/secret|private|older words|river/)
  })
})

describe('an interrupt', () => {
  it('the turn\'s running rows become interrupted, the status idle, and no canary or missing fires', async () => {
    const s = setup()
    const file = s.transcript(SID(903))
    writeFileSync(file, head('interrupt.jsonl', firstUser))
    s.lens.setTerminals([term(SID(903))])
    s.lens.open(SID(903))
    await s.run(20)
    s.lens.hook('UserPromptSubmit', { ...stream[0].body, session_id: SID(903) }, Date.now())
    s.lens.hook('PreToolUse', { ...hooksOf('hooks-tools.jsonl')[4].body, session_id: SID(903), tool_use_id: 'toolu_fixture99' }, Date.now())
    await s.run(10)
    expect(s.item('toolu_fixture99').state).toBe('running')
    const lines = linesOf('interrupt.jsonl')
    appendFileSync(file, lines[1].text + '\n' + lines[2].text + '\n')
    await s.run(300)
    expect(s.item('toolu_fixture99').state).toBe('interrupted')
    expect(s.status().state).toBe('idle')
    await s.run(6000)
    expect(s.status().banner).toBeNull()
  })

  it('the whole interrupt fixture read live: the rejected call stays rejected, the status idle', async () => {
    const s = setup()
    const file = s.transcript(SID(903))
    writeFileSync(file, head('interrupt.jsonl', firstUser))
    s.lens.setTerminals([term(SID(903))])
    s.lens.open(SID(903))
    await s.run(20)
    s.lens.hook('UserPromptSubmit', { ...stream[0].body, session_id: SID(903) }, Date.now())
    writeFileSync(file, fixture('interrupt.jsonl'))
    await s.run(1100)
    expect(s.item('toolu_fixture31').state).toBe('rejected')
    expect(s.status().state).toBe('idle')
    await s.run(6000)
    expect(s.status().banner).toBeNull()
  })
})

describe('sub-agents', () => {
  /** agent.jsonl's call (running), its sub-agent's folder where FINDINGS §1 puts it */
  async function agentSession({ copySub = true, through = (t: string) => t.includes('"name":"Agent"') } = {}) {
    const s = setup()
    writeFileSync(s.transcript(SID(904)), head('agent.jsonl', through))
    if (copySub) cpSync(join(FIX, 'agent'), join(s.claudeDir, 'projects', PROJECT, SID(904)), { recursive: true })
    s.lens.setTerminals([term(SID(904))])
    s.lens.open(SID(904))
    await s.run(20)
    return s
  }

  it('SubagentStart pairs with the one running Agent row; its tools are counted there', async () => {
    const s = await agentSession()
    const hooks = hooksOf('hooks-agent.jsonl')
    s.lens.hook('PreToolUse', hooks[0].body, Date.now())
    s.lens.hook('SubagentStart', hooks[1].body, Date.now())
    s.lens.hook('PreToolUse', hooks[2].body, Date.now())
    await s.run(10)
    expect(s.item('toolu_fixture41')).toMatchObject({ tool: 'Agent', agentId: 'afixture01', agentTools: 1 })
    // the sub-agent's own call makes no row of its own in the main conversation
    expect(s.item('toolu_fixture42')).toBeUndefined()
  })

  it('two Agent rows running: no pairing (never a guessed row)', async () => {
    const s = await agentSession()
    const hooks = hooksOf('hooks-agent.jsonl')
    s.lens.hook('PreToolUse', { ...hooks[0].body, tool_use_id: 'toolu_fixture43' }, Date.now())
    s.lens.hook('SubagentStart', hooks[1].body, Date.now())
    s.lens.hook('PreToolUse', hooks[2].body, Date.now())
    await s.run(10)
    expect(s.item('toolu_fixture43').agentId).toBeUndefined()
    expect(s.upserted().filter((i: any) => i.id === 'toolu_fixture41').every((i: any) => i.agentId === undefined)).toBe(true)
  })

  it('agent(): the sub-agent\'s rows from its own transcript, under the Agent row', async () => {
    const s = await agentSession({ through: (t) => t.includes('async_launched') })
    expect(s.updates.flatMap(u => u.ops).find((o: any) => o.op === 'reset').items.find((i: any) => i.id === 'toolu_fixture41').agentId).toBe('afixture01')
    const r = await s.lens.agent(SID(904), 'toolu_fixture41')
    await s.run(10)
    expect(r).toEqual({ ok: true })
    const ps = s.item('toolu_fixture42')
    expect(ps).toMatchObject({ tool: 'PowerShell', state: 'done', parent: 'toolu_fixture41' })
    const text = s.upserted().find((i: any) => i.kind === 'text' && i.parent === 'toolu_fixture41')
    expect(text.text).toBe('3')
    for (const i of s.upserted()) expect(itemProblems(i)).toEqual([])
  })

  it('an agent_transcript_path outside the projects folder is never read', async () => {
    const s = await agentSession({ copySub: false, through: (t) => t.includes('async_launched') })
    const outside = join(s.claudeDir, 'elsewhere', 'agent-afixture01.jsonl')
    mkdirSync(join(s.claudeDir, 'elsewhere'), { recursive: true })
    cpSync(join(FIX, 'agent', 'subagents', 'agent-afixture01.jsonl'), outside)
    s.lens.hook('SubagentStop', { ...hooksOf('hooks-agent.jsonl')[4].body, agent_transcript_path: outside }, Date.now())
    await s.run(10)
    const r = await s.lens.agent(SID(904), 'toolu_fixture41')
    await s.run(10)
    expect(r).toEqual({ ok: false })
    expect(s.opened.filter(p => p.includes('elsewhere'))).toEqual([])
    expect(s.item('toolu_fixture42')).toBeUndefined()
  })
})

describe('the host\'s version changes while views are open', () => {
  it('setVersion to a newer one: every open view gets the quiet note; back in range: the note goes (unless a transcript line is newer)', async () => {
    const s = setup({ version: '2.1.325 (Claude Code)' })
    writeFileSync(s.transcript(SID(901)), fixture('basic.jsonl'))
    s.lens.setTerminals([term(SID(901))])
    s.lens.open(SID(901))
    await s.run(20)
    expect(s.status()).toMatchObject({ note: null })
    s.lens.setVersion('2.3.0 (Claude Code)')
    await s.run(20)
    expect(s.status()).toMatchObject({ note: 'new-version', banner: null })
    s.lens.setVersion('2.1.330 (Claude Code)')
    await s.run(20)
    expect(s.status()).toMatchObject({ note: null })
  })
})
