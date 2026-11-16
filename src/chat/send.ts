/**
 * The page's half of a chat send (Phase 3; the plan's "send, step by step"). Main types the
 * text without Enter (chat.send) and presses Enter only on a submit whose echo the page saw
 * (chat.submit); this is everything in between:
 *
 *   0. the session waits on the user → refused here (`waiting`)
 *   1. the prompt row read from the page's own terminal buffer; not readable → refused here (`screen`)
 *   2. the provisional bubble (not for a slash command), chat.send
 *   3. the echo watched every 50 ms for 1.5 s (+ 0.5 s an image): a dialog or another text stop at once;
 *      once it is right, main's minimum before Enter is waited out here and the screen read once more
 *   4. chat.submit with what was seen last; the bubble is sent, or it goes and the text is said to be
 *      left on the terminal's prompt row (`leftOnPrompt`: sending again would double it)
 *
 * One send at a time per terminal, decided before anything is awaited (a double click, a key
 * repeat). Nothing is ever retried. Bridge, screen and clock are injected (tests, the QA page).
 */

import { echoState, promptRow, type EchoState } from './promptRow'
import type { Outbox, OutboxImage } from './outbox'
import type { EchoVerdict, Expect, LensStatus, ScreenVerdict, SendRefusal, SubmitRefusal } from './types'

export interface SendDeps {
  bridge: {
    send(p: { id: string; sendId: string; text: string; images: string[]; screen: ScreenVerdict }): Promise<{ ok: true; expect: Expect; command: boolean; minEnterMs?: number } | { ok: false; reason: SendRefusal }>
    submit(p: { id: string; sendId: string; echo: EchoVerdict }): Promise<{ ok: true } | { ok: false; reason: SubmitRefusal }>
  }
  /** the terminal's last lines as text (src/termMetrics.ts termText) */
  readScreen(id: string): string | null
  now(): number
  sleep(ms: number): Promise<void>
  outbox: Outbox
  newId(): string
  status: LensStatus | null
  /** the largest transcript order the page has (src/chat/outbox.ts baselineOf) */
  baseline: number
}

export type SendResult = { ok: true; command: boolean } | { ok: false; reason: SendRefusal | SubmitRefusal; leftOnPrompt: boolean }

const ECHO_MS = 1500
const ECHO_IMAGE_MS = 500
const POLL_MS = 50

/** A margin over main's minimum before Enter (two processes, one clock, rounding) */
const ENTER_MARGIN_MS = 20

/** As main sanitises the start: blank lines before the first one with text go (electron/chatInput.cjs sanitize) */
const dropLeadingBlank = (s: string) => s.replace(/\r\n?/g, '\n').replace(/^(?:[ \t]*\n)+/, '')

/**
 * The same test main makes (electron/chatInput.cjs isCommand): a one-line slash command, typed as
 * is. Main's answer decides; the page uses this for the hint and the bubble shown before it.
 */
export function isCommandText(text: string): boolean {
  const s = dropLeadingBlank(String(text ?? '')).replace(/\s+$/, '')
  return !s.includes('\n') && !s.includes('\t') && /^\/[A-Za-z][\w:.-]{0,63}(?:[ \t]|$)/.test(s)
}

/** A lone surrogate (half of a pair) as the terminal and main show it: U+FFFD */
export function wellFormed(s: string): string {
  return s.replace(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g, '�')
}

/** Terminals with a send running on this page */
const busy = new Set<string>()

/** A random id for one send (main accepts each once) */
export function newSendId(): string {
  const b = new Uint8Array(12)
  crypto.getRandomValues(b)
  return Array.from(b, x => x.toString(16).padStart(2, '0')).join('')
}

export async function sendDraft(draft: { id: string; text: string; images: OutboxImage[] }, d: SendDeps): Promise<SendResult> {
  const { id } = draft
  const text = draft.text.replace(/\s+$/, '')
  if (busy.has(id)) return { ok: false, reason: 'sending', leftOnPrompt: false }
  // (a card open for this session (Phase 4): it is answered first; Enter here never answers it)
  if (d.status?.state === 'waiting' || (d.status?.asks?.length ?? 0) > 0) return { ok: false, reason: 'waiting', leftOnPrompt: false }
  const row = promptRow(d.readScreen(id))
  if (row.kind === 'unknown') return { ok: false, reason: 'screen', leftOnPrompt: false }
  busy.add(id)
  try {
    const sendId = d.newId()
    // the bubble shows at once, from the page's own guess; main's answer decides (a command has none)
    let bubble = !(isCommandText(text) && !draft.images.length)
    const local = `${sendId}`
    const shown = wellFormed(dropLeadingBlank(text))
    const addBubble = () => d.outbox.add({ local, text: shown, images: draft.images, state: 'sending', at: d.now(), baseline: d.baseline })
    if (bubble) addBubble()
    let sent: Awaited<ReturnType<SendDeps['bridge']['send']>>
    try {
      sent = await d.bridge.send({ id, sendId, text, images: draft.images.map(i => i.token), screen: row.kind })
    } catch {
      sent = { ok: false, reason: 'no-session' }
    }
    if (!sent.ok) {
      // nothing was typed: the draft and its chips stay in the composer, so do their pictures
      if (bubble) d.outbox.remove(local, false)
      return { ok: false, reason: sent.reason, leftOnPrompt: false }
    }
    const answeredAt = d.now()
    // what the row showed before the paste (a suggestion, the placeholder): seen again, it is not drawn yet
    const before = row.kind === 'text' ? row.text : null
    if (sent.command && bubble) { d.outbox.remove(local, false); bubble = false }
    else if (!sent.command && !bubble) { addBubble(); bubble = true }
    // the echo, on the page's own screen
    const limit = ECHO_MS + ECHO_IMAGE_MS * sent.expect.images
    // (counted in polls, so a clock set back or stopped never makes it endless; and by the clock, at
    // twice the limit, so slow reads of the screen never outlast main's patience)
    let seen: EchoState = 'pending'
    for (let waited = 0; ; waited += POLL_MS) {
      seen = echoState(d.readScreen(id), sent.expect, before)
      if (seen !== 'pending' || waited >= limit || d.now() - answeredAt >= 2 * limit) break
      await d.sleep(POLL_MS)
    }
    // the echo is there: wait out main's minimum before Enter, then look once more (a dialog that
    // opened meanwhile, another text) — the screen is read last right before Enter is asked for
    if (seen === 'ok') {
      const rest = answeredAt + (typeof sent.minEnterMs === 'number' ? sent.minEnterMs : 150) + ENTER_MARGIN_MS - d.now()
      if (rest > 0) await d.sleep(rest)
      seen = echoState(d.readScreen(id), sent.expect, before)
    }
    const echo: EchoVerdict = seen === 'pending' ? 'timeout' : seen
    let done: Awaited<ReturnType<SendDeps['bridge']['submit']>>
    try {
      done = await d.bridge.submit({ id, sendId, echo })
    } catch {
      done = { ok: false, reason: 'no-session' }
    }
    if (!done.ok) {
      if (bubble) d.outbox.remove(local)
      return { ok: false, reason: done.reason, leftOnPrompt: true }
    }
    if (bubble) d.outbox.mark(local, 'sent', d.now())
    return { ok: true, command: sent.command }
  } finally {
    busy.delete(id)
  }
}
