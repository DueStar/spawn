/**
 * The prompt row of a Claude Code screen, read from the page's own copy of the terminal
 * (src/termMetrics.ts termText: the last lines of the xterm buffer as text), and the echo of
 * what the composer typed there. The composer types nothing unless this says the row is
 * there and what is on it, and presses Enter only when the echo is right (the plan's "send,
 * step by step").
 *
 * Only the shape verified on Claude Code 2.1.323–2.1.325 counts as the prompt box: a solid rule
 * (─), the prompt mark ❯ at the start of the first line, continuation lines indented by two
 * spaces, another solid rule, and a short footer under it. A dialog (a numbered menu with the
 * selection mark, or dashed rules ╌ under the last solid rule) wins over everything. Anything
 * else (bash mode's `!`, a shell, a shape a newer Claude Code draws) is `unknown`: nothing is sent.
 *
 * Pure: no page, no clock. Only the last 24 lines are looked at.
 */

export type RowVerdict =
  | { kind: 'empty' }
  | { kind: 'text'; text: string }
  | { kind: 'unknown'; why: 'no-reader' | 'short' | 'dialog' | 'no-box' }

export interface EchoExpect { head: string; images: number; long: boolean }
export type EchoState = 'ok' | 'pending' | 'mismatch' | 'blocked'

const LOOK = 24
const SOLID = /^\s*─{20,}\s*$/
const DASHED = /╌{20,}/
/**
 * the box's top rule with a label in it: a prompt recalled with ↑ at its left ("─── History 33/33 ───…"; the Phase 3
 * trial), a named session's name (/rename, --name) at its right ("───…─── Spawn ─"; the owner's session after 1.5.1),
 * or both; still at least 20 rule characters in all (topLabelled)
 */
const TOP_LABELLED = /^\s*─{2,}(?: [^─╌❯]+? ─+)+\s*$/
const topLabelled = (l: string) => TOP_LABELLED.test(l) && (l.match(/─/g)?.length ?? 0) >= 20
// The prompt and selection mark is ❯, or a plain > where Claude Code draws it so (the owner's own app, 1.5.3's log:
// ">" and a no-break space under a named session's rule, where the trial copies drew ❯). A > counts as the
// prompt only with that no-break space after it; either counts as a menu's selection mark
/** a numbered menu line with the selection mark (a dialog), anywhere on its line */
const MENU = /^\s*[❯>]\s*\d+\.\s/
/** the same, indented: never a prompt Claude Code echoed (those start at the first column) */
const MENU_INDENTED = /^\s+[❯>]\s*\d+\.\s/
// (Claude Code 2.1.325 draws the mark with a no-break space after it: seen in the Phase 3 trial)
const PROMPT = /^(?:❯(?:[  ]|$)|>(?: |$))/
const INDENT = /^[  ]{2}/
/** a shell's prompt (Claude Code gone): PowerShell, cmd, or a POSIX prompt ending in $ # % */
const SHELL = /^(?:PS\s.*>|[A-Za-z]:\\.*>|\S+[$#%])\s*$/
/** lines under the box: the footer (the mode line, the status line) */
const FOOTER_MAX = 4
/** while a slash command is typed, Claude Code lists the commands that match under the box */
const COMMAND_FOOTER_MAX = 12
/**
 * while a subagent runs (`"tui": "fullscreen"`), the agents panel under the footer: a blank line, then indented lines,
 * the first a status glyph ("  ● main", "  ◯ general-purpose  …"), no selection mark (the owner's session after 1.5.1)
 */
const PANEL_MAX = 12
const PANEL_FIRST = /^\s+[^\p{L}\p{N}\s❯]/u

/** The footer is the short footer, then a blank line and the agents panel */
function agentsPanel(footer: string[]): boolean {
  const blank = footer.findIndex(l => !l.trim())
  if (blank < 0 || blank > FOOTER_MAX) return false
  const panel = footer.slice(blank + 1)
  const first = panel.find(l => l.trim())
  return !!first && panel.length <= PANEL_MAX && PANEL_FIRST.test(first) && panel.every(l => !l.trim() || (/^\s+\S/.test(l) && !l.includes('❯')))
}

/**
 * The shape of a screen's last lines for spawn.log (1.5.3: the owner's sends refused with no way to see why): every
 * letter and digit masked as `a`, spaces shown as `·`, a run of 8 or more of one character folded (`─×120`), each
 * line at most 160 characters. Never any text; the box's rules, marks and indentation stay.
 */
const KNOWN = new Set(['─', '╌', '❯', '●', '◯', '⏵', '·', '✻', '⎿', '…', '↓', '⚠'])
export function screenShape(screen: string | null): string {
  if (typeof screen !== 'string') return '(no terminal text)'
  // (a no-break space shows as ⍽; any other symbol outside ASCII and the box's own marks by its code point)
  const sym = (c: string) => c === ' ' ? '·' : c === ' ' ? '⍽' : (c >= '!' && c <= '~') || KNOWN.has(c) ? c : `{${c.codePointAt(0)!.toString(16)}}`
  return lastLines(screen, 14)
    .map(l => [...l.replace(/[\p{L}\p{N}]/gu, 'a')].map(sym).join('').replace(/(.)\1{7,}/gu, (m, c: string) => `${c}×${[...m].length}`).slice(0, 160))
    .join('\n')
}

/** The last `n` lines of a text, without splitting all of it (a long buffer costs nothing) */
function lastLines(text: string, n: number): string[] {
  let end = text.length
  // trailing empty lines go first
  while (end > 0) {
    const nl = text.lastIndexOf('\n', end - 1)
    if (text.slice(nl + 1, end).trim()) break
    end = nl < 0 ? 0 : nl
  }
  const out: string[] = []
  let at = end
  while (out.length < n && at > 0) {
    const nl = text.lastIndexOf('\n', at - 1)
    out.push(text.slice(nl + 1, at).replace(/\r$/, ''))
    at = nl < 0 ? 0 : nl
  }
  return out.reverse()
}

export function promptRow(screen: string | null): RowVerdict {
  if (typeof screen !== 'string') return { kind: 'unknown', why: 'no-reader' }
  const lines = lastLines(screen, LOOK)
  if (lines.filter(l => l.trim()).length < 3) return { kind: 'unknown', why: 'short' }

  // a dialog: an indented menu anywhere, or a menu / dashed rule under the last solid rule
  let last = -1
  for (let i = lines.length - 1; i >= 0; i--) if (SOLID.test(lines[i])) { last = i; break }
  if (lines.some(l => MENU_INDENTED.test(l))) return { kind: 'unknown', why: 'dialog' }
  if (lines.slice(last + 1).some(l => MENU.test(l) || DASHED.test(l))) return { kind: 'unknown', why: 'dialog' }
  if (last < 0) return { kind: 'unknown', why: 'no-box' }

  // the box: the nearest solid rule above the last one, 1–12 lines between
  let first = -1
  for (let i = last - 1; i >= Math.max(0, last - 13); i--) if (SOLID.test(lines[i]) || topLabelled(lines[i])) { first = i; break }
  const inside = first >= 0 ? lines.slice(first + 1, last) : []
  if (!inside.length || !PROMPT.test(inside[0])) return { kind: 'unknown', why: 'no-box' }
  if (inside.slice(1).some(l => l.trim() !== '' && !INDENT.test(l))) return { kind: 'unknown', why: 'no-box' }
  const text = [inside[0].slice(2), ...inside.slice(1).map(l => l.slice(2))].join('\n').trim()

  // the footer: short, no shell prompt (a command's list of matches may be longer, all indented; the agents panel
  // may follow it)
  const footer = lines.slice(last + 1)
  if (footer.some(l => SHELL.test(l.trim()) && !l.startsWith(' '))) return { kind: 'unknown', why: 'no-box' }
  const command = text.startsWith('/')
  if (footer.length > FOOTER_MAX && !agentsPanel(footer) && !(command && footer.length <= COMMAND_FOOTER_MAX && footer.every(l => !l.trim() || /^\s/.test(l)))) {
    return { kind: 'unknown', why: 'no-box' }
  }
  return text ? { kind: 'text', text } : { kind: 'empty' }
}

const collapse = (s: string) => s.replace(/\s+/g, ' ').trim()
const IMAGE = /\[Image #\d+\]/g

/**
 * Whether what the composer typed is on the prompt row, as typed: `ok` (Enter may follow),
 * `pending` (not there yet: an empty row, an image Claude Code is still reading), `mismatch`
 * (something else is on the row, e.g. a suggestion the paste was appended to), `blocked` (a
 * dialog: never press Enter into it). `before`: the row's text when the send was asked for (a
 * suggestion, the first-run placeholder): while the row still shows exactly that, Claude Code has
 * not drawn the paste yet (`pending`; the Phase 3 trial saw it 30 ms after the paste).
 */
export function echoState(screen: string | null, expect: EchoExpect, before?: string | null): EchoState {
  const v = promptRow(screen)
  if (v.kind === 'unknown') return v.why === 'dialog' ? 'blocked' : 'pending'
  if (v.kind === 'empty') return 'pending'
  const text = collapse(v.text)
  const head = collapse(expect.head)
  if (typeof before === 'string' && before && text === collapse(before)) return 'pending'
  if (head && !(text.startsWith(head) || (expect.long && text.startsWith('[Pasted text #')))) return 'mismatch'
  const images = text.match(IMAGE)?.length ?? 0
  if (images < expect.images) return 'pending'
  // images alone: the row is exactly their markers (anything else was on it before)
  if (!head && expect.images > 0 && (images !== expect.images || text.replace(IMAGE, ' ').trim() !== '')) return 'mismatch'
  // no head and no image: nothing to recognise, never ok (main always gives a head for text)
  if (!head && expect.images === 0) return 'mismatch'
  return 'ok'
}
