/**
 * electron/chatWorker.cjs — the real worker thread hosting the lens: told the
 * terminals and asked to open one, it reads the transcript under
 * CLAUDE_CONFIG_DIR and answers with a reset; hook bodies posted to it give
 * the expected tool rows; it replies to requests; terminate() is clean.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Worker } from 'node:worker_threads'
import { afterAll, describe, expect, it } from 'vitest'
import { hooksOf, linesOf } from './chat-helpers'

const dirs: string[] = []
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }) })
const tempDir = () => { const d = mkdtempSync(join(tmpdir(), 'spawn-chat-worker-')); dirs.push(d); return d }

const SID = '00000000-0000-4000-8000-000000000902'

describe('the chat worker', () => {
  it('reads, follows hooks, replies, and stops cleanly', async () => {
    const claudeDir = tempDir()
    const userDataDir = tempDir()
    mkdirSync(join(claudeDir, 'projects', 'C--Users-user-work-demo'), { recursive: true })
    mkdirSync(join(userDataDir, 'session-links'), { recursive: true })
    // the session's prompt only: the tool rows come from the hooks
    writeFileSync(join(claudeDir, 'projects', 'C--Users-user-work-demo', `${SID}.jsonl`), linesOf('tools.jsonl')[0].text + '\n')

    const worker = new Worker(join(__dirname, '..', 'electron', 'chatWorker.cjs'), { env: { ...process.env, CLAUDE_CONFIG_DIR: claudeDir } })
    const messages: any[] = []
    const errors: any[] = []
    worker.on('message', (m) => messages.push(m))
    worker.on('error', (e) => errors.push(e))
    const waitFor = async (cond: () => boolean, ms = 5000) => {
      const end = Date.now() + ms
      while (!cond()) { if (Date.now() > end) throw new Error('timed out: ' + JSON.stringify(messages).slice(0, 500)); await new Promise(r => setTimeout(r, 10)) }
    }
    const ops = () => messages.filter(m => m.t === 'update').flatMap(m => m.update.ops)
    const row = (id: string) => ops().filter((o: any) => o.op === 'upsert').flatMap((o: any) => o.items).filter((i: any) => i.id === id).at(-1)

    worker.postMessage({ t: 'init', userDataDir, version: '2.1.323 (Claude Code)' })
    worker.postMessage({ t: 'terminals', list: [{ id: SID, cwd: 'C:\\Users\\user\\work\\demo', armed: true, status: 'running' }] })
    worker.postMessage({ t: 'open', id: SID })
    await waitFor(() => ops().some((o: any) => o.op === 'reset'))
    const reset = ops().find((o: any) => o.op === 'reset')
    expect(reset.items.map((i: any) => i.kind)).toEqual(['user'])
    expect(reset.status).toMatchObject({ state: 'idle', banner: null, empty: false, version: '2.1.323' })

    const hooks = hooksOf('hooks-tools.jsonl')
    for (const h of hooks.slice(0, 4)) worker.postMessage({ t: 'hook', event: h.event, body: h.body, at: Date.now() })
    await waitFor(() => row('toolu_fixture07')?.state === 'done')
    // UserPromptSubmit for this terminal: main hears it (the composer's ledger)
    expect(messages.filter(m => m.t === 'prompt')).toEqual([{ t: 'prompt', id: SID }])
    expect(row('toolu_fixture07')).toMatchObject({ tool: 'Edit', durationMs: 8840 })
    // as main sends them: the raw bytes, parsed here (a body that is not JSON is dropped)
    worker.postMessage({ t: 'hook', event: 'Stop', raw: new Uint8Array(Buffer.from('{not json')), at: Date.now() })
    for (const h of hooks.slice(4, 6)) worker.postMessage({ t: 'hook', event: h.event, raw: new Uint8Array(Buffer.from(JSON.stringify(h.body))), at: Date.now() })
    await waitFor(() => row('toolu_fixture05')?.state === 'failed')
    const states = ops().filter((o: any) => o.op === 'upsert').flatMap((o: any) => o.items).filter((i: any) => i.id === 'toolu_fixture07').map((i: any) => i.waiting ?? i.state)
    expect(states).toEqual(['running', 'permission', 'done'])

    // requests are answered by a reply carrying their number
    worker.postMessage({ t: 'older', id: SID, req: 7 })
    await waitFor(() => messages.some(m => m.t === 'reply' && m.req === 7))
    expect(messages.find(m => m.t === 'reply' && m.req === 7).result).toEqual({ ok: true, loaded: 0 })
    // resync: the view again as it is (a reset), answered by a reply
    const resets = () => ops().filter((o: any) => o.op === 'reset').length
    const before = resets()
    worker.postMessage({ t: 'resync', id: SID, req: 8 })
    await waitFor(() => messages.some(m => m.t === 'reply' && m.req === 8))
    expect(messages.find(m => m.t === 'reply' && m.req === 8).result).toEqual({ ok: true })
    await waitFor(() => resets() === before + 1)
    // revs: one by one
    const revs = messages.filter(m => m.t === 'update').map(m => m.update.rev)
    expect(revs).toEqual(revs.map((_, i) => i + 1))
    // the log never carries transcript text
    for (const m of messages.filter(x => x.t === 'log')) expect(m.msg).not.toMatch(/math\.js|mul\(/)

    // a held request is bound (the URL's terminal is the session's) or passed; hold-state moves its card
    const permission = hooksOf('hooks-permission.jsonl').find(h => h.event === 'PermissionRequest')!
    const held = { ...permission.body, session_id: SID }
    worker.postMessage({ t: 'hook', event: 'PermissionRequest', raw: new Uint8Array(Buffer.from(JSON.stringify(held))), at: Date.now(), hold: 'wh1', id: SID })
    worker.postMessage({ t: 'hook', event: 'PermissionRequest', raw: new Uint8Array(Buffer.from('{not json')), at: Date.now(), hold: 'wh2', id: SID })
    await waitFor(() => messages.some(m => m.t === 'hold-pass' && m.holdId === 'wh2'))
    expect(messages.find(m => m.t === 'hold-bind')).toMatchObject({ holdId: 'wh1', id: SID, kind: 'permission' })
    expect(messages.find(m => m.t === 'hold-pass')).toEqual({ t: 'hold-pass', holdId: 'wh2', why: 'shape' })
    worker.postMessage({ t: 'hold-state', holdId: 'wh1', state: 'sent', choice: 'allow' })
    const lastStatus = () => ops().filter((o: any) => o.op === 'status' || o.op === 'reset').at(-1).status
    await waitFor(() => lastStatus().asks?.[0]?.state === 'sent')
    expect(lastStatus().asks[0]).toMatchObject({ holdId: 'wh1', sent: 'allow' })

    await worker.terminate()
    expect(errors).toEqual([])
  }, 20_000)
})
