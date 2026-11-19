/**
 * The resume list (이어하기): no two identical "Spawn" rows after a /clear, twins told apart, and a session
 * just closed is "닫는 중" (deleting it waits for its end), while a registry file whose pid Windows reused for another
 * program no longer reads as running.
 */

import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import { numbered, withDates } from '../src/sameNames'

const require = createRequire(import.meta.url)
const history = require('../electron/history.cjs')
const { trashWhenEnded } = require('../electron/sessionTrash.cjs')
const { createTerminalManager } = require('../electron/terminals.cjs')
const REPO = fileURLToPath(new URL('..', import.meta.url))

const dirs: string[] = []
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }) })
const tempDir = () => { const d = mkdtempSync(join(tmpdir(), 'spawn-resume-')); dirs.push(d); return d }

const TAB = '23071273-1111-4111-8111-111111111111' // an app tab's own id (its first conversation)
const AFTER = '773dea67-2222-4222-8222-222222222222' // the conversation a /clear started in that tab
const AFTER2 = '88888888-2222-4222-8222-222222222222'
const OTHER = '99999999-3333-4333-8333-333333333333'

function transcript(claudeDir: string, id: string, title: string, mtime: number) {
  const proj = join(claudeDir, 'projects', 'C--work-spawn')
  mkdirSync(proj, { recursive: true })
  const file = join(proj, `${id}.jsonl`)
  writeFileSync(file, [
    JSON.stringify({ type: 'custom-title', customTitle: title, sessionId: id }),
    JSON.stringify({ type: 'user', cwd: 'C:\\work\\spawn', message: { role: 'user', content: 'hello there' } }),
  ].join('\n') + '\n')
  require('node:fs').utimesSync(file, mtime / 1000, mtime / 1000)
}

const keep = process.env.CLAUDE_CONFIG_DIR
afterEach(() => { if (keep === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = keep })

describe('a /clear in an app tab leaves no second identical row', () => {
  it('the conversation a /clear superseded is folded (kept on disk, marked superseded), the current one stays', () => {
    const claudeDir = tempDir()
    const userData = tempDir()
    process.env.CLAUDE_CONFIG_DIR = claudeDir
    const t0 = Date.UTC(2026, 10, 18, 9)
    transcript(claudeDir, TAB, 'Spawn', t0)
    transcript(claudeDir, AFTER, 'Spawn', t0 + 3_600_000)
    transcript(claudeDir, OTHER, 'Other', t0 + 60_000)
    mkdirSync(join(userData, 'session-links'))
    writeFileSync(join(userData, 'session-links', TAB), AFTER)
    const list = history.listHistory({ running: new Set(), userDataDir: userData })
    expect(list.map((x: { id: string }) => x.id)).toEqual([AFTER, OTHER, TAB])
    expect(list.filter((x: { superseded?: boolean }) => !x.superseded).map((x: { title: string }) => x.title)).toEqual(['Spawn', 'Other'])
    expect(list.find((x: { id: string }) => x.id === TAB).superseded).toBe(true)
    expect(existsSync(join(claudeDir, 'projects', 'C--work-spawn', `${TAB}.jsonl`))).toBe(true)
  })

  it('every /clear before the current one is folded too (the .prev the hook keeps), never the current one', () => {
    const links = new Map([[TAB, { current: AFTER2, prev: [AFTER] }]])
    const has = () => true
    expect([...history.supersededIds(links, has)].sort()).toEqual([TAB, AFTER].sort())
    // the current conversation has no transcript yet: reopening still falls back to the tab's own, so nothing folds
    expect(history.supersededIds(new Map([[TAB, { current: AFTER, prev: [] }]]), (id: string) => id !== AFTER).size).toBe(0)
    // a tab never cleared (its link names itself): nothing folds
    expect(history.supersededIds(new Map([[TAB, { current: TAB, prev: [] }]]), has).size).toBe(0)
  })

  it("the app's name for a tab goes with its current conversation, never on the one a /clear superseded", () => {
    const links = new Map([[TAB, { current: AFTER, prev: [] }]])
    const rows = [{ id: AFTER }, { id: OTHER }, { id: TAB, superseded: true }]
    const got = history.appTitles({ [TAB]: 'Spawn', [OTHER]: 'Docs' }, links, rows)
    expect([...got].sort()).toEqual([[AFTER, 'Spawn'], [OTHER, 'Docs']].sort())
    // the conversation's own app name wins over its tab's
    expect(history.appTitles({ [TAB]: 'Spawn', [AFTER]: 'Mine' }, links, rows).get(AFTER)).toBe('Mine')
  })

  it('without the app\'s data folder the list is as before', () => {
    const claudeDir = tempDir()
    process.env.CLAUDE_CONFIG_DIR = claudeDir
    transcript(claudeDir, TAB, 'Spawn', Date.UTC(2026, 10, 18))
    expect(history.listHistory({ running: new Set() })[0].superseded).toBeUndefined()
  })

  it('the hook notes the conversation a /clear leaves behind in <link>.prev', () => {
    const userData = tempDir()
    mkdirSync(join(userData, 'session-links'))
    const link = join(userData, 'session-links', TAB)
    const run = (session_id: string, source: string) => spawnSync(process.execPath, [join(REPO, 'hooks', 'spawn-hook.cjs')], {
      input: JSON.stringify({ hook_event_name: 'SessionStart', source, session_id, cwd: REPO }),
      encoding: 'utf8',
      env: { ...process.env, SPAWN_EVENT_URL: 'http://127.0.0.1:9/event', SPAWN_SESSION_ID: TAB, SPAWN_LINK_FILE: link },
    })
    expect(run(TAB, 'startup').status).toBe(0)
    expect(existsSync(`${link}.prev`)).toBe(false)
    expect(run(AFTER, 'clear').status).toBe(0)
    expect(existsSync(`${link}.prev`)).toBe(false) // (the tab's own id is superseded by being the tab: not written)
    expect(run(AFTER2, 'clear').status).toBe(0)
    expect(readFileSync(`${link}.prev`, 'utf8').trim()).toBe(AFTER)
    expect(readFileSync(link, 'utf8')).toBe(AFTER2)
  })
})

describe('two sessions of one name are told apart, not hidden', () => {
  it('the resume list adds the day, then the time when they share a day', () => {
    const a = new Date(2026, 10, 18, 9, 5).getTime()
    const b = new Date(2026, 10, 19, 14, 30).getTime()
    expect(withDates(['Spawn', 'Spawn', 'Other'], [b, a, a])).toEqual(['Spawn · 11/19', 'Spawn · 11/18', 'Other'])
    const c = new Date(2026, 10, 19, 9, 0).getTime()
    expect(withDates(['Spawn', 'spawn ', 'Spawn'], [b, c, a])).toEqual(['Spawn · 11/19 14:30', 'spawn · 11/19 09:00', 'Spawn · 11/18'])
    expect(withDates(['A', 'A'], [b, b])).toEqual(['A · 11/19 14:30', 'A · 11/19 14:30 (2)'])
  })
  it('open tabs: the first keeps its name, the next get (2), (3); unnamed ones stay unnamed', () => {
    expect(numbered(['Spawn', null, 'Spawn', 'Spawn', 'Docs'])).toEqual(['Spawn', null, 'Spawn (2)', 'Spawn (3)', 'Docs'])
    expect(numbered([null, null])).toEqual([null, null])
  })
})

describe('running: a reused pid is not a running session', () => {
  function registry(recs: { pid: number; sessionId: string; procStart?: string; startedAt?: number }[]) {
    const dir = tempDir()
    for (const r of recs) writeFileSync(join(dir, `${r.pid}.json`), JSON.stringify(r))
    return dir
  }
  const FT = '134395389579551400' // a FILETIME, as Claude Code writes procStart on Windows

  it('the start time must match the record (a later start is another program)', async () => {
    const dir = registry([
      { pid: 10, sessionId: 'live', procStart: FT },
      { pid: 11, sessionId: 'reused', procStart: FT },
      { pid: 12, sessionId: 'gone', procStart: FT },
    ])
    let asked = 0
    const running = history.runningCheck({
      dir, isAlive: (pid: number) => pid !== 12,
      startTimes: async (pids: number[]) => { asked++; return new Map(pids.map(p => [p, p === 11 ? String(BigInt(FT) + 600_000_000n) : FT])) },
    })
    expect([...await running()].sort()).toEqual(['live'])
    expect([...await running()].sort()).toEqual(['live'])
    expect(asked).toBe(1) // (kept: one PowerShell call per pid and start)
    // the quick look still counts it (what the check is for)
    expect([...history.runningSessions({ dir, isAlive: (pid: number) => pid !== 12 })].sort()).toEqual(['live', 'reused'])
  })

  it('no answer (not Windows, PowerShell failed): a live pid counts, as before', async () => {
    const dir = registry([{ pid: 10, sessionId: 'a', procStart: FT }])
    const running = history.runningCheck({ dir, isAlive: () => true, startTimes: async () => null })
    expect([...await running()]).toEqual(['a'])
  })

  it('sameProcess: by procStart to the second, else started before the record was written', () => {
    expect(history.sameProcess({ procStart: FT }, FT)).toBe(true)
    expect(history.sameProcess({ procStart: FT }, String(BigInt(FT) + 5_000_000n))).toBe(true)
    expect(history.sameProcess({ procStart: FT }, String(BigInt(FT) + 50_000_000n))).toBe(false)
    const startedAt = Number(BigInt(FT) / 10000n) - 11644473600000 + 500
    expect(history.sameProcess({ procStart: null, startedAt }, FT)).toBe(true)
    expect(history.sameProcess({ procStart: null, startedAt: startedAt - 60_000 }, FT)).toBe(false)
    expect(history.sameProcess({ procStart: FT }, null)).toBe(true)
  })

  it('processStartTimes reads "pid filetime" lines (one call, Windows only)', async () => {
    const calls: string[][] = []
    const execFile = (_f: string, args: string[], _o: unknown, cb: (e: Error | null, out: string) => void) => { calls.push(args); cb(null, `10 ${FT}\r\n11 123\r\n`) }
    const got = await history.processStartTimes([10, 11], { platform: 'win32', execFile })
    expect([...got]).toEqual([[10, FT], [11, '123']])
    expect(calls).toHaveLength(1)
    expect(await history.processStartTimes([10], { platform: 'linux', execFile })).toBeNull()
  })
})

describe('deleting a session whose tab was just closed', () => {
  const ID = '11111111-2222-4333-8444-555555555555'
  function setup() {
    const root = tempDir()
    const claudeDir = join(root, 'claude')
    const proj = join(claudeDir, 'projects', 'C--work-demo')
    mkdirSync(proj, { recursive: true })
    writeFileSync(join(proj, `${ID}.jsonl`), '{"type":"user"}\n')
    return { claudeDir, spawnHome: join(root, 'spawn'), proj }
  }
  const fakeClock = () => { let t = 0; return { clock: () => t, sleep: async (ms: number) => { t += ms } } }

  it('waits while its Claude Code ends, then moves it into the trash', async () => {
    const s = setup()
    const c = fakeClock()
    let polls = 0
    const r = await trashWhenEnded({ ...s, id: ID, running: async () => ++polls <= 4, closing: () => true, ...c })
    expect(r).toMatchObject({ ok: true, moved: 1 })
    expect(r.waited).toBe(4000)
    expect(existsSync(join(s.proj, `${ID}.jsonl`))).toBe(false)
  })

  it('gives up after 30 s and keeps it', async () => {
    const s = setup()
    const r = await trashWhenEnded({ ...s, id: ID, running: async () => true, closing: () => true, ...fakeClock() })
    expect(r).toEqual({ ok: false, reason: 'running' })
    expect(existsSync(join(s.proj, `${ID}.jsonl`))).toBe(true)
  })

  it("another terminal's live session is refused at once; one open in the app too", async () => {
    const s = setup()
    let polls = 0
    expect(await trashWhenEnded({ ...s, id: ID, running: async () => { polls++; return true }, closing: () => false, ...fakeClock() })).toEqual({ ok: false, reason: 'running' })
    expect(polls).toBe(1)
    expect(await trashWhenEnded({ ...s, id: ID, open: () => true, ...fakeClock() })).toEqual({ ok: false, reason: 'open' })
    expect(await trashWhenEnded({ ...s, id: 'nope', ...fakeClock() })).toEqual({ ok: false, reason: 'invalid' })
  })
})

describe('the terminal manager knows what it closed and what it has open', () => {
  function fakePty() {
    let next = 100
    return {
      spawn() {
        const pid = next++
        return { pid, onData() {}, onExit() {}, kill() {}, write() {}, resize() {} }
      },
    }
  }
  it('a closed Claude tab (and the conversation a /clear gave it) is recently closed; an open one is open', () => {
    const userDataDir = tempDir()
    process.env.CLAUDE_CONFIG_DIR = tempDir()
    const terms = createTerminalManager({ repoRoot: REPO, userDataDir, defaultCwd: userDataDir, send: () => {}, pty: fakePty(), killTree: () => {} })
    const a = terms.create({ sessionId: TAB })
    writeFileSync(join(userDataDir, 'session-links', TAB), AFTER)
    expect([...terms.openConversations()].sort()).toEqual([TAB, AFTER].sort())
    terms.close(a.id)
    expect(terms.openConversations().size).toBe(0)
    expect([...terms.recentlyClosed()].sort()).toEqual([TAB, AFTER].sort())
    // a shell tab is no Claude Code: nothing to wait for
    const sh = terms.create({ tool: 'shell' })
    terms.close(sh.id)
    expect(terms.recentlyClosed().has(sh.sessionId)).toBe(false)
  })
})
