/**
 * src/chat/promptRow.ts — the composer reads Claude Code's prompt row from the page's own
 * terminal buffer (src/termMetrics.ts termText) before it types anything, and the echo of
 * what it typed before Enter. Only the verified shape counts as a prompt box; a dialog wins.
 * Screens: tests/fixtures/chat/screens/*.txt (hand-written, redacted).
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { echoState, promptRow } from '../src/chat/promptRow'
import { termText, trackTermMetrics, type TermMetrics } from '../src/termMetrics'

const screen = (name: string) => readFileSync(join(__dirname, 'fixtures', 'chat', 'screens', `${name}.txt`), 'utf8').replace(/\n$/, '')
const R = '─'.repeat(100)

describe('promptRow', () => {
  it('an empty box: idle and while Claude works', () => {
    expect(promptRow(screen('idle-empty'))).toEqual({ kind: 'empty' })
    expect(promptRow(screen('working-empty'))).toEqual({ kind: 'empty' })
  })

  it('text on the row: a placeholder, a greyed suggestion and typed text read alike', () => {
    expect(promptRow(screen('idle-placeholder'))).toEqual({ kind: 'text', text: 'Try "how does <filepath> work?"' })
    expect(promptRow(screen('after-turn-suggestion'))).toEqual({ kind: 'text', text: 'Read it first, then add mul' })
    expect(promptRow(screen('typed'))).toEqual({ kind: 'text', text: 'add a mul function' })
    expect(promptRow(screen('typed-multiline'))).toEqual({ kind: 'text', text: 'add a mul function\nafter sub, and export it\nwith a test' })
    expect(promptRow(screen('narrow-wrap'))).toEqual({ kind: 'text', text: 'please add a mul function after sub\nand export it from the module' })
  })

  it('every dialog is a dialog', () => {
    for (const name of ['dialog-bash', 'dialog-edit', 'dialog-plan', 'dialog-trust', 'dialog-question']) {
      expect(promptRow(screen(name)), name).toEqual({ kind: 'unknown', why: 'dialog' })
    }
  })

  it('anything that is not the verified box is not one: bash mode, a shell, too little, no reader', () => {
    expect(promptRow(screen('bash-mode'))).toEqual({ kind: 'unknown', why: 'no-box' })
    expect(promptRow(screen('no-box-shell'))).toEqual({ kind: 'unknown', why: 'no-box' })
    expect(promptRow(screen('short'))).toEqual({ kind: 'unknown', why: 'short' })
    expect(promptRow(null)).toEqual({ kind: 'unknown', why: 'no-reader' })
    // `>` instead of ❯; a line in the box that is not indented; a shell prompt under an old box
    expect(promptRow(['x', R, '> hello', R, '  footer'].join('\n'))).toEqual({ kind: 'unknown', why: 'no-box' })
    expect(promptRow(['x', R, '❯ hello', 'world', R, '  footer'].join('\n'))).toEqual({ kind: 'unknown', why: 'no-box' })
    expect(promptRow(['x', R, '❯ /exit', R, '  footer', 'PS C:\\Users\\user\\work\\demo>'].join('\n'))).toEqual({ kind: 'unknown', why: 'no-box' })
    expect(promptRow(['x', R, '❯', R, '  a', '  b', '  c', '  d', '  e'].join('\n'))).toEqual({ kind: 'unknown', why: 'no-box' })
  })

  it('a dialog below a box wins; a numbered prompt typed in the box, or echoed above it, is not a dialog', () => {
    expect(promptRow(['x', R, '❯', R, '  footer', ' ❯ 1. Yes', '   2. No'].join('\n'))).toEqual({ kind: 'unknown', why: 'dialog' })
    expect(promptRow(['x', R, '❯', R, '╌'.repeat(40)].join('\n'))).toEqual({ kind: 'unknown', why: 'dialog' })
    expect(promptRow(['❯ 1. add tests', '  2. fix lint', '', R, '❯ 1. and one more', R, '  footer'].join('\n'))).toEqual({ kind: 'text', text: '1. and one more' })
  })

  it('a slash command typed in the box: the command list under it is the footer', () => {
    const list = ['  /compact      Clear conversation history but keep a summary', '  /config       Open config panel', '  /context      Visualize current context', '  /cost         Show the total cost', '  /clear        Clear conversation history']
    expect(promptRow(['x', R, '❯ /co', R, ...list].join('\n'))).toEqual({ kind: 'text', text: '/co' })
    // not a command: the same list is too long a footer
    expect(promptRow(['x', R, '❯ co', R, ...list].join('\n'))).toEqual({ kind: 'unknown', why: 'no-box' })
  })

  it('looks only at the last 24 lines: a 2 000-line screen in under 5 ms', () => {
    const big = [...Array.from({ length: 2000 }, (_, i) => `line ${i} ❯ 1. Yes ${'x'.repeat(80)}`), screen('idle-empty')].join('\n')
    promptRow(big)
    const t0 = performance.now()
    for (let i = 0; i < 10; i++) expect(promptRow(big)).toEqual({ kind: 'empty' })
    expect((performance.now() - t0) / 10).toBeLessThan(5)
  })
})

describe('echoState', () => {
  const head = 'Without tools, name thre'
  it('the sent text at the start of the row: ok; appended to a suggestion: mismatch', () => {
    expect(echoState(screen('echo-plain'), { head, images: 0, long: false })).toBe('ok')
    expect(echoState(screen('echo-after-suggestion'), { head, images: 0, long: false })).toBe('mismatch')
    expect(echoState(screen('echo-korean'), { head: '강 세 개만 알려 줘', images: 0, long: false })).toBe('ok')
  })

  it('a long paste collapsed by Claude Code: ok only when the text was long', () => {
    expect(echoState(screen('echo-pasted'), { head: 'line one of a long paste', images: 0, long: true })).toBe('ok')
    expect(echoState(screen('echo-pasted'), { head: 'line one of a long paste', images: 0, long: false })).toBe('mismatch')
  })

  it('images: every [Image #n] there; a path not yet read is pending', () => {
    expect(echoState(screen('echo-image'), { head: 'what is in this picture?', images: 1, long: false })).toBe('ok')
    expect(echoState(screen('echo-image'), { head: 'what is in this picture?', images: 2, long: false })).toBe('pending')
    expect(echoState(screen('echo-image-pending'), { head: 'what is in this picture?', images: 1, long: false })).toBe('pending')
    expect(echoState(['x', R, '❯ [Image #1] [Image #2]', R, '  f'].join('\n'), { head: '', images: 2, long: false })).toBe('ok')
  })

  it('a dialog: blocked; an empty row or no reader: pending', () => {
    expect(echoState(screen('dialog-bash'), { head, images: 0, long: false })).toBe('blocked')
    expect(echoState(screen('idle-empty'), { head, images: 0, long: false })).toBe('pending')
    expect(echoState(null, { head, images: 0, long: false })).toBe('pending')
    expect(echoState(screen('bash-mode'), { head, images: 0, long: false })).toBe('pending')
  })

  it('whitespace is collapsed on both sides', () => {
    expect(echoState(['x', R, '❯ add a mul function', '  after sub', R, '  f'].join('\n'), { head: 'add a mul function after', images: 0, long: true })).toBe('ok')
  })
})

describe('termText', () => {
  const metrics = (text: string): TermMetrics => ({ id: 't1', fontFamily: '', fontSize: 13, cellWidth: null, cellHeight: null, cols: 100, rows: 30, faces: [], text })

  it('null with no reader, the reader\'s text with one, null when it throws', () => {
    expect(termText('t1')).toBeNull()
    const off = trackTermMetrics('t1', () => metrics('❯ hi'))
    expect(termText('t1')).toBe('❯ hi')
    off()
    expect(termText('t1')).toBeNull()
    const off2 = trackTermMetrics('t1', () => { throw new Error('gone') })
    expect(termText('t1')).toBeNull()
    off2()
  })
})
