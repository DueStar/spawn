/**
 * Safe markdown for the chat view (Phase 2): the assistant's prose becomes a small
 * typed tree that src/components/chat/Markdown.tsx turns into React elements.
 * There is no HTML path anywhere: raw HTML (`<div>`, `<img …>`, `<script>`) stays
 * literal text, entities are not decoded, an image `![alt](url)` is a link whose
 * text is the alt (nothing is ever loaded), and a link whose address is not
 * http(s) — or holds a space, a quote or a hidden character — stays plain text.
 * Links open only through the app (terminals.openUrl, http/https in main).
 *
 * The subset is what Claude Code prints: headings, paragraphs (line breaks kept,
 * as the terminal shows them), lists (nested by indentation, at most 4 levels),
 * fenced code (``` and ~~~; an unclosed fence runs to the end, which the live
 * bubble needs), GFM tables, quotes, rules; inline code, strong, em, del, links,
 * bare http(s) addresses and file paths with a known extension.
 *
 * Bounded work: the input is cut at MD_CAP characters (the tree then ends with a
 * `cut` block, which the renderer says aloud), and every scan is linear — closers
 * come from tables built once per paragraph, failed searches are remembered, and
 * no regular expression with nested quantifiers runs over unbounded text.
 * Nesting stops at 4 list levels and 8 quote levels.
 */

export type Inline =
  | { type: 'text'; text: string }
  | { type: 'code'; text: string }
  | { type: 'strong'; children: Inline[] }
  | { type: 'em'; children: Inline[] }
  | { type: 'del'; children: Inline[] }
  | { type: 'link'; href: string; children: Inline[] }
  | { type: 'autolink'; href: string }
  | { type: 'path'; file: string; line?: number; col?: number; text: string }
  | { type: 'br' }

export type Align = 'left' | 'center' | 'right' | null

export type Block =
  | { type: 'heading'; level: 1 | 2 | 3 | 4; inline: Inline[] }
  | { type: 'para'; inline: Inline[] }
  | { type: 'list'; ordered: boolean; start: number; items: Block[][] }
  | { type: 'code'; lang: string; text: string }
  | { type: 'table'; align: Align[]; head: Inline[][]; rows: Inline[][][] }
  | { type: 'quote'; blocks: Block[] }
  | { type: 'hr' }
  /** The input was longer than MD_CAP: what follows was not shown */
  | { type: 'cut' }

/** The most characters parsed (the lens caps a message at the same 200 000) */
export const MD_CAP = 200_000
const MAX_LIST_DEPTH = 4
const MAX_QUOTE_DEPTH = 8
/** A table's most columns (a wider one is cut) */
const MAX_COLS = 32

// ------------------------------------------------------------------ characters

/** Hidden or direction-changing characters: never inside an address or a path */
const HIDDEN = /[\u0000-\u001f\u007f­؜᠎​-‏‪-‮⁠-⁤⁦-⁩﻿]/
const isSpace = (c: string | undefined) => c === undefined || c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f' || c === '\v' || c === ' '
const isWordChar = (c: string | undefined) => !!c && /[\p{L}\p{N}]/u.test(c)
const ASCII_PUNCT = '!"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~'

// ------------------------------------------------------------------ links and paths

/** An address a link may open: http(s), no space, no quote or angle bracket, nothing hidden */
export function safeHref(raw: string): string | null {
  if (raw.length > 4096) return null
  if (!/^https?:\/\/[^/?#\s]/i.test(raw)) return null
  if (HIDDEN.test(raw) || /[\s"'<>`\\]/.test(raw)) return null
  try {
    const u = new URL(raw)
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null
  } catch { return null }
  return raw
}

// (a bare address also ends at Hangul, kana, Han or CJK punctuation: Korean glues 에서 / 를 / 은 to it.
// The trade-off, accepted: a bare address with Korean or Japanese in its path, such as
// https://ko.wikipedia.org/wiki/한국어, links only up to /wiki/ — written as <…> or [text](…) it is whole)
const URL_STOP = /[\s<>"'`\u0000-\u001f\u007f\u00ad\u061c\u180e\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff\u3000-\u303f\uff00-\uffef\p{Script=Hangul}\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u

/** The longest bare address taken (a longer one stays text) */
const MAX_URL = 4096

/**
 * A bare address starting at i (http:// or https://), its end; trailing punctuation and an
 * unmatched ")" left out. `runEnd` is where the run of address characters from i stops (the
 * caller computes it once per run, so a long run is scanned once, not once per "http" in it).
 */
function autolinkAt(s: string, i: number, runEnd: number): number {
  const rest = s.startsWith('https://', i) ? 8 : s.startsWith('http://', i) ? 7 : 0
  if (!rest) return -1
  if (i > 0 && (isWordChar(s[i - 1]) || s[i - 1] === '/')) return -1
  if (runEnd - i > MAX_URL) return -1
  let j = runEnd
  // trailing punctuation is the sentence's, a ")" without its "(" is the prose's
  let open = 0, close = 0
  for (let k = i; k < j; k++) { if (s[k] === '(') open++; else if (s[k] === ')') close++ }
  while (j > i + rest) {
    const c = s[j - 1]
    if ('.,;:!?*_~'.includes(c)) { j--; continue }
    if (c === ')' && close > open) { j--; close--; continue }
    break
  }
  if (j <= i + rest) return -1
  return safeHref(s.slice(i, j)) ? j : -1
}

const EXT = 'tsx|ts|jsx|js|mjs|cjs|json|jsonl|md|mdx|py|rs|go|java|kt|kts|swift|c|h|cc|cpp|hpp|cs|rb|php|css|scss|sass|less|html|htm|vue|svelte|yml|yaml|toml|ini|sh|bash|zsh|ps1|psm1|bat|cmd|sql|txt|xml|gradle|lua|dart|ex|exs|erl|hs|ml|scala|clj|r|pl|env|lock|cfg|conf|gitignore|dockerfile'
/**
 * One token (≤ 300 characters, no space): a file path with a folder or a line. A UNC or
 * device path (\\host\share\…, \\?\…, \\.\…) is read whole — so its backslashes stay — but it
 * stays plain text, never a chip: a click would make Windows connect to that host
 * (electron/links.cjs refuses one too).
 */
const PATH_RE = new RegExp(String.raw`^((?:[A-Za-z]:[\\/]|\\\\)?(?:\.{1,2}[\\/])?(?:[\w.@\-\[\]()]+[\\/])*[\w.@\-]+\.(?:${EXT}))(?::(\d{1,7})(?::(\d{1,5}))?)?(?![\w])`, 'i')
const PATH_LEAD = /^[(\[{'"“‘<]+/

/** A UNC share or a device path (two slashes of either kind first): never a chip, never opened */
export function isRemotePath(file: string): boolean {
  return /^[\\/]{2}/.test(file)
}

/** Text with file paths taken out as path chips */
function withPaths(text: string, out: Inline[]) {
  if (!text.includes('.')) { pushText(out, text); return }
  let last = 0
  let i = 0
  const n = text.length
  while (i < n) {
    while (i < n && isSpace(text[i])) i++
    const start = i
    while (i < n && !isSpace(text[i])) i++
    const tok = text.slice(start, i)
    if (tok.length < 4 || tok.length > 300 || !tok.includes('.') || HIDDEN.test(tok)) continue
    const lead = PATH_LEAD.exec(tok)?.[0].length ?? 0
    const m = PATH_RE.exec(tok.slice(lead))
    if (!m) continue
    const file = m[1]
    const line = m[2] ? Number(m[2]) : undefined
    if (!/[\\/]/.test(file) && line === undefined) continue // a bare name: a word
    if (isRemotePath(file)) continue // a UNC or device path: text, whole
    const at = start + lead
    pushText(out, text.slice(last, at))
    const node: Inline = { type: 'path', file, text: m[0] }
    if (line !== undefined) node.line = line
    if (m[3]) node.col = Number(m[3])
    out.push(node)
    last = at + m[0].length
  }
  pushText(out, text.slice(last))
}

function pushText(out: Inline[], text: string) {
  if (!text) return
  const prev = out[out.length - 1]
  if (prev && prev.type === 'text') prev.text += text
  else out.push({ type: 'text', text })
}

// ------------------------------------------------------------------ inline

interface Tables {
  /** The next "]" at or after i */
  nextClose: Int32Array
  /** For a "(" : its matching ")" within the same run of non-space characters, else -1 */
  paren: Int32Array
  /** For the first backtick of a run: the start of the next run of the same length, else -1 */
  tickNext: Int32Array
  /** For the first backtick of a run: its length */
  tickLen: Int32Array
  /**
   * 1 where a backslash is a path's (a run of non-space characters that starts with X:\ or \\, or holds
   * two or more): never an escape. The trade-off, accepted: a run with two escapes in it
   * (`\*\*not bold\*\*`) keeps its backslashes on screen — Windows paths whole matter more.
   */
  pathSlash: Uint8Array
  /** The next '"' and the next '>' at or after i (a link's title, an <address>) */
  nextQuote: Int32Array
  nextGt: Int32Array
}

function tablesFor(s: string): Tables {
  const n = s.length
  const nextClose = new Int32Array(n + 1).fill(-1)
  for (let i = n - 1; i >= 0; i--) nextClose[i] = s[i] === ']' ? i : nextClose[i + 1]
  const paren = new Int32Array(n).fill(-1)
  const stack: number[] = []
  for (let i = 0; i < n; i++) {
    const c = s[i]
    if (isSpace(c)) stack.length = 0
    else if (c === '(') stack.push(i)
    else if (c === ')' && stack.length) paren[stack.pop()!] = i
  }
  const tickLen = new Int32Array(n)
  const tickNext = new Int32Array(n).fill(-1)
  const runs: [number, number][] = []
  for (let i = 0; i < n;) {
    if (s[i] === '`') {
      let j = i
      while (j < n && s[j] === '`') j++
      tickLen[i] = j - i
      runs.push([i, j - i])
      i = j
    } else i++
  }
  const lastOfLen = new Map<number, number>()
  for (let k = runs.length - 1; k >= 0; k--) {
    const [at, len] = runs[k]
    tickNext[at] = lastOfLen.get(len) ?? -1
    lastOfLen.set(len, at)
  }
  const pathSlash = new Uint8Array(n)
  for (let a = 0; a < n;) {
    if (isSpace(s[a])) { a++; continue }
    let b = a
    let slashes = 0
    while (b < n && !isSpace(s[b])) { if (s[b] === '\\') slashes++; b++ }
    const drive = /[A-Za-z]/.test(s[a]) && s[a + 1] === ':' && s[a + 2] === '\\'
    const unc = s[a] === '\\' && s[a + 1] === '\\'
    if (slashes && (drive || unc || slashes >= 2)) for (let k = a; k < b; k++) if (s[k] === '\\') pathSlash[k] = 1
    a = b
  }
  const nextQuote = new Int32Array(n + 1).fill(-1)
  const nextGt = new Int32Array(n + 1).fill(-1)
  for (let i = n - 1; i >= 0; i--) {
    nextQuote[i] = s[i] === '"' ? i : nextQuote[i + 1]
    nextGt[i] = s[i] === '>' ? i : nextGt[i + 1]
  }
  return { nextClose, paren, tickNext, tickLen, pathSlash, nextQuote, nextGt }
}

type Mark = '**' | '__' | '*' | '_' | '~~'

/** Parse s[from, to) into inline nodes (the tables are for the whole string) */
function inlines(s: string, from: number, to: number, T: Tables, links: boolean): Inline[] {
  const out: Inline[] = []
  let buf = ''
  /** A marker whose closer is known to be missing from here to `to` */
  const noCloser = new Set<Mark>()
  const flush = () => { if (buf) { withPaths(buf, out); buf = '' } }
  /** Where the current run of address characters ends (see autolinkAt) */
  let runEnd = -1

  /** Where a run of `mark` that closes emphasis begins, from `start` (before `to`), else -1 */
  const closer = (mark: Mark, start: number): number => {
    if (noCloser.has(mark)) return -1
    const ch = mark[0]
    const len = mark.length
    for (let j = start; j < to; j++) {
      const c = s[j]
      if (c === '\\') { j++; continue }
      if (c === '`') {
        const nx = T.tickNext[j]
        if (T.tickLen[j] && nx >= 0 && nx < to) { j = nx + T.tickLen[nx] - 1; continue }
        if (T.tickLen[j]) { j += T.tickLen[j] - 1; continue }
      }
      if (c !== ch) continue
      let k = j
      while (k < to && s[k] === ch) k++
      const run = k - j
      const prev = s[j - 1]
      const next = s[k]
      const fits = len === 2 ? run >= 2 : run === 1 || run === 3
      const flank = !isSpace(prev) && j > start && (ch !== '_' || !isWordChar(next))
      if (fits && flank) return len === 2 ? j : (run === 3 ? j + 2 : j)
      j = k - 1
    }
    noCloser.add(mark)
    return -1
  }

  let i = from
  while (i < to) {
    const c = s[i]
    // a backslash escapes punctuation; at a line end it is a hard break
    if (c === '\\' && !T.pathSlash[i]) {
      const nx = s[i + 1]
      if (nx === '\n') { flush(); out.push({ type: 'br' }); i += 2; continue }
      if (nx !== undefined && i + 1 < to && ASCII_PUNCT.includes(nx)) { buf += nx; i += 2; continue }
      buf += c; i++; continue
    }
    if (c === '\n') { flush(); out.push({ type: 'br' }); i++; continue }
    // code span: the next run of the same number of backticks
    if (c === '`') {
      const len = T.tickLen[i]
      const nx = T.tickNext[i]
      if (len && nx >= 0 && nx < to) {
        flush()
        let code = s.slice(i + len, nx).replace(/\n/g, ' ')
        if (code.length > 2 && code[0] === ' ' && code[code.length - 1] === ' ' && code.trim()) code = code.slice(1, -1)
        out.push({ type: 'code', text: code })
        i = nx + len
        continue
      }
      buf += s.slice(i, i + (len || 1)); i += len || 1; continue
    }
    // [text](href) and ![alt](href): links only to http(s); else the whole thing stays text
    if (links && (c === '[' || (c === '!' && s[i + 1] === '['))) {
      const open = c === '!' ? i + 1 : i
      const close = T.nextClose[open + 1]
      if (close >= 0 && close + 1 < to && s[close + 1] === '(') {
        let end = T.paren[close + 1]
        // [x](url "title"): a space before the title ends the paren table's run; look for the title's ")"
        if (end < 0) {
          const q = T.nextQuote[close + 2]
          if (q >= 0 && q < Math.min(to, close + 2 + MAX_URL)) {
            const m = /^\s*\S+\s+"[^"\n]{0,300}"\s*\)/.exec(s.slice(close + 2, Math.min(to, q + 304)))
            if (m) end = close + 1 + m[0].length
          }
        }
        if (end >= 0 && end < to) {
          let raw = s.slice(close + 2, end).trim()
          const title = raw.match(/^(\S+)\s+"[^"]*"$/) // the title is dropped
          if (title) raw = title[1]
          if (raw.startsWith('<') && raw.endsWith('>')) raw = raw.slice(1, -1)
          const href = safeHref(raw)
          if (href) {
            flush()
            const children = c === '!'
              ? [{ type: 'text', text: s.slice(open + 1, close) } as Inline]
              : inlines(s, open + 1, close, T, false)
            out.push({ type: 'link', href, children: children.length ? children : [{ type: 'text', text: href }] })
            i = end + 1
            continue
          }
          // not a safe address: the whole construct as written
          buf += s.slice(i, end + 1)
          i = end + 1
          continue
        }
      }
      buf += c; i++; continue
    }
    // <https://…>: the address, without its brackets
    if (links && c === '<' && s[i + 1] === 'h') {
      const gt = T.nextGt[i + 1]
      if (gt > 0 && gt < to && gt - i <= MAX_URL) {
        const href = safeHref(s.slice(i + 1, gt))
        if (href) { flush(); out.push({ type: 'autolink', href }); i = gt + 1; continue }
      }
    }
    // a bare address
    if (links && c === 'h' && s[i + 1] === 't') {
      if (i >= runEnd) { runEnd = i; while (runEnd < to && !URL_STOP.test(s[runEnd])) runEnd++ }
      const end = autolinkAt(s, i, runEnd)
      if (end > 0) { flush(); out.push({ type: 'autolink', href: s.slice(i, end) }); i = end; continue }
    }
    // emphasis
    if (c === '*' || c === '_' || c === '~') {
      let k = i
      while (k < to && s[k] === c) k++
      const run = k - i
      const mark: Mark | null = c === '~' ? (run === 2 ? '~~' : null) : run >= 2 ? (c === '*' ? '**' : '__') : (c === '*' ? '*' : '_')
      const len = mark ? mark.length : 0
      const nextCh = s[i + len]
      const prevCh = i > from ? s[i - 1] : undefined
      const opens = !!mark && !isSpace(nextCh) && i + len < to && (c !== '_' || !isWordChar(prevCh))
      if (opens) {
        const cl = closer(mark!, i + len)
        if (cl > i + len) {
          flush()
          const children = inlines(s, i + len, cl, T, links)
          out.push({ type: mark === '~~' ? 'del' : len === 2 && c !== '~' ? 'strong' : 'em', children } as Inline)
          i = cl + len
          continue
        }
      }
      buf += s.slice(i, k); i = k; continue
    }
    buf += c
    i++
  }
  flush()
  return out
}

/** One paragraph's (or cell's) inline nodes */
export function parseInline(src: string, links = true): Inline[] {
  return inlines(src, 0, src.length, tablesFor(src), links)
}

// ------------------------------------------------------------------ blocks

const indentOf = (line: string) => { let i = 0; while (i < line.length && line[i] === ' ') i++; return i }
const blank = (line: string) => !line.trim()

interface ListMark { indent: number; ordered: boolean; start: number; content: number; text: string }

/** A list item's marker at the start of the line */
function listMark(line: string): ListMark | null {
  const indent = indentOf(line)
  let i = indent
  const c = line[i]
  let ordered = false
  let start = 1
  if (c === '-' || c === '*' || c === '+') i++
  else {
    let j = i
    while (j < line.length && j - i < 9 && line[j] >= '0' && line[j] <= '9') j++
    if (j === i || (line[j] !== '.' && line[j] !== ')')) return null
    ordered = true
    start = Number(line.slice(i, j))
    i = j + 1
  }
  if (i < line.length && line[i] !== ' ' && line[i] !== '\t') return null
  let sp = 0
  while (i + sp < line.length && (line[i + sp] === ' ' || line[i + sp] === '\t')) sp++
  const content = i + (sp >= 1 && sp <= 4 ? sp : 1)
  return { indent, ordered, start, content, text: line.slice(Math.min(line.length, i + sp)) }
}

function fenceOf(line: string): { ch: string; len: number; lang: string; indent: number } | null {
  const indent = indentOf(line)
  if (indent > 3) return null
  const ch = line[indent]
  if (ch !== '`' && ch !== '~') return null
  let j = indent
  while (j < line.length && line[j] === ch) j++
  const len = j - indent
  if (len < 3) return null
  const info = line.slice(j).trim()
  if (ch === '`' && info.includes('`')) return null
  return { ch, len, lang: info.split(/\s/)[0].slice(0, 40), indent }
}

function isHr(line: string): boolean {
  const t = line.trim()
  if (t.length < 3 || indentOf(line) > 3) return false
  const m = t[0]
  if (m !== '-' && m !== '*' && m !== '_') return false
  let count = 0
  for (const c of t) { if (c === m) count++; else if (c !== ' ' && c !== '\t') return false }
  return count >= 3
}

function headingOf(line: string): { level: number; text: string } | null {
  const indent = indentOf(line)
  if (indent > 3) return null
  let j = indent
  while (j < line.length && line[j] === '#') j++
  const level = j - indent
  if (level < 1 || level > 6) return null
  if (j < line.length && line[j] !== ' ' && line[j] !== '\t') return null
  let text = line.slice(j).trim()
  // a closing run of #s after a space
  let k = text.length
  while (k > 0 && text[k - 1] === '#') k--
  if (k < text.length && (k === 0 || text[k - 1] === ' ')) text = text.slice(0, k).trim()
  return { level, text }
}

/** The cells of a table row: split at "|" outside code spans and escapes; the outer pipes dropped */
function cellsOf(line: string): string[] {
  let t = line.trim()
  if (t.startsWith('|')) t = t.slice(1)
  if (t.endsWith('|') && !t.endsWith('\\|')) t = t.slice(0, -1)
  const cells: string[] = []
  let cur = ''
  let tick = 0
  for (let i = 0; i < t.length; i++) {
    const c = t[i]
    if (c === '\\' && t[i + 1] === '|') { cur += '\\|'; i++; continue }
    if (c === '`') {
      let j = i
      while (j < t.length && t[j] === '`') j++
      const run = j - i
      if (!tick) tick = run; else if (tick === run) tick = 0
      cur += t.slice(i, j)
      i = j - 1
      continue
    }
    if (c === '|' && !tick) { cells.push(cur.trim()); cur = ''; if (cells.length > MAX_COLS) break; continue }
    cur += c
  }
  if (cells.length <= MAX_COLS) cells.push(cur.trim())
  // a code span left open: split again at every pipe (as GFM does)
  return tick ? t.split('|').map(x => x.trim()).slice(0, MAX_COLS + 1) : cells
}

function delimiterRow(line: string | undefined): Align[] | null {
  if (line === undefined || !line.includes('-')) return null
  const t = line.trim()
  if (!t.includes('|') && !/^:?-+:?$/.test(t)) return null
  const cells = cellsOf(line)
  if (!cells.length) return null
  const out: Align[] = []
  for (const c of cells) {
    if (!/^:?-+:?$/.test(c)) return null
    const l = c.startsWith(':'), r = c.endsWith(':')
    out.push(l && r ? 'center' : r ? 'right' : l ? 'left' : null)
  }
  return out
}

function tableStart(lines: string[], i: number): Align[] | null {
  if (!lines[i].includes('|')) return null
  const align = delimiterRow(lines[i + 1])
  if (!align) return null
  return cellsOf(lines[i]).length === align.length ? align : null
}

interface Depth { list: number; quote: number }

/** Does this line begin a block that ends a paragraph? */
function interrupts(lines: string[], i: number, d: Depth): boolean {
  const line = lines[i]
  if (fenceOf(line) || headingOf(line) || isHr(line)) return true
  if (line.trimStart().startsWith('>')) return true
  if (d.list < MAX_LIST_DEPTH) {
    const m = listMark(line)
    if (m && m.text.trim() && (!m.ordered || m.start === 1)) return true
  }
  return !!tableStart(lines, i)
}

function parseBlocks(lines: string[], d: Depth): Block[] {
  const out: Block[] = []
  let i = 0
  const n = lines.length
  while (i < n) {
    const line = lines[i]
    if (blank(line)) { i++; continue }

    const fence = fenceOf(line)
    if (fence) {
      const body: string[] = []
      i++
      while (i < n) {
        const l = lines[i]
        const ind = indentOf(l)
        if (ind <= 3 && l[ind] === fence.ch) {
          let j = ind
          while (j < l.length && l[j] === fence.ch) j++
          if (j - ind >= fence.len && !l.slice(j).trim()) { i++; break }
        }
        // the fence's own indent is taken off its lines
        let k = 0
        while (k < fence.indent && l[k] === ' ') k++
        body.push(l.slice(k))
        i++
      }
      out.push({ type: 'code', lang: fence.lang, text: body.join('\n') })
      continue
    }

    const h = headingOf(line)
    if (h) {
      out.push({ type: 'heading', level: Math.min(4, h.level) as 1 | 2 | 3 | 4, inline: parseInline(h.text) })
      i++
      continue
    }

    if (isHr(line)) { out.push({ type: 'hr' }); i++; continue }

    if (line.trimStart().startsWith('>')) {
      const inner: string[] = []
      while (i < n && !blank(lines[i])) {
        const l = lines[i]
        const t = l.trimStart()
        if (t.startsWith('>')) inner.push(t.slice(t[1] === ' ' ? 2 : 1))
        else if (!interrupts(lines, i, d)) inner.push(l) // a lazy continuation
        else break
        i++
      }
      if (d.quote < MAX_QUOTE_DEPTH) out.push({ type: 'quote', blocks: parseBlocks(inner, { ...d, quote: d.quote + 1 }) })
      else out.push({ type: 'para', inline: parseInline(inner.join('\n')) })
      continue
    }

    const mark = d.list < MAX_LIST_DEPTH ? listMark(line) : null
    if (mark) {
      const items: Block[][] = []
      while (i < n) {
        const m = listMark(lines[i])
        if (!m || m.ordered !== mark.ordered || m.indent > mark.indent + 3 || m.indent + 1 < mark.indent) break
        // this item's lines, made relative to its content
        const body: string[] = [m.text]
        const nested = m.indent + 2
        i++
        let lastBlank = false
        while (i < n) {
          const l = lines[i]
          if (blank(l)) { body.push(''); lastBlank = true; i++; continue }
          const ind = indentOf(l)
          const sib = listMark(l)
          if (sib && sib.ordered === mark.ordered && ind < nested && ind + 1 >= mark.indent) break
          if (ind >= nested) { body.push(l.slice(Math.min(ind, m.content))); lastBlank = false; i++; continue }
          if (!lastBlank && !interrupts(lines, i, d)) { body.push(l.trimStart()); i++; continue } // lazy
          break
        }
        while (body.length && blank(body[body.length - 1])) body.pop()
        items.push(parseBlocks(body, { ...d, list: d.list + 1 }))
        // a blank line then something not in the list ends it
        if (i < n && blank(lines[i - 1] ?? '') && !listMark(lines[i])) break
      }
      out.push({ type: 'list', ordered: mark.ordered, start: mark.start, items })
      continue
    }

    const align = tableStart(lines, i)
    if (align) {
      const cols = align.length
      const row = (l: string): Inline[][] => {
        const cells = cellsOf(l).slice(0, cols)
        while (cells.length < cols) cells.push('')
        return cells.map(c => parseInline(c))
      }
      const head = row(line)
      const rows: Inline[][][] = []
      i += 2
      while (i < n && !blank(lines[i]) && lines[i].includes('|')) { rows.push(row(lines[i])); i++ }
      out.push({ type: 'table', align, head, rows })
      continue
    }

    // a paragraph: up to a blank line or a line that begins a block (at least its first line)
    const para: string[] = [line.trim()]
    i++
    while (i < n && !blank(lines[i]) && !interrupts(lines, i, d)) { para.push(lines[i].trim()); i++ }
    out.push({ type: 'para', inline: parseInline(para.join('\n')) })
  }
  return out
}

/** A key per block that stays the same as text streams in: its kind and its place among blocks of that kind */
export function blockKeys(blocks: Block[]): string[] {
  const seen: Record<string, number> = {}
  return blocks.map(b => { const n = seen[b.type] = (seen[b.type] ?? -1) + 1; return `${b.type}-${n}` })
}

/** Markdown → blocks; nothing in the result is HTML */
export function parseMarkdown(src: string): Block[] {
  let text = typeof src === 'string' ? src : ''
  const cut = text.length > MD_CAP
  if (cut) text = text.slice(0, MD_CAP)
  text = text.replace(/\r\n?/g, '\n').replace(/\u0000/g, '�')
  const blocks = parseBlocks(text.split('\n'), { list: 0, quote: 0 })
  if (cut) blocks.push({ type: 'cut' })
  return blocks
}
