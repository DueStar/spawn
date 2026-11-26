/**
 * electron/terminals.cjs — the app's Claude Code terminals: the session
 * settings it hands every session, and the environment it starts them in.
 */

import { spawnSync } from 'node:child_process'
import fs, { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import os, { tmpdir } from 'node:os'
import path, { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it, vi } from 'vitest'

const require = createRequire(import.meta.url)
const { writeSessionSettings, cleanEnv, readOpenSessions, hasTranscript, linkedConversation, gitBranch, createTerminalManager } = require('../electron/terminals.cjs')

const REPO = fileURLToPath(new URL('..', import.meta.url))

const dirs: string[] = []
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }) })
const tempDir = () => { const d = mkdtempSync(join(tmpdir(), 'poke-settings-')); dirs.push(d); return d }

describe('terminals.cjs', () => {
  it('writes session settings whose hooks and status line run this checkout\'s scripts with the app in Node mode', () => {
    const file = writeSessionSettings(REPO, tempDir(), 'C:\\Program Files\\spawn\\spawn.exe')
    const settings = JSON.parse(readFileSync(file, 'utf8'))
    const command: string = settings.hooks.SessionStart[0].hooks[0].command
    expect(command).toMatch(/^ELECTRON_RUN_AS_NODE=1 ".+spawn\.exe" "[^"\\]+\/hooks\/spawn-hook\.cjs"$/)
    expect(command).not.toMatch(/python|bash|curl/)
    expect(Object.keys(settings.hooks)).toEqual(expect.arrayContaining(['PreToolUse', 'Stop', 'SessionEnd', 'UserPromptSubmit', 'PermissionRequest']))
    expect(settings.statusLine.command).toMatch(/^ELECTRON_RUN_AS_NODE=1 ".+" ".+\/hooks\/status-line\.cjs"$/)
  })

  it('tool-call hooks run in the background (async); the ones that change what the session is doing do not', () => {
    const settings = JSON.parse(readFileSync(writeSessionSettings(REPO, tempDir(), process.execPath), 'utf8'))
    for (const e of ['PreToolUse', 'PostToolUse', 'PostToolBatch']) expect(settings.hooks[e][0].hooks[0].async, e).toBe(true)
    for (const e of ['Stop', 'PermissionRequest', 'SessionStart', 'SessionEnd', 'UserPromptSubmit', 'PostToolUseFailure', 'Notification']) expect(settings.hooks[e][0].hooks[0].async, e).toBeUndefined()
  })

  it('the hook command really runs in a shell: reads the payload, prints nothing, exits 0 (server down)', () => {
    // Here the "app" is the Node running the tests, which ignores ELECTRON_RUN_AS_NODE
    const settings = JSON.parse(readFileSync(writeSessionSettings(REPO, tempDir(), process.execPath), 'utf8'))
    const command: string = settings.hooks.PreToolUse[0].hooks[0].command
    const res = spawnSync('bash', ['-c', command], {
      input: JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: {}, session_id: 's' }),
      encoding: 'utf8',
      env: { ...process.env, SPAWN_PORT: '9', SPAWN_HOME: tempDir() },
    })
    expect(res.status).toBe(0)
    expect(res.stdout).toBe('')
    expect(res.stderr).toBe('')
  })

  it('starts sessions without another Claude Code session\'s markers', () => {
    const env = cleanEnv({
      PATH: '/bin', HOME: '/h', CLAUDECODE: '1', CLAUDE_PID: '9',
      CLAUDE_CODE_CHILD_SESSION: '1', CLAUDE_CODE_SESSION_ID: 'x', CLAUDE_CONFIG_DIR: '/c',
    })
    expect(env).toEqual({ PATH: '/bin', HOME: '/h', CLAUDE_CONFIG_DIR: '/c' })
  })

  it('reads back the sessions open at the last close: real ids, folders that exist, no repeats', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spawn-open-'))
    const file = path.join(dir, 'open-sessions.json')
    const a = '11111111-1111-4111-8111-111111111111'
    fs.writeFileSync(file, JSON.stringify([
      { sessionId: a, cwd: dir }, { sessionId: a, cwd: dir },
      { sessionId: 'not-an-id', cwd: dir },
      { sessionId: '22222222-2222-4222-8222-222222222222', cwd: path.join(dir, 'gone') },
    ]))
    expect(readOpenSessions(file)).toEqual([{ sessionId: a, cwd: dir, tool: 'claude' }])
    fs.writeFileSync(file, '{broken')
    expect(readOpenSessions(file)).toEqual([])
    expect(readOpenSessions(path.join(dir, 'missing.json'))).toEqual([])
  })

  it('after /clear the hook links the terminal to its new conversation, which reopening resumes', () => {
    const userData = tempDir()
    const terminal = '11111111-2222-4333-8444-555555555555'
    const fresh = '99999999-8888-4777-8666-555555555555'
    fs.mkdirSync(join(userData, 'session-links'))
    expect(linkedConversation(userData, terminal)).toBe('')
    const res = spawnSync(process.execPath, [join(REPO, 'hooks', 'spawn-hook.cjs')], {
      input: JSON.stringify({ hook_event_name: 'SessionStart', source: 'clear', session_id: fresh, cwd: REPO }),
      encoding: 'utf8',
      env: { ...process.env, SPAWN_EVENT_URL: 'http://127.0.0.1:9/event', SPAWN_SESSION_ID: terminal, SPAWN_LINK_FILE: join(userData, 'session-links', terminal) },
    })
    expect(res.status).toBe(0)
    expect(linkedConversation(userData, terminal)).toBe(fresh)
  })

  it("does not pass another app terminal's identity on", () => {
    const env = cleanEnv({ PATH: '/bin', SPAWN_SESSION_ID: 'x', SPAWN_LINK_FILE: 'y' })
    expect(env).toEqual({ PATH: '/bin' })
  })

  it("reads a folder's git branch from its repository (detached: the short commit; a worktree's .git file; none outside)", () => {
    const repo = tempDir()
    fs.mkdirSync(join(repo, '.git'))
    fs.mkdirSync(join(repo, 'src', 'deep'), { recursive: true })
    fs.writeFileSync(join(repo, '.git', 'HEAD'), 'ref: refs/heads/feature/hp-bar\n')
    expect(gitBranch(join(repo, 'src', 'deep'))).toBe('feature/hp-bar')
    fs.writeFileSync(join(repo, '.git', 'HEAD'), 'eb017ee82a26a403af65ca01db31e9284e3d032d\n')
    expect(gitBranch(repo)).toBe('eb017ee')
    const wt = tempDir()
    fs.mkdirSync(join(repo, '.git', 'worktrees', 'w'), { recursive: true })
    fs.writeFileSync(join(repo, '.git', 'worktrees', 'w', 'HEAD'), 'ref: refs/heads/side\n')
    fs.writeFileSync(join(wt, '.git'), `gitdir: ${join(repo, '.git', 'worktrees', 'w')}\n`)
    expect(gitBranch(wt)).toBe('side')
    expect(gitBranch(tempDir())).toBeNull()
  })

  it('reopens only sessions that have a transcript', () => {
    const claude = fs.mkdtempSync(path.join(os.tmpdir(), 'spawn-claude-'))
    const id = '33333333-3333-4333-8333-333333333333'
    fs.mkdirSync(path.join(claude, 'projects', 'C--work'), { recursive: true })
    fs.writeFileSync(path.join(claude, 'projects', 'C--work', `${id}.jsonl`), '{}\n')
    expect(hasTranscript(id, claude)).toBe(true)
    expect(hasTranscript('44444444-4444-4444-8444-444444444444', claude)).toBe(false)
  })

  it('drops the NO_COLOR Claude Code sets, keeps one the user set', () => {
    expect(cleanEnv({ PATH: '/bin', CLAUDECODE: '1', NO_COLOR: '1' })).toEqual({ PATH: '/bin' })
    expect(cleanEnv({ PATH: '/bin', NO_COLOR: '1' })).toEqual({ PATH: '/bin', NO_COLOR: '1' })
  })
})

/** A stand-in for node-pty: records what was spawned; `exit(pid)` plays the process ending */
function fakePty(log: string[] = []) {
  let next = 100
  const procs = new Map<number, { onExit?: (e: { exitCode: number }) => void; onData?: (d: string) => void; killed: boolean }>()
  const spawned: { command: string; args: string[] }[] = []
  return {
    procs,
    spawned,
    exit(pid: number) { procs.get(pid)?.onExit?.({ exitCode: 1 }) },
    data(pid: number, d: string) { procs.get(pid)?.onData?.(d) },
    spawn(command: string, args: string[]) {
      spawned.push({ command, args })
      const pid = next++
      const p = { killed: false } as { onExit?: (e: { exitCode: number }) => void; onData?: (d: string) => void; killed: boolean }
      procs.set(pid, p)
      return {
        pid,
        onData(cb: (d: string) => void) { p.onData = cb },
        onExit(cb: (e: { exitCode: number }) => void) { p.onExit = cb },
        kill() { p.killed = true; log.push(`pty ${pid}`) },
        write() {}, resize(c: number, r: number) { log.push(`resize ${pid} ${c}x${r}`) },
      }
    },
  }
}

function manager(pty: ReturnType<typeof fakePty>, killTree: (pid: number) => void, extra: Record<string, unknown> = {}) {
  const userDataDir = tempDir()
  return createTerminalManager({ repoRoot: REPO, userDataDir, defaultCwd: userDataDir, send: () => {}, pty, killTree, ...extra })
}

describe('terminal manager shutdown', () => {
  it("shutdown kills each running session's process tree and waits for its exit", async () => {
    const pty = fakePty()
    const killed: number[] = []
    const terms = manager(pty, (pid) => { killed.push(pid); setTimeout(() => pty.exit(pid), 10) })
    terms.create({ tool: 'shell' })
    terms.create({ tool: 'shell' })
    expect(await terms.shutdown(1000, 0)).toEqual({ exited: 2, stuck: 0 })
    expect(killed.sort()).toEqual([100, 101])
    expect([...pty.procs.values()].every(p => p.killed)).toBe(true)
  })

  it('shutdown gives up after the timeout and reports the stuck ones', async () => {
    const pty = fakePty()
    const terms = manager(pty, () => {})
    terms.create({ tool: 'shell' })
    const t0 = Date.now()
    expect(await terms.shutdown(50, 0)).toEqual({ exited: 0, stuck: 1 })
    expect(Date.now() - t0).toBeLessThan(1000)
  })

  it('kills the tree first and the pty only after the exit; a session that ended by itself has its pty closed too', async () => {
    const order: string[] = []
    const pty = fakePty(order)
    const terms = manager(pty, (pid) => { order.push(`tree ${pid}`); pty.exit(pid) })
    terms.create({ tool: 'shell' })
    terms.create({ tool: 'shell' })
    pty.exit(101) // ended on its own earlier: still holds its pseudo-console
    expect(await terms.shutdown(1000, 0)).toEqual({ exited: 1, stuck: 0 })
    expect(order).toEqual(['tree 100', 'pty 100', 'pty 101'])
  })

  it('shutdown with nothing running resolves at once', async () => {
    const terms = manager(fakePty(), () => { throw new Error('no tree to kill') })
    expect(await terms.shutdown(1000, 0)).toEqual({ exited: 0, stuck: 0 })
  })
})

describe('the reopen list when Windows shuts down', () => {
  const setup = (exitGraceMs: number) => {
    const pty = fakePty()
    const userDataDir = tempDir()
    const terms = createTerminalManager({ repoRoot: REPO, userDataDir, defaultCwd: userDataDir, send: () => {}, pty, killTree: () => {}, exitGraceMs })
    const openList = () => JSON.parse(readFileSync(join(userDataDir, 'open-sessions.json'), 'utf8')).map((o: any) => o.sessionId)
    return { pty, terms, openList }
  }

  it('sessions ending one by one (Windows killing them before the app) stay listed until the exits settle', async () => {
    const { pty, terms, openList } = setup(60)
    const a = terms.create({ tool: 'shell' }) as any
    const b = terms.create({ tool: 'shell' }) as any
    expect(openList()).toEqual([a.sessionId, b.sessionId])
    pty.exit(100)
    pty.exit(101)
    // the app is killed in this window: the file still lists both, so the next start reopens them
    expect(openList()).toEqual([a.sessionId, b.sessionId])
    await new Promise(r => setTimeout(r, 120))
    // the app lived on: the ended ones leave the list
    expect(openList()).toEqual([])
  })

  it('once Windows says the session is ending (freeze), later exits never empty the list', async () => {
    const { pty, terms, openList } = setup(20)
    const a = terms.create({ tool: 'shell' }) as any
    terms.freeze()
    pty.exit(100)
    await new Promise(r => setTimeout(r, 60))
    expect(openList()).toEqual([a.sessionId])
  })

  it('closing a tab yourself still updates the list at once', () => {
    const { terms, openList } = setup(10_000)
    const a = terms.create({ tool: 'shell' }) as any
    const b = terms.create({ tool: 'shell' }) as any
    terms.close(a.id)
    expect(openList()).toEqual([b.sessionId])
  })
})

describe('resizing a session', () => {
  it('passes a new size on to the session once; the same size again is not sent (Claude Code redraws on every resize)', () => {
    const log: string[] = []
    const pty = fakePty(log)
    const terms = manager(pty, () => {})
    const info = terms.create({ tool: 'shell' })
    const id = (info as any).id ?? (info as any).terminal?.id
    terms.resize(id, 100, 30)
    terms.resize(id, 100, 30)
    terms.resize(id, 100, 30)
    terms.resize(id, 101, 30)
    expect(log.filter(l => l.startsWith('resize'))).toEqual(['resize 100 100x30', 'resize 100 101x30'])
  })
})

describe('closing a tab', () => {
  it("closes the pty of a session that already ended (it still holds its pseudo-console)", () => {
    const log: string[] = []
    const pty = fakePty(log)
    const terms = manager(pty, () => {})
    const t = terms.create({ tool: 'shell' })
    pty.exit(100)
    terms.close(t.id)
    expect(log).toEqual(['pty 100'])
  })
})

describe('terminal output', () => {
  it('output within 16 ms goes out as one message', async () => {
    vi.useFakeTimers()
    try {
      const pty = fakePty()
      const sent: { id: string; data: string }[] = []
      const terms = manager(pty, () => {}, { send: (ch: string, p: any) => { if (ch === 'terminals:data') sent.push(p) } })
      const t = terms.create({ tool: 'shell' })
      pty.data(100, 'a'); pty.data(100, 'b'); pty.data(100, 'c')
      expect(sent).toEqual([])
      await vi.advanceTimersByTimeAsync(20)
      expect(sent).toEqual([{ id: t.id, data: 'abc', seq: 1 }])
    } finally { vi.useRealTimers() }
  })

  it('the replay buffer holds only output already sent, at most 200000 characters', async () => {
    vi.useFakeTimers()
    try {
      const pty = fakePty()
      const terms = manager(pty, () => {})
      const t = terms.create({ tool: 'shell' })
      pty.data(100, 'pending')
      expect(terms.buffer(t.id)).toEqual({ data: '', seq: 0 })
      await vi.advanceTimersByTimeAsync(20)
      expect(terms.buffer(t.id)).toEqual({ data: 'pending', seq: 1 })
      for (let i = 0; i < 3000; i++) { pty.data(100, String(i % 10).repeat(100)); if (i % 50 === 49) await vi.advanceTimersByTimeAsync(20) }
      await vi.advanceTimersByTimeAsync(20)
      const { data: buf, seq } = terms.buffer(t.id)
      expect(seq).toBeGreaterThan(1)
      expect(buf.length).toBe(200000)
      expect(buf.endsWith('9'.repeat(100))).toBe(true)
    } finally { vi.useRealTimers() }
  })

  it("a session's last output is sent before its exit is reported", async () => {
    const pty = fakePty()
    const order: string[] = []
    const terms = manager(pty, () => {}, { send: (ch: string, p: any) => order.push(ch === 'terminals:data' ? `data ${p.data}` : ch) })
    terms.create({ tool: 'shell' })
    order.length = 0
    pty.data(100, 'bye')
    pty.exit(100)
    expect(order[0]).toBe('data bye')
    expect(order).toContain('terminals:list')
  })
})

describe('a Codex tab', () => {
  const TOOLS = [{ id: 'codex', name: 'Codex CLI', command: 'codex' }]
  // Other AI tools switched on (electron/features.cjs), so the feature keeps being tested while it is hidden
  function codexManager(otherTools = true, userDataDir = tempDir()) {
    const pty = fakePty()
    const watches: any[] = []
    const events: any[] = []
    const statuses: any[] = []
    const terms = createTerminalManager({
      repoRoot: REPO, userDataDir, defaultCwd: userDataDir, send: () => {}, pty, killTree: () => {},
      tools: () => TOOLS, emit: (e: any) => events.push(e), postStatus: (s: any) => statuses.push(s),
      codexWatch: (opts: any) => { const w = { opts, stopped: false, stop() { w.stopped = true } }; watches.push(w); return w },
      otherTools,
    })
    return { pty, userDataDir, watches, events, statuses, terms }
  }

  it("follows its session log: what it tells goes to the server, its thread is remembered for reopening, and output stops standing in", () => {
    const { pty, userDataDir, watches, events, statuses, terms } = codexManager()
    const t = terms.create({ tool: 'codex' })
    expect(watches).toHaveLength(1)
    expect(watches[0].opts).toMatchObject({ sessionId: t.id, resumeThread: null })
    watches[0].opts.onThread('01a1c401-945a-7ca0-8b17-38351a3ade01')
    expect(linkedConversation(userDataDir, t.id)).toBe('01a1c401-945a-7ca0-8b17-38351a3ade01')
    watches[0].opts.status({ type: 'session_status', sessionId: t.id })
    expect(statuses).toEqual([{ type: 'session_status', sessionId: t.id }])
    events.length = 0
    pty.data(100, 'lots of output')
    expect(events.filter(e => e.type === 'agent_working')).toEqual([]) // the log speaks now, not the output
    watches[0].opts.emit({ type: 'session_prompt', sessionId: t.id, text: 'hi' })
    expect(events).toContainEqual({ type: 'session_prompt', sessionId: t.id, text: 'hi' })
    pty.exit(100)
    expect(watches[0].stopped).toBe(true)
  })

  it('reopened, it resumes the remembered thread; with none it starts anew under the same tab id', () => {
    const { pty, userDataDir, watches, terms } = codexManager()
    const id = '77777777-7777-4777-8777-777777777777'
    terms.create({ tool: 'codex', resume: id })
    expect(pty.spawned.at(-1)!.args).not.toContain('resume')
    expect(watches.at(-1).opts).toMatchObject({ sessionId: id, resumeThread: null })
    fs.mkdirSync(join(userDataDir, 'session-links'), { recursive: true })
    fs.writeFileSync(join(userDataDir, 'session-links', id), '01a1bf02-5c65-7463-ac3e-1dc7420b39fc')
    terms.close(id)
    terms.create({ tool: 'codex', resume: id })
    expect(pty.spawned.at(-1)!.args.slice(-2)).toEqual(['resume', '01a1bf02-5c65-7463-ac3e-1dc7420b39fc'])
    expect(watches.at(-1).opts).toMatchObject({ sessionId: id, resumeThread: '01a1bf02-5c65-7463-ac3e-1dc7420b39fc' })
  })

  it('switched on, a Codex tab from the last run comes back in the reopen list', () => {
    const userDataDir = tempDir()
    const codexTab = { sessionId: '88888888-8888-4888-8888-888888888888', cwd: userDataDir, tool: 'codex' }
    fs.writeFileSync(join(userDataDir, 'open-sessions.json'), JSON.stringify([codexTab]))
    const { terms } = codexManager(true, userDataDir)
    expect(terms.takeRestorable()).toEqual([codexTab])
  })
})

describe('1.6.2: what spawn.log says about a session\'s first minutes (the trust question that took no key)', () => {
  // Never what was typed: only how many arrows, Enters, Escs and focus reports arrived, and how much the tool drew since.
  it('the keys that move or answer a question, counted in 5 s batches with the output since; text alone says nothing', async () => {
    vi.useFakeTimers()
    const said: string[] = []
    const logSpy = vi.spyOn(console, 'log').mockImplementation(((...a: any[]) => { said.push(a.join(' ')) }) as any)
    try {
      const pty = fakePty()
      const terms = manager(pty, () => {})
      const t = terms.create({})
      terms.write(t.id, 'hello 다')
      await vi.advanceTimersByTimeAsync(6000)
      expect(said.filter(s => s.includes('[terminals]'))).toEqual([])
      terms.write(t.id, '\x1b[O')
      terms.write(t.id, '\x1b[I')
      terms.write(t.id, '\x1b[B')
      pty.data(100, 'x'.repeat(300))
      terms.write(t.id, '\x1bOA')
      terms.write(t.id, '\r')
      terms.write(t.id, '\x1b')
      await vi.advanceTimersByTimeAsync(5000)
      const lines = said.filter(s => s.includes('[terminals]'))
      expect(lines).toHaveLength(1)
      expect(lines[0]).toMatch(new RegExp(`^\\[terminals\\] claude ${t.id.slice(0, 8)} \\+\\d+ s: arrows 2, enter 1, esc 1, focus 2; output since 300 B$`))
      expect(lines[0]).not.toContain('hello')
    } finally { logSpy.mockRestore(); vi.useRealTimers() }
  })

  it('nothing after the first 10 minutes', async () => {
    vi.useFakeTimers()
    const said: string[] = []
    const logSpy = vi.spyOn(console, 'log').mockImplementation(((...a: any[]) => { said.push(a.join(' ')) }) as any)
    try {
      const terms = manager(fakePty(), () => {})
      const t = terms.create({})
      await vi.advanceTimersByTimeAsync(10 * 60_000 + 1000)
      terms.write(t.id, '\x1b[B')
      await vi.advanceTimersByTimeAsync(6000)
      expect(said.filter(s => s.includes('[terminals]'))).toEqual([])
    } finally { logSpy.mockRestore(); vi.useRealTimers() }
  })

  it('an exit: the tool, how long it ran, its code, and whether a question was on its screen', () => {
    const said: string[] = []
    const logSpy = vi.spyOn(console, 'log').mockImplementation(((...a: any[]) => { said.push(a.join(' ')) }) as any)
    try {
      const pty = fakePty()
      const terms = manager(pty, () => {})
      const t = terms.create({})
      pty.data(100, ' ❯ 1. Yes, I trust this folder\r\n   2. No, exit\r\n')
      pty.exit(100)
      expect(said.filter(s => s.includes('[terminals]'))).toEqual([`[terminals] claude ${t.id.slice(0, 8)} exited (code 1) after 0 s, a question on its screen`])
    } finally { logSpy.mockRestore() }
  })
})

describe('1.6.2: a reopened Claude Code session that never got a prompt (no transcript)', () => {
  // On 1.6.1 such a tab was left out of the reopen list (nothing to resume), and the next write of the list dropped it
  // for good: a new-folder session was gone after an update restart.
  const ID = '55555555-5555-4555-8555-555555555555'
  const OTHER = '66666666-6666-4666-8666-666666666666'
  function manager(transcripts: string[], link?: string) {
    const claude = tempDir()
    fs.mkdirSync(join(claude, 'projects', 'C--work'), { recursive: true })
    for (const t of transcripts) fs.writeFileSync(join(claude, 'projects', 'C--work', `${t}.jsonl`), '{}\n')
    vi.stubEnv('CLAUDE_CONFIG_DIR', claude)
    const userDataDir = tempDir()
    if (link) {
      fs.mkdirSync(join(userDataDir, 'session-links'), { recursive: true })
      fs.writeFileSync(join(userDataDir, 'session-links', ID), link)
    }
    const pty = fakePty()
    const terms = createTerminalManager({ repoRoot: REPO, userDataDir, defaultCwd: userDataDir, send: () => {}, pty, killTree: () => {} })
    return { pty, terms, userDataDir }
  }
  const after = (args: string[], flag: string) => (args.includes(flag) ? args[args.indexOf(flag) + 1] : null)

  it('is in the reopen list', () => {
    try {
      vi.stubEnv('CLAUDE_CONFIG_DIR', tempDir())
      const userDataDir = tempDir()
      const tab = { sessionId: ID, cwd: userDataDir, tool: 'claude' }
      fs.writeFileSync(join(userDataDir, 'open-sessions.json'), JSON.stringify([tab]))
      const terms = createTerminalManager({ repoRoot: REPO, userDataDir, defaultCwd: userDataDir, send: () => {}, pty: fakePty(), killTree: () => {} })
      expect(terms.takeRestorable()).toEqual([tab])
    } finally { vi.unstubAllEnvs() }
  })

  it('starts fresh under its own id (so its folder and its Pokémon): --session-id, never --resume', () => {
    try {
      const { pty, terms } = manager([])
      const t = terms.create({ resume: ID })
      expect(t.id).toBe(ID)
      const args = pty.spawned.at(-1)!.args
      expect(after(args, '--session-id')).toBe(ID)
      expect(args).not.toContain('--resume')
    } finally { vi.unstubAllEnvs() }
  })

  it('with a transcript it resumes, as before', () => {
    try {
      const { pty, terms } = manager([ID])
      terms.create({ resume: ID })
      expect(after(pty.spawned.at(-1)!.args, '--resume')).toBe(ID)
      expect(pty.spawned.at(-1)!.args).not.toContain('--session-id')
    } finally { vi.unstubAllEnvs() }
  })

  it('after a /clear: the linked conversation when it has a transcript; else the tab\'s own, never --session-id on an id with one', () => {
    try {
      const a = manager([OTHER], OTHER)
      a.terms.create({ resume: ID })
      expect(after(a.pty.spawned.at(-1)!.args, '--resume')).toBe(OTHER)
      vi.unstubAllEnvs()
      const b = manager([ID], OTHER)
      b.terms.create({ resume: ID })
      expect(after(b.pty.spawned.at(-1)!.args, '--resume')).toBe(ID)
      expect(b.pty.spawned.at(-1)!.args).not.toContain('--session-id')
    } finally { vi.unstubAllEnvs() }
  })
})

describe('other AI tools switched off (electron/features.cjs)', () => {
  const TOOLS = [{ id: 'codex', name: 'Codex CLI', command: 'codex' }]
  function offManager(userDataDir = tempDir()) {
    const pty = fakePty()
    const watches: any[] = []
    const events: any[] = []
    const terms = createTerminalManager({
      repoRoot: REPO, userDataDir, defaultCwd: userDataDir, send: () => {}, pty, killTree: () => {},
      // Codex still listed in the stored settings: it must not leak through
      tools: () => TOOLS, emit: (e: any) => events.push(e),
      codexWatch: (opts: any) => { const w = { opts, stop() {} }; watches.push(w); return w },
      otherTools: false,
    })
    return { pty, userDataDir, watches, events, terms }
  }

  it('a session asked for with Codex (a stored default) starts Claude Code, and no Codex log watcher runs', () => {
    const { pty, watches, events, terms } = offManager()
    const t = terms.create({ tool: 'codex' })
    expect(t.tool).toBe('claude')
    expect(t.toolName).toBe('Claude Code')
    expect(pty.spawned.at(-1)!.args).toContain('--session-id')
    expect(pty.spawned.at(-1)!.command).not.toMatch(/codex/i)
    expect(watches).toEqual([])
    expect(events).toEqual([]) // nothing stands in for hooks: it is a Claude session
  })

  it('a reopened Codex id starts a fresh Claude Code, never a resume of an id Claude never had', () => {
    const { pty, terms } = offManager()
    terms.create({ tool: 'codex', resume: '77777777-7777-4777-8777-777777777777' })
    expect(pty.spawned.at(-1)!.args).not.toContain('--resume')
    expect(pty.spawned.at(-1)!.args).not.toContain('resume')
  })

  it("the shell tab is not part of it: it still opens", () => {
    const { pty, terms } = offManager()
    expect(terms.create({ tool: 'shell' }).tool).toBe('shell')
    expect(pty.spawned).toHaveLength(1)
  })

  it('Codex tabs in the reopen list are skipped, and kept in the list for when the switch is flipped back', () => {
    const userDataDir = tempDir()
    const codexTab = { sessionId: '88888888-8888-4888-8888-888888888888', cwd: userDataDir, tool: 'codex' }
    const shellTab = { sessionId: '99999999-9999-4999-8999-999999999999', cwd: userDataDir, tool: 'shell' }
    fs.writeFileSync(join(userDataDir, 'open-sessions.json'), JSON.stringify([codexTab, shellTab]))
    const { terms } = offManager(userDataDir)
    expect(terms.takeRestorable()).toEqual([shellTab])
    // This run writes its own tabs over the list: the Codex one stays in it
    const s = terms.create({ tool: 'shell' })
    const list = JSON.parse(readFileSync(join(userDataDir, 'open-sessions.json'), 'utf8'))
    expect(list).toEqual([{ sessionId: s.sessionId, cwd: userDataDir, tool: 'shell' }, codexTab])
    terms.close(s.id)
    expect(JSON.parse(readFileSync(join(userDataDir, 'open-sessions.json'), 'utf8'))).toEqual([codexTab])
  })
})

describe('the other-tools switch', () => {
  it('the manager follows electron/features.cjs when not told otherwise', () => {
    const { OTHER_TOOLS } = require('../electron/features.cjs')
    const pty = fakePty()
    const userDataDir = tempDir()
    const terms = createTerminalManager({
      repoRoot: REPO, userDataDir, defaultCwd: userDataDir, send: () => {}, pty, killTree: () => {},
      tools: () => [{ id: 'codex', name: 'Codex CLI', command: 'codex' }],
      codexWatch: () => ({ stop() {} }),
    })
    expect(terms.create({ tool: 'codex' }).tool).toBe(OTHER_TOOLS ? 'codex' : 'claude')
  })
})

describe('reopening tabs', () => {
  it('a reopened id that is not a session id is not taken (it names a file)', () => {
    const terms = manager(fakePty(), () => {})
    const t = terms.create({ tool: 'shell', resume: '..\..\escape' })
    expect(t.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
  })

  it('a tab whose tool was removed from the settings opens a fresh Claude Code, not a resume of an id it never had', () => {
    const pty = fakePty()
    const terms = manager(pty, () => {})
    terms.create({ tool: 'gone-tool', resume: '77777777-7777-4777-8777-777777777777' })
    expect(pty.spawned.at(-1)!.args).not.toContain('--resume')
    expect(pty.spawned.at(-1)!.args).toContain('--session-id')
  })
})

// ---------------------------------------------------------------------------
// The chat view's hooks: appended to the same generated settings file;
// with the feature off the file is exactly release 1.4.0's
// ---------------------------------------------------------------------------

const { sessionSettingsJson } = require('../electron/terminals.cjs')
const { chatHookEntries } = require('../electron/chatHooks.cjs')

const RUNTIME = 'C:\\Program Files\\spawn\\spawn.exe'
/** a hook command as it is written into the JSON: forward slashes for the path separator, then JSON-escaped */
const command = (script: string) => JSON.stringify(`ELECTRON_RUN_AS_NODE=1 "${RUNTIME.split(path.sep).join('/')}" "${path.join(REPO, 'hooks', script).split(path.sep).join('/')}"`).slice(1, -1)
const HOOK = command('spawn-hook.cjs')
const STATUS = command('status-line.cjs')
/**
 * session-settings.json exactly as release 1.4.0 writes it: captured from writeSessionSettings
 * at cff52ac (before any chat code; written to a temp folder, its content pasted here). Only the
 * two commands, which name this checkout and the runtime, are interpolated (HOOK, STATUS).
 */
const SETTINGS_1_4_0 = `{
  "hooks": {
    "PreToolUse": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "${HOOK}",
            "async": true
          }
        ]
      }
    ],
    "PostToolUse": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "${HOOK}",
            "async": true
          }
        ]
      }
    ],
    "PostToolUseFailure": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "${HOOK}"
          }
        ]
      }
    ],
    "SubagentStop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "${HOOK}"
          }
        ]
      }
    ],
    "SessionStart": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "${HOOK}"
          }
        ]
      }
    ],
    "SessionEnd": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "${HOOK}"
          }
        ]
      }
    ],
    "UserPromptSubmit": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "${HOOK}"
          }
        ]
      }
    ],
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "${HOOK}"
          }
        ]
      }
    ],
    "PermissionRequest": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "${HOOK}"
          }
        ]
      }
    ],
    "Notification": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "${HOOK}"
          }
        ]
      }
    ],
    "StopFailure": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "${HOOK}"
          }
        ]
      }
    ],
    "PreCompact": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "${HOOK}"
          }
        ]
      }
    ],
    "PostCompact": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "${HOOK}"
          }
        ]
      }
    ],
    "PostToolBatch": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "${HOOK}",
            "async": true
          }
        ]
      }
    ],
    "CwdChanged": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "${HOOK}"
          }
        ]
      }
    ],
    "PostModelSwitch": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "${HOOK}"
          }
        ]
      }
    ]
  },
  "statusLine": {
    "type": "command",
    "command": "${STATUS}"
  }
}`

const CHAT_ID = '00000000-0000-4000-8000-000000000001'
const CHAT = chatHookEntries({ port: 51234, token: 'ab'.repeat(24), id: CHAT_ID })

describe('the session settings file with the chat view off: release 1.4.0, byte for byte', () => {
  it('sessionSettingsJson with no chat hooks is the 1.4.0 file', () => {
    expect(sessionSettingsJson(REPO, RUNTIME, null)).toBe(SETTINGS_1_4_0)
    expect(sessionSettingsJson(REPO, RUNTIME)).toBe(SETTINGS_1_4_0)
  })

  it('writeSessionSettings writes exactly that (and with chat null, as before)', () => {
    expect(readFileSync(writeSessionSettings(REPO, tempDir(), RUNTIME), 'utf8')).toBe(SETTINGS_1_4_0)
    expect(readFileSync(writeSessionSettings(REPO, tempDir(), RUNTIME, null), 'utf8')).toBe(SETTINGS_1_4_0)
  })
})

describe('the session settings file with chat hooks', () => {
  it('appends each chat hook as its own group after the game\'s, which keep their place and bytes', () => {
    const off = JSON.parse(SETTINGS_1_4_0)
    const on = JSON.parse(sessionSettingsJson(REPO, RUNTIME, CHAT))
    expect(on.statusLine).toEqual(off.statusLine)
    for (const [event, groups] of Object.entries<any[]>(off.hooks)) {
      expect(on.hooks[event][0], event).toEqual(groups[0])
      if (CHAT[event]) {
        expect(on.hooks[event], event).toHaveLength(2)
        expect(on.hooks[event][1], event).toEqual(CHAT[event])
      } else {
        expect(on.hooks[event], event).toHaveLength(1)
      }
    }
    // the chat-only events: one group, the chat's
    expect(on.hooks.MessageDisplay).toEqual([CHAT.MessageDisplay])
    expect(on.hooks.SubagentStart).toEqual([CHAT.SubagentStart])
    // the game's events first, in their order
    expect(Object.keys(on.hooks).slice(0, Object.keys(off.hooks).length)).toEqual(Object.keys(off.hooks))
  })

  it('writing twice gives the same bytes; with the chat hooks and then without, the 1.4.0 bytes again', () => {
    const dir = tempDir()
    const a = readFileSync(writeSessionSettings(REPO, dir, RUNTIME, CHAT), 'utf8')
    const b = readFileSync(writeSessionSettings(REPO, dir, RUNTIME, CHAT), 'utf8')
    expect(b).toBe(a)
    expect(JSON.parse(a)).toEqual(JSON.parse(sessionSettingsJson(REPO, RUNTIME, CHAT)))
    expect(readFileSync(writeSessionSettings(REPO, dir, RUNTIME, null), 'utf8')).toBe(SETTINGS_1_4_0)
  })
})

describe('the terminal manager and the chat view', () => {
  const settingsOf = (userDataDir: string) => readFileSync(join(userDataDir, 'session-settings.json'), 'utf8')
  function chatManager(state: () => any) {
    const pty = fakePty()
    const userDataDir = tempDir()
    const sent: any[] = []
    const terms = createTerminalManager({ repoRoot: REPO, userDataDir, defaultCwd: userDataDir, send: (c: string, p: any) => sent.push([c, p]), pty, killTree: () => {}, chat: { state } })
    return { pty, userDataDir, terms, sent }
  }

  it('off: terminals carry no chat key, the settings file has no chat hook (as today)', () => {
    const plain = manager(fakePty(), () => {})
    const { terms, userDataDir } = chatManager(() => ({ on: false }))
    const a = plain.create({})
    const b = terms.create({})
    const shell = terms.create({ tool: 'shell' })
    const strip = (t: any) => ({ ...t, id: '', sessionId: '', cwd: '', project: '', createdAt: 0 })
    expect(strip(b)).toEqual(strip(a))
    expect('chat' in b).toBe(false)
    expect('chat' in shell).toBe(false)
    expect(terms.list().every((t: any) => !('chat' in t))).toBe(true)
    expect(settingsOf(userDataDir)).not.toContain('/chat/')
    expect(JSON.parse(settingsOf(userDataDir)).hooks.MessageDisplay).toBeUndefined()
  })

  it('the default (no chat option) is off', () => {
    const terms = manager(fakePty(), () => {})
    expect('chat' in terms.create({})).toBe(false)
  })

  it('off: redrawForChat exists but does nothing; resizes are 1.4.0\'s; only chatHost.redraw calls it, after its off check', () => {
    vi.useFakeTimers()
    try {
      const log: string[] = []
      const terms = manager(fakePty(log), () => {})
      const t = terms.create({})
      terms.resize(t.id, 100, 30)
      terms.resize(t.id, 100, 30)
      expect(typeof terms.redrawForChat).toBe('function')
      expect(terms.redrawForChat(t.id)).toBe(false)
      vi.advanceTimersByTime(1000)
      terms.resize(t.id, 101, 30)
      expect(log.filter(l => l.startsWith('resize'))).toEqual(['resize 100 100x30', 'resize 100 101x30'])
      const host = readFileSync(join(REPO, 'electron', 'chatHost.cjs'), 'utf8')
      const redraw = host.slice(host.indexOf('function redraw('), host.indexOf('terminals.redrawForChat('))
      expect(redraw).toMatch(/if \(!st\.on\) return \{ ok: false, reason: 'off' \}/)
    } finally { vi.useRealTimers() }
  })

  /** the --settings file a session was launched with */
  const launchedWith = (pty: ReturnType<typeof fakePty>) => { const a = pty.spawned.at(-1)!.args; return a[a.indexOf('--settings') + 1] }

  it('on with hooks: a Claude terminal is armed and launched with its own chat settings file; a shell has no chat key', () => {
    const { terms, userDataDir, pty } = chatManager(() => ({ on: true, hooks: CHAT, version: '2.1.323' }))
    expect(terms.create({}).chat).toBe('armed')
    const file = launchedWith(pty)
    expect(path.basename(file)).toMatch(/^session-settings-chat-[0-9a-f]{12}\.json$/)
    expect(path.dirname(file)).toBe(userDataDir)
    expect(readFileSync(file, 'utf8')).toBe(sessionSettingsJson(REPO, process.execPath, CHAT))
    expect('chat' in terms.create({ tool: 'shell' })).toBe(false)
  })

  it('on without hooks (a version not checked, or still starting): unarmed with the reason, launched with the 1.4.0 file', () => {
    let state: any = { on: true, hooks: null, reason: 'version', version: '2.0.9' }
    const { terms, pty, userDataDir } = chatManager(() => state)
    expect(terms.create({}).chat).toBe('version')
    expect(launchedWith(pty)).toBe(join(userDataDir, 'session-settings.json'))
    state = { on: true, hooks: null, reason: 'starting' }
    expect(terms.create({}).chat).toBe('starting')
  })

  it('a file a session was launched with is never written again (review I4): toggles change which file a new session gets', () => {
    let state: any = { on: false }
    const { terms, userDataDir, pty } = chatManager(() => state)
    const plainFile = join(userDataDir, 'session-settings.json')
    terms.create({})
    expect(launchedWith(pty)).toBe(plainFile)
    const plain = readFileSync(plainFile, 'utf8')
    expect(plain).toBe(sessionSettingsJson(REPO, process.execPath, null))
    const writes: string[] = []
    const realWrite = fs.writeFileSync
    const spy = vi.spyOn(fs, 'writeFileSync').mockImplementation(((p: any, ...rest: any[]) => { writes.push(String(p)); return (realWrite as any)(p, ...rest) }) as any)
    try {
      state = { on: true, hooks: CHAT, version: '2.1.323' }
      terms.refreshSettings()
      const first = terms.create({})
      const chatFile = launchedWith(pty)
      expect(chatFile).not.toBe(plainFile)
      terms.create({})
      expect(launchedWith(pty)).toBe(chatFile) // the same hooks: the same file, not written again
      state = { on: true, hooks: null, reason: 'version' }
      terms.refreshSettings()
      const second = terms.create({})
      expect(launchedWith(pty)).toBe(plainFile)
      expect(terms.list().find((t: any) => t.id === first.id).chat).toBe('armed')
      expect(second.chat).toBe('version')
      state = { on: false }
      terms.refreshSettings()
      terms.create({})
      expect(terms.list().every((t: any) => !('chat' in t))).toBe(true)
      // a new endpoint (other port and token): another file; the first one is left as it is
      state = { on: true, hooks: chatHookEntries({ port: 5555, token: 'cd'.repeat(24), id: CHAT_ID }) }
      terms.create({})
      expect(launchedWith(pty)).not.toBe(chatFile)
      expect(readFileSync(chatFile, 'utf8')).toBe(sessionSettingsJson(REPO, process.execPath, CHAT))
    } finally { spy.mockRestore() }
    // the 1.4.0 file was never written again, and every chat file was written once (to a temp name, then renamed)
    const settingsWrites = writes.filter(w => path.basename(w).startsWith('session-settings'))
    expect(settingsWrites.filter(w => path.basename(w) === 'session-settings.json')).toEqual([])
    expect(settingsWrites.every(w => /session-settings-chat-[0-9a-f]{12}\.json\.\d+\.tmp$/.test(path.basename(w)))).toBe(true)
    expect(settingsWrites).toHaveLength(2)
    expect(readFileSync(plainFile, 'utf8')).toBe(plain)
    expect(fs.readdirSync(userDataDir).filter(n => n.endsWith('.tmp'))).toEqual([])
  })

  it('refreshSettings writes nothing; it broadcasts the list (so the page learns what changed)', () => {
    let state: any = { on: false }
    const { terms, sent, userDataDir } = chatManager(() => state)
    terms.create({})
    const before = settingsOf(userDataDir)
    const files = fs.readdirSync(userDataDir).sort()
    const n = sent.length
    state = { on: true, hooks: CHAT }
    terms.refreshSettings()
    expect(sent.length).toBe(n + 1)
    expect(sent.at(-1)[0]).toBe('terminals:list')
    expect(settingsOf(userDataDir)).toBe(before)
    expect(fs.readdirSync(userDataDir).sort()).toEqual(files)
  })

  it('chat settings files left by an earlier run go when this run writes its first one (never while off)', () => {
    const userDataDir = tempDir()
    fs.writeFileSync(join(userDataDir, 'session-settings-chat-0123456789ab.json'), '{}')
    fs.writeFileSync(join(userDataDir, 'session-settings-chat-0123456789ab.json.42.tmp'), '{')
    let state: any = { on: false }
    const terms = createTerminalManager({ repoRoot: REPO, userDataDir, defaultCwd: userDataDir, send: () => {}, pty: fakePty(), killTree: () => {}, chat: { state: () => state } })
    terms.create({})
    expect(fs.readdirSync(userDataDir).filter(n => n.startsWith('session-settings-chat-'))).toHaveLength(2)
    state = { on: true, hooks: CHAT }
    terms.create({})
    expect(fs.readdirSync(userDataDir).filter(n => n.startsWith('session-settings-chat-'))).toHaveLength(1)
  })

  it('a chat settings file that cannot be renamed into place never keeps a session shut (re-review I-1): the 1.4.0 file, unarmed, logged once without a path', () => {
    const { terms, pty, userDataDir } = chatManager(() => ({ on: true, hooks: CHAT, version: '2.1.323' }))
    const said: string[] = []
    const logSpy = vi.spyOn(console, 'log').mockImplementation(((...a: any[]) => { said.push(a.join(' ')) }) as any)
    const rename = vi.spyOn(fs, 'renameSync').mockImplementation((() => { throw Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' }) }) as any)
    try {
      const a = terms.create({})
      expect(a.chat).toBe('unarmed')
      expect(launchedWith(pty)).toBe(join(userDataDir, 'session-settings.json'))
      expect(readFileSync(join(userDataDir, 'session-settings.json'), 'utf8')).toBe(sessionSettingsJson(REPO, process.execPath, null))
      const b = terms.create({})
      expect(b.chat).toBe('unarmed')
      expect(rename.mock.calls.length).toBe(6) // two creates, three tries each
      expect(terms.armedCount()).toBe(0)
    } finally { rename.mockRestore(); logSpy.mockRestore() }
    const about = said.filter(s => /settings file could not be written/.test(s))
    expect(about).toEqual([expect.stringContaining('(EPERM)')])
    expect(about[0]).not.toContain(userDataDir)
    expect(about[0]).not.toMatch(/[\\/]/)
    // no temporary file is left behind
    expect(fs.readdirSync(userDataDir).filter(n => n.endsWith('.tmp'))).toEqual([])
    // the next session, once the file can be written, is armed
    const c = terms.create({})
    expect(c.chat).toBe('armed')
    expect(path.basename(launchedWith(pty))).toMatch(/^session-settings-chat-[0-9a-f]{12}\.json$/)
  })

  it('a rename held for a moment (EBUSY once) still arms; a write that fails (ENOSPC) opens the session unarmed', () => {
    const one = chatManager(() => ({ on: true, hooks: CHAT }))
    const realRename = fs.renameSync
    let left = 1
    const rename = vi.spyOn(fs, 'renameSync').mockImplementation(((a: any, b: any) => { if (left-- > 0) throw Object.assign(new Error('busy'), { code: 'EBUSY' }); return (realRename as any)(a, b) }) as any)
    try { expect(one.terms.create({}).chat).toBe('armed') } finally { rename.mockRestore() }
    const two = chatManager(() => ({ on: true, hooks: CHAT }))
    const realWrite = fs.writeFileSync
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const write = vi.spyOn(fs, 'writeFileSync').mockImplementation(((p: any, ...rest: any[]) => { if (/session-settings-chat-/.test(String(p))) throw Object.assign(new Error('no space'), { code: 'ENOSPC' }); return (realWrite as any)(p, ...rest) }) as any)
    try {
      const s = two.terms.create({})
      expect(s.chat).toBe('unarmed')
      expect(launchedWith(two.pty)).toBe(join(two.userDataDir, 'session-settings.json'))
    } finally { write.mockRestore(); logSpy.mockRestore() }
  })

  it('armedCount counts the running armed sessions only', () => {
    const state: any = { on: true, hooks: CHAT }
    const { terms, pty } = chatManager(() => state)
    const a = terms.create({})
    terms.create({})
    expect(terms.armedCount()).toBe(2)
    const pid = [...pty.procs.keys()][0]
    pty.exit(pid)
    expect(terms.armedCount()).toBe(1)
    terms.close(a.id)
    expect(terms.armedCount()).toBe(1)
  })
})

describe('the terminal manager and the chat composer', () => {
  /** A pty that records every write with the fake clock's time */
  function recordingPty() {
    const base = fakePty()
    const writes: { pid: number; data: string; at: number }[] = []
    return {
      ...base,
      writes,
      spawn(command: string, args: string[]) {
        const p = base.spawn(command, args)
        return { ...p, write(d: string) { writes.push({ pid: p.pid, data: d, at: Date.now() }) } }
      },
    }
  }
  /** What a keyboard write, an Enter, an Esc and a side-box send (one line, then three lines) write, and when */
  async function play(chat: Record<string, unknown> | undefined) {
    const pty = recordingPty()
    const userDataDir = tempDir()
    const terms = createTerminalManager({ repoRoot: REPO, userDataDir, defaultCwd: userDataDir, send: () => {}, pty, killTree: () => {}, ...(chat ? { chat } : {}) })
    const t = terms.create({})
    const t0 = Date.now()
    terms.write(t.id, 'ab')
    terms.write(t.id, '\r')
    terms.write(t.id, '\x1b')
    expect(terms.sendInstruction(t.id, ' hello ')).toEqual({ ok: true })
    await vi.advanceTimersByTimeAsync(500)
    expect(terms.sendInstruction(t.id, 'one\r\ntwo\nthree')).toEqual({ ok: true })
    await vi.advanceTimersByTimeAsync(500)
    return { writes: pty.writes.map(w => ({ data: w.data, at: w.at - t0 })), terms, t }
  }
  /** release 1.4.0's bytes and times for that sequence */
  const PINNED = [
    { data: 'ab', at: 0 }, { data: '\r', at: 0 }, { data: '\x1b', at: 0 },
    { data: 'hello', at: 0 }, { data: '\r', at: 120 },
    { data: '\x1b[200~one\ntwo\nthree\x1b[201~', at: 500 }, { data: '\r', at: 620 },
  ]

  it('off, or no onInput, or a session not armed: the same bytes at the same times as 1.4.0, onInput never called', async () => {
    vi.useFakeTimers()
    try {
      const onInput = vi.fn()
      expect((await play(undefined)).writes).toEqual(PINNED)
      expect((await play({ state: () => ({ on: false }) })).writes).toEqual(PINNED)
      // on but not armed (no hooks: the version gate, starting): onInput is there and never called
      expect((await play({ state: () => ({ on: true, hooks: null, reason: 'version' }), onInput })).writes).toEqual(PINNED)
      expect(onInput).not.toHaveBeenCalled()
    } finally { vi.useRealTimers() }
  })

  it('armed: onInput hears every keyboard write (with the asking flag before it) and the side box, after the same writes', async () => {
    vi.useFakeTimers()
    try {
      const calls: unknown[][] = []
      const { writes } = await play({ state: () => ({ on: true, hooks: CHAT }), onInput: (...a: unknown[]) => calls.push(a) })
      expect(writes).toEqual(PINNED)
      const id = calls[0][0]
      expect(calls).toEqual([
        [id, 'ab', 'keyboard', undefined, false], [id, '\r', 'keyboard', undefined, false], [id, '\x1b', 'keyboard', undefined, false],
        [id, null, 'side', 'typed'], [id, null, 'side', 'enter'],
        [id, null, 'side', 'typed'], [id, null, 'side', 'enter'],
      ])
    } finally { vi.useRealTimers() }
  })

  it('an onInput that throws changes nothing for the terminal', async () => {
    vi.useFakeTimers()
    try {
      const { writes } = await play({ state: () => ({ on: true, hooks: CHAT }), onInput: () => { throw new Error('host gone') } })
      expect(writes).toEqual(PINNED)
    } finally { vi.useRealTimers() }
  })

  it('1.6.2: a send asked notWhileTyping is refused (typing) within 1.5 s of a real key, nothing written; a report or a move does not count', async () => {
    vi.useFakeTimers()
    try {
      const pty = recordingPty()
      const userDataDir = tempDir()
      const terms = createTerminalManager({ repoRoot: REPO, userDataDir, defaultCwd: userDataDir, send: () => {}, pty, killTree: () => {} })
      const t = terms.create({})
      terms.write(t.id, '다')
      await vi.advanceTimersByTimeAsync(500)
      expect(terms.sendInstruction(t.id, '/rename 로그인 수정', { notWhileTyping: true })).toEqual({ ok: false, reason: 'typing' })
      await vi.advanceTimersByTimeAsync(300)
      expect(pty.writes.map(w => w.data)).toEqual(['다'])
      await vi.advanceTimersByTimeAsync(800)
      // (a focus report and the cursor moving are not typing)
      terms.write(t.id, '\x1b[I')
      terms.write(t.id, '\x1b[D')
      expect(terms.sendInstruction(t.id, '/rename 로그인 수정', { notWhileTyping: true })).toEqual({ ok: true })
      await vi.advanceTimersByTimeAsync(300)
      expect(pty.writes.map(w => w.data)).toEqual(['다', '\x1b[I', '\x1b[D', '/rename 로그인 수정', '\r'])
      // without the option: as before, at once
      terms.write(t.id, 'x')
      expect(terms.sendInstruction(t.id, 'hi')).toEqual({ ok: true })
    } finally { vi.useRealTimers() }
  })

  it('review I-5: while a chat send is between its text and its Enter, the side box refuses (busy) and writes nothing; off or unarmed, busy is never asked', async () => {
    vi.useFakeTimers()
    try {
      let busy = true
      const asked: string[] = []
      const chat = { state: () => ({ on: true, hooks: CHAT }), onInput: () => {}, busy: (id: string) => { asked.push(id); return busy } }
      const pty = recordingPty()
      const userDataDir = tempDir()
      const terms = createTerminalManager({ repoRoot: REPO, userDataDir, defaultCwd: userDataDir, send: () => {}, pty, killTree: () => {}, chat })
      const t = terms.create({})
      expect(terms.sendInstruction(t.id, '/rename 로그인 수정')).toEqual({ ok: false, reason: 'busy' })
      await vi.advanceTimersByTimeAsync(300)
      expect(pty.writes).toEqual([])
      busy = false
      expect(terms.sendInstruction(t.id, '/rename 로그인 수정')).toEqual({ ok: true })
      await vi.advanceTimersByTimeAsync(300)
      expect(pty.writes.map(w => w.data)).toEqual(['/rename 로그인 수정', '\r'])
      expect(asked).toEqual([t.id, t.id])
      // off, or an unarmed session: 1.4.0 (busy never asked, the pinned bytes and times)
      const never = vi.fn(() => true)
      expect((await play({ state: () => ({ on: false }), onInput: () => {}, busy: never })).writes).toEqual(PINNED)
      expect((await play({ state: () => ({ on: true, hooks: null, reason: 'version' }), onInput: () => {}, busy: never })).writes).toEqual(PINNED)
      expect(never).not.toHaveBeenCalled()
    } finally { vi.useRealTimers() }
  })

  it('review m9: a session launched armed, the chat turned off since: its input is not reported any more', async () => {
    vi.useFakeTimers()
    try {
      let state: any = { on: true, hooks: CHAT }
      const calls: unknown[][] = []
      const pty = recordingPty()
      const userDataDir = tempDir()
      const terms = createTerminalManager({ repoRoot: REPO, userDataDir, defaultCwd: userDataDir, send: () => {}, pty, killTree: () => {}, chat: { state: () => state, onInput: (...a: unknown[]) => calls.push(a) } })
      const t = terms.create({})
      terms.write(t.id, 'a')
      expect(calls).toHaveLength(1)
      state = { on: false }
      terms.write(t.id, 'b')
      terms.sendInstruction(t.id, 'hi')
      await vi.advanceTimersByTimeAsync(300)
      expect(calls).toHaveLength(1)
      expect(pty.writes.map(w => w.data)).toEqual(['a', 'b', 'hi', '\r'])
    } finally { vi.useRealTimers() }
  })

  it('review I-4: each armed session gets a settings file of its own whose hooks name its terminal; it goes when the tab closes', () => {
    const { chatHookEntries: entries } = require('../electron/chatHooks.cjs')
    const hooks = (id: string) => entries({ port: 51234, token: 'ab'.repeat(24), id })
    const pty = fakePty()
    const userDataDir = tempDir()
    const terms = createTerminalManager({ repoRoot: REPO, userDataDir, defaultCwd: userDataDir, send: () => {}, pty, killTree: () => {}, chat: { state: () => ({ on: true, hooks }) } })
    const launched = () => { const a = pty.spawned.at(-1)!.args; return a[a.indexOf('--settings') + 1] }
    const a = terms.create({})
    const fa = launched()
    const b = terms.create({})
    const fb = launched()
    expect(fa).not.toBe(fb)
    expect(a.chat).toBe('armed')
    expect(readFileSync(fa, 'utf8')).toBe(sessionSettingsJson(REPO, process.execPath, hooks(a.id)))
    expect(JSON.parse(readFileSync(fb, 'utf8')).hooks.PermissionRequest[1].hooks[0].url).toContain('/' + b.id + '/PermissionRequest')
    terms.close(a.id)
    expect(existsSync(fa)).toBe(false)
    expect(existsSync(fb)).toBe(true)
    // the 1.4.0 file is not written for armed sessions
    expect(existsSync(join(userDataDir, 'session-settings.json'))).toBe(false)
  })

  it('typeForChat: only a running, armed Claude Code terminal; nothing else written; clearAsking clears the question', () => {
    const pty = recordingPty()
    const userDataDir = tempDir()
    const sent: any[] = []
    let state: any = { on: true, hooks: CHAT }
    const terms = createTerminalManager({ repoRoot: REPO, userDataDir, defaultCwd: userDataDir, send: (c: string, p: any) => sent.push([c, p]), pty, killTree: () => {}, chat: { state: () => state } })
    const armed = terms.create({})
    const shell = terms.create({ tool: 'shell' })
    state = { on: false }
    const plain = terms.create({})
    expect(terms.typeForChat(armed.id, 'x')).toBe(true)
    expect(terms.typeForChat(shell.id, 'x')).toBe(false)
    expect(terms.typeForChat(plain.id, 'x')).toBe(false)
    expect(terms.typeForChat('nope', 'x')).toBe(false)
    expect(terms.typeForChat(armed.id, 42 as any)).toBe(false)
    expect(pty.writes.map(w => w.data)).toEqual(['x'])
    // a question on screen (the trust question), cleared from the chat
    const pid = [...pty.procs.keys()][0]
    pty.data(pid, 'Do you trust the files in this folder?\n❯ 1. Yes, proceed\n')
    expect(terms.list().find((t: any) => t.id === armed.id).asking).toBe(true)
    const before = sent.length
    terms.clearAsking(armed.id)
    expect(terms.list().find((t: any) => t.id === armed.id).asking).toBe(false)
    expect(sent.length).toBe(before + 1)
    terms.clearAsking(armed.id)
    expect(sent.length).toBe(before + 1)
    // exited: no more
    pty.exit(pid)
    expect(terms.typeForChat(armed.id, 'x')).toBe(false)
  })

  it('typeForChat: a dialog answered from the chat (Enter, or Esc) clears the question; arrows between choices do not', () => {
    const pty = recordingPty()
    const userDataDir = tempDir()
    const terms = createTerminalManager({ repoRoot: REPO, userDataDir, defaultCwd: userDataDir, send: () => {}, pty, killTree: () => {}, chat: { state: () => ({ on: true, hooks: CHAT }) } })
    const armed = terms.create({})
    const pid = [...pty.procs.keys()][0]
    const asking = () => terms.list().find((t: any) => t.id === armed.id).asking
    // the /model confirmation (2.1.32x), answered by the chat's dialog card
    pty.data(pid, '   Switch model?\n   > 1. Yes, switch to Sonnet 5.5\n     2. No\n')
    expect(asking()).toBe(true)
    terms.typeForChat(armed.id, '\x1b[B')
    expect(asking()).toBe(true)
    terms.typeForChat(armed.id, '\r')
    expect(asking()).toBe(false)
    // the old dialog's words do not raise it again on the next output
    pty.data(pid, 'Set model to Sonnet 5.5\n')
    expect(asking()).toBe(false)
    // dismissed with Esc
    pty.data(pid, '   Switch model?\n   > 1. Yes, switch to Opus 5.5\n     2. No\n')
    expect(asking()).toBe(true)
    terms.typeForChat(armed.id, '\x1b')
    expect(asking()).toBe(false)
  })
})
