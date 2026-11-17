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

export interface DialogOption { n: number; label: string; desc: string[]; free: boolean }
export interface Dialog { title: string; body: string[]; options: DialogOption[]; selected: number; hints: string[]; esc: boolean }

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
  // above the first option: the body up to a rule (╌ separates parts and is passed over), at most 16 lines
  const body: string[] = []
  for (let j = idx[0] - 1; j >= 0 && body.length < 16; j--) {
    const l = lines[j]
    const r = RULE.exec(l)
    if (r) { if (r[1] === '╌') { if (body.length && body[0] !== '') body.unshift(''); continue } break }
    body.unshift(l.trim())
  }
  while (body.length && !body[0]) body.shift()
  while (body.length && !body[body.length - 1]) body.pop()
  const collapsed = body.filter((l, i) => l || (i > 0 && body[i - 1]))
  const title = collapsed.length ? collapsed[collapsed.length - 1] : ''
  return { title, body: collapsed.slice(0, -1), options, selected, hints, esc: hints.some(h => /\besc\b/i.test(h)) }
}

/** Two readings are the same dialog (its options' labels) */
export const sameDialog = (a: Dialog | null, b: Dialog | null) =>
  !!a && !!b && a.options.length === b.options.length && a.options.every((o, i) => o.label === b.options[i].label)

export type DialogKey = 'up' | 'down' | 'enter' | 'esc'
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
