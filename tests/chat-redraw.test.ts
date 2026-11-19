/**
 * The hidden terminal's size, main's half: one redraw nudge for a terminal whose
 * chat is shown and whose xterm replayed before it fitted. `terminals.redrawForChat` resizes the pty
 * one row and, 150 ms later, back; it writes nothing. `chatHost.redraw` refuses unless the chat is
 * on, the terminal is a running armed Claude Code, its chat is the shown view of a visible window
 * (the page that said so), no send is in flight, no answer card is open, and no nudge happened in
 * the last 10 s. A fake pty, fake timers, a fake worker and endpoint around the host's real holds.
 */

import { EventEmitter } from 'node:events'
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'

const require = createRequire(import.meta.url)
const { createTerminalManager } = require('../electron/terminals.cjs')
const { createChatHost } = require('../electron/chatHost.cjs')
const { chatHookEntries } = require('../electron/chatHooks.cjs')

const REPO = fileURLToPath(new URL('..', import.meta.url))
const dirs: string[] = []
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }) })
afterEach(() => { vi.useRealTimers() })
const tempDir = () => { const d = mkdtempSync(join(tmpdir(), 'spawn-redraw-')); dirs.push(d); return d }

const CHAT = (id: string) => chatHookEntries({ port: 51234, token: 'ab'.repeat(24), id })

/** A stand-in for node-pty that records every resize and every write */
function fakePty() {
  let next = 100
  const log: string[] = []
  const procs = new Map<number, { onExit?: (e: { exitCode: number }) => void }>()
  return {
    log,
    exit(pid: number) { procs.get(pid)?.onExit?.({ exitCode: 0 }) },
    spawn() {
      const pid = next++
      const p: { onExit?: (e: { exitCode: number }) => void } = {}
      procs.set(pid, p)
      return {
        pid,
        onData() {},
        onExit(cb: (e: { exitCode: number }) => void) { p.onExit = cb },
        kill() {},
        write(d: string) { log.push(`write ${JSON.stringify(d)}`) },
        resize(c: number, r: number) { log.push(`resize ${c}x${r}`) },
      }
    },
  }
}

function manager(state: () => any = () => ({ on: true, hooks: CHAT })) {
  const pty = fakePty()
  const userDataDir = tempDir()
  const terms = createTerminalManager({ repoRoot: REPO, userDataDir, defaultCwd: userDataDir, send: () => {}, pty, killTree: () => {}, chat: { state } })
  return { pty, terms }
}

describe('terminals.redrawForChat: one row less, then back after 150 ms; never a write', () => {
  it('exactly (c, r−1) then (c, r) 150 ms later; the manager follows each step', async () => {
    vi.useFakeTimers()
    const { pty, terms } = manager()
    const t = terms.create({})
    terms.resize(t.id, 120, 40)
    pty.log.length = 0
    expect(terms.redrawForChat(t.id)).toBe(true)
    expect(pty.log).toEqual(['resize 120x39'])
    await vi.advanceTimersByTimeAsync(149)
    expect(pty.log).toEqual(['resize 120x39'])
    await vi.advanceTimersByTimeAsync(1)
    expect(pty.log).toEqual(['resize 120x39', 'resize 120x40'])
    // the manager's size is the real one again: the same size from the page is not passed on
    terms.resize(t.id, 120, 40)
    expect(pty.log).toEqual(['resize 120x39', 'resize 120x40'])
    expect(pty.log.some(l => l.startsWith('write'))).toBe(false)
  })

  it('a real resize in between skips the restore (also one to the nudged size itself)', async () => {
    vi.useFakeTimers()
    const { pty, terms } = manager()
    const t = terms.create({})
    terms.resize(t.id, 120, 40)
    pty.log.length = 0
    terms.redrawForChat(t.id)
    terms.resize(t.id, 130, 42)
    await vi.advanceTimersByTimeAsync(500)
    expect(pty.log).toEqual(['resize 120x39', 'resize 130x42'])

    pty.log.length = 0
    terms.redrawForChat(t.id)
    terms.resize(t.id, 130, 41) // the page fitted to exactly the nudged size: kept, not undone
    await vi.advanceTimersByTimeAsync(500)
    expect(pty.log).toEqual(['resize 130x41'])
  })

  it('rows 5: (c, 6) then (c, 5)', async () => {
    vi.useFakeTimers()
    const { pty, terms } = manager()
    const t = terms.create({})
    terms.resize(t.id, 80, 5)
    pty.log.length = 0
    expect(terms.redrawForChat(t.id)).toBe(true)
    await vi.advanceTimersByTimeAsync(150)
    expect(pty.log).toEqual(['resize 80x6', 'resize 80x5'])
  })

  it('a shell, an unarmed Claude Code, an exited one, one with no known size, the chat off: no call', async () => {
    vi.useFakeTimers()
    const { pty, terms } = manager()
    const shell = terms.create({ tool: 'shell' })
    terms.resize(shell.id, 100, 30)
    const unsized = terms.create({})
    const exited = terms.create({})
    terms.resize(exited.id, 100, 30)
    pty.exit(102)
    const unarmed = manager(() => ({ on: true, hooks: null, reason: 'version' }))
    const u = unarmed.terms.create({})
    unarmed.terms.resize(u.id, 100, 30)
    pty.log.length = 0
    unarmed.pty.log.length = 0
    expect(terms.redrawForChat(shell.id)).toBe(false)
    expect(terms.redrawForChat(unsized.id)).toBe(false)
    expect(terms.list().find((x: any) => x.id === exited.id).status).toBe('exited')
    expect(terms.redrawForChat(exited.id)).toBe(false)
    expect(terms.redrawForChat('nope')).toBe(false)
    expect(unarmed.terms.redrawForChat(u.id)).toBe(false)
    // armed, then the chat turned off: nothing
    let on = true
    const off = manager(() => (on ? { on: true, hooks: CHAT } : { on: false }))
    const o = off.terms.create({})
    off.terms.resize(o.id, 100, 30)
    off.pty.log.length = 0
    on = false
    expect(off.terms.redrawForChat(o.id)).toBe(false)
    await vi.advanceTimersByTimeAsync(500)
    expect([...pty.log, ...unarmed.pty.log, ...off.pty.log]).toEqual([])
  })

  it('the session ends during the 150 ms: no restore', async () => {
    vi.useFakeTimers()
    const { pty, terms } = manager()
    const t = terms.create({})
    terms.resize(t.id, 100, 30)
    pty.log.length = 0
    terms.redrawForChat(t.id)
    pty.exit(100)
    await vi.advanceTimersByTimeAsync(500)
    expect(pty.log).toEqual(['resize 100x29'])
  })
})

// ---- chatHost.redraw ------------------------------------------------------------------------------

class FakeWorker extends EventEmitter {
  posted: any[] = []
  postMessage(m: any) { this.posted.push(m) }
  terminate() { queueMicrotask(() => this.emit('exit', 1)); return Promise.resolve(1) }
  send(m: any) { this.emit('message', m) }
}

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const S = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'

async function hostSetup(canNudge: () => boolean = () => true) {
  const list: any[] = [
    { id: A, tool: 'claude', status: 'running', chat: 'armed', createdAt: 1 },
    { id: B, tool: 'claude', status: 'running', chat: 'armed', createdAt: 2 },
    { id: S, tool: 'shell', status: 'running', createdAt: 3 },
  ]
  const nudged: string[] = []
  const typed: any[] = []
  const endpoints: any[] = []
  const host = createChatHost({
    terminals: {
      list: () => list.map(t => ({ ...t })), refreshSettings: () => {}, armedCount: () => 2,
      typeForChat: (id: string, data: string) => { typed.push({ id, data }); return true }, clearAsking: () => {},
      redrawForChat: (id: string) => { if (!canNudge()) return false; nudged.push(id); return true },
    },
    send: () => {}, userDataDir: 'C:\\Users\\user\\AppData\\Roaming\\spawn',
    claudeVersion: async () => '2.1.325 (Claude Code)',
    makeWorker: () => new FakeWorker(),
    makeEndpoint: (o: any) => { const e = { opts: o, listen: async () => ({ port: 4321, token: 'ab'.repeat(24) }), setDraining: () => {}, close: async () => {} }; endpoints.push(e); return e },
    log: () => {},
  })
  await host.enable()
  vi.useFakeTimers()
  const ipc = new Map<string, (...a: any[]) => any>()
  host.registerIpc({ handle: (n: string, f: any) => ipc.set(n, f), on: (n: string, f: any) => ipc.set(n, f) }, (fn: any) => (e: any, arg: any) => fn(arg, e))
  /** an IPC call from the page whose webContents id is `page` */
  const call = (n: string, arg: any, page = 7) => ipc.get(n)!({ sender: { id: page } }, arg)
  return { host, list, nudged, typed, call, endpoints, ipc }
}

describe('chatHost.redraw: the checks, in order', () => {
  it('the shown chat of a visible window, nothing in flight: one nudge; again within 10 s: recent; after 10 s: another', async () => {
    const s = await hostSetup()
    s.call('chat:visible', { id: A })
    expect(await s.call('chat:redraw', A)).toEqual({ ok: true })
    expect(s.nudged).toEqual([A])
    expect(await s.call('chat:redraw', A)).toEqual({ ok: false, reason: 'recent' })
    await vi.advanceTimersByTimeAsync(9_999)
    expect(await s.call('chat:redraw', A)).toEqual({ ok: false, reason: 'recent' })
    await vi.advanceTimersByTimeAsync(1)
    expect(await s.call('chat:redraw', A)).toEqual({ ok: true })
    expect(s.nudged).toEqual([A, A])
    expect(s.typed).toEqual([])
  })

  it('not-shown: another id shown, none shown, the window hidden, or asked by a page other than the one that showed it', async () => {
    const s = await hostSetup()
    expect(await s.call('chat:redraw', A)).toEqual({ ok: false, reason: 'not-shown' })
    s.call('chat:visible', { id: B })
    expect(await s.call('chat:redraw', A)).toEqual({ ok: false, reason: 'not-shown' })
    s.call('chat:visible', { id: A })
    expect(await s.call('chat:redraw', A, 8)).toEqual({ ok: false, reason: 'not-shown' })
    s.host.setWindowVisible(false)
    expect(await s.call('chat:redraw', A)).toEqual({ ok: false, reason: 'not-shown' })
    s.host.setWindowVisible(true)
    s.host.pageGone(7)
    expect(await s.call('chat:redraw', A)).toEqual({ ok: false, reason: 'not-shown' })
    expect(s.nudged).toEqual([])
  })

  it('sending: a chat send in flight for it (between its text and its Enter)', async () => {
    const s = await hostSetup()
    s.call('chat:visible', { id: A })
    const r = await s.host.send({ id: A, sendId: 'send-0001', text: 'hello', images: [], screen: 'empty' })
    expect(r.ok).toBe(true)
    expect(await s.call('chat:redraw', A)).toEqual({ ok: false, reason: 'sending' })
    await vi.advanceTimersByTimeAsync(160)
    expect(await s.host.submit({ id: A, sendId: 'send-0001', echo: 'ok' })).toEqual({ ok: true })
    expect(await s.call('chat:redraw', A)).toEqual({ ok: true })
    expect(s.nudged).toEqual([A])
  })

  it('waiting: an answer card is open for it (a held permission)', async () => {
    const s = await hostSetup()
    s.call('chat:visible', { id: A })
    const registry = s.endpoints[0].opts.holds()
    const got: (string | null)[] = []
    const holdId = registry.open('permission', (b: string | null) => got.push(b), { id: A })
    expect(holdId).toBeTruthy()
    expect(await s.call('chat:redraw', A)).toEqual({ ok: false, reason: 'waiting' })
    // another session's card does not hold this one back
    s.call('chat:visible', { id: B })
    expect(await s.call('chat:redraw', B)).toEqual({ ok: true })
    registry.release(holdId, 'settled')
    s.call('chat:visible', { id: A })
    expect(await s.call('chat:redraw', A)).toEqual({ ok: true })
    expect(s.nudged).toEqual([B, A])
  })

  it('off, no-session, unarmed', async () => {
    const s = await hostSetup()
    s.call('chat:visible', { id: A })
    expect(await s.call('chat:redraw', 'nope')).toEqual({ ok: false, reason: 'no-session' })
    expect(await s.call('chat:redraw', S)).toEqual({ ok: false, reason: 'unarmed' })
    s.list[1].chat = 'unarmed'
    expect(await s.call('chat:redraw', B)).toEqual({ ok: false, reason: 'unarmed' })
    s.list[0].status = 'exited'
    expect(await s.call('chat:redraw', A)).toEqual({ ok: false, reason: 'no-session' })
    s.list[0].status = 'running'
    s.host.disable()
    expect(await s.call('chat:redraw', A)).toEqual({ ok: false, reason: 'off' })
    expect(s.nudged).toEqual([])
  })

  it('the manager could not nudge (no size yet): no-session, and no 10 s wait recorded', async () => {
    let ok = false
    const s = await hostSetup(() => ok)
    s.call('chat:visible', { id: A })
    expect(await s.call('chat:redraw', A)).toEqual({ ok: false, reason: 'no-session' })
    ok = true
    expect(await s.call('chat:redraw', A)).toEqual({ ok: true })
    expect(s.nudged).toEqual([A])
  })
})

describe('the final review M1: no chat send for 1 s after a nudge (refused as screen, never queued or retried)', () => {
  it('a send 0–999 ms after the nudge: refused `screen`, nothing typed; at 1000 ms: sent; another terminal: never held back', async () => {
    const s = await hostSetup()
    s.call('chat:visible', { id: A })
    expect(await s.call('chat:redraw', A)).toEqual({ ok: true })
    expect(await s.host.send({ id: A, sendId: 'send-m1-0001', text: 'hello', images: [], screen: 'empty' })).toEqual({ ok: false, reason: 'screen' })
    await vi.advanceTimersByTimeAsync(999)
    expect(await s.host.send({ id: A, sendId: 'send-m1-0002', text: 'hello', images: [], screen: 'empty' })).toEqual({ ok: false, reason: 'screen' })
    // another session was not nudged: it sends
    expect((await s.host.send({ id: B, sendId: 'send-m1-0003', text: 'hi', images: [], screen: 'empty' })).ok).toBe(true)
    expect(s.typed.filter(t => t.id === A)).toEqual([])
    // nothing was queued: time passing types nothing of the refused sends
    await vi.advanceTimersByTimeAsync(1)
    expect(s.typed.filter(t => t.id === A)).toEqual([])
    // a new send (the user's own Enter, a new id) at 1000 ms goes
    expect((await s.host.send({ id: A, sendId: 'send-m1-0004', text: 'hello', images: [], screen: 'empty' })).ok).toBe(true)
    expect(s.typed.filter(t => t.id === A).length).toBeGreaterThan(0)
  })

  it('the page says `screen` as "확인하지 못했어요" (an existing reason: the draft stays, the user tries again)', () => {
    const composer = read('src', 'components', 'chat', 'Composer.tsx')
    expect(composer).toMatch(/\/\/ screen, off, unarmed, not-claude, no-echo: the terminal's state is not certain\s*\n\s*default: return \{ key: '터미널이 지금 입력을 받을 수 있는지 확인하지 못했어요', terminal: true \}/)
  })
})

// ---- source guards ---------------------------------------------------------------------------------

const read = (...p: string[]) => readFileSync(join(REPO, ...p), 'utf8')
/** The body of `function name(` in a source file, up to the next line that closes at its indentation */
function bodyOf(src: string, name: string): string {
  const at = src.indexOf(`function ${name}(`)
  if (at < 0) return ''
  const lineStart = src.lastIndexOf('\n', at) + 1
  const indent = src.slice(lineStart, at).match(/^\s*/)![0]
  const end = src.indexOf(`\n${indent}}`, at)
  return src.slice(at, end + indent.length + 2)
}

describe('source guards: the nudge only resizes, and only chatHost.redraw asks for it', () => {
  it('redrawForChat names pty.resize and no write', () => {
    const body = bodyOf(read('electron', 'terminals.cjs'), 'redrawForChat')
    expect(body).toContain('pty.resize(')
    expect(body).not.toMatch(/write|typeForChat|sendInstruction/)
  })

  it('redrawForChat is called only from chatHost.cjs redraw (main.cjs only passes it on, inside the host\'s terminals)', () => {
    const files = [
      ...readdirSync(join(REPO, 'electron')).filter(f => /\.c?js$/.test(f)).map(f => ['electron', f]),
      ...readdirSync(join(REPO, 'src'), { recursive: true } as any).map(String).filter(f => /\.tsx?$/.test(f)).map(f => ['src', f]),
    ]
    const users: string[] = []
    for (const f of files) if (read(...f).includes('redrawForChat')) users.push(f.join('/').replace(/\\/g, '/'))
    expect(users.sort()).toEqual(['electron/chatHost.cjs', 'electron/main.cjs', 'electron/terminals.cjs'])
    const host = read('electron', 'chatHost.cjs')
    const calls = [...host.matchAll(/terminals\.redrawForChat\(/g)].map(m => m.index!)
    const redraw = bodyOf(host, 'redraw')
    const at = host.indexOf(redraw)
    expect(calls.length).toBeGreaterThan(0)
    for (const c of calls) expect(c >= at && c < at + redraw.length, 'a redrawForChat call outside redraw').toBe(true)
    // main.cjs: one line, inside `if (CHAT_VIEW) chatHost = …createChatHost({ terminals: { … } })`
    const main = read('electron', 'main.cjs')
    expect(main.match(/redrawForChat/g)).toHaveLength(2)
    const line = main.split('\n').find(l => l.includes('redrawForChat'))!
    expect(line.trim()).toMatch(/^redrawForChat: \(id\) => terminals\?\.redrawForChat\(id\) \?\? false,?/)
    const hostAt = main.indexOf("if (CHAT_VIEW) chatHost = require('./chatHost.cjs').createChatHost({")
    const hostEnd = main.indexOf('\n  })', hostAt)
    expect(hostAt).toBeGreaterThan(0)
    expect(main.indexOf(line) > hostAt && main.indexOf(line) < hostEnd).toBe(true)
    // terminals.cjs defines and returns it, and never calls it itself
    const terms = read('electron', 'terminals.cjs')
    expect([...terms.matchAll(/redrawForChat\(/g)]).toHaveLength(1)
  })

  it('chat:redraw is registered in registerIpc only; the preload passes the id only', () => {
    const host = read('electron', 'chatHost.cjs')
    const reg = bodyOf(host, 'registerIpc')
    expect(reg).toContain("'chat:redraw'")
    expect(host.split("'chat:redraw'").length - 1).toBe(1)
    expect(read('electron', 'main.cjs')).not.toContain('chat:redraw')
    const preload = read('electron', 'preload.cjs')
    expect(preload).toMatch(/redraw: \(id\) => ipcRenderer\.invoke\('chat:redraw', String\(id\)\)/)
  })

  it('the send and answer rules are not where the nudge lives', () => {
    const host = read('electron', 'chatHost.cjs')
    for (const fn of ['submit', 'interrupt', 'answer']) expect(bodyOf(host, fn), fn).not.toContain('redraw')
    // send: only the refusal (no send for 1 s after a nudge), which reads the time and refuses; the
    // nudge itself is never asked for from a send
    const send = bodyOf(host, 'send')
    expect(send.split('\n').filter(l => /redraw/i.test(l)).map(l => l.trim())).toEqual([
      'const nudged = redrawAt.get(id)',
      "if (nudged !== undefined && now() - nudged < REDRAW_SETTLE_MS) return { ok: false, reason: 'screen' }",
    ])
    expect(bodyOf(host, 'redraw')).not.toMatch(/typeForChat|\.write\(/)
  })
})
