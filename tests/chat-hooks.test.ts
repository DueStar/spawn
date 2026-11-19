/**
 * electron/chatHooks.cjs — the chat view's hook endpoint on 127.0.0.1: only
 * this run's token and the chat events get in, it answers before doing any
 * work (Claude Code waits for every chat hook), and a draining endpoint still
 * answers. A real socket.
 */

import http from 'node:http'
import { createRequire } from 'node:module'
import { Worker } from 'node:worker_threads'
import { afterEach, describe, expect, it } from 'vitest'
import { budget } from './timing'

const require = createRequire(import.meta.url)
const { createChatEndpoint, chatHookEntries, CHAT_HOOK_EVENTS } = require('../electron/chatHooks.cjs')

/** a terminal's id: the hook's URL names the terminal the session runs in */
const TID = '33333333-3333-4333-8333-333333333333'

const open: { close(): Promise<void> }[] = []
afterEach(async () => { for (const e of open.splice(0)) await e.close() })

async function endpoint(onHook: (event: string, body: any, at: number) => void = () => {}, opts: Record<string, unknown> = {}) {
  const e = createChatEndpoint({ onHook, log: () => {}, ...opts })
  open.push(e)
  const { port, token } = await e.listen()
  return { e, port, token }
}

function post(port: number, path: string, body: string | Buffer, headers: Record<string, string> = {}, method = 'POST'): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, method, headers: { 'content-type': 'application/json', ...headers } }, (res) => {
      let data = ''
      res.on('data', (c) => { data += c })
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: data }))
    })
    req.on('error', reject)
    req.end(body)
  })
}

const until = async (cond: () => boolean, ms = 2000) => {
  const end = Date.now() + ms
  while (!cond()) { if (Date.now() > end) throw new Error('timed out'); await new Promise(r => setTimeout(r, 5)) }
}

describe('the hook entries', () => {
  it('one http hook per chat event, on 127.0.0.1 with the token in the path, and nothing else', () => {
    const entries = chatHookEntries({ port: 4321, token: 'cd'.repeat(24), id: TID })
    expect(Object.keys(entries)).toEqual(CHAT_HOOK_EVENTS)
    expect(CHAT_HOOK_EVENTS).toEqual(['UserPromptSubmit', 'PreToolUse', 'PermissionRequest', 'PostToolUse', 'PostToolUseFailure', 'MessageDisplay', 'Stop', 'StopFailure', 'SubagentStart', 'SubagentStop', 'PreCompact', 'PostCompact'])
    for (const [event, group] of Object.entries<any>(entries)) {
      expect(Object.keys(group)).toEqual(['hooks'])
      expect(group.hooks).toHaveLength(1)
      const h = group.hooks[0]
      expect(Object.keys(h).sort()).toEqual(['timeout', 'type', 'url'])
      expect(h.type).toBe('http')
      expect(h.url).toBe(`http://127.0.0.1:4321/chat/${'cd'.repeat(24)}/${TID}/${event}`)
      expect(h.url).not.toContain('$')
      expect(h.timeout).toBe(event === 'MessageDisplay' ? 3 : 5)
    }
  })
})

describe('the endpoint', () => {
  it('the right token: 200, and the hook is handed on once, parsed', async () => {
    const got: any[] = []
    const { port, token } = await endpoint((event, body, at) => got.push({ event, body, at }))
    expect(token).toMatch(/^[0-9a-f]{48}$/)
    const r = await post(port, `/chat/${token}/${TID}/PreToolUse`, JSON.stringify({ session_id: 's', tool_name: 'Read' }))
    expect(r).toEqual({ status: 200, body: '' })
    await until(() => got.length === 1)
    expect(got[0].event).toBe('PreToolUse')
    expect(got[0].body).toEqual({ session_id: 's', tool_name: 'Read' })
    expect(typeof got[0].at).toBe('number')
  })

  it('refuses everything else: a wrong token, an unknown event, GET (404); an Origin, another Host (403)', async () => {
    const got: any[] = []
    const { port, token } = await endpoint((e) => got.push(e))
    expect((await post(port, `/chat/${'00'.repeat(24)}/${TID}/Stop`, '{}')).status).toBe(404)
    expect((await post(port, `/chat/${token.slice(0, 10)}/${TID}/Stop`, '{}')).status).toBe(404)
    expect((await post(port, `/chat/${token}/${TID}/SessionStart`, '{}')).status).toBe(404)
    expect((await post(port, `/chat/${token}/${TID}/Stop/x`, '{}')).status).toBe(404)
    expect((await post(port, `/hook/Stop`, '{}')).status).toBe(404)
    expect((await post(port, `/chat/${token}/${TID}/Stop`, '', {}, 'GET')).status).toBe(404)
    const origin = await post(port, `/chat/${token}/${TID}/Stop`, '{}', { Origin: 'http://evil.example' })
    expect(origin).toEqual({ status: 403, body: '' })
    expect((await post(port, `/chat/${token}/${TID}/Stop`, '{}', { Host: `localhost:${port}` })).status).toBe(403)
    expect((await post(port, `/chat/${token}/${TID}/Stop`, '{}', { Host: 'evil.example' })).status).toBe(403)
    await new Promise(r => setTimeout(r, 30))
    expect(got).toEqual([])
  })

  it('a body over the cap: 200, and the hook is handed on as { oversize: true }', async () => {
    const got: any[] = []
    const { port, token } = await endpoint((event, body) => got.push({ event, body }))
    const r = await post(port, `/chat/${token}/${TID}/PostToolUse`, Buffer.alloc(3 << 20, 0x61))
    expect(r.status).toBe(200)
    await until(() => got.length === 1)
    expect(got[0]).toEqual({ event: 'PostToolUse', body: { oversize: true } })
  })

  it('a body that is not JSON: 200, dropped', async () => {
    const got: any[] = []
    const { port, token } = await endpoint((e) => got.push(e))
    expect((await post(port, `/chat/${token}/${TID}/Stop`, '{not json')).status).toBe(200)
    await new Promise(r => setTimeout(r, 30))
    expect(got).toEqual([])
  })

  it('a handler that throws does not stop the endpoint', async () => {
    const { port, token } = await endpoint(() => { throw new Error('boom') })
    expect((await post(port, `/chat/${token}/${TID}/Stop`, '{}')).status).toBe(200)
    expect((await post(port, `/chat/${token}/${TID}/Stop`, '{}')).status).toBe(200)
  })

  it('answers first: with a handler that blocks for 500 ms, the first of two posts is answered in < 50 ms (×4 on CI)', async () => {
    const { port, token } = await endpoint(() => { const end = Date.now() + 500; while (Date.now() < end) { /* busy */ } })
    // the client runs in its own thread: this one is the one being blocked
    const code = `
      const { parentPort, workerData } = require('worker_threads')
      const http = require('http')
      const one = () => new Promise((resolve) => {
        const t0 = Date.now()
        const req = http.request({ host: '127.0.0.1', port: workerData.port, path: workerData.path, method: 'POST', headers: { 'content-type': 'application/json' } }, (res) => {
          res.resume(); res.on('end', () => resolve({ status: res.statusCode, ms: Date.now() - t0 }))
        })
        req.end('{"session_id":"s"}')
      })
      Promise.all([one(), one()]).then((r) => parentPort.postMessage(r))
    `
    const worker = new Worker(code, { eval: true, workerData: { port, path: `/chat/${token}/${TID}/MessageDisplay` } })
    const results: { status: number; ms: number }[] = await new Promise((resolve, reject) => { worker.once('message', resolve); worker.once('error', reject) })
    await worker.terminate()
    expect(results.map(r => r.status)).toEqual([200, 200])
    // ×4 on a CI runner (budget(), tests/timing.ts): the handler blocks 500 ms, so 200 ms still proves the post is
    // answered before the handler runs
    expect(Math.min(...results.map(r => r.ms))).toBeLessThan(budget(50))
  })

  it('draining: still 200, and nothing is handed on', async () => {
    const got: any[] = []
    const { e, port, token } = await endpoint((ev) => got.push(ev))
    e.setDraining(true)
    expect((await post(port, `/chat/${token}/${TID}/Stop`, '{"session_id":"s"}')).status).toBe(200)
    await new Promise(r => setTimeout(r, 30))
    expect(got).toEqual([])
    e.setDraining(false)
    expect((await post(port, `/chat/${token}/${TID}/Stop`, '{"session_id":"s"}')).status).toBe(200)
    await until(() => got.length === 1)
  })

  it('listen twice: the same port and token; close stops listening', async () => {
    const { e, port, token } = await endpoint()
    expect(await e.listen()).toEqual({ port, token })
    await e.close()
    await expect(post(port, `/chat/${token}/${TID}/Stop`, '{}')).rejects.toThrow()
  })
})

// main never parses a hook body (it can hold a file's text); refusals are logged once per reason
describe('raw bodies and refusals', () => {
  it('raw: the body is handed on as its own bytes, unparsed (the worker parses it)', async () => {
    const got: any[] = []
    const e = createChatEndpoint({ onHook: (ev: string, body: any) => got.push({ ev, body }), log: () => {}, raw: true })
    open.push(e)
    const { port, token } = await e.listen()
    await post(port, `/chat/${token}/${TID}/PostToolUse`, '{"session_id":"s","tool_response":{"file":"x"}}')
    await post(port, `/chat/${token}/${TID}/Stop`, '{not json')
    await until(() => got.length === 2)
    expect(got[0].body).toBeInstanceOf(Uint8Array)
    expect(got[0].body.byteOffset).toBe(0)
    expect(got[0].body.buffer.byteLength).toBe(got[0].body.byteLength) // its own buffer: safe to transfer
    expect(Buffer.from(got[0].body).toString('utf8')).toBe('{"session_id":"s","tool_response":{"file":"x"}}')
    expect(Buffer.from(got[1].body).toString('utf8')).toBe('{not json')
  })

  it('the first refusal of each kind is logged, without the address or the token', async () => {
    const logs: string[] = []
    const e = createChatEndpoint({ onHook: () => {}, log: (_l: string, m: string) => logs.push(m) })
    open.push(e)
    const { port, token } = await e.listen()
    for (let i = 0; i < 3; i++) await post(port, `/chat/${token}/${TID}/Stop`, '{}', { Origin: 'http://x.example' })
    for (let i = 0; i < 3; i++) await post(port, `/chat/${token}/${TID}/Stop`, '{}', { Host: 'localhost' })
    for (let i = 0; i < 3; i++) await post(port, `/chat/${'0'.repeat(48)}/${TID}/Stop`, '{}')
    expect(logs).toHaveLength(3)
    for (const m of logs) { expect(m).not.toContain(token); expect(m).not.toContain('/chat/'); expect(m).not.toContain(String(port)) }
  })
})

describe('the endpoint tells the host what arrives (the composer)', () => {
  it('onArrive gets the event name before the response, never a body; a refused request is not one', async () => {
    const order: string[] = []
    const arrived: unknown[][] = []
    const { port, token } = await endpoint(() => order.push('hook'), { onArrive: (...a: unknown[]) => { arrived.push(a); order.push('arrive') } })
    const r = post(port, `/chat/${token}/${TID}/PermissionRequest`, JSON.stringify({ session_id: 's', tool_name: 'Bash' })).then((x) => { order.push('response'); return x })
    expect((await r).status).toBe(200)
    await until(() => order.includes('hook'))
    expect(arrived).toEqual([['PermissionRequest', TID]])
    expect(order.indexOf('arrive')).toBeLessThan(order.indexOf('response'))
    await post(port, `/chat/${'00'.repeat(24)}/${TID}/PermissionRequest`, '{}')
    await post(port, `/chat/${token}/${TID}/SessionStart`, '{}')
    expect(arrived).toEqual([['PermissionRequest', TID]])
  })

  it('an onArrive that throws: the hook is still answered and handed on', async () => {
    const got: string[] = []
    const { port, token } = await endpoint((e) => got.push(e), { onArrive: () => { throw new Error('host gone') } })
    expect((await post(port, `/chat/${token}/${TID}/Stop`, '{}')).status).toBe(200)
    await until(() => got.length === 1)
  })
})

describe('the hook names its terminal (review I-4)', () => {
  it('entries are made for one terminal only: no id, no entries', () => {
    expect(() => chatHookEntries({ port: 4321, token: 'cd'.repeat(24) })).toThrow()
    expect(() => chatHookEntries({ port: 4321, token: 'cd'.repeat(24), id: '../x' })).toThrow()
    const a = chatHookEntries({ port: 4321, token: 'cd'.repeat(24), id: TID })
    const b = chatHookEntries({ port: 4321, token: 'cd'.repeat(24), id: '44444444-4444-4444-8444-444444444444' })
    expect(a.PermissionRequest.hooks[0].url).not.toBe(b.PermissionRequest.hooks[0].url)
  })

  it('a path without a terminal, or with something else in its place: 404, and nothing arrives', async () => {
    const arrived: unknown[][] = []
    const got: string[] = []
    const { port, token } = await endpoint((e) => got.push(e), { onArrive: (...a: unknown[]) => arrived.push(a) })
    expect((await post(port, `/chat/${token}/PermissionRequest`, '{}')).status).toBe(404)
    expect((await post(port, `/chat/${token}/not-a-terminal/PermissionRequest`, '{}')).status).toBe(404)
    expect((await post(port, `/chat/${token}/${TID}/${TID}/PermissionRequest`, '{}')).status).toBe(404)
    await new Promise(r => setTimeout(r, 30))
    expect(arrived).toEqual([])
    expect(got).toEqual([])
    // and the right one: the terminal, with the event, before the body
    expect((await post(port, `/chat/${token}/${TID}/PreToolUse`, '{}')).status).toBe(200)
    expect(arrived).toEqual([['PreToolUse', TID]])
  })
})
