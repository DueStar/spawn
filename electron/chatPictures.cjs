'use strict'

/**
 * chatPictures.cjs — a picture the conversation names (a Read of a picture file, a file
 * Claude sent, a path in its answer), read for the chat view's thumbnail. Only a picture
 * extension, only a path some item of that session names (so the page cannot ask for any
 * file on the disk), at most maxBytes. Pure apart from the file reads (fs injected).
 */

const path = require('path')

const PICTURE_TYPES = Object.freeze({
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
})
const MAX_BYTES = 8 * 1024 * 1024
const MAX_DEPTH = 6

/** Whether some string inside `items` (their inputs, texts, nested) contains `p` */
function namedIn(items, p) {
  if (typeof p !== 'string' || !p) return false
  const seen = (v, depth) => {
    if (typeof v === 'string') return v.includes(p)
    if (!v || typeof v !== 'object' || depth > MAX_DEPTH) return false
    for (const x of Array.isArray(v) ? v : Object.values(v)) if (seen(x, depth + 1)) return true
    return false
  }
  for (const item of items) if (seen(item, 0)) return true
  return false
}

/**
 * { ok: true, type, bytes } or { ok: false, reason: 'type' | 'unnamed' | 'missing' | 'size' }.
 * `named(path)`: whether the session's items name it.
 */
async function readPicture(fs, { path: p, named, maxBytes = MAX_BYTES }) {
  if (typeof p !== 'string' || !path.isAbsolute(p)) return { ok: false, reason: 'type' }
  const type = PICTURE_TYPES[path.extname(p).toLowerCase()]
  if (!type) return { ok: false, reason: 'type' }
  if (!named(p)) return { ok: false, reason: 'unnamed' }
  let st
  try { st = await fs.stat(p) } catch { return { ok: false, reason: 'missing' } }
  if (!st.isFile()) return { ok: false, reason: 'missing' }
  if (st.size > maxBytes) return { ok: false, reason: 'size' }
  try { return { ok: true, type, bytes: new Uint8Array(await fs.readFile(p)) } } catch { return { ok: false, reason: 'missing' } }
}

module.exports = { readPicture, namedIn, PICTURE_TYPES, MAX_BYTES }
