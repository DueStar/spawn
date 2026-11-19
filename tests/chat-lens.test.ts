/**
 * electron/chatLens.cjs, part one — terminals ↔ conversations, the transcript
 * found and read, hooks turned into live tool rows and status, and the
 * provisional bubble from MessageDisplay. Fake timers; a temp Claude folder
 * with the fixtures in it; `emit` collects the updates.
 */

import fs, { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fixture, hooksOf, itemProblems, linesOf } from './chat-helpers'

const require = createRequire(import.meta.url)
const { createLens, conversationOf, terminalFor, transcriptAllowed, findTranscript, liveMatches } = require('../electron/chatLens.cjs')
const { LIVE_BASE, LIVE_ORDER } = require('../electron/chatItems.cjs')
const { callKey } = require('../hooks/spawn-hook.cjs')

const PROJECT = 'C--Users-user-work-demo'
const CWD = 'C:\\Users\\user\\work\\demo'
const T1 = '11111111-1111-4111-8111-111111111111'
const T2 = '22222222-2222-4222-8222-222222222222'
const SID = (n: number) => `00000000-0000-4000-8000-000000000${n}`

const dirs: string[] = []
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }) })
const tempDir = () => { const d = mkdtempSync(join(tmpdir(), 'spawn-chat-lens-')); dirs.push(d); return d }

beforeEach(() => { vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] }); vi.setSystemTime(new Date('2026-11-14T12:00:00Z')) })
afterEach(() => { vi.useRealTimers() })

/** A Claude folder, an app data folder and a lens over them */
function setup() {
  const claudeDir = tempDir()
  const userDataDir = tempDir()
  mkdirSync(join(claudeDir, 'projects', PROJECT), { recursive: true })
  mkdirSync(join(userDataDir, 'session-links'), { recursive: true })
  const updates: any[] = []
  const opened: string[] = []
  const spyFs = {
    ...fs,
    promises: { ...fs.promises, open: (p: string, f?: string) => { opened.push(String(p)); return fs.promises.open(p, f) } },
  }
  const lens = createLens({ claudeDir, userDataDir, fs: spyFs, emit: (u: any) => updates.push(u), callKey, watch: () => null })
  const transcript = (sid: string) => join(claudeDir, 'projects', PROJECT, `${sid}.jsonl`)
  const link = (term: string, sid: string) => writeFileSync(join(userDataDir, 'session-links', term), sid)
  /** let `ms` of fake time pass, the lens's reads finishing as it goes */
  const run = async (ms: number) => { for (let t = 0; t < ms; t += 10) { vi.advanceTimersByTime(Math.min(10, ms - t)); await lens.idle() } await lens.idle() }
  return { claudeDir, userDataDir, updates, opened, lens, transcript, link, run }
}

/** The ops of the updates since `from` */
const opsSince = (updates: any[], from: number) => updates.slice(from).flatMap(u => u.ops)
const resetsOf = (updates: any[]) => opsSince(updates, 0).filter(o => o.op === 'reset')
/** The fixture's lines up to and including the first one matching `until` */
function firstLines(name: string, until: (text: string) => boolean): string {
  const out: string[] = []
  for (const l of linesOf(name)) { out.push(l.text); if (until(l.text)) break }
  return out.join('\n') + '\n'
}
const term = (id: string, extra: Record<string, unknown> = {}) => ({ id, cwd: CWD, armed: true, status: 'running', ...extra })
const hookAt = (body: any, sid: string) => ({ ...body, session_id: sid })

describe('pure helpers', () => {
  it('conversationOf: the link file, else the terminal id', () => {
    expect(conversationOf({ id: T1 }, () => '')).toBe(T1)
    expect(conversationOf({ id: T1 }, () => SID(901))).toBe(SID(901))
  })

  it('liveMatches: by text prefix, line ends and trailing spaces ignored', () => {
    const answer = fixture('hooks-stream.jsonl') && hooksOf('hooks-stream.jsonl')[4].body.last_assistant_message
    expect(liveMatches(answer, answer)).toBe(true)
    expect(liveMatches(answer.slice(0, 60), answer)).toBe(true)
    expect(liveMatches(answer.replace(/\n/g, '  \r\n'), answer)).toBe(true)
    expect(liveMatches('Here', answer)).toBe(false) // under 20 characters in common
    expect(liveMatches('Something else entirely, longer than twenty', answer)).toBe(false)
    expect(liveMatches('', answer)).toBe(false)
  })

  it('terminalFor: current conversation, then a link file, then the terminal id; two matches are none', () => {
    const terms = [term(T1), term(T2)]
    const links: Record<string, string> = {}
    const readLink = (id: string) => links[id] ?? ''
    const current = new Map([[T1, T1], [T2, T2]])
    expect(terminalFor(T1, terms, current, readLink)?.id).toBe(T1)
    links[T2] = SID(905)
    expect(terminalFor(SID(905), terms, current, readLink)?.id).toBe(T2)
    expect(terminalFor(SID(999), terms, current, readLink)).toBeNull()
    const clash: string[][] = []
    current.set(T1, SID(904)); current.set(T2, SID(904))
    expect(terminalFor(SID(904), terms, current, readLink, (l: any[]) => clash.push(l.map(t => t.id)))).toBeNull()
    expect(clash).toEqual([[T1, T2]])
    // an unarmed terminal is never a match
    expect(terminalFor(T1, [term(T1, { armed: false })], new Map([[T1, T1]]), readLink)).toBeNull()
  })

  it('transcriptAllowed: only a .jsonl inside the Claude projects folder', async () => {
    const { claudeDir, transcript } = setup()
    writeFileSync(transcript(SID(901)), fixture('basic.jsonl'))
    writeFileSync(join(claudeDir, 'settings.json'), '{}')
    writeFileSync(join(claudeDir, 'projects', 'x.txt'), '')
    expect(await transcriptAllowed(transcript(SID(901)), claudeDir, fs)).toBe(true)
    expect(await transcriptAllowed(join(claudeDir, 'settings.json'), claudeDir, fs)).toBe(false)
    expect(await transcriptAllowed(join(claudeDir, 'projects', PROJECT, '..', '..', 'x.jsonl'), claudeDir, fs)).toBe(false)
    expect(await transcriptAllowed(join(claudeDir, 'projects', 'x.txt'), claudeDir, fs)).toBe(false)
    expect(await transcriptAllowed(join(claudeDir, 'projects', PROJECT, 'missing.jsonl'), claudeDir, fs)).toBe(false)
    expect(await findTranscript(SID(901), claudeDir, fs)).toBe(transcript(SID(901)))
    expect(await findTranscript(SID(902), claudeDir, fs)).toBeNull()
    expect(await findTranscript('../../settings', claudeDir, fs)).toBeNull()
  })
})

describe('the mapping table (through the lens)', () => {
  it('a hook whose session is the terminal id reaches that terminal', async () => {
    const { lens, updates, transcript, run } = setup()
    writeFileSync(transcript(T1), firstLines('tools.jsonl', t => t.includes('"type":"user"')))
    lens.setTerminals([term(T1), term(T2)])
    lens.open(T1)
    await run(20)
    const from = updates.length
    lens.hook('UserPromptSubmit', hookAt(hooksOf('hooks-tools.jsonl')[0].body, T1), Date.now())
    await run(10)
    const ups = updates.slice(from)
    expect(ups.length).toBeGreaterThan(0)
    expect(ups.every(u => u.id === T1)).toBe(true)
    expect(ups.flatMap(u => u.ops).find(o => o.op === 'status').status.state).toBe('working')
  })

  it('a hook whose session is a link file\'s conversation reaches that terminal', async () => {
    const { lens, updates, link, run } = setup()
    link(T2, SID(905))
    lens.setTerminals([term(T1), term(T2)])
    lens.hook('UserPromptSubmit', hookAt(hooksOf('hooks-tools.jsonl')[0].body, SID(905)), Date.now())
    await run(10)
    expect(updates.map(u => u.id)).toEqual([T2])
    expect(updates[0].ops).toEqual([{ op: 'status', status: expect.objectContaining({ state: 'working' }) }])
  })

  it('/clear: the link changes; the same terminal, and a reset for the new file once a prompt names it', async () => {
    const { lens, updates, transcript, link, run } = setup()
    link(T1, SID(901))
    writeFileSync(transcript(SID(901)), fixture('basic.jsonl'))
    lens.setTerminals([term(T1)])
    lens.open(T1)
    await run(20)
    expect(resetsOf(updates)).toHaveLength(1)
    expect(resetsOf(updates)[0].items.map((i: any) => i.kind)).toEqual(['user', 'thinking', 'text', 'turn-end'])
    // /clear: the game hook writes the new conversation into the link file; the new file appears
    link(T1, SID(902))
    writeFileSync(transcript(SID(902)), firstLines('tools.jsonl', t => t.includes('"type":"user"')))
    const body = { ...hooksOf('hooks-tools.jsonl')[0].body, session_id: SID(902), transcript_path: transcript(SID(902)) }
    lens.hook('UserPromptSubmit', body, Date.now())
    await run(60)
    const resets = resetsOf(updates)
    expect(resets).toHaveLength(2)
    expect(resets[1].items.map((i: any) => i.kind)).toEqual(['user'])
    expect(resets[1].items[0].text).toMatch(/^Read src\/math\.js/)
    expect(updates.every(u => u.id === T1)).toBe(true)
  })

  it('an unknown session: no terminal, no update', async () => {
    const { lens, updates, run } = setup()
    lens.setTerminals([term(T1)])
    lens.hook('UserPromptSubmit', hookAt(hooksOf('hooks-tools.jsonl')[0].body, SID(999)), Date.now())
    lens.hook('PreToolUse', { tool_name: 'Read' }, Date.now()) // no session id at all
    await run(10)
    expect(updates).toEqual([])
  })

  it('two terminals on the same conversation: neither gets it, and the open one says so (mapping)', async () => {
    const { lens, updates, transcript, link, run } = setup()
    link(T1, SID(901)); link(T2, SID(901))
    writeFileSync(transcript(SID(901)), fixture('basic.jsonl'))
    lens.setTerminals([term(T1), term(T2)])
    lens.open(T1)
    await run(20)
    const from = updates.length
    lens.hook('UserPromptSubmit', hookAt(hooksOf('hooks-stream.jsonl')[0].body, SID(901)), Date.now())
    await run(10)
    const after = updates.slice(from)
    expect(after.flatMap(u => u.ops).every(o => o.op === 'status')).toBe(true)
    const t1 = after.filter(u => u.id === T1).flatMap(u => u.ops).at(-1)
    expect(t1.status.banner).toEqual({ reason: 'mapping' })
    expect(t1.status.state).not.toBe('working') // the hook was not applied to either
  })

  it('a transcript_path outside the projects folder is refused and never read', async () => {
    const { lens, updates, claudeDir, opened, run } = setup()
    writeFileSync(join(claudeDir, 'settings.json'), '{"type":"user"}\n')
    mkdirSync(join(claudeDir, 'x'), { recursive: true })
    writeFileSync(join(claudeDir, 'x', `${T1}.jsonl`), fixture('basic.jsonl'))
    lens.setTerminals([term(T1)])
    lens.open(T1)
    await run(20)
    for (const bad of [join(claudeDir, 'settings.json'), join(claudeDir, 'projects', PROJECT, '..', '..', 'x', `${T1}.jsonl`)]) {
      lens.hook('UserPromptSubmit', { ...hooksOf('hooks-tools.jsonl')[0].body, session_id: T1, transcript_path: bad }, Date.now())
      await run(600)
    }
    expect(opened.filter(p => p.includes('settings.json') || p.includes(`${join('x', T1)}`))).toEqual([])
    expect(opened).toEqual([])
    // the view says: no transcript yet
    expect(resetsOf(updates).every(r => r.status.empty === true)).toBe(true)
  })
})

describe('hooks replayed against tools.jsonl', () => {
  it('a tool row from hooks before the transcript has it; permission, done, then its place in the file; a failure', async () => {
    const { lens, updates, transcript, run } = setup()
    const file = transcript(SID(902))
    writeFileSync(file, firstLines('tools.jsonl', t => t.includes('"type":"user"')))
    lens.setTerminals([term(SID(902))])
    lens.open(SID(902))
    await run(20)
    const hooks = hooksOf('hooks-tools.jsonl')
    const item = (id: string) => { const ups = opsSince(updates, 0).filter(o => o.op === 'upsert').flatMap(o => o.items).filter((i: any) => i.id === id); return ups.at(-1) }
    const lastStatus = () => opsSince(updates, 0).filter(o => o.op === 'status' || o.op === 'reset').at(-1).status

    lens.hook('UserPromptSubmit', hooks[0].body, Date.now())
    lens.hook('PreToolUse', hooks[1].body, Date.now())
    await run(10)
    expect(item('toolu_fixture07')).toMatchObject({ kind: 'tool', tool: 'Edit', state: 'running', input: { file: 'src/math.js' } })
    expect(item('toolu_fixture07').order).toBeGreaterThanOrEqual(LIVE_BASE)
    expect(lastStatus().state).toBe('working')

    lens.hook('PermissionRequest', hooks[2].body, Date.now())
    await run(10)
    expect(item('toolu_fixture07').waiting).toBe('permission')
    expect(lastStatus().state).toBe('waiting')

    lens.hook('PostToolUse', hooks[3].body, Date.now())
    await run(10)
    expect(item('toolu_fixture07')).toMatchObject({ state: 'done', durationMs: 8840 })
    expect(item('toolu_fixture07').waiting).toBeUndefined()
    expect(lastStatus().state).toBe('working')

    // the transcript catches up: the call line puts the row at its place in the file, same id, still done
    const rest = linesOf('tools.jsonl')
    const callLine = rest.find(l => l.text.includes('"id":"toolu_fixture07"'))!
    writeFileSync(file, fixture('tools.jsonl').slice(0, callLine.offset + Buffer.byteLength(callLine.text) + 1))
    await run(1100)
    const placed = item('toolu_fixture07')
    expect(placed.order).toBe(callLine.offset)
    expect(placed.state).toBe('done')

    lens.hook('PreToolUse', hooks[4].body, Date.now())
    lens.hook('PostToolUseFailure', hooks[5].body, Date.now())
    await run(10)
    // the failed Bash was already read from the file (it comes before the Edit there): still failed
    expect(item('toolu_fixture05').state).toBe('failed')
    for (const u of opsSince(updates, 0).filter(o => o.op === 'upsert').flatMap(o => o.items)) expect(itemProblems(u)).toEqual([])
  })

  it('a hook-made row for a call the file does not have yet fails from PostToolUseFailure', async () => {
    const { lens, updates, transcript, run } = setup()
    writeFileSync(transcript(SID(902)), firstLines('tools.jsonl', t => t.includes('"type":"user"')))
    lens.setTerminals([term(SID(902))])
    lens.open(SID(902))
    await run(20)
    const hooks = hooksOf('hooks-tools.jsonl')
    lens.hook('PreToolUse', hooks[4].body, Date.now())
    lens.hook('PostToolUseFailure', hooks[5].body, Date.now())
    await run(10)
    const rows = opsSince(updates, 0).filter(o => o.op === 'upsert').flatMap(o => o.items).filter((i: any) => i.id === 'toolu_fixture05')
    expect(rows.map((r: any) => r.state)).toEqual(['running', 'failed'])
  })
})

describe('the provisional bubble', () => {
  it('MessageDisplay batches make one live item; the transcript text removes it in the same update', async () => {
    const { lens, updates, transcript, run } = setup()
    const file = transcript(SID(901))
    writeFileSync(file, firstLines('basic.jsonl', t => t.includes('"type":"user"')))
    lens.setTerminals([term(SID(901))])
    lens.open(SID(901))
    await run(20)
    const hooks = hooksOf('hooks-stream.jsonl')
    lens.hook('UserPromptSubmit', hooks[0].body, Date.now())
    for (const h of hooks.slice(1, 4)) { lens.hook('MessageDisplay', h.body, Date.now()); await run(10) }
    const lives = opsSince(updates, 0).filter(o => o.op === 'upsert').flatMap(o => o.items).filter((i: any) => i.kind === 'live')
    expect(new Set(lives.map((l: any) => l.id)).size).toBe(1)
    expect(lives[0].order).toBe(LIVE_ORDER)
    const answer = hooks[4].body.last_assistant_message
    expect(lives.at(-1).text).toBe(answer)
    expect(lives.map((l: any) => l.text.length)).toEqual([...lives.map((l: any) => l.text.length)].sort((a, b) => a - b))

    const from = updates.length
    writeFileSync(file, fixture('basic.jsonl'))
    await run(1100)
    const replaced = updates.slice(from).find(u => u.ops.some((o: any) => o.op === 'remove'))
    expect(replaced).toBeTruthy()
    expect(replaced.ops.find((o: any) => o.op === 'remove').ids).toEqual([lives[0].id])
    expect(replaced.ops.find((o: any) => o.op === 'upsert').items.some((i: any) => i.kind === 'text' && i.text === answer)).toBe(true)
  })

  it('batches out of order wait for the gap; an interrupted turn\'s bubble gives way to the partial text', async () => {
    const { lens, updates, transcript, run } = setup()
    const file = transcript(SID(901))
    writeFileSync(file, fixture('basic.jsonl'))
    lens.setTerminals([term(SID(901))])
    lens.open(SID(901))
    await run(20)
    const hooks = hooksOf('hooks-stream.jsonl')
    // second turn, interrupted (MessageDisplay ×1, no final, no Stop)
    lens.hook('UserPromptSubmit', hooks[5].body, Date.now())
    const md = hooks[6].body
    const cut = md.delta.indexOf('\n') + 1
    lens.hook('MessageDisplay', { ...md, index: 1, delta: md.delta.slice(cut) }, Date.now()) // index 1 before 0
    await run(10)
    expect(opsSince(updates, 0).filter(o => o.op === 'upsert').flatMap(o => o.items).some((i: any) => i.kind === 'live')).toBe(false)
    lens.hook('MessageDisplay', { ...md, delta: md.delta.slice(0, cut) }, Date.now())
    await run(10)
    const live = opsSince(updates, 0).filter(o => o.op === 'upsert').flatMap(o => o.items).filter((i: any) => i.kind === 'live').at(-1)
    expect(live.text).toBe(md.delta)

    const from = updates.length
    const intr = linesOf('interrupt.jsonl').slice(0, 2).map(l => l.text).join('\n') + '\n'
    appendFileSync(file, intr)
    await run(1100)
    const replaced = updates.slice(from).find(u => u.ops.some((o: any) => o.op === 'remove'))
    // (the turn's prompt row, shown from its hook, goes with it: its line was never written)
    expect(replaced.ops.find((o: any) => o.op === 'remove').ids.filter((id: string) => !id.startsWith('prompt:'))).toEqual([live.id])
    expect(replaced.ops.find((o: any) => o.op === 'upsert').items.find((i: any) => i.kind === 'text').partial).toBe(true)
  })
})

describe('updates', () => {
  it('rev grows by one per update per terminal; a terminal not open gets status only', async () => {
    const { lens, updates, transcript, run } = setup()
    writeFileSync(transcript(SID(902)), firstLines('tools.jsonl', t => t.includes('"type":"user"')))
    lens.setTerminals([term(SID(902)), term(T2)])
    const hooks = hooksOf('hooks-tools.jsonl')
    // not open: hooks change the status, no rows
    lens.hook('UserPromptSubmit', hooks[0].body, Date.now())
    lens.hook('PreToolUse', hooks[1].body, Date.now())
    lens.hook('PermissionRequest', hooks[2].body, Date.now())
    await run(10)
    expect(updates.flatMap(u => u.ops).every(o => o.op === 'status')).toBe(true)
    expect(updates.at(-1).ops[0].status.state).toBe('waiting')
    lens.open(SID(902))
    await run(20)
    lens.hook('PreToolUse', hooks[4].body, Date.now())
    await run(1100)
    const mine = updates.filter(u => u.id === SID(902))
    expect(mine.map(u => u.rev)).toEqual(mine.map((_, i) => i + 1))
    expect(mine.some(u => u.ops.some((o: any) => o.op === 'reset'))).toBe(true)
  })

  it('a new session with no transcript yet: an empty reset, then the conversation once the file appears', async () => {
    const { lens, updates, transcript, run } = setup()
    lens.setTerminals([term(T1)])
    lens.open(T1)
    await run(20)
    expect(resetsOf(updates)[0]).toMatchObject({ items: [], status: { empty: true } })
    writeFileSync(transcript(T1), fixture('basic.jsonl'))
    await run(600)
    const r = resetsOf(updates)
    expect(r).toHaveLength(2)
    expect(r[1].status.empty).toBe(false)
    expect(r[1].items.map((i: any) => i.kind)).toEqual(['user', 'thinking', 'text', 'turn-end'])
  })

  it('close: the view is dropped a minute later; opening again inside the minute costs no full read', async () => {
    const { lens, updates, transcript, opened, run } = setup()
    writeFileSync(transcript(SID(901)), fixture('basic.jsonl'))
    lens.setTerminals([term(SID(901))])
    lens.open(SID(901))
    await run(20)
    lens.close(SID(901))
    await run(30_000)
    const reads = opened.length
    lens.open(SID(901))
    await run(10)
    expect(resetsOf(updates)).toHaveLength(2)
    expect(resetsOf(updates)[1].items).toEqual(resetsOf(updates)[0].items)
    expect(opened.length - reads).toBeLessThanOrEqual(1) // at most one look for what was appended meanwhile
    lens.close(SID(901))
    await run(61_000)
    const n = opened.length
    await run(5_000)
    expect(opened.length).toBe(n) // nothing polls a closed view
    lens.open(SID(901))
    await run(20)
    expect(resetsOf(updates)).toHaveLength(3)
    lens.dispose()
  })
})

describe('long sessions (chat view phase 2, Task 16)', () => {
  /** A lens over a Claude folder whose reads are counted in bytes */
  function counted() {
    const claudeDir = tempDir()
    const userDataDir = tempDir()
    mkdirSync(join(claudeDir, 'projects', PROJECT), { recursive: true })
    mkdirSync(join(userDataDir, 'session-links'), { recursive: true })
    const read = { bytes: 0 }
    const countingFs = {
      ...fs,
      promises: {
        ...fs.promises,
        open: async (p: string, f?: string) => {
          const h = await fs.promises.open(p, f)
          return new Proxy(h, {
            get(target: any, prop) {
              if (prop === 'read') return async (...a: any[]) => { const r = await target.read(...a); read.bytes += r.bytesRead; return r }
              const v = target[prop]
              return typeof v === 'function' ? v.bind(target) : v
            },
          })
        },
      },
    }
    const updates: any[] = []
    const lens = createLens({ claudeDir, userDataDir, fs: countingFs, emit: (u: any) => updates.push(u), callKey, watch: () => null })
    const run = async (ms: number) => { for (let t = 0; t < ms; t += 10) { vi.advanceTimersByTime(Math.min(10, ms - t)); await lens.idle() } await lens.idle() }
    return { lens, updates, read, run, file: join(claudeDir, 'projects', PROJECT, `${T1}.jsonl`) }
  }

  /** basic.jsonl's prompt, answer and turn end, as turn n (fresh uuids) */
  const TURN = linesOf('basic.jsonl').map(l => JSON.parse(l.text)).filter(o => o.type === 'user' || (o.type === 'assistant' && o.message?.content?.some?.((c: any) => c.type === 'text')) || o.subtype === 'turn_duration')
  const turn = (n: number) => TURN.map((o, k) => JSON.stringify({ ...o, uuid: `t${n}-${k}-${'0'.repeat(8)}`, parentUuid: null })).join('\n') + '\n'
  const renderable = (items: any[]) => items.filter(i => i.kind !== 'turn-end')
  /** the bookkeeping a real turn carries (skipped unparsed: quickSkip) */
  const NOISE = JSON.stringify({ type: 'file-history-snapshot', messageId: 'm', snapshot: { trackedFileBackups: {}, note: 'x'.repeat(1500) } }) + '\n'

  it('a 20 000-turn transcript: the tail first (≤ 150 rows, ≤ 16 MB read), then three older pages, each older and new', async () => {
    const { lens, updates, read, run, file } = counted()
    const parts: string[] = []
    for (let n = 0; n < 20_000; n++) parts.push(NOISE, turn(n))
    writeFileSync(file, parts.join(''))
    expect(fs.statSync(file).size).toBeGreaterThan(55 << 20) // about 60 MB
    lens.setTerminals([term(T1)])
    lens.open(T1)
    await run(50)
    const reset = resetsOf(updates)[0]
    expect(reset).toBeTruthy()
    expect(renderable(reset.items).length).toBeGreaterThan(0)
    expect(renderable(reset.items).length).toBeLessThanOrEqual(150)
    expect(reset.status.hasOlder).toBe(true)
    expect(read.bytes).toBeLessThanOrEqual(16 << 20)
    const seen = new Set(reset.items.map((i: any) => i.id))
    let lowest = Math.min(...reset.items.map((i: any) => i.order))
    for (let page = 0; page < 3; page++) {
      const from = updates.length
      const answer = await lens.older(T1)
      await run(10)
      const ups = opsSince(updates, from).filter(o => o.op === 'upsert').flatMap(o => o.items)
      expect(answer.ok).toBe(true)
      expect(answer.loaded).toBe(ups.length)
      expect(renderable(ups).length).toBeGreaterThan(0)
      expect(renderable(ups).length).toBeLessThanOrEqual(150)
      for (const it of ups) {
        expect(seen.has(it.id), `${it.id} sent twice`).toBe(false)
        seen.add(it.id)
        expect(it.order).toBeLessThan(lowest)
      }
      lowest = Math.min(...ups.map((i: any) => i.order))
      const status = opsSince(updates, from).filter(o => o.op === 'status' || o.op === 'reset').pop()
      if (status) expect(status.status.hasOlder).toBe(true)
    }
    expect(read.bytes).toBeLessThanOrEqual(24 << 20)
    lens.dispose()
  }, 60_000)

  it('a result whose call is on the next older page becomes one row once that page loads', async () => {
    const { lens, updates, run, file } = counted()
    const call = linesOf('tools.jsonl').map(l => JSON.parse(l.text)).find(o => o.type === 'assistant' && o.message.content[0]?.name === 'Bash')
    const result = linesOf('tools.jsonl').map(l => JSON.parse(l.text)).find(o => o.type === 'user' && o.message.content?.[0]?.tool_use_id === call.message.content[0].id)
    const filler = (from: number, n: number) => Array.from({ length: n }, (_, i) => turn(from + i)).join('')
    // the page boundary falls between the call and its result: 150 kept lines from the result on
    const after = Math.ceil(149 / TURN.length)
    const tailTurns = filler(1000, after).split('\n').filter(Boolean).slice(0, 149).join('\n') + '\n'
    writeFileSync(file, filler(0, 200) + JSON.stringify(call) + '\n' + JSON.stringify(result) + '\n' + tailTurns)
    lens.setTerminals([term(T1)])
    lens.open(T1)
    await run(50)
    const id = call.message.content[0].id
    const first = resetsOf(updates)[0].items.filter((i: any) => i.id === id)
    expect(first).toHaveLength(1)
    expect(first[0].tool).toBeNull() // only the result so far
    const from = updates.length
    await lens.older(T1)
    await run(10)
    const ups = opsSince(updates, from).filter(o => o.op === 'upsert').flatMap(o => o.items).filter((i: any) => i.id === id)
    expect(ups).toHaveLength(1)
    expect(ups[0].tool).toBe('Bash')
    expect(ups[0].state).toBe('done')
    expect(ups[0].order).toBeLessThan(first[0].order)
    lens.dispose()
  })

  it('a closed view lets its rows go after a minute: opening it again reads the file again', async () => {
    const { lens, updates, read, run, file } = counted()
    writeFileSync(file, Array.from({ length: 400 }, (_, n) => turn(n)).join(''))
    lens.setTerminals([term(T1)])
    lens.open(T1)
    await run(50)
    lens.close(T1)
    await run(20_000)
    let bytes = read.bytes
    lens.open(T1) // inside the minute: the rows it kept, no tail read
    await run(50)
    expect(resetsOf(updates)).toHaveLength(2)
    expect(read.bytes - bytes).toBeLessThan(200 << 10)
    lens.close(T1)
    await run(61_000)
    bytes = read.bytes
    lens.open(T1) // after it: the rows were let go, the tail is read again
    await run(50)
    expect(resetsOf(updates)).toHaveLength(3)
    expect(read.bytes - bytes).toBeGreaterThan(200 << 10)
    expect(resetsOf(updates)[2].items.map((i: any) => i.id)).toEqual(resetsOf(updates)[0].items.map((i: any) => i.id))
    lens.dispose()
  })
})
