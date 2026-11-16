/**
 * electron/linkFetch.cjs — the link-preview fetcher (Phase 5, Task 5.9). Each row of the plan's "Link preview
 * policy" has its own describe block below (Scheme, URL shape, Names, IP forms, Address check, DNS, Redirects,
 * Request, Response, Time, Size, HTML, Image, Logs, Test switch), then the composition (previewOf) and the
 * source guards.
 *
 * No real network, ever: every name goes through an injected resolver, the system resolver is replaced by a
 * trap for the whole file (checked empty at the end), refusals use a spy `request` that must never be called,
 * and transport cases use real servers on 127.0.0.1 with `allowLoopback: true`.
 */

import { spawnSync } from 'node:child_process'
import dns from 'node:dns'
import { EventEmitter } from 'node:events'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import http from 'node:http'
import https from 'node:https'
import { createRequire } from 'node:module'
import net from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import zlib from 'node:zlib'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { FIX } from './chat-helpers'
import { growth, GROWTH_LINEAR, memoryBudget, showGrowth } from './timing'

const require = createRequire(import.meta.url)
const LF = require('../electron/linkFetch.cjs')
const { checkUrl, addressAllowed, resolveAllowed, fetchLimited, redirectTarget, readMeta, decodeHtml, sniffImage, imageAllowed, previewOf, refusalLog, LINK_CAPS, USER_AGENT } = LF

const SRC_PATH = join(__dirname, '..', 'electron', 'linkFetch.cjs')
const PREVIEW = join(FIX, 'preview')
const fixture = (name: string) => readFileSync(join(PREVIEW, name))

// ---- no system resolver, anywhere in this file

const systemDns: string[] = []
const savedDns = { lookup: dns.lookup, plookup: dns.promises.lookup }
beforeAll(() => {
  ;(dns as any).lookup = (host: string, ...rest: any[]) => {
    // an IP literal (server.listen('127.0.0.1') goes through lookup) needs no resolver
    if (net.isIP(String(host))) return (savedDns.lookup as any)(host, ...rest)
    systemDns.push(String(host))
    const cb = rest[rest.length - 1]
    if (typeof cb === 'function') process.nextTick(cb, Object.assign(new Error('system resolver used'), { code: 'ENOTFOUND' }))
  }
  ;(dns.promises as any).lookup = async (host: string) => {
    systemDns.push(String(host))
    throw Object.assign(new Error('system resolver used'), { code: 'ENOTFOUND' })
  }
})
afterAll(() => {
  ;(dns as any).lookup = savedDns.lookup
  ;(dns.promises as any).lookup = savedDns.plookup
})

// ---- fakes

type Table = Record<string, string[] | ((n: number) => string[] | Promise<string[]>)>
/** A resolver over a table (a function value gets the call number for that name, from 1) */
function fakeResolve(table: Table) {
  const calls: { host: string; opts: any }[] = []
  const fn = async (host: string, opts: any) => {
    calls.push({ host, opts })
    const v = table[host]
    const n = calls.filter(c => c.host === host).length
    const list = typeof v === 'function' ? await v(n) : v
    if (!list) throw Object.assign(new Error('not found'), { code: 'ENOTFOUND' })
    return list.map(address => ({ address, family: net.isIP(address) }))
  }
  return Object.assign(fn, { calls })
}

/** A `request` that records its options and never touches the network */
function spyRequest() {
  const calls: { proto: string; opts: any }[] = []
  const make = (proto: string) => ({
    request(opts: any) {
      calls.push({ proto, opts })
      const req: any = new EventEmitter()
      req.end = () => { setImmediate(() => req.emit('error', new Error('spy: no network'))) }
      req.destroy = () => {}
      return req
    },
  })
  return { http: make('http'), https: make('https'), calls }
}

/** A resolver that never answers until the test ends it (a hung lookup holds a slot of the DNS gate until then) */
function hangingResolve() {
  const calls: string[] = []
  const ends: ((e: Error) => void)[] = []
  const fn = (host: string) => { calls.push(host); return new Promise<any>((_ok, fail) => { ends.push(fail) }) }
  const release = async () => {
    for (const end of ends.splice(0)) end(Object.assign(new Error('ended by the test'), { code: 'ETIMEOUT' }))
    await new Promise(r => setTimeout(r, 0))
  }
  return Object.assign(fn, { calls, release })
}

/** A `request` whose single response the test drives by hand (status 200, the given headers) */
function drivenRequest(headers: Record<string, string>) {
  let give!: (r: any) => void
  const incoming = new Promise<any>(r => { give = r })
  const make = () => ({
    request(_opts: any) {
      const req: any = new EventEmitter()
      req.destroy = () => {}
      req.end = () => {
        const res: any = new EventEmitter()
        res.statusCode = 200
        res.headers = headers
        res.destroy = () => {}
        setImmediate(() => { req.emit('response', res); give(res) })
      }
      return req
    },
  })
  return { http: make(), https: make(), incoming }
}

/** The collector, for tests that count what is still held (v8 lets a running process turn it on) */
function exposeGc(): () => void {
  if (typeof (globalThis as any).gc === 'function') return (globalThis as any).gc
  require('node:v8').setFlagsFromString('--expose-gc')
  return require('node:vm').runInNewContext('gc')
}

const PUBLIC = { 'site.test': ['93.184.216.34'], 'pub.test': ['93.184.216.34'], 'example.com': ['93.184.216.34'] }

// ---- the local server (127.0.0.1 only)

type Seen = { path: string; host?: string; headers: http.IncomingHttpHeaders; rawHeaders: string[]; local?: string; method?: string }
type Handler = (req: http.IncomingMessage, res: http.ServerResponse) => void
let server: http.Server
let PORT = 0
const seen: Seen[] = []
const closed: { path: string; at: number }[] = []
const routes = new Map<string, Handler>()
const sockets = new Set<net.Socket>()
const route = (path: string, h: Handler) => { routes.set(path, h) }
const at = (path: string, host = 'site.test', scheme = 'http') => `${scheme}://${host}:${PORT}${path}`
const seenAt = (path: string) => seen.filter(s => s.path === path)
const NAMES: Table = { 'site.test': ['127.0.0.1'], 'other.test': ['127.0.0.1'], 'xn--r8jz45g.test': ['127.0.0.1'], 'pinned.test': ['127.0.0.1'] }
const local = (extra: Record<string, unknown> = {}) => ({ allowLoopback: true, resolve: fakeResolve(NAMES), ...extra })
const html = (body: string, type = 'text/html; charset=utf-8'): Handler => (_req, res) => { res.writeHead(200, { 'content-type': type }); res.end(body) }
const file = (name: string, type: string): Handler => (_req, res) => { res.writeHead(200, { 'content-type': type }); res.end(fixture(name)) }
const redirect = (location: string, status = 302, extra: Record<string, string> = {}): Handler => (_req, res) => { res.writeHead(status, { location, ...extra }); res.end() }
const waitFor = async (ok: () => boolean, ms = 1500) => { const end = Date.now() + ms; while (!ok() && Date.now() < end) await new Promise(r => setTimeout(r, 10)); return ok() }

let GZIP_BOMB: Buffer
let DEFLATE_BOMB: Buffer
let BROTLI_BOMB: Buffer
/** 1 GB of zeros through a compressor, 1 MB at a time */
const squeeze = (z: zlib.Gzip | zlib.Deflate | zlib.BrotliCompress) => new Promise<Buffer>((resolve, reject) => {
  const out: Buffer[] = []
  const zeros = Buffer.alloc(1 << 20)
  z.on('data', c => out.push(c)).on('end', () => resolve(Buffer.concat(out))).on('error', reject)
  let i = 0
  const pump = () => { while (i < 1024) { i++; if (!z.write(zeros)) { z.once('drain', pump); return } } z.end() }
  pump()
})

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const path = (req.url || '').split('?')[0]
    seen.push({ path, host: req.headers.host, headers: req.headers, rawHeaders: req.rawHeaders, local: req.socket.localAddress, method: req.method })
    req.socket.once('close', () => closed.push({ path, at: Date.now() }))
    res.on('error', () => {})
    const h = routes.get(path)
    if (!h) { res.writeHead(404, { 'content-type': 'text/html' }); res.end('<title>nope</title>'); return }
    h(req, res)
  })
  server.on('connection', s => { sockets.add(s); s.on('close', () => sockets.delete(s)); s.on('error', () => {}) })
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
  PORT = (server.address() as net.AddressInfo).port
  const member = zlib.gzipSync(Buffer.alloc(1 << 20), { level: 9 })
  GZIP_BOMB = Buffer.concat(new Array(1024).fill(member))
  DEFLATE_BOMB = await squeeze(zlib.createDeflate({ level: 9 }))
  BROTLI_BOMB = await squeeze(zlib.createBrotliCompress({ params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 5 } }))
}, 60_000)

afterAll(async () => {
  for (const s of sockets) s.destroy()
  await new Promise(r => server.close(r))
})

/** A refusal: the right reason, no request made, and (for a lexical rule) no lookup either */
async function refused(url: string, why: string, { lexical = true, table = PUBLIC as Table, allowLoopback = false } = {}) {
  const spy = spyRequest()
  const resolve = fakeResolve(table)
  const r = await fetchLimited(url, { kind: 'html', request: spy, resolve, allowLoopback })
  expect(r, url).toEqual({ ok: false, why })
  expect(spy.calls, `${url}: request made`).toHaveLength(0)
  if (lexical) expect(resolve.calls, `${url}: lookup made`).toHaveLength(0)
  return resolve
}

// ======================================================================================================

describe('LINK_CAPS and the user agent', () => {
  it('the caps are the policy table\'s numbers', () => {
    expect(LINK_CAPS).toMatchObject({
      urlChars: 2048, dnsMs: 2000, headersMs: 4000, idleMs: 2000, totalMs: 6000, redirects: 3,
      htmlBytes: 1 << 20, imageBytes: 2 << 20, htmlText: 512 << 10, imageSide: 4096, imagePixels: 12_000_000,
      jpegScan: 64 << 10, title: 200, description: 400, site: 80,
    })
    expect(Object.isFrozen(LINK_CAPS)).toBe(true)
  })
  it('a fixed neutral user agent: no app name, version, user or project', () => {
    expect(USER_AGENT).toBe('Mozilla/5.0 (compatible; link-preview)')
  })
})

describe('Scheme: http and https only, refused before any lookup', () => {
  it.each([
    'file:///C:/x', 'ftp://a.b/', 'data:text/html,x', 'javascript:alert(1)', 'blob:https://example.com/1b6a5c1e-0000-4000-8000-000000000000',
    'ws://example.com/', 'wss://example.com/', 'gopher://example.com/', 'mailto:a@example.com', 'about:blank', 'chrome://settings',
    'view-source:http://example.com/', 'jar:http://example.com/!/', 'file://localhost/etc/passwd',
  ])('%s → scheme', async url => {
    expect(checkUrl(url, {})).toEqual({ ok: false, why: 'scheme' })
    await refused(url, 'scheme')
  })
  it('an upper-case scheme is the same scheme (WHATWG lowercases it)', () => {
    expect(checkUrl('HTTP://Example.COM/a', {})).toMatchObject({ ok: true, url: 'http://example.com/a' })
    expect(checkUrl('HTTPS://example.com/', {})).toMatchObject({ ok: true, url: 'https://example.com/' })
    expect(checkUrl('HTTP://LOCALHOST/', {})).toEqual({ ok: false, why: 'name' })
  })
})

describe('URL shape: WHATWG URL, ≤ 2048, no userinfo, port 80/443', () => {
  it('userinfo → userinfo (also an empty one, and a backslash form)', async () => {
    for (const url of ['http://user:pw@example.com', 'http://user@example.com/', 'http://:pw@example.com/', 'http://@example.com/', 'https://a@b@example.com/']) {
      expect(checkUrl(url, {}), url).toEqual({ ok: false, why: 'userinfo' })
      await refused(url, 'userinfo')
    }
  })
  it('a port other than 80 or 443 → port; 80 and 443 explicit are fine for both schemes', async () => {
    for (const url of ['http://example.com:8080', 'https://example.com:8443/', 'http://example.com:22/', 'http://example.com:0/', 'https://example.com:65535/']) {
      expect(checkUrl(url, {}), url).toEqual({ ok: false, why: 'port' })
      await refused(url, 'port')
    }
    for (const url of ['http://example.com:80/', 'http://example.com:443/', 'https://example.com:80/', 'https://example.com:443/', 'http://example.com:080/']) {
      expect(checkUrl(url, {}).ok, url).toBe(true)
    }
  })
  it('a 3,000-character URL → shape; 2,048 is the limit', async () => {
    const long = 'http://example.com/' + 'a'.repeat(3000 - 19)
    expect(long.length).toBe(3000)
    expect(checkUrl(long, {})).toEqual({ ok: false, why: 'shape' })
    await refused(long, 'shape')
    const edge = 'http://example.com/' + 'a'.repeat(2048 - 19)
    expect(checkUrl(edge, {}).ok).toBe(true)
    expect(checkUrl(edge + 'a', {})).toEqual({ ok: false, why: 'shape' })
    // an IDN that grows past the limit once WHATWG writes it in punycode
    const label = Array.from({ length: 60 }, (_, i) => String.fromCharCode(0xac00 + i * 97)).join('')
    const idn = 'http://' + label + '.com/' + 'a'.repeat(1976)
    expect(idn.length).toBe(2048)
    expect(new URL(idn).href.length).toBeGreaterThan(2048)
    expect(checkUrl(idn, {})).toEqual({ ok: false, why: 'shape' })
  })
  it('not a URL, not a string, white space or control characters → shape', async () => {
    for (const url of ['', 'example.com', '//example.com/', 'http://', 'http://[fe80::1%25eth0]/', 'http://exa%2Fmple.com/', 'http://1.2.3.4.5/', 'http://a b.com/', 'http://example.com/\r\nHost: x', 'http://exa\tmple.com/', 'http://example.com/\u0000', ' http://example.com/']) {
      expect(checkUrl(url, {}), JSON.stringify(url)).toEqual({ ok: false, why: 'shape' })
      await refused(url, 'shape')
    }
    for (const v of [null, undefined, 42, {}, ['http://example.com']]) expect(checkUrl(v, {})).toEqual({ ok: false, why: 'shape' })
  })
  it('IPv6 zone ids are refused (WHATWG has no zone; a zone in a resolved address is refused too)', () => {
    expect(checkUrl('http://[fe80::1%eth0]/', {})).toEqual({ ok: false, why: 'shape' })
    expect(checkUrl('http://[fe80::1%25eth0]/', {})).toEqual({ ok: false, why: 'shape' })
    expect(addressAllowed('fe80::1%eth0', 6, {})).toBe(false)
    expect(addressAllowed('2606:2800:220:1:248:1893:25c8:1946%1', 6, {})).toBe(false)
  })
  it('a public name passes with its normalised href', () => {
    expect(checkUrl('https://Example.com/a?b=1#frag', {})).toMatchObject({ ok: true, url: 'https://example.com/a?b=1#frag' })
  })
})

describe('Names: local names refused lexically, before any lookup', () => {
  it.each([
    'http://localhost', 'http://LOCALHOST.', 'http://localhost./', 'http://a.localhost', 'http://x.y.localhost/', 'http://printer.local', 'http://printer.local./',
    'http://db.internal', 'http://intranet', 'http://intranet./', 'http://router.home.arpa/', 'http://1.0.0.127.in-addr.arpa/', 'http://nas.lan/', 'http://ｌｏｃａｌｈｏｓｔ/',
    'https://intranet/', 'http://wiki.corp/', 'http://nas.home/', 'http://x.onion/',
  ])('%s → name', async url => {
    expect(checkUrl(url, {})).toEqual({ ok: false, why: 'name' })
    await refused(url, 'name')
    // the test switch does not lift a name rule
    expect(checkUrl(url, { allowLoopback: true })).toEqual({ ok: false, why: 'name' })
  })
  it('a public name with a trailing dot is the same name (and passes)', () => {
    expect(checkUrl('http://example.com./', {})).toMatchObject({ ok: true, host: 'example.com' })
  })
})

describe('IP forms: WHATWG normalises them, then the address check', () => {
  it.each([
    'http://2130706433', 'http://0x7f000001', 'http://0x7f.1', 'http://0177.0.0.1', 'http://127.1', 'http://017700000001', 'http://0x7f.0x0.0x0.0x1/',
    'http://127.0.0.1.', 'http://①②⑦.0.0.1/', 'http://0/', 'http://0.0.0.0./', 'http://[::]/', 'http://[::ffff:a9fe:a9fe]/', 'http://2852039166/',
  ])('%s → address, with no lookup', async url => {
    expect(checkUrl(url, {})).toEqual({ ok: false, why: 'address' })
    await refused(url, 'address')
  })
})

describe('Address check: a module-level net.BlockList of every range', () => {
  const BLOCKED4 = [
    '0.0.0.0', '0.255.255.255', '10.0.0.1', '10.255.255.255', '100.64.0.1', '100.127.255.255', '127.0.0.1', '127.255.255.254', '169.254.0.1', '169.254.169.254',
    '172.16.0.1', '172.31.255.255', '192.0.0.1', '192.0.0.170', '192.0.2.1', '192.88.99.1', '192.168.0.1', '192.168.255.255', '198.18.0.1', '198.19.255.255',
    '198.51.100.1', '203.0.113.1', '224.0.0.1', '239.255.255.250', '240.0.0.1', '255.255.255.255',
  ]
  const ALLOWED4 = ['1.1.1.1', '8.8.8.8', '93.184.216.34', '11.0.0.1', '100.63.255.255', '100.128.0.0', '126.255.255.255', '128.0.0.1', '169.253.255.255', '169.255.0.1', '172.15.255.255', '172.32.0.0', '192.0.1.1', '192.169.0.1', '198.17.255.255', '198.20.0.0', '223.255.255.255']
  const BLOCKED6 = [
    '::', '::1', '::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:a9fe:a9fe', '::ffff:10.0.0.1', '::ffff:8.8.8.8', '::127.0.0.1', '::ffff:0:a00:1',
    '64:ff9b::a00:1', '64:ff9b::7f00:1', '64:ff9b::808:808', '64:ff9b:1::1', '100::1', '2001::1', '2001:0:4136:e378:8000:63bf:3fff:fdd2', '2001:10::1', '2001:1ff::1',
    '2001:db8::1', '2002:a00:1::', '2002:7f00:1::1', '2002:808:808::1', 'fc00::1', 'fd00::1', 'fd00:ec2::254', 'fe80::1', 'febf:ffff::1', 'fec0::1', 'feff::1',
    'ff02::1', 'ff0e::1', '3fff::1', '4000::1', '1::1', 'e000::1',
  ]
  const ALLOWED6 = ['2606:2800:220:1:248:1893:25c8:1946', '2001:4860:4860::8888', '2a00:1450:4001:80b::200e', '2001:200::1', '2400:cb00::1']

  it('IPv4: every range in the table refused; public addresses next to each range pass', () => {
    for (const ip of BLOCKED4) expect(addressAllowed(ip, 4, {}), ip).toBe(false)
    for (const ip of ALLOWED4) expect(addressAllowed(ip, 4, {}), ip).toBe(true)
  })
  it('IPv6: loopback, unspecified, mapped (the IPv4 checked), NAT64, 6to4, Teredo, ULA (fd00:ec2::254), link-local, site-local, multicast, documentation, non-global', () => {
    for (const ip of BLOCKED6) expect(addressAllowed(ip, 6, {}), ip).toBe(false)
    for (const ip of ALLOWED6) expect(addressAllowed(ip, 6, {}), ip).toBe(true)
  })
  it('no IPv6 rule swallows IPv4 (a ::ffff:0:0/96 rule in a BlockList matches every IPv4 address)', () => {
    expect(addressAllowed('93.184.216.34', 4, {})).toBe(true)
    expect(addressAllowed('8.8.8.8', undefined, {})).toBe(true)
  })
  it('garbage, a family that does not match, a zone → refused', () => {
    for (const [ip, fam] of [['', 4], ['abc', 4], ['1.2.3', 4], ['::ffff', 6], ['1.1.1.1', 6], ['2606:2800:220:1::1', 4], ['fe80::1%eth0', 6], [42, 4], [null, 4]] as [any, any][]) {
      expect(addressAllowed(ip, fam, {}), String(ip)).toBe(false)
    }
  })
  it('URLs with an address in a blocked range → address, with no request', async () => {
    for (const url of [
      'http://127.0.0.1', 'http://[::1]', 'http://169.254.169.254/latest/meta-data', 'http://10.0.0.1', 'http://192.168.1.1', 'http://172.16.0.1', 'http://100.64.0.1', 'http://0.0.0.0',
      'http://[fe80::1]', 'http://[fc00::1]', 'http://[fd00:ec2::254]', 'http://[::ffff:127.0.0.1]', 'http://[::ffff:7f00:1]', 'http://[64:ff9b::a00:1]', 'http://[2002:a00:1::]',
      'http://[2001:0:4136:e378:8000:63bf:3fff:fdd2]/', 'http://[ff02::1]/', 'http://[::127.0.0.1]/', 'http://255.255.255.255/', 'http://224.0.0.251/',
    ]) {
      expect(checkUrl(url, {}), url).toEqual({ ok: false, why: 'address' })
      await refused(url, 'address')
    }
  })
  it('a public address literal passes the URL check', () => {
    expect(checkUrl('http://93.184.216.34/', {})).toMatchObject({ ok: true, ip: '93.184.216.34' })
    expect(checkUrl('https://[2606:2800:220:1:248:1893:25c8:1946]/', {})).toMatchObject({ ok: true, ip: '2606:2800:220:1:248:1893:25c8:1946' })
  })
})

describe('DNS: lookup all + verbatim, 2 s, every address checked, the request pinned to the checked one', () => {
  it('asks the injected resolver with { all: true, verbatim: true }', async () => {
    const resolve = fakeResolve(PUBLIC)
    const r = await resolveAllowed('example.com', { resolve })
    expect(r).toEqual({ ok: true, address: '93.184.216.34', family: 4 })
    expect(resolve.calls).toEqual([{ host: 'example.com', opts: { all: true, verbatim: true } }])
  })
  it('a public name resolving to 10.0.0.5 → refused, with no connection', async () => {
    await refused('http://evil.example/', 'address', { lexical: false, table: { 'evil.example': ['10.0.0.5'] } })
  })
  it('a name resolving to [93.184.216.34, 127.0.0.1] → refused (every address must pass)', async () => {
    await refused('http://mixed.example/', 'address', { lexical: false, table: { 'mixed.example': ['93.184.216.34', '127.0.0.1'] } })
    await refused('http://mixed6.example/', 'address', { lexical: false, table: { 'mixed6.example': ['2606:2800:220:1:248:1893:25c8:1946', 'fd00:ec2::254'] } })
    await refused('http://meta.example/', 'address', { lexical: false, table: { 'meta.example': ['169.254.169.254'] } })
  })
  it('a name like 127.0.0.1.nip.io resolving to loopback → refused', async () => {
    await refused('http://127.0.0.1.nip.io/', 'address', { lexical: false, table: { '127.0.0.1.nip.io': ['127.0.0.1'] } })
    await refused('http://a9fea9fe.rbndr.us/', 'address', { lexical: false, table: { 'a9fea9fe.rbndr.us': ['::ffff:169.254.169.254'] } })
  })
  it('no answer, an empty answer, a malformed answer, or a zone in an answer → refused', async () => {
    await refused('http://none.example/', 'dns', { lexical: false, table: {} })
    await refused('http://empty.example/', 'dns', { lexical: false, table: { 'empty.example': [] } })
    const many = Array.from({ length: 65 }, () => ({ address: '93.184.216.34', family: 4 }))
    for (const bad of [null, 'x', [{ address: 42, family: 4 }], [{ address: '93.184.216.34', family: 6 }], [{ address: 'fe80::1%2', family: 6 }], many]) {
      const r = await resolveAllowed('odd.example', { resolve: async () => bad })
      expect(r.ok, JSON.stringify(bad)).toBe(false)
    }
  })
  it('the resolver is asked once per hop: a rebinding answer (public, then private) is never seen', async () => {
    const spy = spyRequest()
    const resolve = fakeResolve({ 'rebind.example': n => (n === 1 ? ['93.184.216.34'] : ['10.0.0.5']) })
    await fetchLimited('https://rebind.example/a', { kind: 'html', request: spy, resolve })
    expect(resolve.calls).toHaveLength(1)
    expect(spy.calls).toHaveLength(1)
    const { opts } = spy.calls[0]
    // the pinned lookup answers the checked address, both shapes, without asking again
    const one = await new Promise<any[]>(r => opts.lookup('rebind.example', {}, (...a: any[]) => r(a)))
    expect(one).toEqual([null, '93.184.216.34', 4])
    const all = await new Promise<any[]>(r => opts.lookup('rebind.example', { all: true }, (...a: any[]) => r(a)))
    expect(all).toEqual([null, [{ address: '93.184.216.34', family: 4 }]])
    const other = await new Promise<any[]>(r => opts.lookup('elsewhere.example', {}, (...a: any[]) => r(a)))
    expect(other[0]).toBeInstanceOf(Error)
    expect(resolve.calls).toHaveLength(1)
  })
  it('a rebinding resolver over a real connection: asked once, the request reaches the checked address', async () => {
    route('/rebind', html('<title>ok</title>'))
    const resolve = fakeResolve({ 'rebind.test': n => (n === 1 ? ['127.0.0.1'] : ['10.0.0.5']) })
    const r = await fetchLimited(at('/rebind', 'rebind.test'), { kind: 'html', allowLoopback: true, resolve })
    expect(r.ok).toBe(true)
    expect(resolve.calls).toHaveLength(1)
  })
  it('the connection goes to the pinned address: the server sees 127.0.0.1, the Host header is the name', async () => {
    route('/whoami', html('<title>who</title>'))
    const resolve = fakeResolve({ 'pinned.test': ['127.0.0.1'] })
    const r = await fetchLimited(at('/whoami', 'pinned.test'), { kind: 'html', allowLoopback: true, resolve })
    expect(r).toMatchObject({ ok: true, finalUrl: at('/whoami', 'pinned.test') })
    const s = seenAt('/whoami').at(-1)!
    expect(s.local).toBe('127.0.0.1')
    expect(s.host).toBe(`pinned.test:${PORT}`)
    expect(systemDns).not.toContain('pinned.test')
  })
  it('https: TLS servername is the host, the certificate is checked as usual, the agent is a fresh one', async () => {
    const spy = spyRequest()
    await fetchLimited('https://Example.com/p?q=1#f', { kind: 'html', request: spy, resolve: fakeResolve(PUBLIC) })
    expect(spy.calls).toHaveLength(1)
    const { proto, opts } = spy.calls[0]
    expect(proto).toBe('https')
    expect(opts).toMatchObject({ host: 'example.com', port: 443, path: '/p?q=1', method: 'GET', servername: 'example.com', maxHeaderSize: 16 * 1024 })
    // (5.9b) said explicitly, so NODE_TLS_REJECT_UNAUTHORIZED=0 in the environment cannot turn the check off
    expect(opts.rejectUnauthorized).toBe(true)
    expect(opts.minVersion).toBe('TLSv1.2')
    expect('ca' in opts || 'checkServerIdentity' in opts || 'insecureHTTPParser' in opts).toBe(false)
    expect(opts.agent).toBeInstanceOf(https.Agent)
    expect(opts.agent).not.toBe(https.globalAgent)
    expect(opts.agent.keepAlive).toBe(false)
    expect(typeof opts.lookup).toBe('function')
  })
  it('the DNS timer is 2 s: a resolver that never answers → refused at about 2 s, no request', async () => {
    const spy = spyRequest()
    const hang = hangingResolve()
    const t0 = Date.now()
    const r = await fetchLimited('http://hang.example/', { kind: 'html', request: spy, resolve: hang })
    const took = Date.now() - t0
    expect(r).toEqual({ ok: false, why: 'dns' })
    expect(took).toBeGreaterThanOrEqual(1900)
    expect(took).toBeLessThan(3000)
    expect(spy.calls).toHaveLength(0)
    // (a hung lookup keeps its slot of the DNS gate until it ends: end it, so the gate is free for the next tests)
    await hang.release()
  })
})

describe('Redirects: manual, ≤ 3, each hop through every rule again', () => {
  it('to http://169.254.169.254/ → refused at the hop, with no second connection', async () => {
    route('/to-metadata', redirect('http://169.254.169.254/latest/meta-data/'))
    const before = seen.length
    const r = await fetchLimited(at('/to-metadata'), { kind: 'html', ...local() })
    expect(r).toEqual({ ok: false, why: 'address' })
    expect(seen.slice(before).map(s => s.path)).toEqual(['/to-metadata'])
  })
  it('to http://localhost:3000 → refused', async () => {
    route('/to-localhost', redirect('http://localhost:3000/'))
    expect(await fetchLimited(at('/to-localhost'), { kind: 'html', ...local() })).toEqual({ ok: false, why: 'name' })
  })
  it('to a name that resolves private → refused, the resolver asked for each hop\'s name', async () => {
    route('/to-private-name', redirect('http://inside.example/'))
    const resolve = fakeResolve({ ...NAMES, 'inside.example': ['192.168.0.10'] } as Table)
    expect(await fetchLimited(at('/to-private-name'), { kind: 'html', allowLoopback: true, resolve })).toEqual({ ok: false, why: 'address' })
    expect(resolve.calls.map(c => c.host)).toEqual(['site.test', 'inside.example'])
  })
  it('a chain of 4 → refused at the 4th; a chain of 3 is followed', async () => {
    for (const n of [1, 2, 3, 4]) route(`/c${n}`, redirect(`/c${n + 1}`))
    route('/c5', html('<title>end</title>'))
    let before = seen.length
    expect(await fetchLimited(at('/c1'), { kind: 'html', ...local() })).toEqual({ ok: false, why: 'redirect' })
    expect(seen.slice(before).map(s => s.path)).toEqual(['/c1', '/c2', '/c3', '/c4'])
    before = seen.length
    const ok = await fetchLimited(at('/c2'), { kind: 'html', ...local() })
    expect(ok).toMatchObject({ ok: true, finalUrl: at('/c5') })
    expect(seen.slice(before).map(s => s.path)).toEqual(['/c2', '/c3', '/c4', '/c5'])
  })
  it('https → http → refused; https → https is followed', async () => {
    // "https" here is plain http on the loopback server: what is tested is the scheme rule, not TLS
    const tlsOverPlain = { http, https: { request: (opts: any) => http.request({ ...opts, protocol: 'http:', agent: false, servername: undefined }) } }
    route('/tls-down', redirect(at('/plain')))
    route('/tls-a', redirect(at('/tls-b', 'site.test', 'https')))
    route('/tls-b', html('<title>secure</title>'))
    route('/plain', html('<title>plain</title>'))
    expect(await fetchLimited(at('/tls-down', 'site.test', 'https'), { kind: 'html', request: tlsOverPlain, ...local() })).toEqual({ ok: false, why: 'scheme' })
    expect(seenAt('/plain')).toHaveLength(0)
    expect(await fetchLimited(at('/tls-a', 'site.test', 'https'), { kind: 'html', request: tlsOverPlain, ...local() })).toMatchObject({ ok: true, finalUrl: at('/tls-b', 'site.test', 'https') })
  })
  it('a relative Location is resolved against the hop and re-checked', async () => {
    route('/rel', redirect('rel-2?x=1'))
    route('/rel-2', html('<title>two</title>'))
    expect(await fetchLimited(at('/rel'), { kind: 'html', ...local() })).toMatchObject({ ok: true, finalUrl: at('/rel-2?x=1') })
    route('/proto-rel', redirect('//localhost/x'))
    expect(await fetchLimited(at('/proto-rel'), { kind: 'html', ...local() })).toEqual({ ok: false, why: 'name' })
    route('/to-mapped', redirect('//[::ffff:a9fe:a9fe]/latest/'))
    expect(await fetchLimited(at('/to-mapped'), { kind: 'html', ...local() })).toEqual({ ok: false, why: 'address' })
    route('/to-decimal', redirect('http://2852039166/latest/meta-data/'))
    expect(await fetchLimited(at('/to-decimal'), { kind: 'html', ...local() })).toEqual({ ok: false, why: 'address' })  })
  it('a redirect to file:, with userinfo, with a control character, or without a Location → refused', async () => {
    route('/to-file', redirect('file:///C:/Windows/win.ini'))
    route('/to-userinfo', redirect(`http://user:pw@site.test:${PORT}/x`))
    route('/to-tab', redirect(`http://site.test:${PORT}/a\tb`))
    route('/no-loc', (_q, res) => { res.writeHead(302); res.end() })
    route('/to-data', redirect('data:text/html,<title>x</title>'))
    expect(await fetchLimited(at('/to-file'), { kind: 'html', ...local() })).toEqual({ ok: false, why: 'scheme' })
    expect(await fetchLimited(at('/to-data'), { kind: 'html', ...local() })).toEqual({ ok: false, why: 'scheme' })
    expect(await fetchLimited(at('/to-userinfo'), { kind: 'html', ...local() })).toEqual({ ok: false, why: 'userinfo' })
    expect(await fetchLimited(at('/to-tab'), { kind: 'html', ...local() })).toEqual({ ok: false, why: 'shape' })
    expect(await fetchLimited(at('/no-loc'), { kind: 'html', ...local() })).toEqual({ ok: false, why: 'redirect' })
  })
  it('redirectTarget: CRLF, control characters and over-long targets give nothing', () => {
    const base = 'http://site.test/a/b'
    expect(redirectTarget('c', base)).toBe('http://site.test/a/c')
    expect(redirectTarget('/c', base)).toBe('http://site.test/c')
    expect(redirectTarget('https://other.test/x', base)).toBe('https://other.test/x')
    for (const bad of ['http://x.test/\r\nSet-Header: 1', '/a\nb', '/a\u0000', '/a\u007f', '', '   ', 'http://x.test/' + 'a'.repeat(2100), 'http://[', 42, null]) expect(redirectTarget(bad, base), JSON.stringify(bad)).toBe(null)
  })
  it('301, 303, 307 and 308 are followed too; a 304 or a 3xx other than these is refused', async () => {
    for (const s of [301, 303, 307, 308]) route(`/s${s}`, redirect('/s-end', s))
    route('/s-end', html('<title>end</title>'))
    for (const s of [301, 303, 307, 308]) expect(await fetchLimited(at(`/s${s}`), { kind: 'html', ...local() }), String(s)).toMatchObject({ ok: true, finalUrl: at('/s-end') })
    route('/s304', redirect('/s-end', 304))
    route('/s300', redirect('/s-end', 300))
    expect(await fetchLimited(at('/s304'), { kind: 'html', ...local() })).toEqual({ ok: false, why: 'status' })
    expect(await fetchLimited(at('/s300'), { kind: 'html', ...local() })).toEqual({ ok: false, why: 'status' })
  })
})

describe('Request: GET, exactly the listed headers, a fresh agent, no proxy, nothing from a previous hop', () => {
  it('the server records exactly the listed headers', async () => {
    route('/headers', html('<title>h</title>'))
    const r = await fetchLimited(at('/headers'), { kind: 'html', ...local() })
    expect(r.ok).toBe(true)
    const s = seenAt('/headers').at(-1)!
    expect(s.method).toBe('GET')
    expect(Object.keys(s.headers).sort()).toEqual(['accept', 'accept-encoding', 'connection', 'host', 'user-agent'])
    expect(s.headers['user-agent']).toBe('Mozilla/5.0 (compatible; link-preview)')
    expect(s.headers.accept).toBe('text/html,application/xhtml+xml;q=0.9,image/*;q=0.8')
    expect(s.headers['accept-encoding']).toBe('gzip, deflate, br')
    expect(s.headers.connection).toBe('close')
    for (const h of ['cookie', 'referer', 'authorization', 'accept-language', 'origin', 'proxy-authorization']) expect(s.headers[h], h).toBeUndefined()
  })
  it('the image request carries the same headers', async () => {
    route('/headers.png', file('tiny.png', 'image/png'))
    expect((await fetchLimited(at('/headers.png'), { kind: 'image', ...local() })).ok).toBe(true)
    expect(Object.keys(seenAt('/headers.png').at(-1)!.headers).sort()).toEqual(['accept', 'accept-encoding', 'connection', 'host', 'user-agent'])
  })
  it('a Set-Cookie from hop 1 is not sent to hop 2', async () => {
    route('/cookie-1', redirect('/cookie-2', 302, { 'set-cookie': 'sid=abc123; Path=/' }))
    route('/cookie-2', html('<title>c</title>'))
    expect((await fetchLimited(at('/cookie-1'), { kind: 'html', ...local() })).ok).toBe(true)
    const hop2 = seenAt('/cookie-2').at(-1)!
    expect(hop2.headers.cookie).toBeUndefined()
    expect(hop2.headers.referer).toBeUndefined()
    expect(Object.keys(hop2.headers).sort()).toEqual(['accept', 'accept-encoding', 'connection', 'host', 'user-agent'])
  })
  // (5.9b) Note: NODE_USE_ENV_PROXY exists only on Node ≥ 24 (Electron 33 runs Node 20) and is read when the process
  // STARTS, so setting it here, in a running process, proves little on its own; what protects is the fresh custom
  // agent (no proxyEnv) on every hop. The next test starts a child Node with it set, where it does take effect.
  it('HTTP_PROXY / HTTPS_PROXY / ALL_PROXY / NO_PROXY are not honoured: nothing reaches a trap proxy', async () => {
    let trapped = 0
    const trap = net.createServer(s => { trapped++; s.destroy() })
    await new Promise<void>(r => trap.listen(0, '127.0.0.1', r))
    const trapUrl = `http://127.0.0.1:${(trap.address() as net.AddressInfo).port}`
    const names = ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'NODE_USE_ENV_PROXY']
    const saved = Object.fromEntries(names.map(n => [n, process.env[n]]))
    try {
      Object.assign(process.env, { HTTP_PROXY: trapUrl, HTTPS_PROXY: trapUrl, ALL_PROXY: trapUrl, NO_PROXY: '', NODE_USE_ENV_PROXY: '1' })
      route('/via-proxy', html('<title>direct</title>'))
      const r = await fetchLimited(at('/via-proxy'), { kind: 'html', ...local() })
      expect(r.ok).toBe(true)
      expect(seenAt('/via-proxy')).toHaveLength(1)
      expect(trapped).toBe(0)
    } finally {
      for (const n of names) { if (saved[n] === undefined) delete process.env[n]; else process.env[n] = saved[n] }
      await new Promise(r => trap.close(r))
    }
  })
  it('a child Node started with NODE_USE_ENV_PROXY=1: its global agent goes to the trap proxy (control), the fetcher does not', async () => {
    let trapped = 0
    const trap = net.createServer(s => { trapped++; s.on('error', () => {}); s.destroy() })
    await new Promise<void>(r => trap.listen(0, '127.0.0.1', r))
    const trapUrl = `http://127.0.0.1:${(trap.address() as net.AddressInfo).port}`
    route('/env-proxy-control', html('<title>control</title>'))
    route('/env-proxy', html('<title>direct</title>'))
    const script = [
      `const http = require('http'); const LF = require(${JSON.stringify(require.resolve('../electron/linkFetch.cjs'))})`,
      `const control = () => new Promise(r => http.get('http://127.0.0.1:${PORT}/env-proxy-control', x => { x.resume(); r('direct') }).on('error', () => r('proxied')))`,
      `const resolve = async () => [{ address: '127.0.0.1', family: 4 }]`,
      `control().then(c => LF.fetchLimited('http://site.test:${PORT}/env-proxy', { kind: 'html', allowLoopback: true, resolve }).then(f => process.stdout.write(JSON.stringify({ c, ok: f.ok }))))`,
    ].join('\n')
    const { execFile } = await import('node:child_process')
    try {
      const out = await new Promise<string>((ok, fail) => execFile(process.execPath, ['-e', script], { env: { ...process.env, NODE_USE_ENV_PROXY: '1', HTTP_PROXY: trapUrl, HTTPS_PROXY: trapUrl, NO_PROXY: '' }, timeout: 10_000 }, (e, so) => (e ? fail(e) : ok(String(so)))))
      const got = JSON.parse(out)
      // the control: on a Node that honours NODE_USE_ENV_PROXY the plain global agent was sent to the trap
      if (got.c === 'proxied') expect(trapped).toBe(1)
      expect(got.ok).toBe(true)
      expect(seenAt('/env-proxy')).toHaveLength(1)
      expect(trapped).toBe(got.c === 'proxied' ? 1 : 0)
    } finally {
      await new Promise(r => trap.close(r))
    }
  }, 15_000)
  it('a replaced global agent is never constructed or used', async () => {
    const saved = (http as any).globalAgent
    let made = 0
    let used = 0
    class Trap extends http.Agent {
      constructor(o?: http.AgentOptions) { super(o); made++ }
      addRequest(...a: any[]) { used++; return (http.Agent.prototype as any).addRequest.apply(this, a) }
    }
    try {
      ;(http as any).globalAgent = new Trap()
      made = 0
      route('/global-agent', html('<title>g</title>'))
      expect((await fetchLimited(at('/global-agent'), { kind: 'html', ...local() })).ok).toBe(true)
      expect(made).toBe(0)
      expect(used).toBe(0)
    } finally {
      ;(http as any).globalAgent = saved
    }
  })
  it('the request options: GET, the path without the fragment, a fresh http.Agent without keep-alive', async () => {
    const spy = spyRequest()
    await fetchLimited('http://example.com/a/b?c=d#frag', { kind: 'html', request: spy, resolve: fakeResolve(PUBLIC) })
    const { proto, opts } = spy.calls[0]
    expect(proto).toBe('http')
    expect(opts).toMatchObject({ host: 'example.com', port: 80, path: '/a/b?c=d', method: 'GET' })
    expect(opts.headers).toEqual({ 'User-Agent': USER_AGENT, Accept: 'text/html,application/xhtml+xml;q=0.9,image/*;q=0.8', 'Accept-Encoding': 'gzip, deflate, br' })
    expect(opts.agent).toBeInstanceOf(http.Agent)
    expect(opts.agent).not.toBe(http.globalAgent)
    expect(opts.agent.keepAlive).toBe(false)
    expect(opts.servername).toBeUndefined()
  })
})

describe('Response: 200 only, HTML by its type, an image by its bytes', () => {
  it('404 and 500 → status', async () => {
    route('/e500', (_q, res) => { res.writeHead(500, { 'content-type': 'text/html' }); res.end('<title>err</title>') })
    expect(await fetchLimited(at('/missing-page'), { kind: 'html', ...local() })).toEqual({ ok: false, why: 'status' })
    expect(await fetchLimited(at('/e500'), { kind: 'html', ...local() })).toEqual({ ok: false, why: 'status' })
    route('/e201', (_q, res) => { res.writeHead(201, { 'content-type': 'text/html' }); res.end('<title>x</title>') })
    expect(await fetchLimited(at('/e201'), { kind: 'html', ...local() })).toEqual({ ok: false, why: 'status' })
  })
  it('application/json, text/plain or no type for a page → type; text/html and application/xhtml+xml pass', async () => {
    route('/json', html('{"title":"x"}', 'application/json'))
    route('/plain-text', html('<title>x</title>', 'text/plain'))
    route('/no-type', (_q, res) => { res.writeHead(200); res.end('<title>x</title>') })
    route('/xhtml', html('<title>x</title>', 'application/xhtml+xml; charset=utf-8'))
    route('/upper-type', html('<title>x</title>', 'Text/HTML'))
    for (const p of ['/json', '/plain-text', '/no-type']) expect(await fetchLimited(at(p), { kind: 'html', ...local() }), p).toEqual({ ok: false, why: 'type' })
    expect(await fetchLimited(at('/xhtml'), { kind: 'html', ...local() })).toMatchObject({ ok: true, type: 'application/xhtml+xml' })
    expect(await fetchLimited(at('/upper-type'), { kind: 'html', ...local() })).toMatchObject({ ok: true, type: 'text/html' })
  })
  it('an image is judged by its bytes, not its header', async () => {
    route('/png-as-text', file('tiny.png', 'text/plain'))
    route('/svg-as-png', html('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><script>alert(1)</script></svg>', 'image/png'))
    const a = await fetchLimited(at('/png-as-text'), { kind: 'image', ...local() })
    expect(sniffImage(a.bytes)).toEqual({ type: 'png', width: 3, height: 2, animated: false })
    const b = await fetchLimited(at('/svg-as-png'), { kind: 'image', ...local() })
    expect(b.ok).toBe(true)
    expect(sniffImage(b.bytes)).toBe(null)
  })
})

describe('Time: DNS 2 s, connect + headers 4 s, idle 2 s, 6 s in all; the socket destroyed', () => {
  it('the timers asked for are the caps', async () => {
    const asked: number[] = []
    const timers = { setTimeout: (fn: () => void, ms: number) => { asked.push(ms); return setTimeout(fn, ms) }, clearTimeout }
    route('/timers', html('<title>t</title>'))
    expect((await fetchLimited(at('/timers'), { kind: 'html', timers, ...local() })).ok).toBe(true)
    expect(asked[0]).toBe(6000)
    expect(asked).toContain(2000)
    expect(asked).toContain(4000)
  })
  it('slow headers end at 4 s, an idle body at 2 s, a dripping body and a slow redirect chain at 6 s; each socket destroyed', async () => {
    route('/slow-headers', () => {})
    route('/idle', (_q, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.write('<html><head>') })
    route('/drip', (_q, res) => {
      res.writeHead(200, { 'content-type': 'text/html' })
      const t = setInterval(() => res.write('a'), 500)
      res.on('close', () => clearInterval(t))
    })
    for (const n of [1, 2]) route(`/slow-hop-${n}`, (_q, res) => { const t = setTimeout(() => { res.writeHead(302, { location: `/slow-hop-${n + 1}` }); res.end() }, 2500); res.on('close', () => clearTimeout(t)) })
    route('/slow-hop-3', (_q, res) => { const t = setTimeout(() => { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<title>late</title>') }, 2500); res.on('close', () => clearTimeout(t)) })
    // (5.9b) a header DRIP: the status line and headers one byte every 500 ms, from a raw socket. Header bytes do not
    // count as progress: the 4 s connect + headers timer ends it (not the 2 s idle timer, which is for the body)
    let dripClosed = -1
    const dripper = net.createServer(s => {
      s.on('error', () => {})
      const text = 'HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nX-Slow: ' + 'a'.repeat(100)
      let i = 0
      const t = setInterval(() => { if (i < text.length) s.write(text[i++]) }, 500)
      s.on('close', () => { clearInterval(t); dripClosed = Date.now() })
    })
    await new Promise<void>(r => dripper.listen(0, '127.0.0.1', r))
    const dripUrl = `http://drip-headers.test:${(dripper.address() as net.AddressInfo).port}/`
    const timed = async (path: string) => {
      const t0 = Date.now()
      const r = path.startsWith('http')
        ? await fetchLimited(path, { kind: 'html', allowLoopback: true, resolve: fakeResolve({ 'drip-headers.test': ['127.0.0.1'] }) })
        : await fetchLimited(at(path), { kind: 'html', ...local() })
      return { r, took: Date.now() - t0, end: Date.now() }
    }
    const [headers, idle, drip, hops, dripHead] = await Promise.all(['/slow-headers', '/idle', '/drip', '/slow-hop-1', dripUrl].map(timed))
    for (const x of [headers, idle, drip, hops, dripHead]) expect(x.r).toEqual({ ok: false, why: 'timeout' })
    expect(dripHead.took).toBeGreaterThanOrEqual(3900); expect(dripHead.took).toBeLessThan(4800)
    expect(await waitFor(() => dripClosed >= dripHead.end - 50), 'the drip socket closed').toBe(true)
    await new Promise(r => dripper.close(r))
    expect(headers.took).toBeGreaterThanOrEqual(3900); expect(headers.took).toBeLessThan(4800)
    expect(idle.took).toBeGreaterThanOrEqual(1900); expect(idle.took).toBeLessThan(2800)
    expect(drip.took).toBeGreaterThanOrEqual(5900); expect(drip.took).toBeLessThan(6800)
    expect(hops.took).toBeGreaterThanOrEqual(5900); expect(hops.took).toBeLessThan(6800)
    for (const [p, x] of [['/slow-headers', headers], ['/idle', idle], ['/drip', drip], ['/slow-hop-3', hops]] as const) {
      expect(await waitFor(() => closed.some(c => c.path === p && c.at >= x.end - 50)), `${p} closed`).toBe(true)
    }
  }, 14_000)
})

describe('Size: 1 MB / 2 MB read, 512 KB of HTML, stop at </head> or <body, zlib counters', () => {
  const forever = (type: string): Handler => (_q, res) => {
    res.writeHead(200, { 'content-type': type })
    const chunk = Buffer.alloc(64 << 10, 0x61)
    let gone = false
    res.on('close', () => { gone = true })
    const pump = () => { while (!gone) { if (!res.write(chunk)) { res.once('drain', pump); return } } }
    pump()
  }
  it('a 1 GB page (a server writing forever): ends at the cap, ≤ 1 MB read, socket destroyed, < 1.5 s', async () => {
    route('/forever', forever('text/html'))
    const t0 = Date.now()
    const r = await fetchLimited(at('/forever'), { kind: 'html', ...local() })
    const took = Date.now() - t0
    expect(r.ok).toBe(true)
    expect(r.bytes.length).toBe(512 << 10)
    expect(r.read).toBeLessThanOrEqual(1 << 20)
    expect(took).toBeLessThan(1500)
    expect(await waitFor(() => closed.some(c => c.path === '/forever'))).toBe(true)
  })
  it('a 1 GB image stream → refused at 2 MB, socket destroyed, < 1.5 s', async () => {
    route('/forever.png', forever('image/png'))
    const t0 = Date.now()
    expect(await fetchLimited(at('/forever.png'), { kind: 'image', ...local() })).toEqual({ ok: false, why: 'size' })
    expect(Date.now() - t0).toBeLessThan(1500)
    expect(await waitFor(() => closed.some(c => c.path === '/forever.png'))).toBe(true)
  })
  it('a 3 MB PNG → refused at 2 MB (with and without Content-Length); 2 MB exactly is fine', async () => {
    const png = Buffer.concat([fixture('tiny.png').subarray(0, 33), Buffer.alloc(3 << 20)])
    route('/big.png', (_q, res) => { res.writeHead(200, { 'content-type': 'image/png', 'content-length': String(png.length) }); res.end(png) })
    route('/big-chunked.png', (_q, res) => { res.writeHead(200, { 'content-type': 'image/png' }); res.write(png.subarray(0, 1 << 20)); res.end(png.subarray(1 << 20)) })
    route('/edge.png', (_q, res) => { res.writeHead(200, { 'content-type': 'image/png' }); res.end(png.subarray(0, 2 << 20)) })
    expect(await fetchLimited(at('/big.png'), { kind: 'image', ...local() })).toEqual({ ok: false, why: 'size' })
    expect(await fetchLimited(at('/big-chunked.png'), { kind: 'image', ...local() })).toEqual({ ok: false, why: 'size' })
    const edge = await fetchLimited(at('/edge.png'), { kind: 'image', ...local() })
    expect(edge.ok).toBe(true)
    expect(edge.bytes.length).toBe(2 << 20)
  })
  const bomb = (enc: string, body: () => Buffer, type = 'text/html'): Handler => (_q, res) => { res.writeHead(200, { 'content-type': type, 'content-encoding': enc }); res.end(body()) }
  it.each([['gzip', () => GZIP_BOMB], ['deflate', () => DEFLATE_BOMB], ['br', () => BROTLI_BOMB]] as const)('a %s bomb (1 GB inside): the inflater stops at 512 KB, RSS grows < 50 MB (×4 on CI)', async (enc, body) => {
    expect(body().length).toBeLessThan(1.1 * (1 << 20))
    route(`/bomb-${enc}`, bomb(enc, body))
    route(`/bomb-${enc}.png`, bomb(enc, body, 'image/png'))
    const rss0 = process.memoryUsage().rss
    const t0 = Date.now()
    const r = await fetchLimited(at(`/bomb-${enc}`), { kind: 'html', ...local() })
    expect(r.ok).toBe(true)
    expect(r.bytes.length).toBe(512 << 10)
    expect(r.bytes.every((b: number) => b === 0)).toBe(true) // inflated, not the compressed bytes
    expect(r.read).toBeLessThanOrEqual(1 << 20)
    const img = await fetchLimited(at(`/bomb-${enc}.png`), { kind: 'image', ...local() })
    expect(img).toEqual({ ok: false, why: 'size' })
    // ×4 on a CI runner (memoryBudget(), tests/timing.ts): the bomb is 1 GB inside, so 200 MB still proves the
    // inflater stopped
    expect(process.memoryUsage().rss - rss0).toBeLessThan(memoryBudget(50 << 20))
    expect(Date.now() - t0).toBeLessThan(3000)
  })
  it('Content-Encoding: gzip with garbage → encoding; an unknown or stacked encoding → encoding', async () => {
    route('/garbage-gzip', (_q, res) => { res.writeHead(200, { 'content-type': 'text/html', 'content-encoding': 'gzip' }); res.end('<title>not gzip at all</title>') })
    route('/compress', (_q, res) => { res.writeHead(200, { 'content-type': 'text/html', 'content-encoding': 'compress' }); res.end('x') })
    route('/stacked', (_q, res) => { res.writeHead(200, { 'content-type': 'text/html', 'content-encoding': 'gzip, br' }); res.end(zlib.brotliCompressSync(zlib.gzipSync('<title>x</title>'))) })
    for (const p of ['/garbage-gzip', '/compress', '/stacked']) expect(await fetchLimited(at(p), { kind: 'html', ...local() }), p).toEqual({ ok: false, why: 'encoding' })
  })
  it('gzip, deflate (zlib and raw) and br pages decode', async () => {
    const page = '<html><head><title>Squeezed</title></head><body>x</body></html>'
    const enc: [string, string, Buffer][] = [['gz', 'gzip', zlib.gzipSync(page)], ['xgz', 'x-gzip', zlib.gzipSync(page)], ['zl', 'deflate', zlib.deflateSync(page)], ['raw', 'deflate', zlib.deflateRawSync(page)], ['br', 'br', zlib.brotliCompressSync(page)], ['id', 'identity', Buffer.from(page)]]
    for (const [name, e, body] of enc) {
      route(`/enc-${name}`, (_q, res) => { res.writeHead(200, { 'content-type': 'text/html', 'content-encoding': e }); res.end(body) })
      const r = await fetchLimited(at(`/enc-${name}`), { kind: 'html', ...local() })
      expect(r.ok, name).toBe(true)
      expect(readMeta(decodeHtml(r.bytes, 'text/html')).title, name).toBe('Squeezed')
    }
  })
  it('reading stops at </head> or <body (also split across chunks), without waiting for the rest', async () => {
    route('/head-stall', (_q, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.write('<html><head><title>T</title></head><body><p>never read') })
    route('/body-stall', (_q, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.write('<html><title>T</title><BODY class=x>never read') })
    route('/split-stall', (_q, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.write('<html><head><title>T</title></he'); setTimeout(() => res.write('ad>never read'), 100) })
    for (const p of ['/head-stall', '/body-stall', '/split-stall']) {
      const t0 = Date.now()
      const r = await fetchLimited(at(p), { kind: 'html', ...local() })
      expect(r.ok, p).toBe(true)
      expect(Date.now() - t0, p).toBeLessThan(1000)
      const text = r.bytes.toString('latin1')
      expect(text, p).not.toContain('never read')
      expect(text.toLowerCase(), p).not.toMatch(/<\/head|<body/)
      expect(readMeta(text).title).toBe('T')
      expect(await waitFor(() => closed.some(c => c.path === p)), `${p} closed`).toBe(true)
    }
  })
  it('a 512 KB head with no </head> stops at the cap; og-late keeps only what lies before it', async () => {
    route('/big-head', html('<html><head><title>Early</title>' + '<link rel="x" href="/y">\n'.repeat(30000) + '<meta property="og:title" content="Late">'))
    const r = await fetchLimited(at('/big-head'), { kind: 'html', ...local() })
    expect(r.bytes.length).toBe(512 << 10)
    expect(readMeta(decodeHtml(r.bytes, 'text/html')).title).toBe('Early')
    route('/og-late', file('og-late.html', 'text/html'))
    const late = await fetchLimited(at('/og-late'), { kind: 'html', ...local() })
    expect(late.bytes.length).toBe(512 << 10)
    expect(readMeta(decodeHtml(late.bytes, late.contentType))).toEqual({ title: 'The early title before the cap', description: '', site: '', image: '' })
  })
  it('the compressed counter: past the read cap a page keeps what came before it (caps injected)', async () => {
    route('/raw-cap', html('<title>Cap</title>' + 'x'.repeat(10_000)))
    const r = await fetchLimited(at('/raw-cap'), { kind: 'html', caps: { htmlBytes: 1000 }, ...local() })
    expect(r.ok).toBe(true)
    expect(r.bytes.length).toBe(1000)
    expect(r.read).toBe(1000)
  })
})

describe('HTML: readMeta, a linear scanner (nothing executed), and decodeHtml', () => {
  const page = (name: string) => decodeHtml(fixture(name), 'text/html')
  it('og-basic: og wins over twitter and the plain tags', () => {
    expect(readMeta(page('og-basic.html'))).toEqual({ title: 'The longest rivers', description: 'The Nile and the Amazon, compared by length and by flow.', site: 'River Notes', image: 'tiny.png' })
  })
  it('og-entities: entities decoded, quotes nested, attributes without quotes, upper-case tags, white space collapsed', () => {
    expect(readMeta(page('og-entities.html'))).toEqual({ title: 'Rivers & Seas: the "big" ones', description: 'It\'s about the Nile & the Amazon \u2014 <b>not</b> markup. Spread over lines.', site: 'Rivers & Co', image: '' })
  })
  it('og-euckr: the charset from the meta, correct Korean', () => {
    expect(readMeta(decodeHtml(fixture('og-euckr.html'), 'text/html'))).toEqual({ title: '한강의 다리', description: '한강은 서울을 가로질러 흐르는 강입니다.', site: '강 이야기', image: '' })
    // the header's charset wins over the meta
    expect(readMeta(decodeHtml(fixture('og-euckr.html'), 'text/html; charset=EUC-KR')).title).toBe('한강의 다리')
  })
  it('og-script: a meta inside a script, a comment, a style, noscript and a template is ignored', () => {
    expect(readMeta(page('og-script.html'))).toEqual({ title: 'The real title', description: 'The real description', site: '', image: '' })
  })
  it('og-bidi: U+202E, bidi isolates, zero-width characters and control characters removed', () => {
    const m = readMeta(page('og-bidi.html'))
    expect(m.title).toBe('Riversgnp.exe and seas')
    expect(m.description).toBe('Flows north to the sea.')
    for (const s of [m.title, m.description]) expect(s).not.toMatch(/[\u0000-\u001f\u007f-\u009f\u061c\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/)
  })
  it('fallbacks: twitter, then the plain description and <title>; first of each wins; names in any case', () => {
    expect(readMeta('<title>Plain</title><meta name="description" content="Desc">')).toEqual({ title: 'Plain', description: 'Desc', site: '', image: '' })
    expect(readMeta('<meta name="twitter:title" content="TT"><meta name="twitter:description" content="TD"><meta name="twitter:image" content="/t.png"><title>Plain</title>')).toEqual({ title: 'TT', description: 'TD', site: '', image: '/t.png' })
    expect(readMeta('<meta property="OG:TITLE" content="One"><meta property="og:title" content="Two">').title).toBe('One')
    expect(readMeta('<meta name="og:title" content="By name">').title).toBe('By name')
    expect(readMeta('<meta property="og:title" content="   "><title>Fallback</title>').title).toBe('Fallback')
    expect(readMeta('<meta property="og:image:secure_url" content="https://a.test/s.png">').image).toBe('https://a.test/s.png')
    expect(readMeta('<meta property="og:image" content=" \n https://a.test/x.png \t">').image).toBe('https://a.test/x.png')
  })
  it('caps: title 200, description 400, site 80 (by code points, never a half pair)', () => {
    const m = readMeta(`<meta property="og:title" content="${'😀'.repeat(300)}"><meta property="og:description" content="${'d'.repeat(500)}"><meta property="og:site_name" content="${'s'.repeat(100)}">`)
    expect(Array.from(m.title)).toHaveLength(200)
    expect(m.title).toBe('😀'.repeat(200))
    expect(m.description).toHaveLength(400)
    expect(m.site).toHaveLength(80)
  })
  it('stops at <body; an unclosed comment, quote or raw-text element ends the scan', () => {
    expect(readMeta('<title>A</title><body><meta property="og:title" content="In body">').title).toBe('A')
    expect(readMeta('<title>A</title><!-- <meta property="og:title" content="B">').title).toBe('A')
    expect(readMeta('<title>A</title><meta content="x><meta property="og:title" content="B">').title).toBe('A')
    expect(readMeta('<title>A</title><script><meta property="og:title" content="B">').title).toBe('A')
    expect(readMeta('<textarea><meta property="og:title" content="B"></textarea><title>A</title>').title).toBe('A')
  })
  it('entities: numeric (decimal, hex, invalid), a fixed named set, unknown names kept', () => {
    expect(readMeta('<title>&#65;&#x42;&#0;&#xD800;&#1114112;&amp;&lt;&gt;&quot;&apos;&nbsp;&hellip;&mdash;&ndash;&rsquo;&copy;&bogus;&amp</title>').title).toBe('AB\ufffd\ufffd\ufffd&<>"\' \u2026\u2014\u2013\u2019\u00a9&bogus;&amp')
  })
  it.each([
    ['1 MB of <', (k: number) => '<'.repeat(k), 1 << 18],
    ['1 MB of <a (no >)', (k: number) => '<a '.repeat(k), 87_500],
    ['1 MB of <!--', (k: number) => '<!--'.repeat(k), 65_536],
    ['1 MB of <script>', (k: number) => '<script>'.repeat(k), 32_768],
    ['1 MB of <meta content=" (unclosed)', (k: number) => '<meta content="'.repeat(k), 17_500],
    ['1 MB of &#', (k: number) => '<title>' + '&#'.repeat(k) + '</title>', 125_000],
    ['1 MB of <A B=C', (k: number) => '<A B=C '.repeat(k) + '>', 37_500],
  ])('readMeta over %s is linear', (_name, make, n) => {
    // By growth (tests/timing.ts): the best time of a quarter of the input and of all of it, in turns, stays near
    // ×4 (a scanner that is not linear is ×16, and takes seconds over 1 MB); and the whole MB within a generous
    // 500 ms (a few ms on a desktop; a busy CI runner took over 100). A wall-clock 50 ms alone measured the runner.
    expect(make(4 * n).length).toBeGreaterThanOrEqual(1_000_000)
    const g = growth(make, readMeta, n)
    expect(g.ratio, showGrowth(g)).toBeLessThan(GROWTH_LINEAR)
    expect(g.large, showGrowth(g)).toBeLessThan(500)
  })
  it('decodeHtml: header charset, BOM, meta charset, http-equiv, unknown → UTF-8, a meta naming UTF-16 → UTF-8', () => {
    const euc = Buffer.from(fixture('og-euckr.html'))
    const korean = Buffer.from('<meta charset="utf-8"><title>한강</title>', 'utf8')
    expect(decodeHtml(korean, 'text/html; charset=utf-8')).toContain('한강')
    expect(decodeHtml(korean, 'text/html; charset="UTF-8"')).toContain('한강')
    expect(decodeHtml(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), korean]), 'text/html; charset=euc-kr')).toContain('한강')
    const equiv = Buffer.concat([Buffer.from('<meta http-equiv="Content-Type" content="text/html; charset=euc-kr"><title>'), new TextEncoder().encode('x'), Buffer.from('</title>'), euc])
    expect(decodeHtml(equiv, 'text/html')).toContain('한강의 다리')
    expect(decodeHtml(Buffer.from('<meta charset="no-such-charset"><title>한강</title>'), 'text/html')).toContain('한강')
    expect(decodeHtml(Buffer.from('<meta charset="utf-16"><title>한강</title>'), 'text/html')).toContain('한강')
    expect(decodeHtml(new Uint8Array(Buffer.from('<title>u8</title>')), 'text/html')).toBe('<title>u8</title>')
  })
})

describe('Image: magic bytes PNG / JPEG / WebP only, dimensions from the header, never decoded', () => {
  it('tiny.png / tiny.jpg / tiny.webp → the right type and dimensions', () => {
    expect(sniffImage(fixture('tiny.png'))).toEqual({ type: 'png', width: 3, height: 2, animated: false })
    expect(sniffImage(fixture('tiny.jpg'))).toEqual({ type: 'jpeg', width: 10, height: 6, animated: false })
    expect(sniffImage(fixture('tiny.webp'))).toEqual({ type: 'webp', width: 6, height: 4, animated: false })
    for (const f of ['tiny.png', 'tiny.jpg', 'tiny.webp']) expect(imageAllowed(sniffImage(fixture(f))), f).toBe(true)
  })
  it('tiny.gif, anim.png (acTL), an animated WebP (VP8X flag / ANIM chunk), SVG, HTML → no image', () => {
    expect(sniffImage(fixture('tiny.gif'))).toBe(null)
    expect(sniffImage(fixture('anim.png'))).toMatchObject({ type: 'png', animated: true })
    expect(imageAllowed(sniffImage(fixture('anim.png')))).toBe(false)
    const vp8x = (flags: number, extra: Buffer[] = []) => {
      const data = Buffer.alloc(10); data[0] = flags; data.writeUIntLE(99, 4, 3); data.writeUIntLE(49, 7, 3)
      const chunk = Buffer.concat([Buffer.from('VP8X'), Buffer.from([10, 0, 0, 0]), data, ...extra])
      const head = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP')]); head.writeUInt32LE(4 + chunk.length, 4)
      return Buffer.concat([head, chunk])
    }
    expect(sniffImage(vp8x(0x10))).toEqual({ type: 'webp', width: 100, height: 50, animated: false })
    expect(sniffImage(vp8x(0x02))).toMatchObject({ type: 'webp', animated: true })
    expect(sniffImage(vp8x(0x00, [Buffer.from('ANIM'), Buffer.from([6, 0, 0, 0]), Buffer.alloc(6)]))).toMatchObject({ animated: true })
    expect(imageAllowed(sniffImage(vp8x(0x02)))).toBe(false)
    expect(sniffImage(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>'))).toBe(null)
    expect(sniffImage(Buffer.from('<?xml version="1.0"?><svg/>'))).toBe(null)
    expect(sniffImage(fixture('fake.png'))).toBe(null)
  })
  it('huge-dims.png (30000×30000) → no image, decided from the header', () => {
    expect(sniffImage(fixture('huge-dims.png'))).toEqual({ type: 'png', width: 30000, height: 30000, animated: false })
    expect(imageAllowed(sniffImage(fixture('huge-dims.png')))).toBe(false)
  })
  it('the limits: ≤ 4096 a side, ≤ 12 MP, ≥ 1 a side', () => {
    const ok = (w: number, h: number) => imageAllowed({ type: 'png', width: w, height: h, animated: false })
    expect(ok(4096, 2929)).toBe(true)
    expect(ok(4096, 2930)).toBe(false)
    expect(ok(4097, 1)).toBe(false)
    expect(ok(1, 4097)).toBe(false)
    expect(ok(0, 10)).toBe(false)
    expect(ok(3464, 3464)).toBe(true)
    expect(ok(3465, 3465)).toBe(false)
    expect(imageAllowed(null)).toBe(false)
    expect(imageAllowed({ type: 'gif', width: 1, height: 1, animated: false })).toBe(false)
  })
  it('a lossy WebP (VP8) header; a JPEG whose SOF lies past 64 KB; truncated or broken headers → null', () => {
    const vp8 = Buffer.alloc(30); vp8.write('RIFF', 0); vp8.writeUInt32LE(22, 4); vp8.write('WEBP', 8); vp8.write('VP8 ', 12); vp8.writeUInt32LE(10, 16)
    vp8[23] = 0x9d; vp8[24] = 0x01; vp8[25] = 0x2a; vp8.writeUInt16LE(320, 26); vp8.writeUInt16LE(200, 28)
    expect(sniffImage(vp8)).toEqual({ type: 'webp', width: 320, height: 200, animated: false })
    const jpg = fixture('tiny.jpg')
    const app = Buffer.alloc(4 + 65000); app[0] = 0xff; app[1] = 0xe1; app.writeUInt16BE(65002, 2) // an APP1 segment of 65,000 bytes, twice
    const far = Buffer.concat([jpg.subarray(0, 2), app, app, jpg.subarray(2)])
    expect(sniffImage(far)).toBe(null)
    expect(sniffImage(fixture('tiny.png').subarray(0, 8))).toBe(null)
    expect(sniffImage(fixture('tiny.png').subarray(0, 20))).toBe(null)
    expect(sniffImage(fixture('tiny.jpg').subarray(0, 40))).toBe(null)
    expect(sniffImage(fixture('tiny.webp').subarray(0, 22))).toBe(null)
    expect(sniffImage(Buffer.alloc(0))).toBe(null)
    expect(sniffImage(null)).toBe(null)
  })
  it('over the wire: an image fetched through every rule, ≤ 2 MB, its bytes sniffed', async () => {
    route('/tiny.webp', file('tiny.webp', 'image/webp'))
    const r = await fetchLimited(at('/tiny.webp'), { kind: 'image', ...local() })
    expect(sniffImage(r.bytes)).toEqual({ type: 'webp', width: 6, height: 4, animated: false })
  })
})

describe('previewOf: the composition into a LinkCardData', () => {
  const OG_BASIC = fixture('og-basic.html').toString('utf8')
  beforeAll(() => {
    route('/rivers', html(OG_BASIC))
    route('/tiny.png', file('tiny.png', 'image/png'))
    route('/hop-rivers', (_q, res) => { res.writeHead(301, { location: `http://other.test:${PORT}/rivers` }); res.end() })
  })
  it('og-basic and its image: title, description, the link\'s own host as the site, image bytes with type and size, the url as written', async () => {
    const url = at('/rivers')
    const card = await previewOf(url, local())
    // (Task 5.10, the controller's ruling: og:site_name is what the page claims, so the card's site is always the
    // link's real host; a page can never make a card name another site)
    expect(card).toMatchObject({ url, site: 'site.test', via: null, title: 'The longest rivers', description: 'The Nile and the Amazon, compared by length and by flow.' })
    expect(card.image).toMatchObject({ type: 'png', width: 3, height: 2 })
    expect(card.image.bytes).toBeInstanceOf(Uint8Array)
    expect(Buffer.isBuffer(card.image.bytes)).toBe(false)
    expect(Buffer.from(card.image.bytes).equals(fixture('tiny.png'))).toBe(true)
    expect(card.image.bytes.byteOffset).toBe(0)
    expect(card.image.bytes.buffer.byteLength).toBe(card.image.bytes.byteLength)
    expect(Object.keys(card).sort()).toEqual(['description', 'image', 'site', 'title', 'url', 'via'])
  })
  it('a redirect that leaves the host → via; the site is still the link\'s own host', async () => {
    const card = await previewOf(at('/hop-rivers'), local())
    expect(card).toMatchObject({ site: 'site.test', via: 'other.test' })
  })
  it('a page naming itself another site (og:site_name) never changes the site: it is the link\'s host', async () => {
    route('/claims', html('<title>Sign in</title><meta property="og:site_name" content="accounts.google.com">'))
    const card = await previewOf(at('/claims'), local())
    expect(card).toMatchObject({ site: 'site.test', via: null, title: 'Sign in' })
    expect(JSON.stringify(card)).not.toContain('google')
  })
  it('no og:site_name → the host; a non-ASCII host in Unicode with its punycode beside', async () => {
    route('/no-site', html('<title>Plain page</title>'))
    expect(await previewOf(at('/no-site'), local())).toMatchObject({ site: 'site.test', via: null, title: 'Plain page', description: '', image: null })
    expect(await previewOf(`http://例え.test:${PORT}/no-site`, local())).toMatchObject({ site: '例え.test (xn--r8jz45g.test)', title: 'Plain page' })
  })
  it('a page with neither title nor description → null, and its image is not fetched', async () => {
    route('/empty-page', html('<meta property="og:image" content="/never.png"><meta property="og:site_name" content="S">'))
    expect(await previewOf(at('/empty-page'), local())).toBe(null)
    expect(seenAt('/never.png')).toHaveLength(0)
  })
  it('an image that is a GIF, animated, too big, not an image, or at a blocked address → the card without an image', async () => {
    const cases: [string, string, string][] = [['gif', 'tiny.gif', 'image/gif'], ['anim', 'anim.png', 'image/png'], ['huge', 'huge-dims.png', 'image/png'], ['fake', 'fake.png', 'image/png']]
    for (const [name, f, type] of cases) {
      route(`/img-${name}`, html(`<title>${name}</title><meta property="og:image" content="/pic-${name}">`))
      route(`/pic-${name}`, file(f, type))
      const card = await previewOf(at(`/img-${name}`), local())
      expect(card, name).toMatchObject({ title: name, image: null })
      expect(seenAt(`/pic-${name}`), name).toHaveLength(1)
    }
    route('/img-meta', html('<title>m</title><meta property="og:image" content="http://169.254.169.254/latest/meta-data/x.png">'))
    route('/img-file', html('<title>f</title><meta property="og:image" content="file:///C:/x.png">'))
    route('/img-local', html('<title>l</title><meta property="og:image" content="http://printer.local/x.png">'))
    for (const p of ['/img-meta', '/img-file', '/img-local']) expect(await previewOf(at(p), local()), p).toMatchObject({ image: null })
  })
  it('a relative og:image is resolved against the final page URL after a redirect', async () => {
    route('/hop-rel', redirect(`http://other.test:${PORT}/dir/page`))
    route('/dir/page', html('<title>rel</title><meta property="og:image" content="pic.png">'))
    route('/dir/pic.png', file('tiny.png', 'image/png'))
    const card = await previewOf(at('/hop-rel'), local())
    expect(card).toMatchObject({ title: 'rel', via: 'other.test', image: { type: 'png', width: 3, height: 2 } })
    expect(seenAt('/dir/pic.png').at(-1)!.host).toBe(`other.test:${PORT}`)
  })
  it('a refused page → null, and the refusal is noted by kind only', async () => {
    const notes: string[] = []
    expect(await previewOf('http://10.0.0.1/', { note: (w: string) => notes.push(w), resolve: fakeResolve(PUBLIC), request: spyRequest() })).toBe(null)
    expect(await previewOf('http://localhost/', { note: (w: string) => notes.push(w), resolve: fakeResolve(PUBLIC), request: spyRequest() })).toBe(null)
    expect(notes).toEqual(['address', 'name'])
  })
})

describe('Logs: fixed words and counts only, once per kind per minute', () => {
  it('counted, once per kind per minute, never the URL, host or text', () => {
    const lines: string[] = []
    let t = 1_000_000
    const note = refusalLog({ write: (s: string) => lines.push(s), now: () => t })
    note('address'); note('address'); note('timeout'); note('size'); note('address')
    expect(lines).toEqual(['link preview: refused (address) x1', 'link preview: timeout x1', 'link preview: too large x1'])
    t += 60_000
    note('address')
    expect(lines.at(-1)).toBe('link preview: refused (address) x3')
    note('http://secret.example/private?token=abc' as any)
    note({ toString: () => 'evil.example' } as any)
    expect(lines.at(-1)).toBe('link preview: refused (other) x1')
    for (const l of lines) expect(l).toMatch(/^link preview: (refused \([a-z]+\)|timeout|too large|failed \(network\)) x\d+$/)
  })
})

describe('Test switch: allowLoopback permits only 127.0.0.0/8 and ::1 (any port), as a plain option', () => {
  it('127/8 and ::1 pass with the switch; every other blocked range is still refused', () => {
    for (const ip of ['127.0.0.1', '127.1.2.3', '127.255.255.254']) expect(addressAllowed(ip, 4, { allowLoopback: true }), ip).toBe(true)
    expect(addressAllowed('::1', 6, { allowLoopback: true })).toBe(true)
    for (const ip of ['10.0.0.1', '169.254.169.254', '0.0.0.0', '192.168.1.1', '::ffff:127.0.0.1', '::', 'fe80::1', 'fd00:ec2::254', '::ffff:7f00:1']) {
      expect(addressAllowed(ip, net.isIP(ip), { allowLoopback: true }), ip).toBe(false)
    }
    expect(checkUrl('http://127.0.0.1:5173/', { allowLoopback: true })).toMatchObject({ ok: true })
    expect(checkUrl('http://[::1]:5173/', { allowLoopback: true })).toMatchObject({ ok: true })
    expect(checkUrl('http://127.0.0.1:5173/', {})).toEqual({ ok: false, why: 'port' })
  })
  it('a port other than 80/443 with the switch: only when every resolved address is loopback', async () => {
    await refused('http://pub.test:8080/', 'port', { lexical: false, allowLoopback: true })
    await refused('http://10.0.0.1:8080/', 'address', { allowLoopback: true })
  })
  it('the switch is an option: linkFetch.cjs reads no environment variable', () => {
    expect(readFileSync(SRC_PATH, 'utf8')).not.toMatch(/process\.env|SPAWN_PREVIEW_LOOPBACK/)
  })
})

describe('Guards: the source of linkFetch.cjs', () => {
  const src = readFileSync(SRC_PATH, 'utf8')
  it('requires only http, https, dns, net, zlib, url (and the pure linkShape.cjs)', () => {
    const reqs = [...src.matchAll(/require\(\s*['"`]([^'"`]+)['"`]\s*\)/g)].map(m => m[1])
    // (./linkShape.cjs: the rule for which links may get a card at all, pure; the final review's I1)
    expect(new Set(reqs)).toEqual(new Set(['http', 'https', 'dns', 'net', 'zlib', 'url', './linkShape.cjs']))
    expect(src).not.toMatch(/\brequire\(\s*[^'"`\s]/)
    expect(src).not.toMatch(/\bimport\(/)
  })
  it('never names cookie, referer, localStorage, session, net.request, electron, fs; no console, no TLS bypass', () => {
    for (const bad of [/cookie/i, /referr?er/i, /localStorage/, /session/i, /net\.request/, /electron/i, /\bfs\b/, /console\./, /rejectUnauthorized\s*:(?!\s*true\b)/, /NODE_TLS/, /insecureHTTPParser/, /checkServerIdentity/, /\bca\s*:/, /eval\(|new Function/]) {
      expect(src, String(bad)).not.toMatch(bad)
    }
    // (5.9b) the certificate check is said, not assumed: the environment cannot turn it off
    expect(src).toMatch(/rejectUnauthorized: true/)
    expect(src).toMatch(/minVersion: 'TLSv1\.2'/)
  })
  it('LinkCardData: src/chat/types.ts has it, linkFetch.cjs mirrors it in JSDoc', () => {
    const types = readFileSync(join(__dirname, '..', 'src', 'chat', 'types.ts'), 'utf8')
    const block = types.slice(types.indexOf('export interface LinkCardData'))
    expect(block.length).toBeGreaterThan(0)
    for (const f of ['url: string', 'site: string', 'via: string | null', 'title: string; description: string', "image: { bytes: Uint8Array; type: 'png' | 'jpeg' | 'webp'; width: number; height: number } | null"]) expect(block).toContain(f)
    expect(src).toMatch(/@typedef[\s\S]*LinkCardData/)
    for (const f of ['url', 'site', 'via', 'title', 'description', 'image']) expect(src).toMatch(new RegExp(`LinkCardData[\\s\\S]*\\b${f}\\b`))
  })
})

// ======================================================================================================
// 5.9b: the findings of the independent security review, each with the test that failed before its fix

/** The openssl binary, if this machine has one (Git for Windows ships it); the TLS tests are skipped without it */
function findOpenssl(): string | null {
  for (const bin of ['openssl', 'C:/Program Files/Git/usr/bin/openssl.exe', 'C:/Program Files/Git/mingw64/bin/openssl.exe']) {
    try { if (spawnSync(bin, ['version'], { stdio: 'ignore', timeout: 5000 }).status === 0) return bin } catch { /* next */ }
  }
  return null
}
const OPENSSL = findOpenssl()
const HAS_V6 = await new Promise<boolean>(r => {
  const s = net.createServer()
  s.once('error', () => r(false))
  s.listen(0, '::1', () => s.close(() => r(true)))
})

describe.skipIf(!OPENSSL)('5.9b TLS over a real socket: an untrusted certificate is refused, whatever the environment says', () => {
  // a self-signed certificate for tls.test, made at test time in a temp dir and removed after (no key is ever committed)
  let dir = ''
  let cert = ''
  let srv: https.Server
  let port = 0
  let served = 0
  let handshakeErrors = 0
  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'lf-tls-'))
    const made = spawnSync(OPENSSL!, ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes',
      '-keyout', join(dir, 'k.pem'), '-out', join(dir, 'c.pem'), '-days', '1', '-subj', '/CN=tls.test', '-addext', 'subjectAltName=DNS:tls.test'], { stdio: 'pipe', timeout: 20_000 })
    expect(made.status, String(made.stderr)).toBe(0)
    cert = readFileSync(join(dir, 'c.pem'), 'utf8')
    srv = https.createServer({ key: readFileSync(join(dir, 'k.pem')), cert }, (_q, res) => { served++; res.writeHead(200, { 'content-type': 'text/html' }); res.end('<title>tls</title>') })
    srv.on('tlsClientError', () => { handshakeErrors++ })
    await new Promise<void>(r => srv.listen(0, '127.0.0.1', r))
    port = (srv.address() as net.AddressInfo).port
  }, 30_000)
  afterAll(async () => {
    if (srv) await new Promise(r => srv.close(r))
    if (dir) rmSync(dir, { recursive: true, force: true })
  })
  const tlsUrl = () => `https://tls.test:${port}/`
  const tlsLocal = () => ({ kind: 'html', allowLoopback: true, resolve: fakeResolve({ 'tls.test': ['127.0.0.1'] }) })

  it('control: a client that trusts this certificate gets the page (so a refusal below is the certificate)', async () => {
    const status = await new Promise<number>((ok, fail) => {
      https.get({ host: 'tls.test', port, servername: 'tls.test', ca: cert, agent: false, lookup: (_n: string, o: any, cb: any) => (o && o.all ? cb(null, [{ address: '127.0.0.1', family: 4 }]) : cb(null, '127.0.0.1', 4)) }, res => { res.resume(); ok(res.statusCode!) }).on('error', fail)
    })
    expect(status).toBe(200)
  })
  it('a self-signed certificate for the right name → network; nothing served', async () => {
    const before = served
    const errs = handshakeErrors
    expect(await fetchLimited(tlsUrl(), tlsLocal())).toEqual({ ok: false, why: 'network' })
    expect(served).toBe(before)
    expect(await waitFor(() => handshakeErrors > errs)).toBe(true)
  })
  it('NODE_TLS_REJECT_UNAUTHORIZED=0 in the environment during the fetch: still refused', async () => {
    const saved = process.env.NODE_TLS_REJECT_UNAUTHORIZED
    const emit = process.emitWarning
    const before = served
    try {
      ;(process as any).emitWarning = () => {}
      process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'
      expect(await fetchLimited(tlsUrl(), tlsLocal())).toEqual({ ok: false, why: 'network' })
      expect(served).toBe(before)
    } finally {
      if (saved === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED
      else process.env.NODE_TLS_REJECT_UNAUTHORIZED = saved
      process.emitWarning = emit
    }
  })
})

describe('5.9b bounded buffers: one buffer per cap, no per-chunk list', () => {
  it('1-byte chunks (raw): the bytes copied into one store, no chunk held while reading', async () => {
    const gc = exposeGc()
    const t = drivenRequest({ 'content-type': 'text/html' })
    const p = fetchLimited('http://example.com/', { kind: 'html', request: t, resolve: fakeResolve(PUBLIC) })
    const res = await t.incoming
    const N = 200_000
    const refs: WeakRef<Buffer>[] = []
    for (let i = 0; i < N; i++) {
      const c = Buffer.from([0x61])
      if (i % 200 === 0) refs.push(new WeakRef(c))
      res.emit('data', c)
    }
    await new Promise(r => setTimeout(r, 0))
    gc()
    const held = refs.filter(r => r.deref() !== undefined).length
    res.emit('end')
    const r = await p
    expect(r.ok).toBe(true)
    expect(r.bytes.length).toBe(N)
    expect(r.bytes.every((b: number) => b === 0x61)).toBe(true)
    // O(1): of 1,000 sampled chunks none is still held (the old per-chunk list held every one)
    expect(held).toBeLessThanOrEqual(2)
    // the result is a view of the one store of the cap's size
    expect(r.bytes.buffer.byteLength).toBe(LINK_CAPS.htmlText)
  })
  it('1-byte chunks (decoded): gzip fed a byte at a time decodes right, into the one store', async () => {
    const page = '<html><head><title>Byte by byte</title>' + '<meta name="x" content="y">'.repeat(20) + '</head><body>never</body></html>'
    const gz = zlib.gzipSync(page, { level: 0 })
    const t = drivenRequest({ 'content-type': 'text/html', 'content-encoding': 'gzip' })
    const p = fetchLimited('http://example.com/', { kind: 'html', request: t, resolve: fakeResolve(PUBLIC) })
    const res = await t.incoming
    for (let i = 0; i < gz.length; i++) res.emit('data', gz.subarray(i, i + 1))
    res.emit('end')
    const r = await p
    expect(r.ok).toBe(true)
    expect(r.bytes.toString('latin1')).toBe(page.slice(0, page.indexOf('</head>')))
    expect(readMeta(decodeHtml(r.bytes, 'text/html')).title).toBe('Byte by byte')
    expect(r.bytes.buffer.byteLength).toBe(LINK_CAPS.htmlText)
  })
  it('an image in 1-byte chunks: whole, in the image cap\'s store', async () => {
    const png = fixture('tiny.png')
    const t = drivenRequest({ 'content-type': 'image/png' })
    const p = fetchLimited('http://example.com/a.png', { kind: 'image', request: t, resolve: fakeResolve(PUBLIC) })
    const res = await t.incoming
    for (let i = 0; i < png.length; i++) res.emit('data', png.subarray(i, i + 1))
    res.emit('end')
    const r = await p
    expect(Buffer.from(r.bytes).equals(png)).toBe(true)
    expect(r.bytes.buffer.byteLength).toBe(LINK_CAPS.imageBytes)
  })
  it('a real server writing 1-byte chunks: the right page, in bounded time', async () => {
    const page = '<html><head><title>Slowly</title><meta property="og:description" content="' + 'd'.repeat(2000) + '"></head><body>'
    route('/one-byte', (_q, res) => {
      res.writeHead(200, { 'content-type': 'text/html' })
      let i = 0
      let gone = false
      res.on('close', () => { gone = true })
      const next = () => { if (gone) return; if (i >= page.length) { res.end(); return } res.write(page[i++]); setImmediate(next) }
      next()
    })
    const t0 = Date.now()
    const r = await fetchLimited(at('/one-byte'), { kind: 'html', ...local() })
    expect(Date.now() - t0).toBeLessThan(3000)
    expect(r.ok).toBe(true)
    expect(readMeta(decodeHtml(r.bytes, 'text/html'))).toMatchObject({ title: 'Slowly', description: 'd'.repeat(400) })
  })
})

describe('5.9b deflate: the zlib-or-raw choice waits for two bytes', () => {
  it('a zlib-wrapped deflate page whose first chunk is 1 byte decodes (not taken for raw deflate)', async () => {
    const z = zlib.deflateSync('<html><head><title>Split deflate</title></head>')
    const t = drivenRequest({ 'content-type': 'text/html', 'content-encoding': 'deflate' })
    const p = fetchLimited('http://example.com/', { kind: 'html', request: t, resolve: fakeResolve(PUBLIC) })
    const res = await t.incoming
    res.emit('data', z.subarray(0, 1))
    await new Promise(r => setTimeout(r, 5))
    res.emit('data', z.subarray(1))
    res.emit('end')
    const r = await p
    expect(r.ok).toBe(true)
    expect(readMeta(decodeHtml(r.bytes, 'text/html')).title).toBe('Split deflate')
  })
  it('raw deflate in 1-byte chunks still decodes', async () => {
    const z = zlib.deflateRawSync('<html><head><title>Raw split</title></head>')
    const t = drivenRequest({ 'content-type': 'text/html', 'content-encoding': 'deflate' })
    const p = fetchLimited('http://example.com/', { kind: 'html', request: t, resolve: fakeResolve(PUBLIC) })
    const res = await t.incoming
    for (let i = 0; i < z.length; i++) res.emit('data', z.subarray(i, i + 1))
    res.emit('end')
    const r = await p
    expect(readMeta(decodeHtml(r.bytes, 'text/html')).title).toBe('Raw split')
  })
})

describe('5.9b DNS: at most 2 lookups at once, failures remembered 60 s per host, no lingering timers', () => {
  const ANSWER = [{ address: '93.184.216.34', family: 4 }]
  it('the gate is free before these tests', () => {
    expect(LF.dnsGate()).toMatchObject({ running: 0, waiting: 0 })
  })
  it('a 3rd concurrent lookup does not start until one of 2 ends', async () => {
    const asked: string[] = []
    const answers: ((v: any) => void)[] = []
    const resolve = (host: string) => { asked.push(host); return new Promise<any>(r => answers.push(r)) }
    const a = resolveAllowed('gate-a.example', { resolve })
    const b = resolveAllowed('gate-b.example', { resolve })
    const c = resolveAllowed('gate-c.example', { resolve })
    await new Promise(r => setTimeout(r, 30))
    expect(asked).toEqual(['gate-a.example', 'gate-b.example'])
    expect(LF.dnsGate()).toMatchObject({ running: 2, waiting: 1 })
    answers[0](ANSWER)
    expect(await a).toMatchObject({ ok: true })
    await new Promise(r => setTimeout(r, 10))
    expect(asked).toEqual(['gate-a.example', 'gate-b.example', 'gate-c.example'])
    answers[1](ANSWER); answers[2](ANSWER)
    expect(await b).toMatchObject({ ok: true })
    expect(await c).toMatchObject({ ok: true })
    expect(LF.dnsGate()).toMatchObject({ running: 0, waiting: 0 })
  })
  it('two hung lookups: a 3rd waits only as long as the DNS timer, then dns, its resolver never called', async () => {
    const hang = hangingResolve()
    const h1 = resolveAllowed('hung-1.example', { resolve: hang })
    const h2 = resolveAllowed('hung-2.example', { resolve: hang })
    let third = 0
    const t0 = Date.now()
    const r3 = await resolveAllowed('waits.example', { resolve: async () => { third++; return ANSWER }, timeoutMs: 300 })
    expect(r3).toEqual({ ok: false, why: 'dns' })
    expect(Date.now() - t0).toBeLessThan(1500)
    expect(third).toBe(0)
    expect(LF.dnsGate().waiting).toBe(0)
    // a wait that ran out is the gate's, not the name's: not remembered, asked again once the gate is free
    await hang.release()
    expect(await h1).toEqual({ ok: false, why: 'dns' })
    expect(await h2).toEqual({ ok: false, why: 'dns' })
    expect(await resolveAllowed('waits.example', { resolve: async () => { third++; return ANSWER } })).toMatchObject({ ok: true })
    expect(third).toBe(1)
  })
  it('a lookup that failed or timed out is remembered for 60 s: the resolver is not asked again for that host', async () => {
    let t = 5_000_000
    const timers = { setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms), clearTimeout: (h: any) => clearTimeout(h), now: () => t }
    let asked = 0
    const fails = async () => { asked++; throw Object.assign(new Error('nx'), { code: 'ENOTFOUND' }) }
    expect(await resolveAllowed('gone.example', { resolve: fails, timers })).toEqual({ ok: false, why: 'dns' })
    expect(await resolveAllowed('gone.example', { resolve: fails, timers })).toEqual({ ok: false, why: 'dns' })
    expect(asked).toBe(1)
    // through fetchLimited too: no lookup, no request
    const spy = spyRequest()
    expect(await fetchLimited('http://gone.example/', { kind: 'html', request: spy, resolve: fails, timers })).toEqual({ ok: false, why: 'dns' })
    expect(asked).toBe(1)
    expect(spy.calls).toHaveLength(0)
    t += 59_000
    expect(await resolveAllowed('gone.example', { resolve: fails, timers })).toEqual({ ok: false, why: 'dns' })
    expect(asked).toBe(1)
    t += 2_000
    expect(await resolveAllowed('gone.example', { resolve: fails, timers })).toEqual({ ok: false, why: 'dns' })
    expect(asked).toBe(2)
    // a timed-out lookup too
    const hang = hangingResolve()
    expect(await resolveAllowed('slow-name.example', { resolve: hang, timers, timeoutMs: 100 })).toEqual({ ok: false, why: 'dns' })
    expect(await resolveAllowed('slow-name.example', { resolve: hang, timers, timeoutMs: 100 })).toEqual({ ok: false, why: 'dns' })
    expect(hang.calls).toEqual(['slow-name.example'])
    await hang.release()
    // an answer (even one refused for its address) is not a failure: not remembered
    let n = 0
    const priv = async () => { n++; return [{ address: '10.0.0.1', family: 4 }] }
    await resolveAllowed('private-name.example', { resolve: priv, timers })
    await resolveAllowed('private-name.example', { resolve: priv, timers })
    expect(n).toBe(2)
  })
  it('the whole-fetch timer ending a fetch during its lookup clears the DNS timer: no timer left behind', async () => {
    const live = new Set<any>()
    const timers = {
      setTimeout: (fn: () => void, ms: number) => { const h = setTimeout(() => { live.delete(h); fn() }, ms); live.add(h); return h },
      clearTimeout: (h: any) => { live.delete(h); clearTimeout(h) },
    }
    const hang = hangingResolve()
    const spy = spyRequest()
    const r = await fetchLimited('http://slow-dns.example/', { kind: 'html', request: spy, resolve: hang, timers, caps: { totalMs: 300 } })
    expect(r).toEqual({ ok: false, why: 'timeout' })
    expect(live.size).toBe(0)
    await hang.release()
    expect(LF.dnsGate()).toMatchObject({ running: 0, waiting: 0 })
  })
  it('the DNS timer cannot be raised by a caller', async () => {
    const hang = hangingResolve()
    const t0 = Date.now()
    expect(await resolveAllowed('raise.example', { resolve: hang, timeoutMs: 60_000 })).toEqual({ ok: false, why: 'dns' })
    expect(Date.now() - t0).toBeLessThan(3000)
    await hang.release()
  })
})

describe('5.9b 1xx: an informational response fails the fetch', () => {
  it('a server sending 102 Processing over and over → network, at once, socket destroyed', async () => {
    route('/processing', (_q, res) => {
      const t = setInterval(() => { try { (res as any).writeProcessing() } catch { /* gone */ } }, 20)
      res.on('close', () => clearInterval(t))
    })
    const t0 = Date.now()
    expect(await fetchLimited(at('/processing'), { kind: 'html', ...local() })).toEqual({ ok: false, why: 'network' })
    expect(Date.now() - t0).toBeLessThan(1500)
    expect(await waitFor(() => closed.some(c => c.path === '/processing'))).toBe(true)
  })
})

describe('5.9b an https page never pulls an http image', () => {
  // "https" is plain http on the loopback server: the scheme rule is what is tested, not TLS
  const tlsOverPlain = { http, https: { request: (opts: any) => http.request({ ...opts, protocol: 'http:', agent: false, servername: undefined }) } }
  it('og:image http: on an https page → no image, never requested; an https image on it is kept', async () => {
    route('/sec-page', html(`<title>secure</title><meta property="og:image" content="http://site.test:${PORT}/sec-down.png">`))
    route('/sec-page-ok', html(`<title>secure</title><meta property="og:image" content="https://site.test:${PORT}/sec-up.png">`))
    route('/sec-down.png', file('tiny.png', 'image/png'))
    route('/sec-up.png', file('tiny.png', 'image/png'))
    const notes: string[] = []
    const down = await previewOf(at('/sec-page', 'site.test', 'https'), { request: tlsOverPlain, note: (w: string) => notes.push(w), ...local() })
    expect(down).toMatchObject({ title: 'secure', image: null })
    expect(seenAt('/sec-down.png')).toHaveLength(0)
    expect(notes).toEqual(['scheme'])
    const up = await previewOf(at('/sec-page-ok', 'site.test', 'https'), { request: tlsOverPlain, ...local() })
    expect(up).toMatchObject({ title: 'secure', image: { type: 'png' } })
  })
  it('an http page that redirected to https: its final scheme counts', async () => {
    route('/to-sec', redirect(at('/sec-page', 'site.test', 'https')))
    const card = await previewOf(at('/to-sec'), { request: tlsOverPlain, ...local() })
    expect(card).toMatchObject({ title: 'secure', image: null })
    expect(seenAt('/sec-down.png')).toHaveLength(0)
  })
  it('fetchLimited fromSecure: an http URL → scheme, no lookup, no request', async () => {
    const spy = spyRequest()
    const resolve = fakeResolve(PUBLIC)
    expect(await fetchLimited('http://example.com/a.png', { kind: 'image', fromSecure: true, request: spy, resolve })).toEqual({ ok: false, why: 'scheme' })
    expect(spy.calls).toHaveLength(0)
    expect(resolve.calls).toHaveLength(0)
  })
})

describe('5.9b callers cannot raise a cap', () => {
  it('urlChars, redirects, the HTML text and read caps, the image limits: an override above the cap is the cap', async () => {
    const long = 'http://example.com/' + 'a'.repeat(3000)
    expect(checkUrl(long, { caps: { urlChars: 100_000 } })).toEqual({ ok: false, why: 'shape' })
    for (const n of [1, 2, 3, 4]) route(`/raise-c${n}`, redirect(`/raise-c${n + 1}`))
    route('/raise-c5', html('<title>end</title>'))
    expect(await fetchLimited(at('/raise-c1'), { kind: 'html', caps: { redirects: 10 }, ...local() })).toEqual({ ok: false, why: 'redirect' })
    route('/raise-forever', (_q, res) => {
      res.writeHead(200, { 'content-type': 'text/html' })
      const chunk = Buffer.alloc(64 << 10, 0x61)
      let gone = false
      res.on('close', () => { gone = true })
      const pump = () => { while (!gone) { if (!res.write(chunk)) { res.once('drain', pump); return } } }
      pump()
    })
    const r = await fetchLimited(at('/raise-forever'), { kind: 'html', caps: { htmlText: 64 << 20, htmlBytes: 64 << 20 }, ...local() })
    expect(r.bytes.length).toBe(512 << 10)
    expect(r.read).toBeLessThanOrEqual(1 << 20)
    expect(imageAllowed(sniffImage(fixture('huge-dims.png')), { imageSide: 1e6, imagePixels: 1e12 })).toBe(false)
  })
  it('the timers asked for never exceed the caps', async () => {
    const asked: number[] = []
    const timers = { setTimeout: (fn: () => void, ms: number) => { asked.push(ms); return setTimeout(fn, ms) }, clearTimeout }
    route('/raise-timers', html('<title>t</title>'))
    const caps = { totalMs: 1e9, headersMs: 1e9, idleMs: 1e9, dnsMs: 1e9 }
    expect((await fetchLimited(at('/raise-timers'), { kind: 'html', timers, caps, ...local() })).ok).toBe(true)
    expect(asked[0]).toBe(6000)
    expect(Math.max(...asked)).toBe(6000)
  })
  it('previewOf with raised image caps: a 30000×30000 image is still not kept', async () => {
    route('/raise-img', html('<title>big</title><meta property="og:image" content="/raise-huge.png">'))
    route('/raise-huge.png', file('huge-dims.png', 'image/png'))
    const card = await previewOf(at('/raise-img'), { caps: { imageSide: 1e6, imagePixels: 1e12, imageBytes: 1e9 }, ...local() })
    expect(card).toMatchObject({ title: 'big', image: null })
  })
  it('a lower override still lowers (the raw-cap test above relies on it)', () => {
    expect(checkUrl('http://example.com/' + 'a'.repeat(100), { caps: { urlChars: 50 } })).toEqual({ ok: false, why: 'shape' })
  })
})

describe('5.9b blocklist additions', () => {
  it('Azure WireServer 168.63.129.16, AS112 192.31.196/24, 192.52.193/24, 192.175.48/24 refused; their neighbours pass', async () => {
    for (const ip of ['168.63.129.16', '192.31.196.1', '192.31.196.255', '192.52.193.1', '192.52.193.255', '192.175.48.1', '192.175.48.6']) expect(addressAllowed(ip, 4, {}), ip).toBe(false)
    for (const ip of ['168.63.129.15', '168.63.129.17', '192.31.195.255', '192.31.197.0', '192.52.192.255', '192.52.194.0', '192.175.47.255', '192.175.49.0']) expect(addressAllowed(ip, 4, {}), ip).toBe(true)
    await refused('http://168.63.129.16/machine?comp=goalstate', 'address')
    await refused('http://wire.example/', 'address', { lexical: false, table: { 'wire.example': ['168.63.129.16'] } })
  })
  it('ISATAP: the IPv4 in …:0:5efe:a.b.c.d and …:200:5efe:… is unpacked and checked', () => {
    for (const ip of ['2001:4860:1:2:0:5efe:127.0.0.1', '2001:4860:1:2:200:5efe:10.0.0.1', '2a00:1450:1:2:0:5efe:a9fe:a9fe', '2a00:1450:1:2:100:5efe:192.168.0.1', '2a00:1450:1:2:300:5efe:168.63.129.16']) {
      expect(addressAllowed(ip, 6, {}), ip).toBe(false)
    }
    // a public IPv4 inside an ISATAP address under a global prefix passes
    expect(addressAllowed('2001:4860:1:2:200:5efe:8.8.8.8', 6, {})).toBe(true)
    expect(checkUrl('http://[2001:4860:1:2:0:5efe:7f00:1]/', {})).toEqual({ ok: false, why: 'address' })
  })
  it('.localdomain is a local suffix', async () => {
    for (const url of ['http://host.localdomain/', 'http://localhost.localdomain/', 'http://nas.localdomain./']) {
      expect(checkUrl(url, {}), url).toEqual({ ok: false, why: 'name' })
      await refused(url, 'name')
    }
  })
})

describe('5.9b headers: maxHeaderSize 16 KB holds on a real socket', () => {
  it('a response with a 20 KB header, or 4,000 headers → network; 8 KB of headers is fine', async () => {
    route('/big-header', (_q, res) => { res.setHeader('x-big', 'a'.repeat(20 << 10)); res.writeHead(200, { 'content-type': 'text/html' }); res.end('<title>x</title>') })
    route('/many-headers', (_q, res) => { for (let i = 0; i < 4000; i++) res.setHeader(`x-h${i}`, '1'); res.writeHead(200, { 'content-type': 'text/html' }); res.end('<title>x</title>') })
    route('/fine-headers', (_q, res) => { res.setHeader('x-fine', 'a'.repeat(8 << 10)); res.writeHead(200, { 'content-type': 'text/html' }); res.end('<title>x</title>') })
    expect(await fetchLimited(at('/big-header'), { kind: 'html', ...local() })).toEqual({ ok: false, why: 'network' })
    expect(await fetchLimited(at('/many-headers'), { kind: 'html', ...local() })).toEqual({ ok: false, why: 'network' })
    expect((await fetchLimited(at('/fine-headers'), { kind: 'html', ...local() })).ok).toBe(true)
  })
})

describe.skipIf(!HAS_V6)('5.9b the pin over IPv6: a server on ::1, the resolver answers ::1', () => {
  it('the connection goes to ::1, the resolver asked once, never the system resolver', async () => {
    let localAddr = ''
    const srv6 = http.createServer((req, res) => { localAddr = req.socket.localAddress || ''; res.writeHead(200, { 'content-type': 'text/html' }); res.end('<title>six</title>') })
    await new Promise<void>(r => srv6.listen(0, '::1', r))
    try {
      const resolve = fakeResolve({ 'six.test': ['::1'] })
      const r = await fetchLimited(`http://six.test:${(srv6.address() as net.AddressInfo).port}/`, { kind: 'html', allowLoopback: true, resolve })
      expect(r.ok).toBe(true)
      expect(localAddr).toBe('::1')
      expect(resolve.calls).toHaveLength(1)
      expect(systemDns).not.toContain('six.test')
    } finally {
      await new Promise(r => srv6.close(r))
    }
  })
})

describe('no real network', () => {
  it('nothing in this file reached the system resolver', () => {
    expect(systemDns).toEqual([])
  })
})
