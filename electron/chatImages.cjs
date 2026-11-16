'use strict'

/**
 * chatImages.cjs — images pasted, dropped or picked in the chat composer (the chat view,
 * Phase 3). The page sends the bytes; main checks what they are by their first bytes (never
 * by a name or a type the page claims), writes them under the app's own temp folder with a
 * name it makes, and answers with an opaque token. The composer's send names tokens only, so
 * the page never chooses a path. Claude Code reads the file from its pasted path (FINDINGS §7:
 * it becomes `[Image #n]`); nothing leaves the machine, and the clipboard is never touched.
 *
 *   <os temp>/spawn-chat-<8 hex of the app's data folder>/<terminal id>/<24 hex>.<ext>
 *
 * One folder per app instance (a development build and a trial copy never share one). The
 * files go when a chip is removed (drop), when the session ends (dropSession) and at every
 * start (sweep: an earlier run's leftovers).
 */

const path = require('path')
const crypto = require('crypto')
const { errWord } = require('./chatLog.cjs')

/** PNG, JPEG, GIF, WebP: the formats Claude Code sends to the model; nothing else (no SVG, BMP, HEIC) */
function sniffImage(bytes) {
  if (!(bytes instanceof Uint8Array)) return null
  const b = bytes
  const at = (i, ...v) => v.every((x, k) => b[i + k] === x)
  if (b.length >= 8 && at(0, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return 'png'
  if (b.length >= 3 && at(0, 0xff, 0xd8, 0xff)) return 'jpeg'
  if (b.length >= 6 && at(0, 0x47, 0x49, 0x46, 0x38) && (b[4] === 0x37 || b[4] === 0x39) && b[5] === 0x61) return 'gif'
  if (b.length >= 12 && at(0, 0x52, 0x49, 0x46, 0x46) && at(8, 0x57, 0x45, 0x42, 0x50)) return 'webp'
  return null
}

const IMAGE_CAPS = Object.freeze({ bytes: 10 << 20, perSession: 64, sessionBytes: 256 << 20 })

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const TOKEN = /^[0-9a-f]{24}$/

/** The image folder of this app instance */
function imageRoot(tmpDir, userDataDir) {
  return path.join(String(tmpDir), 'spawn-chat-' + crypto.createHash('sha1').update(String(userDataDir)).digest('hex').slice(0, 8))
}

/**
 * @param {object} o
 * @param {string} o.root  imageRoot(…)
 */
function createImageStore({ root, fs = require('fs').promises, randomBytes = crypto.randomBytes, log = () => {}, caps = IMAGE_CAPS }) {
  /** terminal id → { files: Map<token, file>, count, bytes } (count and bytes: everything saved this session) */
  const sessions = new Map()

  /** Save one image for a terminal: { ok: true, token, type } or { ok: false, reason: 'type' | 'size' | 'limit' | 'off' | 'io' } (io: it could not be written, e.g. a full disk) */
  async function save(terminalId, bytes) {
    if (typeof terminalId !== 'string' || !UUID.test(terminalId)) return { ok: false, reason: 'off' }
    if (!(bytes instanceof Uint8Array)) return { ok: false, reason: 'type' }
    if (bytes.byteLength > caps.bytes) return { ok: false, reason: 'size' }
    const type = sniffImage(bytes)
    if (!type) return { ok: false, reason: 'type' }
    let s = sessions.get(terminalId)
    if (s && (s.count >= caps.perSession || s.bytes + bytes.byteLength > caps.sessionBytes)) return { ok: false, reason: 'limit' }
    if (!s) { s = { files: new Map(), count: 0, bytes: 0 }; sessions.set(terminalId, s) }
    s.count++
    s.bytes += bytes.byteLength
    const dir = path.join(root, terminalId)
    await fs.mkdir(dir, { recursive: true, mode: 0o700 })
    for (let tries = 0; tries < 3; tries++) {
      const token = Buffer.from(randomBytes(12)).toString('hex')
      if (!TOKEN.test(token) || s.files.has(token)) continue
      const file = path.join(dir, `${token}.${type === 'jpeg' ? 'jpg' : type}`)
      try {
        // a new file only ('wx'): never over another
        await fs.writeFile(file, bytes, { flag: 'wx', mode: 0o600 })
      } catch (err) {
        if (err?.code === 'EEXIST') continue
        log('error', `chat images: an image could not be saved (${errWord(err)})`)
        // (a full disk: the file was made and part of it written; it goes, and this image counts for nothing)
        try { await fs.unlink(file) } catch { /* not made, or gone already */ }
        s.count--
        s.bytes -= bytes.byteLength
        return { ok: false, reason: 'io' }
      }
      s.files.set(token, file)
      return { ok: true, token, type }
    }
    return { ok: false, reason: 'off' }
  }

  /** The absolute path of a token this store saved for this terminal, else null */
  function filePath(terminalId, token) {
    if (typeof token !== 'string' || !TOKEN.test(token)) return null
    return sessions.get(terminalId)?.files.get(token) ?? null
  }

  /** A chip removed: its file goes */
  async function drop(terminalId, token) {
    const file = filePath(terminalId, token)
    if (!file) return
    sessions.get(terminalId).files.delete(token)
    await fs.rm(file, { force: true }).catch(() => {})
  }

  /** The session ended: its folder goes */
  async function dropSession(terminalId) {
    if (typeof terminalId !== 'string' || !UUID.test(terminalId)) return
    sessions.delete(terminalId)
    const dir = path.join(root, terminalId)
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {})
  }

  /** At start: everything an earlier run left */
  async function sweep() {
    sessions.clear()
    await fs.rm(root, { recursive: true, force: true }).catch(() => {})
  }

  /** Whether this terminal has had images saved this run (its folder to remove when it ends) */
  const has = (terminalId) => sessions.has(terminalId)

  return { save, path: filePath, drop, dropSession, sweep, has, root }
}

module.exports = { sniffImage, IMAGE_CAPS, imageRoot, createImageStore }
