'use strict'

/**
 * chatChanges.cjs — the change index of a conversation (Phase 5, the 변경 사항 panel). It runs in the
 * chat worker (chatLens.cjs), never in the main process.
 *
 * The page keeps a window of the conversation, so a panel built from its items would undercount a long
 * session. The index reads the whole conversation instead: a forward scan of the transcript (and of the
 * sub-agents' own files), then the lens's live lines. It holds counts and byte offsets only, never the
 * text of a diff. When the page asks for a file, each edit is read again from its line (readEdit),
 * checked by its tool id, and rebuilt with Phase 2's buildDiff — the same block chatItems gives its row.
 *
 * Wrong information is the worst failure:
 *   - edits of a file are kept and returned one by one, in order, never composed into one diff (that
 *     would need the file's contents between edits, which the transcript does not hold);
 *   - an edit whose patch the record does not hold is `missing` (counts null), never drawn as empty;
 *   - a failed, rejected or interrupted edit changed nothing and has no entry;
 *   - no file of the project is ever read: everything comes from the transcript lines.
 *
 * Mirrored shapes (src/chat/types.ts):
 * @typedef {{ v: number, state: 'scanning' | 'ready' | 'partial' | 'gone', files: number, edits: number,
 *   added: number, removed: number, unknown: number }} ChangeSummary
 * @typedef {{ file: string, outside: boolean, created: boolean, edits: number, added: number, removed: number,
 *   unknown: number, cut: boolean, agent: boolean, last: number }} ChangeFile
 * @typedef {{ toolId: string, order: number, at: number | null, agentId?: string, kind: 'edit' | 'create' | 'write' | 'notebook',
 *   added: number | null, removed: number | null, state: 'ok' | 'missing' | 'stale', diff?: object }} ChangeEdit
 * An entry (the index's own): ChangeEdit's fields without `diff`, plus `cut`, `src: { file: 'main' | agentId, offset }`
 * and `hash` (a short digest of its line, to tell the line is still the one indexed).
 */

const crypto = require('crypto')
const { buildDiff, relFile, lexicalPath } = require('./chatItems.cjs')
const { quickSkip } = require('./chatSchema.cjs')

/** The one source of the index's limits */
const CHANGE_CAPS = Object.freeze({
  files: 2000, editsPerFile: 500, calls: 5000, scanBytes: 1 << 30, agents: 50, agentBytes: 64 << 20,
  bodyEdits: 20, bodyLines: 4000, lineBytes: 32 << 20,
})

const EDIT_TOOLS = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit'])
const REJECTED = 'User rejected tool use'
const AGENT_ID = /^[A-Za-z0-9_-]{1,64}$/
/** An agent's edits sit after the main line that named the agent: anchor + k * STEP (k counts its edits) */
const STEP = 2 ** -20

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v)
const atOf = (ts) => { const t = typeof ts === 'string' ? Date.parse(ts) : NaN; return Number.isFinite(t) ? t : null }
const WIN_PATH = /^[A-Za-z]:[\\/]/
const ABSOLUTE = /^(?:[A-Za-z]:[\\/]|[\\/])/

/** A short digest of a line's text (as decoded): the line at an offset is still the one indexed */
const hashOf = (text) => crypto.createHash('sha1').update(Buffer.from(text, 'utf8')).digest('hex').slice(0, 16)

/**
 * The file as the panel names it (relative to the session folder with forward slashes, else as
 * recorded), the key it is found by, and whether it is outside the folder. The judgement and the key
 * are made on the path with `.` and `..` resolved by its text (never the disk), without case on Windows
 * and macOS; the name shown is still the recorded text (the final review's M5).
 */
function fileOf(raw, cwd, platform = process.platform) {
  const rel = relFile(raw, cwd, platform)
  const resolved = lexicalPath(rel)
  const outside = ABSOLUTE.test(rel) || resolved === '..' || resolved.startsWith('../')
  const name = ABSOLUTE.test(rel) ? rel : rel.replace(/\\/g, '/')
  const win = WIN_PATH.test(String(cwd ?? '')) || WIN_PATH.test(raw) || raw.includes('\\')
  return { name, key: win || platform === 'darwin' ? resolved.toLowerCase() : resolved, outside }
}

/**
 * The index. `line(obj, offset, src?, hash?)` takes one parsed line (src: 'main', or the sub-agent's id
 * for a line of its own file) and says whether anything changed.
 */
function createChangeIndex({ cwd, caps = CHANGE_CAPS, platform = process.platform } = {}) {
  /** tool_use id → { tool, file } of an edit call whose result has not come yet */
  const calls = new Map()
  /** file key → { name, outside, entries: Map<toolId, entry> } (least recently touched first) */
  const files = new Map()
  /** toolId → file key (the same id again replaces its entry) */
  const where = new Map()
  /** agent id → { anchor, k } (the order its edits are placed at) */
  const agents = new Map()
  let capped = false

  function reset() { calls.clear(); files.clear(); where.clear(); agents.clear(); capped = false }

  function remove(toolId) {
    const key = where.get(toolId)
    if (key === undefined) return
    where.delete(toolId)
    const f = files.get(key)
    if (!f) return
    f.entries.delete(toolId)
    if (!f.entries.size) files.delete(key)
  }

  function add(entry, raw) {
    const { name, key, outside } = fileOf(raw, cwd, platform)
    remove(entry.toolId)
    let f = files.get(key)
    if (f) files.delete(key)
    else f = { name, outside, entries: new Map() }
    // (re-inserted: the most recently touched file goes last; past the cap the least recently touched goes)
    files.set(key, f)
    f.entries.set(entry.toolId, entry)
    where.set(entry.toolId, key)
    if (f.entries.size > caps.editsPerFile) {
      let oldest = null
      for (const e of f.entries.values()) if (!oldest || e.order < oldest.order) oldest = e
      f.entries.delete(oldest.toolId)
      where.delete(oldest.toolId)
      capped = true
    }
    while (files.size > caps.files) {
      const [k, gone] = files.entries().next().value
      for (const id of gone.entries.keys()) where.delete(id)
      files.delete(k)
      capped = true
    }
  }

  /** The kind an edit is shown as */
  function kindOf(tool, r, diff) {
    if (tool === 'NotebookEdit') return 'notebook'
    if (diff) return diff.kind
    if (tool === 'Write') return isObj(r) && r.type === 'create' ? 'create' : 'write'
    return 'edit'
  }

  function onResult(block, obj, offset, src, hash) {
    const toolId = block.tool_use_id
    const r = obj.toolUseResult
    const call = calls.get(toolId)
    calls.delete(toolId)
    const rejected = r === REJECTED || obj.toolDenialKind === 'user-rejected'
    const stopped = isObj(r) && r.interrupted === true
    // (an edit that did not go through changed nothing)
    if (rejected || stopped || block.is_error === true) return false
    // an Agent call's result names its sub-agent: its own file is read later (main lines only)
    if (src === 'main' && isObj(r) && typeof r.agentId === 'string' && AGENT_ID.test(r.agentId) && !agents.has(r.agentId)) {
      agents.set(r.agentId, { anchor: offset, k: 0 })
    }
    const shaped = isObj(r) && typeof r.filePath === 'string' && r.filePath && ((Array.isArray(r.structuredPatch) && r.structuredPatch.length > 0) || r.type === 'create')
    if (!call && !shaped) return false
    const raw = isObj(r) && typeof r.filePath === 'string' && r.filePath ? r.filePath
      : isObj(r) && typeof r.notebook_path === 'string' && r.notebook_path ? r.notebook_path : call?.file
    if (typeof raw !== 'string' || !raw) return false
    // the line already indexed (a live line the scan counted): nothing changes
    const key = where.get(toolId)
    const prev = key !== undefined ? files.get(key)?.entries.get(toolId) : undefined
    if (prev && prev.src.file === src && prev.src.offset === offset) return false
    const diff = call && !['Edit', 'MultiEdit', 'Write'].includes(call.tool) ? null : buildDiff(r, { cwd })
    let order = offset
    if (src !== 'main') {
      const a = agents.get(src)
      order = prev && prev.src.file === src ? prev.order : (a ? a.anchor + (++a.k) * STEP : offset)
    }
    const entry = {
      toolId, order, at: atOf(obj.timestamp), kind: kindOf(call?.tool ?? null, r, diff),
      added: diff ? diff.added : null, removed: diff ? diff.removed : null,
      state: diff ? 'ok' : 'missing', cut: !!diff && (diff.truncated === true || diff.hidden > 0),
      src: { file: src, offset }, hash: hash ?? null,
    }
    if (src !== 'main') entry.agentId = src
    add(entry, raw)
    return true
  }

  function line(obj, offset, src = 'main', hash = null) {
    if (!isObj(obj) || !isObj(obj.message) || !Array.isArray(obj.message.content)) return false
    // a sidechain line in the main transcript is a sub-agent's (chatItems skips it there too)
    if (src === 'main' && obj.isSidechain === true) return false
    let changed = false
    if (obj.type === 'assistant') {
      for (const b of obj.message.content) {
        if (!isObj(b) || b.type !== 'tool_use' || typeof b.id !== 'string' || !EDIT_TOOLS.has(b.name)) continue
        const input = isObj(b.input) ? b.input : {}
        const file = typeof input.file_path === 'string' ? input.file_path : typeof input.notebook_path === 'string' ? input.notebook_path : null
        calls.delete(b.id)
        calls.set(b.id, { tool: b.name, file })
        if (calls.size > caps.calls) { calls.delete(calls.keys().next().value); capped = true }
      }
      return false
    }
    if (obj.type !== 'user') return false
    for (const b of obj.message.content) {
      if (isObj(b) && b.type === 'tool_result' && typeof b.tool_use_id === 'string' && onResult(b, obj, offset, src, hash)) changed = true
    }
    return changed
  }

  /** A file's entries in order: each source's own in its offsets' order, sources interleaved by time */
  function ordered(f) {
    const bySrc = new Map()
    for (const e of f.entries.values()) {
      if (!bySrc.has(e.src.file)) bySrc.set(e.src.file, [])
      bySrc.get(e.src.file).push(e)
    }
    const lists = [...bySrc.values()].map(l => l.sort((a, b) => a.src.offset - b.src.offset))
    if (lists.length === 1) return lists[0]
    const out = []
    const pos = lists.map(() => 0)
    for (;;) {
      let best = -1
      for (let i = 0; i < lists.length; i++) {
        if (pos[i] >= lists[i].length) continue
        if (best < 0) { best = i; continue }
        const a = lists[i][pos[i]]
        const b = lists[best][pos[best]]
        const ta = a.at ?? -Infinity
        const tb = b.at ?? -Infinity
        if (ta < tb || (ta === tb && a.order < b.order)) best = i
      }
      if (best < 0) return out
      out.push(lists[best][pos[best]++])
    }
  }

  function fileSummary(f, list = ordered(f)) {
    let added = 0
    let removed = 0
    let unknown = 0
    let cut = false
    let agent = false
    for (const e of list) {
      if (e.state === 'missing') unknown++
      else { added += e.added; removed += e.removed }
      if (e.cut) cut = true
      if (e.agentId) agent = true
    }
    return {
      file: f.name, outside: f.outside, created: list.length > 0 && list[0].kind === 'create',
      edits: list.length, added, removed, unknown, cut, agent, last: list.length ? list[list.length - 1].order : 0,
    }
  }

  function summary() {
    const s = { files: files.size, edits: 0, added: 0, removed: 0, unknown: 0, partial: capped }
    for (const f of files.values()) {
      for (const e of f.entries.values()) {
        s.edits++
        if (e.state === 'missing') s.unknown++
        else { s.added += e.added; s.removed += e.removed }
      }
    }
    return s
  }

  /** Every file, most recently changed first */
  function list() {
    return [...files.values()].map(f => fileSummary(f)).sort((a, b) => b.last - a.last)
  }

  /**
   * A file's newest `limit` edits (or the `limit` before the edit whose order is `before`), newest last,
   * and how many older ones there are; null for a file not in the index.
   */
  function editsOf(file, before, limit = caps.bodyEdits) {
    if (typeof file !== 'string' || !file) return null
    const f = files.get(fileOf(file, cwd, platform).key)
    if (!f) return null
    const all = ordered(f)
    let end = all.length
    if (typeof before === 'number' && Number.isFinite(before)) {
      const i = all.findIndex(e => e.order === before)
      end = i >= 0 ? i : all.filter(e => e.order < before).length
    }
    const start = Math.max(0, end - limit)
    return { file: fileSummary(f, all), edits: all.slice(start, end), more: start }
  }

  return {
    line, summary, files: list, editsOf, reset,
    /** the sub-agents the main transcript named, in the order it named them */
    agents: () => [...agents].map(([agentId, a]) => ({ agentId, anchor: a.anchor })),
    /** whether a result with this tool id is one the index waits for (the scan's pre-filter) */
    waits: (toolId) => calls.has(toolId),
  }
}

// ---- reading the transcript ---------------------------------------------------------------------

const NL = 0x0a
const NEEDLE_RESULT = Buffer.from('"toolUseResult"')
const NEEDLE_USE = Buffer.from('"tool_use"')
const EDIT_NAME = /"name":\s*"(?:Edit|MultiEdit|Write|NotebookEdit)"/
const PATCH = /"structuredPatch":\s*\[\s*\{|"type":\s*"create"|"agentId"/
const RESULT_ID = /"tool_use_id":\s*"([^"]{1,200})"/g

/**
 * A line worth parsing: an assistant line with an edit call, or a result line that answers a call the
 * index waits for, holds a patch, a created file or a sub-agent's id. Everything else (a Read's file
 * text, prose, bookkeeping) is passed over without decoding more than the check needs.
 */
function candidate(bytes, waiting) {
  if (bytes.indexOf(NEEDLE_RESULT) !== -1) {
    const text = bytes.toString('utf8')
    if (quickSkip(text)) return null
    if (PATCH.test(text)) return text
    for (const m of text.matchAll(RESULT_ID)) if (waiting(m[1])) return text
    return null
  }
  if (bytes.indexOf(NEEDLE_USE) !== -1) {
    const text = bytes.toString('utf8')
    return !quickSkip(text) && EDIT_NAME.test(text) ? text : null
  }
  return null
}

/**
 * The forward scan: `file` from `from` to `until` (the tail's end when the lens began; later lines
 * come through the lens's ingest), in 1 MB chunks on its own file handle, yielding every `yieldEvery`
 * bytes. Stops at `maxBytes` (partial), at a line longer than `lineBytes` (passed over: partial), or
 * when `signal.aborted`. `end` is where the next scan of the file starts (the first line not read whole).
 */
async function scanChanges(file, index, {
  fs = require('fs').promises, from = 0, until, src = 'main', yieldEvery = 2 << 20, maxBytes = CHANGE_CAPS.scanBytes,
  lineBytes = CHANGE_CAPS.lineBytes, chunk = 1 << 20, signal = null, pause = () => new Promise((r) => setImmediate(r)),
} = {}) {
  const h = await fs.open(file, 'r')
  let partial = false
  let changed = false
  let end = from
  try {
    const size = (await h.stat()).size
    const stop = typeof until === 'number' ? Math.min(until, size) : size
    const waiting = (id) => index.waits ? index.waits(id) : true
    let pos = from
    let carry = []        // the start of a line not ended yet (its chunks)
    let carryLen = 0
    let carryAt = from    // where it starts in the file
    let skipping = false  // inside a line longer than lineBytes
    let read = 0
    let since = 0
    while (pos < stop) {
      if (read >= maxBytes) { partial = true; break }
      const n = Math.min(chunk, stop - pos, maxBytes - read)
      const buf = Buffer.allocUnsafe(n)
      const { bytesRead } = await h.read(buf, 0, n, pos)
      if (!bytesRead) break
      const data = buf.subarray(0, bytesRead)
      const base = pos
      pos += bytesRead
      read += bytesRead
      let start = 0
      for (let i = data.indexOf(NL); i !== -1; i = data.indexOf(NL, start)) {
        if (skipping) { skipping = false }
        else {
          const piece = data.subarray(start, i)
          let bytes = carryLen ? Buffer.concat([...carry, piece]) : piece
          const offset = carryLen ? carryAt : base + start
          if (bytes.length && bytes[bytes.length - 1] === 0x0d) bytes = bytes.subarray(0, bytes.length - 1)
          const text = bytes.length ? candidate(bytes, waiting) : null
          if (text !== null) {
            let obj = null
            try { obj = JSON.parse(text) } catch { obj = null }
            if (obj && index.line(obj, offset, src, hashOf(text))) changed = true
          }
        }
        carry = []
        carryLen = 0
        start = i + 1
        carryAt = base + start
      }
      if (!skipping && start < data.length) {
        // (copied: the chunk's buffer is not kept)
        carry.push(Buffer.from(data.subarray(start)))
        carryLen += data.length - start
        if (carryLen > lineBytes) { skipping = true; partial = true; carry = []; carryLen = 0 }
      }
      since += bytesRead
      if (since >= yieldEvery) {
        since = 0
        await pause()
        if (signal && signal.aborted) return { end: carryAt, partial, changed, aborted: true }
      }
    }
    end = skipping ? pos : carryAt
  } finally {
    await h.close().catch(() => {})
  }
  return { end, partial, changed, aborted: false }
}

/**
 * One edit read again from its line: the line at `ref.src.offset` (at most `lineBytes`), its tool_result
 * for `ref.toolId`, the same digest as when indexed, then buildDiff — the block chatItems gives the row.
 * Anything else is `stale` (the record changed since); a guard that says the file changed is stale too.
 */
async function readEdit(file, ref, { fs = require('fs').promises, cwd, guard = null, lineBytes = CHANGE_CAPS.lineBytes, chunk = 1 << 20 } = {}) {
  if (ref.state === 'missing') return { state: 'missing' }
  if (guard && !(await guard())) return { state: 'stale' }
  let text = null
  try {
    const h = await fs.open(file, 'r')
    try {
      const parts = []
      let len = 0
      let pos = ref.src.offset
      for (;;) {
        const n = Math.min(chunk, lineBytes + 2 - len)
        if (n <= 0) break
        const buf = Buffer.allocUnsafe(n)
        const { bytesRead } = await h.read(buf, 0, n, pos)
        if (!bytesRead) break
        const data = buf.subarray(0, bytesRead)
        const i = data.indexOf(NL)
        if (i !== -1) { parts.push(data.subarray(0, i)); len += i; text = ''; break }
        parts.push(data)
        len += bytesRead
        pos += bytesRead
      }
      if (text !== null) {
        let bytes = Buffer.concat(parts)
        if (bytes.length && bytes[bytes.length - 1] === 0x0d) bytes = bytes.subarray(0, bytes.length - 1)
        text = bytes.toString('utf8')
      }
    } finally {
      await h.close().catch(() => {})
    }
  } catch {
    return { state: 'stale' }
  }
  if (!text) return { state: 'stale' }
  if (ref.hash && hashOf(text) !== ref.hash) return { state: 'stale' }
  let obj
  try { obj = JSON.parse(text) } catch { return { state: 'stale' } }
  const content = isObj(obj) && isObj(obj.message) && Array.isArray(obj.message.content) ? obj.message.content : []
  if (!content.some(b => isObj(b) && b.type === 'tool_result' && b.tool_use_id === ref.toolId)) return { state: 'stale' }
  const diff = buildDiff(obj.toolUseResult, { cwd })
  if (!diff || diff.added !== ref.added || diff.removed !== ref.removed) return { state: 'stale' }
  return { state: 'ok', diff }
}

module.exports = { CHANGE_CAPS, createChangeIndex, scanChanges, readEdit, fileOf, hashOf }
