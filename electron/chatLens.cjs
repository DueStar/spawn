'use strict'

/**
 * chatLens.cjs — the chat view's core (Phase 2, the read-only lens). It runs
 * inside the chat worker (chatWorker.cjs), never in the main process.
 *
 * For every armed Claude Code terminal it knows which conversation runs in it
 * (the terminal id, or the conversation the game hook last wrote into its
 * session-links file after a /clear or a resume), finds that conversation's
 * transcript (only under <Claude folder>/projects/), reads it from the end
 * (chatTail.cjs) and turns lines into items (chatItems.cjs). Chat hooks
 * (chatHooks.cjs, answered by the main process first) add what the
 * transcript has not written yet: tool rows running → done, permission waits,
 * the provisional bubble from MessageDisplay, working / waiting / idle.
 *
 * Out goes one event model (src/chat/types.ts): ChatUpdate { id, rev, ops },
 * rev +1 per update per terminal. A terminal whose chat view is not open gets
 * status updates only.
 *
 * Wrong or stale is the worst failure: a hook is placed only on a terminal it
 * certainly belongs to (never by folder), and whenever the mapping, the
 * schema, the version or the file itself is in doubt the status carries a
 * banner instead of a guess.
 */

const path = require('path')
const { quickSkip, checkLine, classify, versionVerdict, queueOp } = require('./chatSchema.cjs')
const { createItemBuilder, toolInput, CAPS, LIVE_BASE, LIVE_ORDER, unwrapPasted, alwaysRules, ruleLabel, permissionDiff } = require('./chatItems.cjs')
const { createTail } = require('./chatTail.cjs')
const { CHANGE_CAPS, createChangeIndex, scanChanges, readEdit, hashOf } = require('./chatChanges.cjs')
const { errWord } = require('./chatLog.cjs')
const { readFull } = require('./chatFull.cjs')

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const keep = (text) => !quickSkip(text)
const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v)
const byOrder = (a, b) => (a.order - b.order) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/** The conversation a terminal runs: its link file's (after /clear or a resume), else its own id */
function conversationOf(terminal, readLink) {
  return readLink(terminal.id) || terminal.id
}

/**
 * The one armed terminal a hook's session belongs to: the one whose current
 * conversation it is; else (re-reading the link files) the one linked to it;
 * else the one with that id; else null. Two matches at any step is null too,
 * and `onClash(terminals)` hears which (they show the `mapping` banner).
 * Never by folder.
 */
function terminalFor(sessionId, terminals, current, readLink, onClash) {
  // only a running armed terminal can own a hook (an exited tab that once had the conversation never clashes)
  const armed = terminals.filter(t => t.armed && t.alive !== false)
  const pick = (list) => {
    if (list.length === 1) return list[0]
    if (list.length > 1) { if (onClash) onClash(list); return null }
    return undefined
  }
  for (const match of [
    (t) => current.get(t.id) === sessionId,
    (t) => readLink(t.id) === sessionId,
    (t) => t.id === sessionId,
  ]) {
    const r = pick(armed.filter(match))
    if (r !== undefined) return r
  }
  return null
}

/**
 * A transcript the lens may read: a real .jsonl inside <claudeDir>/projects/ (symlinks resolved). `ext`: another
 * ending allowed instead (a sub-agent's .meta.json beside its transcript)
 */
async function transcriptAllowed(p, claudeDir, fs, ext = '.jsonl') {
  if (typeof p !== 'string' || !p.endsWith(ext)) return false
  // a lexical check first, so a path from a hook body (a UNC share, another drive) is never even looked up
  if (/^(\\\\|\/\/)/.test(p)) return false
  const win = process.platform === 'win32'
  const lexical = path.relative(path.resolve(claudeDir, 'projects'), path.resolve(p))
  if (!lexical || lexical.startsWith('..') || path.isAbsolute(lexical) || (win && /^[a-z]:/i.test(lexical))) return false
  try {
    const real = await fs.promises.realpath(p)
    const root = await fs.promises.realpath(path.join(claudeDir, 'projects'))
    const rel = path.relative(root, real)
    return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel) && real.endsWith(ext)
  } catch {
    return false
  }
}

/** projects/<any>/<conversation>.jsonl (as terminals.cjs hasTranscript looks), never built from the folder name */
async function findTranscript(conversationId, claudeDir, fs) {
  if (typeof conversationId !== 'string' || !UUID.test(conversationId)) return null
  let projects = []
  try { projects = await fs.promises.readdir(path.join(claudeDir, 'projects')) } catch { return null }
  for (const p of projects) {
    const file = path.join(claudeDir, 'projects', p, `${conversationId}.jsonl`)
    if (await transcriptAllowed(file, claudeDir, fs)) return file
  }
  return null
}

const normalise = (s) => String(s ?? '').replace(/\r\n?/g, '\n').split('\n').map(l => l.replace(/\s+$/, '')).join('\n').trim()

/**
 * The provisional text (MessageDisplay, or Stop's last_assistant_message)
 * and a transcript text are the same message: equal, or one starts with the
 * other's first 200 characters (20 at least), line ends and trailing spaces
 * aside. Never by id (MessageDisplay's message_id is not the transcript's).
 */
function liveMatches(live, text) {
  const a = normalise(live)
  const b = normalise(text)
  if (!a || !b) return false
  if (a === b) return true
  const pa = a.slice(0, 200)
  const pb = b.slice(0, 200)
  return (pa.length >= 20 && b.startsWith(pa)) || (pb.length >= 20 && a.startsWith(pb))
}

/** The row shown from a UserPromptSubmit before the prompt's own line is written (showPrompt) */
const isPromptRow = (i) => !!i && i.kind === 'user' && !i.parent && typeof i.pending === 'string'

/** The prompt a hook named and a user line are the same: equal once normalised, or one starts the other (liveMatches) */
function samePrompt(a, b) {
  const x = normalise(a)
  const y = normalise(b)
  return !!x && !!y && (x === y || liveMatches(x, y))
}

// ---------------------------------------------------------------------------
// The lens
// ---------------------------------------------------------------------------

const POLL_ACTIVE_MS = 250
const POLL_IDLE_MS = 1000
const FIND_MS = 500
const READ_AFTER_HOOK_MS = 50
const CLOSE_AFTER_MS = 60_000
const TAIL_WANT = 150
const CANARY_MS = 3000
// Claude Code writes a prompt only once every UserPromptSubmit hook is done, and another plugin's hook can take
// many seconds (claude-mem: 12 s, 2026-11-17) while spawn's own arrives at once: the wait allows for them
const MISSING_MS = 15_000
const STALL_MS = 30_000
const AGENT_ITEMS = 200
/** the items a view keeps (the page's own cap, src/chat/store.ts ITEM_CAP): the oldest go, hasOlder says so */
const ITEM_CAP = 4000
/** kept lines needed before the soft-problem ratio can raise the schema banner (a hard problem banners at once) */
const SOFT_WINDOW_MIN = 20
/** banners that stay until 다시 읽기 (the others clear when a later turn's canary passes) */
const STICKY = new Set(['schema', 'rewrite', 'version', 'mapping', 'worker'])
/** The permission modes hook bodies name (src/chat/types.ts PermissionMode); any other value shows as unknown (null) */
const PERMISSION_MODES = new Set(['default', 'acceptEdits', 'plan', 'auto', 'bypassPermissions', 'dontAsk'])

// ---- the chat's buttons (Phase 4): what a card shows, whole or not at all ----

/** The most a card shows of each part; past it the card is answered in the terminal (never cut and answered) */
const CARD = Object.freeze({ command: 20_000, file: 2_000, url: 2_000, args: 4_000, question: 1_000, label: 200, description: 1_000, header: 100, json: 65_536 })

/**
 * The input keys each tool's card shows (review C3). A key outside its tool's list makes the card
 * read-only (`why: 'fields'`): what 허용 approves is never more than the card shows. Any other tool
 * (MCP, unknown) shows its whole input as JSON.
 */
const CARD_KEYS = Object.freeze({
  Bash: ['command', 'description', 'timeout', 'run_in_background', 'dangerouslyDisableSandbox'],
  PowerShell: ['command', 'description', 'timeout', 'run_in_background', 'dangerouslyDisableSandbox'],
  Edit: ['file_path', 'old_string', 'new_string', 'replace_all'],
  Write: ['file_path', 'content'],
  WebFetch: ['url', 'prompt'],
})
/** A command's time limit Claude Code accepts at most (10 minutes); a bigger or odd value is not shown as a plain line */
const TIMEOUT_MAX_MS = 600_000

/**
 * What a permission card shows of a call's input, whole: the command (with its folder and, each on a
 * line of its own, running outside the sandbox, in the background, a time limit), the file, the URL
 * (and what is asked of the page), or (for any other tool) its input as JSON. `cut` with `why`: the
 * card cannot be answered here — 'long' (something would not fit), 'fields' (a key it does not show).
 */
function cardInput(tool, input, cwd) {
  if (!isObj(input)) return { input: {}, cut: true, why: 'fields' }
  const out = { input: {}, cut: false }
  const cut = (why) => { if (!out.cut) { out.cut = true; out.why = why } }
  const whole = (v, n) => { if (typeof v !== 'string' || !v) return undefined; if (v.length > n) { cut('long'); return undefined } return v }
  const json = () => {
    let text = ''
    try { text = JSON.stringify(input, null, 2) ?? '' } catch { text = '' }
    if (!text) cut('fields')
    else if (text.length > CARD.args) cut('long')
    else out.args = text
  }
  const keys = Object.hasOwn(CARD_KEYS, tool) ? CARD_KEYS[tool] : null
  if (keys && Object.keys(input).some(k => !keys.includes(k))) cut('fields')
  // an optional flag: absent, or a boolean (anything else is not something the card can say)
  const flag = (k) => { const v = input[k]; if (v === undefined || v === false) return false; if (v === true) return true; cut('fields'); return false }
  switch (tool) {
    case 'Bash': case 'PowerShell': {
      const command = whole(input.command, CARD.command)
      if (!command) { cut(typeof input.command === 'string' && input.command ? 'long' : 'fields'); break }
      out.input.command = command
      // (Claude's own words about the command: shown whole, labelled as Claude's)
      if (input.description !== undefined) {
        const d = typeof input.description === 'string' ? whole(input.description, CARD.description) : undefined
        if (typeof input.description !== 'string') cut('fields')
        else if (d) out.input.description = d
      }
      // the folder the command runs in (review M13): the hook's own cwd, else the session's
      if (typeof cwd === 'string' && cwd) { const c = whole(cwd, CARD.file); if (c) out.cwd = c }
      if (flag('dangerouslyDisableSandbox')) out.sandboxOff = true
      if (flag('run_in_background')) out.background = true
      if (input.timeout !== undefined) {
        const ms = input.timeout
        if (typeof ms === 'number' && Number.isInteger(ms) && ms > 0 && ms <= TIMEOUT_MAX_MS) out.timeoutMs = ms
        else cut('fields')
      }
      break
    }
    case 'Edit': case 'Write': {
      const file = whole(input.file_path, CARD.file)
      if (!file) { cut(typeof input.file_path === 'string' && input.file_path ? 'long' : 'fields'); break }
      out.input.file = file
      if (tool === 'Edit' && flag('replace_all')) out.replaceAll = true
      break
    }
    case 'WebFetch': {
      const url = whole(input.url, CARD.url)
      if (!url) { cut(typeof input.url === 'string' && input.url ? 'long' : 'fields'); break }
      out.input.url = url
      if (input.prompt !== undefined) {
        const p = typeof input.prompt === 'string' ? whole(input.prompt, CARD.description) : undefined
        if (typeof input.prompt !== 'string') cut('fields')
        else if (p) out.fetchPrompt = p
      }
      break
    }
    default: json()
  }
  return out
}

const NETWORK_PATH = /^(?:\\\\|\/\/)/
/**
 * Whether a Write would replace a file that is there (review C4), by the session folder's rules
 * (chatFiles.cjs): a network or device path is never touched, a link is not followed. 'none': no such
 * file; 'file': a plain file is there (the card says it is overwritten); 'unsure': anything else (a
 * folder, a link, a path that cannot be resolved, an error but "not found") — the card is read-only.
 */
function fileThere(file, cwd, fsx) {
  try {
    if (typeof file !== 'string' || !file || NETWORK_PATH.test(file)) return 'unsure'
    const base = typeof cwd === 'string' && cwd && !NETWORK_PATH.test(cwd) ? cwd : null
    if (!path.isAbsolute(file) && !base) return 'unsure'
    const abs = base ? path.resolve(base, file) : path.resolve(file)
    if (NETWORK_PATH.test(abs) || typeof fsx?.lstatSync !== 'function') return 'unsure'
    const st = fsx.lstatSync(abs)
    return st.isFile() && !st.isSymbolicLink() ? 'file' : 'unsure'
  } catch (err) {
    return err && err.code === 'ENOENT' ? 'none' : 'unsure'
  }
}

/**
 * A question card's questions (the first also as `question`, as before), and whether it can be answered from the
 * chat: 1–4 questions (2026-11-17; one until then), each with 2–6 options of unique labels, single or multi-select,
 * every word fitting the card, the question texts unique (the answer is keyed by them).
 */
function questionCard(input) {
  const qs = isObj(input) && Array.isArray(input.questions) ? input.questions : []
  const cutTo = (v, n) => (typeof v === 'string' && v ? v.slice(0, n) : undefined)
  const shown = qs.filter(isObj).slice(0, 4).map(q => {
    const opts = Array.isArray(q.options) ? q.options.filter(isObj) : []
    return {
      text: cutTo(q.question, CARD.question) ?? '',
      ...(cutTo(q.header, CARD.header) ? { header: cutTo(q.header, CARD.header) } : {}),
      ...(q.multiSelect === true ? { multiSelect: true } : {}),
      options: opts.slice(0, 6).map(o => ({ label: cutTo(o.label, CARD.label) ?? '', ...(cutTo(o.description, CARD.description) ? { description: cutTo(o.description, CARD.description) } : {}) })),
    }
  })
  let size = Infinity
  // (the whole input: the answer carries all of it back)
  try { size = JSON.stringify(input).length } catch { size = Infinity }
  const fits = (q) => {
    if (!isObj(q) || !Array.isArray(q.options)) return false
    const opts = q.options.filter(isObj)
    const labels = opts.map(o => o.label)
    return q.options.length === opts.length && typeof q.question === 'string' && !!q.question && q.question.length <= CARD.question
      && opts.length >= 2 && opts.length <= 6
      && labels.every(l => typeof l === 'string' && !!l && l.length <= CARD.label) && new Set(labels).size === labels.length
      && opts.every(o => o.description === undefined || (typeof o.description === 'string' && o.description.length <= CARD.description))
      && (q.header === undefined || (typeof q.header === 'string' && q.header.length <= CARD.header))
      && (q.multiSelect === undefined || typeof q.multiSelect === 'boolean')
  }
  const answerable = qs.length >= 1 && qs.length <= 4 && qs.every(fits)
    && new Set(qs.map(q => q.question)).size === qs.length && size <= CARD.json
  const sets = answerable ? qs.map(q => q.options.map(o => o.label)) : []
  return { question: shown[0] ?? null, questions: shown, answerable, labels: sets[0] ?? [], sets }
}
/** The tools whose call opens a dialog in the terminal without a PermissionRequest */
const ASKING_TOOLS = new Set(['AskUserQuestion', 'ExitPlanMode'])

/**
 * @param {object} o
 * @param {string} o.claudeDir    <CLAUDE_CONFIG_DIR or ~/.claude>
 * @param {string} o.userDataDir  the app's data folder (session-links/ is read, never written)
 * @param {object} o.fs           node's fs (promises, readFileSync for the tiny link files, watch)
 * @param {(u: object) => void} o.emit   a ChatUpdate out
 * @param {(name: string, input: unknown) => string} o.callKey  hooks/spawn-hook.cjs callKey
 * @param {string|null} [o.version]  the Claude Code version the host armed with
 */
function createLens({
  claudeDir, userDataDir, fs = require('fs'), now = () => Date.now(),
  timers = { setTimeout: (f, ms) => setTimeout(f, ms), clearTimeout: (t) => clearTimeout(t), setInterval: (f, ms) => setInterval(f, ms), clearInterval: (t) => clearInterval(t) },
  emit, callKey = require('../hooks/spawn-hook.cjs').callKey, log = () => {}, version = null,
  // UserPromptSubmit for a terminal: what was on its prompt row was taken (the composer's ledger, chatHost.cjs)
  onPrompt: promptSignal = () => {},
  // a question or a plan to approve open in a terminal, or none any more (the composer's Enter, chatHost.cjs)
  onAsking: askingSignal = () => {},
  // Phase 4: what a held request is (hold-bind / hold-pass) and when its call settled (hold-resolved), to main
  onHold: holdSignal = () => {},
  watch = (file, onChange) => {
    try { const w = fs.watch(file, { persistent: false }, onChange); w.on('error', () => {}); return w } catch { return null }
  },
}) {
  /** terminal id → its state */
  const terms = new Map()
  // (the host's version: set again when Claude Code's binary changes while the lens runs — setVersion)
  let versionNote = versionVerdict(version) === 'new' ? 'new-version' : null
  // "2.1.323 (Claude Code)" → "2.1.323"
  version = /(\d+\.\d+\.\d+)/.exec(String(version ?? ''))?.[1] ?? null

  function readLink(id) {
    if (typeof id !== 'string' || !UUID.test(id)) return ''
    try {
      const v = fs.readFileSync(path.join(userDataDir, 'session-links', id), 'utf8').trim()
      return UUID.test(v) ? v : ''
    } catch { return '' }
  }

  function makeTerm({ id, cwd, armed, status, createdAt }) {
    const t = {
      id, cwd: typeof cwd === 'string' ? cwd : '', armed: armed === true, alive: status !== 'exited',
      current: conversationOf({ id }, readLink),
      hookPath: null, path: null, conv: null,
      open: false, loaded: false, following: true,
      tail: null, builder: null, items: new Map(),
      calls: new Map(), live: new Map(), liveSeq: 0,
      status: { state: 'starting', since: null, label: null, banner: null, note: versionNote, version: version ?? null, hasOlder: false, empty: false },
      sent: null, rev: 0, queue: Promise.resolve(),
      timers: { close: null, poll: null, find: null, read: null, canary: null, missing: null, queueIdle: null, changes: null },
      watcher: null, turnStart: 0,
      // part two: the turn's prompt mark, the canary, a stall, the schema window, versions, sub-agents
      prompt: null, canary: null, stall: null, soft: [], softCount: 0, lineVersion: null,
      agentPaths: new Map(), unpairedAgentTools: 0, logged: new Set(),
      // the sub-agents at work now (status.agents, the chat's strip), by agent id
      running: new Map(),
      // the session's launch (a tab reopened under the same id is a new session), the turn's prompt text
      // (to find the turn's own user line), the next MessageDisplay index per message seen (even unseen views)
      createdAt: typeof createdAt === 'number' ? createdAt : null, promptText: null, streams: new Map(),
      // polls in a row that failed (a banner only after READ_FAILS); this state let go (a relaunch, the tab gone)
      readFails: 0, disposed: false,
      // a turn a prompt opened and nothing has closed yet (Stop, StopFailure, an interrupt, the turn's end)
      turnOpen: false,
      // the session-links file as last read by followLink (a /clear changes it before any hook says so)
      linkSeen: null,
      // what Claude Code itself queued while it worked (the composer's strip), oldest first; after an
      // operation the lens does not know, nothing until the next enqueue
      queued: [], queuedBlocked: false,
      // Phase 4: the cards that wait on the user (status.asks), by key, with the call key that settles each
      asks: new Map(),
      // Phase 5: the open view's change index (chatChanges.cjs), its scan and its sub-agents' files
      changes: null,
    }
    t.linkSeen = readLink(id) || null
    if (!t.alive) t.status.state = 'ended'
    return t
  }

  // ---- out ----------------------------------------------------------------

  const statusOf = (t) => ({ ...t.status, banner: t.status.banner ? { ...t.status.banner } : null })

  /** One update: `ops` plus a status op when the status changed; a terminal not open gets status only */
  function flush(t, ops = []) {
    // a terminal's old state, after its id was launched again or let go: it speaks no more
    if (t.disposed) return
    let out = ops.filter(o => !(o.op === 'upsert' && !o.items.length) && !(o.op === 'remove' && !o.ids.length))
    if (!t.open) out = out.filter(o => o.op === 'status')
    const status = JSON.stringify(t.status)
    if (out.some(o => o.op === 'reset')) t.sent = status
    else if (status !== t.sent) { out.push({ op: 'status', status: statusOf(t) }); t.sent = status }
    if (!out.length) return
    t.rev += 1
    try { emit({ id: t.id, rev: t.rev, ops: out }) } catch (err) { log('error', `chat lens: emit failed (${errWord(err)})`) }
  }

  const upsertOp = (items) => ({ op: 'upsert', items: [...items].sort(byOrder) })

  /** working / waiting keep the moment the work began (since); idle clears it */
  function setState(t, state, at) {
    const prev = t.status.state
    if (prev === 'ended' || prev === state) return
    const busy = (s) => s === 'working' || s === 'waiting'
    t.status.state = state
    // whose wait it was (a sub-agent's) is over with the wait
    if (state !== 'waiting') delete t.status.waitingAgent
    // (idle or ended: no question or plan is open in the terminal any more, whatever hook did not come)
    if (state === 'idle' || state === 'ended') askingOff(t)
    if (!busy(state)) t.status.since = null
    else if (!busy(prev) || t.status.since === null) t.status.since = typeof at === 'number' ? at : now()
  }

  /** A banner: a sticky one (schema, rewrite, version, mapping) is never replaced by a passing one */
  function setBanner(t, reason, detail) {
    const cur = t.status.banner
    if (cur && (STICKY.has(cur.reason) || !STICKY.has(reason))) return
    t.status.banner = detail ? { reason, detail } : { reason }
  }

  // ---- work, one thing at a time per terminal ------------------------------

  function enqueue(t, fn) {
    t.queue = t.queue.then(fn).catch((err) => onError(t, err))
    return t.queue
  }

  /** Polls in a row that may fail before the view says its reader stopped (a scanner holds the file a moment) */
  const READ_FAILS = 3

  /**
   * A read that failed. The transcript gone (ENOENT): following stops and the view
   * says `missing`. A load that failed: the `worker` banner (the reading part stopped
   * for this view), and still a reset, so the page never waits. A poll that failed
   * (EBUSY, EPERM, EMFILE while a scanner holds the growing file): nothing shown, the
   * next poll reads on; only READ_FAILS failures in a row show the `worker` banner.
   * Logged once per terminal and kind, never with a path.
   */
  function onError(t, err) {
    const code = errWord(err)
    logOnce(t, `err:${code}`, `chat lens: a read failed (${code})`, 'error')
    if (!terms.has(t.id) || t.disposed) return
    const gone = code === 'ENOENT'
    if (t.path && gone) { t.following = false; stopFollowing(t); changesGone(t) }
    if (!gone && t.loaded && ++t.readFails < READ_FAILS) return
    setBanner(t, gone ? 'missing' : 'worker')
    if (t.open && !t.loaded) {
      t.loaded = true
      flush(t, [{ op: 'reset', items: [...t.items.values()].sort(byOrder), status: statusOf(t) }])
    } else flush(t)
  }

  function stopTimer(t, name) {
    if (t.timers[name]) { timers.clearTimeout(t.timers[name]); t.timers[name] = null }
  }

  function stopFollowing(t) {
    for (const name of ['poll', 'find', 'read']) stopTimer(t, name)
    if (t.watcher) { try { t.watcher.close() } catch {} t.watcher = null }
  }

  /** The view's file and items gone; `keepTurn`: the turn's own checks (missing, canary) go on (a /clear) */
  function dropView(t, { keepTurn = false } = {}) {
    stopFollowing(t)
    dropChanges(t)
    if (!keepTurn) { clearCanary(t); stopTimer(t, 'missing') }
    t.stall = null
    t.tail = null
    t.builder = null
    t.items = new Map()
    t.live = new Map()
    t.loaded = false
    t.path = null
    t.conv = null
  }

  // ---- the transcript ------------------------------------------------------

  async function resolveTranscript(t) {
    const conv = t.current
    if (t.hookPath && path.basename(t.hookPath) === `${conv}.jsonl` && await transcriptAllowed(t.hookPath, claudeDir, fs)) return t.hookPath
    return findTranscript(conv, claudeDir, fs)
  }

  /** A tool row from the file over the one hooks made: the file's place; hook-known progress kept while the file says running */
  function merge(prev, next) {
    if (!prev || prev.kind !== 'tool' || next.kind !== 'tool') return next
    const m = { ...next }
    if (next.state === 'running' && prev.state !== 'running') m.state = prev.state
    if (m.state === 'running' && prev.waiting && !m.waiting) m.waiting = prev.waiting
    if (m.durationMs === undefined && prev.durationMs !== undefined) m.durationMs = prev.durationMs
    if (m.agentId === undefined && prev.agentId !== undefined) m.agentId = prev.agentId
    if (m.agentTools === undefined && prev.agentTools !== undefined) m.agentTools = prev.agentTools
    return m
  }

  /**
   * Lines read → items (in t.items). Returns what changed: items to upsert,
   * ids to remove (a provisional bubble the transcript's text replaced).
   */
  function ingest(t, lines, { live = true, queue = live } = {}) {
    const upserts = new Map()
    const removes = new Set()
    for (const { text, offset } of lines) {
      let obj
      try { obj = JSON.parse(text) } catch { onBadLine(t, { hard: true, problem: 'a line that is not JSON' }); continue }
      const problem = checkLine(obj)
      onLineChecked(t, obj, problem)
      if (problem?.hard) continue
      // a line written now goes to the change index too (what the scan began with, it reads itself)
      if (live && t.changes) changeLine(t, obj, offset, text)
      // (only lines read live or in the tail first read: an older page never touches the queue)
      if (queue && obj.type === 'queue-operation') { onQueueOp(t, obj); continue }
      for (const raw of t.builder.line(obj, offset)) {
        const item = merge(t.items.get(raw.id), raw)
        t.items.set(item.id, item)
        upserts.set(item.id, item)
        // only a text written now replaces a bubble (an older page's text never does)
        if (live && item.kind === 'text' && !item.parent) {
          for (const [mid, l] of t.live) {
            if (liveMatches(l.text, item.text)) {
              t.live.delete(mid)
              const id = `live:${mid}`
              if (t.items.delete(id)) removes.add(id)
              upserts.delete(id)
            }
          }
        }
        // the prompt's own line: the row shown from its UserPromptSubmit goes
        if (live && item.kind === 'user' && !item.parent) {
          for (const [id, p] of t.items) {
            if (isPromptRow(p) && samePrompt(p.text, item.text)) { t.items.delete(id); upserts.delete(id); removes.add(id) }
          }
        }
        if (live) onItem(t, item, upserts, removes)
        // a prompt Claude Code took in (mid-turn, or as the next turn): its entry leaves the strip
        if (queue && item.kind === 'user' && !item.parent) unqueue(t, item.text)
      }
    }
    capItems(t, upserts, removes)
    return { upserts, removes }
  }

  /**
   * At most ITEM_CAP items per view (an all-day session): the oldest go with
   * their sub-agent's items, the page hears (remove), and hasOlder says there is more.
   */
  function capItems(t, upserts, removes) {
    if (t.items.size <= ITEM_CAP) return
    const main = [...t.items.values()].filter(i => !i.parent && i.order < LIVE_BASE).sort(byOrder)
    const children = new Map()
    for (const i of t.items.values()) if (i.parent) children.set(i.parent, [...(children.get(i.parent) ?? []), i.id])
    for (const i of main) {
      if (t.items.size <= ITEM_CAP) break
      for (const id of [i.id, ...(children.get(i.id) ?? [])]) {
        t.items.delete(id)
        upserts.delete(id)
        removes.add(id)
        t.builder?.forget(id)
      }
    }
    t.status.hasOlder = true
  }

  /** The provisional bubbles (and the prompt shown from its hook) go (their turn is over): the ids removed, also added to `removes` when given */
  function clearLive(t, removes) {
    const ids = []
    for (const [id, i] of t.items) if (i.kind === 'live' || isPromptRow(i)) ids.push(id)
    for (const id of ids) { t.items.delete(id); removes?.add(id) }
    t.live.clear()
    return ids
  }

  // ---- what the lines say about the lens's own footing ---------------------

  /** A complete line that is not JSON, or a hard shape problem: the transcript cannot be trusted */
  function onBadLine(t, problem) {
    setBanner(t, 'schema', problem.problem)
  }

  /**
   * Every kept line, checked: hard → schema; soft problems on more than half
   * of the last 200 kept lines → schema; the Claude Code version a line names
   * (older than the checked range → version; newer → a quiet note).
   */
  function onLineChecked(t, obj, problem) {
    if (problem?.hard) { onBadLine(t, problem); return }
    const kind = classify(obj)
    if (kind === 'noise' || kind === 'attachment') return
    t.soft.push(problem ? 1 : 0)
    t.softCount += problem ? 1 : 0
    if (t.soft.length > 200) t.softCount -= t.soft.shift()
    // (a new session's first line of a new bookkeeping kind is not yet a pattern)
    if (t.soft.length >= SOFT_WINDOW_MIN && t.softCount * 2 > t.soft.length) setBanner(t, 'schema', 'unknown lines')
    if ((kind === 'user' || kind === 'assistant') && typeof obj.version === 'string' && obj.version && obj.version !== t.lineVersion) {
      t.lineVersion = obj.version.slice(0, 40)
      noteVersion(t, t.lineVersion)
    }
  }

  // (each Claude Code version first seen in a transcript is logged once: its number and verdict only)
  const versionsLogged = new Set()
  function noteVersion(t, v) {
    const verdict = versionVerdict(v)
    if (verdict === 'unknown') return
    const number = /^\d{1,4}\.\d{1,4}\.\d{1,6}/.exec(v)?.[0]
    if (number && !versionsLogged.has(number) && versionsLogged.size < 32) {
      versionsLogged.add(number)
      log('info', `chat lens: a transcript of Claude Code ${number} (${verdict})`)
    }
    t.status.version = v
    if (verdict === 'old') setBanner(t, 'version')
    // a later line by a checked version: the session is written by it now (a long session resumed across updates);
    // the old version's banner said a version the view no longer reads from
    if (verdict === 'ok' && t.status.banner?.reason === 'version') t.status.banner = null
    if (verdict === 'new') t.status.note = 'new-version'
  }

  /** An item read as it was written (not from history): interrupts, the canary, the turn's end */
  function onItem(t, item, upserts, removes) {
    if (item.parent) return
    if (item.kind === 'turn-end') { setState(t, 'idle'); t.turnOpen = false; clearLive(t, removes); queueIdle(t) }
    // Esc writes "[Request interrupted by user…" (FINDINGS §1); a partial text alone only marks that text
    if (item.kind === 'notice' && item.notice === 'interrupted') interrupted(t, upserts, removes)
    // a call's result in the transcript (done, failed, rejected …): its cards are over
    if (item.kind === 'tool' && item.state !== 'running') { settle(t, a => a.card.toolId === item.id, 'result'); askingOff(t, item.id) }
    if (t.canary && item.order < LIVE_BASE) {
      t.canary.fresh.push(item)
      if (canaryHolds(t)) canaryPassed(t, upserts, removes)
    }
  }

  /**
   * Esc: the turn's running rows are interrupted, the session idle. No Stop
   * comes after Esc, so no canary is armed; a pending missing check is moot;
   * the turn's bubble and its open calls go with it.
   */
  function interrupted(t, upserts, removes) {
    for (const i of t.items.values()) {
      if (i.kind === 'tool' && !i.parent && i.state === 'running' && i.order >= t.turnStart) {
        const next = { ...i, state: 'interrupted' }
        delete next.waiting
        t.items.set(i.id, next)
        upserts.set(i.id, next)
      }
    }
    setState(t, 'idle')
    t.turnOpen = false
    clearCanary(t)
    stopTimer(t, 'missing')
    clearLive(t, removes)
    t.calls.clear()
    settleAll(t, 'interrupted')
    askingOff(t)
    // (Esc may put queued prompts back into the input: a strip left over goes after the idle wait)
    queueIdle(t)
  }

  /**
   * The turn's own user line: the newest user item whose text is this turn's prompt
   * (UserPromptSubmit's) and, for a prompt seen while the file was being read, it lies past
   * where the file stood then. A prompt sent mid-turn (a queued_command, also a user item)
   * is passed over when it is not the prompt the hook named. Unknown (null): the canary
   * then accepts only lines read after Stop.
   */
  function turnAnchor(t) {
    if (typeof t.promptText !== 'string') return null
    const a = normalise(t.promptText)
    let found = null
    for (const i of t.items.values()) {
      if (i.kind !== 'user' || i.parent || i.order >= LIVE_BASE || (found && i.order <= found.order)) continue
      const b = normalise(i.text)
      if (b && (a === b || (i.truncated && a.startsWith(b)))) found = i
    }
    if (!found) return null
    if (t.prompt && t.prompt.path && t.prompt.path === t.path && found.order < t.prompt.end) return null
    return found.order
  }

  /** The Stop message and a transcript text are the same answer: equal once normalised (a capped text: a prefix of it) */
  function sameAnswer(msg, item) {
    const a = normalise(msg)
    const b = normalise(item.text)
    if (!a || !b) return false
    return a === b || (item.truncated === true && a.startsWith(b))
  }

  /**
   * The canary holds: after the turn's own user line (or, not knowing it, among the
   * lines read since Stop) there is the answer Stop named — or, for a turn with tools
   * only, anything at all after the user line.
   */
  function canaryHolds(t) {
    if (!t.canary) return true
    const anchor = turnAnchor(t)
    const lines = anchor !== null
      ? [...t.items.values()].filter(i => !i.parent && i.order > anchor && i.order < LIVE_BASE)
      : t.canary.fresh
    // (a thinking item alone is not the turn: Claude Code writes it before anything the turn did)
    if (!t.canary.msg) return lines.some(i => i.kind !== 'user' && i.kind !== 'thinking')
    if (lines.some(i => i.kind === 'text' && sameAnswer(t.canary.msg, i))) return true
    // no user line of its own (a wake-up's prompt is an `agent-done` notice, a prompt the record words otherwise):
    // the answer may have been read before Stop reached the lens (the file is written ~0.1 s after Stop is sent),
    // so the turn's own part of the file counts too — every line past where the file stood at its prompt
    return anchor === null && [...t.items.values()].some(i => i.kind === 'text' && !i.parent && i.order >= t.canary.start && i.order < LIVE_BASE && sameAnswer(t.canary.msg, i))
  }

  function clearCanary(t) {
    stopTimer(t, 'canary')
    t.canary = null
  }

  /**
   * The finished turn is in the transcript: banners that only doubted the
   * live reading (canary, missing, stalled) go; rows of the turn that never
   * got a result are 'unknown' (the transcript does not say how they ended).
   */
  function canaryPassed(t, upserts, removes) {
    const start = t.canary ? t.canary.start : t.turnStart
    clearCanary(t)
    if (t.status.banner && !STICKY.has(t.status.banner.reason)) t.status.banner = null
    for (const i of t.items.values()) {
      if (i.kind === 'tool' && i.state === 'running' && i.order >= start && !i.parent) {
        const next = { ...i, state: 'unknown' }
        delete next.waiting
        t.items.set(i.id, next)
        upserts.set(i.id, next)
      }
    }
    // the turn is settled: whatever stayed provisional goes
    clearLive(t, removes)
  }

  /** The transcript grew past where it stood at the turn's prompt (missing) */
  function grewSincePrompt(t) {
    if (!t.tail || !t.prompt) return false
    const end = t.tail.state().endOffset
    return t.prompt.path === t.path ? end > t.prompt.end : end > 0
  }

  async function load(t) {
    if (t.disposed) return
    t.loaded = false
    t.readFails = 0
    dropChanges(t)
    // (opened after a /clear made while no view was open: the conversation the link names now)
    followLink(t)
    const file = await resolveTranscript(t)
    if (t.disposed || (!t.open && !t.timers.close)) return
    if (!file) {
      t.path = null
      t.items = new Map()
      t.status.empty = true
      t.status.hasOlder = false
      if (t.status.state === 'starting') t.status.state = 'idle'
      t.loaded = true
      flush(t, [{ op: 'reset', items: [], status: statusOf(t) }])
      startFinding(t)
      return
    }
    t.path = file
    t.conv = path.basename(file, '.jsonl')
    t.tail = createTail(file, { fs: fs.promises })
    t.builder = createItemBuilder({ cwd: t.cwd })
    t.items = new Map()
    t.live = new Map()
    const r = await t.tail.readTail({ want: TAIL_WANT, keep })
    if (t.disposed) return
    t.queued = []
    t.queuedBlocked = false
    ingest(t, r.lines, { live: false, queue: true })
    syncQueue(t)
    queueIdle(t)
    // opened in the middle of a turn: the turn starts at its own user line, when it is known;
    // otherwise only what is read from now on counts as this turn's
    if (t.status.state === 'working' || t.status.state === 'waiting') {
      const anchor = turnAnchor(t)
      t.turnStart = anchor ?? r.endOffset
      t.prompt = { path: t.path, end: anchor ?? r.endOffset }
      // the turn ended while no view read it live (a permission refused with Esc in the terminal: no
      // hook follows; the Phase 3 trial): its own record says so after its prompt — an interrupt or
      // the turn's end — and the session is idle, not waiting for good
      if (anchor !== null) {
        const after = [...t.items.values()].filter(i => !i.parent && i.order > anchor && i.order < LIVE_BASE)
        const stopped = after.some(i => i.kind === 'notice' && i.notice === 'interrupted')
        if (stopped) interrupted(t, new Map(), new Set())
        else if (after.some(i => i.kind === 'turn-end')) { setState(t, 'idle'); t.turnOpen = false }
      }
    }
    t.status.empty = false
    t.status.hasOlder = !r.atStart
    if (t.status.state === 'starting') t.status.state = 'idle'
    t.loaded = true
    // the whole conversation's changes: scanned up to where the tail stands now (later lines come through ingest)
    startChanges(t, r.endOffset)
    flush(t, [{ op: 'reset', items: [...t.items.values()].sort(byOrder), status: statusOf(t) }])
    startFollowing(t)
  }

  async function readNew(t) {
    if (!t.tail || !t.following || !t.loaded || t.disposed) return
    const before = t.tail.state().endOffset
    const r = await t.tail.readNew({ keep })
    if (t.disposed) return
    t.readFails = 0
    if (r.rewritten) { onRewritten(t); return }
    // the file grew (bookkeeping counts too): a stall is over, and a prompt that landed late was not missing
    if (t.tail.state().endOffset > before) {
      t.stall = null
      if (t.status.banner?.reason === 'missing' && grewSincePrompt(t)) t.status.banner = null
    }
    if (!r.lines.length) { flush(t); return }
    const { upserts, removes } = ingest(t, r.lines)
    const ops = []
    if (removes.size) ops.push({ op: 'remove', ids: [...removes] })
    if (upserts.size) ops.push(upsertOp(upserts.values()))
    flush(t, ops)
  }

  /** Not append-only after all: a banner, and nothing more is read until 다시 읽기 */
  function onRewritten(t) {
    t.following = false
    stopFollowing(t)
    clearCanary(t)
    stopTimer(t, 'missing')
    setBanner(t, 'rewrite')
    // the index's offsets point into a record that is not what was read: it goes (다시 읽기 builds it again)
    dropChanges(t)
    flush(t)
  }

  /**
   * The terminal's link file moved to another conversation since it was last read (a /clear
   * or a resume: the game hook rewrites it at SessionStart, before any prompt, so no chat hook
   * says so yet): `current` follows it, unless another terminal holds that conversation. Only a
   * change counts, so a link the game hook failed to update never pulls `current` back.
   */
  function followLink(t) {
    const v = readLink(t.id)
    if (!v || v === t.linkSeen) return false
    t.linkSeen = v
    if (v === t.current || [...terms.values()].some(o => o !== t && o.current === v)) return false
    t.current = v
    return true
  }

  function startFollowing(t) {
    stopFollowing(t)
    if (!t.path || t.disposed) return
    t.watcher = watch(t.path, () => scheduleRead(t, 0))
    const tick = () => {
      t.timers.poll = timers.setTimeout(() => {
        t.timers.poll = null
        // a /clear shows its new, empty conversation at once, not the old one until the next prompt
        if (followLink(t) && t.loaded && t.conv !== t.current) { t.turnStart = 0; switchConversation(t); return }
        enqueue(t, () => readNew(t))
        if (t.open && t.following) tick()
      }, t.status.state === 'working' || t.status.state === 'waiting' ? POLL_ACTIVE_MS : POLL_IDLE_MS)
    }
    if (t.open) tick()
  }

  /** No transcript yet (a new session): look again every 500 ms */
  function startFinding(t) {
    stopTimer(t, 'find')
    if (!t.open) return
    t.timers.find = timers.setTimeout(() => {
      t.timers.find = null
      enqueue(t, async () => {
        if (!t.open || t.path) return
        followLink(t)
        if (await resolveTranscript(t)) await load(t)
        else startFinding(t)
      })
    }, FIND_MS)
  }

  /** A read soon (after a hook, or the file changed) */
  function scheduleRead(t, delay) {
    if (!t.open || !t.loaded) return
    if (!t.path) { if (!t.timers.find) startFinding(t); return }
    if (t.timers.read) return
    t.timers.read = timers.setTimeout(() => { t.timers.read = null; enqueue(t, () => readNew(t)) }, delay)
  }

  /** The view moves to another conversation's file (a /clear, a resume) */
  function switchConversation(t) {
    // another conversation in this terminal: nothing of the last one waits on the user any more
    settleAll(t, 'conversation')
    enqueue(t, async () => {
      if (!t.open && !t.timers.close) return
      dropView(t, { keepTurn: true })
      await load(t)
    })
  }

  // ---- what Claude Code queued (the composer's strip) ------------------------

  const QUEUE_KEEP = 10
  const QUEUE_SENT = 3
  const QUEUE_TEXT = 200
  const QUEUE_IDLE_MS = 10_000

  /** The strip's part of the status: the first three (capped) and the count; absent when empty */
  function syncQueue(t) {
    if (!t.queued.length) { delete t.status.queued; delete t.status.queuedCount; return }
    t.status.queued = t.queued.slice(0, QUEUE_SENT).map(q => ({ text: q.text.slice(0, QUEUE_TEXT), truncated: q.text.length > QUEUE_TEXT }))
    t.status.queuedCount = t.queued.length
  }

  /** A queue-operation line: enqueue adds; remove / dequeue take the entry with its text (or the first); anything else clears */
  function onQueueOp(t, obj) {
    const { op, text } = queueOp(obj)
    if (op === 'enqueue') {
      t.queuedBlocked = false
      if (text !== null && text.trim()) {
        t.queued.push({ text, at: now() })
        if (t.queued.length > QUEUE_KEEP) t.queued.shift()
      }
    } else if (op === 'remove' || op === 'dequeue') {
      if (t.queuedBlocked) return
      const i = text === null ? 0 : t.queued.findIndex(q => q.text === text)
      if (i >= 0 && t.queued.length) t.queued.splice(i, 1)
    } else {
      t.queued = []
      t.queuedBlocked = true
      logOnce(t, 'queue-op', 'chat lens: a queue operation it does not know: the queue strip stays empty until the next prompt is queued')
    }
    syncQueue(t)
    queueIdle(t)
  }

  /** A prompt taken in (a queued_command, or the next turn's user line): its entry goes */
  function unqueue(t, text) {
    if (!t.queued.length) return
    const i = t.queued.findIndex(q => liveMatches(q.text, text))
    if (i < 0) return
    t.queued.splice(i, 1)
    syncQueue(t)
  }

  /** Idle with entries left: in 10 s, unless a prompt comes, the strip is cleared (it lost track rather than lie) */
  function queueIdle(t) {
    stopTimer(t, 'queueIdle')
    if (!t.queued.length || t.status.state !== 'idle') return
    t.timers.queueIdle = timers.setTimeout(() => {
      t.timers.queueIdle = null
      if (t.status.state !== 'idle' || !t.queued.length) return
      t.queued = []
      syncQueue(t)
      flush(t)
    }, QUEUE_IDLE_MS)
  }

  // ---- the cards that wait on the user (Phase 4) ------------------------------
  //
  // A held request (its hold id from main) is bound — to this terminal, its call key and what an
  // answer needs — or passed back to the terminal. Its card is in the status (status.asks, oldest
  // first) until what Claude Code did settles the call: a PostToolUse, the transcript's result, an
  // interrupt, the turn's end, a new turn, another conversation, the terminal gone. Main hears that
  // too (hold-resolved), so a hold never waits on a call that is over. The card's state follows main's
  // hold (hold-state); it never says what the click did, only what was sent and what Claude Code did.

  const sendHold = (m) => { try { holdSignal(m) } catch {} }

  function syncAsks(t) {
    if (!t.asks.size) { delete t.status.asks; return }
    t.status.asks = [...t.asks.values()].map(a => a.card)
  }

  function addCard(t, card, key) {
    t.asks.set(card.key, { card, callKey: key })
    syncAsks(t)
  }

  /** The cards `pred` names go (their call settled); main hears which holds are over */
  function settle(t, pred, why) {
    if (!t.asks.size) return
    const holdIds = []
    for (const [k, a] of [...t.asks]) {
      if (!pred(a)) continue
      t.asks.delete(k)
      if (a.card.holdId) holdIds.push(a.card.holdId)
    }
    if (holdIds.length) sendHold({ t: 'hold-resolved', holdIds, why })
    syncAsks(t)
  }
  const settleAll = (t, why) => settle(t, () => true, why)

  const keyOf = (name, input) => { try { return callKey(name, input) } catch { return null } }

  /**
   * A held request, read: bound with its card, or passed (a plan, a question asked as a permission,
   * another terminal, a shape not verified, something too long to show whole). The message to main
   * goes last, once everything it says is known.
   */
  function onHeld(t, event, body, at, holdId, urlId) {
    if (typeof urlId === 'string' && urlId && urlId !== t.id) return sendHold({ t: 'hold-pass', holdId, why: 'other-terminal' })
    const tool = body.tool_name
    if (typeof tool !== 'string' || !tool) return sendHold({ t: 'hold-pass', holdId, why: 'shape' })
    const key = keyOf(tool, body.tool_input)
    if (event === 'PermissionRequest') {
      if (tool === 'ExitPlanMode') {
        // plan approval from the chat (2026-11-17): 승인 (allow) or 계속 계획하기 (deny, Claude plans on), only when the
        // plan is shown whole and it is the main thread's; a sub-agent's, a plan too long, or no key: the terminal's
        const input = toolInput(tool, body.tool_input, t.cwd)
        const raw = isObj(body.tool_input) && typeof body.tool_input.plan === 'string' ? body.tool_input.plan : ''
        const whole = !!raw.trim() && (input.plan ?? '').length === raw.length
        const agent = typeof body.agent_id === 'string'
        const answerable = whole && !agent && !!key
        addCard(t, { key: answerable ? holdId : `ask:${holdId}`, holdId: answerable ? holdId : null, kind: 'plan', toolId: (key && t.calls.get(key)) ?? null, agent, tool, input, always: null, state: answerable ? 'open' : 'terminal', since: at, ...(raw && !whole ? { cut: true, cutWhy: 'long' } : {}) }, key)
        return sendHold(answerable ? { t: 'hold-bind', holdId, id: t.id, kind: 'permission', key, data: { rules: [] } } : { t: 'hold-pass', holdId, why: 'plan' })
      }
      // a question is answered through its PreToolUse route, never as a permission
      if (tool === 'AskUserQuestion') return sendHold({ t: 'hold-pass', holdId, why: 'question' })
      if (!key) return sendHold({ t: 'hold-pass', holdId, why: 'shape' })
      const cwd = typeof body.cwd === 'string' && body.cwd ? body.cwd : t.cwd
      const shown = cardInput(tool, body.tool_input, cwd)
      const diff = permissionDiff(tool, body.tool_input, t.cwd)
      let why = shown.cut ? shown.why : diff === null ? 'long' : null
      // a Write over a file that is there replaces it: said so; not known → answered in the terminal
      let overwrite = false
      if (!why && tool === 'Write') {
        const there = fileThere(body.tool_input.file_path, cwd, fs)
        if (there === 'file') overwrite = true
        else if (there !== 'none') why = 'unsure'
      }
      const cut = why !== null
      // (a call outside the sandbox gets no 항상 허용: the rule could not say so, and would let the next one run outside
      // it unasked too; the real-session trial showed Claude passing the flag when asked to)
      const rules = cut || shown.sandboxOff ? [] : alwaysRules(tool, body.permission_suggestions)
      const card = {
        key: cut ? `ask:${holdId}` : holdId, holdId: cut ? null : holdId, kind: 'permission',
        toolId: t.calls.get(key) ?? null, agent: typeof body.agent_id === 'string', tool, input: shown.input,
        ...(shown.args ? { args: shown.args } : {}), ...(diff ? { diff: overwrite ? { ...diff, kind: 'write' } : diff } : {}), ...(shown.replaceAll ? { replaceAll: true } : {}),
        ...(shown.cwd ? { cwd: shown.cwd } : {}), ...(shown.sandboxOff ? { sandboxOff: true } : {}), ...(shown.background ? { background: true } : {}),
        ...(shown.timeoutMs ? { timeoutMs: shown.timeoutMs } : {}), ...(shown.fetchPrompt ? { fetchPrompt: shown.fetchPrompt } : {}),
        ...(overwrite ? { overwrite: true } : {}),
        always: rules.length ? { rule: ruleLabel(rules) } : null,
        state: cut ? 'terminal' : 'open', since: at, ...(cut ? { cut: true, cutWhy: why } : {}),
      }
      addCard(t, card, key)
      return sendHold(cut ? { t: 'hold-pass', holdId, why: why === 'long' ? 'too-long' : why } : { t: 'hold-bind', holdId, id: t.id, kind: 'permission', key, data: { rules } })
    }
    // the AskUserQuestion route (a PreToolUse body)
    if (tool !== 'AskUserQuestion' || !key) return sendHold({ t: 'hold-pass', holdId, why: 'shape' })
    const q = questionCard(body.tool_input)
    const toolId = typeof body.tool_use_id === 'string' ? body.tool_use_id : (t.calls.get(key) ?? null)
    // (a sub-agent's question: shown, answered in the terminal)
    const answerable = q.answerable && typeof body.agent_id !== 'string'
    if (q.question) {
      addCard(t, { key: answerable ? holdId : `ask:${holdId}`, holdId: answerable ? holdId : null, kind: 'question', toolId, agent: typeof body.agent_id === 'string', tool, input: {}, always: null, question: q.question, ...(q.questions.length > 1 || q.questions[0]?.multiSelect ? { questions: q.questions } : {}), state: answerable ? 'open' : 'terminal', since: at }, key)
    }
    if (!answerable) return sendHold({ t: 'hold-pass', holdId, why: 'shape' })
    // (the whole input: the answer keeps every field of it, review M10)
    return sendHold({ t: 'hold-bind', holdId, id: t.id, kind: 'question', key, data: { questions: body.tool_input.questions, labels: q.labels, sets: q.sets, input: body.tool_input } })
  }

  /** Main's word on a hold (Phase 4): the card's state, nothing else */
  function holdState(holdId, state, choice) {
    if (typeof holdId !== 'string' || !holdId) return
    for (const t of terms.values()) {
      for (const [k, a] of t.asks) {
        if (a.card.holdId !== holdId) continue
        const next = { ...a.card }
        delete next.sent
        if (state === 'sent') { next.state = 'sent'; if (['allow', 'always', 'deny', 'option'].includes(choice)) next.sent = choice }
        else if (state === 'timeout') next.state = 'timeout'
        else next.state = 'terminal'
        t.asks.set(k, { ...a, card: next })
        syncAsks(t)
        flush(t)
        return
      }
    }
  }

  // ---- hooks ---------------------------------------------------------------

  function mapHook(sessionId) {
    const list = [...terms.values()]
    const current = new Map(list.map(t => [t.id, t.current]))
    return terminalFor(sessionId, list, current, (id) => {
      const v = readLink(id)
      const t = terms.get(id)
      if (t && v && v !== t.current && !list.some(o => o !== t && o.current === v)) t.current = v
      return v
    }, (clash) => {
      for (const c of clash) { setBanner(c, 'mapping'); flush(c) }
    })
  }

  const rowsOn = (t) => t.open && t.loaded

  function upsertRow(t, item, ops) {
    t.items.set(item.id, item)
    ops.push(upsertOp([item]))
  }

  function onPre(t, body, at, ops) {
    const name = body.tool_name
    const id = body.tool_use_id
    if (typeof name === 'string' && 'tool_input' in body) {
      try { if (typeof id === 'string') t.calls.set(callKey(name, body.tool_input), id) } catch {}
    }
    if (!rowsOn(t) || typeof id !== 'string' || typeof name !== 'string') return
    const waiting = name === 'AskUserQuestion' ? 'question' : name === 'ExitPlanMode' ? 'plan' : undefined
    const prev = t.items.get(id)
    if (prev) {
      if (waiting && prev.kind === 'tool' && prev.state === 'running' && prev.waiting !== waiting) upsertRow(t, { ...prev, waiting }, ops)
      return
    }
    const item = { id, order: LIVE_BASE + (++t.liveSeq), at, kind: 'tool', tool: name, input: toolInput(name, body.tool_input, t.cwd), state: 'running' }
    if (waiting) item.waiting = waiting
    upsertRow(t, item, ops)
  }

  function onPermission(t, body, at, ops) {
    setState(t, 'waiting', at)
    // the main thread's own wait (paired with its row or not): no sub-agent is blamed for it
    delete t.status.waitingAgent
    if (typeof body.tool_name !== 'string') return
    let id
    try { id = t.calls.get(callKey(body.tool_name, body.tool_input)) } catch {}
    const item = id && rowsOn(t) ? t.items.get(id) : null
    // (Claude Code asks a PermissionRequest for AskUserQuestion and ExitPlanMode too: their rows stay a question and a
    // plan, never a permission — the owner's log said "permission: AskUserQuestion")
    const waiting = body.tool_name === 'AskUserQuestion' ? 'question' : body.tool_name === 'ExitPlanMode' ? 'plan' : 'permission'
    if (item && item.kind === 'tool' && item.state === 'running' && item.waiting !== waiting) upsertRow(t, { ...item, waiting }, ops)
  }

  /** PostToolUse ('done') / PostToolUseFailure ('failed', or 'interrupted' when it says so) */
  function onPost(t, body, at, ended, ops) {
    const id = body.tool_use_id
    if (typeof id !== 'string') return
    for (const [k, v] of t.calls) if (v === id) t.calls.delete(k)
    const item = rowsOn(t) ? t.items.get(id) : null
    if (item && item.kind === 'tool') {
      const next = { ...item }
      delete next.waiting
      if (item.state === 'running') next.state = ended
      if (typeof body.duration_ms === 'number' && Number.isFinite(body.duration_ms) && body.duration_ms >= 0) next.durationMs = body.duration_ms
      if (JSON.stringify(next) !== JSON.stringify(item)) upsertRow(t, next, ops)
    }
    const stillWaiting = rowsOn(t) && [...t.items.values()].some(i => i.kind === 'tool' && !!i.waiting && i.state === 'running' && i.order >= t.turnStart)
    if (t.status.state === 'waiting' && !stillWaiting) setState(t, 'working', at)
  }

  function onMessageDisplay(t, body, at, ops) {
    const mid = body.message_id
    const index = body.index
    if (typeof mid !== 'string' || !Number.isInteger(index) || index < 0 || typeof body.delta !== 'string') return
    // where each message's stream stands, also while no view shows it (a view opened, or read
    // again, in the middle of a message then starts at the batch it gets, not at an index 0 long gone)
    const streamed = t.streams.has(mid)
    if (!streamed && t.streams.size > 50) t.streams.delete(t.streams.keys().next().value)
    t.streams.set(mid, Math.max(t.streams.get(mid) ?? 0, index + 1))
    if (!rowsOn(t)) return
    let l = t.live.get(mid)
    if (!l) { l = { parts: new Map(), next: streamed ? index : 0, text: '' }; t.live.set(mid, l) }
    if (index < l.next || l.parts.has(index) || l.parts.size > 200) return
    l.parts.set(index, body.delta)
    let grew = false
    while (l.parts.has(l.next)) { l.text += l.parts.get(l.next); l.parts.delete(l.next); l.next++; grew = true }
    if (!grew || !l.text.trim()) return
    if (l.text.length > CAPS.text) l.text = l.text.slice(0, CAPS.text)
    // the transcript was faster (it rarely is): nothing provisional to show
    for (const i of t.items.values()) {
      if (i.kind === 'text' && !i.parent && i.order >= t.turnStart && i.order < LIVE_BASE && liveMatches(l.text, i.text)) { t.live.delete(mid); return }
    }
    upsertRow(t, { id: `live:${mid}`, order: LIVE_ORDER, at, kind: 'live', text: l.text }, ops)
  }

  /**
   * The prompt Claude Code just took, shown at once from its UserPromptSubmit (a terminal's own Enter too):
   * Claude Code writes the prompt's line only once every UserPromptSubmit hook is done, and another plugin's
   * can take 6–12 s (measured 2026-11-19: a 6 s hook beside spawn's held the line 6.4 s; the hook itself came
   * 0.13 s after Enter). Built as the record would build it (a command, a `!` command or a wake-up shows no
   * bubble), marked `pending: 'sent'`, ordered after what the turn has so far; its own line replaces it
   * (ingest), and it goes with the turn's other provisional rows (clearLive).
   */
  function showPrompt(t, body, at, ops) {
    if (!rowsOn(t) || typeof body.prompt !== 'string') return
    const raw = body.prompt
    // (a slash command opens a panel or runs locally: the record words it, never a bubble)
    if (/^\s*\/[A-Za-z]/.test(raw)) return
    let item = null
    try {
      const line = { type: 'user', uuid: '00000000-0000-4000-8000-000000000000', message: { role: 'user', content: raw } }
      item = createItemBuilder({ cwd: t.cwd }).line(line, 0).find(i => i.kind === 'user') ?? null
    } catch { item = null }
    if (!item || !item.text.trim()) return
    // the record was faster (it rarely is), or the newest line already says it (the same words twice: then
    // only no early bubble): nothing provisional to show
    let newest = null
    for (const i of t.items.values()) if (i.kind === 'user' && !i.parent && !i.pending && i.order < LIVE_BASE && (!newest || i.order > newest.order)) newest = i
    if (newest && samePrompt(item.text, newest.text)) return
    const images = (item.text.match(/\[Image #\d+\]/g) ?? []).length
    upsertRow(t, { ...item, id: `prompt:${body.prompt_id && typeof body.prompt_id === 'string' ? body.prompt_id.slice(0, 80) : ++t.liveSeq}`, order: LIVE_BASE + (++t.liveSeq), at, images: Math.max(item.images ?? 0, images), pending: 'sent' }, ops)
  }

  const EVENTS = {
    UserPromptSubmit(t, body, at, ops) {
      // a prompt typed while Claude works (queued, or taken in mid-turn) belongs to the turn in progress
      // (one a prompt opened and no Stop, failure, interrupt or turn end has closed yet): the message
      // streaming now, its stream positions, the open calls and the turn's start all stay
      // (2026-11-19, the owner's log: a question dismissed with Esc in the terminal, no view reading the record, then a
      // prompt typed there. A prompt can only be typed once no dialog holds the terminal: a wait with no card still
      // answerable here (no hold pending) is over, and the prompt opens a new turn)
      const dismissed = t.status.state === 'waiting' && ![...t.asks.values()].some(a => a.card.state === 'open' && a.card.holdId)
      const midTurn = t.turnOpen && (t.status.state === 'working' || t.status.state === 'waiting') && !dismissed && t.current === body.session_id
      // no question or plan dialog is open in the terminal: its prompt took a line (a hold still pending is main's)
      askingOff(t)
      // (cards the terminal decided — passed, timed out, answered — are over too: their dialog is gone)
      settle(t, a => a.card.state !== 'open', 'prompt')
      t.turnOpen = true
      setState(t, 'working', at)
      t.current = body.session_id
      if (typeof body.transcript_path === 'string') t.hookPath = body.transcript_path
      // a background sub-agent reporting back (its wake-up): it is done
      if (typeof body.prompt === 'string') agentReported(t, body.prompt)
      // (a long paste may come wrapped as the transcript records it: compared unwrapped)
      t.promptText = typeof body.prompt === 'string' ? unwrapPasted(body.prompt) : null
      // (nor is the turn's missing check armed again: a long tool call may keep the file still for minutes)
      if (midTurn) return
      // a new turn: whatever waited on the user in the last one is over
      settleAll(t, 'turn')
      t.turnStart = t.tail ? t.tail.state().endOffset : 0
      // a new turn: the last one's provisional text and open calls are over
      const gone = clearLive(t)
      if (gone.length) ops.push({ op: 'remove', ids: gone })
      t.calls.clear()
      t.streams.clear()
      // another conversation in this terminal (a /clear, a resume): the view moves to its file
      // (a view still waiting for its first file just looks for the new conversation's)
      const moving = (t.open || t.timers.close) && t.loaded && t.path && t.conv !== body.session_id
      if (moving) { t.turnStart = 0; t.running.clear(); switchConversation(t) }
      else showPrompt(t, body, at, ops)
      onPrompt(t, body, at)
      if (moving) t.prompt = { path: null, end: 0 }
    },
    PreToolUse(t, body, at, ops) {
      if (typeof body.agent_id === 'string') { onAgentTool(t, body, at, ops); return }
      if (t.status.state === 'idle') setState(t, 'working', at)
      onPre(t, body, at, ops)
      onToolHook(t, at)
    },
    PermissionRequest(t, body, at, ops) {
      // a sub-agent's: the page puts the wait on that sub-agent's Agent row (status.waitingAgent)
      if (typeof body.agent_id === 'string') {
        setState(t, 'waiting', at)
        if (AGENT_ID.test(body.agent_id)) t.status.waitingAgent = body.agent_id
        return
      }
      onPermission(t, body, at, ops)
    },
    PostToolUse(t, body, at, ops) {
      if (typeof body.agent_id === 'string') return
      agentCallOver(t, body)
      onPost(t, body, at, 'done', ops)
      onToolHook(t, at)
    },
    PostToolUseFailure(t, body, at, ops) {
      if (typeof body.agent_id === 'string') return
      agentCallOver(t, body)
      onPost(t, body, at, body.is_interrupt === true ? 'interrupted' : 'failed', ops)
      onToolHook(t, at)
    },
    MessageDisplay(t, body, at, ops) {
      // a sub-agent's text goes to its own file, never into the main conversation
      if (typeof body.agent_id === 'string') return
      if (t.status.state === 'idle') setState(t, 'working', at)
      onMessageDisplay(t, body, at, ops)
    },
    Stop(t, body, at, ops) { onTurnOver(t, at, ops); foregroundOver(t); onStop(t, body, at, 'Stop', ops) },
    // a failed turn (a usage limit): its message is an error, not an answer — no canary
    StopFailure(t, body, at, ops) { onTurnOver(t, at, ops); foregroundOver(t); onStop(t, body, at, 'StopFailure', ops) },
    // a /compact typed between turns is work too (the view says it is compacting); one inside a turn keeps the turn's state
    PreCompact(t, body, at) { t.status.label = 'compact'; if (t.status.state === 'idle') setState(t, 'working', at) },
    PostCompact(t) { t.status.label = null; if (!t.turnOpen && t.status.state === 'working') setState(t, 'idle') },
    SubagentStart(t, body, at, ops) { onSubagentStart(t, body, at, ops); agentStarted(t, body, at) },
    SubagentStop(t, body) { onSubagentStop(t, body) },
  }

  const watching = (t) => t.open && t.loaded

  /** A prompt: where the transcript stands now (to tell it grew); missing after 5 s without growth */
  function onPrompt(t) {
    t.prompt = { path: t.path, end: t.tail ? t.tail.state().endOffset : 0 }
    // a late check of the last turn ends here: this turn's own check decides
    if (t.canary?.late) clearCanary(t)
    t.stall = null
    stopTimer(t, 'missing')
    if (!watching(t)) return
    t.timers.missing = timers.setTimeout(() => {
      t.timers.missing = null
      enqueue(t, async () => {
        if (!watching(t)) return
        if (t.path) await readNew(t)
        if (!t.path || !grewSincePrompt(t)) { setBanner(t, 'missing'); flush(t) }
      })
    }, MISSING_MS)
  }

  /** Tool hooks while the transcript stands still: three of them over 30 s is a stall */
  function onToolHook(t) {
    if (!watching(t) || !t.path) return
    const at = now()
    if (!t.stall) t.stall = { since: at, count: 0 }
    t.stall.count++
    if (t.stall.count >= 3 && at - t.stall.since >= STALL_MS) setBanner(t, 'stalled')
  }

  /**
   * Stop: within 3 s the transcript must hold this turn's text matching the
   * last assistant message; a turn with tools only must at least have grown.
   * Otherwise the canary banner: what is shown may not be what happened.
   */
  function onStop(t, body, at, event, ops) {
    // no canary (a failed turn, or a view not being read): the turn's provisional text goes now
    if (event !== 'Stop' || !watching(t)) {
      const gone = clearLive(t)
      if (gone.length) ops.push({ op: 'remove', ids: gone })
      return
    }
    stopTimer(t, 'missing')
    const msg = typeof body.last_assistant_message === 'string' ? body.last_assistant_message : ''
    clearCanary(t)
    t.canary = { msg: msg.trim() ? msg : '', start: t.turnStart, fresh: [] }
    const settle = (passed) => {
      const upserts = new Map()
      const removes = new Set()
      if (passed) canaryPassed(t, upserts, removes)
      // (failed: the check stays, late, until the next prompt; the answer landing after all clears the banner,
      // as a 다시 읽기 would have shown it: the owner's session, 2026-11-17)
      else { t.canary.late = true; setBanner(t, 'canary'); clearLive(t, removes) }
      const out = []
      if (removes.size) out.push({ op: 'remove', ids: [...removes] })
      if (upserts.size) out.push(upsertOp(upserts.values()))
      return out
    }
    if (canaryHolds(t)) { ops.push(...settle(true)); return }
    t.timers.canary = timers.setTimeout(() => {
      t.timers.canary = null
      enqueue(t, async () => {
        if (!t.canary || t.canary.late) return
        if (t.path) await readNew(t)
        if (!t.canary || t.canary.late) return
        flush(t, settle(canaryHolds(t)))
      })
    }, CANARY_MS)
    // the answer lands 0.1–0.3 s after Stop (FINDINGS §1): read soon
    scheduleRead(t, READ_AFTER_HOOK_MS)
  }

  /** Stop / StopFailure: idle; no call is waiting any more (a row's permission wait is over too) */
  function onTurnOver(t, at, ops) {
    setState(t, 'idle', at)
    queueIdle(t)
    t.turnOpen = false
    t.calls.clear()
    settleAll(t, 'stop')
    if (!rowsOn(t)) return
    for (const i of [...t.items.values()]) {
      if (i.kind === 'tool' && i.waiting) {
        const next = { ...i }
        delete next.waiting
        upsertRow(t, next, ops)
      }
    }
  }

  const AGENT_ID = /^[A-Za-z0-9_-]{1,64}$/
  const AGENT_TOOLS = new Set(['Agent', 'Task'])

  /** SubagentStart: the one running Agent/Task row without a sub-agent gets it; with several, none does */
  function onSubagentStart(t, body, at, ops) {
    const agentId = body.agent_id
    if (typeof agentId !== 'string' || !AGENT_ID.test(agentId) || !rowsOn(t)) return
    if ([...t.items.values()].some(i => i.kind === 'tool' && i.agentId === agentId)) return
    const rows = [...t.items.values()].filter(i => i.kind === 'tool' && AGENT_TOOLS.has(i.tool) && i.state === 'running' && !i.agentId && !i.parent)
    if (rows.length === 1) upsertRow(t, { ...rows[0], agentId }, ops)
  }

  /** A sub-agent's tool call: counted on its Agent row (only one paired for certain) */
  function onAgentTool(t, body, at, ops) {
    const agentId = body.agent_id
    agentWorked(t, body, at)
    if (!rowsOn(t)) return
    const row = [...t.items.values()].find(i => i.kind === 'tool' && i.agentId === agentId && !i.parent)
    if (row) upsertRow(t, { ...row, agentTools: (row.agentTools ?? 0) + 1 }, ops)
    else t.unpairedAgentTools++
  }

  function onSubagentStop(t, body) {
    if (typeof body.agent_id === 'string') t.running.delete(body.agent_id)
    if (typeof body.agent_id === 'string' && AGENT_ID.test(body.agent_id) && typeof body.agent_transcript_path === 'string') {
      t.agentPaths.set(body.agent_id, body.agent_transcript_path)
    }
    // the sub-agent is done: its file is read on from where the change index stopped (outside the view's queue)
    const c = t.changes
    if (c && c.state !== 'scanning' && typeof body.agent_id === 'string' && c.index.agents().some(a => a.agentId === body.agent_id)) {
      scanAgent(t, c, body.agent_id).then(() => noteChanges(t, c), () => {})
    }
  }

  // ---- the sub-agents at work (status.agents: the chat's strip of 일하는 보조 에이전트) -----------
  //
  // From the hooks only: SubagentStart adds one (or, missed — the app started mid-run — its first tool call),
  // its tool calls move it on, and it goes with SubagentStop, its Agent call's end (a foreground one), a
  // background one's wake-up (<task-notification>'s task id), the turn's end (one known to be foreground),
  // another conversation, the session's end, or an hour without a call. Its .meta.json beside its transcript
  // (Claude Code 2.1.32x) says which Agent call it is (toolUseId), what it was asked (description) and whether
  // it runs in the background; it is read at most AGENT_META_TRIES times, only inside <Claude folder>/projects/.

  const AGENTS_MAX = 12
  const AGENT_QUIET_MS = 60 * 60_000
  const AGENT_META_BYTES = 64 * 1024
  const AGENT_META_TRIES = 3
  const TOOL_USE_ID = /^[A-Za-z0-9_-]{1,100}$/
  const short = (v, n) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, n) : undefined)
  /** the meta reads in flight (idle() waits for them too) */
  const metaReads = new Set()

  function agentStarted(t, body, at) {
    const agentId = body.agent_id
    // (agent_type "": the compaction summariser, the prompt-suggestion pass — no sub-agent anyone sent)
    if (typeof agentId !== 'string' || !AGENT_ID.test(agentId) || !short(body.agent_type, 80)) return
    if (!t.running.has(agentId)) addAgent(t, body, at)
  }

  function addAgent(t, body, at) {
    if (t.running.size >= AGENTS_MAX) return null
    const agentId = body.agent_id
    const row = [...t.items.values()].find(i => i.kind === 'tool' && i.agentId === agentId && !i.parent)
    const a = { id: agentId, since: at, lastAt: at, tools: 0, type: short(body.agent_type, 80), toolId: row?.id, metaTries: 0, meta: false, metaBusy: false }
    t.running.set(agentId, a)
    readAgentMeta(t, a, body)
    return a
  }

  /** A sub-agent's tool call (its PreToolUse): the strip's count and last tool */
  function agentWorked(t, body, at) {
    const agentId = body.agent_id
    if (!AGENT_ID.test(agentId) || !short(body.agent_type, 80)) return
    const a = t.running.get(agentId) ?? addAgent(t, body, at)
    if (!a) return
    a.tools++
    a.lastAt = at
    if (typeof body.tool_name === 'string') a.last = { tool: body.tool_name.slice(0, 80), input: toolInput(body.tool_name, body.tool_input, t.cwd) }
    if (!a.meta) readAgentMeta(t, a, body)
  }

  /** The main thread's Agent / Task call is over: a foreground sub-agent with it (a background one goes on) */
  function agentCallOver(t, body) {
    if (!AGENT_TOOLS.has(body.tool_name) || (isObj(body.tool_input) && body.tool_input.run_in_background === true)) return
    const r = isObj(body.tool_response) ? body.tool_response : null
    // (a background call's answer says it was launched: it goes on, known now to run in the background)
    if (r && (r.status === 'async_launched' || r.isAsync === true)) {
      for (const [k, a] of t.running) if ((a.toolId && a.toolId === body.tool_use_id) || r.agentId === k) a.background = true
      return
    }
    for (const [k, a] of t.running) if ((a.toolId && a.toolId === body.tool_use_id) || (r && r.agentId === k)) t.running.delete(k)
  }

  /** A wake-up: <task-notification> with the background sub-agent's id */
  function agentReported(t, prompt) {
    if (!prompt.trimStart().startsWith('<task-notification>')) return
    const m = /<task-id>\s*([^<\s]+)\s*<\/task-id>/.exec(prompt)
    if (m) t.running.delete(m[1])
  }

  /** The turn's end: the sub-agents known to run in the foreground are over with it */
  function foregroundOver(t) {
    for (const [k, a] of t.running) {
      const row = a.toolId ? t.items.get(a.toolId) : null
      const fore = a.background === false || (a.background === undefined && row?.kind === 'tool' && row.input?.background !== true)
      if (fore) t.running.delete(k)
    }
  }

  /** status.agents, oldest first (absent when none); an hour without a call lets one go */
  function syncAgents(t, at) {
    const quiet = at - AGENT_QUIET_MS
    for (const [k, a] of t.running) if (a.lastAt < quiet) t.running.delete(k)
    if (!t.running.size) { delete t.status.agents; return }
    t.status.agents = [...t.running.values()].sort((a, b) => a.since - b.since).map(a => {
      const out = { id: a.id, since: a.since, tools: a.tools }
      if (a.toolId) out.toolId = a.toolId
      if (a.type) out.type = a.type
      if (a.description) out.description = a.description
      if (a.background !== undefined) out.background = a.background
      if (a.last) out.last = a.last
      return out
    })
  }

  /** <transcript folder>/<conversation>/subagents/agent-<id>.meta.json: its Agent call, what it was asked, background or not */
  function readAgentMeta(t, a, body) {
    if (a.meta || a.metaTries >= AGENT_META_TRIES || a.metaBusy) return
    a.metaTries++
    a.metaBusy = true
    const bases = [body.transcript_path, t.path, t.hookPath].filter(p => typeof p === 'string' && p.endsWith('.jsonl'))
    const read = (async () => {
      for (const base of bases) {
        const file = path.join(path.dirname(base), path.basename(base, '.jsonl'), 'subagents', `agent-${a.id}.meta.json`)
        if (!await transcriptAllowed(file, claudeDir, fs, '.meta.json')) continue
        const st = await fs.promises.stat(file)
        if (st.size > AGENT_META_BYTES) return
        const m = JSON.parse(await fs.promises.readFile(file, 'utf8'))
        if (!isObj(m)) return
        a.meta = true
        if (typeof m.toolUseId === 'string' && TOOL_USE_ID.test(m.toolUseId)) a.toolId = m.toolUseId
        a.description = short(m.description, CAPS.field) ?? a.description
        a.type = short(m.agentType, 80) ?? a.type
        if (typeof m.requestShape === 'string') a.background = m.requestShape === 'background'
        return
      }
    })().catch(() => {}).finally(() => {
      metaReads.delete(read)
      a.metaBusy = false
      if (t.disposed || t.running.get(a.id) !== a || !a.meta) return
      const ops = []
      // its Agent row, when the view has it unpaired: paired now (its rows can be asked for)
      const row = a.toolId ? t.items.get(a.toolId) : null
      if (row && row.kind === 'tool' && !row.agentId && rowsOn(t) && ![...t.items.values()].some(i => i.kind === 'tool' && i.agentId === a.id)) upsertRow(t, { ...row, agentId: a.id }, ops)
      syncAgents(t, now())
      flush(t, ops)
    })
    metaReads.add(read)
  }

  function logOnce(t, key, msg, level = 'info') {
    if (t.logged.has(key)) return
    t.logged.add(key)
    log(level, msg)
  }

  const hookLogged = new Set()

  /**
   * A question (AskUserQuestion) or a plan to approve (ExitPlanMode) the main thread opened: its
   * dialog takes Enter and Esc, and it raises no PermissionRequest of its own. Open from its
   * PreToolUse to its PostToolUse (or the turn's end); main hears when the terminal has one open
   * or none (the composer never presses Enter or Esc into it; chatHost.cjs).
   */
  /** No question or plan open any more (`id`: only that call's): main hears it at once */
  function askingOff(t, id) {
    if (!t.asking || !t.asking.size) return
    if (id === undefined) t.asking.clear()
    else t.asking.delete(id)
    const on = t.asking.size > 0
    if (on !== !!t.askingOn) {
      t.askingOn = on
      try { askingSignal(t.id, on) } catch {}
    }
  }

  function noteAsking(t, event, body) {
    if (!t.asking) t.asking = new Set()
    const id = body.tool_use_id
    if (event === 'PreToolUse' && typeof body.agent_id !== 'string' && ASKING_TOOLS.has(body.tool_name) && typeof id === 'string') t.asking.add(id)
    else if ((event === 'PostToolUse' || event === 'PostToolUseFailure') && typeof id === 'string') t.asking.delete(id)
    else if (event === 'Stop' || event === 'StopFailure') t.asking.clear()
    const on = t.asking.size > 0
    if (on !== !!t.askingOn) {
      t.askingOn = on
      try { askingSignal(t.id, on) } catch {}
    }
  }

  /**
   * A chat hook, answered already — or, with `holdId` (Phase 4), held by main until the lens binds or
   * passes it: every way out of here that does not bind it passes it (no request waits on a doubt).
   * `urlId`: the terminal the hook's URL named.
   */
  function hook(event, body, at, holdId, urlId) {
    const held = typeof holdId === 'string' && holdId ? holdId : null
    let told = !held
    const pass = (why) => { if (!told) { told = true; sendHold({ t: 'hold-pass', holdId: held, why }) } }
    if (!isObj(body) || typeof body.session_id !== 'string' || !Object.hasOwn(EVENTS, event)) { pass('shape'); return }
    try {
      const t = mapHook(body.session_id)
      if (!t) { pass('unmapped'); return }
      const when = typeof at === 'number' && Number.isFinite(at) ? at : now()
      const ops = []
      // the permission mode the hooks report (the composer's control row): one of the known modes, else null
      if (typeof body.permission_mode === 'string') t.status.mode = PERMISSION_MODES.has(body.permission_mode) ? body.permission_mode : null
      // (the AskUserQuestion route's PreToolUse is the hold's only: its twin on the PreToolUse route makes the row)
      if (!(held && event === 'PreToolUse')) EVENTS[event](t, body, when, ops)
      if (event === 'UserPromptSubmit') {
        stopTimer(t, 'queueIdle')
        try { promptSignal(t.id) } catch {}
      }
      // what Claude Code did settles the cards of its call (a sub-agent's too: matched by its call key)
      if (event === 'PostToolUse' || event === 'PostToolUseFailure') {
        const key = typeof body.tool_name === 'string' ? keyOf(body.tool_name, body.tool_input) : null
        const useId = typeof body.tool_use_id === 'string' ? body.tool_use_id : null
        settle(t, a => (key !== null && a.callKey === key) || (useId !== null && a.card.toolId === useId), 'post')
      }
      if (held) { onHeld(t, event, body, when, held, urlId); told = true }
      noteAsking(t, event, body)
      syncAgents(t, when)
      flush(t, ops)
      scheduleRead(t, READ_AFTER_HOOK_MS)
    } catch (err) {
      pass('error')
      // a body of a shape nobody expected: dropped (the transcript still drives the view), logged once per event
      if (!hookLogged.has(event)) { hookLogged.add(event); log('error', `chat lens: a ${event} hook could not be read (${errWord(err)})`) }
    }
  }

  // ---- the page's requests -------------------------------------------------

  function setTerminals(list) {
    const seen = new Set()
    for (const x of Array.isArray(list) ? list : []) {
      if (!isObj(x) || typeof x.id !== 'string' || !x.id) continue
      seen.add(x.id)
      let t = terms.get(x.id)
      if (!t) { t = makeTerm(x); terms.set(x.id, t); continue }
      // the same id launched again (a tab reopened or resumed after it ended): a new session, a new view
      const relaunched = (!t.alive && x.status !== 'exited') || (typeof x.createdAt === 'number' && t.createdAt !== null && x.createdAt !== t.createdAt)
      if (relaunched) {
        settleAll(t, 'gone')
        const wasOpen = t.open
        dropView(t)
        stopTimer(t, 'close')
        // the old state is done: a load or read still in flight on it sends nothing and follows nothing
        disposeTerm(t)
        const fresh = makeTerm(x)
        fresh.rev = t.rev
        fresh.open = wasOpen
        terms.set(x.id, fresh)
        if (wasOpen) enqueue(fresh, () => load(fresh))
        continue
      }
      if (typeof x.createdAt === 'number' && t.createdAt === null) t.createdAt = x.createdAt
      if (typeof x.cwd === 'string') t.cwd = x.cwd
      t.armed = x.armed === true
      const alive = x.status !== 'exited'
      if (t.alive && !alive) { t.alive = false; t.status.state = 'ended'; t.status.since = null; t.running.clear(); delete t.status.agents; settleAll(t, 'gone'); flush(t) }
    }
    for (const [id, t] of terms) {
      if (seen.has(id)) continue
      settleAll(t, 'gone')
      dropView(t)
      stopTimer(t, 'close')
      disposeTerm(t)
      terms.delete(id)
    }
  }

  /** A terminal's state let go: closed, and every later step on it (a load, a read, a flush) does nothing */
  function disposeTerm(t) {
    t.open = false
    t.disposed = true
    for (const name of Object.keys(t.timers)) stopTimer(t, name)
    stopFollowing(t)
  }

  function open(id) {
    const t = terms.get(id)
    if (!t) return
    const reopened = !!t.timers.close
    stopTimer(t, 'close')
    t.open = true
    if (reopened && t.loaded) {
      // flipped back within a minute: the view as it was, then whatever was appended meanwhile
      flush(t, [{ op: 'reset', items: [...t.items.values()].sort(byOrder), status: statusOf(t) }])
      if (t.path) { startFollowing(t); enqueue(t, () => readNew(t)) } else startFinding(t)
      return
    }
    enqueue(t, () => load(t))
  }

  function close(id) {
    const t = terms.get(id)
    if (!t || !t.open) return
    t.open = false
    stopFollowing(t)
    stopTimer(t, 'close')
    t.timers.close = timers.setTimeout(() => { t.timers.close = null; if (!t.open) dropView(t) }, CLOSE_AFTER_MS)
  }

  function reload(id) {
    const t = terms.get(id)
    if (!t) return Promise.resolve({ ok: false })
    return enqueue(t, async () => {
      dropView(t)
      t.following = true
      // a fresh start: every doubt re-evaluated from what is read now
      t.status.banner = null
      t.status.note = versionNote
      t.status.version = version ?? null
      t.soft = []
      t.softCount = 0
      t.lineVersion = null
      t.prompt = null
      if (t.open) await load(t)
      else flush(t)
    }).then(() => ({ ok: true }))
  }

  /**
   * The page lost an update (a rev gap): the view as it is now, banners and all, with
   * nothing re-read or re-judged (다시 읽기 is `reload`). A view not open gets its status.
   */
  function resync(id) {
    const t = terms.get(id)
    if (!t) return Promise.resolve({ ok: false })
    return enqueue(t, async () => {
      if (t.open && t.loaded) flush(t, [{ op: 'reset', items: [...t.items.values()].sort(byOrder), status: statusOf(t) }])
      else if (!t.open) { t.sent = null; flush(t) }
      // (a view still loading sends its reset when the load ends)
    }).then(() => ({ ok: true }))
  }

  function older(id) {
    const t = terms.get(id)
    if (!t) return Promise.resolve({ ok: false, loaded: 0 })
    let loaded = 0
    return enqueue(t, async () => {
      if (!t.open || !t.tail || !t.loaded) return
      const r = await t.tail.readOlder({ want: TAIL_WANT, keep })
      const { upserts, removes } = ingest(t, r.lines, { live: false })
      loaded = upserts.size
      t.status.hasOlder = !r.atStart || t.status.hasOlder && removes.size > 0
      const ops = [upsertOp(upserts.values())]
      if (removes.size) ops.unshift({ op: 'remove', ids: [...removes] })
      flush(t, ops)
    }).then(() => ({ ok: true, loaded }))
  }

  function agent(id, toolId) {
    const t = terms.get(id)
    if (!t) return Promise.resolve({ ok: false })
    return enqueue(t, () => readAgent(t, toolId)).then((ok) => ({ ok: ok === true }))
  }
  /**
   * A sub-agent's own transcript, under its Agent row: SubagentStop's
   * agent_transcript_path when allowed, else <transcript folder>/<conversation>/
   * subagents/agent-<id>.jsonl when allowed. At most AGENT_ITEMS items, sent
   * as an upsert with `parent` set. No file: nothing sent, logged once.
   */
  async function readAgent(t, toolId) {
    if (!t.open || !t.loaded || !t.path) return false
    const row = t.items.get(toolId)
    const agentId = row && row.kind === 'tool' ? row.agentId : undefined
    if (typeof agentId !== 'string' || !AGENT_ID.test(agentId)) { logOnce(t, `agent:${toolId}`, 'chat lens: a sub-agent row without its agent id'); return false }
    let file = null
    for (const candidate of [t.agentPaths.get(agentId), path.join(path.dirname(t.path), t.conv ?? '', 'subagents', `agent-${agentId}.jsonl`)]) {
      if (candidate && await transcriptAllowed(candidate, claudeDir, fs)) { file = candidate; break }
    }
    if (!file) { logOnce(t, `agent-file:${agentId}`, 'chat lens: no transcript for a sub-agent'); return false }
    const r = await createTail(file, { fs: fs.promises }).readTail({ want: AGENT_ITEMS * 2, keep })
    const builder = createItemBuilder({ cwd: t.cwd, parent: toolId })
    const made = new Map()
    for (const { text, offset } of r.lines) {
      let obj
      try { obj = JSON.parse(text) } catch { continue }
      if (checkLine(obj)?.hard) continue
      for (const item of builder.line(obj, offset)) made.set(item.id, item)
    }
    const items = [...made.values()].sort(byOrder).slice(-AGENT_ITEMS)
    if (!t.open) return true
    for (const item of items) t.items.set(item.id, item)
    flush(t, [upsertOp(items)])
    return true
  }

  // ---- the change index (Phase 5): the whole conversation's file changes, counts and offsets only ----
  //
  // Made when a view loads its transcript. Its forward scan runs outside the view's queue (its own file
  // handle, its own loop, yielding every 2 MB), so hooks and reads never wait for it; the lines written
  // after the scan began come through ingest. The sub-agents' own files are read after the main scan,
  // again on SubagentStop and on each `changes` request, from where each stopped. status.changes is sent
  // at most every 500 ms. Dropped with the view, on 다시 읽기, on another conversation, on a rewrite.

  const CHANGES_MS = 500

  function startChanges(t, until) {
    dropChanges(t)
    if (!t.path) return
    const c = {
      index: createChangeIndex({ cwd: t.cwd }), path: t.path, conv: t.conv, cwd: t.cwd, until,
      state: 'scanning', failed: false, agentPartial: false, aborted: false, v: 1, last: now(), sent: null, agents: new Map(),
    }
    t.changes = c
    t.status.changes = summaryOf(c)
    c.sent = countsKey(t.status.changes)
    runScan(t, c)
  }

  function dropChanges(t) {
    if (t.changes) t.changes.aborted = true
    t.changes = null
    stopTimer(t, 'changes')
    delete t.status.changes
  }

  /** The transcript went: what was gathered stays, the summary says `gone` */
  function changesGone(t) {
    const c = t.changes
    if (!c) return
    c.state = 'gone'
    noteChanges(t, c)
  }

  function summaryOf(c) {
    const s = c.index.summary()
    const state = c.state === 'scanning' || c.state === 'gone' ? c.state
      : c.state === 'partial' || s.partial || c.agentPartial ? 'partial' : 'ready'
    // (the record gone: nothing it held is shown, no stale count — Phase 6 drill)
    if (state === 'gone') return { v: c.v, state, files: 0, edits: 0, added: 0, removed: 0, unknown: 0 }
    return { v: c.v, state, files: s.files, edits: s.edits, added: s.added, removed: s.removed, unknown: s.unknown }
  }
  /** The transcript the index was built from is gone (deleted while its view was open): the index says so */
  async function recordGone(t, c) {
    if (c.state === 'gone') return true
    try { await fs.promises.stat(c.path); return false } catch (err) {
      if (err?.code !== 'ENOENT') return false
      c.state = 'gone'
      noteChanges(t, c)
      return true
    }
  }
  const countsKey = (s) => JSON.stringify({ ...s, v: 0 })

  /** The index changed: status.changes with v + 1, at most every CHANGES_MS */
  function noteChanges(t, c) {
    if (t.changes !== c || t.disposed || t.timers.changes) return
    t.timers.changes = timers.setTimeout(() => {
      t.timers.changes = null
      if (t.changes !== c || t.disposed) return
      const next = summaryOf(c)
      const key = countsKey(next)
      if (key === c.sent) return
      c.v += 1
      c.sent = key
      c.last = now()
      t.status.changes = { ...next, v: c.v }
      flush(t)
    }, Math.max(0, c.last + CHANGES_MS - now()))
  }

  /** A line read live: into the index (idempotent by tool id) */
  function changeLine(t, obj, offset, text) {
    const c = t.changes
    try { if (c.index.line(obj, offset, 'main', hashOf(text))) noteChanges(t, c) } catch { /* a shape the index does not know: not counted */ }
  }

  async function runScan(t, c) {
    let partial = false
    try {
      const r = await scanChanges(c.path, c.index, { fs: fs.promises, until: c.until, maxBytes: CHANGE_CAPS.scanBytes, signal: c })
      if (r.aborted || c.aborted) return
      partial = r.partial
      if (r.partial) logOnce(t, 'changes:cap', 'chat changes: the scan stopped at a cap')
      await scanAgents(t, c)
    } catch (err) {
      if (c.aborted) return
      const code = errWord(err)
      if (code === 'ENOENT') c.state = 'gone'
      else { c.failed = true; logOnce(t, `changes:err:${code}`, `chat changes: a read failed (${code})`, 'error') }
    }
    if (c.aborted || t.changes !== c) return
    if (c.state === 'scanning') c.state = partial || c.failed ? 'partial' : 'ready'
    noteChanges(t, c)
  }

  /** Every sub-agent the conversation named (at most CHANGE_CAPS.agents), each read on from where it stopped */
  async function scanAgents(t, c) {
    for (const { agentId } of c.index.agents().slice(0, CHANGE_CAPS.agents)) {
      if (c.aborted) return
      await scanAgent(t, c, agentId)
    }
  }

  /** The sub-agents whose changes could not be read (no allowed file, a failed read, past the cap) */
  function unreadOf(c) {
    const all = c.index.agents()
    let n = Math.max(0, all.length - CHANGE_CAPS.agents)
    for (const { agentId } of all.slice(0, CHANGE_CAPS.agents)) if (c.agents.get(agentId)?.unread) n++
    return n
  }

  /**
   * One sub-agent's file (SubagentStop's path when allowed, else <transcript folder>/<conversation>/
   * subagents/agent-<id>.jsonl when allowed: only under <Claude folder>/projects/), read on from where
   * it stopped, at most CHANGE_CAPS.agentBytes. One read at a time per sub-agent.
   */
  function scanAgent(t, c, agentId) {
    let a = c.agents.get(agentId)
    if (!a) { a = { file: null, offset: 0, size: -1, unread: false, busy: null }; c.agents.set(agentId, a) }
    if (a.busy) return a.busy
    const p = (async () => {
      try {
        if (!a.file) {
          if (typeof agentId !== 'string' || !AGENT_ID.test(agentId)) { a.unread = true; return }
          for (const candidate of [t.agentPaths.get(agentId), path.join(path.dirname(c.path), c.conv ?? '', 'subagents', `agent-${agentId}.jsonl`)]) {
            if (candidate && await transcriptAllowed(candidate, claudeDir, fs)) { a.file = candidate; break }
          }
          if (!a.file) { a.unread = true; return }
        }
        // (asked again with nothing new: its size as when last read, so the file is not opened again)
        const size = (await fs.promises.stat(a.file)).size
        if (!a.unread && size === a.size) return
        const r = await scanChanges(a.file, c.index, { fs: fs.promises, from: a.offset, src: agentId, maxBytes: Math.max(0, CHANGE_CAPS.agentBytes - a.offset), signal: c })
        if (r.aborted) return
        a.size = size
        a.offset = r.end
        a.unread = false
        if (r.partial) c.agentPartial = true
      } catch {
        a.unread = true
      }
    })()
    a.busy = p
    p.then(() => { if (a.busy === p) a.busy = null })
    return p
  }

  const changeEdit = (e) => ({
    toolId: e.toolId, order: e.order, at: e.at, ...(e.agentId ? { agentId: e.agentId } : {}),
    kind: e.kind, added: e.added, removed: e.removed, state: e.state,
  })

  /** chat:changes — the summary, the files (most recent first), the sub-agents not read */
  async function changes(id) {
    const t = terms.get(id)
    const c = t?.changes
    if (!t || !c) {
      // a view with no transcript yet (a new session): nothing changed so far
      if (t && t.open && t.loaded && !t.path) return { ok: true, summary: { v: 0, state: 'ready', files: 0, edits: 0, added: 0, removed: 0, unknown: 0 }, files: [], agentsUnread: 0 }
      return { ok: false }
    }
    if (await recordGone(t, c)) return t.changes === c ? { ok: true, summary: summaryOf(c), files: [], agentsUnread: 0 } : { ok: false }
    // (while the main scan runs, it reads the sub-agents itself when it ends)
    if (c.state !== 'scanning') {
      await scanAgents(t, c)
      if (t.changes !== c) return { ok: false }
      noteChanges(t, c)
    }
    return { ok: true, summary: summaryOf(c), files: c.index.files(), agentsUnread: unreadOf(c) }
  }

  /**
   * chat:change-file — the file's newest CHANGE_CAPS.bodyEdits edits (or those before `before`), newest
   * last, each read again from its line (readEdit: its tool id, its digest, buildDiff) while the diffs'
   * lines stay within CHANGE_CAPS.bodyLines (older ones come without a diff), and `more` older ones. The
   * tailer's guard first: a transcript that changed makes every edit stale and the view says `rewrite`.
   */
  async function changeFile(id, file, before) {
    const t = terms.get(id)
    const c = t?.changes
    if (!t || !c || !t.tail) return { ok: false, reason: 'gone' }
    if (await recordGone(t, c)) return { ok: false, reason: 'gone' }
    const got = c.index.editsOf(typeof file === 'string' ? file.slice(0, 4096) : '', typeof before === 'number' && Number.isFinite(before) ? before : undefined)
    if (!got) return { ok: false, reason: 'unknown' }
    const edits = got.edits.map(changeEdit)
    let intact = false
    try { intact = await t.tail.verify() } catch { intact = false }
    if (t.changes !== c) return { ok: false, reason: 'gone' }
    if (!intact) {
      for (const e of edits) e.state = 'stale'
      onRewritten(t)
      return { ok: true, file: got.file, edits, more: got.more }
    }
    let budget = CHANGE_CAPS.bodyLines
    let rewritten = false
    for (let i = got.edits.length - 1; i >= 0; i--) {
      const ref = got.edits[i]
      if (ref.state === 'missing') continue
      const p = ref.src.file === 'main' ? c.path : c.agents.get(ref.src.file)?.file
      const r = p ? await readEdit(p, ref, { fs: fs.promises, cwd: c.cwd }) : { state: 'stale' }
      if (t.changes !== c) return { ok: false, reason: 'gone' }
      if (r.state !== 'ok') {
        edits[i].state = 'stale'
        // (the main transcript is append-only: a line that is not what was indexed is a rewrite)
        if (ref.src.file === 'main') rewritten = true
        continue
      }
      const lines = r.diff.hunks.reduce((n, h) => n + h.lines.length, 0)
      if (lines > budget) break
      budget -= lines
      edits[i].diff = r.diff
    }
    if (rewritten) onRewritten(t)
    return { ok: true, file: got.file, edits, more: got.more }
  }

  /**
   * chat:full (2026-11-17) — one item of the view read again whole from its transcript line (src/chat… "전체 보기"
   * in place of "see the terminal"), only while the transcript is the one the items came from (the tailer's guard)
   */
  async function full(id, itemId) {
    const t = terms.get(id)
    if (!t || !t.path || !t.tail || typeof itemId !== 'string') return { ok: false, reason: 'gone' }
    const item = t.items.get(itemId)
    if (!item) return { ok: false, reason: 'unknown' }
    let intact = false
    try { intact = await t.tail.verify() } catch { intact = false }
    if (!intact) return { ok: false, reason: 'gone' }
    return readFull(fs.promises, t.path, item)
  }

  /** Every queued read finished (tests; an orderly stop) */
  async function idle() {
    for (let i = 0; i < 20; i++) {
      const qs = [...terms.values()].map(t => t.queue)
      const metas = [...metaReads]
      await Promise.all([...qs, ...metas])
      if ([...terms.values()].every((t, j) => t.queue === qs[j]) && metaReads.size === 0) return
    }
  }

  function dispose() {
    for (const t of terms.values()) { dropView(t); stopTimer(t, 'close'); disposeTerm(t) }
    terms.clear()
  }

  /**
   * How much a terminal's state holds now (counts only, nothing of the conversation): the long-session soak test
   * checks that every map stays bounded (tests/chat-soak.test.ts). Null for a terminal the lens does not know.
   */
  function sizes(id) {
    const t = terms.get(id)
    if (!t) return null
    const c = t.changes && t.changes.index ? t.changes.index.summary() : null
    return {
      items: t.items.size, calls: t.calls.size, live: t.live.size, streams: t.streams.size, logged: t.logged.size,
      asks: t.asks.size, agentPaths: t.agentPaths.size, queued: t.queued.length, soft: t.soft.length,
      changeFiles: c ? c.files : 0, changeEdits: c ? c.edits : 0,
    }
  }

  /**
   * The binary's version changed while the lens runs (Claude Code updated itself; chatHost.cjs apply): the open views'
   * quiet note follows it — on for a version newer than the verified range, off when back in range unless a transcript
   * line itself is newer. Nothing else changes here (the host has already armed or released what the version allows).
   */
  function setVersion(v) {
    version = typeof v === 'string' ? v.slice(0, 80) : null
    versionNote = versionVerdict(version) === 'new' ? 'new-version' : null
    for (const t of terms.values()) {
      if (t.disposed) continue
      const lineNew = t.lineVersion && versionVerdict(t.lineVersion) === 'new'
      t.status.note = lineNew ? 'new-version' : versionNote
      if (!t.lineVersion) t.status.version = version
      flush(t)
    }
  }

  /**
   * Whether `url` is written in a finished answer of the main thread in terminal `id`'s open view (the final review's
   * M2: a link preview is fetched only for a link Claude wrote in the view that asks, whatever the page says). Never a
   * user's message, a tool's output, a sub-agent's text, an interrupted answer or the live bubble.
   */
  function linkInView(id, url) {
    const t = typeof id === 'string' ? terms.get(id) : null
    if (!t || t.disposed || !t.open || typeof url !== 'string' || !url) return false
    for (const i of t.items.values()) {
      if (i.kind === 'text' && !i.parent && !i.partial && i.order < LIVE_BASE && typeof i.text === 'string' && i.text.includes(url)) return true
    }
    return false
  }

  return { setTerminals, hook, holdState, open, close, older, reload, resync, agent, changes, changeFile, full, idle, dispose, sizes, setVersion, linkInView }
}

module.exports = { createLens, conversationOf, terminalFor, transcriptAllowed, findTranscript, liveMatches, LIVE_BASE, LIVE_ORDER }
