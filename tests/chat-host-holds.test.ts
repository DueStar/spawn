/**
 * electron/chatHost.cjs with holds: the registry wired to the reader and the
 * page. A question is answered only while its chat is the visible view; any real key in that
 * session's terminal hands everything back to it; off, a worker that exits, quitting and a version
 * out of the verified range all answer "no decision". A fake worker, a fake endpoint around the
 * host's real registry, fake timers.
 */

import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const require = createRequire(import.meta.url)
const { createChatHost } = require('../electron/chatHost.cjs')
const { chatHookEntries } = require('../electron/chatHooks.cjs')

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const TERMS = [
  { id: A, tool: 'claude', status: 'running', chat: 'armed', createdAt: 100 },
  { id: B, tool: 'claude', status: 'running', chat: 'armed', createdAt: 200 },
]

class FakeWorker extends EventEmitter {
  posted: any[] = []
  postMessage(m: any) { this.posted.push(m) }
  terminate() { queueMicrotask(() => this.emit('exit', 1)); return Promise.resolve(1) }
  send(m: any) { this.emit('message', m) }
}

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { vi.useRealTimers() })

async function setup(version = '2.1.325 (Claude Code)') {
  const workers: FakeWorker[] = []
  const endpoints: any[] = []
  let list = [...TERMS]
  const clearAsking = vi.fn()
  const typed: any[] = []
  const host = createChatHost({
    terminals: {
      list: () => list, refreshSettings: () => {}, armedCount: () => list.length,
      typeForChat: (id: string, data: string) => { typed.push({ id, data }); return true }, clearAsking,
    },
    send: () => {},
    userDataDir: 'C:\\Users\\user\\AppData\\Roaming\\spawn',
    claudeVersion: async () => version,
    makeWorker: () => { const w = new FakeWorker(); workers.push(w); return w },
    makeEndpoint: (opts: any) => {
      const e = { opts, draining: false, listen: async () => ({ port: 4321, token: 'ab'.repeat(24) }), setDraining: (on: boolean) => { e.draining = on }, close: vi.fn(async () => {}) }
      endpoints.push(e)
      return e
    },
    log: () => {},
  })
  await host.enable()
  const worker = () => workers.at(-1)!
  /** A held request as the endpoint opens it: its responses, its hold id (null: not held) */
  const request = (kind: 'permission' | 'question', id: string) => {
    const got: (string | null)[] = []
    const registry = endpoints[0].opts.holds?.() ?? null
    const holdId = registry ? registry.open(kind, (b: string | null) => got.push(b), { id }) : null
    if (holdId) endpoints[0].opts.onHook(kind === 'question' ? 'PreToolUse' : 'PermissionRequest', new Uint8Array([123, 125]), Date.now(), id, holdId)
    return { got, holdId }
  }
  const bind = (holdId: string, id: string, kind: 'permission' | 'question') => worker().send({ t: 'hold-bind', holdId, id, kind, key: 'k', data: kind === 'question' ? { questions: [{ question: 'Q?', options: [{ label: 'Yes' }, { label: 'No' }] }], labels: ['Yes', 'No'] } : { rules: [{ toolName: 'Bash', ruleContent: 'ls' }] } })
  const ipc = new Map<string, (...a: any[]) => any>()
  host.registerIpc({ handle: (n: string, f: any) => ipc.set(n, f), on: (n: string, f: any) => ipc.set(n, f) }, (fn: any) => (_e: any, arg: any) => fn(arg))
  const call = (n: string, arg?: any) => ipc.get(n)!({}, arg)
  return { host, worker, workers, endpoints, request, bind, call, clearAsking, typed, setList: (l: any[]) => { list = l } }
}

describe('questions: only while their chat is the visible view', () => {
  it('bound while visible: open; the view goes (chat:visible null): released at once', async () => {
    const s = await setup()
    s.call('chat:visible', { id: A })
    const q = s.request('question', A)
    s.bind(q.holdId!, A, 'question')
    expect(q.got).toEqual([])
    s.call('chat:visible', { id: null })
    expect(q.got).toEqual([null])
  })

  it('bound while another view is shown, or none: released at once', async () => {
    const s = await setup()
    s.call('chat:visible', { id: B })
    const q = s.request('question', A)
    s.bind(q.holdId!, A, 'question')
    expect(q.got).toEqual([null])
  })

  it('the window minimised: questions released, permissions kept', async () => {
    const s = await setup()
    s.call('chat:visible', { id: A })
    const q = s.request('question', A)
    const p = s.request('permission', A)
    s.bind(q.holdId!, A, 'question')
    s.bind(p.holdId!, A, 'permission')
    s.host.setWindowVisible(false)
    expect(q.got).toEqual([null])
    expect(p.got).toEqual([])
    expect(s.call('chat:answer', { id: A, holdId: p.holdId, choice: 'allow' })).toEqual({ ok: false, reason: 'hidden' })
    s.host.setWindowVisible(true)
    expect(s.call('chat:answer', { id: A, holdId: p.holdId, choice: 'allow' })).toEqual({ ok: true })
    expect(JSON.parse(p.got[0]!).hookSpecificOutput.decision.behavior).toBe('allow')
  })
})

describe('the terminal answers first', () => {
  it('a real key in that terminal releases its holds; another terminal\'s are kept; a terminal report is not a key', async () => {
    const s = await setup()
    const a = s.request('permission', A)
    const b = s.request('permission', B)
    s.bind(a.holdId!, A, 'permission')
    s.bind(b.holdId!, B, 'permission')
    s.host.onInput(A, '\x1b[I', 'keyboard')
    expect(a.got).toEqual([])
    s.host.onInput(A, '1', 'keyboard', undefined, true)
    expect(a.got).toEqual([null])
    expect(b.got).toEqual([])
    // the side box typing into B: that is input too
    s.host.onInput(B, null, 'side', 'typed')
    expect(b.got).toEqual([null])
  })
})

describe('chat:answer', () => {
  it('a question\'s own words (직접 입력, 2026-11-19) reach the registry: the answer is those words', async () => {
    const s = await setup()
    s.call('chat:visible', { id: A })
    const q = s.request('question', A)
    s.bind(q.holdId!, A, 'question')
    expect(s.call('chat:answer', { id: A, holdId: q.holdId, choice: 'options', picks: [[]], other: [42] })).toEqual({ ok: false, reason: 'invalid' })
    expect(s.call('chat:answer', { id: A, holdId: q.holdId, choice: 'options', picks: [[]], other: ['Maybe later'] })).toEqual({ ok: true })
    expect(JSON.parse(q.got[0]!).hookSpecificOutput.updatedInput.answers).toEqual({ 'Q?': 'Maybe later' })
  })

  it('for a terminal that is not the visible one: hidden, nothing sent; accepted: clearAsking once', async () => {
    const s = await setup()
    const p = s.request('permission', A)
    s.bind(p.holdId!, A, 'permission')
    s.call('chat:visible', { id: B })
    expect(s.call('chat:answer', { id: A, holdId: p.holdId, choice: 'deny' })).toEqual({ ok: false, reason: 'hidden' })
    expect(p.got).toEqual([])
    expect(s.clearAsking).not.toHaveBeenCalled()
    s.call('chat:visible', { id: A })
    expect(s.call('chat:answer', { id: B, holdId: p.holdId, choice: 'deny' })).toEqual({ ok: false, reason: 'other-session' })
    expect(s.call('chat:answer', { id: A, holdId: p.holdId, choice: 'always' })).toEqual({ ok: true })
    expect(s.clearAsking).toHaveBeenCalledTimes(1)
    expect(s.clearAsking).toHaveBeenCalledWith(A)
    expect(JSON.parse(p.got[0]!).hookSpecificOutput.decision.updatedPermissions[0].destination).toBe('session')
    expect(s.call('chat:answer', { id: A, holdId: p.holdId, choice: 'allow' })).toEqual({ ok: false, reason: 'gone' })
    expect(p.got).toHaveLength(1)
  })

  it('the worker hears every hold that ended: sent, timeout, terminal', async () => {
    const s = await setup()
    s.call('chat:visible', { id: A })
    const p1 = s.request('permission', A)
    const p2 = s.request('permission', A)
    const p3 = s.request('permission', A)
    for (const p of [p1, p2, p3]) s.bind(p.holdId!, A, 'permission')
    s.call('chat:answer', { id: A, holdId: p1.holdId, choice: 'allow' })
    s.host.onInput(A, 'x', 'keyboard')
    const p4 = s.request('permission', B)
    s.bind(p4.holdId!, B, 'permission')
    vi.advanceTimersByTime(300_000)
    const states = s.worker().posted.filter(m => m.t === 'hold-state')
    expect(states).toEqual([
      { t: 'hold-state', holdId: p1.holdId, state: 'sent', choice: 'allow' },
      { t: 'hold-state', holdId: p2.holdId, state: 'terminal' },
      { t: 'hold-state', holdId: p3.holdId, state: 'terminal' },
      { t: 'hold-state', holdId: p4.holdId, state: 'timeout' },
    ])
  })

  it('the reader passes or settles a hold: released', async () => {
    const s = await setup()
    const p = s.request('permission', A)
    s.worker().send({ t: 'hold-pass', holdId: p.holdId, why: 'plan' })
    expect(p.got).toEqual([null])
    const q = s.request('permission', A)
    s.bind(q.holdId!, A, 'permission')
    s.worker().send({ t: 'hold-resolved', holdIds: [q.holdId, 'nobody'], why: 'post' })
    expect(q.got).toEqual([null])
  })

  it('the hold goes to the worker with its terminal', async () => {
    const s = await setup()
    const p = s.request('permission', A)
    expect(s.worker().posted.find(m => m.t === 'hook')).toMatchObject({ event: 'PermissionRequest', id: A, hold: p.holdId })
  })
})

describe('everything else hands back to the terminal, once', () => {
  it('off', async () => {
    const s = await setup()
    const p = s.request('permission', A)
    s.bind(p.holdId!, A, 'permission')
    s.host.disable()
    expect(p.got).toEqual([null])
    expect(s.endpoints[0].opts.holds()).toBeNull()
  })

  it('the worker exits', async () => {
    const s = await setup()
    const p = s.request('permission', A)
    const q = s.request('permission', A)
    s.bind(p.holdId!, A, 'permission')
    s.worker().emit('exit', 1)
    expect(p.got).toEqual([null])
    expect(q.got).toEqual([null])
  })

  it('quitting: answered before the endpoint closes', async () => {
    const s = await setup()
    const p = s.request('permission', A)
    s.bind(p.holdId!, A, 'permission')
    const closed = s.endpoints[0].close
    closed.mockImplementation(async () => { expect(p.got).toEqual([null]) })
    await s.host.close()
    expect(closed).toHaveBeenCalled()
    expect(p.got).toEqual([null])
  })

  it('a terminal that ended or left the list', async () => {
    const s = await setup()
    const p = s.request('permission', A)
    s.bind(p.holdId!, A, 'permission')
    s.setList([TERMS[1]])
    s.host.onTerminals([TERMS[1]])
    expect(p.got).toEqual([null])
  })
})

describe('the composer while a card is open', () => {
  it('send and 멈추기 are refused as waiting', async () => {
    const s = await setup()
    const p = s.request('permission', A)
    s.bind(p.holdId!, A, 'permission')
    expect(await s.host.send({ id: A, sendId: 'send-0001', text: 'hi', images: [], screen: 'empty' })).toEqual({ ok: false, reason: 'waiting' })
    expect(s.host.interrupt(A)).toEqual({ ok: false, reason: 'waiting' })
    expect(s.typed).toEqual([])
  })
})

describe('only for the verified range', () => {
  it('a newer Claude Code: no holds; the passive entries (no matcher, PermissionRequest at 5 s)', async () => {
    const s = await setup('2.3.0 (Claude Code)')
    expect(s.endpoints[0].opts.holds()).toBeNull()
    const st = s.host.state()
    expect(st.hooks(A)).toEqual(chatHookEntries({ port: 4321, token: 'ab'.repeat(24), id: A }))
    expect(st.hooks(A).PermissionRequest.hooks[0].timeout).toBe(5)
    expect(JSON.stringify(st.hooks(A))).not.toContain('matcher')
    expect(s.request('permission', A).holdId).toBeNull()
  })

  it('the verified range: the holds\' entries', async () => {
    const s = await setup()
    expect(s.host.state().hooks(A)).toEqual(chatHookEntries({ port: 4321, token: 'ab'.repeat(24), id: A, holds: true }))
  })
})

describe('review I3: the shown chat belongs to the page that said so', () => {
  /** the IPC as main wires it: the guard passes the sender's event */
  const fromPage = (s: any) => {
    const ipc = new Map<string, (...a: any[]) => any>()
    s.host.registerIpc({ handle: (n: string, f: any) => ipc.set(n, f), on: (n: string, f: any) => ipc.set(n, f) }, (fn: any) => (e: any, arg: any) => fn(arg, e))
    return (page: number, n: string, arg?: any) => ipc.get(n)!({ sender: { id: page } }, arg)
  }

  it('the widget ↔ window swap: the new page shows the chat, the old page closing does not clear it', async () => {
    const s = await setup()
    const page = fromPage(s)
    const p = s.request('permission', A)
    s.bind(p.holdId!, A, 'permission')
    // the window (page 7) showed the chat; the swap builds page 8, which says so too; then page 7 goes
    page(7, 'chat:visible', { id: A })
    page(8, 'chat:visible', { id: A })
    s.host.pageGone(7)
    // (the old page's last word, had it unmounted in time, changes nothing either)
    page(7, 'chat:visible', { id: null })
    const q = s.request('question', A)
    s.bind(q.holdId!, A, 'question')
    expect(q.got).toEqual([])
    expect(page(8, 'chat:answer', { id: A, holdId: p.holdId, choice: 'allow' })).toEqual({ ok: true })
  })

  it('the page that shows the chat going (closed, reloading): none shown, its question goes back', async () => {
    const s = await setup()
    const page = fromPage(s)
    page(8, 'chat:visible', { id: A })
    const q = s.request('question', A)
    s.bind(q.holdId!, A, 'question')
    expect(q.got).toEqual([])
    s.host.pageGone(8)
    expect(q.got).toEqual([null])
  })

  // (split view: two panes, each a chat on screen. Each says so; one saying so never hides the other)
  it('two chats on screen side by side: a question of either stays for the chat, and goes back only when its own goes', async () => {
    const s = await setup()
    const page = fromPage(s)
    page(8, 'chat:visible', { id: A })
    page(8, 'chat:visible', { id: B })
    const q = s.request('question', A)
    s.bind(q.holdId!, A, 'question')
    expect(q.got).toEqual([])
    // B's pane closes: A's question stays
    page(8, 'chat:visible', { id: B, on: false })
    expect(q.got).toEqual([])
    // A's own pane goes: its question goes back to the terminal
    page(8, 'chat:visible', { id: A, on: false })
    expect(q.got).toEqual([null])
  })

  it('two chats on screen: either is answered from its own pane', async () => {
    const s = await setup()
    const page = fromPage(s)
    const p = s.request('permission', A)
    s.bind(p.holdId!, A, 'permission')
    page(8, 'chat:visible', { id: A })
    page(8, 'chat:visible', { id: B })
    expect(page(8, 'chat:answer', { id: A, holdId: p.holdId, choice: 'allow' })).toEqual({ ok: true })
  })

  it('another page cannot answer for the chat a page shows', async () => {
    const s = await setup()
    const page = fromPage(s)
    const p = s.request('permission', A)
    s.bind(p.holdId!, A, 'permission')
    page(8, 'chat:visible', { id: A })
    expect(page(9, 'chat:answer', { id: A, holdId: p.holdId, choice: 'allow' })).toEqual({ ok: false, reason: 'hidden' })
    expect(p.got).toEqual([])
  })

  it('main.cjs: a window speaks for the window only while it is the app window; a page going clears only its own', () => {
    const main = readFileSync(join(__dirname, '..', 'electron', 'main.cjs'), 'utf8')
    expect(main).toMatch(/if \(win !== widgetWin\) return; if \(chatHost\) chatHost\.setWindowVisible/)
    expect(main).toMatch(/chatHost\.pageGone\(page\)/)
    expect(main).not.toMatch(/chatHost\.visible\(\{ id: null \}\)/)
  })
})

describe('main.cjs', () => {
  it('tells the host the window\'s visibility only inside the chat guard; the hold-time override only unpackaged', () => {
    const main = readFileSync(join(__dirname, '..', 'electron', 'main.cjs'), 'utf8')
    const calls = [...main.matchAll(/setWindowVisible\(/g)]
    expect(calls.length).toBeGreaterThan(0)
    for (const m of calls) {
      const before = main.slice(Math.max(0, m.index! - 400), m.index!)
      expect(before, 'setWindowVisible outside the guard').toMatch(/if \(chatHost\)/)
    }
    const at = main.indexOf('process.env.SPAWN_CHAT_HOLD_S')
    expect(at).toBeGreaterThan(0)
    expect(main.slice(main.lastIndexOf('\n', at), at)).toMatch(/!app\.isPackaged &&/)
    expect(main.match(/process\.env\.SPAWN_CHAT_HOLD_S/g)?.length).toBe(2)
  })
})
