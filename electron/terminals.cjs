'use strict'

/**
 * terminals.cjs — the AI coding sessions that live inside the app.
 *
 * Every terminal is a real pseudo-console (node-pty / ConPTY) running one
 * tool's adapter (adapters.cjs). Claude Code runs as
 * `claude --session-id <uuid>`, so the session id is known before Claude even
 * starts and the server can tie the terminal, the session and its Pokémon
 * together. spawn's hooks are attached to these sessions only, through
 * `--settings` (a generated file) — ~/.claude/settings.json is never touched.
 * Another tool (설정 › 세션 › AI 도구) reports nothing itself: its output is
 * turned into the same server events here (adapters.createActivity).
 *
 * Input reaches a terminal from two places, both inside the app over IPC: the
 * keyboard in the terminal tab, and an instruction sent from the widget. No
 * HTTP route can write to a terminal.
 */

const path = require('path')
const fs = require('fs')
const os = require('os')
const crypto = require('crypto')
const { adapterFor, createActivity } = require('./adapters.cjs')
const { createCodexWatch } = require('./codexWatch.cjs')
const { OTHER_TOOLS } = require('./features.cjs')

const MAX_BUFFER = 200_000 // characters of scrollback kept for a tab opened later
const OUTPUT_BATCH_MS = 16 // a session's output goes to the window at most once a frame
const REDRAW_RESTORE_MS = 150 // the chat's redraw nudge: its real size again this long after the one-row step

function loadPty() {
  // Loaded lazily: a missing native module must not stop the app window
  return require('node-pty')
}

/**
 * End a session's whole process tree at once (Claude Code and whatever it
 * started); resolves when taskkill is done. node-pty's own kill finds the
 * console's processes later, in a forked helper. Off Windows a session's pty
 * is a process group leader, so the whole group gets SIGKILL (the process
 * alone when there is no such group). `spawn` runs taskkill (execFile's shape).
 */
function killTreeNow(pid, { platform = process.platform, kill = (p, sig) => process.kill(p, sig), spawn = require('child_process').execFile } = {}) {
  return new Promise((resolve) => {
    if (!Number.isInteger(pid) || pid <= 0) return resolve()
    if (platform !== 'win32') {
      try { kill(-pid, 'SIGKILL') } catch {
        try { kill(pid, 'SIGKILL') } catch { /* the process is gone already */ }
      }
      return resolve()
    }
    try {
      spawn('taskkill', ['/T', '/F', '/PID', String(pid)], { windowsHide: true }, () => resolve())
    } catch { resolve() /* the process is gone already */ }
  })
}

/**
 * The Claude Code events the hook forwards (hooks/spawn-hook.cjs). No
 * matchers: every tool call is a step for the session's Pokémon, and the
 * other events either have no matcher support or are wanted every time.
 */
const HOOK_EVENTS = [
  'PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'SubagentStop', 'SessionStart', 'SessionEnd',
  'UserPromptSubmit', 'Stop', 'PermissionRequest', 'Notification', 'StopFailure', 'PreCompact',
  'PostCompact', 'PostToolBatch', 'CwdChanged', 'PostModelSwitch',
]

/**
 * Hooks Claude Code runs in the background instead of waiting for (`async`):
 * the tool-call ones, two or three per tool call, each starting the app in
 * Node mode (~0.2 s). They only report; the server tells a late one by the
 * time it carries (`at`). The ones that change what the session is doing
 * (a prompt, the turn's end, a permission, start and end) stay in order.
 */
const ASYNC_HOOKS = new Set(['PreToolUse', 'PostToolUse', 'PostToolBatch'])

/**
 * A command that runs one of hooks/*.cjs with this very app in Node mode
 * (ELECTRON_RUN_AS_NODE), so a session needs nothing installed besides
 * Claude Code: no Python, no curl. Claude Code runs hook commands in its
 * shell (Git Bash on Windows), hence the POSIX form and forward slashes.
 */
function nodeCommand(runtime, script) {
  const slash = (p) => p.split(path.sep).join('/')
  return `ELECTRON_RUN_AS_NODE=1 "${slash(runtime)}" "${slash(script)}"`
}

/**
 * The session settings file's text: the hooks + status line for app sessions.
 * `chat` (chatHooks.cjs chatHookEntries, the chat view switched on): each
 * chat entry is its own matcher group appended after the game's (an event
 * the game does not use, like MessageDisplay, gets the chat group alone, after
 * the game's events). With `chat` null the text is release 1.4.0's, byte for
 * byte (tests/terminals.test.ts pins it).
 */
function sessionSettingsJson(repoRoot, runtime = process.execPath, chat = null) {
  const hook = nodeCommand(runtime, path.join(repoRoot, 'hooks', 'spawn-hook.cjs'))
  const hooks = Object.fromEntries(HOOK_EVENTS.map(e => [e, [{ hooks: [{ type: 'command', command: hook, ...(ASYNC_HOOKS.has(e) ? { async: true } : {}) }] }]]))
  if (chat) {
    // (a chat value is one group, or a list of groups: Phase 4's matcher group for AskUserQuestion)
    for (const [event, group] of Object.entries(chat)) hooks[event] = [...(hooks[event] ?? []), ...[].concat(group)]
  }
  const settings = {
    hooks,
    statusLine: { type: 'command', command: nodeCommand(runtime, path.join(repoRoot, 'hooks', 'status-line.cjs')) },
  }
  return JSON.stringify(settings, null, 2)
}

/** The session settings file, written to userData (once per start, and again when the chat hooks change) */
function writeSessionSettings(repoRoot, dir, runtime = process.execPath, chat = null) {
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, 'session-settings.json')
  fs.writeFileSync(file, sessionSettingsJson(repoRoot, runtime, chat))
  return file
}

/**
 * The environment for a new session, without another Claude Code's markers:
 * an app started from inside a Claude Code session would otherwise make every
 * session it opens a "child" of that one (no transcript, no hooks).
 * Claude Code also sets NO_COLOR=1 for the commands it runs; inherited, it
 * turns off every colour and background in the app's sessions, so it goes
 * too when the app was started from inside Claude Code (a NO_COLOR the user
 * set themselves, with no Claude Code around, is kept).
 */
function cleanEnv(env) {
  const out = {}
  const fromClaude = 'CLAUDECODE' in env
  for (const [k, v] of Object.entries(env)) {
    if (k === 'CLAUDECODE' || k === 'CLAUDE_PID' || k.startsWith('CLAUDE_CODE_')) continue
    // another app terminal's identity (the app started from inside one of its own sessions)
    if (k === 'SPAWN_SESSION_ID' || k === 'SPAWN_LINK_FILE' || k === 'CLAUDEX_SESSION_ID' || k === 'CLAUDEX_LINK_FILE') continue
    if (fromClaude && k === 'NO_COLOR') continue
    out[k] = v
  }
  return out
}

/**
 * A session asking the user something it cannot go on without (each adapter's
 * `asking` pattern: for Claude Code the folder-trust question at start, a
 * permission prompt, any numbered choice) is read from the terminal's own
 * output (the trust question comes before any hook runs), escape codes out.
 */
const ANSI = /\x1b\[[0-9;?]*[ -\/]*[@-~]|\x1b\][^\x07\x1b]*(\x07|\x1b\\)|\x1b[()][A-Za-z0-9]|\x1b[=>78]/g
function plainText(data) { return String(data).replace(ANSI, ' ') }

/**
 * Whether keys written to a session answer a question on its screen (the chat's ledger only, terminals.write): Enter,
 * a lone Esc, or any typed character. Not the arrows and Tab that move between its choices, nor what the terminal
 * writes back by itself (focus and position reports, a device or version answer).
 */
function answersQuestion(data) {
  if (data === '\x1b') return true
  const rest = String(data).replace(/\x1b(?:\[[\d;<=>?]*[ -\/]*[@-~]|O[@-~]|[P\]^_][\s\S]*?(?:\x07|\x1b\\)|[\s\S])?/g, '').replace(/\t/g, '')
  return rest.length > 0
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** open-sessions.json, checked: [{ sessionId, cwd, tool }] with real ids and folders that still exist (tool 'claude' when an older file has none) */
function readOpenSessions(file) {
  let raw
  try { raw = JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return [] }
  if (!Array.isArray(raw)) return []
  const seen = new Set()
  return raw.filter(s => s && typeof s.sessionId === 'string' && UUID.test(s.sessionId) && typeof s.cwd === 'string'
    && !seen.has(s.sessionId) && seen.add(s.sessionId) && fs.existsSync(s.cwd)).slice(0, 12)
    .map(s => ({ sessionId: s.sessionId, cwd: s.cwd, tool: typeof s.tool === 'string' && /^[a-z0-9-]{1,24}$/.test(s.tool) ? s.tool : 'claude' }))
}

/** Claude Code keeps a session's transcript at ~/.claude/projects/<project>/<id>.jsonl */
function hasTranscript(sessionId, claudeDir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude')) {
  let projects = []
  try { projects = fs.readdirSync(path.join(claudeDir, 'projects')) } catch { return false }
  return projects.some(p => fs.existsSync(path.join(claudeDir, 'projects', p, `${sessionId}.jsonl`)))
}

/**
 * The git branch of the repository `dir` is in (walking up to its .git), the
 * short commit when HEAD is detached, else null. Reads files only: no git run.
 * A worktree's or submodule's `.git` file points at its real git dir.
 */
function gitBranch(dir) {
  let at = path.resolve(String(dir || ''))
  for (let i = 0; i < 40 && at; i++) {
    const dotGit = path.join(at, '.git')
    try {
      let gitDir = dotGit
      if (fs.statSync(dotGit).isFile()) {
        const m = fs.readFileSync(dotGit, 'utf8').match(/^gitdir:\s*(.+)$/m)
        if (!m) return null
        gitDir = path.resolve(at, m[1].trim())
      }
      const head = fs.readFileSync(path.join(gitDir, 'HEAD'), 'utf8').trim()
      const ref = head.match(/^ref:\s*refs\/heads\/(.+)$/)
      if (ref) return ref[1]
      return /^[0-9a-f]{40}$/i.test(head) ? head.slice(0, 7) : null
    } catch { /* no .git here: one folder up */ }
    const up = path.dirname(at)
    if (up === at) break
    at = up
  }
  return null
}

/**
 * The conversation an app terminal last had (its hook writes it at every
 * SessionStart; /clear starts another one in the same terminal): what reopening
 * the terminal resumes. Else '' (never cleared, or an older session).
 */
function linkFile(userDataDir, sessionId) { return path.join(userDataDir, 'session-links', sessionId) }
function linkedConversation(userDataDir, sessionId) {
  try {
    const id = fs.readFileSync(linkFile(userDataDir, sessionId), 'utf8').trim()
    return UUID.test(id) ? id : ''
  } catch { return '' }
}

/**
 * `tools()`: the trainer's other AI tools (설정 › 세션). `emit(event)`: a server
 * event for a session whose tool has no hooks (main posts it to /event).
 * `otherTools` (features.cjs): off, every session is Claude Code or the shell.
 * `chat.state()` (chatHost.cjs, the chat view): `{ on: false }`, or `{ on:
 * true, hooks, reason?, version? }` — `hooks` are the chat entries for the
 * session settings file (null while starting or for a Claude Code version not
 * checked), or a function of a terminal's id giving them (each session's own file).
 * `chat.onInput` hears input to an armed session while the chat is on; `chat.busy(id)`
 * says a chat send is between its text and its Enter there (the side box then waits).
 * Off, nothing changes: no chat entries, no `chat` key on a terminal.
 */
function createTerminalManager({ repoRoot, userDataDir, send, onExit, defaultCwd, extraArgs = () => [], titles = { get: () => null, set: () => {} }, tools = () => [], emit = () => {}, postStatus = () => {}, pty: ptyModule = null, killTree = killTreeNow, codexWatch = createCodexWatch, exitGraceMs = 5000, otherTools = OTHER_TOOLS, chat = { state: () => ({ on: false }) } }) {
  const terms = new Map() // id -> { id, sessionId, cwd, pty, buffer, status, createdAt, exitCode }
  let settingsFile = null
  // The sessions open when the app last closed (open-sessions.json): what the
  // next start may reopen. Read once at start, before this run writes over it.
  const openFile = path.join(userDataDir, 'open-sessions.json')
  let restorable = readOpenSessions(openFile)
  // Other tools switched off: their tabs (Codex…) are not reopened, as Claude or otherwise, but stay
  // in the list this run writes, so they come back when the switch is flipped on again
  const held = otherTools ? [] : restorable.filter(s => s.tool !== 'claude' && s.tool !== 'shell')
  if (held.length) restorable = restorable.filter(s => !held.includes(s))
  const toolList = () => (otherTools ? tools() : [])
  let frozen = false // quitting: the sessions killed on the way out stay listed

  try { fs.mkdirSync(path.join(userDataDir, 'session-links'), { recursive: true }) } catch {}

  // The chat view's variants of the file: one per set of chat hooks (one endpoint, one token), by name
  const chatFiles = new Map()
  const chatState = () => { try { return chat.state() ?? { on: false } } catch { return { on: false } } }

  /** The 1.4.0 file: session-settings.json, written once per start exactly as release 1.4.0 writes it */
  function plainSettings() {
    if (!settingsFile) settingsFile = writeSessionSettings(repoRoot, userDataDir)
    return settingsFile
  }

  let chatWriteLogged = false
  /**
   * The settings file a Claude Code session is launched with, and whether it holds the chat
   * hooks (`armed`). Without chat hooks it is the 1.4.0 file. With them it is a file of its own
   * (session-settings-chat-<hash>.json), written once, through a temporary file and a rename. No
   * file a session was launched with is ever written again. When that file cannot be written
   * (a full or read-only folder, a rename refused while something holds the temporary file), the
   * session still opens, with the 1.4.0 file and unarmed: a chat file never keeps a session shut.
   */
  function settings(state = chatState(), id = null) {
    // (the chat entries name the terminal a hook is about: a function of its id gives them)
    let hooks = state.on ? state.hooks ?? null : null
    if (typeof hooks === 'function') { try { hooks = id ? hooks(id) : null } catch { hooks = null } }
    if (!hooks) return { file: plainSettings(), armed: false }
    const text = sessionSettingsJson(repoRoot, process.execPath, hooks)
    const name = `session-settings-chat-${crypto.createHash('sha1').update(text).digest('hex').slice(0, 12)}.json`
    if (!chatFiles.has(name)) {
      // the first of this run: what an earlier run left goes (none of its sessions is alive now)
      if (!chatFiles.size) {
        try { for (const n of fs.readdirSync(userDataDir)) if (/^session-settings-chat-[0-9a-f]{12}\.json(\.\d+\.tmp)?$/.test(n) && n !== name) fs.rmSync(path.join(userDataDir, n), { force: true }) } catch {}
      }
      const file = path.join(userDataDir, name)
      try {
        if (!fs.existsSync(file) || fs.readFileSync(file, 'utf8') !== text) {
          const tmp = `${file}.${process.pid}.tmp`
          fs.writeFileSync(tmp, text)
          // (Windows: a virus scanner or the indexer may hold the new file a moment: two more tries)
          for (let k = 0; ; k++) {
            try { fs.renameSync(tmp, file); break } catch (err) {
              if (k >= 2 || (err?.code !== 'EPERM' && err?.code !== 'EBUSY' && err?.code !== 'EACCES')) {
                try { fs.rmSync(tmp, { force: true }) } catch {}
                throw err
              }
            }
          }
        }
      } catch (err) {
        // once a run, with the error's code only (never a path)
        if (!chatWriteLogged) { chatWriteLogged = true; console.log(`[terminals] the chat view's settings file could not be written (${typeof err?.code === 'string' ? err.code : 'error'}): sessions open without the chat view`) }
        return { file: plainSettings(), armed: false }
      }
      chatFiles.set(name, file)
    }
    return { file: chatFiles.get(name), armed: true }
  }

  function info(t) {
    const out = {
      id: t.id, sessionId: t.sessionId, cwd: t.cwd, project: path.basename(t.cwd),
      status: t.status, createdAt: t.createdAt, exitCode: t.exitCode ?? null,
      asking: !!t.asking,
      tool: t.adapter.id, toolName: t.adapter.name, canResume: t.adapter.canResume,
      title: titles.get(t.sessionId) ?? null,
    }
    // The chat view (on only): whether this Claude Code session was launched with the chat hooks
    const state = chatState()
    if (state.on && t.adapter.id === 'claude') out.chat = t.chatArmed ? 'armed' : (state.reason ?? 'unarmed')
    return out
  }

  /**
   * The chat view was switched on or off: sessions opened from now on get the other file (no file
   * is written here, none a session runs with is touched), and the page hears the new `chat` values.
   */
  function refreshSettings() {
    send('terminals:list', list())
  }

  /** Running sessions launched with the chat hooks (the endpoint must keep answering them) */
  function armedCount() {
    return [...terms.values()].filter(t => t.chatArmed && t.status !== 'exited').length
  }

  function broadcastList() { rememberOpen(); send('terminals:list', list()) }

  /**
   * A session that ended by itself leaves the list only a few seconds later. When
   * Windows shuts down or logs off it ends the sessions' processes one by one before
   * it kills the app, without the app's own quit (which freezes the list): written at
   * once, each exit took one more session off and the next start reopened none.
   */
  let exitTimer = null
  function rememberSoon() {
    if (exitTimer) clearTimeout(exitTimer)
    exitTimer = setTimeout(() => { exitTimer = null; rememberOpen() }, exitGraceMs)
    exitTimer.unref?.()
  }

  /** The running sessions, written on every change (a crash or a kill leaves the last list) */
  function rememberOpen() {
    if (exitTimer) { clearTimeout(exitTimer); exitTimer = null }
    if (frozen) return
    const open = [...terms.values()].filter(t => t.status !== 'exited').map(t => ({ sessionId: t.sessionId, cwd: t.cwd, tool: t.adapter.id })).concat(held)
    try { fs.writeFileSync(openFile, JSON.stringify(open)) } catch {}
  }

  /**
   * The sessions to reopen, once per run (a window swap reloads the page and
   * must not reopen them again). A Claude Code one only with a transcript: one
   * that never got a prompt has nothing to resume. Another tool's opens anew
   * in its folder (it cannot resume). None while some are open already.
   */
  function takeRestorable() {
    const out = terms.size ? [] : restorable.filter(s => s.tool !== 'claude' || hasTranscript(linkedConversation(userDataDir, s.sessionId) || s.sessionId))
    restorable = []
    return out
  }

  function list() { return [...terms.values()].map(info) }

  function create({ cwd, resume, sessionId: wanted, tool } = {}) {
    const adapter = adapterFor(tool, toolList())
    // A tab reopened keeps its id (and so its Pokémon) even when its tool cannot resume
    // (only a real session id: it names files under session-links)
    const reopened = typeof resume === 'string' && UUID.test(resume) ? resume : undefined
    if (!adapter.canResume) resume = undefined
    // A tool no longer in 설정 falls back to Claude Code: a fresh one, its id never had a Claude conversation
    if (tool && tool !== 'claude' && adapter.id === 'claude') resume = undefined
    // No folder picked: the default one (설정, else Documents), else home
    const def = typeof defaultCwd === 'function' ? defaultCwd() : defaultCwd
    const fallback = def && fs.existsSync(def) ? def : os.homedir()
    const dir = cwd && fs.existsSync(cwd) ? cwd : fallback
    // The widget may pick the id itself, so it can dress the session in its Pokémon before the tab shows
    const sessionId = reopened || (typeof wanted === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(wanted) ? wanted : crypto.randomUUID())
    // A terminal reopened resumes the conversation it last had (after a /clear, not the one it began with)
    // (Codex resumes only a thread its log named; with none it starts anew)
    const conversation = resume ? linkedConversation(userDataDir, resume) || (adapter.kind === 'codex' ? undefined : resume) : undefined
    // The chat view: the hooks the file holds as this session starts are the ones it has (armed or not)
    const launchSettings = adapter.id === 'claude' ? settings(chatState(), sessionId) : null
    let { file: command, args } = adapter.launch({ sessionId, resume: conversation, settingsFile: launchSettings ? launchSettings.file : null, extraArgs: adapter.id === 'claude' ? extraArgs() : [] })
    // Debug only: SPAWN_CLAUDE runs another program in place of claude (tests the terminal plumbing for free)
    if (process.env.SPAWN_CLAUDE && adapter.id === 'claude') { command = process.env.SPAWN_CLAUDE; args = [] }
    const pty = (ptyModule ?? loadPty()).spawn(command, args, {
      name: 'xterm-256color',
      cols: 100,
      rows: 30,
      cwd: dir,
      // Claude Code's hooks report under the terminal's id, whatever conversation runs in it
      // CLAUDEX_SESSION_ID too: the name until 1.3.35, which users' own hooks may test (README)
      env: adapter.id === 'claude' ? { ...cleanEnv(process.env), SPAWN_SESSION_ID: sessionId, CLAUDEX_SESSION_ID: sessionId, SPAWN_LINK_FILE: linkFile(userDataDir, sessionId) } : cleanEnv(process.env),
      useConpty: true,
    })
    // Output reaches the window in batches (pending, sent every OUTPUT_BATCH_MS) and is kept
    // for a tab opened later as the chunks sent (chunks/size): appending to one 200 KB string
    // copied all of it on every chunk. What a tab replays was sent already, so nothing doubles.
    const t = { id: sessionId, sessionId, cwd: dir, pty, chunks: [], size: 0, pending: '', flushTimer: null, seq: 0, status: 'running', createdAt: Date.now(), adapter }
    if (launchSettings?.armed) { t.chatArmed = true; t.chatFile = launchSettings.file }
    t.exited = new Promise((resolve) => { t.markExited = resolve })
    terms.set(t.id, t)
    t.scan = ''
    // A tool without hooks: the server hears of it from here, its output standing in for its events
    if (adapter.events === 'pty') {
      t.activity = createActivity({ sessionId, tool: adapter.name, cwd: dir, emit })
      emit({ type: 'session_started', sessionId, cwd: dir, project: path.basename(dir), source: 'startup', model: adapter.name })
    }
    pty.onData((data) => {
      t.pending += data
      if (!t.flushTimer) t.flushTimer = setTimeout(() => flushOutput(t), OUTPUT_BATCH_MS)
      // Only output since the user last answered counts
      t.scan = (t.scan + plainText(data)).slice(-4000)
      if (!t.asking && adapter.asking.test(t.scan)) { t.asking = true; t.questionSeen = true; broadcastList() }
      t.activity?.output(data)
    })
    // Codex CLI: its session log tells what it does (codexWatch.cjs), better than its output
    if (adapter.kind === 'codex') {
      t.codex = codexWatch({
        sessionId, cwd: dir, startedAt: t.createdAt, resumeThread: conversation ?? null,
        emit, status: postStatus,
        onThread: (thread) => {
          t.activity?.mute()
          try { fs.writeFileSync(linkFile(userDataDir, sessionId), String(thread)) } catch { /* reopening starts anew */ }
        },
      })
    }
    pty.onExit(({ exitCode }) => {
      flushOutput(t)
      t.codex?.stop()
      t.activity?.stop()
      t.status = 'exited'
      t.exitCode = exitCode
      t.markExited()
      rememberSoon()
      send('terminals:list', list())
      // Claude killed with its terminal never runs SessionEnd: say it ourselves
      if (onExit) { try { onExit(t.sessionId, exitCode) } catch {} }
    })
    broadcastList()
    return info(t)
  }

  /** The trainer's own name for a session (kept across resumes); empty clears it */
  function rename(id, title) {
    const t = terms.get(id)
    if (!t) return false
    const clean = String(title ?? '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, 40)
    titles.set(t.sessionId, clean || null)
    broadcastList()
    return true
  }

  /**
   * The chat composer (chat view on, this session launched with its hooks only): what reached the
   * terminal's input besides the chat itself, for its ledger of the prompt row (chatHost.cjs). Called
   * after the writes; it can change nothing here, and a failure in it is the host's own.
   */
  function heard(t, ...args) {
    if (!t.chatArmed || typeof chat.onInput !== 'function' || !chatState().on) return
    try { chat.onInput(t.id, ...args) } catch {}
  }

  /** A chat send is between its text and its Enter in this session (armed sessions only, chat on) */
  function chatBusy(t) {
    if (!t.chatArmed || typeof chat.busy !== 'function') return false
    try { return chat.busy(t.id) === true } catch { return false }
  }

  function write(id, data) {
    const t = terms.get(id)
    if (!t || t.status === 'exited' || typeof data !== 'string') return false
    // (for the chat's ledger a question stays on screen until a key answers it: the terminal's own reports and
    // the arrows between its choices do not, though any ESC clears the side panel's flag below as in 1.4.0)
    const asked = !!t.asking || t.questionSeen === true
    t.pty.write(data)
    t.activity?.input()
    // An answer (Enter, or Esc to dismiss) clears the question
    if (/[\r\x1b]/.test(data)) {
      t.scan = ''
      if (t.asking) { t.asking = false; broadcastList() }
    }
    if (t.questionSeen && answersQuestion(data)) t.questionSeen = false
    // (whether a question was on screen as the keys came: they answered it, not the prompt row)
    heard(t, data, 'keyboard', undefined, asked)
    return true
  }

  /**
   * The chat composer's only way into a terminal (chatHost.cjs, which decides what and when): the
   * data as given, to a running Claude Code session launched with the chat hooks. False otherwise.
   */
  function typeForChat(id, data) {
    const t = terms.get(id)
    if (!t || t.status === 'exited' || !t.chatArmed || t.adapter.id !== 'claude' || typeof data !== 'string') return false
    t.pty.write(data)
    t.activity?.input()
    return true
  }

  /** A question answered from the chat (Phase 4): as an Enter in the terminal clears it */
  function clearAsking(id) {
    const t = terms.get(id)
    if (!t) return
    t.scan = ''
    t.questionSeen = false
    if (t.asking) { t.asking = false; broadcastList() }
  }

  /**
   * An instruction from the widget: typed into the session as if at the
   * keyboard, then Enter. A multi-line instruction is sent as one paste
   * (bracketed paste) so Claude Code keeps it as a single prompt.
   */
  function sendInstruction(id, text) {
    const t = terms.get(id)
    if (!t || t.status === 'exited') return { ok: false, reason: 'no-session' }
    const clean = String(text ?? '').replace(/\r\n?/g, '\n').trim()
    if (!clean) return { ok: false, reason: 'empty' }
    if (clean.length > 20_000) return { ok: false, reason: 'too-long' }
    // the chat view's send is between its text and its Enter: this one would merge into it (refused, said)
    if (chatBusy(t)) return { ok: false, reason: 'busy' }
    t.activity?.input()
    if (clean.includes('\n')) t.pty.write(`\x1b[200~${clean}\x1b[201~`)
    else t.pty.write(clean)
    heard(t, null, 'side', 'typed')
    // Enter a beat later, so the TUI has taken the text in first
    setTimeout(() => { if (t.status !== 'exited') { t.pty.write('\r'); heard(t, null, 'side', 'enter') } }, 120)
    return { ok: true }
  }

  function resize(id, cols, rows) {
    const t = terms.get(id)
    if (!t || t.status === 'exited') return
    // (each size the page asks for, the same one too: a chat redraw nudge does not undo it; redrawForChat)
    t.sizeAsked = (t.sizeAsked ?? 0) + 1
    const c = Math.max(20, Math.min(400, cols | 0))
    const r = Math.max(5, Math.min(200, rows | 0))
    // The same size again is not passed on: every resize makes Claude Code clear and redraw its screen
    if (t.cols === c && t.rows === r) return
    t.cols = c
    t.rows = r
    try { t.pty.resize(c, r) } catch {}
    if (process.env.SPAWN_DEBUG_RESIZE) console.log(`[terminals] resize ${id.slice(0, 8)} ${c}x${r}`)
  }

  /**
   * The chat view's redraw nudge (7-48; asked only by chatHost.cjs redraw, which checks when): a
   * Claude Code session shown as chat whose hidden xterm replayed before it fitted. Its pty gets one
   * row less (one more at the smallest size) and, 150 ms later, its size again, so Claude Code draws
   * its screen anew as on any window resize. A resize only: nothing reaches the session's input. The
   * restore is skipped when the page asked for a size meanwhile. Only for a running session launched
   * with the chat hooks, the chat on, its size known. True when the first step was taken.
   */
  function redrawForChat(id, { timers = { setTimeout: (f, ms) => setTimeout(f, ms) } } = {}) {
    const t = terms.get(id)
    if (!t || t.status === 'exited' || !t.chatArmed || t.adapter.id !== 'claude' || !chatState().on) return false
    const c = t.cols, r = t.rows
    if (!Number.isInteger(c) || !Number.isInteger(r)) return false
    const step = r >= 6 ? r - 1 : r + 1
    try { t.pty.resize(c, step) } catch { return false }
    t.cols = c
    t.rows = step
    const asked = t.sizeAsked
    timers.setTimeout(() => {
      if (t.status === 'exited' || t.sizeAsked !== asked || t.cols !== c || t.rows !== step) return
      try { t.pty.resize(c, r) } catch { return }
      t.cols = c
      t.rows = r
    }, REDRAW_RESTORE_MS)
    return true
  }

  /** Send what a session printed since the last batch, and keep it for a tab opened later */
  function flushOutput(t) {
    if (t.flushTimer) { clearTimeout(t.flushTimer); t.flushTimer = null }
    if (!t.pending) return
    const data = t.pending
    t.pending = ''
    t.seq += 1
    send('terminals:data', { id: t.id, data, seq: t.seq })
    t.chunks.push(data)
    t.size += data.length
    while (t.chunks.length > 1 && t.size - t.chunks[0].length >= MAX_BUFFER) t.size -= t.chunks.shift().length
  }

  /**
   * What a tab opened now replays: the output sent so far (at most MAX_BUFFER
   * characters) and the number of the last batch in it, so the tab writes
   * only the batches after that one, however the messages are ordered.
   */
  function buffer(id) {
    const t = terms.get(id)
    if (!t) return { data: '', seq: 0 }
    const all = t.chunks.join('')
    return { data: all.length > MAX_BUFFER ? all.slice(-MAX_BUFFER) : all, seq: t.seq }
  }

  function close(id) {
    const t = terms.get(id)
    if (!t) return
    if (t.flushTimer) { clearTimeout(t.flushTimer); t.flushTimer = null }
    t.codex?.stop()
    // An ended session's pty is closed too: node-pty leaves its pseudo-console and output
    // worker open after a plain exit, and once the tab is gone shutdown() cannot reach it
    try { t.pty.kill() } catch {}
    terms.delete(id)
    // the chat settings file this session was launched with (one per session: its hooks name it) goes with it
    if (t.chatFile && ![...terms.values()].some(o => o.chatFile === t.chatFile)) {
      for (const [name, file] of chatFiles) if (file === t.chatFile) chatFiles.delete(name)
      try { fs.rmSync(t.chatFile, { force: true }) } catch {}
    }
    broadcastList()
  }

  /** Put a tab at `index` (the tab bar's order, also the order reopened at the next start) */
  function move(id, index) {
    if (!terms.has(id) || !Number.isInteger(index)) return false
    const order = [...terms.values()].filter(t => t.id !== id)
    order.splice(Math.max(0, Math.min(order.length, index)), 0, terms.get(id))
    terms.clear()
    for (const t of order) terms.set(t.id, t)
    broadcastList()
    return true
  }

  /**
   * Quitting: leave nothing of node-pty running when the app tears down (a
   * main quit while it was still busy hung in its native teardown, threads
   * blocked in pipe reads). Each running session's process tree is ended and
   * its exit waited for (at most timeoutMs). Then every pty is killed, which
   * closes its pseudo-console: that ends the read the output worker thread is
   * blocked in (node-pty never stops that worker when the process just exits),
   * and drainMs leaves time for the worker's own drain-then-terminate (1 s).
   * The sessions stay listed as open (frozen), for the next start to reopen.
   */
  /** Windows is ending the session (shutdown, restart, log off): keep the list as it is */
  function freeze() {
    frozen = true
    if (exitTimer) { clearTimeout(exitTimer); exitTimer = null }
  }

  async function shutdown(timeoutMs = 3000, drainMs = 1200) {
    freeze()
    const all = [...terms.values()]
    const running = all.filter(t => t.status !== 'exited')
    if (!all.length) return { exited: 0, stuck: 0 }
    const sleep = (ms) => new Promise((resolve) => { const timer = setTimeout(resolve, ms); timer.unref?.() })
    // One deadline for both waits: the trees ended, then their exits reported
    const end = Date.now() + timeoutMs
    await Promise.race([Promise.all(running.map(t => Promise.resolve().then(() => killTree(t.pty.pid)).catch(() => {}))), sleep(timeoutMs)])
    await Promise.race([Promise.all(running.map(t => t.exited)), sleep(Math.max(0, end - Date.now()))])
    const stuck = running.filter(t => t.status !== 'exited').length
    for (const t of all) { try { t.pty.kill() } catch {} }
    await sleep(drainMs)
    return { exited: running.length - stuck, stuck }
  }

  return { create, write, sendInstruction, typeForChat, clearAsking, resize, redrawForChat, buffer, list, rename, close, move, shutdown, freeze, takeRestorable, refreshSettings, armedCount }
}

module.exports = { createTerminalManager, killTreeNow, writeSessionSettings, sessionSettingsJson, cleanEnv, readOpenSessions, hasTranscript, linkedConversation, gitBranch, HOOK_EVENTS }
