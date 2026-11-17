'use strict'

/**
 * chatInput.cjs — what the chat composer types into a Claude Code terminal (the chat view,
 * Phase 3), and what may be on that terminal's prompt row. Pure: no IO, no clock.
 *
 * The user's text is sanitised (sanitize): no control character and no escape sequence can
 * ride along, so nothing can smuggle an Enter, a Ctrl+C or an early end of the paste. It goes
 * as one bracketed paste (a multi-line prompt stays one prompt; a paste opens none of Claude
 * Code's per-key pop-ups), with a leading space when its first character would change its
 * meaning (`!` shell mode, `#` memory, `@` a mention, a `/` that is not a command), as the
 * spike found (FINDINGS §6). A single-line slash command the user wrote is typed as is. Each
 * image is its own paste of its absolute path (FINDINGS §7: it becomes `[Image #n]`). Enter
 * is never part of what is typed: chatHost.cjs writes it later, once, and only after the
 * page saw the echo (encodeSend's `expect`).
 *
 * The ledger (nextDraft, mayType): what may be on the prompt row since the last submit, fed
 * by every way input reaches the terminal. A greyed suggestion cannot be told from typed text
 * on the screen; the ledger can: text on the row with a clean ledger is a suggestion, which a
 * paste replaces (and the echo makes sure of it).
 *
 * These constants are the only place the chat code spells Enter, Esc or the paste brackets.
 */

const ENTER = '\r'
const ESC = '\x1b'
/** Shift+Tab: Claude Code's key for the next permission mode (the chat's mode menu, 2026-11-17) */
const SHIFT_TAB = '\x1b[Z'
/** ↑ / ↓: a terminal dialog's mark moved from the chat's dialog card (2026-11-17) */
const ARROW_UP = '\x1b[A'
const ARROW_DOWN = '\x1b[B'
/** Ctrl+E (the caret to its line's end) and Backspace: words left on the prompt row cleared from the chat */
const LINE_END = '\x05'
const BACKSPACE = '\x7f'
const PASTE_START = '\x1b[200~'
const PASTE_END = '\x1b[201~'
const INPUT_CAPS = Object.freeze({ chars: 20_000, images: 8 })

/**
 * The user's text, safe to paste: CRLF and CR → LF; every C0 control except LF and TAB, DEL
 * and the C1 range removed (so no ESC, hence no `\x1b[201~`, survives); a lone surrogate (half
 * of a pair) becomes U+FFFD, as the terminal would show it, so the echo can match; blank lines
 * before the first one with text dropped (Claude Code trims them anyway, and the first real
 * line is what the leading-space rule and the echo look at); the whole trimmed at the end;
 * the leading spaces of the first real line kept (a leading space the user typed means
 * "literally").
 */
function sanitize(text) {
  return String(text ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, '')
    .replace(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g, '�')
    .replace(/^(?:[ \t]*\n)+/, '')
    .replace(/\s+$/, '')
}

const COMMAND = /^\/[A-Za-z][\w:.-]{0,63}(?:[ \t]|$)/

/** A slash command the user wrote: one line, no tab (typed as is, a tab would complete), command-shaped */
function isCommand(text) {
  const s = String(text ?? '')
  return !s.includes('\n') && !s.includes('\t') && COMMAND.test(s)
}

/** A leading space when the first character would change the text's meaning, else none */
function literalPrefix(text) {
  const c = String(text ?? '').charAt(0)
  if (c === '!' || c === '#' || c === '@') return ' '
  if (c === '/' && !isCommand(text)) return ' '
  return ''
}

/** A path as the terminal's own drop pastes it: quoted when it has whitespace */
function quotePath(p) {
  return /\s/.test(p) ? `"${p}"` : p
}

/**
 * An image path that may be pasted (it comes from the app's own temp folder, under the OS temp
 * folder): absolute text with no quote (it is quoted when it has a space) and no control character
 */
function pastablePath(p) {
  return typeof p === 'string' && p.length > 0 && p.length < 1024 && !/["\x00-\x1f\x7f-\x9f]/.test(p)
}

const HEAD_CHARS = 24
const LONG_CHARS = 200

/**
 * Claude Code's "quick escape": a `\` right before the cursor turns Enter into a new line, so a
 * text ending in `\` (a Windows folder: `C:\Users\me\`) would never be submitted. One space after
 * it, inside what is typed, keeps the Enter an Enter; Claude Code trims the prompt, so the model
 * gets the same text. (Confirmed on a real session in the Phase 3 trial; nothing is refused for it.)
 */
const endGuard = (s) => (s.endsWith('\\') ? ' ' : '')

/**
 * The steps to type for one send (no Enter in any of them), what the echo must show, whether
 * it is a command, and how long after the last step Enter may come at the earliest (FINDINGS
 * §6: 150 ms after the text worked every time; an image needs Claude Code to read its file).
 * @param {{ text: string, images: string[] }} p  the text sanitised already; absolute image paths
 */
function encodeSend({ text, images = [], shell = false }) {
  // shell: the composer's own shell mode (the user chose it), the one way a `!` is pasted as Claude Code's bash
  // mode; a `!` written in the normal composer stays literal (literalPrefix). A command runs alone: no images
  const paths = Array.isArray(images) && !shell ? images : []
  const t = String(text ?? '')
  if (shell) {
    const line = '!' + t
    const head = [...line.replace(/\s+/g, ' ').trim()].slice(0, HEAD_CHARS).join('').trimEnd()
    return { steps: [{ data: PASTE_START + line + endGuard(line) + PASTE_END, waitMs: 0 }], expect: { head, images: 0, long: t.includes('\n') || t.length > LONG_CHARS }, command: false, minEnterMs: 150 }
  }
  if (isCommand(t) && !paths.length) {
    return { steps: [{ data: t + endGuard(t), waitMs: 0 }], expect: { head: t, images: 0, long: false }, command: true, minEnterMs: 150 }
  }
  const steps = []
  const prefixed = t ? literalPrefix(t) + t : ''
  if (t) steps.push({ data: PASTE_START + prefixed + endGuard(prefixed) + PASTE_END, waitMs: 0 })
  for (const p of paths) steps.push({ data: ' ' + PASTE_START + quotePath(String(p)) + PASTE_END, waitMs: 60 })
  // the echo's head: the first line with text (sanitize dropped the blank ones before it); never
  // empty when there is text, or the echo check would pass for anything on the row
  const first = (prefixed.split('\n').find(l => l.trim()) ?? '').replace(/\s+/g, ' ').trim()
  const head = [...first].slice(0, HEAD_CHARS).join('').trimEnd()
  if (t.trim() && !head) throw new Error('chatInput: a text with no head')
  return {
    steps,
    expect: { head, images: paths.length, long: t.includes('\n') || t.length > LONG_CHARS },
    command: false,
    minEnterMs: 150 + 250 * paths.length,
  }
}

// ---- the ledger --------------------------------------------------------------

/** Keys that move the cursor without changing the row: left, right, home, end (also with modifiers) */
const MOVE = /^\x1b(?:\[(?:\d+(?:;\d+)?)?[CDHF]|O[CDHF]|\[[1478]~)$/
/**
 * Reports the terminal sends by itself, never a key: focus in / out, a mouse event (SGR), xterm's
 * answers to an application's queries (device attributes `\x1b[?…c` / `\x1b[>…c`, a cursor
 * position `\x1b[r;cR`, a mode report `\x1b[?…$y`). OSC and DCS answers (a colour, a setting)
 * are matched as whole strings in tokens().
 */
const REPORT = /^\x1b\[(?:[IO]|<[\d;]*[Mm]|[?>][\d;]*c|\d+;\d+R|\??[\d;]*\$y)$/
/** An OSC or DCS string the terminal answered with (`\x1b]11;rgb:…\x07`, `\x1bP…\x1b\\`) */
const STRING_REPORT = /^\x1b[\]P][^\x07\x1b]*(?:\x07|\x1b\\)/

/** The keyboard's data as tokens: paste, enter, backspace, move, report, text, other */
function tokens(data) {
  const out = []
  let i = 0
  while (i < data.length) {
    if (data.startsWith(PASTE_START, i)) {
      const end = data.indexOf(PASTE_END, i + PASTE_START.length)
      out.push('paste')
      i = end < 0 ? data.length : end + PASTE_END.length
      continue
    }
    const c = data[i]
    if (c === '\r') { out.push('enter'); i++; continue }
    if (c === '\x7f' || c === '\b') { out.push('backspace'); i++; continue }
    if (c === '\x1b') {
      const str = STRING_REPORT.exec(data.slice(i, i + 4096))
      if (str) { out.push('report'); i += str[0].length; continue }
      const m = /^\x1b(?:\[[\d;<=>?]*[\x20-\x2f]*[\x40-\x7e]|O[\x40-\x7e]|[\s\S])?/.exec(data.slice(i, i + 256))
      const seq = m[0]
      out.push(MOVE.test(seq) ? 'move' : REPORT.test(seq) ? 'report' : 'other')
      i += seq.length
      continue
    }
    const code = c.charCodeAt(0)
    if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) { out.push('other'); i++; continue }
    out.push('text')
    i++
  }
  return out
}

/**
 * Whether keyboard data changes anything on the prompt row or in a dialog: anything but the
 * terminal's own reports and the cursor moving. (A send in flight is spoilt by real input only;
 * Phase 4: a hold is released by real input only.)
 */
function isRealInput(data) {
  return tokens(String(data ?? '')).some(tok => tok !== 'report' && tok !== 'move')
}

/**
 * The next ledger state.
 * @param {'clean'|'dirty'|'submitted'|'unknown'} d
 * @param {{ via: 'keyboard', data: string, dialog: boolean } | { via: 'side'|'chat', phase: string } | { via: 'esc'|'prompt'|'timeout' }} ev
 */
function nextDraft(d, ev) {
  const via = ev && ev.via
  if (via === 'keyboard') {
    // a dialog open: the keys answer it, the prompt row is not touched
    if (ev.dialog) return d
    let s = d
    for (const tok of tokens(String(ev.data ?? ''))) {
      if (tok === 'text' || tok === 'paste') s = 'dirty'
      // (Enter on an unknown row, the everyday case of a prompt recalled with ↑ or a suggestion
      // taken with Tab: whatever was there went with it, and UserPromptSubmit makes the row clean;
      // when nothing went, 5 s without it make the row unknown again)
      else if (tok === 'enter') s = s === 'dirty' || s === 'unknown' ? 'submitted' : s
      else if (tok === 'backspace') s = s === 'clean' ? 'clean' : 'unknown'
      else if (tok === 'move' || tok === 'report') { /* the row is unchanged */ }
      else s = 'unknown'
    }
    return s
  }
  if (via === 'side' || via === 'chat') {
    if (ev.phase === 'typed' || ev.phase === 'aborted') return 'dirty'
    if (ev.phase === 'enter') return 'submitted'
    return 'unknown'
  }
  if (via === 'esc') return 'unknown'
  if (via === 'prompt') return d === 'submitted' || d === 'clean' ? 'clean' : d
  return 'unknown'
}

/**
 * The page's reading of the row with the ledger: may the chat type now? (1.6.2) The page reads which characters are
 * dim: a row of only dim text is a placeholder or a greyed suggestion, which a paste replaces (`suggestion`), any
 * normal character is someone's text (`typed`); the screen decides those, whatever the ledger says. Plain `text`
 * comes from a page that could not read the marks: the ledger decides, as before.
 */
function mayType(screen, d) {
  if (screen === 'empty' || screen === 'suggestion') return true
  if (screen === 'text') return d === 'clean'
  return false
}

/**
 * Why not, with text on the row: `prompt-busy` when someone typed there (the ledger saw it),
 * `prompt-unknown` when the ledger cannot tell a suggestion from typed text (a key it cannot
 * follow: ↑ history, Tab, Ctrl+U, Esc; an Enter not confirmed yet)
 */
function busyReason(d) {
  return d === 'dirty' ? 'prompt-busy' : 'prompt-unknown'
}

module.exports = { ENTER, ESC, SHIFT_TAB, ARROW_UP, ARROW_DOWN, LINE_END, BACKSPACE, PASTE_START, PASTE_END, INPUT_CAPS, sanitize, isCommand, literalPrefix, quotePath, pastablePath, encodeSend, tokens, isRealInput, nextDraft, mayType, busyReason }
