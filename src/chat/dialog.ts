/**
 * A dialog Claude Code draws in the terminal that no card of the chat holds (a `/model` confirmation, the folder
 * trust question, a permission or a question its hooks could not hold, a plan's choices): read from the screen,
 * shown in the chat as a card, answered from it (2026-11-17, the owner's call: nothing of a chat session needs the
 * terminal). Its shape (seen on 2.1.32x): a title and body, the numbered options with the selection mark (❯ or >)
 * on one, an option's description indented under it, then a hint line (Enter to confirm · Esc to cancel).
 *
 * answerDialog moves the mark with ↑ / ↓ one step at a time, reading the screen after each, and presses Enter only
 * when the mark is on the chosen option; an option that takes words (Type something, Tell Claude what to change)
 * gets them pasted and seen on the screen first. Pure: the screen, the keys and the clock are injected.
 */

import { isBoxLine } from './boxTable'

export interface DialogOption { n: number; label: string; desc: string[]; free: boolean }
/**
 * `numbered`: options drawn `1.`, `2.` … (false: a panel's plain rows, one marked — /remote-control's, 2026-11-19);
 * `links`: the URLs in the title and body, whole even where the terminal wrapped them (a panel's point may be its link)
 */
export interface Dialog { title: string; body: string[]; options: DialogOption[]; selected: number; hints: string[]; esc: boolean; numbered: boolean; links: string[] }

const LOOK = 48
const OPT = /^(\s*)(?:([❯>])[\s ]*)?(\d{1,2})\.\s+(.*\S)\s*$/
/** a rule: one character, repeated (─ ━ ▔ ▁ …); ╌ only separates the body's parts */
const RULE = /^\s*(\S)\1{9,}\s*$/
const FREE = /\b(type something|tell claude|something else|other)\b/i

export function parseDialog(screen: string | null): Dialog | null {
  if (typeof screen !== 'string') return null
  const all = screen.replace(/\r/g, '').split('\n')
  while (all.length && !all[all.length - 1].trim()) all.pop()
  const lines = all.slice(-LOOK)
  return numbered(lines) ?? plainRows(lines)
}

function numbered(lines: string[]): Dialog | null {
  // the last run of options numbered 1, 2, 3 … (description lines between them)
  let last = -1
  for (let i = lines.length - 1; i >= 0; i--) if (OPT.test(lines[i])) { last = i; break }
  if (last < 0) return null
  const idx: number[] = []
  let want = Number(OPT.exec(lines[last])![3])
  for (let i = last; i >= 0 && want >= 1; i--) {
    const m = OPT.exec(lines[i])
    if (m) {
      if (Number(m[3]) !== want) break
      idx.unshift(i)
      want--
      continue
    }
    // between options only a description (indented deeper) or a blank line
    if (lines[i].trim() && !/^\s{4,}/.test(lines[i])) break
  }
  if (want !== 0 || idx.length < 2) return null
  const options: DialogOption[] = []
  let selected = -1
  for (let k = 0; k < idx.length; k++) {
    const m = OPT.exec(lines[idx[k]])!
    if (m[2]) selected = k
    const col = m[1].length + (m[2] ? 2 : 0)
    const end = k + 1 < idx.length ? idx[k + 1] : lines.length
    const desc: string[] = []
    for (let j = idx[k] + 1; j < end; j++) {
      const l = lines[j]
      if (!l.trim()) continue
      if (k + 1 === idx.length && (l.length - l.trimStart().length) <= col) break
      desc.push(l.trim())
    }
    const label = m[4].trim()
    options.push({ n: Number(m[3]), label, desc, free: FREE.test(label) })
  }
  if (selected < 0) return null
  // after the last option and its description: the hints
  const lastOpt = idx[idx.length - 1]
  const hints: string[] = []
  for (let j = lastOpt + 1 + options[options.length - 1].desc.length; j < lines.length; j++) if (lines[j].trim()) hints.push(lines[j].trim())
  const { title, body, links } = bodyAbove(lines, idx[0], 'last')
  return { title, body, options, selected, hints, esc: hints.some(h => /\besc\b/i.test(h)), numbered: true, links }
}

/**
 * Above the first option: the body up to a rule (╌ separates parts and is passed over), at most 16 lines. The title is
 * the question (the last line ending in ?), else the last line (`fallback` 'first': the first, a panel's own title);
 * the rest is the body, in order. `ruled`: a rule closed it (not the 16 lines, not the screen's top).
 */
function bodyAbove(lines: string[], first: number, fallback: 'first' | 'last') {
  const body: string[] = []
  let ruled = false
  // (a table's drawn lines do not count to the 16: a plan's table stays whole)
  let counted = 0
  for (let j = first - 1; j >= 0 && counted < 16; j--) {
    const l = lines[j]
    const r = RULE.exec(l)
    if (r) { if (r[1] === '╌') { if (body.length && body[0] !== '') body.unshift(''); continue } ruled = true; break }
    body.unshift(l.trim())
    if (!isBoxLine(l)) counted++
  }
  while (body.length && !body[0]) body.shift()
  while (body.length && !body[body.length - 1]) body.pop()
  const collapsed = body.filter((l, i) => l || (i > 0 && body[i - 1]))
  let at = -1
  for (let i = collapsed.length - 1; i >= 0; i--) if (/\?\s*$/.test(collapsed[i])) { at = i; break }
  if (at < 0) at = fallback === 'first' ? (collapsed.length ? 0 : -1) : collapsed.length - 1
  const title = at >= 0 ? collapsed[at] : ''
  const rest = collapsed.filter((_, i) => i !== at)
  while (rest.length && !rest[0]) rest.shift()
  while (rest.length && !rest[rest.length - 1]) rest.pop()
  return { title, body: rest, links: linksIn(collapsed), ruled, count: collapsed.length }
}

const URL_RE = /https?:\/\/[^\s<>"'`]+/g
const URL_TAIL = /^[^\s<>"'`]+$/
/**
 * The URLs in a dialog's lines, a URL that runs to a line's end joined with the lines under it that are one bare piece
 * each (the terminal wrapped it); a sentence's last period is not part of it
 */
export function linksIn(lines: string[]): string[] {
  const out: string[] = []
  for (let i = 0; i < lines.length; i++) {
    let next = i
    for (const m of lines[i].matchAll(URL_RE)) {
      let url = m[0]
      if (m.index! + url.length === lines[i].length && lines[i].length >= 40) {
        for (let j = i + 1; j < lines.length && URL_TAIL.test(lines[j]) && !/^https?:/.test(lines[j]); j++) { url += lines[j]; next = j }
      }
      url = url.replace(/[.,;:!?)\]]+$/, '')
      if (url.length > 10 && !out.includes(url)) out.push(url)
    }
    i = next
  }
  return out
}

/** One row of a panel's list, marked: the mark (❯ or >), then its label */
const MARKED = /^([\s ]*)([❯>])[\s ]+(\S.*?)\s*$/
/** a row's label never starts like Claude's prose or a tool line: a bullet, a tree mark, a number, a quote */
const NOT_ROW = /^(?:[●⎿•·✻✶✳✢✽*+\-–—│|#>❯]|\d{1,2}[.)]\s)/
/** what may follow a panel's rows: its key hints only */
const HINT = /\b(?:esc|enter|tab|space|ctrl\+\S+|shift\+\S+|to (?:select|navigate|cancel|confirm|close|go back|toggle))\b|[↑↓←→]/i
const indentOf = (l: string) => l.length - l.replace(/^[\s ]+/, '').length

/**
 * A panel's list of plain rows (2026-11-19: /remote-control's "Disconnect this session · Show QR code · Continue"; the
 * same shape in other panels): at least two rows at one column, exactly one marked ❯ (or >) two columns to the left of
 * its label, a row's dim line (deeper) under it, blank lines only under the marked row; a title and body above, closed
 * by a rule (every dialog of Claude Code's draws one over itself); under the rows nothing but key hints. Never the
 * prompt box (a rule follows it) and never a reply of Claude's (no rule over it, its own marks, prose after it).
 */
function plainRows(lines: string[]): Dialog | null {
  const marks: number[] = []
  for (let i = 0; i < lines.length; i++) if (MARKED.test(lines[i])) marks.push(i)
  if (!marks.length) return null
  const at = marks[marks.length - 1]
  const m = MARKED.exec(lines[at])!
  const col = indentOf(lines[at]) + 1 + indentOf(lines[at].slice(m[1].length + 1))
  if (col - m[1].length !== 2) return null
  const rows: { i: number; label: string; desc: string[] }[] = [{ i: at, label: m[3], desc: [] }]
  // under the marked row: rows, their dim lines, blank lines; then the hints
  let j = at + 1
  for (; j < lines.length; j++) {
    const l = lines[j]
    if (!l.trim()) continue
    if (MARKED.test(l) || RULE.test(l)) return null
    const ind = indentOf(l)
    if (ind > col) { rows[rows.length - 1].desc.push(l.trim()); continue }
    if (ind < col) break
    rows.push({ i: j, label: l.trim(), desc: [] })
  }
  const hints: string[] = []
  for (; j < lines.length; j++) {
    const l = lines[j]
    if (!l.trim()) continue
    if (RULE.test(l) || !HINT.test(l) || hints.length >= 3) return null
    hints.push(l.trim())
  }
  // over it: rows and their dim lines back to a blank line or a line further left (the body)
  let pending: string[] = []
  let top = at
  for (let k = at - 1; k >= 0; k--) {
    const l = lines[k]
    if (!l.trim()) break
    const ind = indentOf(l)
    if (ind < col) break
    if (RULE.test(l)) return null
    if (ind > col) { pending.unshift(l.trim()); continue }
    rows.unshift({ i: k, label: l.trim(), desc: pending })
    pending = []
    top = k
  }
  if (pending.length) return null
  if (rows.length < 2 || rows.length > 12) return null
  if (rows.some(r => r.label.length > 100 || NOT_ROW.test(r.label))) return null
  const { title, body, links, ruled, count } = bodyAbove(lines, top, 'first')
  if (!ruled || !count || !title) return null
  const options: DialogOption[] = rows.map((r, k) => ({ n: k + 1, label: r.label, desc: r.desc, free: false }))
  const selected = rows.findIndex(r => r.i === at)
  return { title, body, options, selected, hints, esc: hints.some(h => /\besc\b/i.test(h)), numbered: false, links }
}

/** Two readings are the same dialog (its options' labels) */
export const sameDialog = (a: Dialog | null, b: Dialog | null) =>
  !!a && !!b && a.options.length === b.options.length && a.options.every((o, i) => o.label === b.options[i].label)

/** Everything a card shows of a reading: two readings with one signature are the same card */
export const dialogSig = (d: Dialog) => JSON.stringify([d.title, d.body, d.options.map(o => [o.label, o.desc]), d.selected, d.hints, d.links])

export type DialogKey ='up' | 'down' | 'enter' | 'esc'
export interface DialogDeps {
  read(): string | null
  key(k: DialogKey): Promise<boolean>
  paste(text: string): Promise<boolean>
  sleep(ms: number): Promise<void>
}
export type DialogResult = { ok: true } | { ok: false; reason: 'gone' | 'moved' | 'key' | 'words' }

export const DIALOG_LIMITS = Object.freeze({ stepMs: 60, waitMs: 1500 })

async function until<T>(d: DialogDeps, f: () => T | null, limits = DIALOG_LIMITS): Promise<T | null> {
  for (let w = 0; w < limits.waitMs; w += limits.stepMs) {
    await d.sleep(limits.stepMs)
    const v = f()
    if (v !== null) return v
  }
  return null
}

/** Picks option `index` (0-based) of the dialog now on the screen; `words` for an option that takes them */
export async function answerDialog(index: number, d: DialogDeps, words?: string, limits = DIALOG_LIMITS): Promise<DialogResult> {
  const first = parseDialog(d.read())
  if (!first || index < 0 || index >= first.options.length) return { ok: false, reason: 'gone' }
  let at = first.selected
  while (at !== index) {
    const dir: DialogKey = index > at ? 'down' : 'up'
    if (!(await d.key(dir))) return { ok: false, reason: 'key' }
    const next = at + (dir === 'down' ? 1 : -1)
    const seen = await until(d, () => {
      const x = parseDialog(d.read())
      return x && sameDialog(first, x) && x.selected !== at ? x.selected : null
    }, limits)
    if (seen !== next) return { ok: false, reason: seen === null ? 'gone' : 'moved' }
    at = next
  }
  if (words !== undefined && words.trim()) {
    const head = words.trim().replace(/\s+/g, ' ').slice(0, 12)
    if (!(await d.paste(words))) return { ok: false, reason: 'key' }
    const shown = await until(d, () => ((d.read() ?? '').replace(/\s+/g, ' ').includes(head) ? true : null), limits)
    if (!shown) return { ok: false, reason: 'words' }
  }
  if (!(await d.key('enter'))) return { ok: false, reason: 'key' }
  return { ok: true }
}
