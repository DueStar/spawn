'use strict'
/**
 * sessionTrash.cjs — a session deleted from spawn (2026-11-17, the owner's ask "세션을 아예 지우는 것도 여기서"):
 * its Claude Code transcript (`<claude>/projects/<project>/<id>.jsonl`) and its sub-agents' folder (`<id>/`) are
 * moved, not deleted, into `<spawnHome>/trash/<YYYY-MM-DD>/<project>/`, with a note of where they came from, so a
 * slip can be undone (restore). Day folders older than KEEP_DAYS are deleted when the app starts. A session whose
 * Claude Code process still runs is never moved. Only a session id (a UUID) names what moves: no path from the page.
 */

const fsDefault = require('fs')
const path = require('path')

const KEEP_DAYS = 7
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const DAY = /^\d{4}-\d{2}-\d{2}$/

const dayOf = (ms) => new Date(ms).toISOString().slice(0, 10)

/** The transcript files of session `id`: [{ project, file, dir? }] (one per project folder that has it) */
function findSession(claudeDir, id, fs = fsDefault) {
  if (!UUID.test(String(id))) return []
  const root = path.join(claudeDir, 'projects')
  let projects = []
  try { projects = fs.readdirSync(root, { withFileTypes: true }) } catch { return [] }
  const out = []
  for (const p of projects) {
    if (!p.isDirectory()) continue
    const file = path.join(root, p.name, `${id}.jsonl`)
    if (!fs.existsSync(file)) continue
    const dir = path.join(root, p.name, id)
    out.push({ project: p.name, file, ...(fs.existsSync(dir) ? { dir } : {}) })
  }
  return out
}

/**
 * Moves session `id` into the trash. `running(id)`: whether its process still runs (then nothing moves).
 * @returns {{ ok: true, moved: number } | { ok: false, reason: 'invalid' | 'running' | 'none' | 'failed' }}
 */
function trashSession({ claudeDir, spawnHome, id, running = () => false, now = Date.now(), fs = fsDefault }) {
  if (!UUID.test(String(id))) return { ok: false, reason: 'invalid' }
  if (running(id)) return { ok: false, reason: 'running' }
  const found = findSession(claudeDir, id, fs)
  if (!found.length) return { ok: false, reason: 'none' }
  let moved = 0
  for (const f of found) {
    const to = path.join(spawnHome, 'trash', dayOf(now), f.project)
    try {
      fs.mkdirSync(to, { recursive: true })
      fs.renameSync(f.file, path.join(to, `${id}.jsonl`))
      if (f.dir) fs.renameSync(f.dir, path.join(to, id))
      fs.writeFileSync(path.join(to, `${id}.from.json`), JSON.stringify({ id, project: f.project, at: now }))
      moved++
    } catch { /* (the next one is still tried) */ }
  }
  return moved ? { ok: true, moved } : { ok: false, reason: 'failed' }
}

/**
 * Deleting from the resume list (2026-11-19, "right after closing a session it still looks running, so I can't
 * delete it"). `open(id)`: open in one of the app's tabs (never moved). `running(id)`: its Claude Code process still
 * runs (async: history.cjs runningCheck). `closing(id)`: the app closed its tab a moment ago, so that process is on
 * its way out (SessionEnd hooks, Windows' teardown): it is waited for, polling every `pollMs` for at most `waitMs`,
 * and then moved. Running anywhere else (another terminal's live session): refused, as before.
 * @returns {Promise<{ ok: true, moved: number, waited?: number } | { ok: false, reason: 'invalid' | 'open' | 'running' | 'none' | 'failed' }>}
 */
async function trashWhenEnded({
  claudeDir, spawnHome, id, open = () => false, running = async () => false, closing = () => false,
  waitMs = 30_000, pollMs = 1000, sleep = (ms) => new Promise(r => setTimeout(r, ms)), clock = Date.now, now, fs = fsDefault,
}) {
  if (!UUID.test(String(id))) return { ok: false, reason: 'invalid' }
  if (open(id)) return { ok: false, reason: 'open' }
  const start = clock()
  let waited = 0
  while (await running(id)) {
    if (!closing(id) || clock() - start >= waitMs) return { ok: false, reason: 'running' }
    await sleep(pollMs)
    waited = clock() - start
  }
  const r = trashSession({ claudeDir, spawnHome, id, now: now ?? clock(), fs })
  return r.ok && waited ? { ...r, waited } : r
}

/** Puts a trashed session back where it was (any day folder that has it) */
function restoreSession({ claudeDir, spawnHome, id, fs = fsDefault }) {
  if (!UUID.test(String(id))) return { ok: false, reason: 'invalid' }
  const trash = path.join(spawnHome, 'trash')
  let days = []
  try { days = fs.readdirSync(trash).filter(d => DAY.test(d)).sort().reverse() } catch { return { ok: false, reason: 'none' } }
  for (const day of days) {
    let projects = []
    try { projects = fs.readdirSync(path.join(trash, day)) } catch { continue }
    for (const project of projects) {
      const from = path.join(trash, day, project)
      const file = path.join(from, `${id}.jsonl`)
      if (!fs.existsSync(file)) continue
      const to = path.join(claudeDir, 'projects', project)
      if (fs.existsSync(path.join(to, `${id}.jsonl`))) return { ok: false, reason: 'exists' }
      try {
        fs.mkdirSync(to, { recursive: true })
        fs.renameSync(file, path.join(to, `${id}.jsonl`))
        if (fs.existsSync(path.join(from, id))) fs.renameSync(path.join(from, id), path.join(to, id))
        fs.rmSync(path.join(from, `${id}.from.json`), { force: true })
        return { ok: true }
      } catch { return { ok: false, reason: 'failed' } }
    }
  }
  return { ok: false, reason: 'none' }
}

/** Deletes the day folders older than KEEP_DAYS; returns how many went */
function purgeTrash({ spawnHome, now = Date.now(), keepDays = KEEP_DAYS, fs = fsDefault }) {
  const trash = path.join(spawnHome, 'trash')
  const cutoff = dayOf(now - keepDays * 86_400_000)
  let gone = 0
  let days = []
  try { days = fs.readdirSync(trash) } catch { return 0 }
  for (const d of days) {
    if (!DAY.test(d) || d >= cutoff) continue
    try { fs.rmSync(path.join(trash, d), { recursive: true, force: true }); gone++ } catch { /* next start tries again */ }
  }
  return gone
}

module.exports = { KEEP_DAYS, findSession, trashSession, trashWhenEnded, restoreSession, purgeTrash }
