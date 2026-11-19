/**
 * electron/chatChanges.cjs — the change index of a conversation: counts and byte
 * offsets only, built by a forward scan of the whole transcript (and the sub-agents' own files) and by
 * the lens's live lines; each edit re-read from its line when asked, checked by its tool id, rebuilt with
 * chatItems' buildDiff, never merged; no disk read of a project file. Fake timers; a temp Claude folder.
 */

import fs, { appendFileSync, closeSync, copyFileSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync, writeSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FIX, linesOf } from './chat-helpers'

const require = createRequire(import.meta.url)
const { createChangeIndex, scanChanges, readEdit, CHANGE_CAPS } = require('../electron/chatChanges.cjs')
const { createLens } = require('../electron/chatLens.cjs')
const { createItemBuilder } = require('../electron/chatItems.cjs')
const { callKey } = require('../hooks/spawn-hook.cjs')

const PROJECT = 'C--Users-user-work-demo'
const CWD = 'C:\\Users\\user\\work\\demo'
const T1 = '11111111-1111-4111-8111-111111111111'
const AGENT = 'afixture02'
const MAIN_FIX = join(FIX, 'changes.jsonl')
const AGENT_FIX = join(FIX, 'changes-agent', 'subagents', `agent-${AGENT}.jsonl`)

const dirs: string[] = []
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }) })
const tempDir = () => { const d = mkdtempSync(join(tmpdir(), 'spawn-chat-changes-')); dirs.push(d); return d }

beforeEach(() => { vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] }); vi.setSystemTime(new Date('2026-11-14T12:00:00Z')) })
afterEach(() => { vi.useRealTimers() })

const tick = () => new Promise<void>(r => setImmediate(r))

/** A Claude folder with the transcript (and the sub-agent's file where the lens looks for it), and a lens over it */
function setup({ main = MAIN_FIX, agent = true }: { main?: string | null; agent?: boolean } = {}) {
  const claudeDir = tempDir()
  const userDataDir = tempDir()
  const projectDir = join(claudeDir, 'projects', PROJECT)
  mkdirSync(projectDir, { recursive: true })
  mkdirSync(join(userDataDir, 'session-links'), { recursive: true })
  const transcript = join(projectDir, `${T1}.jsonl`)
  // <transcript folder>/<conversation>/subagents/agent-<id>.jsonl (as chatLens.cjs readAgent looks)
  const agentFile = join(projectDir, T1, 'subagents', `agent-${AGENT}.jsonl`)
  if (main) copyFileSync(main, transcript)
  if (agent) { mkdirSync(dirname(agentFile), { recursive: true }); copyFileSync(AGENT_FIX, agentFile) }
  const updates: any[] = []
  const logs: string[] = []
  /** every path the lens touched, and the ones it opened or read (the spy fs) */
  const touched: string[] = []
  const opened: string[] = []
  const note = (p: unknown, read = false) => { touched.push(String(p)); if (read) opened.push(String(p)) }
  const wrap = (o: any, names: string[], read: boolean) => Object.fromEntries(names.filter(n => typeof o[n] === 'function').map(n => [n, (p: any, ...a: any[]) => { note(p, read); return o[n](p, ...a) }]))
  const spyFs = {
    ...fs,
    ...wrap(fs, ['readFileSync', 'createReadStream', 'openSync'], true),
    ...wrap(fs, ['statSync', 'lstatSync', 'existsSync', 'realpathSync', 'readdirSync', 'accessSync'], false),
    promises: {
      ...fs.promises,
      ...wrap(fs.promises, ['open', 'readFile'], true),
      ...wrap(fs.promises, ['stat', 'lstat', 'realpath', 'readdir', 'access'], false),
    },
  }
  const lens = createLens({ claudeDir, userDataDir, fs: spyFs, emit: (u: any) => updates.push({ ...u, now: Date.now() }), callKey, watch: () => null, log: (_l: string, m: string) => logs.push(m) })
  const statuses = () => updates.flatMap(u => u.ops).filter((o: any) => o.op === 'status' || o.op === 'reset').map((o: any) => o.status)
  const changesState = () => statuses().at(-1)?.changes
  /** fake time passes in 10 ms steps, real IO and the scan's yields in between, until `cond` */
  const until = async (cond: () => boolean, what = '') => {
    const end = performance.now() + 30_000
    while (!cond()) {
      if (performance.now() > end) throw new Error(`timed out: ${what}`)
      vi.advanceTimersByTime(10)
      await tick()
    }
  }
  const ready = () => until(() => ['ready', 'partial'].includes(changesState()?.state), 'the index ready')
  return { claudeDir, userDataDir, projectDir, transcript, agentFile, updates, logs, touched, opened, lens, statuses, changesState, until, ready }
}
const term = (id: string) => ({ id, cwd: CWD, armed: true, status: 'running' })

/** What chatItems gives each tool row of the fixtures (main, and the sub-agent's under its Agent row) */
function itemDiffs() {
  const diffs = new Map<string, any>()
  const main = createItemBuilder({ cwd: CWD })
  for (const l of linesOf('changes.jsonl')) for (const i of main.line(JSON.parse(l.text), l.offset)) if (i.kind === 'tool') diffs.set(i.id, i.diff)
  const sub = createItemBuilder({ cwd: CWD, parent: 'toolu_fixture_c11' })
  for (const l of linesOf('changes-agent/subagents/agent-afixture02.jsonl')) for (const i of sub.line(JSON.parse(l.text), l.offset)) if (i.kind === 'tool') diffs.set(i.id, i.diff)
  return diffs
}

const EDIT_KEYS = ['toolId', 'order', 'at', 'agentId', 'kind', 'added', 'removed', 'state', 'diff']
const FILE_KEYS = ['file', 'outside', 'created', 'edits', 'added', 'removed', 'unknown', 'cut', 'agent', 'last']
const SUMMARY_KEYS = ['v', 'state', 'files', 'edits', 'added', 'removed', 'unknown']

describe('the index over changes.jsonl (through the lens)', () => {
  it('files, kinds, missing, cut, the sub-agent\'s edit; nothing for the failed or rejected edit', async () => {
    const s = setup()
    s.lens.setTerminals([term(T1)])
    s.lens.open(T1)
    await s.until(() => s.statuses().length > 0, 'the reset')
    // the reset already says the index is being gathered
    expect(s.statuses()[0].changes).toMatchObject({ state: 'scanning' })
    await s.ready()
    const r = await s.lens.changes(T1)
    expect(r.ok).toBe(true)
    expect(Object.keys(r.summary).sort()).toEqual([...SUMMARY_KEYS].sort())
    for (const f of r.files) for (const k of Object.keys(f)) expect(FILE_KEYS).toContain(k)
    const byName = Object.fromEntries(r.files.map((f: any) => [f.file, f]))
    expect(Object.keys(byName).sort()).toEqual(['C:\\Users\\user\\other\\x.txt', 'README.md', 'notebooks/rivers.ipynb', 'src/config.js', 'src/math.js', 'src/rivers.js', 'src/util.js'])
    expect(byName['src/math.js']).toMatchObject({ edits: 4, agent: true, created: false, unknown: 0, outside: false })
    expect(byName['src/util.js']).toMatchObject({ edits: 1, created: true })
    expect(byName['README.md']).toMatchObject({ edits: 1, created: false })
    expect(byName['C:\\Users\\user\\other\\x.txt']).toMatchObject({ outside: true, edits: 1 })
    expect(byName['src/config.js']).toMatchObject({ edits: 1, unknown: 1, added: 0, removed: 0 })
    expect(byName['notebooks/rivers.ipynb']).toMatchObject({ edits: 1, unknown: 1 })
    expect(byName['src/rivers.js']).toMatchObject({ cut: true, unknown: 0 })
    expect(r.agentsUnread).toBe(0)
    // the edits whose patch the record holds: their counts summed (the missing Edit and the NotebookEdit: unknown)
    const diffs = itemDiffs()
    const known = ['c01', 'c02', 'c03', 'c04', 'c06', 'c09', 'ca1', 'c12'].map(x => diffs.get(`toolu_fixture_${x}`))
    expect(known.every(Boolean)).toBe(true)
    expect(r.summary).toMatchObject({
      state: 'ready', files: 7, edits: 10, unknown: 2,
      added: known.reduce((n, d) => n + d.added, 0), removed: known.reduce((n, d) => n + d.removed, 0),
    })
    // per file too: the sums of its known edits
    expect(byName['src/math.js'].added).toBe(['c01', 'c02', 'ca1', 'c12'].reduce((n, x) => n + diffs.get(`toolu_fixture_${x}`).added, 0))
    // the failed (c07) and the rejected (c08) Edit of math.js left nothing
    const m = await s.lens.changeFile(T1, 'src/math.js')
    expect(m.edits.map((e: any) => e.toolId)).toEqual(['toolu_fixture_c01', 'toolu_fixture_c02', 'toolu_fixture_ca1', 'toolu_fixture_c12'])
    const missing = (await s.lens.changeFile(T1, 'src/config.js')).edits[0]
    expect(missing).toMatchObject({ toolId: 'toolu_fixture_c05', state: 'missing', added: null, removed: null, kind: 'edit' })
    expect(missing.diff).toBeUndefined()
    const nb = (await s.lens.changeFile(T1, 'notebooks/rivers.ipynb')).edits[0]
    expect(nb).toMatchObject({ toolId: 'toolu_fixture_c10', kind: 'notebook', state: 'missing', added: null, removed: null })
    expect((await s.lens.changeFile(T1, 'src/util.js')).edits[0]).toMatchObject({ kind: 'create', state: 'ok' })
    expect((await s.lens.changeFile(T1, 'README.md')).edits[0]).toMatchObject({ kind: 'write', state: 'ok' })
    // a file name as the page may send it back: the same file, without case on Windows
    expect((await s.lens.changeFile(T1, 'SRC/Math.js')).edits).toHaveLength(4)
    expect((await s.lens.changeFile(T1, 'C:/Users/user/other/x.txt')).ok).toBe(true)
    expect(await s.lens.changeFile(T1, 'src/nothing.js')).toEqual({ ok: false, reason: 'unknown' })
  })

  it('a file outside the session folder is named one way everywhere, as recorded: the chat\'s diff block, the tool row and the panel', async () => {
    const s = setup()
    s.lens.setTerminals([term(T1)])
    s.lens.open(T1)
    await s.ready()
    const recorded = 'C:\\Users\\user\\other\\x.txt'
    const diff = itemDiffs().get('toolu_fixture_c09')
    expect(diff.file).toBe(recorded)
    const main = createItemBuilder({ cwd: CWD })
    const row = linesOf('changes.jsonl').flatMap((l: any) => main.line(JSON.parse(l.text), l.offset)).find((i: any) => i.id === 'toolu_fixture_c09')
    expect(row.input.file).toBe(recorded)
    const r = await s.lens.changes(T1)
    expect(r.files.filter((f: any) => f.outside).map((f: any) => f.file)).toEqual([recorded])
    const got = await s.lens.changeFile(T1, diff.file)
    expect(got.ok).toBe(true)
    expect(got.edits[0].diff.file).toBe(recorded)
    // inside the folder: relative with forward slashes, as before
    expect(itemDiffs().get('toolu_fixture_c01').file).toBe('src/math.js')
  })

  it('edits in transcript order, each re-read from its line: the same DiffBlock chatItems gives that row; never merged', async () => {
    const s = setup()
    s.lens.setTerminals([term(T1)])
    s.lens.open(T1)
    await s.ready()
    const diffs = itemDiffs()
    const r = await s.lens.changes(T1)
    for (const f of r.files) {
      const got = await s.lens.changeFile(T1, f.file)
      expect(got.ok).toBe(true)
      expect(got.file).toEqual(f)
      expect(got.more).toBe(0)
      for (const e of got.edits) {
        for (const k of Object.keys(e)) expect(EDIT_KEYS).toContain(k)
        if (e.state === 'missing') continue
        expect(e.state).toBe('ok')
        expect(e.diff).toEqual(diffs.get(e.toolId))
        expect([e.added, e.removed]).toEqual([e.diff.added, e.diff.removed])
      }
      // order grows (transcript order; the sub-agent's edit placed by its time)
      const at = got.edits.map((e: any) => e.at)
      expect(at).toEqual([...at].sort((a: number, b: number) => a - b))
    }
    const math = await s.lens.changeFile(T1, 'src/math.js')
    const [c01, c02, ca1, c12] = math.edits
    expect(ca1).toMatchObject({ agentId: AGENT, kind: 'edit', state: 'ok' })
    expect(c01.agentId).toBeUndefined()
    // the two-hunk edit keeps both hunks: nothing composed
    expect(c02.diff.hunks).toHaveLength(2)
    expect(c02.diff).toEqual(diffs.get('toolu_fixture_c02'))
    expect(c12.order).toBeGreaterThan(c01.order)
    // the 5,000-character line: cut as chatItems cuts it
    const rivers = (await s.lens.changeFile(T1, 'src/rivers.js')).edits[0]
    expect(rivers.diff.truncated).toBe(true)
    expect(rivers.diff).toEqual(diffs.get('toolu_fixture_c06'))
  })

  it('source: nothing composes hunks, and the file\'s own text is never named', () => {
    const src = readFileSync(join(__dirname, '..', 'electron', 'chatChanges.cjs'), 'utf8')
    expect(src).not.toMatch(/oldStart\s*\+/)
    expect(src).not.toMatch(/newStart\s*\+/)
    expect(src).not.toContain('originalFile')
  })

  it('no disk read of a project file: only the transcript and the sub-agent\'s file are opened', async () => {
    const s = setup()
    s.lens.setTerminals([term(T1)])
    s.lens.open(T1)
    await s.ready()
    for (const f of (await s.lens.changes(T1)).files) await s.lens.changeFile(T1, f.file)
    expect(s.opened.length).toBeGreaterThan(0)
    const norm = (p: string) => p.replace(/\\/g, '/').toLowerCase()
    // (the app's own session-links files aside: the lens reads which conversation a terminal runs)
    for (const p of s.opened.filter(x => !norm(x).startsWith(norm(s.userDataDir)))) expect([norm(s.transcript), norm(s.agentFile)]).toContain(norm(p))
    expect(s.opened.map(norm)).toContain(norm(s.agentFile))
    // nothing of the session folder is even looked at
    for (const p of s.touched) expect(norm(p)).not.toContain('work/demo')
    for (const p of s.touched) expect(norm(p).startsWith(norm(s.claudeDir)) || norm(p).startsWith(norm(s.userDataDir))).toBe(true)
  })

  it('stale: a line rewritten at an indexed offset (same length) — the edit is stale, and the lens says rewrite', async () => {
    const s = setup()
    s.lens.setTerminals([term(T1)])
    s.lens.open(T1)
    await s.ready()
    expect((await s.lens.changeFile(T1, 'src/math.js')).edits.every((e: any) => e.state === 'ok')).toBe(true)
    // c01's result line, its tool id changed in place (same length)
    const buf = readFileSync(s.transcript)
    const line = linesOf('changes.jsonl').find(l => l.text.includes('"tool_use_id":"toolu_fixture_c01"'))!
    const at = buf.indexOf('toolu_fixture_c01', line.offset)
    buf.write('toolu_fixture_x01', at)
    writeFileSync(s.transcript, buf)
    const got = await s.lens.changeFile(T1, 'src/math.js')
    expect(got.ok).toBe(true)
    // (a file this small: the tailer's guard sees the change, so every edit of the view is stale)
    expect(got.edits.map((e: any) => e.state)).toEqual(['stale', 'stale', 'stale', 'stale'])
    expect(got.edits.every((e: any) => e.diff === undefined)).toBe(true)
    expect(s.statuses().at(-1).banner).toEqual({ reason: 'rewrite' })
    // the index went with the record it no longer matches
    expect(await s.lens.changes(T1)).toEqual({ ok: false })
  })

  it('readEdit: checked by its tool id at its offset; another line there is stale', async () => {
    const dir = tempDir()
    const file = join(dir, 'main.jsonl')
    copyFileSync(MAIN_FIX, file)
    const index = createChangeIndex({ cwd: CWD })
    const r = await scanChanges(file, index, { fs: fs.promises })
    expect(r).toMatchObject({ partial: false, aborted: false })
    const got = index.editsOf('src/math.js')
    const diffs = itemDiffs()
    for (const e of got.edits) expect(await readEdit(file, e, { fs: fs.promises, cwd: CWD })).toEqual({ state: 'ok', diff: diffs.get(e.toolId) })
    // c01's line overwritten with c02's id (same length): only c01 is stale (no guard given)
    const buf = readFileSync(file)
    const at = buf.indexOf('"tool_use_id":"toolu_fixture_c01"')
    buf.write('"tool_use_id":"toolu_fixture_c02"', at)
    writeFileSync(file, buf)
    expect(await readEdit(file, got.edits[0], { fs: fs.promises, cwd: CWD })).toEqual({ state: 'stale' })
    expect((await readEdit(file, got.edits[1], { fs: fs.promises, cwd: CWD })).state).toBe('ok')
    // a guard that says the file changed: stale without reading
    expect(await readEdit(file, got.edits[1], { fs: fs.promises, cwd: CWD, guard: async () => false })).toEqual({ state: 'stale' })
    // an offset past the end: stale, never an error
    expect(await readEdit(file, { ...got.edits[1], src: { file: 'main', offset: 10 << 20 } }, { fs: fs.promises, cwd: CWD })).toEqual({ state: 'stale' })
  })

  it('a sub-agent\'s file read again: on a changes request, from where it stopped', async () => {
    const s = setup()
    s.lens.setTerminals([term(T1)])
    s.lens.open(T1)
    await s.ready()
    // a second edit by the sub-agent (its lines again, under another tool id of the same length)
    const extra = linesOf('changes-agent/subagents/agent-afixture02.jsonl').filter(l => l.text.includes('toolu_fixture_ca1'))
      .map(l => l.text.replace(/toolu_fixture_ca1/g, 'toolu_fixture_ca9').replace(/"uuid":"([0-9a-f-]+)"/, (_m, u) => `"uuid":"${u.slice(0, -3)}9a9"`)
        .replace(/"timestamp":"2026-11-14T05:00:\d\d\.\d+Z"/g, '"timestamp":"2026-11-14T05:00:40.900Z"'))
    appendFileSync(s.agentFile, extra.join('\n') + '\n')
    const opensBefore = s.opened.length
    const r = await s.lens.changes(T1)
    expect(r.files.find((f: any) => f.file === 'src/math.js').edits).toBe(5)
    expect(s.opened.length).toBeGreaterThan(opensBefore)
    const ids = (await s.lens.changeFile(T1, 'src/math.js')).edits.map((e: any) => e.toolId)
    expect(ids).toEqual(['toolu_fixture_c01', 'toolu_fixture_c02', 'toolu_fixture_ca1', 'toolu_fixture_ca9', 'toolu_fixture_c12'])
    // asked again with nothing new: the same counts (the agent's file read on from where it stopped)
    expect((await s.lens.changes(T1)).files.find((f: any) => f.file === 'src/math.js').edits).toBe(5)
  })

  it('(review) a changes request opens a sub-agent\'s file only when it grew (a stat otherwise)', async () => {
    const s = setup()
    s.lens.setTerminals([term(T1)])
    s.lens.open(T1)
    await s.ready()
    const norm = (p: string) => p.replace(/\\/g, '/').toLowerCase()
    const opensOfAgent = () => s.opened.map(norm).filter(p => p === norm(s.agentFile)).length
    const first = opensOfAgent()
    expect(first).toBeGreaterThan(0)
    for (let i = 0; i < 5; i++) await s.lens.changes(T1)
    expect(opensOfAgent()).toBe(first)
    // it grew: read on (opened once more), then quiet again
    const extra = linesOf('changes-agent/subagents/agent-afixture02.jsonl').filter(l => l.text.includes('toolu_fixture_ca1'))
      .map(l => l.text.replace(/toolu_fixture_ca1/g, 'toolu_fixture_ca8').replace(/"uuid":"([0-9a-f-]+)"/, (_m, u) => `"uuid":"${u.slice(0, -3)}8a8"`)
        .replace(/"timestamp":"2026-11-14T05:00:\d\d\.\d+Z"/g, '"timestamp":"2026-11-14T05:00:40.900Z"'))
    appendFileSync(s.agentFile, extra.join('\n') + '\n')
    const r = await s.lens.changes(T1)
    expect(r.files.find((f: any) => f.file === 'src/math.js').edits).toBe(5)
    expect(opensOfAgent()).toBe(first + 1)
    await s.lens.changes(T1)
    expect(opensOfAgent()).toBe(first + 1)
  })

  it('a sub-agent whose file is not there is counted in agentsUnread; a path outside projects/ is never read', async () => {
    const s = setup({ agent: false })
    // SubagentStop names a file outside the Claude folder (it exists): never opened
    const elsewhere = join(tempDir(), `agent-${AGENT}.jsonl`)
    copyFileSync(AGENT_FIX, elsewhere)
    s.lens.setTerminals([term(T1)])
    s.lens.open(T1)
    await s.ready()
    s.lens.hook('SubagentStop', { session_id: T1, agent_id: AGENT, agent_transcript_path: elsewhere }, Date.now())
    const r = await s.lens.changes(T1)
    expect(r.agentsUnread).toBe(1)
    expect(r.files.find((f: any) => f.file === 'src/math.js')).toMatchObject({ edits: 3, agent: false })
    const norm = (p: string) => p.replace(/\\/g, '/').toLowerCase()
    expect(s.touched.map(norm)).not.toContain(norm(elsewhere))
    // an agent id that is a path is never learned
    const index = createChangeIndex({ cwd: CWD })
    const agentLine = JSON.parse(linesOf('changes.jsonl').find(l => l.text.includes('"agentId":"afixture02"'))!.text)
    agentLine.toolUseResult.agentId = '..\\..\\evil'
    index.line(agentLine, 100)
    expect(index.agents()).toEqual([])
  })
})

describe('the index (pure)', () => {
  const editPair = (n: number, file: string, extra: Record<string, unknown> = {}) => {
    const id = `toolu_cap_${n}`
    const uuid = (k: number) => `00000000-0000-4000-8000-${String(k).padStart(12, '0')}`
    const call = { type: 'assistant', uuid: uuid(2 * n), timestamp: '2026-11-14T05:00:00.000Z', message: { role: 'assistant', stop_reason: 'tool_use', content: [{ type: 'tool_use', id, name: 'Edit', input: { file_path: file, old_string: 'a', new_string: 'b' } }] } }
    const result = { type: 'user', uuid: uuid(2 * n + 1), timestamp: '2026-11-14T05:00:01.000Z', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] }, toolUseResult: { filePath: file, oldString: 'a', newString: 'b', structuredPatch: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-a', '+b'] }], ...extra } }
    return [call, result]
  }

  it('caps: 2,100 files → partial with 2,000; 510 edits of one file → the oldest go, partial', () => {
    const index = createChangeIndex({ cwd: CWD })
    let off = 0
    for (let i = 0; i < 2100; i++) for (const o of editPair(i, `${CWD}\\src\\f${i}.js`)) index.line(o, off += 100)
    expect(index.files()).toHaveLength(CHANGE_CAPS.files)
    expect(index.summary()).toMatchObject({ files: 2000, edits: 2000, partial: true })
    const one = createChangeIndex({ cwd: CWD })
    off = 0
    for (let i = 0; i < 510; i++) for (const o of editPair(i, `${CWD}\\src\\one.js`)) one.line(o, off += 100)
    const got = one.editsOf('src/one.js', undefined, 1000)
    expect(got.edits).toHaveLength(CHANGE_CAPS.editsPerFile)
    expect(got.edits[0].toolId).toBe('toolu_cap_10')
    // (counts stay true for what is kept)
    expect(one.summary()).toMatchObject({ edits: 500, added: 500, removed: 500, partial: true })
    expect(CHANGE_CAPS).toEqual({ files: 2000, editsPerFile: 500, calls: 5000, scanBytes: 1 << 30, agents: 50, agentBytes: 64 << 20, bodyEdits: 20, bodyLines: 4000, lineBytes: 32 << 20 })
  })

  it('idempotent by tool id: the same line again (or the same result at another offset) is not counted twice', () => {
    const index = createChangeIndex({ cwd: CWD })
    const [call, result] = editPair(1, `${CWD}\\src\\a.js`)
    index.line(call, 10)
    index.line(result, 20)
    const once = index.summary()
    index.line(call, 10)
    index.line(result, 20)
    index.line(result, 9000)
    expect(index.summary()).toEqual(once)
    expect(index.editsOf('src/a.js').edits).toHaveLength(1)
  })

  it('failed, rejected and interrupted edits leave no entry; a result whose call was not seen is judged by its shape', () => {
    const index = createChangeIndex({ cwd: CWD })
    const [c1, r1] = editPair(1, `${CWD}\\src\\a.js`)
    index.line(c1, 1); index.line({ ...r1, message: { ...r1.message, content: [{ ...r1.message.content[0], is_error: true }] } }, 2)
    const [c2, r2] = editPair(2, `${CWD}\\src\\b.js`)
    index.line(c2, 3); index.line({ ...r2, toolUseResult: 'User rejected tool use' }, 4)
    const [c3, r3] = editPair(3, `${CWD}\\src\\c.js`, { interrupted: true })
    index.line(c3, 5); index.line(r3, 6)
    const [c4, r4] = editPair(4, `${CWD}\\src\\d.js`)
    index.line(c4, 7); index.line({ ...r4, toolDenialKind: 'user-rejected' }, 8)
    expect(index.summary()).toMatchObject({ files: 0, edits: 0 })
    // the call on an older page (not seen): the result's own patch makes the entry
    const [, r5] = editPair(5, `${CWD}\\src\\e.js`)
    index.line(r5, 9)
    expect(index.editsOf('src/e.js').edits[0]).toMatchObject({ toolId: 'toolu_cap_5', kind: 'edit', state: 'ok', added: 1, removed: 1 })
    // a sidechain line in the main transcript is a sub-agent's, not the main thread's (as chatItems skips it)
    const [c6, r6] = editPair(6, `${CWD}\\src\\f.js`)
    index.line({ ...c6, isSidechain: true }, 11); index.line({ ...r6, isSidechain: true }, 12)
    expect(index.editsOf('src/f.js')).toBeNull()
  })

  it('only candidate lines are parsed (a Read result that merely holds the words is passed over cheaply)', async () => {
    const dir = tempDir()
    const file = join(dir, 'x.jsonl')
    const lines = [
      { type: 'user', uuid: '00000000-0000-4000-8000-000000000001', message: { role: 'user', content: 'hi' } },
      { type: 'assistant', uuid: '00000000-0000-4000-8000-000000000002', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_r', name: 'Read', input: { file_path: 'x' } }] } },
      { type: 'user', uuid: '00000000-0000-4000-8000-000000000003', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_r', content: 'x' }] }, toolUseResult: { type: 'text', file: { filePath: 'x', content: 'tool_use Edit', numLines: 1 } } },
    ]
    writeFileSync(file, lines.map(l => JSON.stringify(l)).join('\n') + '\n')
    const index = createChangeIndex({ cwd: CWD })
    const spy = vi.spyOn(index, 'line')
    await scanChanges(file, index, { fs: fs.promises })
    expect(spy).not.toHaveBeenCalled()
  })
})

describe('the whole conversation', () => {
  /** A synthetic transcript of about `bytes` with `edits` Edits spread through it (generated here, never committed) */
  function bigTranscript(file: string, edits: number, bytes: number, files = 40) {
    const fd = openSync(file, 'w')
    let n = 0
    const uuid = () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`
    const write = (o: unknown) => writeSync(fd, JSON.stringify(o) + '\n')
    write({ type: 'user', uuid: uuid(), timestamp: '2026-11-14T05:00:00.000Z', message: { role: 'user', content: 'Tidy every river file.' } })
    const filler = 'the rivers flow on '.repeat(Math.max(1, Math.floor(bytes / edits / 19) - 40))
    for (let i = 0; i < edits; i++) {
      const at = new Date(Date.parse('2026-11-14T05:00:01.000Z') + i * 1000).toISOString()
      write({ type: 'assistant', uuid: uuid(), timestamp: at, message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: filler }] } })
      const id = `toolu_big_${i}`
      const fp = `${CWD}\\src\\river${i % files}.js`
      write({ type: 'assistant', uuid: uuid(), timestamp: at, message: { role: 'assistant', stop_reason: 'tool_use', content: [{ type: 'tool_use', id, name: 'Edit', input: { file_path: fp, old_string: 'a', new_string: 'b' } }] } })
      write({ type: 'user', uuid: uuid(), timestamp: at, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] }, toolUseResult: { filePath: fp, oldString: 'a', newString: 'b', structuredPatch: [{ oldStart: i + 1, oldLines: 1, newStart: i + 1, newLines: 1, lines: ['-a', '+b'] }], userModified: false, replaceAll: false } })
    }
    closeSync(fd)
  }

  it('a 40 MB transcript with 600 edits: all 600 counted while the page got only the tail; a hook during the scan is not held back', async () => {
    const s = setup({ main: null, agent: false })
    bigTranscript(s.transcript, 600, 40 << 20)
    expect(fs.statSync(s.transcript).size).toBeGreaterThan(38 << 20)
    s.lens.setTerminals([term(T1)])
    s.lens.open(T1)
    await s.until(() => s.updates.some(u => u.ops.some((o: any) => o.op === 'reset')), 'the reset')
    const reset = s.updates.flatMap(u => u.ops).find((o: any) => o.op === 'reset')
    expect(reset.items.length).toBeLessThanOrEqual(150)
    expect(reset.status.changes.state).toBe('scanning')
    // a hook posted while the scan runs: emitted at once (the scan yields), and the view's queue does not wait for the scan
    const posted = performance.now()
    let emittedAt = -1
    let scanningThen = ''
    setImmediate(() => {
      s.lens.hook('PreToolUse', { session_id: T1, tool_name: 'Read', tool_use_id: 'toolu_live_1', tool_input: { file_path: 'x' } }, Date.now())
      if (s.updates.flatMap(u => u.ops).some((o: any) => o.op === 'upsert' && o.items.some((i: any) => i.id === 'toolu_live_1'))) emittedAt = performance.now()
      scanningThen = s.changesState()?.state
    })
    await s.until(() => emittedAt >= 0, 'the hook row')
    expect(emittedAt - posted).toBeLessThan(250)
    expect(scanningThen).toBe('scanning')
    // the read the hook asked for (50 ms later) runs in the view's queue while the scan still runs
    vi.advanceTimersByTime(60)
    await s.lens.idle()
    expect(s.changesState().state).toBe('scanning')
    await s.ready()
    const r = await s.lens.changes(T1)
    expect(r.summary).toMatchObject({ state: 'ready', edits: 600, files: 40, added: 600, removed: 600, unknown: 0 })
    // the newest 20 with their diffs, newest last; the 20 before them on asking
    const page = await s.lens.changeFile(T1, 'src/river0.js')
    expect(page.edits).toHaveLength(15)
    expect(page.more).toBe(0)
    const p1 = await s.lens.changeFile(T1, 'src/river1.js')
    expect(p1.edits.map((e: any) => e.toolId)).toEqual(Array.from({ length: 15 }, (_, k) => `toolu_big_${1 + 40 * k}`))
    expect(p1.edits.every((e: any) => e.state === 'ok' && e.diff.hunks.length === 1)).toBe(true)
    // the status's v grew with each change, and was sent at most every 500 ms (fake time)
    const sent: { v: number; now: number }[] = []
    for (const u of s.updates) {
      for (const o of u.ops) {
        const v = (o.op === 'status' || o.op === 'reset') ? o.status.changes?.v : undefined
        if (typeof v === 'number' && v !== sent.at(-1)?.v) sent.push({ v, now: u.now })
      }
    }
    expect(sent.length).toBeGreaterThan(1)
    expect(sent.map(x => x.v)).toEqual(sent.map((_, i) => i + 1))
    for (let i = 1; i < sent.length; i++) expect(sent[i].now - sent[i - 1].now).toBeGreaterThanOrEqual(500)
  }, 120_000)

  it('the newest 20 edits of a file, `more` older ones, and the ones before `before`', async () => {
    const file = join(tempDir(), 'one.jsonl')
    bigTranscript(file, 50, 1 << 20, 1)
    const one = createChangeIndex({ cwd: CWD })
    await scanChanges(file, one, { fs: fs.promises })
    expect(one.summary()).toMatchObject({ edits: 50, files: 1 })
    const newest = one.editsOf('src/river0.js')
    expect(newest.edits).toHaveLength(CHANGE_CAPS.bodyEdits)
    expect(newest.more).toBe(30)
    expect(newest.edits.at(-1).toolId).toBe('toolu_big_49')
    const older = one.editsOf('src/river0.js', newest.edits[0].order)
    expect(older.edits.map((e: any) => e.toolId)).toEqual(Array.from({ length: 20 }, (_, k) => `toolu_big_${10 + k}`))
    expect(older.more).toBe(10)
  })
})

describe('worker and host wiring', () => {
  const read = (...p: string[]) => readFileSync(join(__dirname, '..', ...p), 'utf8')

  it('chat:changes / chat:change-file: registered in registerIpc only (CHAT_VIEW), through guard; preload and desktop.ts', () => {
    const host = read('electron', 'chatHost.cjs')
    const at = host.indexOf('function registerIpc(')
    const reg = host.slice(at, host.indexOf('\n  }\n', at))
    for (const name of ["'chat:changes'", "'chat:change-file'"]) {
      expect(host.split(name).length - 1).toBe(1)
      expect(reg).toContain(name)
      const line = reg.split('\n').find(l => l.includes(name))!
      expect(line).toMatch(/ipcMain\.handle\('chat:change(s|-file)', guard\(/)
    }
    for (const f of ['main.cjs', 'chatWorker.cjs', 'chatLens.cjs']) expect(read('electron', f)).not.toMatch(/['"`]chat:change/)
    const preload = read('electron', 'preload.cjs')
    expect(preload).toMatch(/changes: \(id\) => ipcRenderer\.invoke\('chat:changes', String\(id\)\)/)
    expect(preload).toContain("changeFile: (p) => ipcRenderer.invoke('chat:change-file', {")
    const desktop = read('src', 'desktop.ts')
    expect(desktop).toMatch(/changes\(id: string\): Promise<\{ ok: true; summary: ChangeSummary; files: ChangeFile\[\]; agentsUnread: number \} \| \{ ok: false \}>/)
    expect(desktop).toMatch(/changeFile\(p: \{ id: string; file: string; before\?: number \}\)/)
    // the lens makes an index only for an open view that loaded its transcript (off: no view, no index)
    const lens = read('electron', 'chatLens.cjs')
    // (its definition and its one call)
    expect(lens.split('startChanges(').length - 1).toBe(2)
    expect(lens.slice(lens.indexOf('async function load(t)'), lens.indexOf('async function readNew(t)'))).toContain('startChanges(t, r.endOffset)')
  })

  it('the real worker answers changes and change-file', async () => {
    vi.useRealTimers()
    const s = setup()
    const { Worker } = await import('node:worker_threads')
    const worker = new Worker(join(__dirname, '..', 'electron', 'chatWorker.cjs'), { env: { ...process.env, CLAUDE_CONFIG_DIR: s.claudeDir } })
    const messages: any[] = []
    worker.on('message', (m) => messages.push(m))
    const reply = async (req: number) => {
      const end = Date.now() + 10_000
      while (!messages.some(m => m.t === 'reply' && m.req === req)) { if (Date.now() > end) throw new Error('timed out'); await new Promise(r => setTimeout(r, 10)) }
      return messages.find(m => m.t === 'reply' && m.req === req).result
    }
    try {
      worker.postMessage({ t: 'init', userDataDir: s.userDataDir, version: '2.1.325 (Claude Code)' })
      worker.postMessage({ t: 'terminals', list: [term(T1)] })
      // no view open: no index
      worker.postMessage({ t: 'changes', id: T1, req: 1 })
      expect(await reply(1)).toEqual({ ok: false })
      worker.postMessage({ t: 'open', id: T1 })
      let r: any
      for (let i = 2; ; i++) {
        worker.postMessage({ t: 'changes', id: T1, req: i })
        r = await reply(i)
        if (r.ok && r.summary.state === 'ready') break
        await new Promise(res => setTimeout(res, 20))
      }
      expect(r.summary).toMatchObject({ files: 7, edits: 10, unknown: 2 })
      worker.postMessage({ t: 'change-file', id: T1, file: 'src/math.js', req: 900 })
      const f = await reply(900)
      expect(f.edits.map((e: any) => e.toolId)).toEqual(['toolu_fixture_c01', 'toolu_fixture_c02', 'toolu_fixture_ca1', 'toolu_fixture_c12'])
      expect(f.edits.every((e: any) => e.state === 'ok' && e.diff)).toBe(true)
      worker.postMessage({ t: 'change-file', id: T1, file: 'nope.js', req: 901 })
      expect(await reply(901)).toEqual({ ok: false, reason: 'unknown' })
      for (const m of messages.filter(x => x.t === 'log')) expect(m.msg).not.toMatch(/math|rivers|[\\/]/)
    } finally {
      await worker.terminate()
    }
  }, 30_000)

  it('the logs carry no file name and no text', async () => {
    const s = setup()
    s.lens.setTerminals([term(T1)])
    s.lens.open(T1)
    await s.ready()
    await s.lens.changes(T1)
    for (const m of s.logs) expect(m).not.toMatch(/math|rivers|util|README|config|[\\/]/)
  })
})
