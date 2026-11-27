/**
 * Regression tests for issues found in a whole-branch review, each failing before its fix; the IDs below
 * label the describe blocks. No real network: every server is on 127.0.0.1 (the preview test switch, allowLoopback).
 *
 *   I1  a link in an answer could carry data out when previews are on: a link with a query string, userinfo, a port
 *       or a long / data-like path never gets a card — the page asks nothing, main refuses, the worker refuses before
 *       any lookup; the setting's hint says the whole address goes to the site (ko / en / ja)
 *   I2  turning previews off (or closing the view, or quitting) stops every running fetch at once: no further
 *       request, redirect hop or image request, the sockets destroyed, the cache emptied
 *   M2  main previews only a URL written in a finished answer of that session's open view (the worker has the items)
 *   M3  SPAWN_CHAT_VIEW works only in an unpackaged build
 *   M4  the list's measured heights are pruned with the rows
 *   M5  the changes panel judges "inside the session folder" on paths with `..` resolved by their text; macOS folds case
 *   M6  updated past the verified range: open cards keep working, only new holds stop
 *   M7  Ctrl/⌘+F does nothing for the chat while a dialog, 설정 or the lightbox is open
 *   M8  every chat log line names an error through errWord and a version through versionWord
 *   M9  a NAT64-only network: still refused, the reason said once in fixed words
 *   M10 spike/ is in .gitignore
 * (M1, the send after a redraw nudge, is in tests/chat-redraw.test.ts beside the nudge's own tests.)
 */

import { EventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { createRequire } from 'node:module'
import type { Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Worker } from 'node:worker_threads'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { parseMarkdown } from '../src/chat/markdown'
import { cardLinks, createPageCache, looksLikeData as pageLooksLikeData, previewable } from '../src/chat/preview'
import { pruneToRows } from '../src/chat/virtual'
import { OVERLAY_SELECTOR, overlayOpen } from '../src/chat/find'
import { linesOf } from './chat-helpers'

const require = createRequire(import.meta.url)
const ROOT = join(__dirname, '..')
const read = (...p: string[]) => readFileSync(join(ROOT, ...p), 'utf8')
const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/[^\n]*/g, '$1')

const dirs: string[] = []
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }) })
const tempDir = () => { const d = mkdtempSync(join(tmpdir(), 'spawn-final-')); dirs.push(d); return d }
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

// ---------------------------------------------------------------- a local server that records every request

interface Hit { url: string; at: number }
function recorder() {
  const hits: Hit[] = []
  const closes: { url: string; at: number }[] = []
  const sockets = new Set<Socket>()
  const routes = new Map<string, (req: IncomingMessage, res: ServerResponse) => void>()
  let server!: Server
  let port = 0
  const start = async () => {
    server = createServer((req, res) => {
      const url = req.url ?? ''
      hits.push({ url, at: Date.now() })
      req.socket.once('close', () => closes.push({ url, at: Date.now() }))
      const h = routes.get(url.split('?')[0])
      if (h) h(req, res)
      else { res.writeHead(404); res.end() }
    })
    server.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)) })
    await new Promise<void>(r => server.listen(0, '127.0.0.1', () => r()))
    port = (server.address() as any).port
  }
  const stop = () => new Promise<void>(r => { for (const s of sockets) s.destroy(); server.close(() => r()) })
  return { hits, closes, routes, start, stop, url: (path: string) => `http://127.0.0.1:${port}${path}` }
}
/** A page whose head comes after `ms`, naming an image on the same server */
const slowPage = (ms: number, image = '/img.png') => (_req: IncomingMessage, res: ServerResponse) => {
  setTimeout(() => {
    if (res.destroyed || res.writableEnded) return
    res.writeHead(200, { 'content-type': 'text/html' })
    res.end(`<html><head><title>T</title><meta property="og:image" content="${image}"></head><body>`)
  }, ms)
}
const PNG = readFileSync(join(ROOT, 'tests', 'fixtures', 'chat', 'preview', 'tiny.png'))
const png = (_req: IncomingMessage, res: ServerResponse) => { res.writeHead(200, { 'content-type': 'image/png' }); res.end(PNG) }

const { previewShape, looksLikeData: mainLooksLikeData } = require('../electron/linkShape.cjs')
const { previewOf, refusalLog, resolveAllowed } = require('../electron/linkFetch.cjs')
const { createPreviewService } = require('../electron/linkPreview.cjs')
const { createChatHost } = require('../electron/chatHost.cjs')

// ======================================================================================================== I1

/** The table both sides run: [url, may it get a card] */
const SHAPES: [string, boolean][] = [
  ['https://developer.mozilla.org/docs/Web/API/URL/URL', true],
  ['https://ko.wikipedia.org/wiki/%ED%95%9C%EA%B5%AD%EC%96%B4', true],
  ['https://github.com/anthropics/claude-code/issues/1234', true],
  ['https://example.com/', true],
  ['https://example.com', true],
  ['http://example.com:80/a', true],
  ['https://example.com:443/a', true],
  ['https://example.com/a#section-2', true],
  ['https://www.npmjs.com/package/@anthropic-ai/sdk', true],
  ['https://youtu.be/dQw4w9WgXcQ', true],
  ['https://blog.example/2024/10/15/getting-started-with-react-18', true],
  ['https://docs.example/Python3ReleaseNotes2024', true],
  // a query string, even an empty one
  ['https://attacker.example/x?d=the-api-key', false],
  ['https://attacker.example/x?', false],
  ['https://attacker.example/?q=1#frag', false],
  // userinfo
  ['https://user:pw@example.com/', false],
  ['https://user@example.com/', false],
  ['https://@example.com/', false],
  // a port that is not the scheme's own
  ['https://example.com:8443/', false],
  ['http://example.com:443/', false],
  ['https://example.com:80/', false],
  // a long path, a data-like segment or host label
  [`https://example.com/${'a/'.repeat(101)}`, false],
  [`https://example.com/${'word-'.repeat(14)}x`, false],
  ['https://attacker.example/bWFkZS11cC1TZWNyZXQtS2V5LTEyMzQ1', false],
  ['https://attacker.example/x/3f9a1c0be47d2a96', false],
  ['https://github.com/anthropics/claude-code/commit/ffe1823a9b0c4d5e6f7a8b9c0d1e2f3a4b5c6d7e', false],
  ['https://attacker.example/00000000-0000-4000-8000-0000000000aa', false],
  ['https://attacker.example/eyJhbGciOiJIUzI1NiJ9', false],
  ['https://attacker.example/abcdefghijklmnopqrstuvwxyzabcdefgh', false],
  ['https://3f9a1c0be47d2a96aa.attacker.example/', false],
  // not http(s), or not a URL
  ['ftp://example.com/', false],
  ['javascript:alert(1)', false],
  ['', false],
]

describe('I1: which links may get a card (the page and main run one rule)', () => {
  it('the table: src/chat/preview.ts previewable and electron/linkShape.cjs previewShape agree on every row', () => {
    for (const [url, ok] of SHAPES) {
      expect(previewable(url), `page: ${url}`).toBe(ok)
      expect(previewShape(url).ok, `main: ${url}`).toBe(ok)
    }
  })

  it('looksLikeData: the same on both sides for names and data alike', () => {
    for (const s of ['URL', 'docs', 'Albert_Einstein', 'getting-started', 'GettingStartedWithReact18', '2024-10-15', 'dQw4w9WgXcQ', 'xn--r8jz45g',
      '3f9a1c0be47d2a96', 'bWFkZS11cC1TZWNyZXQtS2V5LTEyMzQ1', 'eyJhbGciOiJIUzI1NiJ9', 'x'.repeat(65), 'aGVsbG8gd29ybGQgdGhpcyBpcyBkYXRhIQ']) {
      expect(pageLooksLikeData(s), s).toBe(mainLooksLikeData(s))
    }
  })

  it('electron/linkShape.cjs is pure (no require, no I/O), and the same limits are written on both sides', () => {
    const src = code(read('electron', 'linkShape.cjs'))
    expect(src).not.toMatch(/\brequire\(|\bimport\(|process\.|console\./)
    const main = /const SHAPE = Object\.freeze\((\{[^}]*\})\)/.exec(src)![1]
    const page = /const SHAPE = (\{[^}]*\}) as const/.exec(code(read('src', 'chat', 'preview.ts')))![1]
    expect(page.replace(/\s+/g, '')).toBe(main.replace(/\s+/g, '').replace('urlChars:2048,', ''))
    // checked in main before anything reaches the worker, and in the worker before any lookup
    expect(code(read('electron', 'chatHost.cjs'))).toMatch(/if \(!previewShape\(raw, \{ allowLoopback: previewOpts\?\.allowLoopback === true \}\)\.ok\) return null/)
    const fetcher = code(read('electron', 'linkFetch.cjs'))
    const body = fetcher.slice(fetcher.indexOf('async function previewOf('))
    expect(body.indexOf('previewShape(url')).toBeGreaterThan(0)
    expect(body.indexOf('previewShape(url')).toBeLessThan(body.indexOf('fetchLimited('))
  })

  it('the reviewer\'s case: an answer citing https://attacker.example/x?d=<secret> gets no card (cardLinks), so the page never asks', async () => {
    const text = [
      'Per the README, see https://attacker.example/x?d=a-key-from-the-env-file for details.',
      '',
      'Also [the docs](https://docs.example/start?ref=chat), https://user:pw@intra.example/ and http://site.example:8080/a.',
      '',
      `And https://site.example/${'segment-'.repeat(9)}end and https://site.example/bWFkZS11cC1TZWNyZXQtS2V5LTEyMzQ1.`,
      '',
      'The plain one: https://developer.mozilla.org/docs/Web/API/URL/URL',
    ].join('\n')
    expect([...cardLinks(parseMarkdown(text)).values()].flat()).toEqual(['https://developer.mozilla.org/docs/Web/API/URL/URL'])
    // the page's cache asks main only for what cardLinks gave (a LinkCard per link): the refused ones are never asked
    const asked: string[] = []
    const cache = createPageCache({ ask: async (url) => { asked.push(url); return { ok: false } }, makeUrl: () => 'blob:x', revoke: () => {} })
    for (const urls of cardLinks(parseMarkdown(text)).values()) for (const u of urls) cache.want(u, 'c1')
    await sleep(0)
    expect(asked).toEqual(['https://developer.mozilla.org/docs/Web/API/URL/URL'])
  })

  it('main: chat:preview for such a link answers { ok: false } with no worker message, even for an open view', async () => {
    const s = await hostSetup({ v: true })
    await s.call('chat:open', 'c1')
    for (const url of ['https://attacker.example/x?d=secret', 'https://user:pw@a.example/', 'https://a.example:8443/', 'https://a.example/3f9a1c0be47d2a96aa', `https://a.example/${'b/'.repeat(101)}`]) {
      expect(await s.call('chat:preview', { id: 'c1', url }), url).toEqual({ ok: false })
    }
    expect(s.previewMsgs()).toEqual([])
  })

  it('the worker (previewOf): refused before any lookup, the kind noted in fixed words', async () => {
    const asked: string[] = []
    const notes: string[] = []
    const resolve = async (name: string) => { asked.push(name); return [{ address: '93.184.216.34', family: 4 }] }
    expect(await previewOf('https://attacker.example/x?d=secret', { resolve, note: (w: string) => notes.push(w) })).toBe(null)
    expect(await previewOf('https://attacker.example/bWFkZS11cC1TZWNyZXQtS2V5LTEyMzQ1', { resolve, note: (w: string) => notes.push(w) })).toBe(null)
    expect(asked).toEqual([])
    expect(notes).toEqual(['query', 'data'])
    const lines: string[] = []
    const log = refusalLog({ write: (m: string) => lines.push(m) })
    log('query'); log('data'); log('path')
    expect(lines).toEqual(['link preview: refused (query) x1', 'link preview: refused (data) x1', 'link preview: refused (path) x1'])
  })

  describe('the late-fetch probe as a test: the real service and fetcher, a local server', () => {
    const srv = recorder()
    beforeAll(async () => { srv.routes.set('/page', slowPage(50)); srv.routes.set('/img.png', png); await srv.start() })
    afterAll(() => srv.stop())

    it('/page?secret=from-the-conversation: no card, and the server never sees a request', async () => {
      const svc = createPreviewService({ fetchCard: (url: string, signal: AbortSignal) => previewOf(url, { allowLoopback: true, signal }) })
      svc.setOn(true)
      expect(await svc.get(srv.url('/page?secret=from-the-conversation#frag'), 'c1')).toBe(null)
      await sleep(300)
      expect(srv.hits).toEqual([])
      // the same page without the query: fetched as before (the test switch's port allowed for a loopback address)
      expect(await svc.get(srv.url('/page'), 'c1')).toMatchObject({ title: 'T', image: { type: 'png' } })
      expect(srv.hits.map(h => h.url)).toEqual(['/page', '/img.png'])
    })
  })

  it('the setting\'s hint says that the whole address goes to the site (ko / en / ja), and which links are never fetched', async () => {
    const view = read('src', 'components', 'SettingsView.tsx')
    const line = view.split('\n').find(l => l.includes("t('링크 미리보기 (채팅)')"))!
    const ko = /hint=\{t\('([^']+)'\)\}/.exec(line)![1]
    expect(ko).toContain('링크 주소 전체가 그 사이트로 가')
    expect(ko).toContain('물음표나 긴 값이 붙은 주소')
    const { default: settingsLocale } = await import('../src/locales/settings')
    expect(settingsLocale.en[ko]).toContain('sends the whole address of the link to that site')
    expect(settingsLocale.en[ko]).toContain('question mark or a long value')
    expect(settingsLocale.ja[ko]).toContain('リンクのアドレス全体がそのサイトに送られ')
    expect(settingsLocale.ja[ko]).toContain('疑問符や長い値を含むアドレス')
  })
})

// ======================================================================================================== I2

describe('I2: off stops every running fetch at once (the real service and fetcher, a local server that records late requests)', () => {
  const srv = recorder()
  beforeAll(async () => {
    srv.routes.set('/page', slowPage(400))
    srv.routes.set('/img.png', png)
    // a redirect that comes late, to a second page
    srv.routes.set('/hop', (_req, res) => { setTimeout(() => { if (!res.destroyed) { res.writeHead(302, { location: '/page2' }); res.end() } }, 400) })
    srv.routes.set('/page2', slowPage(0))
    await srv.start()
  })
  afterAll(() => srv.stop())
  const service = () => createPreviewService({ fetchCard: (url: string, signal: AbortSignal) => previewOf(url, { allowLoopback: true, signal }) })

  it('the reviewer\'s offlate case: previews off 100 ms in → the page\'s socket closed at once, no image request ever (zero late requests)', async () => {
    srv.hits.length = 0; srv.closes.length = 0
    const svc = service()
    svc.setOn(true)
    const t0 = Date.now()
    const p = svc.get(srv.url('/page'), 'c1')
    await sleep(100)
    svc.setOn(false)
    const off = Date.now()
    expect(await p).toBe(null)
    await sleep(1200)
    const late = srv.hits.filter(h => h.at >= off)
    expect(late).toEqual([])
    expect(srv.hits.map(h => h.url)).toEqual(['/page'])
    // the socket went at once (not when the page would have come, 400 ms in)
    expect(srv.closes).toHaveLength(1)
    expect(srv.closes[0].at - off).toBeLessThan(200)
    expect(srv.closes[0].at - t0).toBeLessThan(380)
    // the cache is empty and nothing runs
    expect(svc.stats()).toMatchObject({ cards: 0, running: 0, queued: 0, on: false })
  })

  it('a redirect still to come: no hop after off', async () => {
    srv.hits.length = 0; srv.closes.length = 0
    const svc = service()
    svc.setOn(true)
    const p = svc.get(srv.url('/hop'), 'c1')
    await sleep(100)
    svc.setOn(false)
    expect(await p).toBe(null)
    await sleep(800)
    expect(srv.hits.map(h => h.url)).toEqual(['/hop'])
  })

  it('the view closed (release): what only it wanted stops the same way; what another view wants goes on', async () => {
    srv.hits.length = 0; srv.closes.length = 0
    const svc = service()
    svc.setOn(true)
    const mine = svc.get(srv.url('/page'), 'c1')
    await sleep(100)
    svc.release('c1')
    expect(await mine).toBe(null)
    await sleep(700)
    expect(srv.hits.map(h => h.url)).toEqual(['/page'])
    // two views want it: one closing leaves it running
    srv.hits.length = 0
    const a = svc.get(srv.url('/page'), 'c1')
    const b = svc.get(srv.url('/page'), 'c2')
    await sleep(50)
    svc.release('c1')
    expect(await b).toMatchObject({ title: 'T' })
    expect(await a).toMatchObject({ title: 'T' })
    expect(srv.hits.map(h => h.url)).toEqual(['/page', '/img.png'])
  })

  it('previewOf with a signal already aborted: nothing at all, not even a lookup', async () => {
    const asked: string[] = []
    const ctrl = new AbortController()
    ctrl.abort()
    expect(await previewOf('https://site.example/a', { signal: ctrl.signal, resolve: async (n: string) => { asked.push(n); return [{ address: '93.184.216.34', family: 4 }] } })).toBe(null)
    expect(asked).toEqual([])
  })
})

// ======================================================================================================== M2 + I2 in the real worker

const SID = '00000000-0000-4000-8000-000000000951'
/** A Claude folder whose one conversation has a user message and an answer (both texts given) */
function conversation(user: string, answer: string, partial = false) {
  const claudeDir = tempDir()
  const userDataDir = tempDir()
  const proj = join(claudeDir, 'projects', 'C--Users-user-work-demo')
  mkdirSync(proj, { recursive: true })
  mkdirSync(join(userDataDir, 'session-links'), { recursive: true })
  const L = linesOf('basic.jsonl')
  const u = JSON.parse(L[5].text)
  u.message.content = user
  const a = JSON.parse(L[17].text)
  a.message.content = [{ type: 'text', text: answer }]
  if (partial) a.message.stop_reason = null
  writeFileSync(join(proj, `${SID}.jsonl`), `${JSON.stringify(u)}\n${JSON.stringify(a)}\n`)
  return { claudeDir, userDataDir }
}

function realWorker(claudeDir: string) {
  const worker = new Worker(join(ROOT, 'electron', 'chatWorker.cjs'), { env: { ...process.env, CLAUDE_CONFIG_DIR: claudeDir } })
  const messages: any[] = []
  worker.on('message', (m) => messages.push(m))
  const waitFor = async (cond: () => boolean, ms = 8000) => {
    const end = Date.now() + ms
    while (!cond()) { if (Date.now() > end) throw new Error('timed out'); await sleep(10) }
  }
  const reply = async (req: number) => { await waitFor(() => messages.some(m => m.t === 'reply' && m.req === req)); return messages.find(m => m.t === 'reply' && m.req === req).result }
  const open = async (userDataDir: string, on = true) => {
    worker.postMessage({ t: 'init', userDataDir, version: '2.1.325 (Claude Code)', preview: { allowLoopback: true, on } })
    worker.postMessage({ t: 'terminals', list: [{ id: SID, cwd: 'C:\\Users\\user\\work\\demo', armed: true, status: 'running' }] })
    worker.postMessage({ t: 'open', id: SID })
    await waitFor(() => messages.some(m => m.t === 'update' && m.update.ops.some((o: any) => o.op === 'reset' && o.items.length >= 2)))
  }
  return { worker, messages, waitFor, reply, open }
}

describe('M2 and I2 in the real worker: only a link of the view\'s answers; off, close and quit stop a running fetch', () => {
  const srv = recorder()
  beforeAll(async () => { srv.routes.set('/page', slowPage(400)); srv.routes.set('/quick', slowPage(0)); srv.routes.set('/img.png', png); await srv.start() })
  afterAll(() => srv.stop())

  it('M2: a link in the answer → its card; one only in the user\'s message, one in no message, or another view → { ok: false }, nothing fetched', async () => {
    srv.hits.length = 0
    const answer = srv.url('/quick')
    const userOnly = srv.url('/page')
    const { claudeDir, userDataDir } = conversation(`Look at ${userOnly} please`, `Here it is: ${answer} .`)
    const w = realWorker(claudeDir)
    try {
      await w.open(userDataDir)
      w.worker.postMessage({ t: 'preview', id: SID, url: userOnly, req: 1 })
      expect(await w.reply(1)).toEqual({ ok: false })
      w.worker.postMessage({ t: 'preview', id: SID, url: srv.url('/nowhere'), req: 2 })
      expect(await w.reply(2)).toEqual({ ok: false })
      w.worker.postMessage({ t: 'preview', id: 'another-terminal', url: answer, req: 3 })
      expect(await w.reply(3)).toEqual({ ok: false })
      w.worker.postMessage({ t: 'preview', url: answer, req: 4 })
      expect(await w.reply(4)).toEqual({ ok: false })
      expect(srv.hits).toEqual([])
      w.worker.postMessage({ t: 'preview', id: SID, url: answer, req: 5 })
      expect(await w.reply(5)).toMatchObject({ ok: true, card: { url: answer, title: 'T' } })
      expect(srv.hits.map(h => h.url)).toEqual(['/quick', '/img.png'])
      // the view closed: not any more
      w.worker.postMessage({ t: 'close', id: SID })
      w.worker.postMessage({ t: 'preview', id: SID, url: answer, req: 6 })
      expect(await w.reply(6)).toEqual({ ok: false })
    } finally { await w.worker.terminate() }
  })

  it('M2: an interrupted answer\'s link is not one of the view\'s answers', async () => {
    const url = srv.url('/quick')
    const { claudeDir, userDataDir } = conversation('hi', `Partly: ${url}`, true)
    const w = realWorker(claudeDir)
    try {
      await w.open(userDataDir)
      w.worker.postMessage({ t: 'preview', id: SID, url, req: 1 })
      expect(await w.reply(1)).toEqual({ ok: false })
    } finally { await w.worker.terminate() }
  })

  for (const how of ['previews off', 'the view closed', 'quitting (the worker terminated)'] as const) {
    it(`I2: ${how} while the page is on its way → the socket closed at once, no request after`, async () => {
      srv.hits.length = 0; srv.closes.length = 0
      const url = srv.url('/page')
      const { claudeDir, userDataDir } = conversation('hi', `See ${url} for it.`)
      const w = realWorker(claudeDir)
      let terminated = false
      try {
        await w.open(userDataDir)
        w.worker.postMessage({ t: 'preview', id: SID, url, req: 1 })
        await w.waitFor(() => srv.hits.length === 1)
        const off = Date.now()
        if (how === 'previews off') w.worker.postMessage({ t: 'previews', on: false })
        else if (how === 'the view closed') w.worker.postMessage({ t: 'close', id: SID })
        else { terminated = true; await w.worker.terminate() }
        if (!terminated) expect(await w.reply(1)).toEqual({ ok: false })
        await sleep(1000)
        expect(srv.hits.map(h => h.url)).toEqual(['/page'])
        expect(srv.closes).toHaveLength(1)
        expect(srv.closes[0].at - off).toBeLessThan(300)
      } finally { if (!terminated) await w.worker.terminate() }
    })
  }
})

// ======================================================================================================== main's chat:preview (M2)

const CLAUDE = { id: 'c1', tool: 'claude', status: 'running', chat: 'armed', createdAt: 100 }
class FakeWorker extends EventEmitter {
  posted: any[] = []
  postMessage(m: any) { this.posted.push(m) }
  terminate() { queueMicrotask(() => this.emit('exit', 1)); return Promise.resolve(1) }
  send(m: any) { this.emit('message', m) }
}
async function hostSetup(on: { v: boolean }, extra: any = {}) {
  const workers: FakeWorker[] = []
  const logs: string[] = []
  const host = createChatHost({
    terminals: { list: () => [CLAUDE], refreshSettings: () => {}, armedCount: () => 1 },
    send: () => {}, userDataDir: 'C:\\Users\\user\\AppData\\Roaming\\spawn',
    claudeVersion: async () => '2.1.325 (Claude Code)',
    makeWorker: () => { const w = new FakeWorker(); workers.push(w); return w },
    makeEndpoint: () => ({ listen: async () => ({ port: 4321, token: 'ab'.repeat(24) }), setDraining: () => {}, close: async () => {} }),
    previewsOn: () => on.v, log: (_l: string, m: string) => logs.push(m),
    ...extra,
  })
  await host.enable()
  const handlers = new Map<string, (...a: any[]) => any>()
  host.registerIpc({ handle: (n: string, f: any) => handlers.set(n, f), on: (n: string, f: any) => handlers.set(n, f) }, (fn: any) => (event: any, arg: any) => fn(arg, event))
  const call = (n: string, arg?: any) => handlers.get(n)!({}, arg)
  const previewMsgs = () => workers.flatMap(w => w.posted).filter(m => m.t === 'preview')
  return { host, workers, call, previewMsgs, logs }
}

describe('M2: main asks the worker only for a view the page has open, and says which', () => {
  it('no id, or a view not open → { ok: false }, no worker message; an open view → the worker is asked with its id', async () => {
    const s = await hostSetup({ v: true })
    const url = 'https://developer.mozilla.org/docs/Web/API/URL/URL'
    expect(await s.call('chat:preview', { url })).toEqual({ ok: false })
    expect(await s.call('chat:preview', { id: 'c1', url })).toEqual({ ok: false })
    expect(s.previewMsgs()).toEqual([])
    expect(await s.call('chat:open', 'c1')).toEqual({ ok: true })
    const p = s.call('chat:preview', { id: 'c1', url })
    const [m] = s.previewMsgs()
    expect(m).toEqual({ t: 'preview', id: 'c1', url, req: m.req })
    s.workers[0].send({ t: 'reply', req: m.req, result: { ok: false } })
    expect(await p).toEqual({ ok: false })
    // closed again: refused at once
    s.call('chat:close', 'c1')
    expect(await s.call('chat:preview', { id: 'c1', url })).toEqual({ ok: false })
    expect(s.previewMsgs()).toHaveLength(1)
  })

  it('the page asks with the view\'s id (preload passes it; the page cache hands its owner to ask)', async () => {
    const pre = read('electron', 'preload.cjs')
    expect(pre).toContain("preview: (p) => ipcRenderer.invoke('chat:preview', { id: String(p?.id ?? '').slice(0, 200), url: String(p?.url ?? '').slice(0, 4096) })")
    const owners: string[] = []
    const cache = createPageCache({ ask: async (_url, owner) => { owners.push(owner); return { ok: false } }, makeUrl: () => 'blob:x', revoke: () => {} })
    cache.want('https://a.example/', 'term-1')
    await sleep(0)
    expect(owners).toEqual(['term-1'])
    expect(code(read('src', 'chat', 'preview.ts'))).toContain('bridge.chat.preview({ id: owner, url })')
  })
})

// ======================================================================================================== M3

describe('M3: SPAWN_CHAT_VIEW turns the chat view on only in an unpackaged build', () => {
  it('features.cjs: the variable counts only when !packaged(); packaged() is true when it cannot tell', () => {
    const src = code(read('electron', 'features.cjs'))
    expect(src).toMatch(/const CHAT_VIEW = FEATURES\.chatView === true \|\| \(process\.env\.SPAWN_CHAT_VIEW === '1' && !packaged\(\)\)/)
    expect(src).toMatch(/electron\.app\.isPackaged === false/)
    expect(src).toMatch(/try \{ electron = require\('electron'\) \} catch \{ return true \}/)
    expect(src.match(/SPAWN_CHAT_VIEW/g)).toHaveLength(1)
  })
  it('packaged(): false in plain Node (the tests), where require(\'electron\') is the npm package\'s path', () => {
    const { packaged } = require('../electron/features.cjs')
    // CI installs without the Electron binary (ci.yml: ELECTRON_SKIP_BINARY_DOWNLOAD), so the package has
    // no path.txt and its index.js throws "Electron failed to install correctly" (CI red since 1.10.1).
    // ELECTRON_OVERRIDE_DIST_PATH is the package's own way to name the binary's folder: with it the real
    // package still answers with a path, binary or not. A failed load is not cached, so it is read afresh
    const before = process.env.ELECTRON_OVERRIDE_DIST_PATH
    process.env.ELECTRON_OVERRIDE_DIST_PATH = tmpdir()
    try {
      expect(typeof require('electron')).toBe('string')
      expect(packaged()).toBe(false)
    } finally {
      if (before === undefined) delete process.env.ELECTRON_OVERRIDE_DIST_PATH
      else process.env.ELECTRON_OVERRIDE_DIST_PATH = before
    }
  })
})

// ======================================================================================================== M4

describe('M4: the list\'s maps are pruned with the rows', () => {
  it('pruneToRows: past rows + 64 keys, every key neither a row nor mounted goes', () => {
    const rows = Array.from({ length: 10 }, (_, i) => ({ key: `r${i}` }))
    const heights = new Map<string, number>()
    for (let i = 0; i < 10; i++) heights.set(`r${i}`, 40)
    for (let i = 0; i < 60; i++) heights.set(`live:${i}`, 30)
    expect(pruneToRows(heights, rows, new Set())).toBe(0)
    for (let i = 60; i < 80; i++) heights.set(`live:${i}`, 30)
    const mounted = new Set(['live:79'])
    expect(pruneToRows(heights, rows, mounted)).toBe(79)
    expect([...heights.keys()].sort()).toEqual([...rows.map(r => r.key), 'live:79'].sort())
  })
  it('ChatList prunes heights.current with refs.current, after every change of the rows', () => {
    const src = code(read('src', 'components', 'chat', 'ChatList.tsx'))
    expect(src).toMatch(/pruneToRows\(refs\.current, rows, elements\.current\)\s*\n\s*pruneToRows\(heights\.current, rows, elements\.current\)\s*\n\s*\}, \[rows\]\)/)
  })
})

// ======================================================================================================== M5

describe('M5: inside the session folder is judged on resolved paths (no disk), case folded on Windows and macOS', () => {
  const { relFile, lexicalPath } = require('../electron/chatItems.cjs')
  const { fileOf } = require('../electron/chatChanges.cjs')
  it('C:/proj/../etc/x is outside C:/proj (named as recorded, marked outside); C:/proj/src/../lib/a.ts is lib/a.ts', () => {
    expect(relFile('C:/proj/../etc/x', 'C:/proj')).toBe('C:/proj/../etc/x')
    expect(fileOf('C:/proj/../etc/x', 'C:/proj')).toMatchObject({ name: 'C:/proj/../etc/x', outside: true })
    expect(fileOf('C:\\proj\\..\\etc\\x', 'C:\\proj')).toMatchObject({ outside: true })
    expect(relFile('C:/proj/src/../lib/a.ts', 'C:/proj')).toBe('lib/a.ts')
    expect(fileOf('C:/proj/./src/a.ts', 'C:/proj')).toMatchObject({ name: 'src/a.ts', outside: false })
    // a relative path that climbs out is outside too
    expect(fileOf('../other/x.ts', 'C:/proj')).toMatchObject({ outside: true })
    // the same file written two ways is one file (one key)
    expect(fileOf('C:/proj/../etc/x', 'C:/proj').key).toBe(fileOf('C:/etc/x', 'C:/proj').key)
    expect(lexicalPath('/a/b/../../../c')).toBe('/c')
    expect(lexicalPath('a/../../c')).toBe('../c')
  })
  it('macOS: Src/a.ts and src/a.ts are one file (each name still as recorded); Linux keeps them apart', () => {
    const cwd = '/Users/user/work/demo'
    const mac = [fileOf(`${cwd}/Src/a.ts`, cwd, 'darwin'), fileOf(`${cwd}/src/a.ts`, cwd, 'darwin')]
    expect(mac.map(f => f.name)).toEqual(['Src/a.ts', 'src/a.ts'])
    expect(mac[0].key).toBe(mac[1].key)
    expect(relFile('/users/user/Work/demo/a.ts', cwd, 'darwin')).toBe('a.ts')
    const linux = [fileOf(`${cwd}/Src/a.ts`, cwd, 'linux'), fileOf(`${cwd}/src/a.ts`, cwd, 'linux')]
    expect(linux[0].key).not.toBe(linux[1].key)
    expect(relFile('/users/user/Work/demo/a.ts', cwd, 'linux')).toBe('/users/user/Work/demo/a.ts')
  })
  it('the index groups them on macOS (createChangeIndex platform)', () => {
    const { createChangeIndex } = require('../electron/chatChanges.cjs')
    const cwd = '/Users/user/work/demo'
    const edit = (id: string, file: string, order: number) => [
      { type: 'assistant', uuid: `a${id}`, timestamp: '2026-11-14T12:00:00Z', message: { content: [{ type: 'tool_use', id, name: 'Edit', input: { file_path: file, old_string: 'a', new_string: 'b' } }] } },
      { type: 'user', uuid: `u${id}`, timestamp: '2026-11-14T12:00:01Z', message: { content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] }, toolUseResult: { filePath: file, structuredPatch: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-a', '+b'] }] } },
    ].map((o, k) => [o, order * 10 + k] as const)
    for (const [platform, files] of [['darwin', 1], ['linux', 2]] as const) {
      const index = createChangeIndex({ cwd, platform })
      for (const [o, off] of [...edit('toolu_1', `${cwd}/Src/a.ts`, 1), ...edit('toolu_2', `${cwd}/src/a.ts`, 2)]) index.line(o, off)
      expect(index.summary().files, platform).toBe(files)
    }
  })
})

// ======================================================================================================== M6

describe('M6: updated past the verified range mid-run: the cards open now keep working, only new holds stop', () => {
  const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
  it('ok → new: an open card still answers; a new held request is handed back at once; back to ok: new holds open again; → old: all go', async () => {
    let v: string | null = '2.1.325 (Claude Code)'
    let stamp = 'h|1|1'
    const endpoints: any[] = []
    const workers: FakeWorker[] = []
    const host = createChatHost({
      terminals: { list: () => [{ id: A, tool: 'claude', status: 'running', chat: 'armed', createdAt: 1 }], refreshSettings: () => {}, armedCount: () => 1, typeForChat: () => true, clearAsking: () => {} },
      send: () => {}, userDataDir: 'C:\\Users\\user\\AppData\\Roaming\\spawn',
      claudeVersion: async () => v, binaryStamp: () => stamp,
      makeWorker: () => { const w = new FakeWorker(); workers.push(w); return w },
      makeEndpoint: (opts: any) => { const e = { opts, listen: async () => ({ port: 4321, token: 'ab'.repeat(24) }), setDraining: () => {}, close: async () => {} }; endpoints.push(e); return e },
      log: () => {},
    })
    await host.enable()
    const step = async (version: string | null, n: number) => { v = version; stamp = `h|${n}|1`; host.noteCreate(); await sleep(0); await host.ready(); await sleep(0) }
    const request = () => {
      const got: (string | null)[] = []
      const registry = endpoints[0].opts.holds()
      const holdId = registry ? registry.open('permission', (b: string | null) => got.push(b), { id: A }) : null
      if (holdId) workers[0].send({ t: 'hold-bind', holdId, id: A, kind: 'permission', key: 'k', data: { rules: [{ toolName: 'Bash', ruleContent: 'ls' }] } })
      return { got, holdId }
    }
    const handlers = new Map<string, (...a: any[]) => any>()
    host.registerIpc({ handle: (n: string, f: any) => handlers.set(n, f), on: (n: string, f: any) => handlers.set(n, f) }, (fn: any) => (_e: any, arg: any) => fn(arg))
    handlers.get('chat:visible')!({}, { id: A })
    const open = request()
    expect(open.holdId).toBeTruthy()
    await step('2.3.0 (Claude Code)', 2)
    // the card open now: not released, and still answers
    expect(open.got).toEqual([])
    // a new held request: the endpoint gets no registry (answered at once there: the terminal's own dialog)
    expect(request().holdId).toBe(null)
    expect(handlers.get('chat:answer')!({}, { id: A, holdId: open.holdId, choice: 'allow' })).toEqual({ ok: true })
    expect(JSON.parse(open.got[0]!).hookSpecificOutput.decision.behavior).toBe('allow')
    // back in the verified range: holds open again
    await step('2.1.330 (Claude Code)', 3)
    const again = request()
    expect(again.holdId).toBeTruthy()
    // an older version: every open hold goes back to the terminal, as before
    await step('2.0.9 (Claude Code)', 4)
    expect(again.got).toEqual([null])
    expect(endpoints[0].opts.holds()).toBe(null)
  })
})

// ======================================================================================================== M7

describe('M7: Ctrl/⌘+F does nothing for the chat while a dialog, 설정 or the lightbox is open', () => {
  it('overlayOpen: true when the page has a dialog (role dialog / alertdialog, aria-modal)', () => {
    const doc = (has: boolean) => ({ querySelector: (s: string) => (s === OVERLAY_SELECTOR && has ? {} : null) })
    expect(overlayOpen(doc(true))).toBe(true)
    expect(overlayOpen(doc(false))).toBe(false)
    expect(overlayOpen(null)).toBe(false)
    for (const sel of ['[role="dialog"]', '[role="alertdialog"]', '[aria-modal="true"]']) expect(OVERLAY_SELECTOR).toContain(sel)
    // 설정 and the lightbox are such dialogs
    expect(read('src', 'components', 'SettingsView.tsx')).toMatch(/className="set-modal" role="dialog"/)
    expect(read('src', 'components', 'chat', 'Lightbox.tsx')).toMatch(/role="dialog"\s+aria-modal="true"/)
  })
  it('ChatView\'s find key returns before preventDefault while one is open', () => {
    const src = code(read('src', 'components', 'ChatView.tsx'))
    const at = src.indexOf('const onFindKey')
    const body = src.slice(at, src.indexOf('openFind()', at))
    // (then the split view's pane check, also before it: 2026-11-27)
    expect(body).toMatch(/if \(overlayOpen\(document\)\) return\s*\n(?:\s*\/\/[^\n]*\n)?(?:\s*if \(!findOwner\([^\n]*\) return\s*\n)?\s*e\.preventDefault\(\)/)
  })
})

// ======================================================================================================== M8

describe('M8: every chat log line through the fixed-words helpers', () => {
  const { versionWord } = require('../electron/chatLog.cjs')
  it('versionWord: the version number only, or unknown', () => {
    expect(versionWord('2.1.325 (Claude Code)')).toBe('2.1.325')
    expect(versionWord('  v2.3.0 extra C:\\Users\\name\\x')).toBe('2.3.0')
    expect(versionWord('Claude Code at /home/name/bin')).toBe('unknown')
    expect(versionWord(null)).toBe('unknown')
    expect(versionWord('2.1.325.7.8')).toBe('unknown')
  })
  it('a version that is not armed: the log names its number, never the rest of the line', async () => {
    const logs: string[] = []
    const host = createChatHost({
      terminals: { list: () => [], refreshSettings: () => {}, armedCount: () => 0 }, send: () => {}, userDataDir: 'C:\\x',
      claudeVersion: async () => '1.0.9 (Claude Code) C:\\Users\\name\\secret', makeWorker: () => new FakeWorker(),
      makeEndpoint: () => ({ listen: async () => ({ port: 1, token: 'ab'.repeat(24) }), setDraining: () => {}, close: async () => {} }),
      log: (_l: string, m: string) => logs.push(m),
    })
    await host.enable()
    expect(logs).toContain('chat view: Claude Code 1.0.9 is not armed')
    for (const l of logs) expect(l).not.toMatch(/name|secret|Claude Code\)/)
    const none = createChatHost({
      terminals: { list: () => [], refreshSettings: () => {}, armedCount: () => 0 }, send: () => {}, userDataDir: 'C:\\x',
      claudeVersion: async () => null, makeWorker: () => new FakeWorker(),
      makeEndpoint: () => ({ listen: async () => ({ port: 1, token: 'ab'.repeat(24) }), setDraining: () => {}, close: async () => {} }),
      log: (_l: string, m: string) => logs.push(m),
    })
    await none.enable()
    expect(logs).toContain('chat view: Claude Code unknown is not armed')
  })
  it('no log line of electron/chat*.cjs names an error but through errWord (no err?.code, err?.name, err.message)', () => {
    for (const f of ['chatHost.cjs', 'chatHolds.cjs', 'chatImages.cjs', 'chatLens.cjs', 'chatHooks.cjs', 'chatWorker.cjs']) {
      const src = code(read('electron', f))
      expect(src, f).not.toMatch(/\$\{err\?\.(code|name|message)/)
      expect(src, f).not.toMatch(/\$\{typeof err\?\.code/)
      expect(src, f).not.toMatch(/\$\{version \?\?/)
    }
  })
})

// ======================================================================================================== M9

describe('M9: a NAT64-only network is still refused, and the log says why once', () => {
  it('every address in 64:ff9b::/96 → refused as nat64 (no request); one public address beside it → address as before', async () => {
    const nat = await resolveAllowed('site.example', { resolve: async () => [{ address: '64:ff9b::5db8:d822', family: 6 }, { address: '64:ff9b::5db8:d823', family: 6 }] })
    expect(nat).toEqual({ ok: false, why: 'nat64' })
    const mixed = await resolveAllowed('site2.example', { resolve: async () => [{ address: '93.184.216.34', family: 4 }, { address: '64:ff9b::5db8:d822', family: 6 }] })
    expect(mixed).toEqual({ ok: false, why: 'address' })
    const local = await resolveAllowed('site3.example', { resolve: async () => [{ address: '64:ff9b::7f00:1', family: 6 }] })
    expect(local.ok).toBe(false)
  })
  it('the log: one fixed sentence, once, whatever the count', () => {
    const lines: string[] = []
    let t = 0
    const note = refusalLog({ write: (m: string) => lines.push(m), now: () => (t += 120_000) })
    for (let i = 0; i < 5; i++) note('nat64')
    expect(lines).toEqual(['link preview: refused (address): every address of a name was a NAT64 one (64:ff9b::/96), as on an IPv6-only network; no preview can be fetched on this network'])
  })
  it('previewOf notes it', async () => {
    const notes: string[] = []
    expect(await previewOf('https://site4.example/a', { resolve: async () => [{ address: '64:ff9b::5db8:d822', family: 6 }], note: (w: string) => notes.push(w) })).toBe(null)
    expect(notes).toEqual(['nat64'])
  })
})

// ======================================================================================================== M10

describe('M10: the spike stays out of the repository', () => {
  it('.gitignore lists spike/', () => {
    expect(read('.gitignore').split(/\r?\n/)).toContain('spike/')
  })
})

