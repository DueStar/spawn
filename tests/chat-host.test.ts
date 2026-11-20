/**
 * electron/chatHost.cjs — the chat view's lifecycle in the main process:
 * nothing at all while off; on, a version gate before any session is armed,
 * the hook endpoint and the reading worker; off again, the worker stops at
 * once and the endpoint drains until the last armed session is gone; a
 * crashed worker shows a banner and restarts at most twice. Fakes for the
 * worker, the endpoint, the terminals and `claude --version`. Also checks
 * that main.cjs builds and enables it only behind the switches.
 */

import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

const require = createRequire(import.meta.url)
const { createChatHost } = require('../electron/chatHost.cjs')
const { chatHookEntries } = require('../electron/chatHooks.cjs')

const CLAUDE = { id: 'c1', tool: 'claude', status: 'running', chat: 'armed', createdAt: 100 }
const UNARMED = { id: 'c2', tool: 'claude', status: 'running', chat: 'unarmed', createdAt: 200 }
const SHELL = { id: 's1', tool: 'shell', status: 'running' }

class FakeWorker extends EventEmitter {
  posted: any[] = []
  terminated = false
  postMessage(m: any) { this.posted.push(m) }
  terminate() { this.terminated = true; queueMicrotask(() => this.emit('exit', 1)); return Promise.resolve(1) }
  crash(code = 1) { this.emit('exit', code) }
  /** the worker sends a message to main */
  send(m: any) { this.emit('message', m) }
}

function fakeEndpoint() {
  const e = {
    onHook: null as any,
    draining: false,
    closed: false,
    listen: vi.fn(async () => ({ port: 4321, token: 'ab'.repeat(24) })),
    setDraining: vi.fn((on: boolean) => { e.draining = on }),
    close: vi.fn(async () => { e.closed = true }),
  }
  return e
}

function setup({ version = '2.1.323 (Claude Code)' as string | null | (() => Promise<string | null>), list = [CLAUDE, UNARMED, SHELL] as any[], armed = 1, extra = {} as Record<string, unknown> } = {}) {
  const workers: FakeWorker[] = []
  const endpoints: ReturnType<typeof fakeEndpoint>[] = []
  const sent: any[] = []
  const logs: any[] = []
  const terminals = {
    list: vi.fn(() => list),
    refreshSettings: vi.fn(),
    armedCount: vi.fn(() => armed),
  }
  const host = createChatHost({
    terminals,
    send: (channel: string, payload: any) => sent.push({ channel, payload }),
    userDataDir: 'C:\\Users\\user\\AppData\\Roaming\\spawn',
    claudeVersion: typeof version === 'function' ? version : async () => version,
    makeWorker: () => { const w = new FakeWorker(); workers.push(w); return w },
    makeEndpoint: ({ onHook }: any) => { const e = fakeEndpoint(); e.onHook = onHook; endpoints.push(e); return e },
    log: (level: string, msg: string) => logs.push({ level, msg }),
    ...extra,
  })
  const setArmed = (n: number) => { armed = n }
  const setList = (l: any[]) => { list = l }
  return { host, workers, endpoints, sent, logs, terminals, setArmed, setList }
}

function fakeIpc() {
  const handlers = new Map<string, (...a: any[]) => any>()
  const ipcMain = { handle: (n: string, f: any) => handlers.set(n, f), on: (n: string, f: any) => handlers.set(n, f) }
  const guard = (fn: any) => (event: any, arg: any) => fn(arg, event)
  return { ipcMain, guard, call: (n: string, arg?: any) => handlers.get(n)!({}, arg), handlers }
}

afterEach(() => { vi.useRealTimers() })

describe('off', () => {
  it('nothing is made: no worker, no endpoint; ready() at once', async () => {
    const s = setup()
    expect(s.host.state()).toEqual({ on: false })
    await s.host.ready()
    s.host.onTerminals([CLAUDE])
    expect(s.workers).toHaveLength(0)
    expect(s.endpoints).toHaveLength(0)
    expect(s.terminals.refreshSettings).not.toHaveBeenCalled()
    const ipc = fakeIpc()
    s.host.registerIpc(ipc.ipcMain, ipc.guard)
    expect(await ipc.call('chat:open', 'c1')).toEqual({ ok: false, reason: 'off' })
  })
})

describe('enable', () => {
  it('a checked Claude Code: hooks, one endpoint, one worker told about the terminals', async () => {
    const s = setup()
    const p = s.host.enable()
    expect(s.host.state()).toEqual({ on: true, hooks: null, reason: 'starting' })
    await p
    await s.host.ready()
    // (each session's entries name its terminal: a function of the terminal's id)
    const st = s.host.state()
    expect({ ...st, hooks: undefined }).toEqual({ on: true, hooks: undefined, version: '2.1.323 (Claude Code)' })
    const T = '11111111-1111-4111-8111-111111111111'
    // (a version in the verified range: the buttons' holds too)
    expect(st.hooks(T)).toEqual(chatHookEntries({ port: 4321, token: 'ab'.repeat(24), id: T, holds: true }))
    expect(s.endpoints).toHaveLength(1)
    expect(s.workers).toHaveLength(1)
    expect(s.terminals.refreshSettings).toHaveBeenCalled()
    const [init, terms] = s.workers[0].posted
    expect(init).toMatchObject({ t: 'init', userDataDir: 'C:\\Users\\user\\AppData\\Roaming\\spawn', version: '2.1.323 (Claude Code)' })
    expect(terms).toEqual({ t: 'terminals', list: [
      { id: 'c1', cwd: undefined, armed: true, status: 'running', createdAt: 100 },
      { id: 'c2', cwd: undefined, armed: false, status: 'running', createdAt: 200 },
    ] })
  })

  it('an older Claude Code: reason version, nothing listens, no worker', async () => {
    const s = setup({ version: '2.0.9 (Claude Code)' })
    await s.host.enable()
    expect(s.host.state()).toEqual({ on: true, hooks: null, reason: 'version', version: '2.0.9 (Claude Code)' })
    expect(s.endpoints).toHaveLength(0)
    expect(s.workers).toHaveLength(0)
  })

  it('an unreadable version: never armed', async () => {
    const s = setup({ version: null })
    await s.host.enable()
    expect(s.host.state()).toMatchObject({ on: true, hooks: null, reason: 'version' })
    expect(s.workers).toHaveLength(0)
  })

  it('a newer Claude Code than the checked range: armed (the lens shows a quiet note; the canary guards)', async () => {
    const s = setup({ version: '2.3.0 (Claude Code)' })
    await s.host.enable()
    expect(s.host.state().hooks).toBeTruthy()
    expect(s.workers[0].posted[0]).toMatchObject({ t: 'init', version: '2.3.0 (Claude Code)' })
  })

  it('claude --version never answers: after 5 s, reason version', async () => {
    vi.useFakeTimers()
    const s = setup({ version: () => new Promise(() => {}) })
    const p = s.host.enable()
    await vi.advanceTimersByTimeAsync(4900)
    expect(s.host.state().reason).toBe('starting')
    await vi.advanceTimersByTimeAsync(200)
    await p
    expect(s.host.state()).toEqual({ on: true, hooks: null, reason: 'version', version: null })
    expect(s.workers).toHaveLength(0)
  })
})

describe('disable and drain', () => {
  it('with an armed session still running: the worker stops at once, the endpoint drains; it closes when the session is gone', async () => {
    const s = setup()
    await s.host.enable()
    s.host.disable()
    expect(s.host.state()).toEqual({ on: false })
    expect(s.workers[0].terminated).toBe(true)
    expect(s.endpoints[0].draining).toBe(true)
    expect(s.endpoints[0].closed).toBe(false)
    expect(s.terminals.refreshSettings).toHaveBeenCalledTimes(3) // starting, on, off
    // nothing is sent to the page: it drops its views when TerminalInfo.chat disappears
    expect(s.sent).toEqual([])
    s.host.onTerminals([{ ...CLAUDE, chat: undefined }])
    expect(s.endpoints[0].closed).toBe(false)
    s.setArmed(0)
    s.host.onTerminals([])
    expect(s.endpoints[0].close).toHaveBeenCalledTimes(1)
  })

  it('enabled again while draining: the same endpoint, port and token', async () => {
    const s = setup()
    await s.host.enable()
    const hooks = s.host.state().hooks
    s.host.disable()
    await s.host.enable()
    expect(s.endpoints).toHaveLength(1)
    expect(s.endpoints[0].draining).toBe(false)
    expect(s.host.state().hooks('11111111-1111-4111-8111-111111111111')).toEqual(hooks('11111111-1111-4111-8111-111111111111'))
    expect(s.workers).toHaveLength(2)
  })

  it('disabled before the version came back: stays off, nothing started', async () => {
    let answer: (v: string) => void = () => {}
    const s = setup({ version: () => new Promise<string>((r) => { answer = r }) })
    const p = s.host.enable()
    s.host.disable()
    answer('2.1.323')
    await p
    expect(s.host.state()).toEqual({ on: false })
    expect(s.workers).toHaveLength(0)
  })
})

describe('the worker', () => {
  it('its updates go to the page with the host\'s own rev; a crash: the open views get the worker banner, and it restarts (twice at most)', async () => {
    vi.useFakeTimers()
    const s = setup()
    await s.host.enable()
    const ipc = fakeIpc()
    s.host.registerIpc(ipc.ipcMain, ipc.guard)
    expect(await ipc.call('chat:open', 'c1')).toEqual({ ok: true })
    const w0 = s.workers[0]
    expect(w0.posted.at(-1)).toEqual({ t: 'open', id: 'c1' })
    const status = { state: 'idle', since: null, label: null, banner: null, note: null, version: '2.1.323', hasOlder: false, empty: false }
    w0.send({ t: 'update', update: { id: 'c1', rev: 1, ops: [{ op: 'reset', items: [], status }] } })
    w0.send({ t: 'update', update: { id: 'c1', rev: 2, ops: [{ op: 'upsert', items: [] }] } })
    expect(s.sent.map(x => [x.channel, x.payload.rev])).toEqual([['chat:update', 1], ['chat:update', 2]])

    w0.crash(1)
    const banner = s.sent.at(-1)
    expect(banner.channel).toBe('chat:update')
    expect(banner.payload).toEqual({ id: 'c1', rev: 3, ops: [{ op: 'status', status: { ...status, banner: { reason: 'worker' } } }] })
    await vi.advanceTimersByTimeAsync(1000)
    expect(s.workers).toHaveLength(2)
    // the new worker is told everything again, the open view included
    expect(s.workers[1].posted.map(m => m.t)).toEqual(['init', 'terminals', 'open'])
    s.workers[1].send({ t: 'update', update: { id: 'c1', rev: 1, ops: [{ op: 'reset', items: [], status }] } })
    expect(s.sent.at(-1).payload.rev).toBe(4)

    s.workers[1].crash(1)
    await vi.advanceTimersByTimeAsync(1000)
    expect(s.workers).toHaveLength(3)
    s.workers[2].crash(1)
    await vi.advanceTimersByTimeAsync(5000)
    expect(s.workers).toHaveLength(3) // no third restart
    expect(s.sent.at(-1).payload.ops[0].status.banner).toEqual({ reason: 'worker' })
    // the endpoint never depended on the worker
    expect(s.endpoints[0].closed).toBe(false)
    expect(() => s.endpoints[0].onHook('Stop', { session_id: 'x' }, 1)).not.toThrow()
  })

  it('a raw hook body goes to the worker as transferred bytes; main never parses it (review M13)', async () => {
    const s = setup()
    await s.host.enable()
    const posts: any[] = []
    const w = s.workers[0]
    w.postMessage = (m: any, transfer?: any[]) => { posts.push({ m, transfer }) }
    const bytes = new Uint8Array(Buffer.from('{"session_id":"c1"}'))
    const spy = vi.spyOn(JSON, 'parse')
    s.endpoints[0].onHook('Stop', bytes, 5)
    expect(spy).not.toHaveBeenCalled()
    spy.mockRestore()
    expect(posts[0].m).toEqual({ t: 'hook', event: 'Stop', raw: bytes, at: 5 })
    expect(posts[0].transfer).toEqual([bytes.buffer])
  })

  it('the endpoint is asked for raw bodies', () => {
    const src = readFileSync(join(__dirname, '..', 'electron', 'chatHost.cjs'), 'utf8')
    // (the registry only while new holds may open)
    expect(src).toContain('makeEndpoint({ onHook, onArrive, log, raw: true, holds: () => (holdsOpen ? holds : null) })')
  })

  it('hooks from the endpoint go to the worker as they are', async () => {
    const s = setup()
    await s.host.enable()
    s.endpoints[0].onHook('PreToolUse', { session_id: 'c1', tool_name: 'Read' }, 123)
    expect(s.workers[0].posted.at(-1)).toEqual({ t: 'hook', event: 'PreToolUse', body: { session_id: 'c1', tool_name: 'Read' }, at: 123 })
  })

  it('the worker\'s log lines go to the log', async () => {
    const s = setup()
    await s.host.enable()
    s.workers[0].send({ t: 'log', level: 'error', msg: 'chat lens: boom' })
    expect(s.logs).toContainEqual({ level: 'error', msg: 'chat lens: boom' })
  })
})

describe('IPC', () => {
  it('chat:open answers from the list and the state, without the worker', async () => {
    const s = setup()
    await s.host.enable()
    const ipc = fakeIpc()
    s.host.registerIpc(ipc.ipcMain, ipc.guard)
    expect([...ipc.handlers.keys()].sort()).toEqual(['chat:agent', 'chat:answer', 'chat:change-file', 'chat:changes', 'chat:close', 'chat:commands', 'chat:cycle-mode', 'chat:diag', 'chat:dialog-key', 'chat:files', 'chat:full', 'chat:image', 'chat:image-drop', 'chat:interrupt', 'chat:local-image', 'chat:older', 'chat:open', 'chat:preview', 'chat:redraw', 'chat:reload', 'chat:resync', 'chat:send', 'chat:stranded', 'chat:submit', 'chat:visible'])
    const before = s.workers[0].posted.length
    expect(await ipc.call('chat:open', 's1')).toEqual({ ok: false, reason: 'not-claude' })
    expect(await ipc.call('chat:open', 'nope')).toEqual({ ok: false, reason: 'not-claude' })
    expect(await ipc.call('chat:open', 'c2')).toEqual({ ok: false, reason: 'unarmed' })
    expect(s.workers[0].posted.length).toBe(before)
  })

  it('chat:open with the version gate closed: version', async () => {
    const s = setup({ version: '2.0.1', list: [{ ...CLAUDE, chat: 'version' }] })
    await s.host.enable()
    const ipc = fakeIpc()
    s.host.registerIpc(ipc.ipcMain, ipc.guard)
    expect(await ipc.call('chat:open', 'c1')).toEqual({ ok: false, reason: 'version' })
  })

  it('older / reload / agent are asked of the worker and answered by its reply; close is passed on', async () => {
    const s = setup()
    await s.host.enable()
    const ipc = fakeIpc()
    s.host.registerIpc(ipc.ipcMain, ipc.guard)
    const w = s.workers[0]
    const older = ipc.call('chat:older', 'c1')
    const req = w.posted.at(-1)
    expect(req).toMatchObject({ t: 'older', id: 'c1' })
    w.send({ t: 'reply', req: req.req, result: { ok: true, loaded: 12 } })
    expect(await older).toEqual({ ok: true, loaded: 12 })
    const agent = ipc.call('chat:agent', { id: 'c1', toolId: 'toolu_x' })
    const r2 = w.posted.at(-1)
    expect(r2).toMatchObject({ t: 'agent', id: 'c1', toolId: 'toolu_x' })
    w.send({ t: 'reply', req: r2.req, result: { ok: true } })
    expect(await agent).toEqual({ ok: true })
    const reload = ipc.call('chat:reload', 'c1')
    const r3 = w.posted.at(-1)
    w.send({ t: 'reply', req: r3.req, result: { ok: true } })
    expect(await reload).toEqual({ ok: true })
    ipc.call('chat:close', 'c1')
    expect(w.posted.at(-1)).toEqual({ t: 'close', id: 'c1' })
  })

  it('changes / change-file are asked of the worker with plain values; no worker: { ok: false }', async () => {
    const s = setup()
    await s.host.enable()
    const ipc = fakeIpc()
    s.host.registerIpc(ipc.ipcMain, ipc.guard)
    const w = s.workers[0]
    const ch = ipc.call('chat:changes', 'c1')
    const r1 = w.posted.at(-1)
    expect(r1).toEqual({ t: 'changes', id: 'c1', req: r1.req })
    const summary = { v: 2, state: 'ready', files: 1, edits: 1, added: 1, removed: 0, unknown: 0 }
    w.send({ t: 'reply', req: r1.req, result: { ok: true, summary, files: [], agentsUnread: 0 } })
    expect(await ch).toEqual({ ok: true, summary, files: [], agentsUnread: 0 })
    // only an id, a file name (capped) and a finite number go to the worker
    const cf = ipc.call('chat:change-file', { id: 'c1', file: 'src/math.js', before: 1234, extra: 'x' })
    const r2 = w.posted.at(-1)
    expect(r2).toEqual({ t: 'change-file', id: 'c1', file: 'src/math.js', before: 1234, req: r2.req })
    w.send({ t: 'reply', req: r2.req, result: { ok: false, reason: 'unknown' } })
    expect(await cf).toEqual({ ok: false, reason: 'unknown' })
    ipc.call('chat:change-file', { id: 'c1', file: 'x'.repeat(5000), before: Infinity })
    const r3 = w.posted.at(-1)
    expect(r3.file).toHaveLength(4096)
    expect('before' in r3).toBe(false)
    // the worker gone: the fallbacks, at once
    await s.host.disable()
    expect(await ipc.call('chat:changes', 'c1')).toEqual({ ok: false })
    expect(await ipc.call('chat:change-file', { id: 'c1', file: 'a' })).toEqual({ ok: false, reason: 'gone' })
  })

  it('resync (a page that lost an update) is asked of the worker; reload stays the 다시 읽기 (review I5)', async () => {
    const s = setup()
    await s.host.enable()
    const ipc = fakeIpc()
    s.host.registerIpc(ipc.ipcMain, ipc.guard)
    const w = s.workers[0]
    const p = ipc.call('chat:resync', 'c1')
    const req = w.posted.at(-1)
    expect(req).toMatchObject({ t: 'resync', id: 'c1' })
    w.send({ t: 'reply', req: req.req, result: { ok: true } })
    expect(await p).toEqual({ ok: true })
  })

  it('resync with the worker gone for good: the open view hears the worker banner again', async () => {
    vi.useFakeTimers()
    const s = setup()
    await s.host.enable()
    const ipc = fakeIpc()
    s.host.registerIpc(ipc.ipcMain, ipc.guard)
    await ipc.call('chat:open', 'c1')
    for (let i = 0; i < 3; i++) { s.workers.at(-1)!.crash(1); await vi.advanceTimersByTimeAsync(1000) }
    const n = s.sent.length
    expect(await ipc.call('chat:resync', 'c1')).toEqual({ ok: true })
    expect(s.sent.length).toBe(n + 1)
    expect(s.sent.at(-1).payload.ops[0].status.banner).toEqual({ reason: 'worker' })
  })

  it('a request to a worker that is gone answers at once', async () => {
    const s = setup({ version: '2.0.1' })
    await s.host.enable()
    const ipc = fakeIpc()
    s.host.registerIpc(ipc.ipcMain, ipc.guard)
    expect(await ipc.call('chat:older', 'c1')).toEqual({ ok: false, loaded: 0 })
    expect(await ipc.call('chat:reload', 'c1')).toEqual({ ok: false })
  })
})

describe('close at quit', () => {
  it('stops the worker and closes the endpoint', async () => {
    const s = setup()
    await s.host.enable()
    await s.host.close()
    expect(s.workers[0].terminated).toBe(true)
    expect(s.endpoints[0].closed).toBe(true)
  })
})

describe('main.cjs: nothing of it unless the switches are on', () => {
  const main = readFileSync(join(__dirname, '..', 'electron', 'main.cjs'), 'utf8')
  const linesWith = (needle: string) => main.split('\n').filter(l => l.includes(needle))

  it('the host is built only behind CHAT_VIEW', () => {
    expect(main).toMatch(/const \{ CHAT_VIEW \} = require\('\.\/features\.cjs'\)/)
    const made = linesWith('createChatHost(')
    expect(made.length).toBeGreaterThan(0)
    for (const l of made) expect(l.slice(0, l.indexOf('createChatHost('))).toContain('CHAT_VIEW')
  })

  it('enable() only behind the setting; ready() awaited only while on', () => {
    const enables = linesWith('.enable()')
    expect(enables.length).toBeGreaterThan(0)
    for (const l of enables) expect(l).toContain('session.chatView')
    const ready = linesWith('.ready()')
    expect(ready.length).toBeGreaterThan(0)
    for (const l of ready) expect(l).toContain('state().on')
  })

  it('the worker, the server and the hook entries live in the host, not in main', () => {
    for (const word of ['chatWorker', 'http.createServer', 'chatHookEntries']) expect(main).not.toContain(word)
  })

  it('the terminal manager gets the chat state, off when there is no host; onInput only behind CHAT_VIEW', () => {
    expect(main).toContain("chat: { state: () => chatHost?.state() ?? { on: false }, onInput: CHAT_VIEW ? (...a) => chatHost?.onInput(...a) : undefined, busy: CHAT_VIEW ? (id) => chatHost?.busy(id) === true : undefined }")
    for (const l of linesWith('busy: ')) expect(l, l).toContain('CHAT_VIEW ?')
    for (const l of linesWith('onInput')) expect(l, l).toContain('CHAT_VIEW ?')
    // the composer's way into a terminal reaches only the host (built only behind CHAT_VIEW)
    expect(linesWith('typeForChat').every(l => l.includes('terminals?.typeForChat'))).toBe(true)
  })
})

// the version gate arms from a cached verdict for the same binary at once, and
// re-probes in the background (never blocking a session's start); newer versions are armed with the note
describe('the version gate, cached and re-probed', () => {
  function cacheFs(initial: string | null) {
    const files = new Map<string, string>()
    if (initial !== null) files.set('cache.json', initial)
    return {
      files,
      fs: {
        readFileSync: (p: string) => { if (!files.has(p)) throw Object.assign(new Error('nope'), { code: 'ENOENT' }); return files.get(p) },
        writeFileSync: (p: string, t: string) => { files.set(p, t) },
        renameSync: (a: string, b: string) => { files.set(b, files.get(a)!); files.delete(a) },
      },
    }
  }

  it('the same binary as last time: armed from the cache at once, the version checked again in the background', async () => {
    const c = cacheFs(JSON.stringify({ stamp: 'claude.exe|1|2', version: '2.1.330 (Claude Code)' }))
    let probes = 0
    const s = setup({ version: () => { probes++; return new Promise(() => {}) }, extra: { binaryStamp: () => 'claude.exe|1|2', cacheFile: 'cache.json', fs: c.fs } })
    s.host.enable()
    await s.host.ready()
    expect(s.host.state()).toMatchObject({ on: true, version: '2.1.330 (Claude Code)' })
    expect(s.host.state().hooks).toBeTruthy()
    expect(probes).toBe(1) // still checked, without waiting for it
  })

  it('no cache (or another binary): the probe decides and is remembered with the binary', async () => {
    const c = cacheFs(JSON.stringify({ stamp: 'claude.exe|OLD|2', version: '2.1.330' }))
    const s = setup({ version: '2.1.340 (Claude Code)', extra: { binaryStamp: () => 'claude.exe|9|9', cacheFile: 'cache.json', fs: c.fs } })
    await s.host.enable()
    expect(s.host.state().version).toBe('2.1.340 (Claude Code)')
    expect(JSON.parse(c.files.get('cache.json')!)).toEqual({ stamp: 'claude.exe|9|9', version: '2.1.340 (Claude Code)' })
  })

  it('an update of Claude Code noticed when a session starts: re-probed in the background; an older one disarms new sessions', async () => {
    let v = '2.1.330 (Claude Code)'
    let stamp = 'a|1|1'
    const c = cacheFs(null)
    const s = setup({ version: async () => v, extra: { binaryStamp: () => stamp, cacheFile: 'cache.json', fs: c.fs } })
    await s.host.enable()
    expect(s.host.state().hooks).toBeTruthy()
    v = '2.0.1 (Claude Code)'
    stamp = 'a|2|1'
    expect(s.host.noteCreate()).toBeUndefined() // never waits
    await new Promise(r => setTimeout(r, 0))
    await s.host.ready()
    expect(s.host.state()).toMatchObject({ on: true, hooks: null, reason: 'version', version: '2.0.1 (Claude Code)' })
    // the armed sessions still running keep their endpoint and worker
    expect(s.endpoints[0].closed).toBe(false)
    expect(s.workers[0].terminated).toBe(false)
    // and back to a checked version: armed again, on the same endpoint
    v = '2.1.400'
    stamp = 'a|3|1'
    s.host.noteCreate()
    await new Promise(r => setTimeout(r, 0))
    expect(s.host.state().hooks).toBeTruthy()
    expect(s.endpoints).toHaveLength(1)
  })

  it('the same binary, re-probed only every few minutes', async () => {
    let probes = 0
    let t = 1_000_000
    const s = setup({ version: async () => { probes++; return '2.1.330' }, extra: { binaryStamp: () => 'b|1|1', now: () => t } })
    await s.host.enable()
    expect(probes).toBe(1)
    s.host.noteCreate()
    s.host.noteCreate()
    expect(probes).toBe(1)
    t += 5 * 60_000
    s.host.noteCreate()
    expect(probes).toBe(2)
  })

  it('a re-probe that cannot read the version of the same binary keeps the known verdict; of a changed binary, disarms', async () => {
    let v: string | null = '2.1.330'
    let stamp = 'c|1|1'
    let t = 0
    const s = setup({ version: async () => v, extra: { binaryStamp: () => stamp, now: () => t } })
    await s.host.enable()
    v = null
    t += 10 * 60_000
    s.host.noteCreate()
    await new Promise(r => setTimeout(r, 0))
    expect(s.host.state().hooks).toBeTruthy()
    stamp = 'c|2|1'
    s.host.noteCreate()
    await new Promise(r => setTimeout(r, 0))
    expect(s.host.state()).toMatchObject({ hooks: null, reason: 'version' })
  })

  it('main asks for the version of the binary its sessions run, and tells the host of every new session', () => {
    const main = readFileSync(join(__dirname, '..', 'electron', 'main.cjs'), 'utf8')
    expect(main).toContain('claudeVersion: () => claudeVersion({ binary: claudeCommand() })')
    expect(main).toContain('chatHost?.noteCreate()')
  })
})

describe('prereqs: the version of a given binary', () => {
  it('claudeVersion({ binary }) runs that binary only', async () => {
    const { claudeVersion } = require('../electron/prereqs.cjs')
    const ran: string[] = []
    const v = await claudeVersion({ binary: '/opt/x/claude', run: async (cmd: string) => { ran.push(cmd); return '2.1.323 (Claude Code)\n' }, exists: () => true, home: '/h', platform: 'darwin' })
    expect(v).toBe('2.1.323 (Claude Code)')
    expect(ran).toEqual(['/opt/x/claude'])
  })
})

describe('binaryStamp', () => {
  it('a binary on PATH or by path: its path, mtime and size; nothing found: null', async () => {
    const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { binaryStamp } = require('../electron/chatHost.cjs')
    const dir = mkdtempSync(join(tmpdir(), 'spawn-stamp-'))
    try {
      writeFileSync(join(dir, 'claude-x'), 'bin')
      const byPath = binaryStamp('claude-x', { env: { PATH: dir } })
      expect(byPath).toMatch(/^.+claude-x\|\d+\|3$/)
      expect(binaryStamp(join(dir, 'claude-x'), { env: {} })).toBe(byPath)
      expect(binaryStamp('nothing-here', { env: { PATH: dir } })).toBeNull()
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
})

describe('the version cache, the stamp, a disarmed host\'s worker', () => {
  function memFs(initial: Record<string, string> = {}) {
    const files = new Map<string, string>(Object.entries(initial))
    return {
      files,
      fs: {
        readFileSync: (p: string) => { if (!files.has(p)) throw Object.assign(new Error('nope'), { code: 'ENOENT' }); return files.get(p) },
        writeFileSync: (p: string, t: string) => { files.set(p, t) },
        renameSync: (a: string, b: string) => { files.set(b, files.get(a)!); files.delete(a) },
      },
    }
  }

  it('m-3: a probe that timed out is never remembered; an old cache of one is not used', async () => {
    vi.useFakeTimers()
    const c = memFs()
    const s = setup({ version: () => new Promise(() => {}), extra: { binaryStamp: () => 'claude.exe|1|2', cacheFile: 'cache.json', fs: c.fs } })
    const ready = s.host.enable()
    await vi.advanceTimersByTimeAsync(5000)
    await ready
    expect(s.host.state()).toMatchObject({ reason: 'version' })
    expect(c.files.has('cache.json')).toBe(false)
    vi.useRealTimers()
    // a cache an earlier build wrote with version null: probed afresh, not taken as "version unknown"
    const d = memFs({ 'cache.json': JSON.stringify({ stamp: 'claude.exe|1|2', version: null }) })
    let probes = 0
    const t = setup({ version: async () => { probes++; return '2.1.330 (Claude Code)' }, extra: { binaryStamp: () => 'claude.exe|1|2', cacheFile: 'cache.json', fs: d.fs } })
    await t.host.enable()
    expect(probes).toBe(1)
    expect(t.host.state().hooks).toBeTruthy()
    expect(JSON.parse(d.files.get('cache.json')!)).toEqual({ stamp: 'claude.exe|1|2', version: '2.1.330 (Claude Code)' })
  })

  it('m-14: a session\'s start looks only at the binary found last time (one stat), and searches PATH again only when it is gone', async () => {
    const asked: (string | undefined)[] = []
    let found: string | null = 'C:\\tools\\claude.exe|1|2'
    const stampFor = (hint?: string) => { asked.push(hint); return hint ? (found && found.startsWith(hint) ? found : null) : 'C:\\other\\claude.exe|5|5' }
    const s = setup({ version: async () => '2.1.330', extra: { binaryStamp: (hint?: string) => (asked.length ? stampFor(hint) : (asked.push(hint), found)) } })
    await s.host.enable()
    expect(asked).toEqual([undefined]) // the full look at start
    s.host.noteCreate()
    expect(asked.slice(1)).toEqual(['C:\\tools\\claude.exe'])
    // the file is gone: the full look again (and a re-probe for the other binary it finds)
    found = null
    s.host.noteCreate()
    expect(asked.slice(2)).toEqual(['C:\\tools\\claude.exe', undefined, undefined]) // (the last: the re-probe's own full look)
  })

  it('m-14: disarmed by a re-probe while armed sessions run, a crashed worker is still restarted for them', async () => {
    let v = '2.1.330'
    let stamp = 'w|1|1'
    const s = setup({ version: async () => v, armed: 1, extra: { binaryStamp: () => stamp } })
    await s.host.enable()
    v = '2.0.1'
    stamp = 'w|2|1'
    s.host.noteCreate()
    await new Promise(r => setTimeout(r, 0))
    expect(s.host.state()).toMatchObject({ hooks: null, reason: 'version' })
    vi.useFakeTimers()
    s.workers[0].crash(1)
    await vi.advanceTimersByTimeAsync(1000)
    expect(s.workers).toHaveLength(2)
    // with no armed session left, a crash is the end of it
    s.setArmed(0)
    s.workers[1].crash(1)
    await vi.advanceTimersByTimeAsync(5000)
    expect(s.workers).toHaveLength(2)
  })
})

describe('the real trial: a chat settings file left by an earlier run', () => {
  it('main\'s host sweeps them before any session starts; session-settings.json and other files stay; other hosts touch nothing', async () => {
    const { mkdtempSync, writeFileSync, readdirSync, rmSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const dir = mkdtempSync(join(tmpdir(), 'spawn-chat-sweep-'))
    try {
      const names = ['session-settings.json', 'session-settings-chat-f4992ccac5aa.json', 'session-settings-chat-85dfa4d1b87f.json.1234.tmp', 'settings.json', 'session-settings-chat-notahash.json']
      for (const n of names) writeFileSync(join(dir, n), '{}')
      // a host built without sweep (the tests', any but main's) leaves the folder alone
      setup({ extra: { userDataDir: dir } })
      expect(readdirSync(dir).sort()).toEqual([...names].sort())
      setup({ extra: { userDataDir: dir, sweep: true } })
      expect(readdirSync(dir).sort()).toEqual(['session-settings-chat-notahash.json', 'session-settings.json', 'settings.json'])
      // a folder that is not there yet: nothing thrown
      expect(() => setup({ extra: { userDataDir: join(dir, 'missing'), sweep: true } })).not.toThrow()
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('main builds its host with sweep on', () => {
    expect(readFileSync(join(__dirname, '..', 'electron', 'main.cjs'), 'utf8')).toMatch(/createChatHost\(\{[\s\S]{0,1500}?sweep: true,[\s\S]{0,1200}?\}\)/)
    // and with the image folder of this app instance (chatImages.cjs: under the OS temp folder)
    expect(readFileSync(join(__dirname, '..', 'electron', 'main.cjs'), 'utf8')).toMatch(/imageRoot: require\('\.\/chatImages\.cjs'\)\.imageRoot\(app\.getPath\('temp'\), app\.getPath\('userData'\)\)/)
  })
})

describe('every part per version verdict (ok / new / old / unknown), at enable and after a mid-run change', () => {
  const T = '11111111-1111-4111-8111-111111111111'
  const VERSIONS: Record<string, string | null> = { ok: '2.1.325 (Claude Code)', new: '2.3.0 (Claude Code)', old: '2.0.9 (Claude Code)', unknown: null }
  /** What each part does for a host on `verdict` (the worker answers whatever it is asked) */
  async function parts(s: ReturnType<typeof setup>) {
    const ipc = fakeIpc()
    s.host.registerIpc(ipc.ipcMain, ipc.guard)
    const st = s.host.state()
    const w = s.workers.at(-1)
    // the worker answers every request it gets at once (as the lens would)
    if (w) w.postMessage = (m: any) => { w.posted.push(m); if (m.req) queueMicrotask(() => w.send({ t: 'reply', req: m.req, result: m.t === 'changes' ? { ok: true, summary: { v: 1, state: 'ready', files: 0, edits: 0, added: 0, removed: 0, unknown: 0 }, files: [], agentsUnread: 0 } : m.t === 'preview' ? { ok: true, card: { url: m.url, site: 'a.example', via: null, title: 'T', description: '', image: null } } : { ok: true } })) }
    const open = await ipc.call('chat:open', 'c1')
    const changes = await ipc.call('chat:changes', 'c1')
    // (for the view just opened: main asks the worker only for an open view)
    const preview = await ipc.call('chat:preview', { id: 'c1', url: 'https://a.example/' })
    return {
      hooks: st.hooks ? st.hooks(T) : null,
      reason: st.reason ?? null,
      open: open.ok === true ? 'ok' : open.reason,
      changes: changes.ok === true,
      preview: preview.ok === true,
      workerVersion: w ? w.posted.find((m: any) => m.t === 'init')?.version ?? null : null,
    }
  }

  for (const [verdict, version] of Object.entries(VERSIONS)) {
    it(`${verdict} at enable: hooks ${verdict === 'ok' || verdict === 'new' ? 'for new sessions' : 'none'}, holds ${verdict === 'ok' ? 'on' : 'off'}, the chat (composer, changes) ${verdict === 'ok' || verdict === 'new' ? 'on' : 'off'}, previews as 설정 says`, async () => {
      const armed = verdict === 'ok' || verdict === 'new'
      // (a session started under this verdict: armed, or launched without the chat hooks for the version — terminals.cjs)
      const s = setup({ version, list: [armed ? CLAUDE : { ...CLAUDE, chat: 'version' }], extra: { previewsOn: () => true } })
      await s.host.enable()
      const p = await parts(s)
      if (armed) expect(p.hooks).toEqual(chatHookEntries({ port: 4321, token: 'ab'.repeat(24), id: T, holds: verdict === 'ok' }))
      else { expect(p.hooks).toBeNull(); expect(p.reason).toBe('version') }
      // the view (and its composer and changes panel) for an armed session: open; never for an unarmed version
      expect(p.open).toBe(armed ? 'ok' : 'version')
      expect(p.changes).toBe(armed)
      // previews follow 설정 (on here): fetched by the worker whatever the version, while there is a chat to show them in
      expect(p.preview).toBe(armed)
      // the open views' note: the worker is told the version (the lens shows 'new-version' for a newer one)
      expect(p.workerVersion).toBe(armed ? version : null)
    })
  }

  it('previews: off in 설정 → nothing asked of the worker, for ok and new alike', async () => {
    for (const version of [VERSIONS.ok, VERSIONS.new]) {
      const s = setup({ version, extra: { previewsOn: () => false } })
      await s.host.enable()
      const ipc = fakeIpc()
      s.host.registerIpc(ipc.ipcMain, ipc.guard)
      expect(await ipc.call('chat:preview', { url: 'https://a.example/' })).toEqual({ ok: false })
      expect(s.workers[0].posted.some((m: any) => m.t === 'preview')).toBe(false)
    }
  })

  it('a mid-run change of the binary: ok → new drops the holds (passive cards), keeps the hooks; → old disarms new sessions, armed ones keep their endpoint and worker; → ok arms again with holds', async () => {
    let v: string | null = VERSIONS.ok
    let stamp = 'c|1|1'
    const s = setup({ version: async () => v, extra: { binaryStamp: () => stamp } })
    await s.host.enable()
    const step = async (version: string | null, n: number) => { v = version; stamp = `c|${n}|1`; s.host.noteCreate(); await new Promise(r => setTimeout(r, 0)); await s.host.ready() }
    expect(s.host.state().hooks(T)).toEqual(chatHookEntries({ port: 4321, token: 'ab'.repeat(24), id: T, holds: true }))
    await step(VERSIONS.new, 2)
    expect(s.host.state().hooks(T)).toEqual(chatHookEntries({ port: 4321, token: 'ab'.repeat(24), id: T, holds: false }))
    expect(s.host.state().version).toBe(VERSIONS.new)
    await step(VERSIONS.old, 3)
    expect(s.host.state()).toMatchObject({ on: true, hooks: null, reason: 'version' })
    expect(s.endpoints[0].closed).toBe(false)
    expect(s.workers[0].terminated).toBe(false)
    await step(null, 4)
    expect(s.host.state()).toMatchObject({ hooks: null, reason: 'version' })
    await step(VERSIONS.ok, 5)
    expect(s.host.state().hooks(T)).toEqual(chatHookEntries({ port: 4321, token: 'ab'.repeat(24), id: T, holds: true }))
    expect(s.endpoints).toHaveLength(1)
    // every step was re-applied to the sessions' settings files (new sessions get the new entries; running ones keep theirs)
    expect(s.terminals.refreshSettings.mock.calls.length).toBeGreaterThanOrEqual(5)
  })
})

describe('drills: the endpoint cannot listen, the worker goes', () => {
  it('listen fails (EADDRINUSE): not left starting — reason failed with a log line, ready() settles, nothing waits; enabling again works', async () => {
    let fail = true
    const s = setup({ extra: { makeEndpoint: ({ onHook }: any) => { const e = fakeEndpoint(); e.onHook = onHook; if (fail) e.listen = vi.fn(async () => { throw Object.assign(new Error('in use'), { code: 'EADDRINUSE' }) }); return e } } })
    await s.host.enable()
    await s.host.ready()
    expect(s.host.state()).toEqual({ on: true, hooks: null, reason: 'failed' })
    expect(s.logs.some((l: any) => l.level === 'error' && /could not start \(EADDRINUSE\)/.test(l.msg))).toBe(true)
    expect(s.workers).toHaveLength(0)
    fail = false
    s.host.disable()
    await s.host.enable()
    expect(s.host.state().hooks).toBeTruthy()
  })

  it('listen never answers: after 3 s the reason is failed (a session start never waits past its own 3 s)', async () => {
    vi.useFakeTimers()
    const made: any[] = []
    const s = setup({ extra: { makeEndpoint: ({ onHook }: any) => { const e = fakeEndpoint(); e.onHook = onHook; e.listen = vi.fn(() => new Promise(() => {})); made.push(e); return e } } })
    const p = s.host.enable()
    await vi.advanceTimersByTimeAsync(2900)
    expect(s.host.state()).toMatchObject({ reason: 'starting' })
    await vi.advanceTimersByTimeAsync(200)
    await p
    expect(s.host.state()).toEqual({ on: true, hooks: null, reason: 'failed' })
    // (it never listened: closed, and the next enable makes a new one)
    expect(made[0].closed).toBe(true)
  })

  it('the flip says why: 채팅 보기를 준비하지 못했어요 (ko / en / ja)', async () => {
    const { LENS_REASON } = await import('../src/components/SessionHeader')
    expect(LENS_REASON.failed).toBe('채팅 보기를 준비하지 못했어요')
    const chat = (await import('../src/locales/chat')).default
    expect(chat.en['채팅 보기를 준비하지 못했어요']).toBe("Couldn't get the chat view ready")
    expect(chat.ja['채팅 보기를 준비하지 못했어요']).toBe('チャット表示を準備できませんでした')
  })

  it('the worker killed with a card open and requests pending: the cards go back to the terminal, every request answered, the third crash not restarted', async () => {
    vi.useFakeTimers()
    const s = setup({ extra: { previewsOn: () => true } })
    await s.host.enable()
    const ipc = fakeIpc()
    s.host.registerIpc(ipc.ipcMain, ipc.guard)
    await ipc.call('chat:open', 'c1')
    const pending = ipc.call('chat:preview', { id: 'c1', url: 'https://a.example/' })
    const changes = ipc.call('chat:changes', 'c1')
    s.workers[0].crash(1)
    expect(await pending).toEqual({ ok: false, again: true })
    expect(await changes).toEqual({ ok: false })
    await vi.advanceTimersByTimeAsync(1100)
    expect(s.workers).toHaveLength(2)
    s.workers[1].crash(1)
    await vi.advanceTimersByTimeAsync(1100)
    expect(s.workers).toHaveLength(3)
    s.workers[2].crash(1)
    await vi.advanceTimersByTimeAsync(5000)
    expect(s.workers).toHaveLength(3)
  })
})

describe('Claude Code updated past the verified range mid-run', () => {
  it('ok → new: the running worker is told the new version (the open views\' note), once; back to ok, told again', async () => {
    let v: string | null = '2.1.325 (Claude Code)'
    let stamp = 'u|1|1'
    const s = setup({ version: async () => v, extra: { binaryStamp: () => stamp } })
    await s.host.enable()
    const step = async (version: string, n: number) => { v = version; stamp = `u|${n}|1`; s.host.noteCreate(); await new Promise(r => setTimeout(r, 0)); await s.host.ready() }
    await step('2.3.0 (Claude Code)', 2)
    expect(s.workers).toHaveLength(1)
    expect(s.workers[0].posted.filter((m: any) => m.t === 'version')).toEqual([{ t: 'version', version: '2.3.0 (Claude Code)' }])
    await step('2.1.330 (Claude Code)', 3)
    expect(s.workers[0].posted.filter((m: any) => m.t === 'version').map((m: any) => m.version)).toEqual(['2.3.0 (Claude Code)', '2.1.330 (Claude Code)'])
  })
})
