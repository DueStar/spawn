'use strict'

/**
 * chatHooks.cjs — the chat view's own Claude Code hooks (Phase 2, the
 * read-only lens): which events, the entries for the generated session
 * settings file, and the endpoint they reach.
 *
 * The entries are HTTP hooks to 127.0.0.1 on an ephemeral port, with a token
 * made once per app run in the URL path (no `headers` / `allowedEnvVars`:
 * header auth was not tested, and a key Claude Code does not know could make
 * it refuse the whole --settings file, the game's hooks with it). They are
 * added to and removed from the same generated file the game's hooks live in
 * (terminals.cjs writeSessionSettings); ~/.claude/settings.json is never
 * touched.
 *
 * Claude Code waits for every one of these hooks (MessageDisplay holds the
 * text it is about to draw), so the endpoint answers 200 with an empty body
 * as soon as the body is read — before parsing, before anything else — and
 * only then hands the hook on, inside try/catch. It answers while draining
 * too (the feature turned off with sessions still running that have the
 * entries). Phase 4 holds two routes only (PermissionRequest, AskUserQuestion),
 * and only through the hold registry (chatHolds.cjs), which answers each one
 * once or hands it back with "no decision". Nothing here goes through server/.
 */

const http = require('http')
const crypto = require('crypto')
const { entryTimeoutS } = require('./chatHolds.cjs')
const { errWord } = require('./chatLog.cjs')

/**
 * The events the lens listens to. No SessionStart/SessionEnd: they accept
 * command hooks only (FINDINGS §2), and the game's own hook writes the
 * session-links file on SessionStart already.
 */
const CHAT_HOOK_EVENTS = [
  'UserPromptSubmit', 'PreToolUse', 'PermissionRequest', 'PostToolUse', 'PostToolUseFailure', 'MessageDisplay',
  'Stop', 'StopFailure', 'SubagentStart', 'SubagentStop', 'PreCompact', 'PostCompact',
]

const TERMINAL_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * One matcher group per event: { hooks: [{ type: 'http', url, timeout }] } (seconds; MessageDisplay
 * 3, the rest 5). The URL names the terminal the session runs in (`/chat/<token>/<terminal id>/<event>`):
 * each session is launched with a settings file of its own, so a hook says which terminal it is
 * about as it arrives, before its body is read (a permission request holds back that terminal's
 * Enter, and only that one's).
 */
function chatHookEntries({ port, token, id, holds = false }) {
  if (typeof id !== 'string' || !TERMINAL_ID.test(id)) throw new Error('chatHookEntries: a terminal id is needed')
  const url = (route) => `http://127.0.0.1:${port}/chat/${token}/${id}/${route}`
  const group = (event) => ({ hooks: [{ type: 'http', url: url(event), timeout: event === 'MessageDisplay' ? 3 : 5 }] })
  const entries = Object.fromEntries(CHAT_HOOK_EVENTS.map(event => [event, group(event)]))
  if (holds === true) {
    // Phase 4: the permission request is held (its entry outlasts the hold: chatHolds.cjs entryTimeoutS),
    // and AskUserQuestion's PreToolUse gets a group of its own (every other tool's PreToolUse keeps 5 s)
    // (on a route of its own, `PermissionHold`: a session launched with Phase 2's 5 s entry is never held,
    // whatever the registry does later; review M1)
    entries.PermissionRequest = { hooks: [{ type: 'http', url: url('PermissionHold'), timeout: entryTimeoutS('permission') }] }
    entries.PreToolUse = [group('PreToolUse'), { matcher: 'AskUserQuestion', hooks: [{ type: 'http', url: url('AskUserQuestion'), timeout: entryTimeoutS('question') }] }]
  }
  return entries
}

const EVENTS = new Set(CHAT_HOOK_EVENTS)

/**
 * The held routes (Phase 4), written only into the entries of a session launched with holds: a
 * PermissionRequest (`PermissionHold`) and AskUserQuestion's PreToolUse (`AskUserQuestion`). Routes,
 * not events of Claude Code's: the body is handed on as the event it is (ROUTE_EVENT). The plain
 * `/PermissionRequest` route (Phase 2's 5 s entry) is always answered at once.
 */
const HOLD_ROUTES = Object.freeze({ PermissionHold: 'permission', AskUserQuestion: 'question' })
const ROUTE_EVENT = Object.freeze({ PermissionHold: 'PermissionRequest', AskUserQuestion: 'PreToolUse' })

/**
 * The endpoint. `onHook(event, body, at, id, holdId?)` gets the parsed body (or
 * `{ oversize: true }` past `maxBody`); a body that is not JSON is dropped.
 * Every hook is answered before it is handed on, except a held route's when
 * `holds` (chatHolds.cjs, or a function giving it or null) opens a hold for it:
 * that request is answered by the registry (the answer, or "no decision"),
 * once, and a client that goes first is told to the registry (`gone`).
 */
function createChatEndpoint({ onHook, onArrive = () => {}, maxBody = 2 << 20, log = () => {}, raw = false, holds = null, requestTimeoutMs = 15_000, checkEveryMs = undefined }) {
  const token = crypto.randomBytes(24).toString('hex')
  const tokenBuf = Buffer.from(token)
  let server = null
  let port = null
  let listening = null
  let draining = false
  const sockets = new Set()

  function tokenOk(given) {
    const b = Buffer.from(String(given))
    return b.length === tokenBuf.length && crypto.timingSafeEqual(b, tokenBuf)
  }

  // The first refusal of each kind is logged (never the address or the token): if Claude Code's own
  // HTTP client were refused, the log says so on the first real run
  const refusedOnce = new Set()
  function refuse(res, status, why) {
    if (!refusedOnce.has(why)) { refusedOnce.add(why); log('error', `chat endpoint: refused a request (${why}, ${status})`) }
    res.writeHead(status, { 'content-length': '0', connection: 'close' })
    res.end()
  }

  function handle(req, res) {
    // a page in a browser, or a name that is not this address: never
    if (req.headers.origin !== undefined) return refuse(res, 403, 'an Origin header')
    if (req.headers.host !== `127.0.0.1:${port}`) return refuse(res, 403, 'another Host')
    const parts = String(req.url ?? '').split('/')
    if (req.method !== 'POST') return refuse(res, 404, 'not a POST')
    if (parts.length !== 5 || parts[0] !== '' || parts[1] !== 'chat' || !TERMINAL_ID.test(parts[3]) || !(EVENTS.has(parts[4]) || Object.hasOwn(HOLD_ROUTES, parts[4]))) return refuse(res, 404, 'an unknown path')
    if (!tokenOk(parts[2])) return refuse(res, 404, 'a wrong token')
    const id = parts[3]
    const route = parts[4]
    const event = Object.hasOwn(ROUTE_EVENT, route) ? ROUTE_EVENT[route] : route
    // the event's name and its terminal only, as it arrives (the composer holds back that terminal's
    // Enter while a permission dialog may be opening; chatHost.cjs): never the body, not read yet
    try { onArrive(event, id) } catch (err) { log('error', `chat hook ${event}: failed (${errWord(err)})`) }
    const chunks = []
    let size = 0
    let oversize = false
    req.on('data', (c) => {
      if (oversize) return
      size += c.length
      if (size > maxBody) { oversize = true; chunks.length = 0; return }
      chunks.push(c)
    })
    req.on('error', () => {})
    req.on('end', () => {
      // a held route: the registry answers it later (or at once when it will not hold: closed, full, off)
      const holdId = !draining && !oversize && Object.hasOwn(HOLD_ROUTES, route) ? openHold(HOLD_ROUTES[route], res, id) : null
      if (holdId === null) {
        // answered first: Claude Code goes on at once
        res.writeHead(200, { 'content-length': '0' })
        res.end()
        if (draining) return
      }
      setImmediate(() => {
        if (draining && holdId === null) return
        let body
        if (oversize) body = { oversize: true }
        else if (raw) {
          // the bytes in a buffer of their own (a pooled Buffer must never be transferred), unparsed
          const all = Buffer.concat(chunks)
          body = new Uint8Array(all.length)
          body.set(all)
        } else {
          try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { return }
        }
        try {
          if (holdId === null) onHook(event, body, Date.now(), id)
          else onHook(event, body, Date.now(), id, holdId)
        } catch (err) { log('error', `chat hook ${event}: failed (${errWord(err)})`) }
      })
    })
  }

  /** A hold for this request (its response written by the registry, once), or null */
  function openHold(kind, res, id) {
    let registry = null
    try { registry = typeof holds === 'function' ? holds() : holds } catch { registry = null }
    if (!registry || typeof registry.open !== 'function') return null
    let answered = false
    // true once the response is written; false when it could not be (answered, or the client went)
    const respond = (body) => {
      if (answered || res.writableEnded || res.destroyed) return false
      answered = true
      if (typeof body === 'string') {
        const buf = Buffer.from(body, 'utf8')
        res.writeHead(200, { 'content-type': 'application/json', 'content-length': String(buf.length) })
        res.end(buf)
      } else {
        res.writeHead(200, { 'content-length': '0' })
        res.end()
      }
      return true
    }
    let holdId = null
    try { holdId = registry.open(kind, respond, { id }) } catch (err) { log('error', `chat holds: a hold could not open (${errWord(err)})`); holdId = null }
    if (typeof holdId !== 'string') return null
    // the client went before an answer (Claude Code gave up, or ended): nothing can be sent any more
    res.on('close', () => { if (!answered) { answered = true; try { registry.gone(holdId) } catch {} } })
    return holdId
  }

  function listen() {
    if (listening) return listening
    // (how often Node looks for requests past their timeout: its default, 30 s, unless a test says)
    server = http.createServer(typeof checkEveryMs === 'number' ? { connectionsCheckingInterval: checkEveryMs } : {}, handle)
    server.requestTimeout = requestTimeoutMs
    server.headersTimeout = 10_000
    server.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)) })
    server.on('clientError', (_err, socket) => { try { socket.destroy() } catch {} })
    listening = new Promise((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => {
        server.off('error', reject)
        server.on('error', (err) => log('error', `chat endpoint: failed (${errWord(err)})`))
        port = server.address().port
        resolve({ port, token })
      })
    })
    return listening
  }

  function setDraining(on) { draining = !!on }

  function close() {
    return new Promise((resolve) => {
      if (!server) return resolve()
      const s = server
      server = null
      listening = null
      s.close(() => resolve())
      for (const sock of sockets) { try { sock.destroy() } catch {} }
      sockets.clear()
    })
  }

  return { listen, setDraining, close, draining: () => draining }
}

module.exports = { CHAT_HOOK_EVENTS, HOLD_ROUTES, ROUTE_EVENT, chatHookEntries, createChatEndpoint }
