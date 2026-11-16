/**
 * What the first real Claude Code session (2.1.325, the trial of 2026-11-15) showed
 * that the hand-written fixtures had guessed wrong. Each test reproduces one defect:
 *
 *  1. A prompt sent while Claude works is taken into the running turn and written as an
 *     `attachment` of type `queued_command`, never as a user line: the chat lost it.
 *     (tests/fixtures/chat/queued.jsonl is that turn, redacted by hand.)
 *  2. A `bridge-session` line (one per request, account ids only) was an unknown line type,
 *     a soft problem each: short turns could tip the half-unknown rule into a false banner.
 *  3. /clear rewrites the terminal's session link at once, but no chat hook comes until the
 *     next prompt: the chat kept showing the old conversation under a cleared terminal.
 *  4. A /compact typed between turns fires PreCompact with the session idle: the chat
 *     showed nothing while it ran (the terminal says it is compacting).
 */

import fs, { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fixture, itemProblems, linesOf } from './chat-helpers'

const require = createRequire(import.meta.url)
const { createLens } = require('../electron/chatLens.cjs')
const { createItemBuilder } = require('../electron/chatItems.cjs')
const { quickSkip, checkLine, classify } = require('../electron/chatSchema.cjs')
const { callKey } = require('../hooks/spawn-hook.cjs')

const PROJECT = 'C--Users-user-work-demo'
const CWD = 'C:\\Users\\user\\work\\demo'
const T1 = '11111111-1111-4111-8111-111111111111'
const T2 = '22222222-2222-4222-8222-222222222222'
const CLEARED = '00000000-0000-4000-8000-000000000398'

const dirs: string[] = []
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }) })
const tempDir = () => { const d = mkdtempSync(join(tmpdir(), 'spawn-chat-trial-')); dirs.push(d); return d }

beforeEach(() => { vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] }); vi.setSystemTime(new Date('2026-11-15T02:04:00Z')) })
afterEach(() => { vi.useRealTimers() })

function setup() {
  const claudeDir = tempDir()
  const userDataDir = tempDir()
  mkdirSync(join(claudeDir, 'projects', PROJECT), { recursive: true })
  mkdirSync(join(userDataDir, 'session-links'), { recursive: true })
  const updates: any[] = []
  const lens = createLens({ claudeDir, userDataDir, fs, emit: (u: any) => updates.push(u), callKey, watch: () => null })
  const transcript = (sid: string) => join(claudeDir, 'projects', PROJECT, `${sid}.jsonl`)
  const link = (term: string, sid: string) => writeFileSync(join(userDataDir, 'session-links', term), sid)
  const run = async (ms: number) => { for (let t = 0; t < ms; t += 10) { vi.advanceTimersByTime(Math.min(10, ms - t)); await lens.idle() } await lens.idle() }
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
    return { items: [...items.values()].sort((a, b) => a.order - b.order), status }
  }
  return { claudeDir, userDataDir, updates, lens, transcript, link, run, view }
}

const term = (id: string) => ({ id, cwd: CWD, armed: true, status: 'running' })
const hookBody = (sid: string, event: string, extra: Record<string, unknown> = {}) => ({ session_id: sid, transcript_path: 'C:\\Users\\user\\.claude\\projects\\x.jsonl', cwd: CWD, hook_event_name: event, ...extra })
const user = (uuid: string, text: string) => JSON.stringify({ parentUuid: null, isSidechain: false, type: 'user', message: { role: 'user', content: text }, uuid, timestamp: '2026-11-15T02:04:01.000Z' }) + '\n'
const U = (n: number) => `00000000-0000-4000-8000-0000000003${String(n).padStart(2, '0')}`
const QUEUED_FINAL = '`src/math.js` defines `add(a, b)`, which returns the sum of its two arguments.\n\nThe Nile and the Amazon are the longest rivers.'

function build(name: string) {
  const b = createItemBuilder({ cwd: CWD })
  const items = new Map<string, any>()
  for (const { text, offset } of linesOf(name)) {
    if (quickSkip(text)) continue
    for (const it of b.line(JSON.parse(text), offset)) items.set(it.id, it)
  }
  return [...items.values()].sort((a, b) => a.order - b.order)
}

describe('1. a prompt sent while Claude works (queued_command)', () => {
  it('the line is kept (not skipped unparsed), passes the shape check, and other attachments are still skipped', () => {
    const lines = linesOf('queued.jsonl').map(l => l.text)
    const queued = lines.find(l => l.includes('"queued_command"'))!
    expect(quickSkip(queued)).toBe(false)
    expect(classify(JSON.parse(queued))).toBe('attachment')
    expect(checkLine(JSON.parse(queued))).toBeNull()
    expect(quickSkip('{"parentUuid":"x","isSidechain":false,"attachment":{"type":"hook_success","hookName":"PreToolUse:Read"},"type":"attachment"}')).toBe(true)
  })

  it('is shown as the user\'s message where Claude took it in: after the tool it was reading, before the answer', () => {
    const items = build('queued.jsonl')
    expect(items.map(i => i.kind + (i.kind === 'user' ? `:${i.text}` : ''))).toEqual([
      'user:Read src/math.js and say what it does in one sentence.',
      'tool',
      'user:Also, which rivers are the longest?',
      'text',
      'turn-end',
    ])
    for (const i of items) expect(itemProblems(i), JSON.stringify(i)).toEqual([])
    expect(JSON.stringify(items)).not.toContain('system-reminder')
  })

  it('only a typed prompt: a queued notification, another mode, a sub-agent\'s own file, or an empty prompt make nothing', () => {
    const line = (attachment: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({ parentUuid: null, isSidechain: false, type: 'attachment', uuid: U(80), timestamp: '2026-11-15T02:04:21.162Z', attachment: { type: 'queued_command', ...attachment }, ...extra })
    const b = createItemBuilder({ cwd: CWD })
    expect(b.line(line({ prompt: '<task-notification>\n<task-id>a1</task-id>\n</task-notification>', commandMode: 'task-notification' }), 10)).toEqual([])
    expect(b.line(line({ prompt: 'ls', commandMode: 'bash', origin: { kind: 'human' } }), 20)).toEqual([])
    expect(b.line(line({ prompt: 'hi', commandMode: 'prompt', origin: { kind: 'coordinator' } }), 30)).toEqual([])
    expect(b.line(line({ prompt: '', commandMode: 'prompt' }), 40)).toEqual([])
    expect(b.line(line({ prompt: 'hi', commandMode: 'prompt' }, { isSidechain: true }), 50)).toEqual([])
    expect(createItemBuilder({ cwd: CWD, parent: 'toolu_fixture09' }).line(line({ prompt: 'hi', commandMode: 'prompt' }), 60)).toEqual([])
    // a prompt with a pasted image (content blocks): its text, and the image counted, never copied
    const [it] = b.line(line({ prompt: [{ type: 'text', text: 'and this one' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgo=' } }], commandMode: 'prompt', origin: { kind: 'human' } }), 70)
    expect(it).toMatchObject({ kind: 'user', text: 'and this one', images: 1 })
    expect(JSON.stringify(it)).not.toContain('iVBOR')
  })

  async function replay(midTurnHook: boolean) {
    const s = setup()
    const lines = fixture('queued.jsonl').split('\n').filter(Boolean)
    const sid = '00000000-0000-4000-8000-000000000399'
    // the terminal launched under the conversation's id; its file holds the turn's first two lines so far
    writeFileSync(s.transcript(sid), '')
    s.lens.setTerminals([term(sid)])
    s.lens.open(sid)
    await s.run(20)
    s.lens.hook('UserPromptSubmit', hookBody(sid, 'UserPromptSubmit', { prompt: 'Read src/math.js and say what it does in one sentence.' }), Date.now())
    appendFileSync(s.transcript(sid), lines.slice(0, 4).join('\n') + '\n')
    await s.run(300)
    if (midTurnHook) s.lens.hook('UserPromptSubmit', hookBody(sid, 'UserPromptSubmit', { prompt: 'Also, which rivers are the longest?' }), Date.now())
    // the rest of the turn lands before Stop (read at once), so the canary has only the anchored lines to go on
    appendFileSync(s.transcript(sid), lines.slice(4).join('\n') + '\n')
    await s.run(300)
    s.lens.hook('Stop', hookBody(sid, 'Stop', { last_assistant_message: QUEUED_FINAL }), Date.now())
    await s.run(3500)
    return s.view(sid)
  }

  it('the canary still finds the answer after the mid-turn prompt (no banner), whether or not a prompt hook came for it', async () => {
    for (const midTurnHook of [false, true]) {
      const v = await replay(midTurnHook)
      expect(v.status.banner, `mid-turn hook: ${midTurnHook}`).toBeNull()
      expect(v.items.filter((i: any) => i.kind === 'user').map((i: any) => i.text)).toEqual(['Read src/math.js and say what it does in one sentence.', 'Also, which rivers are the longest?'])
      expect(v.status.state).toBe('idle')
    }
  })
})

describe('2. bridge-session lines are bookkeeping', () => {
  it('skipped unparsed, so they never count as unknown lines', () => {
    const line = linesOf('queued.jsonl')[0].text
    expect(line.startsWith('{"type":"bridge-session"')).toBe(true)
    const spy = vi.spyOn(JSON, 'parse')
    expect(quickSkip(line)).toBe(true)
    expect(spy).not.toHaveBeenCalled()
    spy.mockRestore()
  })

  it('a session of short turns (one bridge-session per turn, as 2.1.325 writes them) raises no schema banner', async () => {
    const s = setup()
    const bridge = '{"type":"bridge-session","sessionId":"REDACTED","bridgeSessionId":"REDACTED","lastSequenceNum":"REDACTED","ownerAccountUuid":"REDACTED","ownerOrganizationUuid":"REDACTED"}\n'
    let text = ''
    for (let n = 0; n < 30; n++) text += bridge + bridge + user(U(n), `prompt ${n}`)
    writeFileSync(s.transcript(T1), text)
    s.lens.setTerminals([term(T1)])
    s.lens.open(T1)
    await s.run(50)
    expect(s.view(T1).status.banner).toBeNull()
  })
})

describe('3. /clear: the chat follows the terminal at once', () => {
  const clearLines = () => fixture('commands.jsonl').split('\n').filter(Boolean).slice(0, 2).join('\n') + '\n'

  it('an open view moves to the new conversation when the link changes, before any prompt', async () => {
    const s = setup()
    writeFileSync(s.transcript(T1), user(U(1), 'hi, an old conversation'))
    s.lens.setTerminals([term(T1)])
    s.lens.open(T1)
    await s.run(20)
    expect(s.view(T1).items.map((i: any) => i.kind)).toEqual(['user'])
    // /clear: the game hook writes the link at SessionStart; the new file starts with the command
    writeFileSync(s.transcript(CLEARED), clearLines())
    s.link(T1, CLEARED)
    await s.run(1100)
    const v = s.view(T1)
    expect(v.items.map((i: any) => `${i.kind}:${i.notice ?? i.text}`)).toEqual(['notice:command'])
    expect(v.items[0].text).toBe('/clear')
    expect(v.status.banner).toBeNull()
    // and the next prompt in it is not a second move
    const resets = s.updates.flatMap(u => u.ops).filter((o: any) => o.op === 'reset').length
    s.lens.hook('UserPromptSubmit', hookBody(CLEARED, 'UserPromptSubmit', { prompt: 'next' }), Date.now())
    appendFileSync(s.transcript(CLEARED), user(U(2), 'next'))
    await s.run(300)
    expect(s.updates.flatMap(u => u.ops).filter((o: any) => o.op === 'reset').length).toBe(resets)
    expect(s.view(T1).items.map((i: any) => i.kind)).toEqual(['notice', 'user'])
  })

  it('a view opened after a /clear made while it was closed shows the new conversation', async () => {
    const s = setup()
    writeFileSync(s.transcript(T1), user(U(1), 'hi, an old conversation'))
    s.lens.setTerminals([term(T1)])
    writeFileSync(s.transcript(CLEARED), clearLines())
    s.link(T1, CLEARED)
    s.lens.open(T1)
    await s.run(20)
    expect(s.view(T1).items.map((i: any) => i.kind)).toEqual(['notice'])
  })

  it('a link the game hook left behind never pulls the view back; a conversation another terminal shows is not taken', async () => {
    const s = setup()
    s.link(T1, T1)
    writeFileSync(s.transcript(T1), user(U(1), 'first'))
    writeFileSync(s.transcript(CLEARED), user(U(2), 'second'))
    s.lens.setTerminals([term(T1), term(T2)])
    s.lens.open(T1)
    await s.run(20)
    // the hooks say T1 moved on (a resume the link never heard of): the view follows the hooks
    s.lens.hook('UserPromptSubmit', { ...hookBody(CLEARED, 'UserPromptSubmit', { prompt: 'second' }), session_id: CLEARED }, Date.now())
    await s.run(10)
    // (CLEARED is not T1's: the hook maps by id or link only, so it is ignored, and T1 stays where it is)
    await s.run(3000)
    expect(s.view(T1).items.map((i: any) => i.text)).toEqual(['first'])
    // T2's link names T1's conversation: T2 never takes it
    s.link(T2, T1)
    s.lens.open(T2)
    await s.run(1100)
    expect(s.view(T1).items.map((i: any) => i.text)).toEqual(['first'])
    expect(s.view(T2).items.map((i: any) => i.text)).not.toContain('first')
  })
})

describe('4. a /compact typed between turns', () => {
  it('shows the work while it runs (label compact) and ends idle; one inside a turn keeps the turn working', async () => {
    const s = setup()
    writeFileSync(s.transcript(T1), user(U(1), 'hi'))
    s.lens.setTerminals([term(T1)])
    s.lens.open(T1)
    await s.run(20)
    s.lens.hook('PreCompact', hookBody(T1, 'PreCompact', { trigger: 'manual' }), Date.now())
    await s.run(10)
    expect(s.view(T1).status).toMatchObject({ state: 'working', label: 'compact' })
    expect(typeof s.view(T1).status.since).toBe('number')
    s.lens.hook('PostCompact', hookBody(T1, 'PostCompact', { trigger: 'manual' }), Date.now())
    await s.run(10)
    expect(s.view(T1).status).toMatchObject({ state: 'idle', label: null })
    // auto-compact in the middle of a turn: still working after it
    s.lens.hook('UserPromptSubmit', hookBody(T1, 'UserPromptSubmit', { prompt: 'go' }), Date.now())
    s.lens.hook('PreCompact', hookBody(T1, 'PreCompact', { trigger: 'auto' }), Date.now())
    s.lens.hook('PostCompact', hookBody(T1, 'PostCompact', { trigger: 'auto' }), Date.now())
    await s.run(10)
    expect(s.view(T1).status).toMatchObject({ state: 'working', label: null })
  })
})
