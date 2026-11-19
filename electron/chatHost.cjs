'use strict'

/**
 * chatHost.cjs — the chat view's lifecycle in the main process (Phase 2, the
 * read-only lens). main.cjs builds it only when the features.json switch
 * (CHAT_VIEW) is on, and enables it only when 설정 › 세션 › 채팅으로 보기 is on.
 *
 *   enable    the version gate first (`claude --version`, 5 s at most): a
 *             Claude Code older than the checked range, or one whose version
 *             cannot be read, is never armed (an unknown version could refuse
 *             the whole --settings file, the game's hooks with it). Otherwise
 *             the hook endpoint (chatHooks.cjs) and the reading worker
 *             (chatWorker.cjs), then the chat entries go into the session
 *             settings for sessions opened from now on.
 *   disable   the entries go at once, the worker stops at once; the endpoint
 *             keeps answering (draining) until no session launched with the
 *             entries is still running, then closes.
 *   ready     what terminals:create waits for (while on), so restored
 *             sessions start armed.
 *
 * The endpoint never depends on the worker: a crashed worker shows the
 * `worker` banner on the open views and is restarted at most twice a run.
 * The host numbers the updates per terminal itself (rev), so a restarted
 * worker's updates follow on.
 *
 * The composer (Phase 3) sends in two calls with one id. `send` checks the
 * session and the page's reading of the prompt row against the input ledger
 * (chatInput.cjs) and types the text without Enter; `submit` presses Enter
 * once, only when the page saw the echo and nothing changed meanwhile (no
 * permission request, no key in the terminal, still running). `interrupt` is
 * one Esc. These three are the only places the chat writes to a terminal
 * (terminals.typeForChat). A send id is accepted once; nothing is retried.
 *
 * The buttons (Phase 4) answer held hooks (chatHolds.cjs), only for a Claude
 * Code in the verified range. The endpoint opens a hold; the worker binds or
 * passes it and later says when its call settled; the page answers it through
 * `chat:answer`, accepted only for an open hold of the terminal whose chat is
 * the visible view of a visible window. Everything else hands the request back
 * to the terminal with "no decision": a real key in that terminal, a question
 * whose chat is not shown, the setting off, the worker gone, quitting, the
 * session gone, a version out of the range, the hold's own time.
 */

const path = require('path')
const { chatHookEntries, createChatEndpoint } = require('./chatHooks.cjs')
const { versionVerdict } = require('./chatSchema.cjs')
const { ENTER, ESC, SHIFT_TAB, ARROW_UP, ARROW_DOWN, LINE_END, BACKSPACE, PASTE_START, PASTE_END, INPUT_CAPS, sanitize, encodeSend, nextDraft, mayType, busyReason, isRealInput, pastablePath } = require('./chatInput.cjs')
const { createImageStore } = require('./chatImages.cjs')
const { scan: scanFiles, matchFiles } = require('./chatFiles.cjs')
const { listCommands } = require('./chatCommands.cjs')
const { createHolds, HOLD } = require('./chatHolds.cjs')
const { errWord, versionWord } = require('./chatLog.cjs')
const { previewShape } = require('./linkShape.cjs')

const WORKER_FILE = path.join(__dirname, 'chatWorker.cjs')
const REQUEST_TIMEOUT_MS = 10_000
// A preview waits its turn in the worker's queue (linkPreview.cjs: ≤ 24 waiting, 3 at once, 1 per host, each fetch
// ≤ 6 s plus its picture), so it gets longer than the other requests; when even this passes, the answer says
// `again` (not the link's fault: the page does not keep it and asks again when the card mounts next time)
const PREVIEW_TIMEOUT_MS = 30_000

function defaultWorker(file) {
  const { Worker } = require('worker_threads')
  return new Worker(file)
}

/**
 * @param {object} o
 * @param {{ list(): object[], refreshSettings(): void, armedCount(): number }} o.terminals  the terminal manager
 * @param {(channel: string, payload: unknown) => void} o.send  to the app window (chat:update)
 * @param {string} o.userDataDir
 * @param {() => Promise<string | null>} o.claudeVersion  `claude --version`'s first line
 */
function createChatHost({
  terminals, send: toPage, userDataDir, claudeDir, claudeVersion,
  makeWorker = defaultWorker, makeEndpoint = createChatEndpoint, log = () => {},
  timers = { setTimeout: (f, ms) => setTimeout(f, ms), clearTimeout: (t) => clearTimeout(t) },
  versionTimeoutMs = 5000, restartDelayMs = 1000, maxRestarts = 2,
  // the version gate's memory: the binary sessions run (path|mtime|size) and where its verdict is kept
  binaryStamp = () => null, cacheFile = null, fs: fsx = require('fs'), now = () => Date.now(), reprobeMs = 5 * 60_000,
  // main's host only (built before any terminal of the run): the chat settings files earlier runs left go
  sweep = false,
  // the composer's images (chatImages.cjs): their folder for this app instance; none, no images
  imageRoot = null, makeImageStore = createImageStore,
  // the hold times (chatHolds.cjs HOLD; a development build may shorten them, never lengthen them)
  holdLimits = HOLD,
  // link previews (Phase 5): whether 설정 has them on (채팅으로 보기 and 링크 미리보기; asked at every request), and the
  // policy for the worker (allowLoopback: the test switch, which main sets only in a development build)
  previewsOn = () => false, preview: previewOpts = {},
  // the / menu's commands and skills (chatCommands.cjs; tests pass their own reader)
  readCommands = (cwd) => listCommands(cwd, typeof claudeDir === 'string' && claudeDir ? { config: claudeDir } : {}),
}) {
  if (sweep) sweepChatFiles(userDataDir, fsx)
  const images = typeof imageRoot === 'string' && imageRoot ? makeImageStore({ root: imageRoot, log }) : null
  // an earlier run's images go before any session of this run starts
  if (sweep && images) images.sweep().catch(() => {})
  let st = { on: false }
  let gen = 0
  let readyPromise = Promise.resolve()
  let endpoint = null
  let endpointListened = false // the endpoint made has listened once (it may serve armed sessions)
  let worker = null
  let workerVersion = null
  let restarts = 0
  let reqSeq = 0
  const pending = new Map()   // req → { resolve, fallback, timer }
  const openIds = new Set()   // views the page has open
  const revs = new Map()      // terminal id → the last rev sent
  const statuses = new Map()  // terminal id → the last status sent
  // Phase 4: the held requests (only while armed for a verified Claude Code), what the page shows
  let holds = null
  let holdsOpen = false       // new holds may open (the verified version); off, the open ones stay answerable (M6)
  let visibleId = null       // the terminal whose chat is the shown view (chat:visible), or none
  let visibleFrom = null      // the page (its webContents id) that said so: only it, or its going, clears it
  let windowVisible = true    // the app window is shown and not minimised (main.cjs)

  const sleep = (ms, value) => new Promise((resolve) => timers.setTimeout(() => resolve(value), ms))
  /** How long the hooks' endpoint may take to listen before the chat view gives up starting */
  const LISTEN_MS = 3000

  function state() { return st }

  // ---- to the page ---------------------------------------------------------

  function forward(update) {
    if (!update || typeof update.id !== 'string' || !Array.isArray(update.ops)) return
    for (const op of update.ops) {
      if ((op.op === 'reset' || op.op === 'status') && op.status) statuses.set(update.id, op.status)
    }
    const rev = (revs.get(update.id) ?? 0) + 1
    revs.set(update.id, rev)
    toPage('chat:update', { ...update, rev })
  }

  const DEFAULT_STATUS = { state: 'idle', since: null, label: null, banner: null, note: null, version: null, hasOlder: false, empty: false }
  function workerBanner(id) {
    const status = { ...(statuses.get(id) ?? DEFAULT_STATUS), banner: { reason: 'worker' } }
    forward({ id, ops: [{ op: 'status', status }] })
  }

  // ---- the worker ----------------------------------------------------------

  /** The Claude Code terminals as the lens needs them */
  function lensList(list = safeList()) {
    // (createdAt: a tab launched again under the same id is a new session for the lens)
    return list.filter(t => t && t.tool === 'claude').map(t => ({ id: t.id, cwd: t.cwd, armed: t.chat === 'armed', status: t.status, createdAt: t.createdAt }))
  }
  function safeList() { try { return terminals.list() } catch { return [] } }

  function post(m, transfer) {
    if (!worker) return false
    try { if (transfer) worker.postMessage(m, transfer); else worker.postMessage(m); return true } catch (err) { log('error', `chat worker post: failed (${errWord(err)})`); return false }
  }

  function startWorker(version) {
    const w = makeWorker(WORKER_FILE)
    worker = w
    workerVersion = version
    w.on('message', (m) => {
      if (worker !== w || !m || typeof m !== 'object') return
      if (m.t === 'update') forward(m.update)
      else if (m.t === 'log') log(m.level === 'error' ? 'error' : 'info', String(m.msg ?? '').slice(0, 500))
      else if (m.t === 'reply') settle(m.req, m.result)
      // the reader heard UserPromptSubmit for this terminal: what was on its prompt row went
      else if (m.t === 'prompt' && typeof m.id === 'string') draft(m.id, { via: 'prompt' })
      // a question or a plan to approve is open in this terminal (its dialog takes Enter and Esc), or none is
      else if (m.t === 'asking' && typeof m.id === 'string') { if (m.on === true) inputOf(m.id).asking = true; else if (inputs.has(m.id)) inputs.get(m.id).asking = false }
      // Phase 4: what a held request is, and when its call settled
      else if (m.t === 'hold-bind') onBind(m)
      else if (m.t === 'hold-pass' && typeof m.holdId === 'string') holds?.pass(m.holdId, typeof m.why === 'string' ? m.why.slice(0, 40) : 'passed')
      else if (m.t === 'hold-resolved' && Array.isArray(m.holdIds)) for (const h of m.holdIds) if (typeof h === 'string') holds?.release(h, 'settled')
    })
    w.on('error', (err) => log('error', `chat worker: failed (${errWord(err)})`))
    w.on('exit', (code) => {
      if (worker !== w) return
      worker = null
      failPending()
      // what it said was open is not known any more (the screen check and the permission signal stay)
      for (const c of inputs.values()) c.asking = false
      // nobody reads the held requests now (their cards are gone with it): the terminal decides
      holds?.releaseAll('worker')
      if (code !== 0) crashed()
    })
    post({ t: 'init', claudeDir, userDataDir, version, preview: { allowLoopback: previewOpts?.allowLoopback === true, on: previewsNow() } })
    post({ t: 'terminals', list: lensList() })
    for (const id of openIds) post({ t: 'open', id })
  }

  function stopWorker() {
    const w = worker
    worker = null
    failPending()
    for (const c of inputs.values()) c.asking = false
    holds?.releaseAll('worker')
    if (w) { try { w.terminate() } catch {} }
  }

  /**
   * Someone still reads through the worker: on and armed, or on and disarmed (a re-probe found an
   * older Claude Code) while sessions launched with the hooks still run
   */
  function needsWorker() {
    if (!st.on) return false
    if (st.hooks) return true
    try { return terminals.armedCount() > 0 } catch { return false }
  }

  /** A crash: the open views say so; a restart a second later, twice a run at most */
  function crashed() {
    log('error', 'chat worker stopped')
    for (const id of openIds) workerBanner(id)
    if (restarts >= maxRestarts || !needsWorker()) return
    restarts++
    const g = gen
    timers.setTimeout(() => { if (g === gen && needsWorker() && !worker) startWorker(workerVersion) }, restartDelayMs)
  }

  function request(t, payload, fallback, timeoutMs = REQUEST_TIMEOUT_MS) {
    if (!worker) return Promise.resolve(fallback)
    const req = ++reqSeq
    return new Promise((resolve) => {
      const timer = timers.setTimeout(() => settle(req, fallback), timeoutMs)
      pending.set(req, { resolve, timer, fallback })
      if (!post({ t, ...payload, req })) settle(req, fallback)
    })
  }
  function settle(req, result) {
    const p = pending.get(req)
    if (!p) return
    pending.delete(req)
    timers.clearTimeout(p.timer)
    p.resolve(result)
  }
  function failPending() {
    for (const [req, p] of [...pending]) { pending.delete(req); timers.clearTimeout(p.timer); p.resolve(p.fallback ?? { ok: false }) }
  }

  /**
   * A chat hook from the endpoint (answered already — or held, with its hold id): to the worker, or
   * nowhere. A held one with no worker to read it is handed back at once.
   */
  function onHook(event, body, at, id, holdId) {
    const extra = typeof holdId === 'string' ? { id, hold: holdId } : (typeof id === 'string' ? { id } : {})
    // raw bytes (review M13: main never parses a body, which can hold a file's text): moved, not copied
    const ok = body instanceof Uint8Array ? post({ t: 'hook', event, raw: body, at, ...extra }, [body.buffer]) : post({ t: 'hook', event, body, at, ...extra })
    if (!ok && typeof holdId === 'string') holds?.release(holdId, 'worker')
  }

  // ---- the buttons (Phase 4) -------------------------------------------------

  /** The registry, made when armed for a verified Claude Code (its transitions go to the worker's cards) */
  function makeHolds() {
    return createHolds({
      timers, log, limits: holdLimits,
      onChange: (c) => {
        if (c.state !== 'answered' && c.state !== 'released' && c.state !== 'gone') return
        // (the reason only, never what was asked)
        log('info', `chat holds: a ${c.kind} hold ${c.state} (${c.why ?? ''})`)
        const state = c.state === 'answered' ? 'sent' : c.why === 'timeout' ? 'timeout' : 'terminal'
        post(c.state === 'answered' ? { t: 'hold-state', holdId: c.holdId, state, choice: c.choice } : { t: 'hold-state', holdId: c.holdId, state })
      },
    })
  }

  /** The holds of a terminal (bound to it, or named by its URL) */
  const holdOf = (id) => (h) => (h.id ?? h.urlId) === id
  /** A question whose chat is not the visible view of a visible window */
  const hiddenQuestion = (h) => h.kind === 'question' && (!windowVisible || (h.id ?? h.urlId) !== visibleId)

  function onBind(m) {
    if (!holds || typeof m.holdId !== 'string') return
    if (!holds.bind(m.holdId, { id: m.id, key: m.key, data: m.data })) return
    // a question is answered from the chat only while its chat is shown: else the terminal shows it now
    holds.releaseWhere(h => h.holdId === m.holdId && hiddenQuestion(h), 'hidden')
  }

  /**
   * chat:visible: the terminal whose chat is the shown view (or none); a question of any other goes back.
   * `from` is the page that says it (its webContents id): a page saying "none" never clears what another
   * page shows (review I3: the widget and the window swap, the old one goes after the new one spoke).
   */
  function visible(p, from) {
    const id = typeof p?.id === 'string' && p.id ? p.id : null
    if (id === null && from !== undefined && visibleFrom !== null && from !== visibleFrom) return
    visibleId = id
    visibleFrom = id === null ? null : (from ?? null)
    holds?.releaseWhere(hiddenQuestion, 'hidden')
  }

  /** A page went or reloads (main.cjs): the chat it showed is no longer shown — only its own */
  function pageGone(from) {
    if (visibleFrom === null || from !== visibleFrom) return
    visibleId = null
    visibleFrom = null
    holds?.releaseWhere(hiddenQuestion, 'hidden')
  }

  /** The app window shown or hidden / minimised (main.cjs): questions go back while it is not seen */
  function setWindowVisible(on) {
    windowVisible = on === true
    holds?.releaseWhere(hiddenQuestion, 'hidden')
  }

  /**
   * chat:answer: the registry checks it (an open hold of this terminal, its chat the visible view of a
   * visible window, a choice that fits) and builds the answer itself; the page never does
   */
  function answer(p, from) {
    const id = typeof p?.id === 'string' ? p.id : ''
    if (!st.on || !holds) return { ok: false, reason: 'off' }
    const option = Number.isInteger(p?.option) ? p.option : undefined
    // (several questions / a multi-select: each question's picked option indices; plain integers only, bounded)
    const picks = Array.isArray(p?.picks) && p.picks.length <= 4 && p.picks.every(x => Array.isArray(x) && x.length <= 6 && x.every(Number.isInteger)) ? p.picks.map(x => [...x]) : undefined
    // (only the page that shows that chat answers for it)
    const shown = from === undefined || visibleFrom === null || from === visibleFrom ? visibleId : null
    const r = holds.answer(typeof p?.holdId === 'string' ? p.holdId : '', { id, choice: typeof p?.choice === 'string' ? p.choice : '', option, picks, visibleId: shown, windowVisible })
    // the side panel's 확인 필요 goes, as when the terminal is answered with Enter
    if (r.ok) { try { terminals.clearAsking?.(id) } catch {} }
    return r
  }

  /** Quitting (before the sessions are ended): every held request answered "no decision" */
  function releaseHolds(why = 'quit') { holds?.releaseAll(why) }

  // ---- the hidden terminal's size (7-48) ---------------------------------------------------------
  //
  // A session shown as chat whose hidden xterm replayed before it fitted: the page asks once, and the
  // pty gets one row less and its size again (terminals.cjs redrawForChat), so Claude Code draws its
  // screen anew. A resize only, never a byte of input. Refused unless, in this order: on; a running,
  // armed Claude Code; its chat the shown view of a visible window, asked by the page that showed it;
  // no chat send in flight for it; no answer card open for it; no nudge for it in the last 10 s.

  const REDRAW_MS = 10_000
  // after a nudge, Claude Code repaints its screen: for this long no chat send starts in that terminal (a screen read
  // taken mid-repaint can say `empty` over a row that holds a draft; the final review's M1). Refused as `screen`
  // ("try again"), never queued or retried here.
  const REDRAW_SETTLE_MS = 1000
  const redrawAt = new Map()     // terminal id → when it was last nudged

  function redraw(idArg, from) {
    const id = typeof idArg === 'string' ? idArg : ''
    if (!st.on) return { ok: false, reason: 'off' }
    const term = termOf(id)
    if (!term || term.status === 'exited') return { ok: false, reason: 'no-session' }
    if (term.tool !== 'claude' || term.chat !== 'armed') return { ok: false, reason: 'unarmed' }
    const samePage = from === undefined || visibleFrom === null || from === visibleFrom
    if (!windowVisible || visibleId !== id || !samePage) return { ok: false, reason: 'not-shown' }
    const c = inputs.get(id)
    if (c && (c.inFlight || now() < c.sideUntil)) return { ok: false, reason: 'sending' }
    if (holds && holds.openFor(id).length > 0) return { ok: false, reason: 'waiting' }
    const last = redrawAt.get(id)
    if (last !== undefined && now() - last < REDRAW_MS) return { ok: false, reason: 'recent' }
    let done = false
    try { done = typeof terminals.redrawForChat === 'function' && terminals.redrawForChat(id) === true } catch { done = false }
    if (!done) return { ok: false, reason: 'no-session' }
    redrawAt.set(id, now())
    return { ok: true }
  }

  // ---- link previews (Phase 5) -------------------------------------------------------------------
  //
  // Fetched by the worker (linkPreview.cjs over linkFetch.cjs), never here and never by the page. chat:preview answers
  // { ok: false } at once, with no worker message, unless the chat is on and 설정 has previews on; the URL is checked
  // again here (http/https, at most 2048 characters, nothing hidden in it); the worker's card is checked before the
  // page has it (the URL asked, plain strings within the reader's caps, a still PNG / JPEG / WebP within the image
  // caps or no image). Every failure is the same { ok: false }: the plain link stays (`again: true` beside it only
  // when the worker did not answer in time or went: nothing about the link, so the page does not keep it).

  const PREVIEW_URL_MAX = 2048
  const IMAGE_MAX = 2 << 20
  const IMAGE_TYPES = new Set(['png', 'jpeg', 'webp'])

  function previewsNow() {
    if (!st.on) return false
    try { return previewsOn() === true } catch { return false }
  }

  /** A character that never belongs in an address: controls, spaces, quotes and brackets, bidi and zero-width marks */
  const badChar = (c) => c <= 0x20 || (c >= 0x7f && c <= 0x9f) || c === 0xad || c === 0x61c || c === 0x180e || (c >= 0x200b && c <= 0x200f) ||
    (c >= 0x2028 && c <= 0x202e) || (c >= 0x2060 && c <= 0x206f) || c === 0xfeff || c === 0x22 || c === 0x27 || c === 0x3c || c === 0x3e || c === 0x60 || c === 0x5c
  function previewUrl(raw) {
    if (typeof raw !== 'string' || !raw || raw.length > PREVIEW_URL_MAX) return null
    for (let i = 0; i < raw.length; i++) if (badChar(raw.charCodeAt(i))) return null
    if (!/^https?:\/\/[^/?#]/i.test(raw)) return null
    try {
      const u = new URL(raw)
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return null
    } catch { return null }
    // (the final review's I1: an address that could carry data out — a query string, userinfo, a port, a long or
    // data-like path — never reaches the worker, whatever the page asked; linkShape.cjs, the page's own rule)
    if (!previewShape(raw, { allowLoopback: previewOpts?.allowLoopback === true }).ok) return null
    return raw
  }

  const capText = (v, n) => (typeof v === 'string' ? Array.from(v).slice(0, n).join('') : null)
  function checkImage(i) {
    if (!i || typeof i !== 'object' || !IMAGE_TYPES.has(i.type) || !(i.bytes instanceof Uint8Array)) return null
    if (i.bytes.byteLength < 8 || i.bytes.byteLength > IMAGE_MAX) return null
    const side = (n) => Number.isInteger(n) && n >= 1 && n <= 4096
    if (!side(i.width) || !side(i.height) || i.width * i.height > 12_000_000) return null
    return { bytes: i.bytes, type: i.type, width: i.width, height: i.height }
  }
  function checkCard(c, url) {
    if (!c || typeof c !== 'object' || c.url !== url) return null
    const title = capText(c.title, 200), description = capText(c.description, 400), site = capText(c.site, 300)
    if (title === null || description === null || site === null) return null
    if (c.via !== null && typeof c.via !== 'string') return null
    return { url, site, via: c.via === null ? null : capText(c.via, 300), title, description, image: checkImage(c.image) }
  }

  /**
   * chat:preview: one link's card for the view of terminal `id`, from the worker, or { ok: false } (no reason: every
   * failure is silent). Only for a view the page has open; the worker answers only for a link written in a finished
   * answer of that view (the final review's M2: "only links Claude wrote" is not the page's word alone).
   */
  async function preview(p) {
    if (!previewsNow()) return { ok: false }
    const id = typeof p?.id === 'string' ? p.id : ''
    if (!id || !openIds.has(id)) return { ok: false }
    const url = previewUrl(p?.url)
    if (!url) return { ok: false }
    const LATE = { ok: false, again: true }
    const r = await request('preview', { id, url }, LATE, PREVIEW_TIMEOUT_MS)
    // (turned off while it was fetched: nothing is shown)
    if (!previewsNow()) return { ok: false }
    // (the worker did not answer in time, or went: the page may ask again later)
    if (r === LATE) return { ok: false, again: true }
    if (!r || r.ok !== true) return { ok: false }
    const card = checkCard(r.card, url)
    return card ? { ok: true, card } : { ok: false }
  }

  /** 설정's 링크 미리보기 (or 채팅으로 보기) changed: the worker hears it (off: its caches emptied, its queue dropped) */
  function setPreviews() {
    if (worker) post({ t: 'previews', on: previewsNow() })
  }

  // ---- lifecycle -----------------------------------------------------------

  // ---- the version gate ------------------------------------------------------
  //
  // Older or unreadable versions are never armed (an unknown key could make Claude Code refuse the
  // whole --settings file, the game's hooks with it); versions newer than the checked range are armed
  // with a quiet note, the canary as the safety net. The verdict is remembered with the binary it was
  // read from (path, mtime, size: `binaryStamp`), so the next start arms at once; Claude Code updates
  // itself during a long run, so a session's start looks again in the background (a changed binary, or
  // every few minutes) and never waits for it.

  let probing = null    // a probe in flight
  let lastProbe = null  // when the last one began
  let known = null      // { stamp, version } the state was decided from

  /**
   * The binary's stamp. A full look (`binaryStamp()`: a bare name searched along PATH) at start and
   * at every re-probe; a session's start (noteCreate) looks only at the file found last time
   * (`binaryStamp(path)`: one stat, never a dead network drive on PATH), and searches again only
   * when that file is gone.
   */
  const stampNow = (hint) => { try { return binaryStamp(hint) ?? null } catch { return null } }
  const pathOf = (stamp) => {
    if (typeof stamp !== 'string') return undefined
    const b = stamp.lastIndexOf('|', stamp.lastIndexOf('|') - 1)
    return b > 0 ? stamp.slice(0, b) : undefined
  }

  /** The verdict remembered for a binary: only a version that was read (a probe that timed out is not one) */
  function readCache() {
    if (!cacheFile) return null
    try {
      const c = JSON.parse(fsx.readFileSync(cacheFile, 'utf8'))
      return c && typeof c.stamp === 'string' && typeof c.version === 'string' && c.version ? c : null
    } catch { return null }
  }
  function writeCache(entry) {
    if (!cacheFile || typeof entry.version !== 'string' || !entry.version) return
    try {
      const tmp = `${cacheFile}.${process.pid}.tmp`
      fsx.writeFileSync(tmp, JSON.stringify(entry))
      fsx.renameSync(tmp, cacheFile)
    } catch (err) { log('error', `chat view: the version could not be remembered (${errWord(err)})`) }
  }

  /** `claude --version` of the binary sessions run (5 s at most): its first line, or null */
  async function probe() {
    lastProbe = now()
    let p
    try { p = Promise.resolve(claudeVersion()) } catch { p = Promise.resolve(null) }
    try {
      const v = await Promise.race([p, sleep(versionTimeoutMs, null)])
      return typeof v === 'string' && v ? v : null
    } catch { return null }
  }

  const armable = (version) => { const v = versionVerdict(version); return v === 'ok' || v === 'new' }

  /** The state for a version: armed (the endpoint and the worker up), or not (they stay for armed sessions still running) */
  async function apply(version, g) {
    // the buttons' holds only for a Claude Code in the verified range (a newer one keeps Phase 2's passive cards)
    const verdict = versionVerdict(version)
    const holding = verdict === 'ok'
    if (!holding && holds) {
      // (the final review's M6) updated past the verified range mid-run: the cards open now belong to sessions armed
      // under the verified version and keep working until answered or released; only new holds stop (the endpoint
      // hands every new one back at once). An older or unreadable version lets them all go, as before.
      holdsOpen = false
      if (verdict !== 'new') { holds.releaseAll('version'); holds = null }
    }
    if (!armable(version)) {
      log('info', `chat view: Claude Code ${versionWord(version)} is not armed`)
      st = { on: true, hooks: null, reason: 'version', version }
      terminals.refreshSettings()
      return
    }
    // (new holds open only while the version is the verified one: holdsOpen)
    if (!endpoint) endpoint = makeEndpoint({ onHook, onArrive, log, raw: true, holds: () => (holdsOpen ? holds : null) })
    endpoint.setDraining(false)
    // (a port that cannot be had, or a listen that never answers: never left starting — Phase 6 drill)
    const listening = endpoint.listen()
    const { port, token } = await Promise.race([listening, sleep(LISTEN_MS, null).then(() => { throw Object.assign(new Error('listen timed out'), { code: 'ETIMEDOUT' }) })])
    endpointListened = true
    if (g !== gen) { endpoint.setDraining(true); checkDrain(); return }
    if (holding) { if (!holds) holds = makeHolds(); holdsOpen = true }
    if (!worker) startWorker(version)
    // (a worker already running heard of another version: its open views' note follows — Phase 6 trial)
    else if (workerVersion !== version) { workerVersion = version; post({ t: 'version', version }) }
    // each session's entries name its terminal (a hook says which terminal it is about as it arrives)
    st = { on: true, hooks: (id) => chatHookEntries({ port, token, id, holds: holding }), version }
    terminals.refreshSettings()
  }

  /** Look again in the background; the state changes only when the verdict does */
  function reprobe(g) {
    if (probing) return probing
    const stamp = stampNow()
    probing = probe().then(async (version) => {
      if (g !== gen) return
      // the same binary whose version is known, and it could not be read just now: what is known stands
      if (version === null && known && known.version && stamp && known.stamp === stamp) return
      if (stamp) writeCache({ stamp, version })
      const before = known
      known = { stamp, version }
      if (before && armable(before.version) === armable(version) && before.version === version) return
      // (still armed and on the same side of the verified range: the holds stay as they are)
      if (armable(version) && st.hooks && (versionVerdict(version) === 'ok') === holdsOpen) { st = { ...st, version }; return }
      await apply(version, g)
    }).catch((err) => log('error', `chat view: the version check failed (${errWord(err)})`))
      .finally(() => { probing = null })
    return probing
  }

  function enable() {
    if (st.on && (st.reason === 'starting' || st.hooks)) return readyPromise
    const g = ++gen
    st = { on: true, hooks: null, reason: 'starting' }
    readyPromise = (async () => {
      terminals.refreshSettings()
      const stamp = stampNow()
      const cached = readCache()
      if (stamp && cached && cached.stamp === stamp) {
        // the same binary as last time: its verdict at once, checked again behind it
        known = { stamp, version: cached.version }
        await apply(cached.version, g)
        if (g === gen) reprobe(g)
        return
      }
      const version = await probe()
      if (g !== gen) return
      known = { stamp, version }
      if (stamp) writeCache({ stamp, version })
      await apply(version, g)
    })().catch((err) => {
      log('error', `chat view could not start (${errWord(err)})`)
      // (the flip says 채팅 보기를 준비하지 못했어요; turning the setting off and on tries again, with a new endpoint
      // when this one never listened — one that did still serves the sessions armed on it)
      if (endpoint && !endpointListened) { const e = endpoint; endpoint = null; Promise.resolve().then(() => e.close()).catch(() => {}) }
      else if (endpoint) endpoint.setDraining(true)
      if (g === gen) { st = { on: true, hooks: null, reason: 'failed' }; terminals.refreshSettings() }
    })
    return readyPromise
  }

  /**
   * A session is about to start (terminals:create): if Claude Code's binary changed, or the
   * last look is a few minutes old, look again in the background. Never waits.
   */
  function noteCreate() {
    if (!st.on || st.reason === 'starting' || probing) return
    const hint = pathOf(known?.stamp)
    const changed = known && (hint ? stampNow(hint) ?? stampNow() : stampNow()) !== known.stamp
    if (changed || lastProbe === null || now() - lastProbe >= reprobeMs) reprobe(gen)
  }

  function disable() {
    gen++
    const wasOn = st.on
    st = { on: false }
    // every held request goes back to the terminal before anything else (the endpoint drains next)
    if (holds) { holds.close('off'); holds = null }
    holdsOpen = false
    dropInFlight()
    // while off, nothing is heard of the sessions' input (terminals.cjs): turned on again, what
    // their prompt rows hold is not known
    if (wasOn) {
      offAt = now()
      for (const c of inputs.values()) if (c.draft !== 'dirty') { if (c.submittedTimer) { timers.clearTimeout(c.submittedTimer); c.submittedTimer = null } c.draft = 'unknown' }
    }
    readyPromise = Promise.resolve()
    if (wasOn) terminals.refreshSettings()
    stopWorker()
    openIds.clear()
    if (endpoint) endpoint.setDraining(true)
    checkDrain()
  }

  /** Off, and no running session launched with the entries: the endpoint closes */
  function checkDrain() {
    if (st.on || !endpoint) return
    let armed = 0
    try { armed = terminals.armedCount() } catch { armed = 0 }
    if (armed > 0) return
    const e = endpoint
    endpoint = null
    endpointListened = false
    e.close().catch(() => {})
  }

  function ready() { return st.on ? readyPromise : Promise.resolve() }

  /** Every terminals:list: the worker hears, views of terminals gone are forgotten, the drain is checked */
  function onTerminals(list) {
    const all = Array.isArray(list) ? list : []
    for (const id of [...openIds]) if (!all.some(t => t && t.id === id)) openIds.delete(id)
    // a terminal gone or ended: its ledger and any send of it go (no Enter for a session that ended)
    for (const [id, c] of [...inputs]) {
      const t = all.find(x => x && x.id === id)
      if (!t || t.status === 'exited') { forgetInput(id, c) }
    }
    // a session gone or ended: nothing of it is held any more
    holds?.releaseWhere(h => { const t = all.find(x => x && x.id === (h.id ?? h.urlId)); return !t || t.status === 'exited' }, 'gone')
    for (const id of [...fileScans.keys()]) if (!all.some(t => t && t.id === id && t.status !== 'exited')) fileScans.delete(id)
    for (const id of [...redrawAt.keys()]) if (!all.some(t => t && t.id === id && t.status !== 'exited')) redrawAt.delete(id)
    // a session gone or ended: its images go
    if (images) {
      for (const t of all) if (t && t.status === 'exited' && images.has(t.id)) images.dropSession(t.id).catch(() => {})
      for (const id of [...imageIds]) if (!all.some(t => t && t.id === id && t.status !== 'exited')) { imageIds.delete(id); images.dropSession(id).catch(() => {}) }
    }
    post({ t: 'terminals', list: lensList(all) })
    checkDrain()
  }

  // ---- the composer (Phase 3) ------------------------------------------------
  //
  // Per terminal, the ledger of its prompt row (chatInput.cjs nextDraft) and the one send in flight.
  // `permSeq` counts that terminal's PermissionRequest hooks as they arrive (the endpoint's onArrive,
  // before the body is read; the hook's URL names its terminal): a dialog may be opening there, and
  // an Enter or an Esc would answer it. A PreToolUse heard is a tool starting: a question or a plan
  // to approve opens a dialog without a permission request, so an Enter waits a moment for the
  // reader to say whether one is open (`asking`, from the worker).

  const SEND_IDS_KEPT = 32
  const SIDE_MS = 2000           // the side box's text is typed, its Enter not heard yet: at most this long
  const PERMISSION_MS = 2000     // a permission request this recent: nothing is typed, no Enter
  const SUBMITTED_MS = 5000      // an Enter not confirmed by UserPromptSubmit in this time: the row is unknown
  const PRE_MS = 300             // after a PreToolUse with no PostToolUse yet: Enter waits this long at most
  const PRE_POLL_MS = 25
  const ESC_MS = 1000
  const SEND_ID = /^[A-Za-z0-9_-]{8,64}$/
  // the page watches the echo for 1.5 s (+ 0.5 s an image), then waits out minEnterMs and looks
  // again before it asks for Enter: a send whose submit has not come in twice that (a page that
  // died or was reloaded) goes, without Enter
  const inFlightMs = (images, minEnterMs) => 2 * (1500 + 500 * images + minEnterMs) + 1000

  const inputs = new Map()       // terminal id → { draft, inFlight, sendIds, sideUntil, lastEsc, submittedTimer, permission… }
  let offAt = -Infinity          // the last time the chat was turned off (input went unheard after it)

  function inputOf(id) {
    let c = inputs.get(id)
    if (!c) {
      // a session from before the chat was last turned off: what was typed meanwhile was not heard
      const term = termOf(id)
      const draft = term && typeof term.createdAt === 'number' && term.createdAt <= offAt ? 'unknown' : 'clean'
      c = { draft, inFlight: null, sendIds: [], sideUntil: 0, lastEsc: -Infinity, submittedTimer: null, lastPermissionAt: -Infinity, permSeq: 0, preAt: -Infinity, preOpen: false, asking: false, stranded: false }
      inputs.set(id, c)
    }
    return c
  }

  function forgetInput(id, c) {
    if (c.submittedTimer) timers.clearTimeout(c.submittedTimer)
    if (c.inFlight) timers.clearTimeout(c.inFlight.expiry)
    inputs.delete(id)
  }

  /** The ledger moves on; a submitted row that UserPromptSubmit does not confirm in 5 s is unknown */
  function draft(id, ev) {
    const c = inputOf(id)
    c.draft = nextDraft(c.draft, ev)
    if (c.submittedTimer) { timers.clearTimeout(c.submittedTimer); c.submittedTimer = null }
    if (c.draft === 'submitted') {
      c.submittedTimer = timers.setTimeout(() => { c.submittedTimer = null; if (c.draft === 'submitted') c.draft = nextDraft(c.draft, { via: 'timeout' }) }, SUBMITTED_MS)
    }
  }

  /** A send that ends without Enter: the text the chat typed may still be on the row */
  function abort(c, f) {
    if (c.inFlight === f) c.inFlight = null
    timers.clearTimeout(f.expiry)
    c.draft = nextDraft(c.draft, { via: 'chat', phase: 'aborted' })
  }

  /** Off, or quitting: no send in flight gets its Enter */
  function dropInFlight() {
    for (const c of inputs.values()) if (c.inFlight) abort(c, c.inFlight)
  }

  /** A chat hook's name and terminal as it arrives (before its body is read; chatHooks.cjs) */
  function onArrive(event, id) {
    if (typeof id !== 'string' || !id) return
    if (event === 'PermissionRequest') { const c = inputOf(id); c.lastPermissionAt = now(); c.permSeq++ }
    else if (event === 'PreToolUse') { const c = inputOf(id); c.preAt = now(); c.preOpen = true }
    else if ((event === 'PostToolUse' || event === 'PostToolUseFailure') && inputs.has(id)) inputs.get(id).preOpen = false
  }

  /**
   * Input that reached an armed terminal some other way (terminals.cjs): the keyboard (`asking`:
   * a question was on screen, so the keys answered it), or the side box (`phase` typed / enter).
   * A send in flight is spoilt by real input only (not by the terminal's own reports, a focus
   * change or the cursor moving).
   */
  function onInput(id, data, via, phase, asking) {
    if (typeof id !== 'string' || !id) return
    const c = inputOf(id)
    // a real key in this terminal (or the side box typing into it): the user answers there, the chat steps back
    if ((via === 'keyboard' && isRealInput(typeof data === 'string' ? data : '')) || via === 'side') holds?.releaseWhere(holdOf(id), 'terminal')
    if (via === 'keyboard') {
      const keys = typeof data === 'string' ? data : ''
      if (c.inFlight && isRealInput(keys)) c.inFlight.touched = true
      draft(id, { via: 'keyboard', data: keys, dialog: asking === true || statuses.get(id)?.state === 'waiting' })
    } else if (via === 'side') {
      if (c.inFlight) c.inFlight.touched = true
      // a side send holds the chat back from its text until its Enter is heard (at most SIDE_MS)
      if (phase === 'typed') c.sideUntil = now() + SIDE_MS
      else if (phase === 'enter') c.sideUntil = 0
      draft(id, { via: 'side', phase })
    }
  }

  /** The terminal as the list has it now */
  const termOf = (id) => safeList().find(t => t && t.id === id) ?? null
  /**
   * Why nothing may be typed or entered now: the session waits on the user (the lens says so, or
   * a question or a plan is open in it, or the terminal shows a question), or a dialog may be opening
   * (a permission request of this terminal's arrived in the last 2 s)
   */
  function waitingNow(id, term) {
    const c = inputs.get(id)
    // (a held request of this terminal: its dialog or its question is open, Enter or Esc would answer it)
    if (holds && holds.openFor(id).length > 0) return true
    return statuses.get(id)?.state === 'waiting' || term.asking === true || (!!c && (c.asking || now() - c.lastPermissionAt < PERMISSION_MS))
  }

  /** A chat send is between its text and its Enter in this terminal (the side box's send waits; terminals.cjs) */
  function busy(id) {
    return st.on && typeof id === 'string' && !!inputs.get(id)?.inFlight
  }

  /**
   * A send of this terminal ended without Enter because no page came back for it (reloaded or gone):
   * its text may still be on the prompt row. The composer asks once as it opens, and says so.
   */
  function stranded(idArg) {
    const c = inputs.get(typeof idArg === 'string' ? idArg : '')
    if (!st.on || !c || !c.stranded) return { stranded: false }
    c.stranded = false
    return { stranded: c.draft === 'dirty' }
  }

  /**
   * Step 3 of the plan's "send, step by step": the checks in order, then the text typed without
   * Enter (encodeSend's steps, spaced as they say). The answer comes once the last step is typed.
   */
  async function send(p) {
    const id = typeof p?.id === 'string' ? p.id : ''
    if (!st.on) return { ok: false, reason: 'off' }
    const term = termOf(id)
    if (!term || term.status === 'exited') return { ok: false, reason: 'no-session' }
    if (term.tool !== 'claude') return { ok: false, reason: 'not-claude' }
    if (term.chat !== 'armed') return { ok: false, reason: 'unarmed' }
    const c = inputOf(id)
    const sendId = p.sendId
    if (typeof sendId !== 'string' || !SEND_ID.test(sendId) || c.sendIds.includes(sendId)) return { ok: false, reason: 'duplicate' }
    c.sendIds.push(sendId)
    if (c.sendIds.length > SEND_IDS_KEPT) c.sendIds.shift()
    if (c.inFlight || now() < c.sideUntil) return { ok: false, reason: 'sending' }
    if (waitingNow(id, term)) return { ok: false, reason: 'waiting' }
    // (the terminal was nudged less than a second ago: the screen the page read may be mid-repaint)
    const nudged = redrawAt.get(id)
    if (nudged !== undefined && now() - nudged < REDRAW_SETTLE_MS) return { ok: false, reason: 'screen' }
    const screen = ['empty', 'suggestion', 'typed', 'text'].includes(p.screen) ? p.screen : 'unknown'
    if (screen === 'unknown') return { ok: false, reason: 'screen' }
    // (someone's text on the row, read by its dim marks: busy, whatever the ledger says)
    if (!mayType(screen, c.draft)) return { ok: false, reason: screen === 'typed' ? 'prompt-busy' : busyReason(c.draft) }
    const text = sanitize(typeof p.text === 'string' ? p.text.slice(0, INPUT_CAPS.chars * 2) : '')
    const tokens = Array.isArray(p.images) ? p.images : null
    if (!tokens) return { ok: false, reason: 'images' }
    if (!text.trim() && !tokens.length) return { ok: false, reason: 'empty' }
    if (text.length > INPUT_CAPS.chars) return { ok: false, reason: 'too-long' }
    if (tokens.length > INPUT_CAPS.images) return { ok: false, reason: 'images' }
    const paths = tokens.map(tok => imagePath(id, tok))
    // (a path is pasted quoted when it has a space: a quote or a control character in it, never)
    if (paths.some(x => !pastablePath(x))) return { ok: false, reason: 'images' }
    // (shell: the composer's own shell mode; a `!` command takes no images)
    const shell = p.shell === true
    if (shell && (tokens.length || !text.trim())) return { ok: false, reason: 'empty' }
    const enc = encodeSend({ text, images: paths, shell })

    const f = { sendId, at: now(), lastStepAt: 0, minEnterMs: enc.minEnterMs, permSeq: c.permSeq, touched: false, partial: false, submitting: false, expiry: null }
    c.inFlight = f
    for (let i = 0; i < enc.steps.length; i++) {
      const step = enc.steps[i]
      if (i > 0) {
        await sleep(step.waitMs)
        const t = termOf(id)
        // something changed between two steps (a dialog opening, a key, the session gone, turned off): no more typing
        if (c.inFlight !== f || !t || t.status === 'exited' || f.touched || f.permSeq !== c.permSeq || waitingNow(id, t)) { f.partial = true; break }
      }
      if (!terminals.typeForChat(id, step.data)) {
        // nothing typed at all: nothing to enter, said as the session gone
        if (i === 0) { c.inFlight = null; return { ok: false, reason: 'no-session' } }
        f.partial = true
        break
      }
      f.lastStepAt = now()
      if (i === 0) c.draft = nextDraft(c.draft, { via: 'chat', phase: 'typed' })
    }
    if (c.inFlight === f) {
      f.expiry = timers.setTimeout(() => {
        if (c.inFlight !== f || f.submitting) return
        log('info', 'chat composer: a send was never confirmed by the page: no Enter')
        abort(c, f)
        // the page that sent it is gone: the next one is told the text may be on the prompt row
        c.stranded = true
      }, inFlightMs(paths.length, enc.minEnterMs))
    }
    return { ok: true, expect: enc.expect, command: enc.command, minEnterMs: enc.minEnterMs }
  }

  /**
   * Step 6: Enter, once, only for the send in flight with this id, when the page saw the echo (and
   * looked again once `minEnterMs` had passed since the text: an earlier submit is refused), the
   * session still runs and waits on nobody, no permission request arrived and no key reached the
   * terminal since the text was typed. A tool that has just started in the terminal (a PreToolUse
   * with no PostToolUse yet) makes Enter wait up to PRE_MS, so the reader can say whether it opened
   * a question or a plan to approve; then everything is checked again and Enter goes at once, or not
   * at all. Nothing is retried.
   */
  async function submit(p) {
    const id = typeof p?.id === 'string' ? p.id : ''
    const c = inputs.get(id)
    const f = c?.inFlight
    if (!f || f.sendId !== p.sendId || f.submitting) return { ok: false, reason: 'not-in-flight' }
    f.submitting = true
    const blocked = () => {
      const t = termOf(id)
      if (!st.on || !t || t.status === 'exited' || t.chat !== 'armed') return 'no-session'
      if (f.touched || f.partial) return 'no-echo'
      if (f.permSeq !== c.permSeq || waitingNow(id, t)) return 'waiting'
      return null
    }
    const end = (reason) => { abort(c, f); return { ok: false, reason } }
    if (p.echo !== 'ok') return end('no-echo')
    // the page waits out the minimum itself and reads the screen once more before it asks
    if (now() - f.lastStepAt < f.minEnterMs) return end('not-in-flight')
    let why = blocked()
    if (why) return end(why)
    // a tool just started: wait for its end or a quiet moment (bounded), never longer
    const waitEnd = now() + 2 * PRE_MS
    while (c.preOpen && now() - c.preAt < PRE_MS && now() < waitEnd) {
      await sleep(PRE_POLL_MS)
      if (c.inFlight !== f) return { ok: false, reason: 'not-in-flight' }
    }
    why = blocked()
    if (why) return end(why)
    if (!terminals.typeForChat(id, ENTER)) return end('no-session')
    c.inFlight = null
    timers.clearTimeout(f.expiry)
    draft(id, { via: 'chat', phase: 'enter' })
    return { ok: true }
  }

  /** 멈추기: one Esc, only while the session works, waits on nobody, and no send is in flight; once a second */
  function interrupt(idArg) {
    const id = typeof idArg === 'string' ? idArg : ''
    const term = termOf(id)
    if (!st.on || !term || term.status === 'exited' || term.tool !== 'claude' || term.chat !== 'armed') return { ok: false, reason: 'no-session' }
    if (waitingNow(id, term)) return { ok: false, reason: 'waiting' }
    if (statuses.get(id)?.state !== 'working') return { ok: false, reason: 'not-working' }
    const c = inputOf(id)
    if (c.inFlight) return { ok: false, reason: 'sending' }
    if (now() - c.lastEsc < ESC_MS) return { ok: false, reason: 'debounced' }
    if (!terminals.typeForChat(id, ESC)) return { ok: false, reason: 'no-session' }
    c.lastEsc = now()
    draft(id, { via: 'esc' })
    return { ok: true }
  }

  /**
   * The chat's mode menu (2026-11-17): one Shift+Tab, Claude Code's own key for the next permission mode. The page
   * reads the footer between presses (src/chat/modeSwitch.ts). Never while a dialog waits (Shift+Tab answers some),
   * nor while a send is being typed; at most one every 80 ms. The prompt row is not touched, so the ledger stays.
   */
  const CYCLE_MS = 80
  function cycleMode(idArg) {
    const id = typeof idArg === 'string' ? idArg : ''
    const term = termOf(id)
    if (!st.on || !term || term.status === 'exited' || term.tool !== 'claude' || term.chat !== 'armed') return { ok: false, reason: 'no-session' }
    if (waitingNow(id, term)) return { ok: false, reason: 'waiting' }
    const c = inputOf(id)
    if (c.inFlight) return { ok: false, reason: 'sending' }
    if (now() - (c.lastCycle ?? -Infinity) < CYCLE_MS) return { ok: false, reason: 'debounced' }
    if (!terminals.typeForChat(id, SHIFT_TAB)) return { ok: false, reason: 'no-session' }
    c.lastCycle = now()
    return { ok: true }
  }

  /**
   * The chat's dialog card (2026-11-17): a dialog Claude Code draws that no hold covers (a `/model` confirmation,
   * the folder trust, a plan's choices) is read from the screen by the page (src/chat/dialog.ts), which moves its
   * mark one key at a time and checks the screen between keys. Here only the keys: ↑, ↓, Enter, Esc, or one line
   * of words pasted (an option that takes them). Also Ctrl+E and up to 4000 Backspaces at once: words left on the
   * prompt row cleared from the chat (src/chat/clearRow.ts reads the row before and after). Not while a hold waits
   * (its card answers it) nor while a send is being typed; at most one key every 40 ms.
   */
  const DIALOG_KEYS = Object.freeze({ up: ARROW_UP, down: ARROW_DOWN, enter: ENTER, esc: ESC, end: LINE_END })
  const DIALOG_MS = 40
  function dialogKey(p) {
    const id = typeof p?.id === 'string' ? p.id : ''
    const term = termOf(id)
    if (!st.on || !term || term.status === 'exited' || term.tool !== 'claude' || term.chat !== 'armed') return { ok: false, reason: 'no-session' }
    if (holds && holds.openFor(id).length > 0) return { ok: false, reason: 'held' }
    const c = inputOf(id)
    if (c.inFlight) return { ok: false, reason: 'sending' }
    if (now() - (c.lastDialogKey ?? -Infinity) < DIALOG_MS) return { ok: false, reason: 'debounced' }
    let data = null
    if (p?.key === 'text') {
      // one line of the user's words, sanitised (no control character survives), as one paste
      const text = sanitize(typeof p.text === 'string' ? p.text.slice(0, 4000) : '').replace(/\s*\n\s*/g, ' ')
      if (!text.trim() || text.length > 2000) return { ok: false, reason: 'empty' }
      data = PASTE_START + text + PASTE_END
    } else if (p?.key === 'backspace') {
      const n = Number.isInteger(p.n) && p.n >= 1 && p.n <= 4000 ? p.n : 0
      if (!n) return { ok: false, reason: 'invalid' }
      data = BACKSPACE.repeat(n)
    } else if (Object.prototype.hasOwnProperty.call(DIALOG_KEYS, p?.key)) data = DIALOG_KEYS[p.key]
    if (data === null) return { ok: false, reason: 'invalid' }
    if (!terminals.typeForChat(id, data)) return { ok: false, reason: 'no-session' }
    c.lastDialogKey = now()
    return { ok: true }
  }

  /** An image token → the file's path (chatImages.cjs: only a token its store made for this terminal) */
  function imagePath(id, token) { return images ? images.path(id, token) : null }

  const imageIds = new Set()     // terminals with images saved this run

  /** chat:image: the bytes of one pasted, dropped or picked image, for an armed, running session */
  async function image(p) {
    const id = typeof p?.id === 'string' ? p.id : ''
    if (!st.on || !images) return { ok: false, reason: 'off' }
    const term = termOf(id)
    if (!term || term.status === 'exited' || term.tool !== 'claude' || term.chat !== 'armed') return { ok: false, reason: 'off' }
    if (!(p.bytes instanceof Uint8Array)) return { ok: false, reason: 'type' }
    const r = await images.save(id, p.bytes)
    if (r.ok) imageIds.add(id)
    return r.ok ? { ok: true, token: r.token, type: r.type } : { ok: false, reason: r.reason }
  }

  // ---- the @ mention: names from the session's own folder (chatFiles.cjs), the walk kept 30 s

  const FILES_MS = 30_000
  const fileScans = new Map()    // terminal id → { at, files: Promise<string[]> }

  /** chat:files: only for an armed, running Claude Code session; its folder is the terminal's, never the page's */
  async function files(p) {
    const id = typeof p?.id === 'string' ? p.id : ''
    const term = termOf(id)
    if (!st.on || !term || term.status === 'exited' || term.tool !== 'claude' || term.chat !== 'armed' || typeof term.cwd !== 'string' || !term.cwd) return { ok: false }
    let c = fileScans.get(id)
    if (!c || now() - c.at > FILES_MS || c.cwd !== term.cwd) {
      c = { at: now(), cwd: term.cwd, files: scanFiles(term.cwd).catch(() => []) }
      fileScans.set(id, c)
    }
    const query = typeof p.query === 'string' ? p.query.slice(0, 200) : ''
    return { ok: true, files: matchFiles(await c.files, query, 50) }
  }

  // ---- the / menu: the session's commands and skills besides Claude Code's own (chatCommands.cjs), kept 30 s

  const COMMANDS_MS = 30_000
  const commandReads = new Map() // terminal id → { at, cwd, list: Promise<object[]> }

  /** chat:commands: only for an armed, running Claude Code session; its folder is the terminal's, never the page's */
  async function commands(p) {
    const id = typeof p?.id === 'string' ? p.id : ''
    const term = termOf(id)
    if (!st.on || !term || term.status === 'exited' || term.tool !== 'claude' || term.chat !== 'armed' || typeof term.cwd !== 'string' || !term.cwd) return { ok: false }
    let c = commandReads.get(id)
    if (!c || now() - c.at > COMMANDS_MS || c.cwd !== term.cwd) {
      c = { at: now(), cwd: term.cwd, list: Promise.resolve().then(() => readCommands(term.cwd)).catch(() => []) }
      commandReads.set(id, c)
    }
    const list = await c.list
    return { ok: true, commands: Array.isArray(list) ? list : [] }
  }

  /** chat:image-drop: a chip removed before sending; its file goes */
  function dropImage(p) {
    if (!images || typeof p?.id !== 'string') return
    images.drop(p.id, p.token).catch(() => {})
  }

  /** The ledger's state of a terminal (tests) */
  function inputState(id) { return (inputs.get(id) ?? (termOf(id) ? inputOf(id) : null))?.draft ?? 'clean' }

  // ---- IPC -----------------------------------------------------------------

  function open(id) {
    if (!st.on) return { ok: false, reason: 'off' }
    const term = safeList().find(t => t && t.id === id)
    if (!term || term.tool !== 'claude') return { ok: false, reason: 'not-claude' }
    if (term.chat === 'version') return { ok: false, reason: 'version' }
    if (term.chat !== 'armed') return { ok: false, reason: 'unarmed' }
    openIds.add(id)
    if (!post({ t: 'open', id })) workerBanner(id) // the worker is gone for good this run
    return { ok: true }
  }

  /** The worker sends the view again; with the worker gone for good, its banner is sent again instead */
  function resync(id) {
    if (!worker) {
      if (st.on && openIds.has(id)) workerBanner(id)
      return Promise.resolve({ ok: st.on })
    }
    return request('resync', { id }, { ok: false })
  }

  function close(id) {
    openIds.delete(id)
    post({ t: 'close', id })
  }

  /**
   * Why a send from the chat did not go, in spawn.log (1.5.3: the owner's sends were refused and nothing said why).
   * The page's own refusal for its screen comes with the shape it read (masked there and again here: never any text);
   * at most one line every 30 s per terminal.
   */
  const diagAt = new Map()
  function diag(p) {
    const id = String(p?.id ?? '').slice(0, 200)
    if (!id || now() - (diagAt.get(id) ?? 0) < 30_000) return
    diagAt.set(id, now())
    const why = String(p?.why ?? '').replace(/[^a-z-]/g, '').slice(0, 20)
    const shape = String(p?.shape ?? '').replace(/[\p{L}\p{N}]/gu, 'a').slice(0, 3000)
    // (1.6.2: also after main's prompt-busy / prompt-unknown, with the row's dim marks under `-- dim --`)
    log('info', `chat send refused (${why}); the screen's last lines as the page read them, masked:\n${shape}`)
  }
  function refused(kind, r) {
    if (r && r.ok === false && r.reason !== 'empty') log('info', `chat ${kind} refused (${String(r.reason).slice(0, 30)})`)
    return r
  }

  function registerIpc(ipcMain, guard) {
    const idOf = (v) => String(v ?? '')
    ipcMain.handle('chat:open', guard((id) => open(idOf(id))))
    ipcMain.on('chat:close', guard((id) => close(idOf(id))))
    ipcMain.handle('chat:older', guard((id) => request('older', { id: idOf(id) }, { ok: false, loaded: 0 })))
    ipcMain.handle('chat:reload', guard((id) => request('reload', { id: idOf(id) }, { ok: false })))
    // a page that lost an update: the view again as it is (reload is the banner's 다시 읽기)
    ipcMain.handle('chat:resync', guard((id) => resync(idOf(id))))
    ipcMain.handle('chat:agent', guard((arg) => request('agent', { id: idOf(arg?.id), toolId: idOf(arg?.toolId) }, { ok: false })))
    // the changes panel (Phase 5): the worker's change index; a file's edits read again from the transcript
    ipcMain.handle('chat:changes', guard((id) => request('changes', { id: idOf(id) }, { ok: false })))
    // "전체 보기" (2026-11-17): an item read again whole from the transcript, in place of "see the terminal"
    ipcMain.handle('chat:full', guard((arg) => request('full', { id: idOf(arg?.id), itemId: String(arg?.itemId ?? '').slice(0, 200) }, { ok: false, reason: 'gone' })))
    ipcMain.handle('chat:change-file', guard((arg) => request('change-file', {
      id: idOf(arg?.id), file: String(arg?.file ?? '').slice(0, 4096),
      ...(typeof arg?.before === 'number' && Number.isFinite(arg.before) ? { before: arg.before } : {}),
    }, { ok: false, reason: 'gone' })))
    // the composer (Phase 3): plain values only, checked again in send / submit / interrupt
    ipcMain.handle('chat:send', guard(async (arg) => refused('send', await send(arg && typeof arg === 'object' ? arg : {}))))
    ipcMain.handle('chat:submit', guard(async (arg) => refused('submit', await submit(arg && typeof arg === 'object' ? arg : {}))))
    ipcMain.on('chat:diag', guard((arg) => diag(arg && typeof arg === 'object' ? arg : {})))
    ipcMain.handle('chat:interrupt', guard((id) => interrupt(idOf(id))))
    ipcMain.handle('chat:cycle-mode', guard((id) => cycleMode(idOf(id))))
    ipcMain.handle('chat:dialog-key', guard((arg) => dialogKey(arg && typeof arg === 'object' ? arg : {})))
    ipcMain.handle('chat:image', guard((arg) => image(arg && typeof arg === 'object' ? arg : {})))
    ipcMain.on('chat:image-drop', guard((arg) => dropImage(arg && typeof arg === 'object' ? arg : {})))
    ipcMain.handle('chat:files', guard((arg) => files(arg && typeof arg === 'object' ? arg : {})))
    ipcMain.handle('chat:commands', guard((arg) => commands(arg && typeof arg === 'object' ? arg : {})))
    ipcMain.handle('chat:stranded', guard((id) => stranded(idOf(id))))
    // the buttons (Phase 4): which chat is shown, and an answer (checked and built here, never by the page)
    ipcMain.on('chat:visible', guard((arg, e) => visible(arg && typeof arg === 'object' ? arg : {}, e?.sender?.id)))
    ipcMain.handle('chat:answer', guard((arg, e) => answer(arg && typeof arg === 'object' ? arg : {}, e?.sender?.id)))
    // 7-48: one resize nudge for the shown chat's hidden terminal (checked here; never a write)
    ipcMain.handle('chat:redraw', guard((id, e) => redraw(idOf(id), e?.sender?.id)))
    // link previews (Phase 5): { ok: false } at once unless on; fetched by the worker only
    ipcMain.handle('chat:preview', guard((arg) => preview(arg && typeof arg === 'object' ? arg : {})))
  }

  /** Quitting (after the sessions ended): the worker and the endpoint go */
  async function close_() {
    gen++
    st = { on: false }
    // every held request answered "no decision" before the endpoint closes
    if (holds) { holds.close('quit'); holds = null }
    holdsOpen = false
    dropInFlight()
    // the sessions have ended: their images go now (the next start sweeps what is left)
    if (images) await images.sweep().catch(() => {})
    stopWorker()
    openIds.clear()
    const e = endpoint
    endpoint = null
    endpointListened = false
    if (e) await e.close().catch(() => {})
  }

  return { state, enable, disable, ready, onTerminals, registerIpc, noteCreate, close: close_, onInput, onArrive, busy, stranded, send, submit, interrupt, cycleMode, dialogKey, inputState, image, dropImage, files, commands, visible, pageGone, setWindowVisible, answer, releaseHolds, redraw, preview, setPreviews }
}

/**
 * The chat settings files (session-settings-chat-<hash>.json, and a temporary one) an earlier run
 * left in the app's folder. A run that writes one removes the others (terminals.cjs); a run with the
 * setting off writes none, so without this the last one would stay. Called before any session of
 * this run starts, so no running session was launched with one. Never touches session-settings.json.
 */
function sweepChatFiles(dir, fs = require('fs')) {
  if (typeof dir !== 'string' || !dir) return 0
  let n = 0
  try {
    for (const name of fs.readdirSync(dir)) {
      if (!/^session-settings-chat-[0-9a-f]{12}\.json(\.\d+\.tmp)?$/.test(name)) continue
      try { fs.rmSync(path.join(dir, name), { force: true }); n++ } catch { /* held: the next start */ }
    }
  } catch { /* no folder yet */ }
  return n
}

/**
 * The binary a command runs, as "path|mtime|size" (null when it is not found): an absolute path
 * as it is, a bare name looked up on PATH. Changes when Claude Code updates itself.
 */
function binaryStamp(command, { env = process.env, fs = require('fs'), pathMod = path } = {}) {
  if (typeof command !== 'string' || !command) return null
  const dirs = pathMod.isAbsolute(command) ? [''] : String(env.PATH ?? env.Path ?? '').split(pathMod.delimiter).filter(Boolean)
  for (const d of dirs) {
    const p = d ? pathMod.join(d, command) : command
    try {
      const s = fs.statSync(p)
      if (s.isFile()) return `${p}|${Math.round(s.mtimeMs)}|${s.size}`
    } catch { /* not here */ }
  }
  return null
}

module.exports = { createChatHost, binaryStamp, sweepChatFiles, WORKER_FILE }
