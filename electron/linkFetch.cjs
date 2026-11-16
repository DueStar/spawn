'use strict'

/**
 * linkFetch.cjs — the link-preview fetcher (Phase 5): the policy and the transport, pure over an injected
 * `resolve`, `request` and `timers`. It runs in the chat worker (linkPreview.cjs hosts it), never in the page
 * and never in the main process's own thread. Previews are opt-in; this module is only ever handed a URL
 * once the user has turned them on.
 *
 * Every hop goes through the same rules, in this order (the plan's "Link preview policy"):
 *   1. the URL, lexically (checkUrl): http/https only; parsed by WHATWG URL; at most 2048 characters; no
 *      userinfo; port 80 or 443; local and single-label names refused; an IP literal (any form WHATWG
 *      normalises: decimal, hex, octal, short) checked as an address;
 *   2. the name resolved once (all addresses, verbatim, 2 s), and EVERY address checked (addressAllowed):
 *      one private address refuses the name; at most 2 lookups at once module-wide (the DNS gate), a failed
 *      name not asked again for 60 s;
 *   3. the request connects to the checked address through a pinned lookup, so a second resolution (a DNS
 *      rebind) cannot happen; TLS servername = the host, the certificate always checked (said explicitly, so
 *      the environment cannot turn it off), TLS 1.2 at least; a fresh agent without keep-alive (no shared
 *      pool; a replaced global agent is never used; no proxy); a 1xx response fails the fetch;
 *   4. redirects by hand, at most 3, each hop through 1-3 again; https -> http refused (an https page's image
 *      too);
 *   5. status 200 only; a page must say text/html or application/xhtml+xml; an image is judged by its bytes;
 *   6. time caps (DNS 2 s, connect + headers 4 s, idle 2 s, 6 s for the whole fetch) and size caps (1 MB of a
 *      page / 2 MB of an image read; 512 KB of HTML, reading stops at </head> or <body; zlib output counted,
 *      so a gzip, deflate or brotli bomb ends at the cap); every stop destroys the socket.
 * The request carries exactly the three headers in HEADERS: no credentials and nothing about the user, the
 * app or the conversation the link was in. A header the server sends to be stored is never kept or sent back.
 * Nothing is written anywhere and this module logs nothing itself: refusalLog is handed a writer by its host
 * and writes fixed words and counts only, never a URL, a host or page text.
 *
 * HTML is read by a small linear tag scanner (readMeta): no DOM, nothing executed. An image is never
 * decoded here: its magic bytes and its header's dimensions are read (sniffImage); the page decodes it in the
 * sandboxed renderer from a blob: URL it made itself.
 *
 * Mirrored shape (src/chat/types.ts):
 * @typedef {{ url: string, site: string, via: string | null, title: string, description: string,
 *   image: { bytes: Uint8Array, type: 'png' | 'jpeg' | 'webp', width: number, height: number } | null }} LinkCardData
 *   url: the link as written; site: the link's own host, always (Unicode, punycode beside when not ASCII:
 *   og:site_name is only what the page claims, so a card never names it); via: the final host when a redirect
 *   left the link's host.
 */

const http = require('http')
const https = require('https')
const dns = require('dns')
const net = require('net')
const zlib = require('zlib')
const { domainToUnicode } = require('url')
const { previewShape } = require('./linkShape.cjs')

/** The one source of the fetcher's limits (the policy table's numbers) */
const LINK_CAPS = Object.freeze({
  urlChars: 2048,
  dnsMs: 2000, headersMs: 4000, idleMs: 2000, totalMs: 6000,
  redirects: 3,
  htmlBytes: 1 << 20, imageBytes: 2 << 20, htmlText: 512 << 10,
  imageSide: 4096, imagePixels: 12000000, jpegScan: 64 << 10,
  title: 200, description: 400, site: 80,
  answers: 64,
})

const USER_AGENT = 'Mozilla/5.0 (compatible; link-preview)'
const HEADERS = Object.freeze({
  'User-Agent': USER_AGENT,
  Accept: 'text/html,application/xhtml+xml;q=0.9,image/*;q=0.8',
  'Accept-Encoding': 'gzip, deflate, br',
})

const TIMERS = Object.freeze({ setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: (t) => clearTimeout(t) })

/** The caps with a caller's overrides, each only ever LOWER than the policy's (a caller cannot raise a cap) */
const capsOf = (over) => {
  if (!over || typeof over !== 'object') return LINK_CAPS
  const out = { ...LINK_CAPS }
  for (const k of Object.keys(LINK_CAPS)) if (Number.isFinite(over[k]) && over[k] > 0) out[k] = Math.min(over[k], LINK_CAPS[k])
  return Object.freeze(out)
}
const no = (why) => ({ ok: false, why })

// ---- addresses

/** Every range the policy refuses. IPv4-mapped (::ffff:0:0/96) is deliberately not a BlockList rule: a rule
 *  of that range matches every IPv4 address. Mapped and other non-global IPv6 addresses are refused by the
 *  global-unicast rule (GLOBAL6), and the IPv4 address embedded in any IPv6 form is checked on its own. */
const BLOCKED_RANGES = Object.freeze([
  ['0.0.0.0', 8, 'ipv4'], ['10.0.0.0', 8, 'ipv4'], ['100.64.0.0', 10, 'ipv4'], ['127.0.0.0', 8, 'ipv4'],
  ['169.254.0.0', 16, 'ipv4'], ['172.16.0.0', 12, 'ipv4'], ['192.0.0.0', 24, 'ipv4'], ['192.0.2.0', 24, 'ipv4'],
  ['192.88.99.0', 24, 'ipv4'], ['192.168.0.0', 16, 'ipv4'], ['198.18.0.0', 15, 'ipv4'], ['198.51.100.0', 24, 'ipv4'],
  ['203.0.113.0', 24, 'ipv4'], ['224.0.0.0', 4, 'ipv4'], ['240.0.0.0', 4, 'ipv4'], ['255.255.255.255', 32, 'ipv4'],
  // Azure's WireServer (a metadata endpoint reachable from every Azure VM), and the AS112 sinks
  ['168.63.129.16', 32, 'ipv4'], ['192.31.196.0', 24, 'ipv4'], ['192.52.193.0', 24, 'ipv4'], ['192.175.48.0', 24, 'ipv4'],
  ['::', 128, 'ipv6'], ['::1', 128, 'ipv6'], ['64:ff9b::', 96, 'ipv6'], ['64:ff9b:1::', 48, 'ipv6'], ['100::', 64, 'ipv6'],
  ['2001::', 23, 'ipv6'], ['2001:db8::', 32, 'ipv6'], ['2002::', 16, 'ipv6'], ['3fff::', 20, 'ipv6'],
  ['fc00::', 7, 'ipv6'], ['fe80::', 10, 'ipv6'], ['fec0::', 10, 'ipv6'], ['ff00::', 8, 'ipv6'],
])
const BLOCKED = new net.BlockList()
for (const [a, p, t] of BLOCKED_RANGES) BLOCKED.addSubnet(a, p, t)
/** Only global unicast IPv6 can be public */
const GLOBAL6 = new net.BlockList()
GLOBAL6.addSubnet('2000::', 3, 'ipv6')
const LOOPBACK4 = new net.BlockList()
LOOPBACK4.addSubnet('127.0.0.0', 8, 'ipv4')

/** The eight 16-bit groups of a valid IPv6 address (net.isIP said 6, no zone) */
function hextets(ip) {
  let s = ip
  let tail = null
  if (s.includes('.')) {
    const c = s.lastIndexOf(':')
    const p = s.slice(c + 1).split('.').map(Number)
    tail = [(p[0] << 8) | p[1], (p[2] << 8) | p[3]]
    s = s.slice(0, c + 1) + '0:0'
  }
  const halves = s.split('::')
  const head = halves[0] ? halves[0].split(':') : []
  let parts = head
  if (halves.length === 2) {
    const rest = halves[1] ? halves[1].split(':') : []
    parts = [...head, ...new Array(Math.max(0, 8 - head.length - rest.length)).fill('0'), ...rest]
  }
  const out = parts.map((x) => parseInt(x, 16) || 0)
  if (tail) { out[6] = tail[0]; out[7] = tail[1] }
  return out
}

const dotted = (a, b) => `${a >> 8}.${a & 255}.${b >> 8}.${b & 255}`
/** IPv4 addresses an IPv6 address carries: mapped, compatible, translated, NAT64, 6to4, Teredo (server, client),
 *  ISATAP (an interface id of 0:5efe or 200:5efe, with the u/g bits either way, under any prefix) */
function embeddedV4(h) {
  const zero = (from, to) => h.slice(from, to).every((x) => x === 0)
  const out = []
  if (zero(0, 5) && h[5] === 0xffff) out.push(dotted(h[6], h[7]))
  if (zero(0, 6)) out.push(dotted(h[6], h[7]))
  if (zero(0, 4) && h[4] === 0xffff && h[5] === 0) out.push(dotted(h[6], h[7]))
  if (h[0] === 0x64 && h[1] === 0xff9b) out.push(dotted(h[6], h[7]))
  if (h[0] === 0x2002) out.push(dotted(h[1], h[2]))
  if (h[0] === 0x2001 && h[1] === 0) { out.push(dotted(h[2], h[3])); out.push(dotted(h[6] ^ 0xffff, h[7] ^ 0xffff)) }
  if ((h[4] & 0xfcff) === 0 && h[5] === 0x5efe) out.push(dotted(h[6], h[7]))
  return out
}

function isLoopback(ip, fam) {
  if (fam === 4) return LOOPBACK4.check(ip, 'ipv4')
  const h = hextets(ip)
  return zeroUpTo(h, 7) && h[7] === 1
}
const zeroUpTo = (h, n) => { for (let i = 0; i < n; i++) if (h[i] !== 0) return false; return true }
/** A NAT64 address (64:ff9b::/96, or the local-use 64:ff9b:1::/48): an IPv4 one as an IPv6-only network reaches it */
const isNat64 = (ip) => { const h = hextets(ip); return h[0] === 0x64 && h[1] === 0xff9b }

/**
 * Whether a connection to this address is allowed. `allowLoopback` (the test switch, set only by main in an
 * unpackaged build) permits 127.0.0.0/8 and ::1 and nothing else.
 */
function addressAllowed(ip, family, opts = {}) {
  if (typeof ip !== 'string' || ip.includes('%')) return false
  const fam = net.isIP(ip)
  if (!fam || (family && family !== fam)) return false
  if (opts && opts.allowLoopback === true && isLoopback(ip, fam)) return true
  if (fam === 4) return !BLOCKED.check(ip, 'ipv4')
  for (const v4 of embeddedV4(hextets(ip))) if (BLOCKED.check(v4, 'ipv4')) return false
  if (!GLOBAL6.check(ip, 'ipv6')) return false
  return !BLOCKED.check(ip, 'ipv6')
}

// ---- the URL

const SCHEME = /^([a-zA-Z][a-zA-Z0-9+.-]*):/
const AUTHORITY = /^[a-zA-Z][a-zA-Z0-9+.-]*:[\\/]*([^\\/?#]*)/
/** A character class from code point ranges, built at run time (the source holds no invisible character) */
const classOf = (ranges, flags = '') =>
  new RegExp('[' + ranges.map(([a, b]) => String.fromCodePoint(a) + (b === undefined ? '' : '-' + String.fromCodePoint(b))).join('') + ']', flags)
/** C0 controls and DEL */
const CTRL = classOf([[0x00, 0x1f], [0x7f]])
/** C0 controls, space and DEL: never in a URL as written */
const UNSAFE = classOf([[0x00, 0x20], [0x7f]])
const LOCAL_SUFFIXES = ['.localhost', '.local', '.localdomain', '.internal', '.arpa', '.lan', '.intranet', '.corp', '.home', '.private', '.onion']

/**
 * The URL rules that need no lookup. → { ok: true, url, host, ip, port, secure, loopbackOnly } | { ok: false, why }
 * `loopbackOnly`: a port other than 80/443 under the test switch, allowed only if every address is loopback.
 */
function checkUrl(raw, opts = {}) {
  const caps = capsOf(opts && opts.caps)
  const allowLoopback = !!opts && opts.allowLoopback === true
  if (typeof raw !== 'string') return no('shape')
  const m = SCHEME.exec(raw)
  if (!m) return no('shape')
  const scheme = m[1].toLowerCase()
  if (scheme !== 'http' && scheme !== 'https') return no('scheme')
  if (raw.length > caps.urlChars || UNSAFE.test(raw)) return no('shape')
  let u
  try { u = new URL(raw) } catch { return no('shape') }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return no('scheme')
  if (u.href.length > caps.urlChars) return no('shape')
  const auth = AUTHORITY.exec(raw)
  if (u.username || u.password || (auth && auth[1].includes('@'))) return no('userinfo')
  const secure = u.protocol === 'https:'
  const port = u.port === '' ? (secure ? 443 : 80) : Number(u.port)
  let loopbackOnly = false
  if (port !== 80 && port !== 443) {
    if (!allowLoopback) return no('port')
    loopbackOnly = true
  }
  let host = u.hostname
  let ip = null
  if (host.startsWith('[')) ip = host.slice(1, -1)
  else if (net.isIP(host) === 4) ip = host
  if (ip !== null) {
    const fam = net.isIP(ip)
    if (!fam || !addressAllowed(ip, fam, { allowLoopback })) return no('address')
    if (loopbackOnly && !isLoopback(ip, fam)) return no('port')
    host = ip
  } else {
    if (host.endsWith('.')) host = host.slice(0, -1)
    if (!host || host.length > 253 || !host.includes('.') || host.startsWith('.') || host.endsWith('.')) return no('name')
    if (host === 'localhost' || LOCAL_SUFFIXES.some((s) => host.endsWith(s))) return no('name')
  }
  return { ok: true, url: u.href, host, ip, port, secure, loopbackOnly }
}

/** A Location header → the next hop's URL, or null (control characters, too long, not a URL) */
function redirectTarget(location, current) {
  if (typeof location !== 'string' || !location.trim() || location.length > LINK_CAPS.urlChars) return null
  if (CTRL.test(location)) return null
  try {
    const u = new URL(location, current)
    return u.href.length > LINK_CAPS.urlChars ? null : u.href
  } catch {
    return null
  }
}

// ---- DNS

/**
 * The DNS gate. dns.lookup runs on libuv's thread pool (shared with zlib and file reads) and cannot be cancelled, so at
 * most DNS_RUNNING lookups run at once, module-wide; a lookup keeps its place until it really ends, even after our
 * timer gave up on it. Others wait for a place, within the same DNS timer (then: dns). A name whose lookup failed or
 * timed out is not asked again for DNS_FORGET_MS (a short negative cache, at most DNS_REMEMBER names, in memory).
 */
const DNS_RUNNING = 2
const DNS_FORGET_MS = 60000
const DNS_REMEMBER = 256
const gate = { running: 0, waiting: [] }
const dnsFailed = new Map() // name → until (insertion order: oldest first)
const nowOf = (timers) => (typeof timers.now === 'function' ? timers.now() : Date.now())

function gateRelease() {
  gate.running--
  const next = gate.waiting.shift()
  if (next) next()
}

/**
 * One lookup through the gate, under one timer that covers the wait and the lookup. → { list } | { failed: true }
 * (the resolver failed or timed out: the name's fault) | { gave: true } (no place in time, or cancelled: not the
 * name's fault). `hold.cancel` is set while it runs: the fetch calls it when it ends first (no timer left behind).
 */
function gatedLookup(name, resolve, ms, timers, hold) {
  return new Promise((done) => {
    let settled = false
    let started = false
    let timer = null
    const end = (v) => {
      if (settled) return
      settled = true
      if (timer !== null) timers.clearTimeout(timer)
      const i = gate.waiting.indexOf(start)
      if (i >= 0) gate.waiting.splice(i, 1)
      if (hold) hold.cancel = null
      done(v)
    }
    function start() {
      started = true
      gate.running++
      let p
      try { p = Promise.resolve(resolve(name, { all: true, verbatim: true })) } catch (e) { p = Promise.reject(e) }
      p.then(gateRelease, gateRelease)
      p.then((list) => end({ list }), () => end({ failed: true }))
    }
    timer = timers.setTimeout(() => end(started ? { failed: true } : { gave: true }), ms)
    if (hold) hold.cancel = () => end({ gave: true })
    if (gate.running < DNS_RUNNING) start()
    else gate.waiting.push(start)
  })
}

/** The gate's state, for tests: lookups running, lookups waiting, names remembered as failed */
const dnsGate = () => ({ running: gate.running, waiting: gate.waiting.length, remembered: dnsFailed.size })

/**
 * Resolve a name once and check every address. → { ok: true, address, family } (the first; the request is
 * pinned to it) | { ok: false, why }. An IP literal is checked without a lookup.
 */
async function resolveAllowed(host, opts = {}) {
  const resolve = typeof opts.resolve === 'function' ? opts.resolve : dns.promises.lookup
  const timers = opts.timers || TIMERS
  const timeoutMs = Number.isFinite(opts.timeoutMs) && opts.timeoutMs > 0 ? Math.min(opts.timeoutMs, LINK_CAPS.dnsMs) : LINK_CAPS.dnsMs
  const allowLoopback = opts.allowLoopback === true
  const loopbackOnly = opts.loopbackOnly === true
  if (typeof host !== 'string' || !host) return no('dns')
  const bare = host.startsWith('[') ? host.slice(1, -1) : host
  const lit = net.isIP(bare)
  if (lit) {
    if (!addressAllowed(bare, lit, { allowLoopback })) return no('address')
    if (loopbackOnly && !isLoopback(bare, lit)) return no('port')
    return { ok: true, address: bare, family: lit }
  }
  const key = bare.toLowerCase()
  const until = dnsFailed.get(key)
  if (until !== undefined) {
    if (nowOf(timers) < until) return no('dns')
    dnsFailed.delete(key)
  }
  const got = await gatedLookup(bare, resolve, timeoutMs, timers, opts.hold)
  if (got.failed) {
    dnsFailed.set(key, nowOf(timers) + DNS_FORGET_MS)
    while (dnsFailed.size > DNS_REMEMBER) dnsFailed.delete(dnsFailed.keys().next().value)
    return no('dns')
  }
  if (!got.list) return no('dns')
  const list = got.list
  if (!Array.isArray(list) || list.length === 0 || list.length > LINK_CAPS.answers) return no('dns')
  // (an IPv6-only network with NAT64/DNS64 answers every name with 64:ff9b::/96 addresses: still refused — the block
  // is not loosened — but said as its own kind, so the log can name the reason once; the final review's M9)
  const nat64 = list.every((a) => a && typeof a.address === 'string' && net.isIP(a.address) === 6 && isNat64(a.address))
  for (const a of list) {
    const address = a && a.address
    const fam = typeof address === 'string' ? net.isIP(address) : 0
    if (!fam || a.family !== fam) return no('dns')
    if (!addressAllowed(address, fam, { allowLoopback })) return no(nat64 ? 'nat64' : 'address')
    if (loopbackOnly && !isLoopback(address, fam)) return no('port')
  }
  return { ok: true, address: list[0].address, family: list[0].family }
}

// ---- the transport

const REDIRECTS = new Set([301, 302, 303, 307, 308])
/** Where reading a page stops: the head is over */
const HEAD_END = /<\/head[\s>/]|<body[\s>/]/i
const Z_OPTS = Object.freeze({ finishFlush: zlib.constants.Z_SYNC_FLUSH })

/**
 * Fetch one URL under every rule. kind 'html' | 'image'.
 * → { ok: true, finalUrl, bytes, type, contentType, read } | { ok: false, why }
 * `bytes`: a page's HTML (decompressed, cut at </head> / <body / 512 KB / the read cap) or an image's bytes
 * (whole, ≤ 2 MB). `read`: compressed bytes read. why: scheme | shape | userinfo | port | name | address |
 * dns | redirect | status | type | encoding | timeout | size | network | off.
 * `fromSecure`: the URL was found on an https page (an og:image): an http URL is refused (scheme), as a redirect
 * from https to http is.
 * `signal` (an AbortSignal): when it aborts (previews off, the view closed) the fetch ends at once as `off`: its
 * socket, response and agent destroyed, no redirect hop and no request after it.
 */
function fetchLimited(rawUrl, opts = {}) {
  const kind = opts.kind === 'image' ? 'image' : 'html'
  const request = opts.request || { http, https }
  const resolve = typeof opts.resolve === 'function' ? opts.resolve : dns.promises.lookup
  const timers = opts.timers || TIMERS
  const caps = capsOf(opts.caps)
  const allowLoopback = opts.allowLoopback === true
  const fromSecure = opts.fromSecure === true
  const signal = opts.signal && typeof opts.signal.addEventListener === 'function' ? opts.signal : null

  return new Promise((done) => {
    // (stopped before it began: nothing at all, not even a lookup)
    if (signal && signal.aborted) { done(no('off')); return }
    let finished = false
    let req = null
    let res = null
    let agent = null
    let decoder = null
    let headersTimer = null
    let idleTimer = null
    /** the running lookup's cancel (its timer cleared when the fetch ends first) */
    const hold = { cancel: null }

    /** Close the transport of the current hop (the decoder may still flush what it was given) */
    const dropTransport = () => {
      if (headersTimer) { timers.clearTimeout(headersTimer); headersTimer = null }
      if (idleTimer) { timers.clearTimeout(idleTimer); idleTimer = null }
      const r0 = req; const s0 = res; const a0 = agent
      req = null; res = null; agent = null
      if (s0) s0.destroy()
      if (r0) r0.destroy()
      if (a0) a0.destroy()
    }
    const finish = (result) => {
      if (finished) return
      finished = true
      timers.clearTimeout(totalTimer)
      if (signal) signal.removeEventListener('abort', onAbort)
      if (hold.cancel) hold.cancel()
      dropTransport()
      if (decoder) { decoder.destroy(); decoder = null }
      done(result)
    }
    const fail = (why) => finish(no(why))
    const totalTimer = timers.setTimeout(() => fail('timeout'), caps.totalMs)
    // previews turned off, or the view closed (linkPreview.cjs): at once, the socket destroyed, no further hop
    function onAbort() { fail('off') }
    if (signal) signal.addEventListener('abort', onAbort)

    const hop = async (href, redirects, wasSecure) => {
      if (finished) return
      const c = checkUrl(href, { allowLoopback, caps })
      if (!c.ok) return fail(c.why)
      if (wasSecure && !c.secure) return fail('scheme')
      const r = await resolveAllowed(c.host, { resolve, timers, allowLoopback, loopbackOnly: c.loopbackOnly, timeoutMs: caps.dnsMs, hold })
      if (finished) return
      if (!r.ok) return fail(r.why)
      send(c, r, redirects, wasSecure || c.secure)
    }

    const send = (c, r, redirects, secure) => {
      if (finished) return
      const mod = c.secure ? request.https : request.http
      agent = c.secure ? new https.Agent({ keepAlive: false }) : new http.Agent({ keepAlive: false })
      /** The pinned lookup: the checked address, for the checked name only; never a second resolution */
      const lookup = (name, o, cb) => {
        if (typeof o === 'function') { cb = o; o = {} }
        if (name !== c.host) { cb(Object.assign(new Error('not the checked name'), { code: 'ENOTFOUND' })); return }
        if (o && o.all) cb(null, [{ address: r.address, family: r.family }])
        else cb(null, r.address, r.family)
      }
      const u = new URL(c.url)
      const options = {
        protocol: c.secure ? 'https:' : 'http:', host: c.host, port: c.port, path: u.pathname + u.search, method: 'GET',
        headers: { ...HEADERS }, agent, lookup, maxHeaderSize: 16 * 1024,
      }
      if (c.secure) {
        // said explicitly, so the environment variable that turns certificate checks off cannot reach this request
        Object.assign(options, { rejectUnauthorized: true, minVersion: 'TLSv1.2' })
        if (c.ip === null) options.servername = c.host
      }
      let mine
      try { mine = mod.request(options) } catch { return fail('network') }
      req = mine
      mine.on('error', () => { if (req === mine) fail('network') })
      // a 1xx (102 Processing, 103 Early Hints, …) is never asked for: one fails the fetch (no 1xx flood)
      mine.on('information', () => { if (req === mine) fail('network') })
      headersTimer = timers.setTimeout(() => fail('timeout'), caps.headersMs)
      mine.on('response', (incoming) => {
        if (finished || req !== mine) { incoming.on('error', () => {}); incoming.destroy(); return }
        timers.clearTimeout(headersTimer); headersTimer = null
        res = incoming
        incoming.on('error', () => { if (res === incoming) fail('network') })
        const status = incoming.statusCode
        if (REDIRECTS.has(status)) {
          const location = incoming.headers.location
          dropTransport()
          if (redirects >= caps.redirects) return fail('redirect')
          if (typeof location !== 'string' || location === '') return fail('redirect')
          const next = redirectTarget(location, c.url)
          if (!next) return fail('shape')
          hop(next, redirects + 1, secure).catch(() => fail('network'))
          return
        }
        if (status !== 200) return fail('status')
        read(incoming, c)
      })
      mine.end()
    }

    const read = (incoming, c) => {
      const contentType = String(incoming.headers['content-type'] || '')
      const type = contentType.split(';')[0].trim().toLowerCase()
      if (kind === 'html' && type !== 'text/html' && type !== 'application/xhtml+xml') return fail('type')
      const readCap = kind === 'image' ? caps.imageBytes : caps.htmlBytes
      const outCap = kind === 'image' ? caps.imageBytes : caps.htmlText
      const declared = Number(incoming.headers['content-length'])
      if (kind === 'image' && Number.isFinite(declared) && declared > readCap) return fail('size')
      const enc = String(incoming.headers['content-encoding'] || '').trim().toLowerCase()
      let mode = null
      if (enc === 'gzip' || enc === 'x-gzip') mode = 'gzip'
      else if (enc === 'deflate') mode = 'deflate'
      else if (enc === 'br') mode = 'br'
      else if (enc !== '' && enc !== 'identity') return fail('encoding')

      // The bytes kept go into ONE buffer of the cap's size, made at the first byte (copied in at an offset), never
      // into a list of the chunks: a server sending 1-byte chunks costs no more memory than one sending 64 KB ones.
      let store = null
      let got = 0     // compressed bytes read
      let out = 0     // bytes kept (decompressed)
      let tail = ''
      let inputDone = false
      let head = null // deflate: its first byte, until a second says zlib-wrapped or raw
      const put = (b) => {
        if (!store) store = Buffer.allocUnsafe(outCap)
        b.copy(store, out)
        out += b.length
      }
      const succeed = () => finish({ ok: true, finalUrl: c.url, bytes: store ? store.subarray(0, out) : Buffer.alloc(0), type, contentType, read: got })

      /** Decompressed bytes, counted */
      const take = (chunk) => {
        if (finished) return
        if (kind === 'image') {
          if (out + chunk.length > outCap) return fail('size')
          put(chunk)
          return
        }
        const piece = chunk.length > outCap - out ? chunk.subarray(0, outCap - out) : chunk
        const text = tail + piece.toString('latin1')
        const m = HEAD_END.exec(text)
        if (m) {
          const keep = m.index - tail.length
          if (keep > 0) put(piece.subarray(0, keep))
          else out += keep // (the end began in the bytes already kept: they are cut)
          return succeed()
        }
        put(piece)
        tail = text.slice(-8)
        if (out >= outCap) succeed()
      }
      const makeDecoder = (first) => {
        let d
        if (mode === 'gzip') d = zlib.createGunzip(Z_OPTS)
        else if (mode === 'br') d = zlib.createBrotliDecompress({ finishFlush: zlib.constants.BROTLI_OPERATION_FLUSH })
        else {
          const wrapped = first.length >= 2 && (first[0] & 0x0f) === 8 && ((first[0] << 8) | first[1]) % 31 === 0
          d = wrapped ? zlib.createInflate(Z_OPTS) : zlib.createInflateRaw(Z_OPTS)
        }
        d.on('data', take)
        d.on('error', () => { if (decoder === d) fail('encoding') })
        d.on('end', () => { if (decoder === d && !finished) succeed() })
        return d
      }
      /** The decoder for these first bytes (deflate needs two to tell zlib from raw), fed them */
      const startDecoder = (first) => {
        decoder = makeDecoder(first)
        decoder.write(first)
      }
      const endInput = () => {
        if (finished || inputDone) return
        inputDone = true
        dropTransport()
        if (mode && !decoder && head) { const h = head; head = null; startDecoder(h) }
        if (decoder) decoder.end()
        else succeed()
      }
      const resetIdle = () => {
        if (idleTimer) timers.clearTimeout(idleTimer)
        idleTimer = timers.setTimeout(() => fail('timeout'), caps.idleMs)
      }
      resetIdle()
      incoming.on('data', (chunk) => {
        if (finished || inputDone || res !== incoming) return
        resetIdle()
        let piece = chunk
        let over = false
        if (got + piece.length > readCap) {
          if (kind === 'image') return fail('size')
          piece = piece.subarray(0, readCap - got)
          over = true
        }
        got += piece.length
        if (mode && !decoder) {
          const first = head ? Buffer.concat([head, piece]) : piece
          head = null
          if (mode === 'deflate' && first.length < 2) { if (first.length) head = Buffer.from(first) }
          else if (first.length) startDecoder(first)
        } else if (decoder) decoder.write(piece)
        else take(piece)
        if (over) endInput()
      })
      incoming.on('end', () => { if (res === incoming) endInput() })
    }

    hop(rawUrl, 0, fromSecure).catch(() => fail('network'))
  })
}

// ---- HTML

const isSpace = (c) => c === 32 || c === 9 || c === 10 || c === 12 || c === 13
const isAlpha = (c) => (c >= 65 && c <= 90) || (c >= 97 && c <= 122)
const isNameChar = (c) => isAlpha(c) || (c >= 48 && c <= 57) || c === 45 || c === 58 || c === 95 || c === 46
const VALUE_MAX = 8192
const ATTRS_MAX = 64
/** Elements whose body is text, not markup: skipped whole (a <title>'s text is kept) */
const RAW_END = new Map(['script', 'style', 'noscript', 'template', 'textarea', 'title', 'xmp', 'iframe', 'noembed', 'noframes']
  .map((n) => [n, new RegExp(`</${n}[\\s/>]`, 'ig')]))

/**
 * A tag's attributes from `k` (just after its name) to its '>'. → the index after '>', or -1 when the tag
 * never closes (then no later tag can close either: the scan ends). Forward only: linear.
 */
function attributes(s, k, attrs) {
  const n = s.length
  while (k < n) {
    let c = s.charCodeAt(k)
    if (c === 62) return k + 1
    if (isSpace(c) || c === 47) { k++; continue }
    const a0 = k
    k++
    while (k < n) { c = s.charCodeAt(k); if (isSpace(c) || c === 47 || c === 62 || c === 61) break; k++ }
    const keep = attrs !== null && attrs.size < ATTRS_MAX
    const name = keep ? s.slice(a0, Math.min(k, a0 + 64)).toLowerCase() : ''
    while (k < n && isSpace(s.charCodeAt(k))) k++
    let value = ''
    if (k < n && s.charCodeAt(k) === 61) {
      k++
      while (k < n && isSpace(s.charCodeAt(k))) k++
      const q = s.charCodeAt(k)
      if (q === 34 || q === 39) {
        const e = s.indexOf(q === 34 ? '"' : "'", k + 1)
        if (e < 0) return -1
        if (keep) value = s.slice(k + 1, Math.min(e, k + 1 + VALUE_MAX))
        k = e + 1
      } else {
        const v0 = k
        while (k < n) { c = s.charCodeAt(k); if (isSpace(c) || c === 62) break; k++ }
        if (keep) value = s.slice(v0, Math.min(k, v0 + VALUE_MAX))
      }
    }
    if (keep && !attrs.has(name)) attrs.set(name, value)
  }
  return -1
}

/**
 * The linear tag scanner. Calls onMeta(attrs) for each <meta> of the head (true stops); skips comments,
 * doctype/processing instructions and the bodies of script, style, noscript, template and the other
 * raw-text elements; stops at </head> or <body. → { title } (the first <title>'s raw text, or null).
 */
function scan(s, onMeta) {
  const n = s.length
  let i = 0
  let title = null
  while (i < n) {
    const lt = s.indexOf('<', i)
    if (lt < 0 || lt + 1 >= n) break
    const c = s.charCodeAt(lt + 1)
    if (c === 33) {
      if (s.startsWith('<!--', lt)) {
        const e = s.indexOf('-->', lt + 4)
        if (e < 0) break
        i = e + 3
      } else {
        const e = s.indexOf('>', lt + 2)
        if (e < 0) break
        i = e + 1
      }
      continue
    }
    if (c === 63) {
      const e = s.indexOf('>', lt + 2)
      if (e < 0) break
      i = e + 1
      continue
    }
    const closing = c === 47
    let j = closing ? lt + 2 : lt + 1
    if (j >= n || !isAlpha(s.charCodeAt(j))) { i = lt + 1; continue }
    // no '>' anywhere after this: no tag can close any more
    if (s.indexOf('>', j) < 0) break
    const n0 = j
    while (j < n && isNameChar(s.charCodeAt(j))) j++
    const name = s.slice(n0, Math.min(j, n0 + 32)).toLowerCase()
    const attrs = closing ? null : new Map()
    const end = attributes(s, j, attrs)
    if (end < 0) break
    i = end
    if (closing) {
      if (name === 'head') break
      continue
    }
    if (name === 'body' || name === 'plaintext') break
    if (name === 'meta') {
      if (onMeta(attrs)) break
      continue
    }
    const re = RAW_END.get(name)
    if (re) {
      re.lastIndex = i
      const m = re.exec(s)
      const stop = m ? m.index : n
      if (name === 'title' && title === null) title = s.slice(i, Math.min(stop, i + VALUE_MAX))
      if (!m) break
      i = stop
    }
  }
  return { title }
}

/** The named entities decoded (a fixed set; others are kept as written), by code point */
const NAMED = new Map(Object.entries({
  amp: 0x26, lt: 0x3c, gt: 0x3e, quot: 0x22, apos: 0x27, nbsp: 0xa0, ndash: 0x2013, mdash: 0x2014, hellip: 0x2026,
  lsquo: 0x2018, rsquo: 0x2019, ldquo: 0x201c, rdquo: 0x201d, laquo: 0xab, raquo: 0xbb, middot: 0xb7,
  bull: 0x2022, copy: 0xa9, reg: 0xae, trade: 0x2122, times: 0xd7, deg: 0xb0, euro: 0x20ac,
  pound: 0xa3, yen: 0xa5, cent: 0xa2, sect: 0xa7, para: 0xb6,
}).map(([k, cp]) => [k, String.fromCodePoint(cp)]))
const REPLACEMENT = String.fromCodePoint(0xfffd)
const ENTITY = /&(?:#(\d{1,8});?|#[xX]([0-9a-fA-F]{1,7});?|([A-Za-z][A-Za-z0-9]{1,31});)/g
function decodeEntities(s) {
  if (s.indexOf('&') < 0) return s
  return s.replace(ENTITY, (m, dec, hex, name) => {
    if (name !== undefined) { const v = NAMED.get(name.toLowerCase()); return v === undefined ? m : v }
    const cp = dec !== undefined ? parseInt(dec, 10) : parseInt(hex, 16)
    if (!(cp > 0) || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return REPLACEMENT
    return String.fromCodePoint(cp)
  })
}

const LINE_BREAKS = classOf([[0x09, 0x0d], [0x85], [0x2028, 0x2029]], 'g')
const CONTROLS = classOf([[0x00, 0x1f], [0x7f, 0x9f]], 'g')
/** Bidi controls (embeddings, overrides, isolates, marks), zero-width and other invisible format characters */
const INVISIBLE = classOf([[0xad], [0x61c], [0x180e], [0x200b, 0x200f], [0x202a, 0x202e], [0x2060, 0x2064], [0x2066, 0x206f], [0xfeff], [0xfff9, 0xfffb]], 'g')
/** Text for a card: control, bidi and zero-width characters removed, white space collapsed, capped (code points) */
function clean(s, cap) {
  let t = String(s).replace(LINE_BREAKS, ' ').replace(CONTROLS, '').replace(INVISIBLE, '')
  if (typeof t.toWellFormed === 'function') t = t.toWellFormed()
  t = t.replace(/\s+/g, ' ').trim()
  if (t.length > cap) {
    const cps = Array.from(t)
    if (cps.length > cap) t = cps.slice(0, cap).join('').trim()
  }
  return t
}

const META_KEYS = new Set(['og:title', 'og:description', 'og:site_name', 'og:image', 'og:image:url', 'og:image:secure_url',
  'twitter:title', 'twitter:description', 'twitter:image', 'twitter:image:src', 'description'])

/** An image reference as written (entities decoded, white space and line breaks dropped), or '' */
function imageRef(raw) {
  if (typeof raw !== 'string') return ''
  const t = decodeEntities(raw).replace(/[\t\n\r\f]/g, '').trim()
  if (!t || t.length > LINK_CAPS.urlChars || CTRL.test(t)) return ''
  return t
}

/** The card's text from a page's head (pure; nothing executed). → { title, description, site, image } */
function readMeta(html) {
  const found = new Map()
  let title = null
  if (typeof html === 'string' && html) {
    title = scan(html, (attrs) => {
      const key = (attrs.get('property') || attrs.get('name') || '').trim().toLowerCase()
      if (META_KEYS.has(key) && attrs.has('content') && !found.has(key)) found.set(key, attrs.get('content'))
      return false
    }).title
  }
  const text = (raw, cap) => (typeof raw === 'string' ? clean(decodeEntities(raw), cap) : '')
  const pick = (keys, cap) => { for (const k of keys) { const v = text(found.get(k), cap); if (v) return v } return '' }
  let image = ''
  for (const k of ['og:image', 'og:image:url', 'og:image:secure_url', 'twitter:image', 'twitter:image:src']) { image = imageRef(found.get(k)); if (image) break }
  return {
    title: pick(['og:title', 'twitter:title'], LINK_CAPS.title) || text(title, LINK_CAPS.title),
    description: pick(['og:description', 'twitter:description', 'description'], LINK_CAPS.description),
    site: pick(['og:site_name'], LINK_CAPS.site),
    image,
  }
}

const toBuffer = (bytes) => (Buffer.isBuffer(bytes) ? bytes : bytes instanceof Uint8Array ? Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength) : Buffer.alloc(0))
const charsetParam = (ct) => {
  const m = /;\s*charset\s*=\s*(?:"([^"]*)"|([^\s;"]+))/i.exec(String(ct || ''))
  return m ? (m[1] || m[2] || '').trim() || null : null
}
/** The charset a page names in a <meta> of its first 4 KB (charset=, or http-equiv content-type) */
function metaCharset(head) {
  let label = null
  scan(head, (attrs) => {
    const direct = attrs.get('charset')
    if (direct) { label = direct.trim(); return true }
    if ((attrs.get('http-equiv') || '').trim().toLowerCase() === 'content-type') {
      const c = charsetParam(';' + (attrs.get('content') || '').replace(/^[^;]*;?/, ''))
      if (c) { label = c; return true }
    }
    return false
  })
  return label
}

/** A page's bytes → text: a BOM, else the header's charset, else a <meta>'s, else UTF-8 (unknown → UTF-8) */
function decodeHtml(bytes, contentType) {
  const b = toBuffer(bytes)
  let label = null
  let start = 0
  if (b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) { label = 'utf-8'; start = 3 }
  else if (b[0] === 0xfe && b[1] === 0xff) { label = 'utf-16be'; start = 2 }
  else if (b[0] === 0xff && b[1] === 0xfe) { label = 'utf-16le'; start = 2 }
  if (!label) label = charsetParam(contentType)
  if (!label) {
    label = metaCharset(b.subarray(0, 4096).toString('latin1'))
    if (label && /^utf-?16/i.test(label)) label = 'utf-8'
  }
  const body = b.subarray(start)
  try { return new TextDecoder(label || 'utf-8').decode(body) } catch { return new TextDecoder('utf-8').decode(body) }
}

// ---- images (never decoded: magic bytes and the header's dimensions only)

const latin = (b, at, len) => b.toString('latin1', at, at + len)
const JPEG_SOF = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf])
const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

function sniffPng(b) {
  if (b.length < 24 || b.readUInt32BE(8) !== 13 || latin(b, 12, 4) !== 'IHDR') return null
  const width = b.readUInt32BE(16)
  const height = b.readUInt32BE(20)
  if (!width || !height || width > 0x7fffffff || height > 0x7fffffff) return null
  let animated = false
  let pos = 8
  while (pos + 8 <= b.length) {
    const len = b.readUInt32BE(pos)
    const type = latin(b, pos + 4, 4)
    if (type === 'acTL') { animated = true; break }
    if (type === 'IDAT' || type === 'IEND' || len > 0x7fffffff) break
    pos += 12 + len
  }
  return { type: 'png', width, height, animated }
}

function sniffJpeg(b) {
  const end = Math.min(b.length, LINK_CAPS.jpegScan)
  let pos = 2
  while (pos + 4 <= end) {
    if (b[pos] !== 0xff) return null
    const m = b[pos + 1]
    if (m === 0xff) { pos++; continue }
    if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) { pos += 2; continue }
    if (m === 0xd9 || m === 0xda) return null
    const len = b.readUInt16BE(pos + 2)
    if (len < 2) return null
    if (JPEG_SOF.has(m)) {
      if (pos + 9 > end) return null
      const height = b.readUInt16BE(pos + 5)
      const width = b.readUInt16BE(pos + 7)
      return width && height ? { type: 'jpeg', width, height, animated: false } : null
    }
    pos += 2 + len
  }
  return null
}

function webpHasChunk(b, names) {
  let pos = 12
  while (pos + 8 <= b.length) {
    if (names.includes(latin(b, pos, 4))) return true
    const size = b.readUInt32LE(pos + 4)
    pos += 8 + size + (size & 1)
  }
  return false
}

function sniffWebp(b) {
  const four = latin(b, 12, 4)
  const d = 20
  if (four === 'VP8 ') {
    if (b.length < d + 10 || b[d + 3] !== 0x9d || b[d + 4] !== 0x01 || b[d + 5] !== 0x2a) return null
    const width = b.readUInt16LE(d + 6) & 0x3fff
    const height = b.readUInt16LE(d + 8) & 0x3fff
    return width && height ? { type: 'webp', width, height, animated: false } : null
  }
  if (four === 'VP8L') {
    if (b.length < d + 5 || b[d] !== 0x2f) return null
    const v = b.readUInt32LE(d + 1)
    return { type: 'webp', width: (v & 0x3fff) + 1, height: ((v >>> 14) & 0x3fff) + 1, animated: false }
  }
  if (four === 'VP8X') {
    if (b.length < d + 10) return null
    const animated = (b[d] & 0x02) !== 0 || webpHasChunk(b, ['ANIM', 'ANMF'])
    return { type: 'webp', width: b.readUIntLE(d + 4, 3) + 1, height: b.readUIntLE(d + 7, 3) + 1, animated }
  }
  return null
}

/** PNG, JPEG or WebP by their magic bytes, with the header's dimensions. Anything else (GIF, SVG, …) → null */
function sniffImage(bytes) {
  if (!bytes || !(bytes instanceof Uint8Array) || bytes.length < 12) return null
  const b = toBuffer(bytes)
  if (b.subarray(0, 8).equals(PNG_SIG)) return sniffPng(b)
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return sniffJpeg(b)
  if (latin(b, 0, 4) === 'RIFF' && latin(b, 8, 4) === 'WEBP') return sniffWebp(b)
  return null
}

/** A still PNG / JPEG / WebP of at most 4096 a side and 12 MP */
function imageAllowed(s, caps) {
  const c = capsOf(caps)
  return !!s && !s.animated && (s.type === 'png' || s.type === 'jpeg' || s.type === 'webp') &&
    Number.isInteger(s.width) && Number.isInteger(s.height) && s.width >= 1 && s.height >= 1 &&
    s.width <= c.imageSide && s.height <= c.imageSide && s.width * s.height <= c.imagePixels
}

// ---- the card

const bareHost = (h) => { let t = String(h || '').toLowerCase(); if (t.endsWith('.')) t = t.slice(0, -1); return t }
/** A host as a card names it: Unicode, with the punycode beside when they differ */
function hostLabel(hostname) {
  const h = bareHost(hostname)
  if (!h || h.startsWith('[')) return h
  const uni = clean(domainToUnicode(h) || '', 253)
  return uni && uni !== h ? `${uni} (${h})` : h
}

/**
 * A link → LinkCardData | null. The page under every rule, its head read; a page with neither a title nor a
 * description gives null. Its og:image / twitter:image resolved against the final page URL and fetched under
 * every rule again; kept only as a still PNG / JPEG / WebP within the caps. Every failure is silent (null or no
 * image); deps.note(why) hears the kind of a refusal (a word, never the URL).
 * A link whose address could carry data (a query string, userinfo, a port, a long or data-like path: linkShape.cjs,
 * the final review's I1) is refused before any lookup. `deps.signal` aborting (previews off, the view closed) stops
 * it at once: no further request, redirect hop or image request (I2).
 * deps: { resolve, request, timers, allowLoopback, caps, note, signal }
 */
async function previewOf(url, deps = {}) {
  const note = typeof deps.note === 'function' ? deps.note : () => {}
  const signal = deps.signal && typeof deps.signal.addEventListener === 'function' ? deps.signal : null
  const stopped = () => !!signal && signal.aborted
  const shape = previewShape(url, { allowLoopback: deps.allowLoopback === true })
  if (!shape.ok) { note(shape.why); return null }
  if (stopped()) return null
  const opts = { request: deps.request, resolve: deps.resolve, timers: deps.timers, allowLoopback: deps.allowLoopback === true, caps: deps.caps, signal }
  const page = await fetchLimited(url, { ...opts, kind: 'html' })
  if (!page.ok) { if (page.why !== 'off') note(page.why); return null }
  if (stopped()) return null
  const meta = readMeta(decodeHtml(page.bytes, page.contentType))
  if (!meta.title && !meta.description) return null
  const start = new URL(url)
  const final = new URL(page.finalUrl)
  // (the link's own host, never og:site_name: a page could name itself any site, and a card must not let it)
  const site = hostLabel(start.hostname)
  const via = bareHost(start.hostname) === bareHost(final.hostname) ? null : hostLabel(final.hostname)
  let image = null
  const src = meta.image ? redirectTarget(meta.image, page.finalUrl) : null
  if (src && !stopped()) {
    // (an https page never pulls an http image: the page's final scheme goes with the image's fetch)
    const got = await fetchLimited(src, { ...opts, kind: 'image', fromSecure: final.protocol === 'https:' })
    if (stopped()) return null
    if (!got.ok) note(got.why)
    else {
      const s = sniffImage(got.bytes)
      if (imageAllowed(s, deps.caps)) image = { bytes: new Uint8Array(got.bytes), type: s.type, width: s.width, height: s.height }
    }
  }
  return { url, site, via, title: meta.title, description: meta.description, image }
}

// ---- logs

const LOG_WORDS = new Map([
  ['address', 'refused (address)'], ['name', 'refused (name)'], ['scheme', 'refused (scheme)'], ['port', 'refused (port)'],
  ['userinfo', 'refused (userinfo)'], ['shape', 'refused (shape)'], ['dns', 'refused (dns)'], ['redirect', 'refused (redirect)'],
  ['status', 'refused (status)'], ['type', 'refused (type)'], ['encoding', 'refused (encoding)'], ['network', 'failed (network)'],
  ['timeout', 'timeout'], ['size', 'too large'],
  ['query', 'refused (query)'], ['path', 'refused (path)'], ['data', 'refused (data)'],
])
/** Kinds said once only, in a sentence of fixed words, for what the user can see nowhere else */
const ONCE_WORDS = new Map([
  ['nat64', 'link preview: refused (address): every address of a name was a NAT64 one (64:ff9b::/96), as on an IPv6-only network; no preview can be fetched on this network'],
])
/**
 * note(why): a fixed word per kind, counted, written at most once per kind per minute
 * (`link preview: refused (address) x3`). Anything that is not a known kind is "refused (other)". A NAT64 network
 * (every address of a name in 64:ff9b::/96) is said once, in its own fixed sentence, and is not counted again.
 */
function refusalLog({ write, now = Date.now, everyMs = 60000 } = {}) {
  const kinds = new Map()
  const said = new Set()
  return function note(why) {
    if (typeof write !== 'function') return
    if (typeof why === 'string' && ONCE_WORDS.has(why)) {
      if (!said.has(why)) { said.add(why); write(ONCE_WORDS.get(why)) }
      return
    }
    const word = (typeof why === 'string' && LOG_WORDS.get(why)) || 'refused (other)'
    let k = kinds.get(word)
    if (!k) { k = { last: -Infinity, count: 0 }; kinds.set(word, k) }
    k.count++
    const t = now()
    if (t - k.last >= everyMs) {
      write(`link preview: ${word} x${k.count}`)
      k.last = t
      k.count = 0
    }
  }
}

module.exports = {
  LINK_CAPS, USER_AGENT, BLOCKED_RANGES,
  checkUrl, addressAllowed, resolveAllowed, redirectTarget, fetchLimited, dnsGate,
  readMeta, decodeHtml, sniffImage, imageAllowed, previewOf, refusalLog,
}
