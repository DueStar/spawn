'use strict'

/**
 * chatPictures.cjs — a picture the conversation names (a Read of a picture file, a file
 * Claude sent, a path in its answer), read for the chat view's thumbnail. Only a picture
 * extension; only a path some item of that session names as a whole path (so the page cannot
 * ask for any other file); never a network or device path (Windows would connect to the host
 * and send the user's credentials); never a link; at most maxBytes. Pure apart from the file
 * reads (fs injected).
 */

const path = require('path')

const PICTURE_TYPES = Object.freeze({
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
})
const MAX_BYTES = 8 * 1024 * 1024
const MAX_DEPTH = 6
/** \\host\…, //host/…, \\?\…, \\.\… (either slash) */
const NETWORK_OR_DEVICE = /^[\\/]{2}/

/** A character a whole path may sit right after in text */
const BEFORE = /[\s`'"(<[{=:,]/
/** A character a whole path may sit right before in text ('.' only when no word follows it: "a.png." ends, "a.png.txt" does not) */
const AFTER = /[\s`'")>\]},;:!?]/

/** Whether `s` contains `p` as a whole path: the whole string, or set off by spaces, quotes or punctuation */
function holds(s, p) {
  if (s === p) return true
  for (let i = s.indexOf(p); i >= 0; i = s.indexOf(p, i + 1)) {
    const before = i === 0 ? '' : s[i - 1]
    const end = i + p.length
    const after = end >= s.length ? '' : s[end]
    const startOk = before === '' || BEFORE.test(before)
    const endOk = after === '' || AFTER.test(after) || (after === '.' && !/\w/.test(s[end + 1] ?? ''))
    if (startOk && endOk) return true
  }
  return false
}

/** Whether some string inside `items` (their inputs, texts, nested) names `p` as a whole path */
function namedIn(items, p) {
  if (typeof p !== 'string' || !p) return false
  const seen = (v, depth) => {
    if (typeof v === 'string') return holds(v, p)
    if (!v || typeof v !== 'object' || depth > MAX_DEPTH) return false
    for (const x of Array.isArray(v) ? v : Object.values(v)) if (seen(x, depth + 1)) return true
    return false
  }
  for (const item of items) if (seen(item, 0)) return true
  return false
}

/**
 * The file a page's path stands for: an absolute one as it is; a relative one (a Read inside the
 * session's folder is listed relative to it) inside `cwd`, with no `..` and never in a network
 * folder. A drive-rooted path (\x, /x on Windows) is refused: it names the current drive's root.
 * null when refused.
 */
function askedPath(asked, cwd, platform = process.platform) {
  const p = platform === 'win32' ? path.win32 : path.posix
  if (typeof asked !== 'string' || !asked || NETWORK_OR_DEVICE.test(asked)) return null
  if (platform === 'win32' && /^[\\/](?![\\/])/.test(asked)) return null
  if (p.isAbsolute(asked)) return asked
  if (typeof cwd !== 'string' || !cwd || NETWORK_OR_DEVICE.test(cwd)) return null
  if (asked.split(/[\\/]/).includes('..')) return null
  return p.join(cwd, asked)
}

/**
 * { ok: true, type, bytes } or { ok: false, reason: 'type' | 'unnamed' | 'missing' | 'size' }.
 * `named(path)`: whether the session's items name it. A network or device path is refused before
 * anything touches the disk.
 */
async function readPicture(fs, { path: p, named, maxBytes = MAX_BYTES }) {
  if (typeof p !== 'string' || NETWORK_OR_DEVICE.test(p) || !path.isAbsolute(p)) return { ok: false, reason: 'type' }
  const type = PICTURE_TYPES[path.extname(p).toLowerCase()]
  if (!type) return { ok: false, reason: 'type' }
  if (!named(p)) return { ok: false, reason: 'unnamed' }
  let st
  try { st = await fs.lstat(p) } catch { return { ok: false, reason: 'missing' } }
  // a link could stand for any file: never followed
  if (!st.isFile() || st.isSymbolicLink()) return { ok: false, reason: 'missing' }
  if (st.size > maxBytes) return { ok: false, reason: 'size' }
  try { return { ok: true, type, bytes: new Uint8Array(await fs.readFile(p)) } } catch { return { ok: false, reason: 'missing' } }
}

module.exports = { readPicture, namedIn, askedPath, PICTURE_TYPES, MAX_BYTES }
