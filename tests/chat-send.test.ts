/**
 * electron/chatHost.cjs — the composer's send path in main: `send` types the text without
 * Enter, `submit` presses Enter once and only after the page saw the echo, `interrupt` is one
 * Esc. A send id is accepted once; nothing is typed into a terminal whose state is unknown
 * (a dialog, text on the prompt row the app did not type, not armed, exited); nothing is
 * retried. A fake terminal manager whose pty records every write with the (fake) clock.
 */

import { EventEmitter } from 'node:events'
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { afterEach, describe, expect, it, vi } from 'vitest'

const require = createRequire(import.meta.url)
const { createChatHost } = require('../electron/chatHost.cjs')

class FakeWorker extends EventEmitter {
  posted: any[] = []
  postMessage(m: any) { this.posted.push(m) }
  terminate() { queueMicrotask(() => this.emit('exit', 1)); return Promise.resolve(1) }
  send(m: any) { this.emit('message', m) }
}

const C1 = '11111111-1111-4111-8111-111111111111'
const C2 = '22222222-2222-4222-8222-222222222222'
type Term = { id: string; tool: string; status: string; chat?: string; asking?: boolean; createdAt: number }

async function setup(extraTerms: Term[] = [], opts: Record<string, unknown> = {}) {
  const terms: Term[] = [{ id: C1, tool: 'claude', status: 'running', chat: 'armed', asking: false, createdAt: 1 }, ...extraTerms]
  const pty: { id: string; data: string; at: number }[] = []
  const workers: FakeWorker[] = []
  const endpoints: any[] = []
  const terminals = {
    list: () => terms.map(t => ({ ...t })),
    refreshSettings: () => {},
    armedCount: () => terms.filter(t => t.chat === 'armed' && t.status !== 'exited').length,
    typeForChat: (id: string, data: string) => {
      const t = terms.find(x => x.id === id)
      if (!t || t.status === 'exited' || t.chat !== 'armed' || t.tool !== 'claude') return false
      pty.push({ id, data, at: Date.now() })
      return true
    },
    clearAsking: () => {},
  }
  const host = createChatHost({
    terminals, send: () => {}, userDataDir: 'C:\\Users\\user\\AppData\\Roaming\\spawn',
    claudeVersion: async () => '2.1.325 (Claude Code)',
    makeWorker: () => { const w = new FakeWorker(); workers.push(w); return w },
    makeEndpoint: (o: any) => {
      const e = { ...o, listen: async () => ({ port: 4321, token: 'ab'.repeat(24) }), setDraining: () => {}, close: async () => {} }
      endpoints.push(e)
      return e
    },
    ...opts,
  })
  await host.enable()
  vi.useFakeTimers()
  const t0 = Date.now()
  const status = (id: string, state: string) => workers[0].send({ t: 'update', update: { id, ops: [{ op: 'status', status: { state, since: null, label: null, banner: null, note: null, version: null, hasOlder: false, empty: false } }] } })
  const arrive = (event: string, id = C1) => endpoints[0].onArrive(event, id)
  const kb = (data: string, id = C1) => host.onInput(id, data, 'keyboard', undefined, false)
  let n = 0
  const sendId = () => `send-${String(++n).padStart(4, '0')}`
  return { host, terms, pty, workers, status, arrive, kb, sendId, t0, endpoints }
}

const wait = (ms: number) => vi.advanceTimersByTimeAsync(ms)
const until = async (cond: () => boolean, ms = 3000) => {
  const end = Date.now() + ms
  while (!cond()) { if (Date.now() > end) throw new Error('timed out'); await new Promise(r => setTimeout(r, 10)) }
}
afterEach(() => { vi.useRealTimers() })

describe('send and submit', () => {
  it('the happy path: the text as one bracketed paste, no Enter; Enter once, at least 150 ms after, on an accepted submit', async () => {
    const s = await setup()
    const id = s.sendId()
    const r = await s.host.send({ id: C1, sendId: id, text: 'hello', images: [], screen: 'empty' })
    expect(r).toEqual({ ok: true, expect: { head: 'hello', images: 0, long: false }, command: false, minEnterMs: 150 })
    expect(s.pty.map(w => w.data)).toEqual(['\x1b[200~hello\x1b[201~'])
    // (the page waits out minEnterMs and reads the screen again before it asks; main then writes at once)
    await wait(160)
    expect(await s.host.submit({ id: C1, sendId: id, echo: 'ok' })).toEqual({ ok: true })
    expect(s.pty.map(w => w.data)).toEqual(['\x1b[200~hello\x1b[201~', '\r'])
    expect(s.pty[1].at - s.pty[0].at).toBeGreaterThanOrEqual(150)
    // the same submit again: nothing
    expect(await s.host.submit({ id: C1, sendId: id, echo: 'ok' })).toEqual({ ok: false, reason: 'not-in-flight' })
    expect(s.pty.filter(w => w.data === '\r')).toHaveLength(1)
  })

  it('a send id is accepted once; one send at a time; not within 200 ms of a side-box send', async () => {
    const s = await setup()
    const id = s.sendId()
    expect((await s.host.send({ id: C1, sendId: id, text: 'a', images: [], screen: 'empty' })).ok).toBe(true)
    expect(await s.host.send({ id: C1, sendId: id, text: 'a', images: [], screen: 'empty' })).toEqual({ ok: false, reason: 'duplicate' })
    expect(await s.host.send({ id: C1, sendId: s.sendId(), text: 'b', images: [], screen: 'empty' })).toEqual({ ok: false, reason: 'sending' })
    expect(s.pty).toHaveLength(1)
    await wait(160); await s.host.submit({ id: C1, sendId: id, echo: 'ok' })
    s.host.onInput(C1, null, 'side', 'typed')
    expect(await s.host.send({ id: C1, sendId: s.sendId(), text: 'c', images: [], screen: 'empty' })).toEqual({ ok: false, reason: 'sending' })
    await wait(250)
    s.host.onInput(C1, null, 'side', 'enter')
    expect((await s.host.send({ id: C1, sendId: s.sendId(), text: 'c', images: [], screen: 'empty' })).ok).toBe(true)
  })

  it('an echo that is not right: no Enter, the row is dirty, and the next send over text is refused', async () => {
    for (const echo of ['mismatch', 'blocked', 'timeout']) {
      const s = await setup()
      const id = s.sendId()
      await s.host.send({ id: C1, sendId: id, text: 'hello', images: [], screen: 'empty' })
      const sub = s.host.submit({ id: C1, sendId: id, echo }); await wait(300)
      expect(await sub).toEqual({ ok: false, reason: 'no-echo' })
      expect(s.pty.some(w => w.data === '\r'), echo).toBe(false)
      expect(s.host.inputState(C1)).toBe('dirty')
      expect(await s.host.send({ id: C1, sendId: s.sendId(), text: 'x', images: [], screen: 'text' })).toEqual({ ok: false, reason: 'prompt-busy' })
      vi.useRealTimers()
    }
  })

  it('a permission request between the paste and Enter: no Enter', async () => {
    const s = await setup()
    const id = s.sendId()
    await s.host.send({ id: C1, sendId: id, text: 'hello', images: [], screen: 'empty' })
    await wait(100)
    s.arrive('PermissionRequest')
    await wait(100)
    const sub = s.host.submit({ id: C1, sendId: id, echo: 'ok' }); await wait(300)
    expect(await sub).toEqual({ ok: false, reason: 'waiting' })
    expect(s.pty.some(w => w.data === '\r')).toBe(false)
  })

  it('a permission request while Enter waits after a PreToolUse: no Enter', async () => {
    const s = await setup()
    const id = s.sendId()
    await s.host.send({ id: C1, sendId: id, text: 'hello', images: [], screen: 'empty' })
    await wait(160)
    s.arrive('PreToolUse')
    const sub = s.host.submit({ id: C1, sendId: id, echo: 'ok' })
    await wait(50)
    s.arrive('PermissionRequest')
    await wait(300)
    expect(await sub).toEqual({ ok: false, reason: 'waiting' })
    expect(s.pty.some(w => w.data === '\r')).toBe(false)
  })

  it('a key typed in the terminal between the paste and Enter: no Enter', async () => {
    const s = await setup()
    const id = s.sendId()
    await s.host.send({ id: C1, sendId: id, text: 'hello', images: [], screen: 'empty' })
    s.kb('x')
    await wait(160)
    const sub = s.host.submit({ id: C1, sendId: id, echo: 'ok' }); await wait(300)
    expect(await sub).toEqual({ ok: false, reason: 'no-echo' })
    expect(s.pty.some(w => w.data === '\r')).toBe(false)
  })

  it('the session waits on the user, or a permission request came in the last 2 s, or the terminal shows a question: nothing typed', async () => {
    const s = await setup()
    s.status(C1, 'waiting')
    expect(await s.host.send({ id: C1, sendId: s.sendId(), text: 'a', images: [], screen: 'empty' })).toEqual({ ok: false, reason: 'waiting' })
    s.status(C1, 'working')
    s.arrive('PermissionRequest')
    await wait(1900)
    expect(await s.host.send({ id: C1, sendId: s.sendId(), text: 'a', images: [], screen: 'empty' })).toEqual({ ok: false, reason: 'waiting' })
    await wait(200)
    s.terms[0].asking = true
    expect(await s.host.send({ id: C1, sendId: s.sendId(), text: 'a', images: [], screen: 'empty' })).toEqual({ ok: false, reason: 'waiting' })
    s.terms[0].asking = false
    expect((await s.host.send({ id: C1, sendId: s.sendId(), text: 'a', images: [], screen: 'empty' })).ok).toBe(true)
    expect(s.pty).toHaveLength(1)
  })

  it('every refusal before typing, in order', async () => {
    const s = await setup([
      { id: C2, tool: 'claude', status: 'running', chat: 'unarmed', createdAt: 2 },
      { id: '33333333-3333-4333-8333-333333333333', tool: 'shell', status: 'running', createdAt: 3 },
    ])
    const send = (o: Record<string, unknown>) => s.host.send({ id: C1, sendId: s.sendId(), text: 'a', images: [], screen: 'empty', ...o })
    expect(await send({ id: '33333333-3333-4333-8333-333333333333' })).toEqual({ ok: false, reason: 'not-claude' })
    expect(await send({ id: C2 })).toEqual({ ok: false, reason: 'unarmed' })
    expect(await send({ id: 'nope' })).toEqual({ ok: false, reason: 'no-session' })
    expect(await send({ screen: 'unknown' })).toEqual({ ok: false, reason: 'screen' })
    expect(await send({ screen: 'what' })).toEqual({ ok: false, reason: 'screen' })
    expect(await send({ text: ' \x07 \n' })).toEqual({ ok: false, reason: 'empty' })
    expect(await send({ text: 'x'.repeat(20_001) })).toEqual({ ok: false, reason: 'too-long' })
    expect(await send({ images: ['0123456789abcdef01234567'] })).toEqual({ ok: false, reason: 'images' })
    expect(await send({ sendId: 42 })).toEqual({ ok: false, reason: 'duplicate' })
    expect(s.pty).toEqual([])
    s.terms[0].status = 'exited'
    expect(await send({})).toEqual({ ok: false, reason: 'no-session' })
  })

  it('text on the row: typed over a clean ledger (a suggestion), refused over anything else', async () => {
    const s = await setup()
    expect((await s.host.send({ id: C1, sendId: s.sendId(), text: 'a', images: [], screen: 'text' })).ok).toBe(true)
    const t = await setup()
    t.kb('a')
    expect(await t.host.send({ id: C1, sendId: t.sendId(), text: 'b', images: [], screen: 'text' })).toEqual({ ok: false, reason: 'prompt-busy' })
    expect((await t.host.send({ id: C1, sendId: t.sendId(), text: 'b', images: [], screen: 'empty' })).ok).toBe(true)
  })

  it('the ledger: keys, Enter, the prompt signal from the reader, 5 s without it', async () => {
    const s = await setup()
    expect(s.host.inputState(C1)).toBe('clean')
    s.kb('a')
    expect(s.host.inputState(C1)).toBe('dirty')
    s.kb('\r')
    expect(s.host.inputState(C1)).toBe('submitted')
    s.workers[0].send({ t: 'prompt', id: C1 })
    expect(s.host.inputState(C1)).toBe('clean')
    s.kb('b'); s.kb('\r')
    await wait(5100)
    expect(s.host.inputState(C1)).toBe('unknown')
    // keys while a question is on screen answer it: the row is unchanged
    const t = await setup()
    t.host.onInput(C1, '1', 'keyboard', undefined, true)
    expect(t.host.inputState(C1)).toBe('clean')
    t.status(C1, 'waiting')
    t.kb('2')
    expect(t.host.inputState(C1)).toBe('clean')
  })

  it('a send with no submit for twice the page\'s wait (a page that died): cleared, no Enter, the row dirty', async () => {
    const s = await setup()
    const id = s.sendId()
    await s.host.send({ id: C1, sendId: id, text: 'hello', images: [], screen: 'empty' })
    // (the page's own wait: 1.5 s of echo + 150 ms before Enter; main waits twice that and a second; review m8)
    await wait(4000)
    expect(s.host.busy(C1)).toBe(true)
    await wait(400)
    expect(s.host.busy(C1)).toBe(false)
    expect(s.host.inputState(C1)).toBe('dirty')
    expect(await s.host.submit({ id: C1, sendId: id, echo: 'ok' })).toEqual({ ok: false, reason: 'not-in-flight' })
    expect(s.pty.some(w => w.data === '\r')).toBe(false)
    expect((await s.host.send({ id: C1, sendId: s.sendId(), text: 'b', images: [], screen: 'empty' })).ok).toBe(true)
  })

  it('a slash command is typed as is; a multi-line text is one paste', async () => {
    const s = await setup()
    const id = s.sendId()
    expect(await s.host.send({ id: C1, sendId: id, text: '/compact', images: [], screen: 'empty' })).toEqual({ ok: true, expect: { head: '/compact', images: 0, long: false }, command: true, minEnterMs: 150 })
    await wait(160); await s.host.submit({ id: C1, sendId: id, echo: 'ok' })
    s.workers[0].send({ t: 'prompt', id: C1 })
    await s.host.send({ id: C1, sendId: s.sendId(), text: 'one\r\ntwo\x1b[201~\nthree', images: [], screen: 'empty' })
    expect(s.pty.map(w => w.data)).toEqual(['/compact', '\r', '\x1b[200~one\ntwo[201~\nthree\x1b[201~'])
  })

  it('turned off: refused; a send in flight then gets no Enter', async () => {
    const s = await setup()
    const id = s.sendId()
    await s.host.send({ id: C1, sendId: id, text: 'hello', images: [], screen: 'empty' })
    s.host.disable()
    expect(await s.host.submit({ id: C1, sendId: id, echo: 'ok' })).toEqual({ ok: false, reason: 'not-in-flight' })
    expect(await s.host.send({ id: C1, sendId: s.sendId(), text: 'a', images: [], screen: 'empty' })).toEqual({ ok: false, reason: 'off' })
    expect(s.pty.some(w => w.data === '\r')).toBe(false)
  })

  it('property: no Enter without an accepted submit of that send, and at most one per send id', async () => {
    let seed = 11
    const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff }
    const pick = <T,>(a: T[]) => a[Math.floor(rnd() * a.length)]
    let everAccepted = 0
    for (let run = 0; run < 500; run++) {
      const s = await setup()
      const ids: string[] = []
      const okIds: string[] = []
      const accepted = new Map<string, number>()
      let pending = 0
      const enterWrites = () => s.pty.filter(w => w.data === '\r').length
      let enters = 0
      for (let step = 0; step < 24; step++) {
        const before = enterWrites()
        const k = rnd()
        if (k < 0.25) {
          const id = rnd() < 0.2 && ids.length ? pick(ids) : s.sendId()
          ids.push(id)
          const sent = await s.host.send({ id: C1, sendId: id, text: pick(['hi', '/compact', 'a\nb', '!x']), images: [], screen: pick(['empty', 'empty', 'empty', 'text', 'unknown']) })
          if (sent.ok) okIds.push(id)
        } else if (k < 0.5 && ids.length) {
          const id = rnd() < 0.8 && okIds.length ? okIds[okIds.length - 1] : pick(ids)
          pending++
          let r: any = null
          // (mostly as the page does: after the minimum; sometimes too early, which is refused)
          if (rnd() < 0.85) await wait(160)
          const p = s.host.submit({ id: C1, sendId: id, echo: pick(['ok', 'ok', 'ok', 'mismatch', 'blocked', 'timeout']) }).then((x: any) => { r = x })
          // things happen while Enter waits its time: a key, a permission request, a status
          await wait(Math.floor(rnd() * 120))
          const meanwhile = rnd()
          if (meanwhile < 0.1) s.kb('z')
          else if (meanwhile < 0.2) s.arrive('PermissionRequest')
          else if (meanwhile < 0.3) s.status(C1, 'waiting')
          else if (meanwhile < 0.35) s.arrive('PreToolUse')
          else if (meanwhile < 0.4) s.workers[0].send({ t: 'asking', id: C1, on: rnd() < 0.5 })
          while (!r) await wait(50)
          await p
          pending--
          if (r.ok) accepted.set(id, (accepted.get(id) ?? 0) + 1)
        } else if (k < 0.6) s.kb(pick(['a', '\r', '\x7f', '\x1b[D']))
        else if (k < 0.7) s.workers[0].send({ t: 'prompt', id: C1 })
        else if (k < 0.78) s.arrive(pick(['PermissionRequest', 'PreToolUse', 'PostToolUse']), pick([C1, C1, C2]))
        else if (k < 0.85) s.status(C1, pick(['idle', 'working', 'working', 'waiting']))
        else await wait(Math.floor(rnd() * 3500))
        const after = enterWrites()
        // an Enter is written only inside an accepted submit
        if (after > before) expect(k >= 0.25 && k < 0.5, `run ${run} step ${step}`).toBe(true)
        enters = after
      }
      const total = [...accepted.values()].reduce((a, b) => a + b, 0)
      expect(enters, `run ${run}`).toBe(total)
      everAccepted += total
      for (const [id, n] of accepted) expect(n, `run ${run} ${id}`).toBe(1)
      expect(pending).toBe(0)
      vi.useRealTimers()
    }
    // not vacuous: many sends went all the way
    expect(everAccepted).toBeGreaterThan(60)
  }, 60_000)
})

describe('interrupt (멈추기)', () => {
  it('one Esc while working; again within a second does nothing; idle and waiting refuse', async () => {
    const s = await setup()
    expect(s.host.interrupt(C1)).toEqual({ ok: false, reason: 'not-working' })
    s.status(C1, 'working')
    expect(s.host.interrupt(C1)).toEqual({ ok: true })
    expect(s.pty.map(w => w.data)).toEqual(['\x1b'])
    expect(s.host.inputState(C1)).toBe('unknown')
    await wait(500)
    expect(s.host.interrupt(C1)).toEqual({ ok: false, reason: 'debounced' })
    await wait(600)
    expect(s.host.interrupt(C1)).toEqual({ ok: true })
    s.status(C1, 'waiting')
    expect(s.host.interrupt(C1)).toEqual({ ok: false, reason: 'waiting' })
    s.status(C1, 'working')
    s.arrive('PermissionRequest')
    await wait(1100)
    expect(s.host.interrupt(C1)).toEqual({ ok: false, reason: 'waiting' })
    expect(s.host.interrupt('nope')).toEqual({ ok: false, reason: 'no-session' })
    expect(s.pty.filter(w => w.data === '\x1b')).toHaveLength(2)
  })

  it('not while a send is in flight', async () => {
    const s = await setup()
    s.status(C1, 'working')
    await s.host.send({ id: C1, sendId: s.sendId(), text: 'hello', images: [], screen: 'empty' })
    expect(s.host.interrupt(C1)).toEqual({ ok: false, reason: 'sending' })
  })
})

describe('the IPC', () => {
  function fakeIpc() {
    const handlers = new Map<string, (...a: any[]) => any>()
    const ipcMain = { handle: (n: string, f: any) => handlers.set(n, f), on: (n: string, f: any) => handlers.set(n, f) }
    const guard = (fn: any) => (event: any, arg: any) => fn(arg, event)
    return { ipcMain, guard, call: (n: string, arg?: any) => handlers.get(n)!({}, arg), handlers }
  }
  it('chat:send, chat:submit, chat:interrupt through the guard; payloads of the wrong shape are refused', async () => {
    const s = await setup()
    const ipc = fakeIpc()
    s.host.registerIpc(ipc.ipcMain, ipc.guard)
    for (const n of ['chat:send', 'chat:submit', 'chat:interrupt']) expect(ipc.handlers.has(n), n).toBe(true)
    expect(await ipc.call('chat:send', null)).toEqual({ ok: false, reason: 'no-session' })
    expect(await ipc.call('chat:send', { id: C1, sendId: 'send-ipc-01', text: { toString: () => 'x' }, images: [], screen: 'empty' })).toEqual({ ok: false, reason: 'empty' })
    expect(await ipc.call('chat:send', { id: C1, sendId: 'send-ipc-02', text: 'x', images: 'nope', screen: 'empty' })).toEqual({ ok: false, reason: 'images' })
    const r = await ipc.call('chat:send', { id: C1, sendId: 'send-ipc-03', text: 'x', images: [], screen: 'empty' })
    expect(r.ok).toBe(true)
    await wait(160)
    expect(await ipc.call('chat:submit', { id: C1, sendId: 'send-ipc-03', echo: 'ok' })).toEqual({ ok: true })
    expect(await ipc.call('chat:interrupt', C1)).toEqual({ ok: false, reason: 'not-working' })
  })
})

describe('images (Task 3.5)', () => {
  const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00])
  const root = (space = '') => join(mkdtempSync(join(tmpdir(), 'spawn-img-host-')), space, 'spawn-chat-0a1b2c3d')

  it('chat:image saves for an armed session; a token becomes its path in send, quoted when it has a space; an unknown token refuses', async () => {
    const r = root('a folder')
    const s = await setup([], { imageRoot: r })
    vi.useRealTimers()
    const saved = await s.host.image({ id: C1, bytes: PNG })
    expect(saved).toMatchObject({ ok: true, type: 'png' })
    vi.useFakeTimers()
    const id = s.sendId()
    const sending = s.host.send({ id: C1, sendId: id, text: 'look', images: [saved.token], screen: 'empty' })
    await wait(100)
    const sent = await sending
    expect(sent).toEqual({ ok: true, expect: { head: 'look', images: 1, long: false }, command: false, minEnterMs: 400 })
    expect(s.pty.map(w => w.data)).toEqual(['\x1b[200~look\x1b[201~', ' \x1b[200~"' + join(r, C1, saved.token + '.png') + '"\x1b[201~'])
    expect(s.pty[1].at - s.pty[0].at).toBeGreaterThanOrEqual(60)
    expect(await s.host.send({ id: C1, sendId: s.sendId(), text: 'x', images: ['f'.repeat(24)], screen: 'empty' })).toEqual({ ok: false, reason: 'sending' })
  })

  it('off, unarmed, not bytes: refused; the session ends: its folder goes; a new host sweeps the folder', async () => {
    const r = root()
    const s = await setup([{ id: C2, tool: 'claude', status: 'running', chat: 'unarmed', createdAt: 2 }], { imageRoot: r })
    vi.useRealTimers()
    expect(await s.host.image({ id: C2, bytes: PNG })).toEqual({ ok: false, reason: 'off' })
    expect(await s.host.image({ id: C1, bytes: 'x' })).toEqual({ ok: false, reason: 'type' })
    const a = await s.host.image({ id: C1, bytes: PNG })
    expect(existsSync(join(r, C1))).toBe(true)
    s.host.dropImage({ id: C1, token: a.token })
    await until(() => !existsSync(join(r, C1, a.token + '.png')))
    await s.host.image({ id: C1, bytes: PNG })
    s.terms[0].status = 'exited'
    s.host.onTerminals(s.terms)
    await until(() => !existsSync(join(r, C1)))
    s.host.disable()
    expect(await s.host.image({ id: C1, bytes: PNG })).toEqual({ ok: false, reason: 'off' })
    // leftovers of an earlier run: the next host (main's, sweep: true) removes the whole folder
    mkdirSync(join(r, C2), { recursive: true })
    writeFileSync(join(r, C2, 'old.png'), 'x')
    createChatHost({ terminals: { list: () => [], refreshSettings() {}, armedCount: () => 0 }, send() {}, userDataDir: tmpdir(), claudeVersion: async () => null, imageRoot: r, sweep: true })
    await until(() => !existsSync(r))
  })

  it('no image root: chat:image is off', async () => {
    const s = await setup()
    vi.useRealTimers()
    expect(await s.host.image({ id: C1, bytes: PNG })).toEqual({ ok: false, reason: 'off' })
  })
})

describe('the review of Phase 3: the send path in main (fixed)', () => {
  it('I-3: terminal ↑ then Enter, the reader hears the prompt: the next send over a greyed suggestion goes', async () => {
    const s = await setup()
    s.kb('\x1b[A')
    expect(await s.host.send({ id: C1, sendId: s.sendId(), text: 'x', images: [], screen: 'text' })).toEqual({ ok: false, reason: 'prompt-unknown' })
    s.kb('\r')
    s.workers[0].send({ t: 'prompt', id: C1 })
    expect(s.host.inputState(C1)).toBe('clean')
    expect((await s.host.send({ id: C1, sendId: s.sendId(), text: 'x', images: [], screen: 'text' })).ok).toBe(true)
  })

  it('I-3: xterm\'s answers to Claude Code\'s start-up queries leave the row clean (the first send goes)', async () => {
    const s = await setup()
    s.kb('\x1b[?1;2c'); s.kb('\x1b]11;rgb:1e1e/1e1e/1e1e\x07'); s.kb('\x1b[I')
    expect(s.host.inputState(C1)).toBe('clean')
    expect((await s.host.send({ id: C1, sendId: s.sendId(), text: 'x', images: [], screen: 'text' })).ok).toBe(true)
  })

  it('I-4: another session\'s permission request neither refuses this one\'s sends nor strands its Enter', async () => {
    const s = await setup([{ id: C2, tool: 'claude', status: 'running', chat: 'armed', asking: false, createdAt: 2 }])
    const id = s.sendId()
    await s.host.send({ id: C1, sendId: id, text: 'hello', images: [], screen: 'empty' })
    s.arrive('PermissionRequest', C2)
    await wait(160)
    expect(await s.host.submit({ id: C1, sendId: id, echo: 'ok' })).toEqual({ ok: true })
    expect(s.pty.filter(w => w.id === C1).map(w => w.data)).toEqual(['\x1b[200~hello\x1b[201~', '\r'])
    // the session that asked is the one refused
    expect(await s.host.send({ id: C2, sendId: s.sendId(), text: 'b', images: [], screen: 'empty' })).toEqual({ ok: false, reason: 'waiting' })
    s.workers[0].send({ t: 'prompt', id: C1 })
    expect((await s.host.send({ id: C1, sendId: s.sendId(), text: 'c', images: [], screen: 'empty' })).ok).toBe(true)
  })

  it('I-5: busy while a send is between its text and its Enter; a side send holds the chat back until its Enter is heard', async () => {
    const s = await setup()
    expect(s.host.busy(C1)).toBe(false)
    const id = s.sendId()
    await s.host.send({ id: C1, sendId: id, text: 'hello', images: [], screen: 'empty' })
    expect(s.host.busy(C1)).toBe(true)
    await wait(160)
    await s.host.submit({ id: C1, sendId: id, echo: 'ok' })
    expect(s.host.busy(C1)).toBe(false)
    s.workers[0].send({ t: 'prompt', id: C1 })
    // the side box typed; its Enter is late (a loaded machine): the chat waits for it, not a fixed 200 ms
    s.host.onInput(C1, null, 'side', 'typed')
    await wait(600)
    expect(await s.host.send({ id: C1, sendId: s.sendId(), text: 'x', images: [], screen: 'empty' })).toEqual({ ok: false, reason: 'sending' })
    s.host.onInput(C1, null, 'side', 'enter')
    s.workers[0].send({ t: 'prompt', id: C1 })
    expect((await s.host.send({ id: C1, sendId: s.sendId(), text: 'x', images: [], screen: 'empty' })).ok).toBe(true)
    // an Enter never heard (the session ended between): the hold lasts 2 s at most
    const t = await setup()
    t.host.onInput(C1, null, 'side', 'typed')
    await wait(2100)
    t.host.onInput(C1, null, 'side', 'enter')
    t.workers[0].send({ t: 'prompt', id: C1 })
    expect((await t.host.send({ id: C1, sendId: t.sendId(), text: 'x', images: [], screen: 'empty' })).ok).toBe(true)
  })

  it('I-6: a submit before the minimum is refused (the page waits it out and looks again); after it, Enter at once', async () => {
    const s = await setup()
    const id = s.sendId()
    await s.host.send({ id: C1, sendId: id, text: 'hello', images: [], screen: 'empty' })
    await wait(40)
    expect(await s.host.submit({ id: C1, sendId: id, echo: 'ok' })).toEqual({ ok: false, reason: 'not-in-flight' })
    expect(s.pty.some(w => w.data === '\r')).toBe(false)
    expect(s.host.inputState(C1)).toBe('dirty')
    const u = await setup()
    const id2 = u.sendId()
    await u.host.send({ id: C1, sendId: id2, text: 'hello', images: [], screen: 'empty' })
    await wait(150)
    const before = Date.now()
    expect(await u.host.submit({ id: C1, sendId: id2, echo: 'ok' })).toEqual({ ok: true })
    expect(u.pty[1].at - before).toBe(0)
  })

  it('I-6: a tool that just started makes Enter wait a moment; a question it opened (the reader says so) gets no Enter', async () => {
    const s = await setup()
    const id = s.sendId()
    await s.host.send({ id: C1, sendId: id, text: 'hello', images: [], screen: 'empty' })
    await wait(160)
    s.arrive('PreToolUse')
    const sub = s.host.submit({ id: C1, sendId: id, echo: 'ok' })
    await wait(30)
    // the reader read the PreToolUse body: AskUserQuestion (it raises no PermissionRequest)
    s.workers[0].send({ t: 'asking', id: C1, on: true })
    await wait(400)
    expect(await sub).toEqual({ ok: false, reason: 'waiting' })
    expect(s.pty.some(w => w.data === '\r')).toBe(false)
    // while the question is open: nothing typed, no Esc
    expect(await s.host.send({ id: C1, sendId: s.sendId(), text: 'x', images: [], screen: 'empty' })).toEqual({ ok: false, reason: 'waiting' })
    s.status(C1, 'working')
    expect(s.host.interrupt(C1)).toEqual({ ok: false, reason: 'waiting' })
    s.workers[0].send({ t: 'asking', id: C1, on: false })
    // an ordinary tool: Enter after its PostToolUse, or 300 ms of quiet at most
    const t = await setup()
    const id3 = t.sendId()
    await t.host.send({ id: C1, sendId: id3, text: 'hello', images: [], screen: 'empty' })
    await wait(160)
    t.arrive('PreToolUse')
    const at = Date.now()
    const sub3 = t.host.submit({ id: C1, sendId: id3, echo: 'ok' })
    await wait(100)
    expect(t.pty.some(w => w.data === '\r')).toBe(false)
    t.arrive('PostToolUse')
    await wait(50)
    expect(await sub3).toEqual({ ok: true })
    expect(t.pty[1].at - at).toBeLessThan(200)
    const u = await setup()
    const id4 = u.sendId()
    await u.host.send({ id: C1, sendId: id4, text: 'hello', images: [], screen: 'empty' })
    await wait(160)
    u.arrive('PreToolUse')
    const at4 = Date.now()
    const sub4 = u.host.submit({ id: C1, sendId: id4, echo: 'ok' })
    await wait(400)
    expect(await sub4).toEqual({ ok: true })
    expect(u.pty[1].at - at4).toBeGreaterThanOrEqual(300)
    expect(u.pty[1].at - at4).toBeLessThan(400)
  })

  it('m7: a send whose page went away: the next composer is told once that its text may be on the prompt row', async () => {
    const s = await setup()
    expect(s.host.stranded(C1)).toEqual({ stranded: false })
    await s.host.send({ id: C1, sendId: s.sendId(), text: 'hello', images: [], screen: 'empty' })
    await wait(5000)
    expect(s.host.stranded(C1)).toEqual({ stranded: true })
    expect(s.host.stranded(C1)).toEqual({ stranded: false })
  })

  it('m9: turned off then on again: what the rows hold is not known (keys went unheard meanwhile)', async () => {
    const s = await setup()
    expect(s.host.inputState(C1)).toBe('clean')
    s.host.disable()
    await s.host.enable()
    expect(s.host.inputState(C1)).toBe('unknown')
    expect(await s.host.send({ id: C1, sendId: s.sendId(), text: 'x', images: [], screen: 'text' })).toEqual({ ok: false, reason: 'prompt-unknown' })
    // a row that reads empty is fine
    expect((await s.host.send({ id: C1, sendId: s.sendId(), text: 'x', images: [], screen: 'empty' })).ok).toBe(true)
  })
})
