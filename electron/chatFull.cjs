'use strict'
/**
 * chatFull.cjs — one item of the chat read again whole from the session's transcript, so
 * nothing of a chat session needs the terminal. The chat's items are capped (an answer at 200 000
 * characters, a command's output at 200 lines); "전체 보기" asks for the rest here instead of "see the terminal".
 *
 * An item's `order` is its line's offset in the transcript. A text, a user message or a thinking block is read from
 * that line; a tool's output from the line of its result, found after its call by its tool_use_id; a `!` command's
 * output from the bash-stdout line after it. Never more than FULL_CAPS.text characters back; a Read's file text is
 * never sent (as everywhere in the chat). Pure apart from the file reads (fs injected).
 */

const { resultText, unwrapPasted } = require('./chatItems.cjs')

const FULL_CAPS = Object.freeze({ text: 2_000_000, lineBytes: 32 * 1024 * 1024, scanBytes: 64 * 1024 * 1024, chunk: 1 << 20 })
const NL = 0x0a
const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v)
const cut = (s) => (s.length > FULL_CAPS.text ? { text: s.slice(0, FULL_CAPS.text), truncated: true } : { text: s, truncated: false })

/** The line starting at `offset` (without its newline), or null past the end / over the cap */
async function lineAt(fs, file, offset, maxBytes = FULL_CAPS.lineBytes) {
  const h = await fs.open(file, 'r')
  try {
    const parts = []
    let pos = offset
    let len = 0
    for (;;) {
      const buf = Buffer.allocUnsafe(FULL_CAPS.chunk)
      const { bytesRead } = await h.read(buf, 0, buf.length, pos)
      if (!bytesRead) return parts.length ? Buffer.concat(parts).toString('utf8') : null
      const data = buf.subarray(0, bytesRead)
      const i = data.indexOf(NL)
      if (i !== -1) { parts.push(data.subarray(0, i)); return Buffer.concat(parts).toString('utf8').replace(/\r$/, '') }
      parts.push(data)
      len += bytesRead
      pos += bytesRead
      if (len > maxBytes) return null
    }
  } finally {
    await h.close().catch(() => {})
  }
}

/** The first whole line after `from` that holds every needle (scanning at most FULL_CAPS.scanBytes), or null */
async function lineAfter(fs, file, from, needles) {
  const start = await lineAt(fs, file, from)
  if (start === null) return null
  let pos = from + Buffer.byteLength(start, 'utf8') + 1
  const end = pos + FULL_CAPS.scanBytes
  while (pos < end) {
    const line = await lineAt(fs, file, pos)
    if (line === null) return null
    if (needles.every(n => line.includes(n))) return line
    pos += Buffer.byteLength(line, 'utf8') + 1
  }
  return null
}

const unescapeHtml = (s) => String(s ?? '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&')

/**
 * The whole text of `item` (one of the view's items) from `file`.
 * @returns {Promise<{ ok: true, text: string, truncated: boolean, md: boolean } | { ok: false, reason: 'gone' | 'unknown' | 'none' }>}
 */
async function readFull(fs, file, item) {
  if (!isObj(item) || typeof item.order !== 'number' || item.order < 0 || item.parent) return { ok: false, reason: 'unknown' }
  const offset = Math.floor(item.order)
  let obj = null
  const parse = (line) => { try { return JSON.parse(line) } catch { return null } }
  try {
    if (item.kind === 'text' || item.kind === 'thinking' || item.kind === 'user') {
      obj = parse(await lineAt(fs, file, offset))
      const content = obj?.message?.content
      if (item.kind === 'user') {
        const text = typeof content === 'string' ? content
          : Array.isArray(content) ? content.filter(b => isObj(b) && b.type === 'text' && typeof b.text === 'string').map(b => b.text).join('\n') : null
        return typeof text === 'string' ? { ok: true, ...cut(unwrapPasted(text)), md: false } : { ok: false, reason: 'gone' }
      }
      const blocks = typeof content === 'string' ? [{ type: 'text', text: content }] : Array.isArray(content) ? content : null
      if (!blocks) return { ok: false, reason: 'gone' }
      const at = /:(\d+)$/.exec(String(item.id))
      const block = at ? blocks[Number(at[1])] : blocks.find(b => isObj(b) && b.type === item.kind)
      const text = item.kind === 'text' ? block?.text : block?.thinking
      return typeof text === 'string' ? { ok: true, ...cut(text), md: true } : { ok: false, reason: 'gone' }
    }
    if (item.kind === 'tool') {
      // (a Read's file text is never sent from the chat)
      if (item.tool === 'Read') return { ok: false, reason: 'none' }
      obj = parse(await lineAfter(fs, file, offset, [`"tool_use_id":"${String(item.id).replace(/"/g, '')}"`, '"tool_result"']))
      const content = Array.isArray(obj?.message?.content) ? obj.message.content : []
      const block = content.find(b => isObj(b) && b.type === 'tool_result' && b.tool_use_id === item.id)
      if (!block) return { ok: false, reason: 'gone' }
      return { ok: true, ...cut(resultText(block.content)), md: false }
    }
    if (item.kind === 'shell') {
      obj = parse(await lineAfter(fs, file, offset, ['<bash-stdout>']))
      const c = obj?.message?.content
      const raw = typeof c === 'string' ? c : Array.isArray(c) ? c.filter(b => isObj(b) && typeof b.text === 'string').map(b => b.text).join('\n') : ''
      const m = /<bash-stdout>([\s\S]*?)<\/bash-stdout>\s*(?:<bash-stderr>([\s\S]*?)<\/bash-stderr>)?/.exec(raw)
      if (!m) return { ok: false, reason: 'gone' }
      const out = [unescapeHtml(m[1]).replace(/\s+$/, ''), unescapeHtml(m[2] ?? '').replace(/\s+$/, '')].filter(Boolean).join('\n')
      return { ok: true, ...cut(out), md: false }
    }
    return { ok: false, reason: 'unknown' }
  } catch {
    return { ok: false, reason: 'gone' }
  }
}

const PICTURE_MEDIA = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp'])
const PICTURE_MAX = 8 * 1024 * 1024

/**
 * A picture the user sent with a message, read again from that message's transcript line (its
 * `order`) when the row is drawn: the n-th image block, decoded. Only a user message of the main
 * thread, only a picture type, at most maxBytes. { ok, type, bytes } or { ok: false, reason }.
 */
async function readUserImage(fs, file, item, index, maxBytes = PICTURE_MAX) {
  if (!isObj(item) || item.kind !== 'user' || item.parent || typeof item.order !== 'number' || item.order < 0) return { ok: false, reason: 'unknown' }
  if (!Number.isInteger(index) || index < 0) return { ok: false, reason: 'unknown' }
  let obj = null
  try { obj = JSON.parse(await lineAt(fs, file, Math.floor(item.order)) ?? '') } catch { return { ok: false, reason: 'gone' } }
  const content = obj?.message?.content
  const pics = Array.isArray(content) ? content.filter(b => isObj(b) && b.type === 'image' && isObj(b.source)) : []
  const block = pics[index]
  if (!block) return { ok: false, reason: 'gone' }
  const { type, media_type: media, data } = block.source
  if (type !== 'base64' || typeof data !== 'string' || !PICTURE_MEDIA.has(media)) return { ok: false, reason: 'type' }
  // (base64: 4 characters per 3 bytes, checked before decoding)
  if (Math.floor(data.length * 3 / 4) > maxBytes) return { ok: false, reason: 'size' }
  return { ok: true, type: media, bytes: new Uint8Array(Buffer.from(data, 'base64')) }
}

module.exports = { FULL_CAPS, lineAt, lineAfter, readFull, readUserImage }
