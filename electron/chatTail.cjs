'use strict'

/**
 * chatTail.cjs — one Claude Code transcript file, read for the chat lens
 * (Phase 2). A session's transcript can be hundreds of MB, so it is never
 * read whole:
 *
 *   readTail   the end first: backwards in chunks until `want` kept lines,
 *              `maxBytes` read, or the file's start
 *   readNew    what was appended since (only whole lines: a half-written last
 *              line waits for the next read)
 *   readOlder  the page before the first line read, on demand
 *
 * The transcript is append-only (FINDINGS §1). The guard checks that: the
 * hash of the file's first bytes (head) and of the bytes just before the end
 * read so far (edge) must not change; a shorter file or a changed hash is
 * reported as `rewritten`, and the lens decides (a banner and a fresh read).
 *
 * All IO is fs.promises with a FileHandle opened per read and closed after it
 * (the file is never held open: Claude Code keeps writing it). Work yields to
 * the event loop every `yieldEvery` bytes. Operations on one tail run one at
 * a time.
 */

const crypto = require('crypto')

const NL = 0x0a

/**
 * Whole lines out of `carry` + `buf` (split on the byte 0x0a only, then each
 * line decoded, so a UTF-8 character cut between two chunks survives). An
 * incomplete last line stays in `carry`. `offset` is the line's byte offset:
 * `base` is where `carry` (or `buf`, when carry is empty) starts in the file.
 */
function splitLines(buf, carry, base = 0) {
  const data = carry && carry.length ? Buffer.concat([carry, buf]) : buf
  const lines = []
  let start = 0
  for (let i = data.indexOf(NL); i !== -1; i = data.indexOf(NL, start)) {
    let end = i
    if (end > start && data[end - 1] === 0x0d) end-- // CRLF
    lines.push({ text: data.subarray(start, end).toString('utf8'), offset: base + start })
    start = i + 1
  }
  return { lines, carry: Buffer.from(data.subarray(start)) }
}

const sha1 = (buf) => crypto.createHash('sha1').update(buf).digest('hex')
const decode = (buf) => (buf.length && buf[buf.length - 1] === 0x0d ? buf.subarray(0, buf.length - 1) : buf).toString('utf8')

function createTail(file, { fs = require('fs').promises, chunk = 1 << 20, yieldEvery = 2 << 20, guardBytes = 64 << 10 } = {}) {
  let startOffset = null // the first line read (null: nothing read yet)
  let endOffset = 0      // just after the last whole line read
  let size = 0
  let atStart = false
  let head = null
  let headLen = 0
  let edge = null
  let edgeFrom = 0

  let sinceYield = 0
  async function progress(n) {
    sinceYield += n
    if (sinceYield >= yieldEvery) { sinceYield = 0; await new Promise((r) => setImmediate(r)) }
  }

  // one operation at a time
  let queue = Promise.resolve()
  function serial(fn) {
    const p = queue.then(() => fn())
    queue = p.then(() => {}, () => {})
    return p
  }

  async function withHandle(fn) {
    const h = await fs.open(file, 'r')
    try { return await fn(h) } finally { await h.close().catch(() => {}) }
  }

  async function readAt(h, from, len) {
    const buf = Buffer.alloc(len)
    let got = 0
    while (got < len) {
      const { bytesRead } = await h.read(buf, got, len - got, from + got)
      if (!bytesRead) break
      got += bytesRead
    }
    return got === len ? buf : buf.subarray(0, got)
  }

  async function guardHashes(h) {
    headLen = Math.min(guardBytes, endOffset)
    head = sha1(await readAt(h, 0, headLen))
    edgeFrom = Math.max(0, endOffset - guardBytes)
    edge = sha1(await readAt(h, edgeFrom, endOffset - edgeFrom))
  }

  /**
   * Lines backwards from `from` (a line boundary), newest last in the result.
   * Stops once `keep` accepted `want` lines, `maxBytes` were read, or the
   * file's start was reached. A single line longer than maxBytes is passed
   * over (never returned) so paging still moves on.
   */
  async function scanBack(h, from, { want, maxBytes, keep }) {
    const found = []
    let accepted = 0
    let boundary = from // the earliest line start reached
    if (from <= 0) return { lines: found, start: 0 }
    const take = (text, offset) => {
      boundary = offset
      if (text.trim() && (!keep || keep(text))) { found.push({ text, offset }); accepted++ }
    }
    // data holds bytes [pos, end of the newest line not taken yet), without its newline
    let pos = from - 1
    let data = Buffer.alloc(0)
    let read = 0
    while (accepted < want) {
      if (pos === 0) { take(decode(data), 0); break } // what is left is the file's first line
      if (read >= maxBytes) {
        // nothing whole in maxBytes: one huge line, passed over (its start found without keeping it)
        if (boundary === from) boundary = await lineStartBefore(h, pos)
        break
      }
      const n = Math.min(chunk, pos, maxBytes - read)
      const buf = await readAt(h, pos - n, n)
      read += n
      pos -= n
      await progress(n)
      data = data.length ? Buffer.concat([buf, data]) : buf
      for (let i = data.lastIndexOf(NL); i !== -1 && accepted < want; i = data.lastIndexOf(NL)) {
        take(decode(data.subarray(i + 1)), pos + i + 1)
        data = data.subarray(0, i)
      }
    }
    found.reverse()
    return { lines: found, start: boundary }
  }

  /** Where the line holding the byte before `pos` starts (reads backwards, keeps nothing) */
  async function lineStartBefore(h, pos) {
    while (pos > 0) {
      const n = Math.min(chunk, pos)
      const buf = await readAt(h, pos - n, n)
      const i = buf.lastIndexOf(NL)
      if (i !== -1) return pos - n + i + 1
      pos -= n
      await progress(n)
    }
    return 0
  }

  /** The end of the last whole line: a partial last line (no newline yet) is left for readNew */
  async function lastBoundary(h, fileSize) {
    let pos = fileSize
    while (pos > 0) {
      const n = Math.min(pos, pos === fileSize ? 1 : chunk)
      const buf = await readAt(h, pos - n, n)
      const i = buf.lastIndexOf(NL)
      if (i !== -1) return pos - n + i + 1
      pos -= n
      await progress(n)
    }
    return 0
  }

  function readTail({ want, maxBytes = 16 << 20, keep } = {}) {
    return serial(() => withHandle(async (h) => {
      size = (await h.stat()).size
      endOffset = await lastBoundary(h, size)
      const r = await scanBack(h, endOffset, { want, maxBytes, keep })
      startOffset = r.start
      atStart = r.start === 0
      await guardHashes(h)
      return { lines: r.lines, startOffset, endOffset, atStart }
    }))
  }

  function readOlder({ want, maxBytes = 4 << 20, keep } = {}) {
    return serial(() => withHandle(async (h) => {
      // nothing read yet (readTail comes first), or at the start already
      if (startOffset === null || startOffset === 0) return { lines: [], startOffset: startOffset ?? 0, endOffset, atStart: startOffset === 0 }
      const r = await scanBack(h, startOffset, { want, maxBytes, keep })
      startOffset = r.start
      atStart = r.start === 0
      return { lines: r.lines, startOffset, endOffset, atStart }
    }))
  }

  function readNew({ keep } = {}) {
    return serial(async () => {
      // a stat first: no new bytes since the last look (the usual poll) opens nothing and hashes nothing.
      // A same-length rewrite is then caught at the next growth, before anything new is shown.
      const now = (await fs.stat(file)).size
      if (now < endOffset) return { lines: [], rewritten: true }
      if (now === endOffset || (head !== null && now === size)) return { lines: [], rewritten: false }
      return withHandle((h) => readNewFrom(h, now, keep))
    })
  }

  async function readNewFrom(h, now, keep) {
    {
      if (head !== null) {
        if (sha1(await readAt(h, 0, headLen)) !== head) return { lines: [], rewritten: true }
        if (sha1(await readAt(h, edgeFrom, endOffset - edgeFrom)) !== edge) return { lines: [], rewritten: true }
      }
      size = now
      const lines = []
      let pos = endOffset
      let carry = Buffer.alloc(0)
      let carryAt = endOffset
      while (pos < now) {
        const n = Math.min(chunk, now - pos)
        const buf = await readAt(h, pos, n)
        if (!buf.length) break
        const r = splitLines(buf, carry, carryAt)
        for (const l of r.lines) if (l.text.trim() && (!keep || keep(l.text))) lines.push(l)
        pos += buf.length
        carry = r.carry
        carryAt = pos - carry.length
        await progress(buf.length)
      }
      const before = endOffset
      endOffset = carryAt
      if (startOffset === null) { startOffset = before; atStart = before === 0 }
      if (endOffset !== before || head === null) await guardHashes(h)
      return { lines, rewritten: false }
    }
  }

  function state() { return { startOffset, endOffset, size } }

  /**
   * The guard alone (Phase 5, an edit read again by its offset): false when the file is shorter than
   * what was read or its head / edge bytes changed. Nothing is read past the end read so far.
   */
  function verify() {
    return serial(async () => {
      if (head === null) return true
      if ((await fs.stat(file)).size < endOffset) return false
      return withHandle(async (h) => sha1(await readAt(h, 0, headLen)) === head && sha1(await readAt(h, edgeFrom, endOffset - edgeFrom)) === edge)
    })
  }

  return { readTail, readNew, readOlder, state, verify }
}

module.exports = { splitLines, createTail }
