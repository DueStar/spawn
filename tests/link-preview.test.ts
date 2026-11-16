/**
 * Link previews II (Phase 5, Task 5.10): the setting, the worker's service, main's gate, the page's cards.
 *
 *   electron/linkPreview.cjs  the worker's preview service over linkFetch.cjs previewOf: the memory caches (200 cards:
 *                             success 24 h, failure 30 min; images ≤ 16 MB, least recently used first), the load (≤ 3 at
 *                             once, ≤ 1 per host, ≤ 24 waiting, the oldest dropped; the same URL in flight shared), the
 *                             on/off switch (off: every cache emptied, the queue dropped). Nothing on disk.
 *   electron/chatWorker.cjs   `preview` / `previews` messages; the image's bytes transferred to main
 *   electron/chatHost.cjs     chat:preview: { ok: false } at once, with no worker message, unless previews are on; the
 *                             URL checked again (≤ 2048, http/https); the worker's card checked before the page has it
 *   electron/main.cjs         previewsOn and the test switch, only inside the CHAT_VIEW host, the switch behind
 *                             !app.isPackaged
 *   src/chat/preview.ts       the page's cache (≤ 120 cards, blob: URLs it made, revoked on eviction, when the view goes,
 *                             when previews go off), which links of a text get a card, the card's site line
 * No real network: the worker test serves the fixtures on 127.0.0.1 with the test switch.
 */

import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { createRequire } from 'node:module'
import { EventEmitter } from 'node:events'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Worker } from 'node:worker_threads'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { parseMarkdown } from '../src/chat/markdown'
import { PAGE_CARDS, cardLinks, createPageCache, hostLine } from '../src/chat/preview'
import { linesOf } from './chat-helpers'

const require = createRequire(import.meta.url)
const { PREVIEW_CAPS, createPreviewService } = require('../electron/linkPreview.cjs')
const { createChatHost } = require('../electron/chatHost.cjs')

const ROOT = join(__dirname, '..')
const read = (...p: string[]) => readFileSync(join(ROOT, ...p), 'utf8')
const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/[^\n]*/g, '$1')
const fixture = (name: string) => readFileSync(join(ROOT, 'tests', 'fixtures', 'chat', 'preview', name))

// ---------------------------------------------------------------- the worker's service

/** A fetch the test settles by hand: each call waits until resolved */
function handFetch() {
  const calls: { url: string; resolve: (card: any) => void }[] = []
  let running = 0
  let most = 0
  const hosts = new Map<string, number>()
  let mostPerHost = 0
  const fetchCard = (url: string) => new Promise((resolve) => {
    running++
    most = Math.max(most, running)
    const h = new URL(url).hostname
    hosts.set(h, (hosts.get(h) ?? 0) + 1)
    mostPerHost = Math.max(mostPerHost, hosts.get(h)!)
    calls.push({ url, resolve: (card) => { running--; hosts.set(h, hosts.get(h)! - 1); resolve(card) } })
  })
  return { fetchCard, calls, stats: () => ({ running, most, mostPerHost }) }
}
const card = (url: string, imageBytes = 0) => ({
  url, site: new URL(url).hostname, via: null, title: `T ${url}`, description: 'D',
  image: imageBytes ? { bytes: new Uint8Array(imageBytes), type: 'png', width: 3, height: 2 } : null,
})
const flush = () => new Promise(r => setTimeout(r, 0))

describe('linkPreview.cjs: the caps are the policy\'s', () => {
  it('200 cards, 24 h / 30 min, 16 MB of images, 3 at once, 1 per host, 24 waiting', () => {
    expect(PREVIEW_CAPS).toEqual({ cards: 200, okMs: 24 * 3600_000, failMs: 30 * 60_000, imageBytes: 16 << 20, running: 3, perHost: 1, queue: 24 })
    expect(Object.isFrozen(PREVIEW_CAPS)).toBe(true)
  })
  it('(5.9b) a caller cannot raise them: 10 at once / 5 per host asked, still 3 at once and 1 per host', async () => {
    const f = handFetch()
    const svc = createPreviewService({ fetchCard: f.fetchCard, caps: { running: 10, perHost: 5, queue: 1000, cards: 1e6 } })
    svc.setOn(true)
    for (let i = 0; i < 6; i++) svc.get(`https://h${i}.example/a`)
    svc.get('https://h0.example/b')
    await flush()
    expect(f.stats().most).toBe(3)
    expect(f.stats().mostPerHost).toBe(1)
    for (const c of f.calls.splice(0)) c.resolve(null)
    await flush()
    svc.setOn(false)
  })
})

describe('linkPreview.cjs: the cache', () => {
  it('off at first: nothing is fetched until it is turned on', async () => {
    const f = handFetch()
    const s = createPreviewService({ fetchCard: f.fetchCard })
    expect(await s.get('https://a.test/')).toBe(null)
    expect(f.calls).toHaveLength(0)
  })

  it('the same URL in flight → one fetch, both callers get its card', async () => {
    const f = handFetch()
    const s = createPreviewService({ fetchCard: f.fetchCard })
    s.setOn(true)
    const a = s.get('https://a.test/x')
    const b = s.get('https://a.test/x')
    await flush()
    expect(f.calls).toHaveLength(1)
    f.calls[0].resolve(card('https://a.test/x'))
    expect(await a).toMatchObject({ title: 'T https://a.test/x' })
    expect(await b).toBe(await a)
  })

  it('a card is kept 24 h, a failure 30 min (a fake clock)', async () => {
    let t = 1_000_000
    const f = handFetch()
    const s = createPreviewService({ fetchCard: f.fetchCard, now: () => t })
    s.setOn(true)
    const ok = s.get('https://ok.test/'); await flush(); f.calls[0].resolve(card('https://ok.test/')); await ok
    const bad = s.get('https://bad.test/'); await flush(); f.calls[1].resolve(null); expect(await bad).toBe(null)
    // within their times: from memory
    t += 29 * 60_000
    expect(await s.get('https://ok.test/')).toMatchObject({ title: 'T https://ok.test/' })
    expect(await s.get('https://bad.test/')).toBe(null)
    expect(f.calls).toHaveLength(2)
    // the failure's 30 minutes are over: asked again; the card's 24 hours are not
    t += 2 * 60_000
    const again = s.get('https://bad.test/'); await flush()
    expect(f.calls).toHaveLength(3)
    f.calls[2].resolve(null); await again
    expect(await s.get('https://ok.test/')).toMatchObject({ title: 'T https://ok.test/' })
    expect(f.calls).toHaveLength(3)
    t += 24 * 3600_000
    const late = s.get('https://ok.test/'); await flush()
    expect(f.calls).toHaveLength(4)
    f.calls[3].resolve(card('https://ok.test/')); await late
  })

  it('a fetch that throws is a failure (null), cached like one', async () => {
    let n = 0
    const s = createPreviewService({ fetchCard: async () => { n++; throw new Error('boom') } })
    s.setOn(true)
    expect(await s.get('https://x.test/')).toBe(null)
    expect(await s.get('https://x.test/')).toBe(null)
    expect(n).toBe(1)
  })

  it('201 cards → the oldest goes; one read again moves to the back', async () => {
    let n = 0
    const fetched: string[] = []
    const s = createPreviewService({ fetchCard: async (url: string) => { n++; fetched.push(url); return card(url) } })
    s.setOn(true)
    for (let i = 0; i < 200; i++) await s.get(`https://h${i}.test/`)
    expect(s.stats().cards).toBe(200)
    // h0 used again: h1 is now the oldest
    await s.get('https://h0.test/')
    expect(n).toBe(200)
    await s.get('https://h200.test/')
    expect(s.stats().cards).toBe(200)
    expect(n).toBe(201)
    await s.get('https://h0.test/')
    expect(n).toBe(201)
    await s.get('https://h1.test/')
    expect(n).toBe(202)
  })

  it('17 MB of images → the least recently used go until ≤ 16 MB', async () => {
    const MB = 1 << 20
    let n = 0
    const s = createPreviewService({ fetchCard: async (url: string) => { n++; return card(url, 2 * MB) } })
    s.setOn(true)
    for (let i = 0; i < 8; i++) await s.get(`https://img${i}.test/`)
    expect(s.stats().imageBytes).toBe(16 * MB)
    // img0 read again: img1 is the least recently used
    await s.get('https://img0.test/')
    await s.get('https://img8.test/')
    expect(s.stats().imageBytes).toBeLessThanOrEqual(16 * MB)
    expect(n).toBe(9)
    await s.get('https://img0.test/')
    expect(n).toBe(9)
    await s.get('https://img1.test/')
    expect(n).toBe(10)
    // a card without an image is never evicted for the images' sake
    const t = createPreviewService({ fetchCard: async (url: string) => card(url, url.includes('big') ? 2 * MB : 0) })
    t.setOn(true)
    await t.get('https://plain.test/')
    for (let i = 0; i < 9; i++) await t.get(`https://big${i}.test/`)
    expect(t.stats().imageBytes).toBeLessThanOrEqual(16 * MB)
    expect(t.stats().cards).toBe(9)
  })
})

describe('linkPreview.cjs: the load', () => {
  it('30 URLs at once: ≤ 3 running, ≤ 1 per host, ≤ 24 waiting (the oldest waiting dropped, never fetched)', async () => {
    const f = handFetch()
    const s = createPreviewService({ fetchCard: f.fetchCard })
    s.setOn(true)
    const urls = Array.from({ length: 30 }, (_, i) => `https://h${i % 10}.test/${i}`)
    const got = urls.map(u => s.get(u))
    await flush()
    expect(f.calls.map(c => c.url)).toEqual([urls[0], urls[1], urls[2]])
    expect(s.stats()).toMatchObject({ running: 3, queued: 24 })
    // the three oldest waiting (urls 3, 4, 5) were dropped: their callers hear null
    expect(await Promise.race([got[3], flush().then(() => 'pending')])).toBe(null)
    expect(await got[4]).toBe(null)
    expect(await got[5]).toBe(null)
    // settle everything as it comes
    for (let k = 0; k < 40 && f.calls.some(c => c); k++) {
      const open = f.calls.filter((c: any) => !c.done)
      if (!open.length) break
      for (const c of open) { (c as any).done = true; c.resolve(card(c.url)) }
      await flush(); await flush()
    }
    await Promise.all(got)
    expect(f.stats().most).toBeLessThanOrEqual(3)
    expect(f.stats().mostPerHost).toBe(1)
    const fetched = f.calls.map(c => c.url)
    expect(fetched).toHaveLength(27)
    for (const u of [urls[3], urls[4], urls[5]]) expect(fetched).not.toContain(u)
    expect(new Set(fetched).size).toBe(27)
  })

  it('a waiting URL asked again joins its place in the queue (no second entry)', async () => {
    const f = handFetch()
    const s = createPreviewService({ fetchCard: f.fetchCard })
    s.setOn(true)
    const a = s.get('https://same.test/1')
    const b = s.get('https://same.test/2')
    const c = s.get('https://same.test/2')
    await flush()
    expect(s.stats()).toMatchObject({ running: 1, queued: 1 })
    f.calls[0].resolve(card('https://same.test/1')); await a; await flush()
    expect(f.calls).toHaveLength(2)
    f.calls[1].resolve(card('https://same.test/2'))
    expect(await b).toBe(await c)
  })
})

describe('linkPreview.cjs: off', () => {
  it('setOn(false) empties every cache and drops the queue; a fetch still running is not kept', async () => {
    const f = handFetch()
    const s = createPreviewService({ fetchCard: f.fetchCard })
    s.setOn(true)
    const kept = s.get('https://kept.test/'); await flush(); f.calls[0].resolve(card('https://kept.test/', 1000)); await kept
    expect(s.stats()).toMatchObject({ cards: 1, imageBytes: 1000 })
    const running = s.get('https://run.test/')
    const waiting = [1, 2, 3].map(i => s.get(`https://run.test/${i}`))
    await flush()
    expect(s.stats()).toMatchObject({ running: 1, queued: 3 })
    s.setOn(false)
    expect(s.stats()).toMatchObject({ cards: 0, imageBytes: 0, queued: 0 })
    for (const w of waiting) expect(await w).toBe(null)
    // the running one ends after: nothing of it kept, its caller hears null
    f.calls[1].resolve(card('https://run.test/'))
    expect(await running).toBe(null)
    expect(s.stats().cards).toBe(0)
    // off: nothing is fetched
    expect(await s.get('https://kept.test/')).toBe(null)
    expect(f.calls).toHaveLength(2)
    // on again: the card is fetched again (nothing was kept)
    s.setOn(true)
    const again = s.get('https://kept.test/'); await flush()
    expect(f.calls).toHaveLength(3)
    f.calls[2].resolve(card('https://kept.test/')); await again
  })

  it('clear() empties the caches and keeps the switch', async () => {
    let n = 0
    const s = createPreviewService({ fetchCard: async (u: string) => { n++; return card(u) } })
    s.setOn(true)
    await s.get('https://c.test/')
    s.clear()
    expect(s.stats().cards).toBe(0)
    await s.get('https://c.test/')
    expect(n).toBe(2)
  })
})

describe('linkPreview.cjs: its source', () => {
  const src = read('electron', 'linkPreview.cjs')
  it('requires only linkFetch.cjs (no fs: nothing on disk), and logs nothing itself', () => {
    const reqs = [...src.matchAll(/require\(\s*['"`]([^'"`]+)['"`]\s*\)/g)].map(m => m[1])
    expect(new Set(reqs)).toEqual(new Set(['./linkFetch.cjs']))
    for (const bad of [/\bfs\b/, /writeFile|appendFile|createWriteStream|mkdir/, /console\./, /localStorage|indexedDB/]) expect(code(src), String(bad)).not.toMatch(bad)
  })
})

// ---------------------------------------------------------------- main: chat:preview

const CLAUDE = { id: 'c1', tool: 'claude', status: 'running', chat: 'armed', createdAt: 100 }
class FakeWorker extends EventEmitter {
  posted: any[] = []
  transfers: any[] = []
  postMessage(m: any, t?: any) { this.posted.push(m); this.transfers.push(t) }
  terminate() { queueMicrotask(() => this.emit('exit', 1)); return Promise.resolve(1) }
  send(m: any) { this.emit('message', m) }
}
function hostSetup(on: { v: boolean }, preview: any = { allowLoopback: false }, extra: any = {}) {
  const workers: FakeWorker[] = []
  const host = createChatHost({
    ...extra,
    terminals: { list: () => [CLAUDE], refreshSettings: () => {}, armedCount: () => 1 },
    send: () => {}, userDataDir: 'C:\\Users\\user\\AppData\\Roaming\\spawn',
    claudeVersion: async () => '2.1.323 (Claude Code)',
    makeWorker: () => { const w = new FakeWorker(); workers.push(w); return w },
    makeEndpoint: () => ({ listen: async () => ({ port: 4321, token: 'ab'.repeat(24) }), setDraining: () => {}, close: async () => {} }),
    previewsOn: () => on.v, preview,
  })
  const handlers = new Map<string, (...a: any[]) => any>()
  host.registerIpc({ handle: (n: string, f: any) => handlers.set(n, f), on: (n: string, f: any) => handlers.set(n, f) }, (fn: any) => (event: any, arg: any) => fn(arg, event))
  const call = (n: string, arg?: any) => handlers.get(n)!({}, arg)
  const previewMsgs = () => workers.flatMap(w => w.posted).filter(m => m.t === 'preview')
  return { host, workers, call, handlers, previewMsgs }
}
const PNG = new Uint8Array(fixture('tiny.png'))
const goodCard = (url: string) => ({ url, site: 'developer.mozilla.org', via: null, title: 'URL() constructor', description: 'Creates a URL.', image: { bytes: PNG.slice(), type: 'png', width: 3, height: 2 } })

describe('chatHost: chat:preview', () => {
  it('is registered by registerIpc', () => {
    const s = hostSetup({ v: true })
    expect(s.handlers.has('chat:preview')).toBe(true)
  })

  it('off (the chat off, or the setting off): { ok: false } at once, with no worker message', async () => {
    const on = { v: true }
    const s = hostSetup(on)
    // the chat itself off: no worker at all
    expect(await s.call('chat:preview', { url: 'https://example.com/' })).toEqual({ ok: false })
    expect(s.workers).toHaveLength(0)
    await s.host.enable()
    await s.call('chat:open', 'c1')
    on.v = false
    const before = s.workers[0].posted.length
    expect(await s.call('chat:preview', { id: 'c1', url: 'https://example.com/' })).toEqual({ ok: false })
    expect(s.workers[0].posted.length).toBe(before)
    expect(s.previewMsgs()).toEqual([])
  })

  it('the worker hears the policy at init: the test switch and whether previews are on', async () => {
    const on = { v: false }
    const s = hostSetup(on, { allowLoopback: true })
    await s.host.enable()
    expect(s.workers[0].posted[0]).toMatchObject({ t: 'init', preview: { allowLoopback: true, on: false } })
    const t = hostSetup({ v: true }, { allowLoopback: 'yes' })
    await t.host.enable()
    expect(t.workers[0].posted[0]).toMatchObject({ t: 'init', preview: { allowLoopback: false, on: true } })
  })

  it('a URL main would not open → { ok: false }, no worker message', async () => {
    const s = hostSetup({ v: true })
    await s.host.enable()
    const bad = ['javascript:alert(1)', 'ftp://a.example/', 'file:///C:/x', 'data:text/html,x', `https://a.example/${'x'.repeat(2100)}`, 'https://a.example/a b', 'http://a.example/\nx', '', 42, null]
    await s.call('chat:open', 'c1')
    for (const url of bad) expect(await s.call('chat:preview', { id: 'c1', url }), String(url).slice(0, 30)).toEqual({ ok: false })
    expect(await s.call('chat:preview', 'https://a.example/')).toEqual({ ok: false })
    expect(s.previewMsgs()).toEqual([])
  })

  it('on: the worker is asked; its card is checked and handed on (bytes as a Uint8Array)', async () => {
    const s = hostSetup({ v: true })
    await s.host.enable()
    await s.call('chat:open', 'c1')
    const url = 'https://developer.mozilla.org/docs/Web/API/URL/URL'
    const p = s.call('chat:preview', { id: 'c1', url })
    const [m] = s.previewMsgs()
    expect(m).toEqual({ t: 'preview', id: 'c1', url, req: m.req })
    s.workers[0].send({ t: 'reply', req: m.req, result: { ok: true, card: goodCard(url) } })
    const r = await p
    expect(r).toMatchObject({ ok: true, card: { url, site: 'developer.mozilla.org', via: null, title: 'URL() constructor', description: 'Creates a URL.', image: { type: 'png', width: 3, height: 2 } } })
    expect(r.card.image.bytes).toBeInstanceOf(Uint8Array)
    expect(Buffer.from(r.card.image.bytes).equals(Buffer.from(PNG))).toBe(true)
    expect(Object.keys(r.card).sort()).toEqual(['description', 'image', 'site', 'title', 'url', 'via'])
  })

  it('a card that is not for the URL asked, or not a card → { ok: false }; a bad image → the card without it', async () => {
    const s = hostSetup({ v: true })
    await s.host.enable()
    await s.call('chat:open', 'c1')
    const url = 'https://a.example/'
    const ask = async (result: any) => {
      const p = s.call('chat:preview', { id: 'c1', url })
      const m = s.previewMsgs().at(-1)
      s.workers[0].send({ t: 'reply', req: m.req, result })
      return p
    }
    expect(await ask({ ok: true, card: goodCard('https://b.example/') })).toEqual({ ok: false })
    expect(await ask({ ok: true, card: { ...goodCard(url), title: 42 } })).toEqual({ ok: false })
    expect(await ask({ ok: true, card: null })).toEqual({ ok: false })
    expect(await ask({ ok: false, why: 'address' })).toEqual({ ok: false })
    expect(await ask({ ok: true, card: { ...goodCard(url), image: { ...goodCard(url).image, type: 'svg' } } })).toMatchObject({ ok: true, card: { image: null } })
    expect(await ask({ ok: true, card: { ...goodCard(url), image: { ...goodCard(url).image, bytes: new Uint8Array((2 << 20) + 1) } } })).toMatchObject({ ok: true, card: { image: null } })
    expect(await ask({ ok: true, card: { ...goodCard(url), image: { ...goodCard(url).image, bytes: 'x' } } })).toMatchObject({ ok: true, card: { image: null } })
    expect(await ask({ ok: true, card: { ...goodCard(url), image: { ...goodCard(url).image, width: 5000 } } })).toMatchObject({ ok: true, card: { image: null } })
    // the texts capped as the reader caps them
    const long = await ask({ ok: true, card: { ...goodCard(url), title: 't'.repeat(500), description: 'd'.repeat(900), site: 's'.repeat(400), via: 'v'.repeat(400) } })
    expect(long.card.title.length).toBeLessThanOrEqual(200)
    expect(long.card.description.length).toBeLessThanOrEqual(400)
    expect(long.card.site.length).toBeLessThanOrEqual(300)
    expect(long.card.via.length).toBeLessThanOrEqual(300)
  })

  it('(review) a preview waits its turn: its own 30 s timeout (the worker\'s queue can take longer than 10 s); a timeout answers { ok: false, again: true }', async () => {
    const made: { f: () => void; ms: number; cleared: boolean }[] = []
    const timers = {
      setTimeout: (f: () => void, ms: number) => { const t = { f, ms, cleared: false }; made.push(t); return t },
      clearTimeout: (t: any) => { if (t) t.cleared = true },
    }
    const s = hostSetup({ v: true }, { allowLoopback: false }, { timers })
    await s.host.enable()
    await s.call('chat:open', 'c1')
    const url = 'https://slow.example/'
    const before = made.length
    const p = s.call('chat:preview', { id: 'c1', url })
    const mine = made.slice(before)
    expect(mine.map(t => t.ms)).toEqual([30_000])
    // the other requests keep their 10 s
    const b2 = made.length
    void s.call('chat:changes', 'c1')
    expect(made.slice(b2).map(t => t.ms)).toEqual([10_000])
    // the worker took too long: not the link's fault, so the page may ask again later
    mine[0].f()
    expect(await p).toEqual({ ok: false, again: true })
    // a worker's own failure is a plain { ok: false } (the page keeps it)
    const q = s.call('chat:preview', { id: 'c1', url })
    const m = s.previewMsgs().at(-1)
    s.workers[0].send({ t: 'reply', req: m.req, result: { ok: false } })
    expect(await q).toEqual({ ok: false })
  })

  it('a change of the setting: { t: previews, on } to the worker (off: its caches emptied there)', async () => {
    const on = { v: true }
    const s = hostSetup(on)
    await s.host.enable()
    on.v = false
    s.host.setPreviews()
    expect(s.workers[0].posted.at(-1)).toEqual({ t: 'previews', on: false })
    on.v = true
    s.host.setPreviews()
    expect(s.workers[0].posted.at(-1)).toEqual({ t: 'previews', on: true })
    // the chat off: nothing to tell (no worker), and nothing is said on
    s.host.disable()
    expect(() => s.host.setPreviews()).not.toThrow()
  })
})

// ---------------------------------------------------------------- the real worker

const VIEW_ID = '00000000-0000-4000-8000-000000000952'
const viewDirs: string[] = []
afterAll(() => { for (const d of viewDirs) rmSync(d, { recursive: true, force: true }) })
/**
 * A real worker with one open view whose answer holds `url` (the worker previews only a link written in an answer of
 * the view that asks: the final review's M2). `view(init)` sends init (its userDataDir replaced) and opens the view;
 * `ask` asks for a card for that view.
 */
function viewWorker(url: string) {
  const claudeDir = mkdtempSync(join(tmpdir(), 'spawn-preview-claude-'))
  const userDataDir = mkdtempSync(join(tmpdir(), 'spawn-preview-data-'))
  viewDirs.push(claudeDir, userDataDir)
  const proj = join(claudeDir, 'projects', 'C--Users-user-work-demo')
  mkdirSync(proj, { recursive: true })
  mkdirSync(join(userDataDir, 'session-links'), { recursive: true })
  const L = linesOf('basic.jsonl')
  const answer = JSON.parse(L[17].text)
  answer.message.content = [{ type: 'text', text: `The longest rivers: ${url} .` }]
  writeFileSync(join(proj, `${VIEW_ID}.jsonl`), `${L[5].text}\n${JSON.stringify(answer)}\n`)
  const worker = new Worker(join(ROOT, 'electron', 'chatWorker.cjs'), { env: { ...process.env, CLAUDE_CONFIG_DIR: claudeDir } })
  const messages: any[] = []
  worker.on('message', (m) => messages.push(m))
  const waitFor = async (cond: () => boolean) => {
    const end = Date.now() + 8000
    while (!cond()) { if (Date.now() > end) throw new Error('timed out'); await new Promise(r => setTimeout(r, 10)) }
  }
  const view = async (init: any) => {
    worker.postMessage({ ...init, userDataDir })
    worker.postMessage({ t: 'terminals', list: [{ id: VIEW_ID, cwd: 'C:\\Users\\user\\work\\demo', armed: true, status: 'running' }] })
    worker.postMessage({ t: 'open', id: VIEW_ID })
    await waitFor(() => messages.some(m => m.t === 'update' && m.update.ops.some((o: any) => o.op === 'reset' && o.items.length >= 2)))
  }
  const ask = async (u: string, req: number) => {
    worker.postMessage({ t: 'preview', id: VIEW_ID, url: u, req })
    await waitFor(() => messages.some(m => m.t === 'reply' && m.req === req))
    return messages.find(m => m.t === 'reply' && m.req === req).result
  }
  return { worker, messages, view, ask }
}

describe('chatWorker: previews in the worker (a real worker; the fixtures on 127.0.0.1, the test switch)', () => {
  let server: Server
  let port = 0
  const seen: string[] = []
  beforeAll(async () => {
    server = createServer((req, res) => {
      seen.push(req.url ?? '')
      if (req.url === '/rivers') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(fixture('og-basic.html')); return }
      if (req.url === '/tiny.png') { res.writeHead(200, { 'content-type': 'image/png' }); res.end(fixture('tiny.png')); return }
      res.writeHead(404); res.end()
    })
    await new Promise<void>(r => server.listen(0, '127.0.0.1', () => r()))
    port = (server.address() as any).port
  })
  afterAll(() => new Promise<void>(r => server.close(() => r())))

  it('off: { ok: false } and no request; on: the card with its image bytes (transferred); off again: emptied', async () => {
    const url = `http://127.0.0.1:${port}/rivers`
    const { worker, messages, ask, view } = viewWorker(url)
    try {
      await view({ t: 'init', userDataDir: '', version: '2.1.323 (Claude Code)', preview: { allowLoopback: true, on: false } })
      expect(await ask(url, 1)).toEqual({ ok: false })
      expect(seen).toEqual([])
      worker.postMessage({ t: 'previews', on: true })
      const r = await ask(url, 2)
      expect(r).toMatchObject({ ok: true, card: { url, site: '127.0.0.1', via: null, title: 'The longest rivers', image: { type: 'png', width: 3, height: 2 } } })
      expect(r.card.image.bytes).toBeInstanceOf(Uint8Array)
      expect(Buffer.from(r.card.image.bytes).equals(fixture('tiny.png'))).toBe(true)
      expect(seen).toEqual(['/rivers', '/tiny.png'])
      // from the worker's memory: no second request, and the bytes it keeps were not lost by the transfer
      const again = await ask(url, 3)
      expect(Buffer.from(again.card.image.bytes).equals(fixture('tiny.png'))).toBe(true)
      expect(seen).toHaveLength(2)
      // off: emptied; on again: fetched again
      worker.postMessage({ t: 'previews', on: false })
      expect(await ask(url, 4)).toEqual({ ok: false })
      worker.postMessage({ t: 'previews', on: true })
      expect(await ask(url, 5)).toMatchObject({ ok: true })
      expect(seen).toHaveLength(4)
      // a log line from the worker never names the URL or the host
      for (const m of messages.filter(x => x.t === 'log')) expect(m.msg).not.toMatch(/127\.0\.0\.1|rivers|http/)
    } finally {
      await worker.terminate()
    }
  })

  it('without the test switch a loopback address is refused (nothing reaches the server)', async () => {
    const url = `http://127.0.0.1:${port}/rivers`
    const { worker, messages, view } = viewWorker(url)
    try {
      const before = seen.length
      await view({ t: 'init', userDataDir: '', version: '2.1.323 (Claude Code)', preview: { allowLoopback: false, on: true } })
      worker.postMessage({ t: 'preview', id: VIEW_ID, url, req: 1 })
      const end = Date.now() + 8000
      while (!messages.some(m => m.t === 'reply')) { if (Date.now() > end) throw new Error('no reply'); await new Promise(r => setTimeout(r, 10)) }
      expect(messages.find(m => m.t === 'reply').result).toEqual({ ok: false })
      expect(seen.length).toBe(before)
      // the refusal is logged by kind only
      const logs = messages.filter(m => m.t === 'log').map(m => m.msg)
      for (const l of logs) expect(l).toMatch(/^link preview: (refused \([a-z]+\)|timeout|too large|failed \(network\)) x\d+$/)
    } finally {
      await worker.terminate()
    }
  })

  it('(5.9b) a message cannot carry the test switch, caps or a transport: only init\'s allowLoopback counts', async () => {
    const url = `http://127.0.0.1:${port}/rivers`
    const { worker, messages, view } = viewWorker(url)
    const evil = { allowLoopback: true, preview: { allowLoopback: true }, caps: { totalMs: 1e9 }, resolve: { x: 1 }, request: { http: 1 } }
    try {
      const before = seen.length
      await view({ t: 'init', userDataDir: '', version: '2.1.323 (Claude Code)', preview: { allowLoopback: false, on: false } })
      worker.postMessage({ t: 'previews', on: true, ...evil })
      worker.postMessage({ t: 'preview', id: VIEW_ID, url, req: 1, ...evil })
      const end = Date.now() + 8000
      while (!messages.some(m => m.t === 'reply')) { if (Date.now() > end) throw new Error('no reply'); await new Promise(r => setTimeout(r, 10)) }
      expect(messages.find(m => m.t === 'reply').result).toEqual({ ok: false })
      expect(seen.length).toBe(before)
    } finally {
      await worker.terminate()
    }
  })

  it('(review) a fault in the preview service (it fails to load) does not stop the worker: { ok: false }, a fixed word in the log', async () => {
    // the worker as it is, with its require of linkPreview.cjs made to throw
    const boot = [
      "const Module = require('module')",
      'const load = Module._load',
      "Module._load = function (req, ...a) { if (/linkPreview\\.cjs$/.test(req)) throw new Error('boom https://secret.example/x'); return load.call(this, req, ...a) }",
      `require(${JSON.stringify(join(ROOT, 'electron', 'chatWorker.cjs'))})`,
    ].join('\n')
    const worker = new Worker(boot, { eval: true })
    const messages: any[] = []
    let exited = false
    worker.on('message', (m) => messages.push(m))
    worker.on('exit', () => { exited = true })
    const replyTo = async (req: number) => {
      const end = Date.now() + 8000
      while (!messages.some(m => m.t === 'reply' && m.req === req)) { if (Date.now() > end || exited) throw new Error(`no reply (exited: ${exited})`); await new Promise(r => setTimeout(r, 10)) }
      return messages.find(m => m.t === 'reply' && m.req === req).result
    }
    try {
      // previews on at init: the service is made there (and fails)
      worker.postMessage({ t: 'init', userDataDir: ROOT, version: '2.1.323 (Claude Code)', preview: { allowLoopback: false, on: true } })
      worker.postMessage({ t: 'preview', url: 'https://a.example/', req: 1 })
      expect(await replyTo(1)).toEqual({ ok: false })
      worker.postMessage({ t: 'previews', on: false })
      worker.postMessage({ t: 'previews', on: true })
      worker.postMessage({ t: 'preview', url: 'https://b.example/', req: 2 })
      expect(await replyTo(2)).toEqual({ ok: false })
      // still alive: another request is answered
      worker.postMessage({ t: 'older', id: 'nobody', req: 3 })
      expect(await replyTo(3)).toMatchObject({ ok: false })
      expect(exited).toBe(false)
      const logs = messages.filter(m => m.t === 'log').map(m => m.msg)
      expect(logs).toContain('link preview: the service failed')
      for (const l of logs) expect(l).not.toMatch(/secret|example|boom|http/)
    } finally {
      await worker.terminate()
    }
  })

  it('(5.9b) its source: previewOf gets only { allowLoopback, note, signal }, allowLoopback set only from init', () => {
    const src = code(read('electron', 'chatWorker.cjs'))
    const calls = [...src.matchAll(/previewOf\(([^)]*)\)/g)].map(m => m[1])
    expect(calls).toEqual(['url, { allowLoopback, note, signal }'])
    expect(src).toMatch(/const allowLoopback = previewPolicy\.allowLoopback === true/)
    // previewPolicy's allowLoopback is written in one place: the init case, from m.preview
    const writes = [...src.matchAll(/allowLoopback:\s*([^,}]+)/g)].map(m => m[1].trim())
    expect(writes).toEqual(['false', 'm.preview?.allowLoopback === true'])
    const init = src.slice(src.indexOf("case 'init':"), src.indexOf("case 'terminals':"))
    expect(init).toContain('m.preview?.allowLoopback === true')
    for (const bad of [/m\.caps/, /m\.request/, /m\.resolve/, /m\.allowLoopback/]) expect(src, String(bad)).not.toMatch(bad)
  })
})

// ---------------------------------------------------------------- main.cjs

describe('main.cjs: previews only through the CHAT_VIEW host; the test switch never in a packaged build', () => {
  const main = read('electron', 'main.cjs')
  const host = main.slice(main.indexOf('createChatHost({'), main.indexOf('\n  })\n', main.indexOf('createChatHost({')))

  it('the env name appears only in electron/main.cjs, once, inside `!app.isPackaged &&`, in the host\'s options', () => {
    const files: string[] = []
    const walk = (dir: string) => {
      for (const n of readdirSync(dir)) {
        const p = join(dir, n)
        if (statSync(p).isDirectory()) { if (n !== 'node_modules') walk(p) } else if (/\.(c?js|mjs|tsx?|json|html)$/.test(n)) files.push(p)
      }
    }
    walk(join(ROOT, 'electron')); walk(join(ROOT, 'src'))
    const holders = files.filter(f => readFileSync(f, 'utf8').includes('SPAWN_PREVIEW_LOOPBACK'))
    expect(holders.map(f => f.slice(ROOT.length + 1).replace(/\\/g, '/'))).toEqual(['electron/main.cjs'])
    const lines = main.split('\n').filter(l => l.includes('SPAWN_PREVIEW_LOOPBACK'))
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain("preview: { allowLoopback: !app.isPackaged && process.env.SPAWN_PREVIEW_LOOPBACK === '1' }")
    expect(host).toContain('SPAWN_PREVIEW_LOOPBACK')
    // the host itself is built only behind CHAT_VIEW
    expect(main).toMatch(/if \(CHAT_VIEW\) chatHost = require\('\.\/chatHost\.cjs'\)\.createChatHost\(\{/)
  })

  it('previewsOn reads 채팅으로 보기 and 링크 미리보기 both, in the host\'s options', () => {
    expect(host).toMatch(/previewsOn: \(\) => appSettings\(\)\.session\.chatView === true && appSettings\(\)\.session\.linkPreviews === true/)
    expect(main.split('\n').filter(l => l.includes('previewsOn')).every(l => host.includes(l))).toBe(true)
  })

  it('a change of the setting tells the host, only behind CHAT_VIEW and the host', () => {
    const lines = main.split('\n').filter(l => l.includes('setPreviews'))
    expect(lines.length).toBe(1)
    expect(lines[0]).toMatch(/if \(CHAT_VIEW && chatHost && next\.session\.linkPreviews !== before\.session\.linkPreviews\) chatHost\.setPreviews\(\)/)
  })
})

// ---------------------------------------------------------------- the page

describe('src/chat/preview.ts: which links of an answer get a card', () => {
  const keysOf = (text: string) => [...cardLinks(parseMarkdown(text)).entries()]

  it('links and bare addresses of the prose; never one in code (inline or a block)', () => {
    const text = [
      'See [MDN](https://developer.mozilla.org/docs/Web/API/URL/URL) for it.',
      '',
      '```',
      'https://code.example/block',
      '```',
      '',
      'Inline `https://inline.example/x` is code.',
      '',
      '- a https://list.example/1 item',
      '',
      '| a |',
      '|---|',
      '| https://table.example/ |',
    ].join('\n')
    expect(keysOf(text)).toEqual([
      ['para-0', ['https://developer.mozilla.org/docs/Web/API/URL/URL']],
      ['list-0', ['https://list.example/1']],
      ['table-0', ['https://table.example/']],
    ])
  })

  it('the first 3 distinct URLs of the item, each after the top-level block holding its first use', () => {
    const text = [
      'One https://a.example/ and https://a.example/ again.',
      '',
      '> quoted https://b.example/',
      '',
      '## Head https://c.example/',
      '',
      'Then https://d.example/ and https://e.example/.',
    ].join('\n')
    expect(keysOf(text)).toEqual([
      ['para-0', ['https://a.example/']],
      ['quote-0', ['https://b.example/']],
      ['heading-0', ['https://c.example/']],
    ])
  })

  it('none for a file path, an address too long for main, or no link at all', () => {
    expect(keysOf('src/app/cart/LoginButton.tsx:18 and plain words')).toEqual([])
    expect(keysOf(`https://long.example/${'x'.repeat(2100)}`)).toEqual([])
  })
})

describe('src/chat/preview.ts: the card\'s site line is the link\'s own host', () => {
  it('the worker\'s site is used only when it is that host (or its Unicode form with the punycode beside)', () => {
    expect(hostLine('https://developer.mozilla.org/docs', 'developer.mozilla.org')).toBe('developer.mozilla.org')
    expect(hostLine('https://xn--r8jz45g.test/a', '例え.test (xn--r8jz45g.test)')).toBe('例え.test (xn--r8jz45g.test)')
    expect(hostLine('https://例え.test/a', '例え.test (xn--r8jz45g.test)')).toBe('例え.test (xn--r8jz45g.test)')
    expect(hostLine('https://WWW.Example.COM./x', 'www.example.com')).toBe('www.example.com')
  })
  it('a site that names anything else is not shown: the host from the URL itself instead', () => {
    expect(hostLine('https://evil.example/login', 'accounts.google.com')).toBe('evil.example')
    expect(hostLine('https://evil.example/login', 'accounts.google.com (evil.example)')).toBe('evil.example')
    expect(hostLine('https://evil.example/login', 'evil.example (evil.example)')).toBe('evil.example')
    expect(hostLine('https://xn--r8jz45g.test/a', '例え.test\u202e (xn--r8jz45g.test)')).toBe('xn--r8jz45g.test')
    expect(hostLine('https://[2001:db8::1]/', '[2001:db8::1]')).toBe('[2001:db8::1]')
    expect(hostLine('not a url', 'x')).toBe('')
  })
})

describe('src/chat/preview.ts: the page\'s cache (≤ 120 cards, blob: URLs it made, revoked)', () => {
  function rig() {
    const asked: string[] = []
    const answers = new Map<string, (r: any) => void>()
    let made = 0
    const live = new Set<string>()
    const revoked: string[] = []
    const cache = createPageCache({
      ask: (url: string) => { asked.push(url); return new Promise(r => answers.set(url, r)) },
      makeUrl: () => { const u = `blob:test/${++made}`; live.add(u); return u },
      revoke: (u: string) => { live.delete(u); revoked.push(u) },
    })
    const answer = async (url: string, r: any) => { answers.get(url)!(r); await flush() }
    return { cache, asked, answer, live, revoked, made: () => made }
  }
  const pageCard = (url: string, image = true) => ({ ok: true, card: { url, site: new URL(url).hostname, via: null, title: 'T', description: 'D', image: image ? { bytes: PNG, type: 'png', width: 3, height: 2 } : null } })

  it(`the cap is ${PAGE_CARDS}`, () => expect(PAGE_CARDS).toBe(120))

  it('asked once per URL; the image shown from a blob: URL the page made', async () => {
    const r = rig()
    r.cache.want('https://a.example/', 't1')
    r.cache.want('https://a.example/', 't1')
    r.cache.want('https://a.example/', 't2')
    expect(r.asked).toEqual(['https://a.example/'])
    expect(r.cache.card('https://a.example/')).toBe(null)
    await r.answer('https://a.example/', pageCard('https://a.example/'))
    expect(r.cache.card('https://a.example/')).toMatchObject({ url: 'https://a.example/', host: 'a.example', title: 'T', src: 'blob:test/1' })
    // a failure: nothing shown, not asked again while kept
    r.cache.want('https://b.example/', 't1')
    await r.answer('https://b.example/', { ok: false })
    expect(r.cache.card('https://b.example/')).toBe(null)
    r.cache.want('https://b.example/', 't1')
    expect(r.asked).toHaveLength(2)
    // a card without an image makes no blob
    r.cache.want('https://c.example/', 't1')
    await r.answer('https://c.example/', pageCard('https://c.example/', false))
    expect(r.cache.card('https://c.example/')).toMatchObject({ src: null })
    expect(r.made()).toBe(1)
  })

  it('(review) an answer that says "again" (main timed out waiting for the worker) is not kept: the next mount asks again', async () => {
    const r = rig()
    r.cache.want('https://slow.example/', 't1')
    await r.answer('https://slow.example/', { ok: false, again: true })
    expect(r.cache.card('https://slow.example/')).toBe(null)
    expect(r.cache.size()).toBe(0)
    r.cache.want('https://slow.example/', 't1')
    expect(r.asked).toEqual(['https://slow.example/', 'https://slow.example/'])
    await r.answer('https://slow.example/', pageCard('https://slow.example/'))
    expect(r.cache.card('https://slow.example/')).toMatchObject({ title: 'T' })
  })

  it('121 cards → the oldest goes, its blob: URL revoked', async () => {
    const r = rig()
    for (let i = 0; i <= PAGE_CARDS; i++) {
      const u = `https://h${i}.example/`
      r.cache.want(u, 't1')
      await r.answer(u, pageCard(u))
    }
    expect(r.cache.size()).toBe(PAGE_CARDS)
    expect(r.cache.card('https://h0.example/')).toBe(null)
    expect(r.revoked).toEqual(['blob:test/1'])
    expect(r.live.size).toBe(PAGE_CARDS)
  })

  it('the view goes (release): its cards go and their blob: URLs are revoked; another view\'s stay', async () => {
    const r = rig()
    for (const [u, who] of [['https://a.example/', 't1'], ['https://b.example/', 't2'], ['https://s.example/', 't1']] as const) { r.cache.want(u, who); await r.answer(u, pageCard(u)) }
    r.cache.want('https://s.example/', 't2')
    r.cache.release('t1')
    expect(r.cache.card('https://a.example/')).toBe(null)
    expect(r.cache.card('https://b.example/')).not.toBe(null)
    expect(r.cache.card('https://s.example/')).not.toBe(null)
    expect(r.revoked).toEqual(['blob:test/1'])
    r.cache.release('t2')
    expect(r.live.size).toBe(0)
    expect(r.cache.size()).toBe(0)
  })

  it('previews off (dropAll): every blob: URL revoked; an answer that comes after makes nothing', async () => {
    const r = rig()
    r.cache.want('https://a.example/', 't1'); await r.answer('https://a.example/', pageCard('https://a.example/'))
    r.cache.want('https://late.example/', 't1')
    r.cache.dropAll()
    expect(r.live.size).toBe(0)
    await r.answer('https://late.example/', pageCard('https://late.example/'))
    expect(r.made()).toBe(1)
    expect(r.cache.card('https://late.example/')).toBe(null)
    // an answer for a view that went meanwhile makes nothing either
    r.cache.want('https://gone.example/', 't9')
    r.cache.release('t9')
    await r.answer('https://gone.example/', pageCard('https://gone.example/'))
    expect(r.made()).toBe(1)
  })

  it('the card is checked: a card for another URL is not shown', async () => {
    const r = rig()
    r.cache.want('https://a.example/', 't1')
    await r.answer('https://a.example/', pageCard('https://b.example/'))
    expect(r.cache.card('https://a.example/')).toBe(null)
    expect(r.made()).toBe(0)
  })
})

describe('the page\'s source: no fetch, no remote src, requests only from a mounted LinkCard', () => {
  const preview = read('src', 'chat', 'preview.ts')
  const card = read('src', 'components', 'chat', 'LinkCard.tsx')
  it('the page never calls fetch( for a preview; the image src is only a blob: URL the page made', () => {
    expect(code(preview)).not.toMatch(/\bfetch\(/)
    expect(code(card)).not.toMatch(/\bfetch\(/)
    expect(code(preview)).toMatch(/URL\.createObjectURL\(/)
    expect(code(preview)).toMatch(/URL\.revokeObjectURL\(/)
    // LinkCard's one <img>: src={card.src}, and src is only ever made by createObjectURL
    const imgs = [...code(card).matchAll(/<img\b[^>]*>/g)].map(m => m[0])
    expect(imgs).toHaveLength(1)
    expect(imgs[0]).toMatch(/src=\{card\.src\}/)
    expect(code(card)).not.toMatch(/src=\{[^}]*url/i)
    expect(code(preview)).toMatch(/src:\s*image\s*\?\s*makeUrl\(/)
  })
  it('chat.preview is called only in preview.ts, and usePreview only from LinkCard (a mounted row)', () => {
    const files: string[] = []
    const walk = (dir: string) => { for (const n of readdirSync(dir)) { const p = join(dir, n); if (statSync(p).isDirectory()) walk(p); else if (/\.tsx?$/.test(n)) files.push(p) } }
    walk(join(ROOT, 'src'))
    const rel = (f: string) => f.slice(ROOT.length + 1).replace(/\\/g, '/')
    expect(files.filter(f => /chat\.preview\(|chat\?\.preview\(/.test(code(readFileSync(f, 'utf8')))).map(rel)).toEqual(['src/chat/preview.ts'])
    expect(files.filter(f => /\busePreview\(/.test(code(readFileSync(f, 'utf8')))).map(rel).sort()).toEqual(['src/chat/preview.ts', 'src/components/chat/LinkCard.tsx'])
    // the request is in an effect of the hook (a mounted card), never during render, and only once the card has stayed
    // mounted a moment (a row drawn only in passing, or the list's first render before it jumps to the end, asks nothing)
    expect(code(preview)).toMatch(/useEffect\(\(\) => \{[^}]*setTimeout\(\(\) => pageCache\.want\(url, owner\), SETTLE_MS\)\s*return \(\) => clearTimeout\(timer\)/)
    expect(code(preview)).toMatch(/export const SETTLE_MS = 200\b/)
  })
  it('the card opens the link through the app (openUrlFromChat), named 링크 미리보기: {title}, its URL in title', () => {
    expect(code(card)).toMatch(/openUrlFromChat\(card\.url\)/)
    expect(code(card)).toMatch(/t\('링크 미리보기: \{title\}'/)
    expect(code(card)).toMatch(/title=\{card\.url\}/)
    expect(code(card)).toMatch(/href="#"/)
  })
  it('ChatView: previews only with the flag, 채팅으로 보기 and 링크 미리보기 on; TextRow only for a finished main-thread text', () => {
    const view = code(read('src', 'components', 'ChatView.tsx'))
    expect(view).toMatch(/chatViewOn\(settings\) && settings\.session\.linkPreviews === true/)
    expect(view).toMatch(/previews && !item\.partial && !item\.parent/)
    // the live bubble passes no afterBlock
    const live = view.slice(view.indexOf('const LiveRow'), view.indexOf('const NoticeRow'))
    expect(live).not.toMatch(/afterBlock/)
    // the page's cache let go when the view goes and when previews go off
    expect(view).toMatch(/releasePreviews\(id\)/)
    expect(view).toMatch(/dropPreviews\(\)/)
    expect(read('src', 'chat', 'preview.ts')).toMatch(/onChatForget\(/)
  })
  it('strings: ko, en, ja', async () => {
    const { default: chat } = await import('../src/locales/chat')
    expect(chat.en['링크 미리보기: {title}']).toBe('Link preview: {title}')
    expect(chat.ja['링크 미리보기: {title}']).toBe('リンクプレビュー:{title}')
  })
})

describe('Phase 6 budget: 200 links scrolled through', () => {
  it('the worker fetches ≤ 3 at once (≤ 1 per host) and the page keeps ≤ 120 cards, the evicted ones\' blob: URLs revoked', async () => {
    // the worker's service: a user scrolling past 200 links, a few asked at each step, each fetch answered a moment later
    const f = handFetch()
    const s = createPreviewService({ fetchCard: f.fetchCard })
    s.setOn(true)
    const urls = Array.from({ length: 200 }, (_, i) => `https://h${i % 25}.test/river-${i}`)
    const got: Promise<unknown>[] = []
    for (let step = 0; step < urls.length; step += 4) {
      for (const u of urls.slice(step, step + 4)) got.push(s.get(u))
      await flush()
      for (const c of f.calls.filter((x: any) => !x.done).slice(0, 2)) { (c as any).done = true; c.resolve(card(c.url)) }
      await flush()
    }
    for (let k = 0; k < 200; k++) {
      const open = f.calls.filter((x: any) => !x.done)
      if (!open.length) break
      for (const c of open) { (c as any).done = true; c.resolve(card(c.url)) }
      await flush(); await flush()
    }
    await Promise.all(got)
    console.log(`[perf] previews: ${f.calls.length} fetched of 200 links, at most ${f.stats().most} at once, ${f.stats().mostPerHost} per host`)
    expect(f.stats().most).toBeLessThanOrEqual(3)
    expect(f.stats().mostPerHost).toBe(1)
    // the page's cache over the same 200 links, each with its picture
    const live = new Set<string>()
    let made = 0
    const answers = new Map<string, (r: any) => void>()
    const cache = createPageCache({
      ask: (url: string) => new Promise(r => answers.set(url, r)),
      makeUrl: () => { const u = `blob:test/${++made}`; live.add(u); return u },
      revoke: (u: string) => { live.delete(u) },
    })
    for (const u of urls) {
      cache.want(u, 't1')
      answers.get(u)!({ ok: true, card: { url: u, site: new URL(u).hostname, via: null, title: 'T', description: 'D', image: { bytes: PNG, type: 'png', width: 3, height: 2 } } })
      await flush()
      expect(cache.size()).toBeLessThanOrEqual(PAGE_CARDS)
    }
    console.log(`[perf] the page's cache after 200 links: ${cache.size()} cards, ${live.size} blob: URLs alive of ${made} made`)
    expect(cache.size()).toBe(PAGE_CARDS)
    expect(live.size).toBeLessThanOrEqual(PAGE_CARDS)
    expect(made - live.size).toBe(200 - PAGE_CARDS)
  })
})
