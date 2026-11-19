'use strict'

/**
 * history.cjs — past Claude Code sessions, from every project, for the app's
 * "이어하기" (resume) picker. Read-only: it lists transcripts under
 * ~/.claude/projects and checks ~/.claude/sessions for the ones still running.
 */

const fs = require('fs')
const os = require('os')
const path = require('path')

const HEAD_BYTES = 512 * 1024
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function claudeDir() {
  return process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude')
}

function readHead(file) {
  const fd = fs.openSync(file, 'r')
  try {
    const buf = Buffer.alloc(HEAD_BYTES)
    const n = fs.readSync(fd, buf, 0, HEAD_BYTES, 0)
    return buf.subarray(0, n).toString('utf8')
  } finally {
    fs.closeSync(fd)
  }
}

/** The first thing a person typed: a string, or the first text block, skipping command/system wrappers. */
function promptText(message) {
  const c = message && message.content
  const text = typeof c === 'string' ? c
    : Array.isArray(c) ? (c.find(b => b && b.type === 'text' && typeof b.text === 'string') || {}).text : null
  if (!text) return null
  const t = text.trim()
  if (!t || t.startsWith('<') || t.startsWith('Caveat:')) return null
  return t.replace(/\s+/g, ' ').slice(0, 120)
}

/** cwd, title and first prompt of one transcript, from its first 512 KB. */
function describe(file) {
  let cwd = null
  let first = null
  let title = null
  for (const line of readHead(file).split('\n')) {
    if (!line || line[0] !== '{') continue
    let rec
    try { rec = JSON.parse(line) } catch { continue }
    if (!cwd && typeof rec.cwd === 'string') cwd = rec.cwd
    if (!title && (rec.type === 'custom-title' || rec.type === 'summary')) title = rec.customTitle || rec.summary || null
    if (!first && rec.type === 'user' && !rec.isMeta && !rec.isSidechain) first = promptText(rec.message)
    if (cwd && first && title) break
  }
  return { cwd, first, title }
}

/** The session registry's records: [{ pid, sessionId, procStart, startedAt }] (one file per running Claude Code) */
function readRegistry(dir = path.join(claudeDir(), 'sessions')) {
  const out = []
  let names = []
  try { names = fs.readdirSync(dir) } catch { return out }
  for (const name of names) {
    if (!name.endsWith('.json')) continue
    try {
      const rec = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'))
      if (!rec || typeof rec.sessionId !== 'string' || !rec.sessionId || !Number.isInteger(rec.pid) || rec.pid <= 0) continue
      out.push({
        pid: rec.pid, sessionId: rec.sessionId,
        procStart: typeof rec.procStart === 'string' ? rec.procStart : null,
        startedAt: Number.isFinite(rec.startedAt) ? rec.startedAt : null,
      })
    } catch {}
  }
  return out
}

const alive = (pid) => { try { process.kill(pid, 0); return true } catch { return false } }

/**
 * Session ids whose Claude Code process is alive, from the session registry. Quick and unchecked:
 * a registry file left by a killed Claude Code whose pid Windows gave to another program counts.
 * runningCheck() below tells those apart.
 */
function runningSessions({ dir, isAlive = alive } = {}) {
  const out = new Set()
  for (const rec of readRegistry(dir)) if (isAlive(rec.pid)) out.add(rec.sessionId)
  return out
}

/** Windows FILETIME (100 ns since 1601) as a decimal string -> ms since 1970 */
const filetimeMs = (ft) => Number(BigInt(ft) / 10000n) - 11644473600000

/**
 * Whether the process now holding `rec.pid` is the one that wrote the record: its start time (a FILETIME string,
 * `live`) equals the record's `procStart` (Claude Code writes that very value, on Windows), or, with none, it
 * started before the record was written. A pid Windows reused started later.
 */
function sameProcess(rec, live) {
  if (!live || !/^\d+$/.test(live)) return true // unknown: as before
  if (rec.procStart && /^\d+$/.test(rec.procStart)) {
    const d = BigInt(live) - BigInt(rec.procStart)
    return (d < 0n ? -d : d) <= 10_000_000n // 1 s
  }
  if (rec.startedAt) return filetimeMs(live) <= rec.startedAt + 2000
  return true
}

/**
 * The start times of `pids` on Windows (one PowerShell call): Map pid -> FILETIME string. Null when it cannot tell
 * (not Windows, PowerShell failed): then every live pid counts, as before.
 */
function processStartTimes(pids, { platform = process.platform, execFile = require('child_process').execFile } = {}) {
  const list = pids.filter(p => Number.isInteger(p) && p > 0)
  if (platform !== 'win32') return Promise.resolve(null)
  if (!list.length) return Promise.resolve(new Map())
  const script = `Get-Process -Id ${list.join(',')} -ErrorAction SilentlyContinue | ForEach-Object { "$($_.Id) $($_.StartTime.ToFileTimeUtc())" }`
  return new Promise((resolve) => {
    try {
      execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: 8000 }, (err, stdout) => {
        if (err && !stdout) return resolve(null)
        const out = new Map()
        for (const line of String(stdout || '').split(/\r?\n/)) {
          const m = /^(\d+) (\d+)$/.exec(line.trim())
          if (m) out.set(Number(m[1]), m[2])
        }
        resolve(out)
      })
    } catch { resolve(null) }
  })
}

/**
 * The running sessions, checked (so a session just closed never shows as running): a registry record counts
 * only while its pid is alive AND belongs to the process that wrote it. A Claude Code ended by force (a closed tab,
 * taskkill) never removes its file, and Windows soon hands its pid to another program: process.kill(pid, 0) alone
 * said "running" for ever. The start-time check costs one PowerShell call, so its verdict is kept per pid and start
 * (a mismatch for good; a match for `ttlMs`, then looked at again).
 * @returns {() => Promise<Set<string>>}
 */
function runningCheck({ dir, isAlive = alive, startTimes = processStartTimes, now = Date.now, ttlMs = 60_000 } = {}) {
  const verdicts = new Map() // `${pid}:${procStart|startedAt}` -> { same, at }
  const key = (r) => `${r.pid}:${r.procStart ?? r.startedAt ?? ''}`
  return async function running() {
    const out = new Set()
    const recs = readRegistry(dir).filter(r => isAlive(r.pid))
    const ask = recs.filter(r => { const v = verdicts.get(key(r)); return !v || (v.same && now() - v.at > ttlMs) })
    if (ask.length) {
      let live = null
      try { live = await startTimes([...new Set(ask.map(r => r.pid))]) } catch { live = null }
      // (no answer: as before, a live pid counts; a pid left out of the answer has just ended, and its next look says so)
      if (live) for (const r of ask) if (live.has(r.pid)) verdicts.set(key(r), { same: sameProcess(r, live.get(r.pid)), at: now() })
    }
    for (const r of recs) {
      const v = verdicts.get(key(r))
      if (!v || v.same) out.add(r.sessionId)
    }
    if (verdicts.size > 500) verdicts.clear()
    return out
  }
}

/**
 * The app's session-links folder (terminals.cjs linkFile): which conversation each app terminal now has, and the
 * ones a /clear in it left behind (`<terminal>.prev`, one id a line, written by hooks/spawn-hook.cjs).
 * @returns {Map<string, { current: string, prev: string[] }>} by terminal id
 */
function readSessionLinks(userDataDir) {
  const out = new Map()
  if (!userDataDir) return out
  const dir = path.join(userDataDir, 'session-links')
  let names = []
  try { names = fs.readdirSync(dir) } catch { return out }
  for (const name of names) {
    if (!UUID.test(name)) continue
    let current = ''
    try { current = fs.readFileSync(path.join(dir, name), 'utf8').trim() } catch {}
    if (!UUID.test(current)) continue
    let prev = []
    try { prev = fs.readFileSync(path.join(dir, `${name}.prev`), 'utf8').split(/\r?\n/).map(x => x.trim()).filter(x => UUID.test(x)) } catch {}
    out.set(name, { current, prev })
  }
  return out
}

/**
 * Transcripts a /clear superseded in an app terminal (so one name never shows twice in 이어하기): the terminal's own first
 * conversation and every one before its current, once the current one has a transcript (until then reopening still
 * falls back to the terminal's own one, terminals.cjs create). Claude Code copies the custom title on /clear, so
 * these read exactly like the conversation that followed them. `has(id)`: whether a conversation has a transcript.
 */
function supersededIds(links, has) {
  const out = new Set()
  for (const [terminal, { current, prev }] of links) {
    if (current === terminal || !has(current)) continue
    out.add(terminal)
    for (const p of prev) out.add(p)
  }
  // (a terminal's current conversation is never hidden, whatever another chain says)
  for (const { current } of links.values()) out.delete(current)
  return out
}

/**
 * The app's own names (설정: a tab renamed in the app; `titles` by tab id) for the listed rows. A name belongs to the
 * tab, so it goes with the conversation the tab has now (after a /clear, another id), and never on a transcript a
 * /clear superseded (the tab's first transcript kept reading "Spawn" next to the conversation that
 * followed it). A conversation's own app name wins over its tab's.
 * @returns {Map<string, string>} id -> name
 */
function appTitles(titles, links, rows) {
  const out = new Map()
  if (!titles || typeof titles !== 'object') return out
  const listed = new Set(rows.filter(r => !r.superseded).map(r => r.id))
  for (const [tab, { current }] of links) {
    const name = titles[tab]
    if (typeof name === 'string' && name && listed.has(current)) out.set(current, name)
  }
  for (const id of listed) {
    const name = titles[id]
    if (typeof name === 'string' && name) out.set(id, name)
  }
  return out
}

/**
 * The most recently used sessions across all projects (newest first). Skips
 * claude-mem's observer folder and empty transcripts. `running`: the running
 * session ids (runningCheck's; else the quick unchecked look). `userDataDir`:
 * the app's data folder, for the transcripts a /clear superseded: marked
 * `superseded` (the picker keeps them folded), apart from `limit`, at most
 * half as many again.
 */
function listHistory({ limit = 40, running = null, userDataDir = null } = {}) {
  const root = path.join(claudeDir(), 'projects')
  const files = []
  let projects = []
  try { projects = fs.readdirSync(root, { withFileTypes: true }) } catch { return [] }
  for (const p of projects) {
    if (!p.isDirectory() || p.name.includes('claude-mem-observer')) continue
    let entries = []
    try { entries = fs.readdirSync(path.join(root, p.name)) } catch { continue }
    for (const name of entries) {
      if (!name.endsWith('.jsonl')) continue
      const id = name.slice(0, -6)
      if (!UUID.test(id)) continue
      const file = path.join(root, p.name, name)
      try {
        const st = fs.statSync(file)
        if (st.size > 0) files.push({ id, file, mtime: st.mtimeMs, size: st.size })
      } catch {}
    }
  }
  files.sort((a, b) => b.mtime - a.mtime)
  const live = running ?? runningSessions()
  const ids = new Set(files.map(f => f.id))
  const superseded = supersededIds(readSessionLinks(userDataDir), (id) => ids.has(id))
  const out = []
  let shown = 0
  let folded = 0
  for (const f of files) {
    if (shown >= limit) break
    const old = superseded.has(f.id)
    if (old && folded >= Math.ceil(limit / 2)) continue
    let d
    try { d = describe(f.file) } catch { continue }
    if (!d.cwd || !d.first) continue // nothing a person said: not worth resuming
    if (isTempCwd(d.cwd)) continue // throwaway temp folders
    out.push({
      id: f.id, cwd: d.cwd, project: path.basename(d.cwd), title: d.title || d.first,
      updatedAt: f.mtime, sizeKb: Math.round(f.size / 1024), running: live.has(f.id),
      ...(old ? { superseded: true } : {}),
    })
    if (old) folded++
    else shown++
  }
  return out
}

/** Throwaway temp folders (Windows %TEMP%, macOS /var/folders): sessions started there are not worth resuming */
function isTempCwd(cwd) {
  return /[\\/]AppData[\\/]Local[\\/]Temp[\\/]/i.test(cwd) || /^(\/private)?\/var\/folders\//.test(cwd)
}

module.exports = {
  listHistory, promptText, isTempCwd, claudeDir, runningSessions, runningCheck, readRegistry, sameProcess,
  processStartTimes, readSessionLinks, supersededIds, appTitles,
}
