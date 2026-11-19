/**
 * A conversation's items (src/chat/types.ts) become the rows the chat view draws.
 * Pure: the same items give the same rows (and the same keys, so the virtual
 * list keeps its measured heights).
 *
 *   - a day line before the first item of each calendar day (local time)
 *   - a turn head (the session's picture once) before the first assistant item of a turn
 *   - finished reads and searches in a row are one group ("파일 3개 읽음 · 검색 2회")
 *   - a sub-agent's items nest under their Agent row and make no rows of their own
 *   - a thinking item makes a row only from 생각 포함 (`density` 'thinking' / 'all'): there it
 *     breaks a run of reads and can begin a turn head; in 기본 it is passed over as if it were not there,
 *     so 기본 draws exactly the rows it would without thinking items (and their feet)
 *   - a turn end makes the turn's foot (the turn summary) and ends the turn. A turn runs from the
 *     last turn end or interrupt before it; a prompt taken mid-turn (a queued one) does not split it. Its
 *     counts (main-thread tool calls, files its diffs changed) and the texts its copy takes are given only
 *     when the whole turn is among the items (`whole`): the boundary before it is loaded (or nothing is
 *     older), and none of its calls or texts is stamped before the turn began (its end − its duration: a
 *     turn that ended with no turn_duration and no interrupt is not counted into the next). Otherwise the
 *     foot says its time only: a count it cannot know is left out, never guessed.
 *   - a wild Pokémon this session met (`extra`, src/chat/wild.ts) goes before the first main-thread item
 *     stamped later than it (the end when none is, before a live bubble). It ends a run of reads there (never inside a
 *     group), and makes no day line and no turn head; it is not counted as a new message (unreadAfter)
 *
 * Never folded into a group (the anti-goal "a permission request hidden in a
 * collapsed group"): a call waiting on the user, a failed or running call, a
 * question and a plan. Each of them also breaks a run of reads.
 */

import type { ChatItem, LiveItem, NoticeItem, ShellItem, TextItem, ThinkingItem, ToolItem, TurnEndItem, UserItem } from './types'
import type { Density } from './density'
import type { WildEntry } from './wild'

export type Row =
  | { row: 'wild'; key: string; entry: WildEntry }                        // from opts.extra; never in 업무 모드
  | { row: 'thinking'; key: string; item: ThinkingItem }                  // only from 생각 포함
  // the turn summary: counts null and `whole` false when the turn's start is not among the items
  | { row: 'foot'; key: string; item: TurnEndItem; tools: number | null; files: number | null; texts: TextItem[]; whole: boolean }
  | { row: 'day'; key: string; label: string }
  | { row: 'user'; key: string; item: UserItem }
  | { row: 'shell'; key: string; item: ShellItem }                        // a `!` command and its output
  | { row: 'turn-head'; key: string; at: number | null }
  | { row: 'text'; key: string; item: TextItem }
  | { row: 'tool'; key: string; item: ToolItem; children: (ToolItem | TextItem)[] }
  | { row: 'group'; key: string; items: ToolItem[]; files: number; searches: number }
  | { row: 'notice'; key: string; item: NoticeItem }
  | { row: 'live'; key: string; item: LiveItem }

export interface RowOptions {
  /** How much is drawn (src/chat/density.ts); absent: 기본 */
  density?: Density
  /** Time-stamped entries from outside the transcript: the wild Pokémon this session met (src/chat/wild.ts); none in 업무 모드 */
  extra?: WildEntry[]
  /** The day line's words for a time (ms) */
  dayLabel: (at: number) => string
  /** Older items exist before the first one given (status.hasOlder): the first turn's start is then not known */
  hasOlder?: boolean
}

export type FootRow = Extract<Row, { row: 'foot' }>
/** How long before a turn's start (its end minus its duration) one of its own items may be stamped */
export const FOOT_SLACK_MS = 2000

const READS = new Set(['Read', 'NotebookRead'])
const SEARCHES = new Set(['Glob', 'Grep', 'LS'])
/** Never folded, whatever their state */
const ALWAYS_OPEN = new Set(['AskUserQuestion', 'ExitPlanMode'])

/** A finished read or search that may join a group */
export function groupable(t: ToolItem): boolean {
  return !!t.tool && (READS.has(t.tool) || SEARCHES.has(t.tool)) && t.state === 'done' && !t.waiting && !ALWAYS_OPEN.has(t.tool)
}

const dayKey = (at: number) => { const d = new Date(at); return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}` }
/** Kinds that begin a new turn for what follows */
const TURN_BREAKS = new Set<NoticeItem['notice']>(['interrupted', 'command', 'agent-done', 'compact', 'summary'])

export function buildRows(items: ChatItem[], opts: RowOptions): Row[] {
  const rows: Row[] = []
  const children = new Map<string, (ToolItem | TextItem)[]>()
  for (const it of items) {
    if (it.parent && (it.kind === 'tool' || it.kind === 'text')) {
      const list = children.get(it.parent)
      if (list) list.push(it); else children.set(it.parent, [it])
    }
  }
  let day: string | null = null
  let needHead = true
  let run: ToolItem[] = []
  const thinking = opts.density === 'thinking' || opts.density === 'all'
  // the turn being read: its main-thread items since the last turn end or interrupt
  let seg: ChatItem[] = []
  let segFrom: 'start' | 'end' | 'interrupt' = opts.hasOlder ? 'start' : 'end'

  const foot = (end: TurnEndItem) => {
    // after an interrupt, only a new prompt begins a turn (a turn_duration right after it closes the stopped one)
    let whole = segFrom === 'end' || (segFrom === 'interrupt' && seg.some(i => i.kind === 'user'))
    if (whole && end.at !== null && Number.isFinite(end.at)) {
      const began = end.at - end.durationMs - FOOT_SLACK_MS
      if (seg.some(i => (i.kind === 'tool' || i.kind === 'text') && i.at !== null && Number.isFinite(i.at) && i.at < began)) whole = false
    }
    const tools = seg.filter((i): i is ToolItem => i.kind === 'tool')
    const texts = seg.filter((i): i is TextItem => i.kind === 'text')
    const files = new Set(tools.flatMap(t => (t.diff ? [t.diff.file] : []))).size
    rows.push({ row: 'foot', key: `foot:${end.id}`, item: end, tools: whole ? tools.length : null, files: whole ? files : null, texts, whole })
  }

  const flush = () => {
    if (!run.length) return
    if (run.length === 1) {
      const it = run[0]
      rows.push({ row: 'tool', key: it.id, item: it, children: children.get(it.id) ?? [] })
    } else {
      const files = run.filter(t => READS.has(t.tool!)).length
      // keyed by its first call, as that call's own row was: a read joining a single one is not a new row
      rows.push({ row: 'group', key: run[0].id, items: run, files, searches: run.length - files })
    }
    run = []
  }
  const dayFor = (it: ChatItem) => {
    if (it.at === null || !Number.isFinite(it.at)) return
    const k = dayKey(it.at)
    if (k === day) return
    flush()
    day = k
    rows.push({ row: 'day', key: `day:${k}`, label: opts.dayLabel(it.at) })
  }
  const head = (it: ChatItem) => {
    if (!needHead) return
    flush()
    needHead = false
    rows.push({ row: 'turn-head', key: `head:${it.id}`, at: it.at })
  }

  // the wild Pokémon met, oldest first: each before the first main-thread item stamped later than it
  const extra = opts.extra?.length ? [...opts.extra].sort((a, b) => a.at - b.at) : []
  let next = 0
  const meet = (before: number) => {
    if (next >= extra.length || extra[next].at >= before) return
    flush()
    while (next < extra.length && extra[next].at < before) {
      const e = extra[next++]
      rows.push({ row: 'wild', key: `wild:${e.key}`, entry: e })
    }
  }

  for (const it of items) {
    if (it.parent) continue
    // (a live bubble is now: everything met before it)
    if (it.kind === 'live') meet(Infinity)
    else if (it.at !== null && Number.isFinite(it.at)) meet(it.at)
    if (it.kind !== 'turn-end') seg.push(it)
    switch (it.kind) {
      case 'user':
        flush(); dayFor(it)
        rows.push({ row: 'user', key: it.id, item: it })
        needHead = true
        break
      case 'text':
        flush(); dayFor(it); head(it)
        rows.push({ row: 'text', key: it.id, item: it })
        break
      case 'live':
        flush(); dayFor(it); head(it)
        rows.push({ row: 'live', key: it.id, item: it })
        break
      case 'tool':
        dayFor(it); head(it)
        if (groupable(it)) run.push(it)
        else { flush(); rows.push({ row: 'tool', key: it.id, item: it, children: children.get(it.id) ?? [] }) }
        break
      case 'notice':
        flush(); dayFor(it)
        rows.push({ row: 'notice', key: it.id, item: it })
        if (TURN_BREAKS.has(it.notice)) needHead = true
        // an interrupt ends the turn (Claude Code writes no turn_duration for it): what follows is another
        if (it.notice === 'interrupted') { seg = []; segFrom = 'interrupt' }
        break
      case 'turn-end':
        flush()
        foot(it)
        needHead = true
        seg = []
        segFrom = 'end'
        break
      case 'shell':
        // the user's own, as a message is: Claude's next words start a turn of their own
        flush(); dayFor(it)
        rows.push({ row: 'shell', key: it.id, item: it })
        needHead = true
        break
      case 'thinking':
        // 기본: as if it were not there (no break in a group, no head, no day line); a progress note shows always
        if (!thinking && !it.update) break
        flush(); dayFor(it); head(it)
        rows.push({ row: 'thinking', key: it.id, item: it })
        break
      default: {
        // a kind this page does not know: said as something it cannot show (never silently nothing)
        const odd = it as { id: string; order: number; at: number | null }
        if (typeof odd.id !== 'string') break
        flush(); dayFor(odd as ChatItem)
        rows.push({ row: 'notice', key: odd.id, item: { id: odd.id, order: odd.order, at: odd.at ?? null, kind: 'notice', notice: 'unknown-block' } })
        break
      }
    }
  }
  flush()
  meet(Infinity)
  return rows
}

/** The text items whose copy a foot took over: a whole turn's. Others keep their own 답 복사 */
export function footCopies(rows: Row[]): Set<string> {
  const ids = new Set<string>()
  for (const r of rows) if (r.row === 'foot' && r.whole) for (const t of r.texts) ids.add(t.id)
  return ids
}

/** What a foot's 복사 writes: the turn's answers as their markdown, a blank line between; `cut` when one was cut */
export function footCopy(row: FootRow): { text: string; cut: boolean } {
  return { text: row.texts.map(t => t.text).join('\n\n'), cut: row.texts.some(t => t.truncated === true) }
}

const COUNTED = new Set<Row['row']>(['user', 'text', 'tool', 'group', 'notice'])

/**
 * The new messages in `next` that `prev` did not have, below the last row of
 * `prev` (rows loaded above are not new; the provisional bubble is not "a row of prev"
 * for this, it is pinned at the bottom). Day lines, turn heads and bubbles do not count;
 * a row that changed but kept its key is not new. A first load (no `prev`) is 0.
 */
export function unreadAfter(prev: Row[], next: Row[]): number {
  if (!prev.length) return 0
  const had = new Set(prev.map(r => r.key))
  // the last row both have, a provisional bubble aside: it sits at the very bottom whatever
  // arrives, so measured from it nothing new would ever count
  let from = -1
  for (let i = next.length - 1; i >= 0; i--) if (next[i].row !== 'live' && had.has(next[i].key)) { from = i; break }
  let n = 0
  for (let i = from + 1; i < next.length; i++) if (COUNTED.has(next[i].row) && !had.has(next[i].key)) n++
  return n
}
