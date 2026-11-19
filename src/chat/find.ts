/**
 * Find in the conversation: what the store's items say as plain text, where a query is found, the row
 * each place is drawn in and what must open for it to show. Pure apart from `t` (a notice's words); the view
 * (src/components/ChatView.tsx) navigates and src/components/chat/FindBar.tsx paints.
 *
 *   - Only what is loaded is searched (the bar says so while older items exist), and only what a row draws:
 *       user          the message as typed
 *       text          the answer's plain text from its markdown tree (inline code and code blocks, link text and
 *                     table cells included; no markup, no link address)
 *       thinking      its text, only in 생각 포함 / 전부 (in 기본 the row is not drawn)
 *       notice        its words as the row says them
 *       tool          as it is drawn: a plain row → the label's detail (command, file, pattern, path, query, url,
 *                     description), a question and its options, a plan, and its output (behind the row's fold);
 *                     a diff → its file and its lines (the first DIFF_PREVIEW shown, the rest behind `:diff`);
 *                     an Agent row → its description, its sub-agent's rows under it (behind its fold);
 *                     a member of a read group → its file, pattern and path only (the group lists nothing else)
 *     Turn feet, wild rows, day lines and turn heads hold nothing to find (their words are the app's, not the
 *     conversation's), and a live bubble neither: a streaming answer is found once it is written.
 *   - The query and the text are both NFC-normalised and compared with toLocaleLowerCase(); an offset is the raw
 *     text's (a decomposed é or Hangul written as jamo is matched and mapped back).
 *   - At most `limit` matches (1000), in row order; `more` says there were more.
 */

import { t } from '../i18n'
import { parseMarkdown, type Block, type Inline } from './markdown'
import type { Density } from './density'
import type { Row } from './rows'
import type { ChatItem, NoticeItem, ToolItem } from './types'

/** Lines a diff shows before "더 보기" (src/components/chat/DiffBlock.tsx DIFF_PREVIEW, kept equal by a test) */
export const DIFF_PREVIEW_LINES = 8
/** The most matches counted */
export const FIND_LIMIT = 1000

export interface FindField {
  /** user · text · thinking · notice · command · file · pattern · path · query · url · description · question ·
   *  option · plan · output · diff-file · diff:<n> (n: the line's place in the diff as drawn, gaps between hunks counted) */
  field: string
  text: string
}

export interface FindMatch {
  itemId: string
  /** The row the item is drawn in (a group's member → the group, a sub-agent's row → its Agent row) */
  rowKey: string
  field: string
  /** In the field's raw text */
  start: number
  end: number
  /** How the item sits in its row: inside a read group, or under an Agent row */
  via?: 'group' | 'agent'
}

export interface FindResult { matches: FindMatch[]; more: boolean }

// ---------------------------------------------------------------- folding

/** Code points that belong to the one before (marks; Hangul vowel and final jamo): folded with it */
const JOINS = /[\p{M}ᅠ-ᇿힰ-퟿]/u

/**
 * NFC + toLocaleLowerCase, with `map[i]` the raw offset folded offset `i` came from (and `map[text.length]` the raw
 * length). `map` is null when nothing moved (the common case: the offsets are the raw ones).
 */
export function fold(raw: string): { text: string; map: number[] | null } {
  const nfc = raw.normalize('NFC')
  const low = nfc.toLocaleLowerCase()
  if (nfc === raw && low.length === raw.length) return { text: low, map: null }
  let text = ''
  const map: number[] = []
  let i = 0
  while (i < raw.length) {
    const start = i
    i += raw.codePointAt(i)! > 0xffff ? 2 : 1
    while (i < raw.length) {
      const cp = raw.codePointAt(i)!
      const ch = String.fromCodePoint(cp)
      if (!JOINS.test(ch)) break
      i += ch.length
    }
    const piece = raw.slice(start, i).normalize('NFC').toLocaleLowerCase()
    for (let k = 0; k < piece.length; k++) map.push(start)
    text += piece
  }
  map.push(raw.length)
  return { text, map }
}

/** The folded query (null: nothing to look for) */
export function foldQuery(q: string): string | null {
  if (!q || !q.trim()) return null
  return q.normalize('NFC').toLocaleLowerCase()
}

/** Every place `q` (already folded) is in `raw`, as raw offsets */
export function placesIn(raw: string, q: string, folded = fold(raw)): [number, number][] {
  const out: [number, number][] = []
  if (!q) return out
  const { text, map } = folded
  for (let at = text.indexOf(q); at >= 0; at = text.indexOf(q, at + q.length)) {
    out.push(map ? [map[at], map[at + q.length]] : [at, at + q.length])
  }
  return out
}

// ---------------------------------------------------------------- plain text

function inlineText(nodes: Inline[]): string {
  let s = ''
  for (const x of nodes) {
    switch (x.type) {
      case 'text': case 'code': case 'path': s += x.text; break
      case 'strong': case 'em': case 'del': case 'link': s += inlineText(x.children); break
      case 'autolink': s += x.href; break
      case 'br': s += '\n'; break
      default: break
    }
  }
  return s
}

function blocksText(blocks: Block[]): string[] {
  const out: string[] = []
  for (const b of blocks) {
    switch (b.type) {
      case 'heading': case 'para': out.push(inlineText(b.inline)); break
      case 'code': out.push(b.text); break
      case 'list': for (const item of b.items) out.push(...blocksText(item)); break
      case 'quote': out.push(...blocksText(b.blocks)); break
      case 'table': for (const row of [b.head, ...b.rows]) out.push(row.map(inlineText).join('\t')); break
      default: break
    }
  }
  return out
}

/** A markdown text as the reader sees it: no markup, a block per line */
export function markdownText(src: string): string {
  return blocksText(parseMarkdown(src)).join('\n')
}

/** A notice's words, as its row says them (ChatView's NoticeRow) */
export const NOTICE_WORDS: Record<string, string> = {
  interrupted: '요청을 멈췄어요',
  command: '{command} 실행',
  compact: '대화를 정리했어요',
  // the summary a compaction carries the conversation on with (never shown as the user's message)
  summary: '대화가 요약되어 이어졌어요',
  'agent-done': '보조 에이전트가 끝났어요',
  'unknown-block': '여기서 보여 줄 수 없는 내용이 있어요',
  model: '',
}

/** What a notice row says (a notice this page does not know is said as one it cannot show) */
export function noticeText(item: NoticeItem): { kind: string; text: string } {
  const kind = Object.prototype.hasOwnProperty.call(NOTICE_WORDS, item.notice) ? item.notice : 'unknown-block'
  const key = NOTICE_WORDS[kind]
  return { kind, text: key ? t(key, { command: item.text ?? '' }) : item.text ?? '' }
}

const AGENT_TOOLS = new Set(['Agent', 'Task'])
const ALWAYS_OPEN = new Set(['AskUserQuestion', 'ExitPlanMode'])
const DETAIL = ['command', 'file', 'pattern', 'path', 'query', 'url', 'description'] as const
/** What a member of a read group shows of itself (ToolGroup lineOf and its detail) */
const IN_GROUP = new Set(['file', 'pattern', 'path'])

function toolFields(it: ToolItem): FindField[] {
  const out: FindField[] = []
  const i = it.input ?? {}
  if (AGENT_TOOLS.has(it.tool ?? '') && !it.parent) {
    if (i.description) out.push({ field: 'description', text: i.description })
    return out
  }
  if (it.diff && it.state === 'done') {
    out.push({ field: 'diff-file', text: it.diff.file })
    let k = 0
    it.diff.hunks.forEach((h, n) => {
      if (n > 0) k++ // the gap DiffBlock draws between hunks
      for (const l of h.lines) out.push({ field: `diff:${k++}`, text: l.text })
    })
    return out
  }
  for (const f of DETAIL) { const v = i[f]; if (typeof v === 'string' && v) out.push({ field: f, text: v }) }
  if (it.tool === 'AskUserQuestion') {
    if (i.question) out.push({ field: 'question', text: i.question })
    for (const o of i.options ?? []) out.push({ field: 'option', text: o })
  }
  if (it.tool === 'ExitPlanMode' && i.plan) out.push({ field: 'plan', text: markdownText(i.plan) })
  if (!ALWAYS_OPEN.has(it.tool ?? '') && it.output?.text) out.push({ field: 'output', text: it.output.text })
  return out
}

const NONE: FindField[] = []
const cache = new WeakMap<object, FindField[]>()

/**
 * The plain text an item is drawn with, by field, cached by the item's identity (main replaces an item whole).
 * A thinking item gives nothing in 기본; a notice is said in the language of the moment (not cached).
 */
export function plainOf(item: ChatItem, density: Density): FindField[] {
  if (item.kind === 'thinking' && !item.update && density !== 'thinking' && density !== 'all') return NONE
  if (item.kind === 'notice') {
    const { text } = noticeText(item)
    return text ? [{ field: 'notice', text }] : NONE
  }
  const hit = cache.get(item)
  if (hit) return hit
  let fields: FindField[]
  switch (item.kind) {
    case 'user': fields = item.text ? [{ field: 'user', text: item.text }] : NONE; break
    case 'text': fields = [{ field: 'text', text: markdownText(item.text) }]; break
    case 'thinking': fields = item.redacted || !item.text.trim() ? NONE : [{ field: 'thinking', text: markdownText(item.text) }]; break
    case 'tool': fields = toolFields(item); break
    default: fields = NONE
  }
  cache.set(item, fields)
  return fields
}

const folds = new WeakMap<FindField, ReturnType<typeof fold>>()
const foldOf = (f: FindField) => { let x = folds.get(f); if (!x) { x = fold(f.text); folds.set(f, x) } return x }

// ---------------------------------------------------------------- matches

/** Where `query` is in the loaded conversation, in row order (at most `limit`) */
export function findMatches(items: ChatItem[], rows: Row[], query: string, density: Density, limit = FIND_LIMIT): FindResult {
  const q = foldQuery(query)
  const matches: FindMatch[] = []
  if (!q) return { matches, more: false }
  const byId = new Map<string, ChatItem>()
  for (const it of items) byId.set(it.id, it)
  const look = (it: ChatItem, rowKey: string, via?: 'group' | 'agent'): boolean => {
    for (const f of plainOf(it, density)) {
      if (via === 'group' && !IN_GROUP.has(f.field)) continue
      for (const [start, end] of placesIn(f.text, q, foldOf(f))) {
        if (matches.length >= limit) return false
        matches.push({ itemId: it.id, rowKey, field: f.field, start, end, ...(via ? { via } : {}) })
      }
    }
    return true
  }
  const done = () => ({ matches, more: true })
  for (const r of rows) {
    switch (r.row) {
      case 'user': case 'text': case 'notice': case 'thinking':
        if (!look(r.item, r.key)) return done()
        break
      case 'tool':
        if (!look(r.item, r.key)) return done()
        // a sub-agent's rows under its Agent row (only what is loaded: what the row asked for)
        for (const c of r.children) if (!look(byId.get(c.id) ?? c, r.key, 'agent')) return done()
        break
      case 'group':
        for (const m of r.items) if (!look(m, r.key, 'group')) return done()
        break
      default: break
    }
  }
  return { matches, more: false }
}

/**
 * The open keys (src/components/chat/context.ts) that make a match show: its group (ToolGroup groupOpenKey) and the
 * call, its Agent row, its own fold (a tool row's output, a diff past its preview lines)
 */
export function openFor(m: FindMatch): string[] {
  const keys: string[] = []
  if (m.via === 'group') return [`group:${m.rowKey}`, m.itemId]
  if (m.via === 'agent') keys.push(m.rowKey)
  if (m.field === 'output') keys.push(m.itemId)
  const d = /^diff:(\d+)$/.exec(m.field)
  if (d && Number(d[1]) >= DIFF_PREVIEW_LINES) keys.push(`${m.itemId}:diff`)
  return keys
}

/** What is on top of the page when a dialog is open: 설정, the lightbox, 패치노트, a picker, a feedback popover … */
export const OVERLAY_SELECTOR = '[role="dialog"], [role="alertdialog"], [aria-modal="true"]'

/**
 * Whether something sits on top of the chat (a dialog, 설정, the lightbox): Ctrl/⌘+F then does nothing for the chat,
 * so the find bar never opens under it
 */
export function overlayOpen(doc: { querySelector(selector: string): unknown } | null | undefined): boolean {
  try { return !!doc && doc.querySelector(OVERLAY_SELECTOR) !== null } catch { return false }
}
