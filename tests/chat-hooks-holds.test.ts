/**
 * electron/chatHooks.cjs with holds: the endpoint keeps a PermissionRequest and
 * the AskUserQuestion route open until the hold registry answers, releases or loses it; every other
 * hook is still answered first; the entries outlast the holds. A real socket.
 */

import http from 'node:http'
import { createRequire } from 'node:module'
import { Worker } from 'node:worker_threads'
import { afterEach, describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const { createChatEndpoint, chatHookEntries, CHAT_HOOK_EVENTS } = require('../electron/chatHooks.cjs')
const { createHolds, HOLD } = require('../electron/chatHolds.cjs')
const { sessionSettingsJson } = require('../electron/terminals.cjs')

const TID = '33333333-3333-4333-8333-333333333333'
const TOKEN = 'cd'.repeat(24)

const open: { close(): Promise<void> }[] = []
afterEach(async () => { for (const e of open.splice(0)) await e.close() })

const realTimers = { setTimeout: (f: () => void, ms: number) => setTimeout(f, ms), clearTimeout: (t: any) => clearTimeout(t) }

async function endpoint(opts: Record<string, unknown> = {}) {
  const hooks: any[] = []
  const e = createChatEndpoint({ onHook: (...a: any[]) => hooks.push(a), log: () => {}, raw: true, ...opts })
  open.push(e)
  const { port, token } = await e.listen()
  return { e, port, token, hooks }
}

function request(port: number, path: string, body: string) {
  let req!: http.ClientRequest
  const done = new Promise<{ status: number; body: string; at: number; type: string | undefined }>((resolve, reject) => {
    req = http.request({ host: '127.0.0.1', port, path, method: 'POST', headers: { 'content-type': 'application/json' } }, (res) => {
      let data = ''
      res.on('data', (c) => { data += c })
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: data, at: Date.now(), type: res.headers['content-type'] }))
    })
    req.on('error', reject)
    req.end(body)
  })
  return { req, done }
}

const until = async (cond: () => boolean, ms = 2000) => {
  const end = Date.now() + ms
  while (!cond()) { if (Date.now() > end) throw new Error('timed out'); await new Promise(r => setTimeout(r, 5)) }
}

const BODY = JSON.stringify({ session_id: 's', hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'ls' } })

describe('the endpoint holds', () => {
  it('a PermissionRequest waits for the answer; the client gets its JSON', async () => {
    const holds = createHolds({ timers: realTimers })
    const { port, token, hooks } = await endpoint({ holds })
    const r = request(port, `/chat/${token}/${TID}/PermissionHold`, BODY)
    await until(() => hooks.length === 1)
    const [event, raw, at, id, holdId] = hooks[0]
    expect(event).toBe('PermissionRequest')
    expect(raw).toBeInstanceOf(Uint8Array)
    expect(typeof at).toBe('number')
    expect(id).toBe(TID)
    expect(typeof holdId).toBe('string')
    let answered = false
    void r.done.then(() => { answered = true })
    await new Promise(res => setTimeout(res, 100))
    expect(answered).toBe(false)
    holds.bind(holdId, { id: TID, key: 'k', data: { rules: [] } })
    expect(holds.answer(holdId, { id: TID, choice: 'allow', visibleId: TID, windowVisible: true })).toEqual({ ok: true })
    const res = await r.done
    expect(res.status).toBe(200)
    expect(res.type).toBe('application/json')
    expect(JSON.parse(res.body)).toEqual({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } } })
  })

  it('released: an empty 200 ("no decision")', async () => {
    const holds = createHolds({ timers: realTimers })
    const { port, token, hooks } = await endpoint({ holds })
    const r = request(port, `/chat/${token}/${TID}/PermissionHold`, BODY)
    await until(() => hooks.length === 1)
    holds.release(hooks[0][4], 'test')
    const res = await r.done
    expect(res).toMatchObject({ status: 200, body: '' })
  })

  it('the client going away: gone, once, and nothing sent', async () => {
    const changes: any[] = []
    const holds = createHolds({ timers: realTimers, onChange: (c: any) => changes.push(c) })
    const { port, token, hooks } = await endpoint({ holds })
    const r = request(port, `/chat/${token}/${TID}/PermissionHold`, BODY)
    r.done.catch(() => {})
    await until(() => hooks.length === 1)
    r.req.destroy()
    await until(() => changes.some(c => c.state === 'gone'))
    expect(changes.filter(c => c.state === 'gone')).toHaveLength(1)
    expect(holds.size()).toBe(0)
  })

  it('draining, a full registry, or no registry: answered at once and no hold opened', async () => {
    const holds = createHolds({ timers: realTimers, limits: { ...HOLD, max: 0 } })
    const { port, token, e } = await endpoint({ holds })
    const full = await request(port, `/chat/${token}/${TID}/PermissionHold`, BODY).done
    expect(full).toMatchObject({ status: 200, body: '' })
    const none = await endpoint({ holds: () => null })
    expect((await request(none.port, `/chat/${none.token}/${TID}/PermissionHold`, BODY).done)).toMatchObject({ status: 200, body: '' })
    const roomy = createHolds({ timers: realTimers })
    const d = await endpoint({ holds: roomy })
    d.e.setDraining(true)
    expect((await request(d.port, `/chat/${d.token}/${TID}/PermissionHold`, BODY).done)).toMatchObject({ status: 200, body: '' })
    expect(roomy.size()).toBe(0)
    void e
  })

  it('the AskUserQuestion route: held, and handed on as a PreToolUse', async () => {
    const holds = createHolds({ timers: realTimers })
    const arrived: string[] = []
    const { port, token, hooks } = await endpoint({ holds, onArrive: (ev: string) => arrived.push(ev) })
    const r = request(port, `/chat/${token}/${TID}/AskUserQuestion`, JSON.stringify({ session_id: 's', hook_event_name: 'PreToolUse', tool_name: 'AskUserQuestion' }))
    await until(() => hooks.length === 1)
    expect(hooks[0][0]).toBe('PreToolUse')
    expect(arrived).toEqual(['PreToolUse'])
    expect(holds.get(hooks[0][4])).toMatchObject({ kind: 'question', urlId: TID })
    holds.release(hooks[0][4], 'test')
    expect((await r.done).body).toBe('')
  })

  it('a held response still arrives after the server\'s request timeout (body read: the timeout is over)', async () => {
    const holds = createHolds({ timers: realTimers })
    // (Node checks for timed-out requests every connectionsCheckingInterval: 50 ms here, so a request it
    // would cut is cut well inside the 1.2 s held)
    const { port, token, hooks } = await endpoint({ holds, requestTimeoutMs: 300, checkEveryMs: 50 })
    const started = Date.now()
    const r = request(port, `/chat/${token}/${TID}/PermissionHold`, BODY)
    await until(() => hooks.length === 1)
    await new Promise(res => setTimeout(res, 1200))
    holds.bind(hooks[0][4], { id: TID, key: 'k', data: { rules: [] } })
    holds.answer(hooks[0][4], { id: TID, choice: 'deny', visibleId: TID, windowVisible: true })
    const res = await r.done
    expect(res.at - started).toBeGreaterThanOrEqual(1200)
    expect(JSON.parse(res.body).hookSpecificOutput.decision.behavior).toBe('deny')
  })

  it('every other hook is still answered first, with a stalled consumer and a hold open', async () => {
    const holds = createHolds({ timers: realTimers })
    const { port, token, hooks } = await endpoint({
      holds,
      // (each hook's own handler stalls the thread for 300 ms: its answer must already be on its way)
      onHook: (...a: any[]) => { hooks.push(a); if (a[0] === 'PermissionRequest') return; const end = Date.now() + 1000; while (Date.now() < end) { /* a stalled consumer */ } },
    })
    const held = request(port, `/chat/${token}/${TID}/PermissionHold`, BODY)
    held.done.catch(() => {})
    await until(() => hooks.length === 1)
    // the client runs in its own thread: this one is the one being blocked
    const code = `
      const { parentPort, workerData } = require('worker_threads')
      const http = require('http')
      const one = (path) => new Promise((resolve) => {
        const t0 = Date.now()
        const req = http.request({ host: '127.0.0.1', port: workerData.port, path, method: 'POST', headers: { 'content-type': 'application/json' } }, (res) => {
          let data = ''; res.on('data', (c) => { data += c }); res.on('end', () => resolve({ status: res.statusCode, body: data, ms: Date.now() - t0 }))
        })
        req.end('{"session_id":"s"}')
      })
      ;(async () => { const out = []; for (const p of workerData.paths) out.push(await one(p)); parentPort.postMessage(out) })()
    `
    const worker = new Worker(code, { eval: true, workerData: { port, paths: ['PreToolUse', 'MessageDisplay'].map(ev => `/chat/${token}/${TID}/${ev}`) } })
    const results: { status: number; body: string; ms: number }[] = await new Promise((resolve, reject) => { worker.once('message', resolve); worker.once('error', reject) })
    await worker.terminate()
    expect(results.map(r => [r.status, r.body])).toEqual([[200, ''], [200, '']])
    // the first is answered before its own handler stalls (1 s); the second may wait out the first's stall only
    // (a wide margin: a loaded machine is slow, never a whole stall slow)
    expect(results[0].ms).toBeLessThan(800)
    holds.releaseAll('test')
    await held.done
  })

  it('the plain PermissionRequest route (the passive entry, 5 s) is never held, even with a registry (review M1)', async () => {
    const holds = createHolds({ timers: realTimers })
    const { port, token, hooks } = await endpoint({ holds })
    const res = await request(port, `/chat/${token}/${TID}/PermissionRequest`, BODY).done
    expect(res).toMatchObject({ status: 200, body: '' })
    await until(() => hooks.length === 1)
    expect(hooks[0][0]).toBe('PermissionRequest')
    expect(hooks[0][4]).toBeUndefined()
    expect(holds.size()).toBe(0)
  })

  it('the endpoint\'s respond says whether it wrote: true once, false after (review M6)', async () => {
    const said: boolean[] = []
    const registry = {
      open: (_kind: string, respond: (b: string | null) => boolean) => { setTimeout(() => { said.push(respond(null)); said.push(respond('{}')) }, 20); return 'h1' },
      gone: () => {},
    }
    const { port, token } = await endpoint({ holds: registry })
    const res = await request(port, `/chat/${token}/${TID}/PermissionHold`, BODY).done
    expect(res).toMatchObject({ status: 200, body: '' })
    expect(said).toEqual([true, false])
  })

  it('no hold unless the route is a held one', async () => {
    const holds = createHolds({ timers: realTimers })
    const { port, token } = await endpoint({ holds })
    await request(port, `/chat/${token}/${TID}/PreToolUse`, JSON.stringify({ session_id: 's' })).done
    expect(holds.size()).toBe(0)
  })
})

describe('the entries with holds', () => {
  it('PermissionRequest 330 s; PreToolUse 5 s plus a matcher group for AskUserQuestion at 330 s; only the known keys', () => {
    const e = chatHookEntries({ port: 4321, token: TOKEN, id: TID, holds: true })
    expect(Object.keys(e)).toEqual(CHAT_HOOK_EVENTS)
    expect(e.PermissionRequest).toEqual({ hooks: [{ type: 'http', url: `http://127.0.0.1:4321/chat/${TOKEN}/${TID}/PermissionHold`, timeout: 330 }] })
    expect(e.PreToolUse).toEqual([
      { hooks: [{ type: 'http', url: `http://127.0.0.1:4321/chat/${TOKEN}/${TID}/PreToolUse`, timeout: 5 }] },
      { matcher: 'AskUserQuestion', hooks: [{ type: 'http', url: `http://127.0.0.1:4321/chat/${TOKEN}/${TID}/AskUserQuestion`, timeout: 330 }] },
    ])
    for (const groups of Object.values<any>(e)) {
      for (const g of [].concat(groups) as any[]) {
        for (const k of Object.keys(g)) expect(['matcher', 'hooks']).toContain(k)
        for (const h of g.hooks) expect(Object.keys(h).sort()).toEqual(['timeout', 'type', 'url'])
      }
    }
    expect(e.PermissionRequest.hooks[0].timeout).toBeGreaterThan(HOLD.permissionMs / 1000)
    expect(e.PreToolUse[1].hooks[0].timeout).toBeGreaterThan(HOLD.questionMs / 1000)
  })

  it('without holds: the passive entries, byte for byte', () => {
    const PHASE2 = `{"UserPromptSubmit":{"hooks":[{"type":"http","url":"http://127.0.0.1:4321/chat/${TOKEN}/${TID}/UserPromptSubmit","timeout":5}]},"PreToolUse":{"hooks":[{"type":"http","url":"http://127.0.0.1:4321/chat/${TOKEN}/${TID}/PreToolUse","timeout":5}]},"PermissionRequest":{"hooks":[{"type":"http","url":"http://127.0.0.1:4321/chat/${TOKEN}/${TID}/PermissionRequest","timeout":5}]},"PostToolUse":{"hooks":[{"type":"http","url":"http://127.0.0.1:4321/chat/${TOKEN}/${TID}/PostToolUse","timeout":5}]},"PostToolUseFailure":{"hooks":[{"type":"http","url":"http://127.0.0.1:4321/chat/${TOKEN}/${TID}/PostToolUseFailure","timeout":5}]},"MessageDisplay":{"hooks":[{"type":"http","url":"http://127.0.0.1:4321/chat/${TOKEN}/${TID}/MessageDisplay","timeout":3}]},"Stop":{"hooks":[{"type":"http","url":"http://127.0.0.1:4321/chat/${TOKEN}/${TID}/Stop","timeout":5}]},"StopFailure":{"hooks":[{"type":"http","url":"http://127.0.0.1:4321/chat/${TOKEN}/${TID}/StopFailure","timeout":5}]},"SubagentStart":{"hooks":[{"type":"http","url":"http://127.0.0.1:4321/chat/${TOKEN}/${TID}/SubagentStart","timeout":5}]},"SubagentStop":{"hooks":[{"type":"http","url":"http://127.0.0.1:4321/chat/${TOKEN}/${TID}/SubagentStop","timeout":5}]},"PreCompact":{"hooks":[{"type":"http","url":"http://127.0.0.1:4321/chat/${TOKEN}/${TID}/PreCompact","timeout":5}]},"PostCompact":{"hooks":[{"type":"http","url":"http://127.0.0.1:4321/chat/${TOKEN}/${TID}/PostCompact","timeout":5}]}}`
    expect(JSON.stringify(chatHookEntries({ port: 4321, token: TOKEN, id: TID }))).toBe(PHASE2)
    expect(JSON.stringify(chatHookEntries({ port: 4321, token: TOKEN, id: TID, holds: false }))).toBe(PHASE2)
  })

  it('the session settings file takes a group or a list of groups; null is 1.4.0', () => {
    const withHolds = JSON.parse(sessionSettingsJson('/repo', '/node', chatHookEntries({ port: 4321, token: TOKEN, id: TID, holds: true })))
    const pre = withHolds.hooks.PreToolUse
    expect(pre.slice(-2)).toEqual(chatHookEntries({ port: 4321, token: TOKEN, id: TID, holds: true }).PreToolUse)
    expect(pre[0].hooks[0].type).toBe('command')
    const plain = JSON.parse(sessionSettingsJson('/repo', '/node', chatHookEntries({ port: 4321, token: TOKEN, id: TID })))
    expect(plain.hooks.PreToolUse.at(-1)).toEqual(chatHookEntries({ port: 4321, token: TOKEN, id: TID }).PreToolUse)
    expect(sessionSettingsJson('/repo', '/node', null)).toBe(sessionSettingsJson('/repo', '/node'))
  })
})
