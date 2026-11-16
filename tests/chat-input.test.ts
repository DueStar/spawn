/**
 * electron/chatInput.cjs — what the chat composer types into a Claude Code terminal: the
 * user's text sanitised (no control character, no escape sequence can ride along), one
 * bracketed paste (never one Enter per line), a leading space when the first character would
 * change its meaning, a slash command typed as is, each image path a paste of its own; and the
 * input ledger that says what may be on the terminal's prompt row. All pure.
 */

import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const I = require('../electron/chatInput.cjs')
const { sanitize, isCommand, literalPrefix, quotePath, pastablePath, encodeSend, nextDraft, mayType, busyReason, isRealInput, tokens, INPUT_CAPS, ENTER, ESC, PASTE_START, PASTE_END } = I

describe('the constants', () => {
  it('are the only spelling of Enter, Esc and the paste brackets', () => {
    expect(ENTER).toBe('\r')
    expect(ESC).toBe('\x1b')
    expect(PASTE_START).toBe('\x1b[200~')
    expect(PASTE_END).toBe('\x1b[201~')
    expect(INPUT_CAPS).toEqual({ chars: 20_000, images: 8 })
  })
})

describe('sanitize', () => {
  it('line ends, control characters, escape sequences, the trailing whitespace', () => {
    expect(sanitize('a\r\nb\rc')).toBe('a\nb\nc')
    expect(sanitize('x\x1b[201~y')).toBe('x[201~y')
    expect(sanitize('\u0007bell')).toBe('bell')
    expect(sanitize('  keep lead  \n')).toBe('  keep lead')
    expect(sanitize('a\tb')).toBe('a\tb')
    expect(sanitize('del\x7f c1\u0085\u009b[0m end')).toBe('del c1[0m end')
    expect(sanitize('ctrl-c \x03 ctrl-u \x15 nul \x00')).toBe('ctrl-c  ctrl-u  nul')
  })
  it('Korean, Japanese and emoji unchanged', () => {
    for (const s of ['강 세 개만 알려 줘', '川を三つ教えて', '좋아요 👍🏽 ✅']) expect(sanitize(s)).toBe(s)
  })
})

describe('isCommand and the leading-space rule', () => {
  it('a slash command: single line, command-shaped', () => {
    expect(isCommand('/compact')).toBe(true)
    expect(isCommand('/compact keep the API notes')).toBe(true)
    expect(isCommand('/plugin:do-it now')).toBe(true)
    expect(isCommand('/compact\nmore')).toBe(false)
    expect(isCommand('/ path')).toBe(false)
    expect(isCommand('//x')).toBe(false)
    expect(isCommand('/usr/bin is slow')).toBe(false)
    expect(isCommand('hello')).toBe(false)
  })
  it('a space before ! # @ and a / that is not a command; none otherwise', () => {
    const table: [string, string][] = [
      ['!ls', ' '], ['#note', ' '], ['@README.md look', ' '], ['/compact', ''], ['/usr/bin is slow', ' '],
      ['/ path', ' '], ['//x', ' '], ['hello', ''], [' /compact', ''], [' !ls', ''], ['', ''],
    ]
    for (const [text, want] of table) expect(literalPrefix(text), JSON.stringify(text)).toBe(want)
  })
  it('a path with whitespace is quoted, as the terminal\'s own drop does', () => {
    expect(quotePath('C:\\Users\\user\\a b\\x.png')).toBe('"C:\\Users\\user\\a b\\x.png"')
    expect(quotePath('C:\\Users\\user\\x.png')).toBe('C:\\Users\\user\\x.png')
  })
})

describe('encodeSend', () => {
  const P = (s: string) => PASTE_START + s + PASTE_END
  it('a plain line: one bracketed paste and its head', () => {
    const e = encodeSend({ text: 'Without tools, name three rivers', images: [] })
    expect(e.steps).toEqual([{ data: P('Without tools, name three rivers'), waitMs: 0 }])
    expect(e.expect).toEqual({ head: 'Without tools, name thre', images: 0, long: false })
    expect(e.command).toBe(false)
    expect(e.minEnterMs).toBe(150)
  })
  it('three lines: one paste with the newlines inside, long', () => {
    const e = encodeSend({ text: 'one\ntwo\nthree', images: [] })
    expect(e.steps).toEqual([{ data: P('one\ntwo\nthree'), waitMs: 0 }])
    expect(e.expect).toEqual({ head: 'one', images: 0, long: true })
  })
  it('over 200 characters on one line: long', () => {
    expect(encodeSend({ text: 'x'.repeat(201), images: [] }).expect.long).toBe(true)
    expect(encodeSend({ text: 'x'.repeat(200), images: [] }).expect.long).toBe(false)
  })
  it('a command typed as is; a command with a second line is not one', () => {
    const c = encodeSend({ text: '/compact', images: [] })
    expect(c.steps).toEqual([{ data: '/compact', waitMs: 0 }])
    expect(c.command).toBe(true)
    expect(c.expect).toEqual({ head: '/compact', images: 0, long: false })
    const n = encodeSend({ text: '/compact\nmore', images: [] })
    expect(n.steps).toEqual([{ data: P(' /compact\nmore'), waitMs: 0 }])
    expect(n.command).toBe(false)
    expect(n.expect.head).toBe('/compact')
  })
  it('literal starts: the space inside the paste, the head without it', () => {
    const e = encodeSend({ text: '!echo hi', images: [] })
    expect(e.steps[0].data).toBe(P(' !echo hi'))
    expect(e.expect.head).toBe('!echo hi')
  })
  it('text and two images, one path with a space: three steps, quoted, 650 ms before Enter', () => {
    const e = encodeSend({ text: 'what is this?', images: ['C:\\T\\a.png', 'C:\\T x\\b.png'] })
    expect(e.steps).toEqual([
      { data: P('what is this?'), waitMs: 0 },
      { data: ' ' + P('C:\\T\\a.png'), waitMs: 60 },
      { data: ' ' + P('"C:\\T x\\b.png"'), waitMs: 60 },
    ])
    expect(e.expect).toEqual({ head: 'what is this?', images: 2, long: false })
    expect(e.minEnterMs).toBe(650)
  })
  it('images only: two image steps, no head', () => {
    const e = encodeSend({ text: '', images: ['C:\\T\\a.png', 'C:\\T\\b.png'] })
    expect(e.steps.map((s: { data: string }) => s.data)).toEqual([' ' + P('C:\\T\\a.png'), ' ' + P('C:\\T\\b.png')])
    expect(e.expect).toEqual({ head: '', images: 2, long: false })
  })
  it('a command with an image is not a command', () => {
    expect(encodeSend({ text: '/compact', images: ['C:\\T\\a.png'] }).command).toBe(false)
  })

  it('property: nothing outside a paste is Enter or a newline; nothing inside can end it early', () => {
    let seed = 7
    const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff }
    const parts = ['a', 'b', ' ', '\r', '\n', '\r\n', '\x1b', '\x1b[201~', '\x1b[200~', '\x03', '\x00', '\x7f', '\u009b', '/', '!', '#', '@', '강', '\t', '[201~', 'x']
    for (let n = 0; n < 1000; n++) {
      const raw = Array.from({ length: Math.floor(rnd() * 30) }, () => parts[Math.floor(rnd() * parts.length)]).join('')
      const text = sanitize(raw)
      const images = rnd() < 0.3 ? ['C:\\T\\a.png'] : []
      if (!text.trim() && !images.length) continue
      const e = encodeSend({ text, images })
      for (const { data } of e.steps) {
        if (e.command) { expect(data, JSON.stringify(raw)).not.toMatch(/[\x00-\x1f\x7f-\x9f]/); continue }
        const at = data.indexOf(PASTE_START)
        expect(at, JSON.stringify(raw)).toBeGreaterThanOrEqual(0)
        expect(data.endsWith(PASTE_END)).toBe(true)
        const outside = data.slice(0, at)
        const inside = data.slice(at + PASTE_START.length, data.length - PASTE_END.length)
        expect(outside, JSON.stringify(raw)).toMatch(/^ ?$/)
        expect(inside.includes('\x1b'), JSON.stringify(raw)).toBe(false)
        expect(inside.includes('\r'), JSON.stringify(raw)).toBe(false)
      }
    }
  })
})

describe('the input ledger', () => {
  const kb = (data: string, dialog = false) => ({ via: 'keyboard', data, dialog })
  const run = (d: string, evs: object[]) => evs.reduce((s: string, ev) => nextDraft(s, ev), d)

  it('the keyboard', () => {
    expect(nextDraft('clean', kb('a'))).toBe('dirty')
    expect(nextDraft('clean', kb('\x1b[200~pasted\x1b[201~'))).toBe('dirty')
    expect(nextDraft('dirty', kb('\r'))).toBe('submitted')
    expect(nextDraft('clean', kb('\r'))).toBe('clean')
    // (review I-3: Enter on an unknown row — a prompt recalled with ↑, a suggestion taken with Tab — submits it)
    expect(nextDraft('unknown', kb('\r'))).toBe('submitted')
    expect(nextDraft('clean', kb('\x7f'))).toBe('clean')
    expect(nextDraft('clean', kb('\b'))).toBe('clean')
    expect(nextDraft('dirty', kb('\x7f'))).toBe('unknown')
    expect(run('clean', [kb('abc'), kb('\x7f\x7f\x7f')])).toBe('unknown')
    for (const k of ['\x1b[D', '\x1b[C', '\x1b[H', '\x1b[F', '\x1bOD', '\x1bOC', '\x1b[1~', '\x1b[4~', '\x1b[1;5D', '\x1b[I', '\x1b[O']) {
      expect(nextDraft('clean', kb(k)), JSON.stringify(k)).toBe('clean')
      expect(nextDraft('dirty', kb(k)), JSON.stringify(k)).toBe('dirty')
    }
    for (const k of ['\x1b', '\x1b[A', '\x1b[B', '\t', '\x03', '\x15', '\x1b\r', '\x1b[99z', '\n']) {
      expect(nextDraft('clean', kb(k)), JSON.stringify(k)).toBe('unknown')
    }
    expect(nextDraft('clean', kb('강'))).toBe('dirty')
  })
  it('keys while a dialog is open answer the dialog: the row is unchanged', () => {
    expect(nextDraft('clean', kb('1', true))).toBe('clean')
    expect(nextDraft('dirty', kb('\r', true))).toBe('dirty')
    expect(nextDraft('clean', kb('\x1b', true))).toBe('clean')
  })
  it('the side box, the chat, Esc, the prompt signal, the timeout', () => {
    expect(nextDraft('clean', { via: 'side', phase: 'typed' })).toBe('dirty')
    expect(nextDraft('dirty', { via: 'side', phase: 'enter' })).toBe('submitted')
    expect(nextDraft('clean', { via: 'chat', phase: 'typed' })).toBe('dirty')
    expect(nextDraft('dirty', { via: 'chat', phase: 'enter' })).toBe('submitted')
    expect(nextDraft('dirty', { via: 'chat', phase: 'aborted' })).toBe('dirty')
    expect(nextDraft('clean', { via: 'esc' })).toBe('unknown')
    expect(nextDraft('submitted', { via: 'prompt' })).toBe('clean')
    expect(nextDraft('clean', { via: 'prompt' })).toBe('clean')
    expect(nextDraft('dirty', { via: 'prompt' })).toBe('dirty')
    expect(nextDraft('unknown', { via: 'prompt' })).toBe('unknown')
    expect(nextDraft('submitted', { via: 'timeout' })).toBe('unknown')
    expect(nextDraft('clean', { via: 'what' })).toBe('unknown')
  })
  it('mayType: an empty row always; text only while the ledger is clean; unknown never', () => {
    for (const d of ['clean', 'dirty', 'submitted', 'unknown']) {
      expect(mayType('empty', d)).toBe(true)
      expect(mayType('text', d)).toBe(d === 'clean')
      expect(mayType('unknown', d)).toBe(false)
    }
    expect(mayType('what', 'clean')).toBe(false)
  })
})

describe('the review of Phase 3 (what it found, fixed)', () => {
  const kb = (data: string) => ({ via: 'keyboard', data, dialog: false })
  const run = (d: string, evs: object[]) => evs.reduce((x: string, ev) => nextDraft(x, ev), d)

  it('I-1: a text ending in a backslash gets one space after it, inside the paste, so Enter is not Claude Code\'s "\\ + Enter = new line"', () => {
    // Claude Code trims the prompt, so the model gets the same text; nothing is refused for it (the
    // trial on a real session confirms the backslash turns Enter into a new line, and the space stops it)
    const e = encodeSend({ text: sanitize('C:\\Users\\me\\'), images: [] })
    expect(e.steps).toEqual([{ data: '\x1b[200~C:\\Users\\me\\ \x1b[201~', waitMs: 0 }])
    expect(e.expect.head).toBe('C:\\Users\\me\\')
    // a command typed raw, the same
    expect(encodeSend({ text: '/foo C:\\x\\', images: [] }).steps[0].data).toBe('/foo C:\\x\\ ')
    // a backslash elsewhere: untouched
    expect(encodeSend({ text: 'a\\b', images: [] }).steps[0].data).toBe('\x1b[200~a\\b\x1b[201~')
  })

  it('I-2: blank lines before the text go; the leading-space rule and the echo look at the first real line; the head is never empty', () => {
    expect(sanitize('\n\n  \nhello')).toBe('hello')
    expect(sanitize('\n   keep the lead')).toBe('   keep the lead')
    // the reviewer's reproductions: an empty head made the echo pass for anything on the row
    const bang = encodeSend({ text: sanitize('\n!rm -rf ~'), images: [] })
    expect(bang.steps[0].data).toBe('\x1b[200~ !rm -rf ~\x1b[201~')
    expect(bang.expect.head).toBe('!rm -rf ~')
    const slash = encodeSend({ text: sanitize('\n/usr/bin is slow'), images: [] })
    expect(slash.expect.head).not.toBe('')
    for (const t of ['\nleading', '\n\n\t x', ' \n y', 'a', '강']) expect(encodeSend({ text: sanitize(t), images: [] }).expect.head, JSON.stringify(t)).not.toBe('')
  })

  it('m4: a lone surrogate becomes U+FFFD (as the terminal shows it); a pair is kept', () => {
    expect(sanitize('a\ud800b')).toBe('a\ufffdb')
    expect(sanitize('a\udc00b')).toBe('a\ufffdb')
    expect(sanitize('👍🏽')).toBe('👍🏽')
  })

  it('I-3: the terminal\'s own answers to queries (DA, a cursor position, OSC and DCS strings) are not keys', () => {
    for (const k of ['\x1b[?1;2c', '\x1b[>0;276;0c', '\x1b[12;40R', '\x1b]11;rgb:0000/0000/0000\x07', '\x1b]10;rgb:ffff/ffff/ffff\x1b\\', '\x1bP>|xterm.js\x1b\\', '\x1b[?2004;1$y']) {
      expect(tokens(k), JSON.stringify(k)).toEqual(['report'])
      expect(nextDraft('clean', kb(k)), JSON.stringify(k)).toBe('clean')
      expect(isRealInput(k), JSON.stringify(k)).toBe(false)
    }
    // terminal ↑ (or Tab) then Enter, then the reader hears the prompt: clean again, not stuck
    expect(run('clean', [kb('\x1b[A'), kb('\r'), { via: 'prompt' }])).toBe('clean')
    expect(run('clean', [kb('\t'), kb('\r'), { via: 'prompt' }])).toBe('clean')
    // an Enter that submitted nothing: 5 s later, unknown again (never clean on a guess)
    expect(run('unknown', [kb('\r'), { via: 'timeout' }])).toBe('unknown')
  })

  it('I-3: an unknown row has a reason of its own (not "text is there")', () => {
    expect(busyReason('dirty')).toBe('prompt-busy')
    expect(busyReason('unknown')).toBe('prompt-unknown')
    expect(busyReason('submitted')).toBe('prompt-unknown')
  })

  it('isRealInput: reports and cursor moves are not input; text, Enter, Esc, history are', () => {
    for (const k of ['\x1b[I', '\x1b[O', '\x1b[<0;10;5M', '\x1b[D', '\x1b[1;5C']) expect(isRealInput(k), JSON.stringify(k)).toBe(false)
    for (const k of ['a', '\r', '\x1b', '\x1b[A', '\t', '\x7f', '\x1b[200~x\x1b[201~']) expect(isRealInput(k), JSON.stringify(k)).toBe(true)
  })

  it('m10: an image path with a quote or a control character is never pasted', () => {
    expect(pastablePath('C:\\Users\\user\\AppData\\Local\\Temp\\spawn-chat-0a1b2c3d\\x.png')).toBe(true)
    expect(pastablePath('C:\\Temp\\a folder\\x.png')).toBe(true)
    for (const bad of ['C:\\Te"mp\\x.png', 'C:\\Te\nmp\\x.png', 'C:\\Te\x1bmp\\x.png', '', 42]) expect(pastablePath(bad), JSON.stringify(bad)).toBe(false)
  })
})
