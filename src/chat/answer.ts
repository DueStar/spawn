/**
 * The answer cards' pure parts (Phase 4): what a card shows of a command or a file's text, whether a
 * click on one of its buttons was meant for it, and which card the surface shows.
 *
 * A card shows what Claude Code asks exactly: no markdown, nothing cut, in logical order (the CSS keeps
 * it so), and the characters a terminal or a browser would hide, reorder or draw like another one
 * (control characters, direction overrides and isolates, zero-width and other default-ignorable
 * marks, the Hangul fillers, the Braille blank, spaces that are not the plain space, separators,
 * unassigned and private-use code points) written out as [U+XXXX] marks, so nobody approves something
 * they cannot see. A URL whose host is not plain ASCII gets its host as the DNS sees it (punycode)
 * written next to it. Newlines and tabs stay as they are (a diff line may show tabs and trailing
 * spaces as quiet marks).
 */

import type { AskCard } from './types'

export interface TextPart { text: string; mark?: true; ws?: true }

/**
 * The characters written out as marks, as Unicode properties (a pattern of the characters themselves
 * would hold what it names): control (but newline and tab), format (bidi, zero-width, tags, the soft
 * hyphen …), separators, surrogates, private use, unassigned, every default-ignorable code point (the
 * Hangul fillers, variation selectors, the Mongolian ones, the musical invisible ones), the Braille
 * blank, and any space but the plain one and the ideographic one (U+3000: Japanese prose, drawn wide).
 */
const HIDDEN = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Cs}\p{Co}\p{Cn}\p{Default_Ignorable_Code_Point}⠀]/u
const ODD_SPACE = /\p{Zs}/u
const hidden = (c: string) => (c !== '\n' && c !== '\t' && HIDDEN.test(c)) || (c !== ' ' && c !== '　' && ODD_SPACE.test(c))

const mark = (c: string) => `[U+${c.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')}]`

/** A URL's host as the DNS sees it, when it is not plain ASCII (else null) */
export function asciiHost(host: string): string | null {
  if (![...host].some(c => c.codePointAt(0)! > 127)) return null
  try {
    const h = new URL(`http://${host}`).hostname
    return h && h !== host ? h : null
  } catch { return null }
}

/** Where a URL's non-ASCII host ends in `s`, with its ASCII form (an index → the mark's text) */
function hostMarks(s: string): Map<number, string> {
  const out = new Map<number, string>()
  const re = /[a-z][a-z0-9+.-]*:\/\/(?:[^\s/?#@]*@)?([^\s/?#:\\]+)/giu
  for (const m of s.matchAll(re)) {
    const host = m[1]
    const ascii = asciiHost(host)
    if (ascii) out.set(m.index! + m[0].length, `[${ascii}]`)
  }
  return out
}

/**
 * The text in parts: plain runs as they are, each hidden character as a visible mark, a URL's
 * non-ASCII host followed by its ASCII form. `ws`: tabs and trailing spaces as quiet marks too (a diff
 * line: a whitespace-only change is never invisible).
 */
export function visibleText(s: string, { ws = false }: { ws?: boolean } = {}): TextPart[] {
  const out: TextPart[] = []
  const hosts = hostMarks(s)
  let trailFrom = s.length
  if (ws) { const m = /[ \t]+$/.exec(s); if (m) trailFrom = m.index }
  let run = ''
  const flush = () => { if (run) { out.push({ text: run }); run = '' } }
  let i = 0
  for (const c of s) {
    const host = hosts.get(i)
    if (host) { flush(); out.push({ text: host, mark: true }) }
    if (hidden(c)) { flush(); out.push({ text: mark(c), mark: true }) }
    else if (ws && c === '\t') { flush(); out.push({ text: '→\t', ws: true }) }
    else if (ws && c === ' ' && i >= trailFrom) { flush(); out.push({ text: '·', ws: true }) }
    else run += c
    i += c.length
  }
  const end = hosts.get(i)
  if (end) { flush(); out.push({ text: end, mark: true }) }
  if (run || !out.length) out.push({ text: run })
  return out
}

/**
 * How long a card must have been on the screen — painted, with the window in front — before a pointer
 * press on it counts (review I2: a press already on its way, or the click that brings the window
 * forward, was meant for what was there). Firefox's own dialogs wait a second.
 */
export const ARM_MS = 800

/**
 * When the window last came back (focus, or the page visible again): a card shown before that is
 * armed again from then. Kept for the page (one window), monotonic clock.
 */
let woke = 0
export function noteWake(at: number) { if (at > woke) woke = at }
export function lastWake() { return woke }

/**
 * A click on a card's button is an answer when it came from the keyboard on the focused button
 * (`detail` 0: Enter or Space; the focus is never moved onto a card), or from a pointer pressed on that
 * same button once the card had been painted ARM_MS ago and the window had been in front as long. A
 * press that began earlier, on something else, or before the card was painted (`shownAt` Infinity)
 * is not one.
 */
export function clickAccepted({ detail, downAt, shownAt, wokeAt = 0 }: { detail: number; downAt: number | null; shownAt: number; wokeAt?: number }): boolean {
  if (detail === 0) return true
  if (downAt === null || !Number.isFinite(shownAt)) return false
  return downAt - Math.max(shownAt, wokeAt) >= ARM_MS
}

/** A card the chat can answer now (main may still refuse it) */
export const answerable = (card: AskCard) => card.state === 'open' && card.holdId !== null && !card.cut

/**
 * The card the surface shows (review M7): the oldest one that can be answered here, else the oldest.
 * A read-only card (a plan, one too long, one handed back) never hides one that can be answered.
 */
export function shownCard(asks: readonly AskCard[] | undefined | null): AskCard | null {
  if (!asks || !asks.length) return null
  return asks.find(answerable) ?? asks[0]
}

/**
 * What the composer says about the card it waits behind (review M8): 'here' (answer it on the card
 * above), 'sent' (the answer went; Claude Code has not finished with it), 'terminal' (it can only be
 * answered in the terminal). Null: no card.
 */
export function cardNote(card: AskCard | null): 'here' | 'sent' | 'terminal' | null {
  if (!card) return null
  if (card.state === 'sent') return 'sent'
  return answerable(card) ? 'here' : 'terminal'
}
