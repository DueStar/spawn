/**
 * What a real session showed after 1.5.1 (Claude Code 2.1.325, Windows, `"tui": "fullscreen"`):
 * every send from the chat was refused as `screen` ("터미널이 지금 입력을 받을 수 있는지 확인하지
 * 못했어요") while the terminal took the same text. Two shapes of the prompt box the first composer trial never
 * met, each a real screen redacted by hand (tests/fixtures/chat/screens/real-*.txt):
 *
 *   a named session (/rename, --name)   Claude Code draws the name at the right end of the box's top
 *                                        rule ("───…─── Spawn ─"); the session seen was named
 *   a subagent running (fullscreen)     the agents panel under the footer: a blank line, "● main",
 *                                        one line per agent
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { echoState, promptRow } from '../src/chat/promptRow'

const screen = (name: string) => readFileSync(join(__dirname, 'fixtures', 'chat', 'screens', `${name}.txt`), 'utf8')
const R = '─'.repeat(100)

describe('a named session: the name in the top rule of the prompt box', () => {
  it('is read as the prompt box (empty, then the echo of a send)', () => {
    expect(promptRow(screen('real-named-session'))).toEqual({ kind: 'empty' })
    const typed = screen('real-named-session').replace('❯\u00a0', '❯\u00a0Reply with the single word: no.')
    expect(promptRow(typed)).toEqual({ kind: 'text', text: 'Reply with the single word: no.' })
    expect(echoState(typed, { head: 'Reply with the single wo', images: 0, long: false })).toBe('ok')
  })

  it('a long name, a Korean name, and a recalled prompt with a name read alike', () => {
    for (const label of ['A very long session name for the chat view label test, longer than sixty', '채팅 테스트']) {
      expect(promptRow(['x', `${'─'.repeat(30)} ${label} ─`, '❯ hello', R, '  footer'].join('\n')), label).toEqual({ kind: 'text', text: 'hello' })
    }
    expect(promptRow(['x', `─── History 2/3 ${'─'.repeat(60)} Spawn ─`, '❯ hello', R, '  footer'].join('\n'))).toEqual({ kind: 'text', text: 'hello' })
  })

  it('still not a box: a label with a prompt mark, a rule too short, a dashed rule', () => {
    expect(promptRow(['x', `${'─'.repeat(30)} a ❯ b ─`, '❯ hello', R, '  footer'].join('\n'))).toEqual({ kind: 'unknown', why: 'no-box' })
    expect(promptRow(['x', '── Spawn ─', '❯ hello', R, '  footer'].join('\n'))).toEqual({ kind: 'unknown', why: 'no-box' })
    expect(promptRow(['x', `${'╌'.repeat(30)} Spawn ╌`, '❯ hello', R, '  footer'].join('\n'))).toEqual({ kind: 'unknown', why: 'no-box' })
  })
})

describe('a subagent running: the agents panel under the footer', () => {
  it('is not taken for a footer too long', () => {
    expect(promptRow(screen('real-agents-panel'))).toEqual({ kind: 'empty' })
    const typed = screen('real-agents-panel').replace('❯\u00a0', '❯\u00a0Reply with the single word: yes.')
    expect(echoState(typed, { head: 'Reply with the single wo', images: 0, long: false })).toBe('ok')
  })

  it('several agents, and the panel with a name in the top rule', () => {
    const agents = Array.from({ length: 6 }, (_, i) => `  ◯ general-purpose  Task ${i + 1}                 ${i + 3}s · ↓ 1.2k tokens`)
    expect(promptRow(['x', R, '❯ hi', R, '  Opus 5.5 · ctx 7%', '  ⏵⏵ accept edits on', '', '  ● main', ...agents].join('\n'))).toEqual({ kind: 'text', text: 'hi' })
    expect(promptRow(['x', `${R} Spawn ─`, '❯', R, '  Opus 5.5', '', '  ● main', '  ◯ Explore  Find it   3s'].join('\n'))).toEqual({ kind: 'empty' })
  })

  it('not a panel: no blank line before it, a line not indented, a selection mark, a footer too long above it, a shell', () => {
    // (the indented lines with no blank line before them: the footer too long, as before)
    expect(promptRow(['x', R, '❯', R, '  a', '  b', '  c', '  d', '  e'].join('\n'))).toEqual({ kind: 'unknown', why: 'no-box' })
    expect(promptRow(['x', R, '❯', R, '  footer', '  mode', '', '  ● main', '  ◯ a', 'not indented'].join('\n'))).toEqual({ kind: 'unknown', why: 'no-box' })
    expect(promptRow(['x', R, '❯', R, '  footer', '  mode', '', '  ● main', '  ◯ a', '  ❯ ◯ general-purpose  Task'].join('\n'))).toEqual({ kind: 'unknown', why: 'no-box' })
    expect(promptRow(['x', R, '❯', R, '  a', '  b', '  c', '  d', '  e', '', '  ● main'].join('\n'))).toEqual({ kind: 'unknown', why: 'no-box' })
    expect(promptRow(['x', R, '❯', R, '  footer', '', '  ● main', 'PS C:\\Users\\user\\work\\demo>'].join('\n'))).toEqual({ kind: 'unknown', why: 'no-box' })
    // a dialog under the box still wins
    expect(promptRow(['x', R, '❯', R, '  footer', '', '  ● main', ' ❯ 1. Yes', '   2. No'].join('\n'))).toEqual({ kind: 'unknown', why: 'dialog' })
  })
})

describe('the prompt mark drawn as a plain > (seen in 1.5.3\'s log)', () => {
  it('is read as the prompt box: empty, typed, the echo of a send', () => {
    const s = screen('real-ascii-mark')
    expect(promptRow(s)).toEqual({ kind: 'empty' })
    const typed = s.replace('>\u00a0', '>\u00a0안녕 채팅에서 보내요')
    expect(promptRow(typed)).toEqual({ kind: 'text', text: '안녕 채팅에서 보내요' })
    expect(echoState(typed, { head: '안녕 채팅에서 보내요', images: 0, long: false })).toBe('ok')
  })
  it('a numbered menu with a plain > is still a dialog (never typed into)', () => {
    expect(promptRow(['x', R, '>\u00a0', R, '  footer', ' > 1. Yes', '   2. No'].join('\n'))).toEqual({ kind: 'unknown', why: 'dialog' })
    expect(promptRow(['x', R, '>\u00a0', R, '> 1. Yes', '  2. No'].join('\n'))).toEqual({ kind: 'unknown', why: 'dialog' })
  })
  it('a > not at the first column, or a shell prompt, is not the prompt box', () => {
    expect(promptRow(['x', R, ' > text', R, '  footer'].join('\n'))).toEqual({ kind: 'unknown', why: 'no-box' })
    expect(promptRow(['x', R, '>\u00a0', R, 'PS C:\\Users\\user\\work>'].join('\n'))).toEqual({ kind: 'unknown', why: 'no-box' })
  })
})
