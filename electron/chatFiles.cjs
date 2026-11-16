'use strict'

/**
 * chatFiles.cjs — the chat composer's @ mention (Phase 3): file names from the session's own
 * folder, for the menu that puts `@path` into the draft (Claude Code resolves the mention
 * itself when the prompt is sent). Read by main: the folder is the terminal's, from the
 * terminal manager, never one the page names.
 *
 * Names only: no file is opened or read. Symbolic links and junctions are never followed
 * (Dirent.isSymbolicLink, then lstat and the real path of every folder before it is read: it
 * must stay inside the session's real folder). Build, dependency and dot folders are skipped.
 * The walk stops at `maxScan` entries or `budgetMs`, whichever comes first. A path with
 * whitespace is left out (how Claude Code reads an @ mention with a space is not verified).
 */

const path = require('path')

/** Folders never walked (with every other dot-folder) */
const SKIP_DIRS = new Set(['.git', 'node_modules', '.next', 'dist', 'build', 'out', 'target', '.venv', 'venv', '__pycache__', '.cache'])

const isUnder = (root, p) => {
  const rel = path.relative(root, p)
  return rel === '' || (!!rel && !rel.startsWith('..') && !path.isAbsolute(rel))
}

/** Every file name under `cwd` (relative, forward slashes), within the caps */
async function scan(cwd, { fs = require('fs').promises, now = Date.now, budgetMs = 400, maxScan = 20_000 } = {}) {
  // a network share (\\server\share, //server/share): every read may stall on the network and holds a
  // thread of Node's pool meanwhile; such folders are not listed (typing @path by hand still works)
  if (typeof cwd !== 'string' || /^(?:\\\\|\/\/)/.test(cwd)) return []
  const start = now()
  // each read races the budget (a slow disk: the walk ends on time, what it found so far stands)
  const SLOW = Symbol('slow')
  const within = (p) => Promise.race([p, new Promise((resolve) => { const t = setTimeout(() => resolve(SLOW), Math.max(0, budgetMs - (now() - start))); t.unref?.() })])
  let root
  try { root = await within(fs.realpath(cwd)) } catch { return [] }
  if (root === SLOW || typeof root !== 'string' || /^(?:\\\\|\/\/)/.test(root)) return []
  const out = []
  const queue = ['']
  let seen = 0
  const over = () => seen >= maxScan || now() - start > budgetMs
  while (queue.length && !over()) {
    const rel = queue.shift()
    const abs = rel ? path.join(root, ...rel.split('/')) : root
    if (rel) {
      // a folder is read only when it is a real folder (no link, no junction) inside the session's
      try {
        const st = await within(fs.lstat(abs))
        if (st === SLOW) break
        if (st.isSymbolicLink() || !st.isDirectory()) continue
        const real = await within(fs.realpath(abs))
        if (real === SLOW) break
        if (!isUnder(root, real)) continue
      } catch { continue }
    }
    let dir
    let opening
    try { opening = fs.opendir(abs); dir = await within(opening) } catch { continue }
    // (a folder that opens after the budget is closed when it does)
    if (dir === SLOW) { opening.then((d) => d.close().catch(() => {}), () => {}); break }
    try {
      for await (const d of dir) {
        seen++
        if (over()) break
        if (d.isSymbolicLink()) continue
        const name = d.name
        const r = rel ? `${rel}/${name}` : name
        if (d.isDirectory()) { if (!name.startsWith('.') && !SKIP_DIRS.has(name)) queue.push(r) }
        else if (d.isFile() && !/\s/.test(r)) out.push(r)
      }
    } catch { /* a folder that went away while read */ }
  }
  return out
}

/** The files that hold the query's letters in order (any case): a hit in the name first, then the shorter path */
function matchFiles(files, query, max = 50) {
  const q = String(query ?? '').toLowerCase()
  const inOrder = (s) => { let i = 0; for (const c of s) { if (c === q[i]) i++; if (i === q.length) return true } return i === q.length }
  const scored = []
  for (const f of files) {
    const lf = f.toLowerCase()
    if (!inOrder(lf)) continue
    const base = lf.slice(lf.lastIndexOf('/') + 1)
    scored.push({ f, rank: !q || base.includes(q) ? 0 : 1 })
  }
  scored.sort((a, b) => a.rank - b.rank || a.f.length - b.f.length || (a.f < b.f ? -1 : a.f > b.f ? 1 : 0))
  return scored.slice(0, max).map(s => s.f)
}

/** The mention menu's files for a query */
async function listFiles(cwd, query, opts = {}) {
  return matchFiles(await scan(cwd, opts), query, opts.max ?? 50)
}

module.exports = { listFiles, matchFiles, scan, SKIP_DIRS }
