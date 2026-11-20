'use strict'

/**
 * chatItems.cjs — Claude Code transcript lines become the chat view's items
 * (the read-only lens). The shapes are the event model of
 * src/chat/types.ts (mirrored in the @typedefs below).
 *
 * A builder is stateful only for pairing: a tool row is made by its tool_use
 * line and updated by its tool_result line, in either order (a result whose
 * call is on an older page comes first; when the call arrives the two merge
 * and the row takes the call's place). Items are keyed by the line's uuid
 * (+ the block's index when a line holds several), never by message.id, which
 * several lines share.
 *
 * Nothing large crosses: tool input is whitelisted per tool and capped, tool
 * output capped (CAPS), a Read result keeps only its line count, pictures are
 * counted and never copied. Pure apart from the pairing map: no IO.
 */

/**
 * @typedef {{ id: string, order: number, at: number | null, parent?: string }} ItemBase
 * @typedef {ItemBase & { kind: 'user', text: string, images: number, truncated?: boolean }} UserItem
 * @typedef {ItemBase & { kind: 'text', text: string, partial?: boolean, truncated?: boolean }} TextItem
 * @typedef {'running' | 'done' | 'failed' | 'rejected' | 'interrupted' | 'unknown'} ToolState
 * @typedef {{ file?: string, command?: string, description?: string, pattern?: string, path?: string, url?: string,
 *   query?: string, question?: string, options?: string[], plan?: string, todos?: { done: number, total: number },
 *   agentType?: string, background?: true, server?: string, mcpTool?: string, files?: string[] }} ToolInput
 * @typedef {{ text: string, lines: number, truncated: boolean, error: boolean }} ToolOutput
 * @typedef {{ t: '+' | '-' | ' ', old: number | null, new: number | null, text: string }} DiffLine
 * @typedef {{ oldStart: number, newStart: number, lines: DiffLine[] }} DiffHunk
 * @typedef {{ file: string, kind: 'edit' | 'create' | 'write', added: number, removed: number, hunks: DiffHunk[], hidden: number, truncated?: boolean }} DiffBlock
 * @typedef {ItemBase & { kind: 'tool', tool: string | null, input: ToolInput, state: ToolState,
 *   waiting?: 'permission' | 'question' | 'plan', output?: ToolOutput, diff?: DiffBlock, durationMs?: number,
 *   agentId?: string, agentTools?: number }} ToolItem
 * @typedef {ItemBase & { kind: 'notice', notice: 'interrupted' | 'command' | 'compact' | 'summary' | 'agent-done' | 'unknown-block' | 'model', text?: string }} NoticeItem
 * @typedef {ItemBase & { kind: 'turn-end', durationMs: number }} TurnEndItem
 * @typedef {ItemBase & { kind: 'live', text: string }} LiveItem
 * @typedef {ItemBase & { kind: 'shell', command: string, state: 'running' | 'done', stdout?: string, stderr?: string, truncated?: boolean }} ShellItem
 * @typedef {ItemBase & { kind: 'thinking', text: string, durationMs?: number, redacted?: boolean, truncated?: boolean, update?: boolean }} ThinkingItem
 * @typedef {UserItem | TextItem | ToolItem | NoticeItem | TurnEndItem | LiveItem | ThinkingItem} ChatItem
 */

/** The one source of limits for what an item may hold */
const CAPS = Object.freeze({ text: 200_000, output: 8_000, outputLines: 200, command: 2_000, plan: 20_000, field: 400, diffLines: 600, diffLine: 2_000, diffText: 200_000 })

/** order for hook-only items not yet in the transcript (LIVE_BASE + n) and for the provisional bubble */
const LIVE_BASE = 2 ** 52
const LIVE_ORDER = Number.MAX_SAFE_INTEGER

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v)
const cut = (s, n) => (s.length > n ? s.slice(0, n) : s)
const str = (v, n) => (typeof v === 'string' ? cut(v, n) : undefined)
const atOf = (ts) => { const t = typeof ts === 'string' ? Date.parse(ts) : NaN; return Number.isFinite(t) ? t : null }
/** An object without its undefined fields (so an item's JSON has only what it holds) */
const clean = (o) => { for (const k of Object.keys(o)) if (o[k] === undefined) delete o[k]; return o }

/**
 * A file path relative to the session folder when inside it (forward slashes),
 * else as it is. String work only, nothing read from the disk: `.` and `..` are
 * resolved by the text first (C:/proj/../etc/x is outside
 * C:/proj, not "../etc/x" inside it); a Windows path, or any path on macOS,
 * compares without case.
 */
function relFile(file, cwd, platform = process.platform) {
  if (typeof file !== 'string') return undefined
  if (typeof cwd !== 'string' || !cwd) return file
  const f = lexicalPath(file)
  const c = lexicalPath(cwd).replace(/\/+$/, '')
  if (!c) return file
  const inside = foldsCase(c, platform) ? f.toLowerCase().startsWith(`${c.toLowerCase()}/`) : f.startsWith(`${c}/`)
  return inside ? f.slice(c.length + 1) : file
}

/**
 * A path with forward slashes and `.` / `..` resolved by its text alone (never the disk: a link is not
 * followed). A `..` above an absolute root goes, as the system does; one at the start of a relative path stays.
 */
function lexicalPath(p) {
  const s = String(p).replace(/\\/g, '/')
  const root = /^(?:\/\/[^/]+\/[^/]+(?:\/|$)|[A-Za-z]:\/|\/)/.exec(s)?.[0] ?? ''
  const out = []
  for (const part of s.slice(root.length).split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') {
      if (out.length && out[out.length - 1] !== '..') out.pop()
      else if (!root) out.push('..')
      continue
    }
    out.push(part)
  }
  return root + out.join('/')
}

/** Whether paths are told apart without case: a Windows path (a drive letter), or any path on macOS (its default disk) */
const foldsCase = (p, platform = process.platform) => /^[A-Za-z]:\//.test(String(p).replace(/\\/g, '/')) || platform === 'darwin'

/** The whitelisted, capped excerpt of a tool call's input the page may show (never the whole input) */
function toolInput(name, input, cwd, caps = CAPS) {
  if (!isObj(input)) return {}
  const f = (v) => str(v, caps.field)
  switch (name) {
    case 'Read': case 'Write': case 'Edit': case 'MultiEdit':
      return clean({ file: f(relFile(input.file_path, cwd)) })
    case 'NotebookEdit': case 'NotebookRead':
      return clean({ file: f(relFile(input.notebook_path ?? input.file_path, cwd)) })
    case 'Bash': case 'PowerShell':
      return clean({ command: str(input.command, caps.command), description: f(input.description) })
    case 'Grep':
      return clean({ pattern: f(input.pattern), path: f(relFile(input.path, cwd)) })
    case 'Glob':
      return clean({ pattern: f(input.pattern) })
    case 'WebFetch':
      return clean({ url: f(input.url) })
    case 'WebSearch':
      return clean({ query: f(input.query) })
    case 'Agent': case 'Task':
      return clean({ description: f(input.description), agentType: f(input.subagent_type), background: input.run_in_background === true ? true : undefined })
    case 'AskUserQuestion': {
      const q = Array.isArray(input.questions) ? input.questions[0] : null
      if (!isObj(q)) return {}
      const options = Array.isArray(q.options) ? q.options.slice(0, 6).map(o => f(isObj(o) ? o.label : undefined)).filter(Boolean) : undefined
      return clean({ question: f(q.question), options: options?.length ? options : undefined })
    }
    case 'ExitPlanMode':
      return clean({ plan: str(input.plan, caps.plan) })
    case 'TodoWrite':
      return Array.isArray(input.todos) ? { todos: { done: input.todos.filter(t => isObj(t) && t.status === 'completed').length, total: input.todos.length } } : {}
    // the files Claude sent the user: their paths (the chat shows the pictures among them)
    case 'SendUserFile': {
      const files = Array.isArray(input.files) ? input.files.filter(x => typeof x === 'string' && x).slice(0, 6).map(f) : []
      return files.length ? { files } : {}
    }
    default: {
      const m = typeof name === 'string' ? /^mcp__(.+?)__(.+)$/.exec(name) : null
      return m ? { server: cut(m[1], caps.field), mcpTool: cut(m[2], caps.field) } : {}
    }
  }
}

/** The text of a tool_result's content: a string, or its text blocks joined (pictures are skipped) */
function resultText(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.filter(b => isObj(b) && b.type === 'text' && typeof b.text === 'string').map(b => b.text).join('\n')
}

/** A Read result: the file's text is never sent, only how many lines were read */
const isReadResult = (name, result) => (name === 'Read' || name == null) && isObj(result) && isObj(result.file)

/**
 * A tool result's output, capped at CAPS.output characters and CAPS.outputLines
 * lines; `lines` is the full count and `truncated` says something was cut.
 */
function toolOutput(content, toolUseResult, isError, name = null, caps = CAPS) {
  const error = isError === true
  if (!error && isReadResult(name, toolUseResult)) {
    const n = Number(toolUseResult.file.numLines)
    return { text: '', lines: Number.isFinite(n) && n >= 0 ? n : 0, truncated: false, error }
  }
  const full = resultText(content)
  if (!full) return { text: '', lines: 0, truncated: false, error }
  const all = full.split('\n')
  // a Read never sends the file's text, whatever shape its result has (only an error is shown)
  if (!error && name === 'Read') return { text: '', lines: all.length, truncated: false, error }
  let text = all.length > caps.outputLines ? all.slice(0, caps.outputLines).join('\n') : full
  text = cut(text, caps.output)
  return { text, lines: all.length, truncated: text.length < full.length, error }
}

const isCount = (v) => typeof v === 'number' && Number.isInteger(v) && v >= 0
const validHunk = (h) => isObj(h) && isCount(h.oldStart) && isCount(h.oldLines) && isCount(h.newStart) && isCount(h.newLines)
  && Array.isArray(h.lines) && h.lines.every(l => typeof l === 'string')

/**
 * A diff block from an Edit/MultiEdit/Write result (its toolUseResult), from
 * the transcript alone — the disk is never read:
 *   edit    a non-empty structuredPatch whose every hunk is well formed
 *   create  `type: 'create'` with the new file's content (every line added)
 *   write   `type: 'update'` (a Write over a file) with a valid structuredPatch
 * Anything else is null: the row then shows no counts, nothing is invented.
 * `added` / `removed` count every line; lines past `maxLines` are not sent and
 * are counted in `hidden`. `file` is relative to `cwd` when inside it, with
 * forward slashes, else the path as recorded.
 */
function buildDiff(r, { cwd, maxLines = CAPS.diffLines, maxLine = CAPS.diffLine, maxText = CAPS.diffText } = {}) {
  if (!isObj(r) || typeof r.filePath !== 'string' || !r.filePath) return null
  // (outside the folder: the path as recorded, as the changes panel names it; chatChanges.cjs fileOf)
  const rel = relFile(r.filePath, cwd)
  const file = /^(?:[A-Za-z]:[\\/]|[\\/])/.test(rel) ? rel : rel.replace(/\\/g, '/')
  // What is sent is capped three ways: lines (maxLines), one line's text (maxLine), the block's text
  // (maxText). The rest is still counted (added / removed / hidden) and `truncated` says something was cut.
  let shown = 0
  let chars = 0
  let hidden = 0
  let truncated = false
  let full = false // the block's text cap reached: every later line is hidden
  const keep = (line, into) => {
    if (line.text.length > maxLine) { line.text = line.text.slice(0, maxLine); truncated = true }
    if (!full && chars + line.text.length > maxText) { full = true; truncated = true }
    if (full || shown >= maxLines) { hidden++; return }
    chars += line.text.length
    shown++
    into.push(line)
  }
  const done = (block) => (truncated ? { ...block, truncated: true } : block)
  if (r.type === 'create') {
    if (typeof r.content !== 'string') return null
    const all = r.content === '' ? [] : r.content.split('\n')
    if (all.length && all[all.length - 1] === '') all.pop() // the file's last newline
    const lines = []
    all.forEach((text, i) => keep({ t: '+', old: null, new: i + 1, text: text.replace(/\r$/, '') }, lines))
    return done({ file, kind: 'create', added: all.length, removed: 0, hunks: lines.length ? [{ oldStart: 0, newStart: 1, lines }] : [], hidden })
  }
  const patch = r.structuredPatch
  if (!Array.isArray(patch) || !patch.length || !patch.every(validHunk)) return null
  let added = 0
  let removed = 0
  const hunks = []
  for (const h of patch) {
    let oldNo = h.oldStart
    let newNo = h.newStart
    const lines = []
    for (const raw of h.lines) {
      if (raw.startsWith('\\')) continue // "\ No newline at end of file"
      const t = raw === '' ? ' ' : raw[0]
      if (t !== '+' && t !== '-' && t !== ' ') return null
      const line = { t, old: t === '+' ? null : oldNo, new: t === '-' ? null : newNo, text: raw.slice(1).replace(/\r$/, '') }
      if (t !== '+') oldNo++
      if (t !== '-') newNo++
      if (t === '+') added++
      if (t === '-') removed++
      keep(line, lines)
    }
    if (lines.length) hunks.push({ oldStart: h.oldStart, newStart: h.newStart, lines })
  }
  return done({ file, kind: r.type === 'update' ? 'write' : 'edit', added, removed, hunks, hidden })
}

const DIFF_TOOLS = new Set(['Edit', 'MultiEdit', 'Write'])

const REJECTED = 'User rejected tool use'

/**
 * How Claude Code's compaction summary begins (a user line, marked isCompactSummary): the
 * conversation carried on from a summary. Also known by these words, should the mark be missing.
 */
const COMPACT_SUMMARY = 'This session is being continued from a previous conversation'

/**
 * The command a slash-command line names ("/clear", "/model haiku"), or null. Only a line
 * that is a command (it starts with its tags), never a prompt that merely mentions the tag.
 */
function commandOf(text) {
  if (!/^\s*<command-(name|message)>/.test(text)) return null
  const m = /<command-name>([\s\S]*?)<\/command-name>/.exec(text)
  if (!m) return null
  const args = /<command-args>([\s\S]*?)<\/command-args>/.exec(text)?.[1]?.trim()
  return cut(`${m[1].trim()}${args ? ` ${args}` : ''}`, CAPS.field)
}

/**
 * A long paste is recorded wrapped (Claude Code 2.1.325, seen on a real session):
 * `\n\n<pasted_content id="fe19">\n…\n</pasted_content id="fe19">\n`. The user's text is what is
 * inside; a prompt that merely mentions the word (no opening tag with an id) is left as it is.
 */
const PASTED_OPEN = /\n*<pasted_content id="[^"\n]{1,40}">\n?/g
const PASTED_CLOSE = /\n?<\/pasted_content(?: id="[^"\n]{1,40}")?>/g
function unwrapPasted(text) {
  const s = String(text ?? '')
  if (!/<pasted_content id="[^"\n]{1,40}">/.test(s)) return s
  return s.replace(PASTED_OPEN, '').replace(PASTED_CLOSE, '').trim()
}

/**
 * A `!` command (Claude Code's bash mode) is recorded as two user lines: `<bash-input>ls</bash-input>`, then
 * `<bash-stdout>…</bash-stdout><bash-stderr>…</bash-stderr>` (the output HTML-escaped). The view shows them as one
 * shell row: the second line updates the first's item.
 */
const BASH_INPUT = /^<bash-input>([\s\S]*?)<\/bash-input>\s*$/
const BASH_OUTPUT = /^<bash-stdout>([\s\S]*?)<\/bash-stdout>\s*(?:<bash-stderr>([\s\S]*?)<\/bash-stderr>)?\s*$/
const NO_OUTPUT = '(Bash completed with no output)'
function unescapeHtml(s) {
  return String(s ?? '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&')
}

/**
 * The pairing builder. `parent` (a sub-agent's Agent row id): sidechain lines
 * are built, each item carrying it (tools and prose only); without it
 * sidechain lines are skipped.
 */
function createItemBuilder({ cwd, caps = CAPS, parent } = {}) {
  /** @type {Map<string, ToolItem>} */
  const tools = new Map()
  const out = (item) => (parent ? { ...item, parent } : { ...item })
  /** the last `!` command's row, which its output line completes */
  let shell = null

  /** A user message or what its text stands for (a notice), or nothing */
  function userText(raw, images, id, order, at, summary = false) {
    const text = unwrapPasted(raw)
    const t = text.trimStart()
    // the summary a compaction carries the conversation on with: a quiet notice, never a user message
    if (summary || t.startsWith(COMPACT_SUMMARY)) return { id, order, at, kind: 'notice', notice: 'summary' }
    if (t.startsWith('<system-reminder>')) return null
    if (t.startsWith('[Request interrupted by user')) return { id, order, at, kind: 'notice', notice: 'interrupted' }
    const command = commandOf(t)
    if (command) return { id, order, at, kind: 'notice', notice: 'command', text: command }
    const input = BASH_INPUT.exec(t)
    if (input) {
      shell = { id, order, at, kind: 'shell', command: cut(unescapeHtml(input[1]).trim(), caps.field), state: 'running' }
      return shell
    }
    const output = BASH_OUTPUT.exec(t)
    if (output) {
      if (!shell) return null
      const stdout = unescapeHtml(output[1]).replace(NO_OUTPUT, '').replace(/\s+$/, '')
      const stderr = unescapeHtml(output[2] ?? '').replace(/\s+$/, '')
      const so = cut(stdout, caps.text)
      const se = cut(stderr, caps.text)
      shell = clean({ ...shell, state: 'done', stdout: so || undefined, stderr: se || undefined, truncated: so.length < stdout.length || se.length < stderr.length ? true : undefined })
      return shell
    }
    if (t.startsWith('<local-command-')) return null
    if (t.startsWith('<task-notification>')) return { id, order, at, kind: 'notice', notice: 'agent-done' }
    if (!text && !images) return null
    const capped = cut(text, caps.text)
    return clean({ id, order, at, kind: 'user', text: capped, images, truncated: capped.length < text.length ? true : undefined })
  }

  /** A tool_result: the row it belongs to, updated (made when its call was not seen yet) */
  function result(block, obj, order, at) {
    const id = block.tool_use_id
    const r = obj.toolUseResult
    const rejected = r === REJECTED || obj.toolDenialKind === 'user-rejected'
    // a command stopped by Esc says so in its result (Bash: interrupted), not as a failure
    const stopped = isObj(r) && r.interrupted === true
    const state = rejected ? 'rejected' : stopped ? 'interrupted' : block.is_error === true ? 'failed' : 'done'
    let item = tools.get(id)
    if (!item) {
      item = { id, order, at, kind: 'tool', tool: null, input: {}, state }
      tools.set(id, item)
    }
    item.state = state
    item.output = toolOutput(block.content, r, block.is_error === true || rejected, item.tool, caps)
    if (isObj(r) && typeof r.agentId === 'string' && r.agentId) item.agentId = cut(r.agentId, caps.field)
    // an edit that went through: its diff (a row whose call is not seen yet is judged by the result's shape)
    if (state === 'done' && (item.tool === null || DIFF_TOOLS.has(item.tool))) {
      const diff = buildDiff(r, { cwd, maxLines: caps.diffLines, maxLine: caps.diffLine, maxText: caps.diffText })
      if (diff) item.diff = diff
    }
    delete item.waiting
    return item
  }

  /** A tool_use: its row (merged into the one its result made, if that came first) */
  function call(block, order, at) {
    const input = toolInput(block.name, block.input, cwd, caps)
    let item = tools.get(block.id)
    if (item) {
      Object.assign(item, { order, at, tool: block.name, input })
      // a result read before its call: once it is known to be a Read, its text goes (only an error stays)
      if (block.name === 'Read' && item.output && !item.output.error) item.output = { ...item.output, text: '', truncated: false }
      return item
    }
    item = { id: block.id, order, at, kind: 'tool', tool: block.name, input, state: 'running' }
    tools.set(block.id, item)
    return item
  }

  /** @returns {ChatItem[]} the items this line makes or changes (complete, for an upsert) */
  function line(obj, order) {
    if (!isObj(obj)) return []
    if (obj.isSidechain === true ? !parent : false) return []
    const at = atOf(obj.timestamp)
    const uuid = typeof obj.uuid === 'string' ? obj.uuid : null
    const items = []
    if (obj.type === 'user') {
      const msg = obj.message
      if (!isObj(msg) || !uuid) return []
      const content = msg.content
      const summary = obj.isCompactSummary === true
      const meta = !summary && (obj.isMeta === true || obj.turnCompanion === true)
      if (typeof content === 'string') {
        if (!meta && !parent) { const it = userText(content, 0, uuid, order, at, summary); if (it) items.push(it) }        return items.map(out)
      }
      if (!Array.isArray(content)) return []
      const texts = []
      let images = 0
      for (const block of content) {
        if (!isObj(block)) continue
        if (block.type === 'tool_result' && typeof block.tool_use_id === 'string') items.push(result(block, obj, order, at))
        else if (block.type === 'text' && typeof block.text === 'string') texts.push(block.text)
        else if (block.type === 'image') images++
      }
      if (!meta && !parent && (texts.length || images || summary)) { const it = userText(texts.join('\n'), images, uuid, order, at, summary); if (it) items.push(it) }
      return items.map(out)
    }
    if (obj.type === 'assistant') {
      const msg = obj.message
      if (!isObj(msg) || !uuid) return []
      const content = typeof msg.content === 'string' ? [{ type: 'text', text: msg.content }] : msg.content
      if (!Array.isArray(content)) return []
      const partial = msg.stop_reason === null
      const many = content.length > 1
      content.forEach((block, i) => {
        if (!isObj(block)) return
        const id = many ? `${uuid}:${i}` : uuid
        // several items of one line keep their order: the block index as a fraction of the offset
        const o = order + (i ? i / 1024 : 0)
        switch (block.type) {
          case 'text': {
            if (typeof block.text !== 'string' || !block.text.trim()) return
            const text = cut(block.text, caps.text)
            items.push(clean({ id, order: o, at, kind: 'text', text, partial: partial || undefined, truncated: text.length < block.text.length ? true : undefined }))
            return
          }
          case 'tool_use':
            if (typeof block.id === 'string' && typeof block.name === 'string') items.push(call(block, o, at))
            return
          case 'thinking': case 'redacted_thinking': {
            // shown from 생각 포함. Claude Code 2.1.32x writes the text empty (FINDINGS §1): '' then,
            // and the row says the content is not in the record. A redacted block's data never travels.
            // A sub-agent's thinking makes no item: its rows show only its tools and its result.
            if (parent) return
            const raw = block.type === 'thinking' && typeof block.thinking === 'string' ? block.thinking : ''
            const text = cut(raw, caps.text)
            const ms = obj.thinkingDurationMs
            items.push(clean({
              id, order: o, at, kind: 'thinking', text,
              durationMs: typeof ms === 'number' && Number.isFinite(ms) && ms >= 0 ? ms : undefined,
              redacted: block.type === 'redacted_thinking' ? true : undefined,
              truncated: text.length < raw.length ? true : undefined,
              // thinkingDisplay "updates": a block with text is the progress note the terminal shows (the hidden
              // thinking is written empty); the chat shows it in 기본 too
              update: obj.thinkingDisplay === 'updates' && raw.trim() && block.type === 'thinking' ? true : undefined,
            }))
            return
          }
          default:
            if (!parent) items.push({ id, order: o, at, kind: 'notice', notice: 'unknown-block' })
        }
      })
      return items.map(out)
    }
    // a prompt sent while Claude worked, taken into the running turn: the user's message where it was taken
    // (only a typed prompt: a background task's notice or a queued command is not the user's message)
    if (obj.type === 'attachment' && !parent && obj.isSidechain !== true && uuid) {
      const a = obj.attachment
      if (!isObj(a) || a.type !== 'queued_command' || a.commandMode !== 'prompt') return []
      if (isObj(a.origin) && a.origin.kind !== 'human') return []
      let text = ''
      let images = 0
      if (typeof a.prompt === 'string') text = a.prompt
      else if (Array.isArray(a.prompt)) {
        const texts = []
        for (const block of a.prompt) {
          if (isObj(block) && block.type === 'text' && typeof block.text === 'string') texts.push(block.text)
          else if (isObj(block) && block.type === 'image') images++
        }
        text = texts.join('\n')
      } else return []
      const it = userText(text, images, uuid, order, at)
      return it && it.kind === 'user' ? [out(it)] : []
    }
    if (obj.type === 'system' && !parent) {
      const id = uuid ?? `system:${order}`
      const sub = typeof obj.subtype === 'string' ? obj.subtype : ''
      if (sub === 'turn_duration') {
        const ms = Number(obj.durationMs)
        return [{ id, order, at, kind: 'turn-end', durationMs: Number.isFinite(ms) && ms >= 0 ? ms : 0 }]
      }
      if (sub.includes('compact')) return [{ id, order, at, kind: 'notice', notice: 'compact' }]
      if (sub === 'local_command') {
        const command = typeof obj.content === 'string' ? commandOf(obj.content) : null
        return command ? [{ id, order, at, kind: 'notice', notice: 'command', text: command }] : []
      }
    }
    return []
  }

  return { line, tool: (id) => tools.get(id), forget: (id) => { tools.delete(id) } }
}

// ---- the chat's buttons: what a permission card shows, and the rules 항상 허용 may add

const RULES_MAX = 4
const RULE_TEXT_MAX = 2000
/** The most lines a card's diff holds (in a box of its own scroll); more, and the card is not answerable */
const CARD_DIFF_LINES = 400

/**
 * The rules "always allow" may add, from the hook's own suggestions: only `addRules` entries that
 * allow, each rule `{ toolName, ruleContent? }` of plain strings; deduplicated; none when there are
 * more than four, or anything does not fit. `setMode`, `addDirectories` and anything unknown are not
 * used (Decision 17). The suggestion's destination is never carried: chatHolds.cjs sets its own.
 */
function sessionRules(suggestions) {
  if (!Array.isArray(suggestions)) return []
  const out = []
  const seen = new Set()
  for (const s of suggestions) {
    if (!isObj(s) || s.type !== 'addRules' || s.behavior !== 'allow' || !Array.isArray(s.rules)) continue
    for (const r of s.rules) {
      if (!isObj(r) || typeof r.toolName !== 'string' || !r.toolName || r.toolName.length > RULE_TEXT_MAX) return []
      if (r.ruleContent !== undefined && (typeof r.ruleContent !== 'string' || r.ruleContent.length > RULE_TEXT_MAX)) return []
      const rule = r.ruleContent === undefined ? { toolName: r.toolName } : { toolName: r.toolName, ruleContent: r.ruleContent }
      const k = JSON.stringify(rule)
      if (seen.has(k)) continue
      seen.add(k)
      out.push(rule)
    }
  }
  return out.length > RULES_MAX ? [] : out
}

/** Tools that change files: no 항상 허용 in this phase (a session rule for edits is not verified) */
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])

/**
 * The rules 항상 허용 may add for a request of `tool`: the hook's own addRules
 * suggestions, and only when every one of them is a plain allow rule, every rule names the requesting
 * tool itself (never an edit tool), and every rule has real content — no bare tool (every call of it),
 * no lone wildcard (`*`, `:*`, an empty prefix). A suggestion that changes the mode, adds a directory or
 * is anything else means none: the terminal's own option would do more than the rule shown. Else [].
 */
function alwaysRules(tool, suggestions) {
  if (typeof tool !== 'string' || !tool || EDIT_TOOLS.has(tool)) return []
  if (!Array.isArray(suggestions) || !suggestions.length) return []
  if (suggestions.some(s => !isObj(s) || s.type !== 'addRules' || s.behavior !== 'allow')) return []
  const rules = sessionRules(suggestions)
  for (const r of rules) {
    if (r.toolName !== tool) return []
    if (typeof r.ruleContent !== 'string' || /^[\s*:]*$/.test(r.ruleContent)) return []
  }
  return rules
}

/** A rule as Claude Code writes it: Tool(content), or the tool alone */
const ruleLabel = (rules) => rules.map(r => (r.ruleContent === undefined ? r.toolName : `${r.toolName}(${r.ruleContent})`)).join(', ')

/**
 * The lines of a text (its last newline is not a line of its own). A CR stays in its line: the card
 * shows it as a mark, so a change of line endings is never invisible.
 */
function splitLines(text) {
  const all = text === '' ? [] : text.split('\n')
  if (all.length && all[all.length - 1] === '') all.pop()
  return all
}

/**
 * What a permission request would change, for its card: an Edit's old → new text as a line diff
 * (longest common subsequence), a Write's new file as added lines. Undefined for other tools; null
 * when it cannot be shown whole (over CARD_DIFF_LINES lines, a line over CAPS.diffLine): the card
 * is then answered in the terminal.
 */
function permissionDiff(tool, input, cwd) {
  if (tool !== 'Edit' && tool !== 'Write') return undefined
  if (!isObj(input) || typeof input.file_path !== 'string' || !input.file_path) return null
  const file = relFile(input.file_path, cwd).replace(/\\/g, '/')
  const tooLong = (ls) => ls.length > CARD_DIFF_LINES || ls.some(l => l.length > CAPS.diffLine)
  if (tool === 'Write') {
    if (typeof input.content !== 'string') return null
    const lines = splitLines(input.content)
    if (tooLong(lines)) return null
    return { file, kind: 'create', added: lines.length, removed: 0, hunks: lines.length ? [{ oldStart: 0, newStart: 1, lines: lines.map((text, i) => ({ t: '+', old: null, new: i + 1, text })) }] : [], hidden: 0 }
  }
  if (typeof input.old_string !== 'string' || typeof input.new_string !== 'string') return null
  const a = splitLines(input.old_string)
  const b = splitLines(input.new_string)
  if (tooLong(a) || tooLong(b)) return null
  // the longest common subsequence, from the end (at most 400 × 400); a replaced block reads − then +
  const n = a.length
  const m = b.length
  const L = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1))
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i][j] = a[i] === b[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1])
  const lines = []
  let i = 0
  let j = 0
  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j]) { lines.push({ t: ' ', old: i + 1, new: j + 1, text: a[i] }); i++; j++ }
    else if (i < n && (j >= m || L[i + 1][j] >= L[i][j + 1])) { lines.push({ t: '-', old: i + 1, new: null, text: a[i] }); i++ }
    else { lines.push({ t: '+', old: null, new: j + 1, text: b[j] }); j++ }
  }
  if (lines.length > CARD_DIFF_LINES) return null
  const added = lines.filter(l => l.t === '+').length
  const removed = lines.filter(l => l.t === '-').length
  // a newline added or taken at the very end: no line shows it, so the card says it
  const endsA = input.old_string.endsWith('\n')
  const endsB = input.new_string.endsWith('\n')
  const eol = endsA === endsB ? {} : { eol: endsB ? 'added' : 'removed' }
  return { file, kind: 'edit', added, removed, hunks: lines.length ? [{ oldStart: 1, newStart: 1, lines }] : [], hidden: 0, ...eol }
}

module.exports = { resultText, sessionRules, alwaysRules, EDIT_TOOLS, ruleLabel, permissionDiff, CARD_DIFF_LINES, CAPS, LIVE_BASE, LIVE_ORDER, createItemBuilder, toolInput, toolOutput, buildDiff, relFile, lexicalPath, foldsCase, unwrapPasted }
