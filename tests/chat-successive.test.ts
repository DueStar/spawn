/**
 * Several choices in a row (2026-11-19, the owner's report: "when I must choose several times in a row, I can choose
 * only once"). Two causes, both fixed:
 *
 * 1. The screen was read for a dialog only when every card was passed to the terminal. A card answered and still
 *    waiting on Claude Code (its tool running), or one that timed out (main handed it back), kept the next dialog —
 *    a permission its hook did not hold, a command's confirmation, the terminal's own copy of the timed-out ask —
 *    from ever getting a card (src/chat/answer.ts screenDialogs).
 * 2. The dialog card kept a reading while its options' labels were the same, so the next permission with the same
 *    options showed the last one's words (src/chat/dialog.ts dialogSig).
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { screenDialogs } from '../src/chat/answer'
import { answerDialog, dialogSig, parseDialog } from '../src/chat/dialog'
import type { AskCard } from '../src/chat/types'
import { AnswerSurface } from '../src/components/chat/AnswerSurface'

const read = (p: string) => readFileSync(join(__dirname, '..', p), 'utf8')
const ask = (key: string, state: AskCard['state'], extra: Partial<AskCard> = {}): AskCard => ({
  key, holdId: state === 'open' || state === 'sent' ? key : null, kind: 'permission', toolId: null, agent: false, tool: 'Bash', input: { command: `echo ${key}` }, always: null, state, since: 0, ...extra,
} as AskCard)

describe('screenDialogs: when the screen is read for a dialog', () => {
  it('no card, or every card passed to the terminal', () => {
    expect(screenDialogs([], false)).toBe(true)
    expect(screenDialogs(null, false)).toBe(true)
    expect(screenDialogs([ask('a', 'terminal')], false)).toBe(true)
  })
  it('a card timed out (main handed it back: the terminal draws it now)', () => {
    expect(screenDialogs([ask('a', 'timeout')], false)).toBe(true)
  })
  it('a card answered and waiting on Claude Code: once it has been so a moment', () => {
    expect(screenDialogs([ask('a', 'sent')], false)).toBe(false)
    expect(screenDialogs([ask('a', 'sent')], true)).toBe(true)
    expect(screenDialogs([ask('a', 'sent'), ask('b', 'terminal')], true)).toBe(true)
  })
  it('never while a card can be answered here (its own buttons answer it)', () => {
    expect(screenDialogs([ask('a', 'open')], true)).toBe(false)
    expect(screenDialogs([ask('a', 'sent'), ask('b', 'open')], true)).toBe(false)
  })
  it('ChatView reads it so, the settle time running from the answered cards', () => {
    const view = read('src/components/ChatView.tsx')
    expect(view).toContain('const termOnly = asks.length > 0 && screenDialogs(asks, sentSettled)')
    expect(view).toContain('const dialog = useTermDialog(id, !!dialogKey && (!asks.length || termOnly))')
    expect(view).toMatch(/setTimeout\(\(\) => setSentSettled\(true\), SENT_SETTLE_MS\)/)
  })
})

describe('the answer surface: the next card after an answer', () => {
  it('a card answered (sent) gives way to the next one that can be answered (a second permission, a second question)', () => {
    const html = renderToStaticMarkup(React.createElement(AnswerSurface, {
      id: 't', who: { name: 'Pika', kind: 'pokemon' } as never, onTerminal() {}, answer: async () => ({ ok: true as const }),
      asks: [ask('first', 'sent', { sent: 'allow' }), ask('second', 'open', { input: { command: 'echo second' } })],
    }))
    expect(html).toContain('echo second')
    expect(html).not.toContain('echo first')
    expect(html).toContain('1건 더 기다려요')
  })
})

// 2026-11-19: every question offers its own answer, as Claude Code's dialog does (its "Other" row)
describe('the question card: 직접 입력', () => {
  const render = (card: AskCard) => renderToStaticMarkup(React.createElement(AnswerSurface, {
    id: 't', who: { name: 'Pika', kind: 'pokemon' } as never, onTerminal() {}, answer: async () => ({ ok: true as const }), asks: [card],
  }))
  const question = { text: 'Which format?', header: 'Format', options: [{ label: 'JSON', description: '' }, { label: 'Markdown', description: '' }] }
  it('one question: its options, then 직접 입력 with a field and 보내기 (off until words are written)', () => {
    const html = render(ask('q', 'open', { kind: 'question', tool: 'AskUserQuestion', input: {}, question } as Partial<AskCard>))
    expect(html.indexOf('Markdown')).toBeLessThan(html.indexOf('직접 입력'))
    expect(html).toMatch(/<input[^>]*class="chat-card-field"/)
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>보내기<\/button>/)
  })
  it('several questions: one field per question; a card handed to the terminal has none', () => {
    const two = [question, { ...question, text: 'Which areas?', multiSelect: true }]
    const html = render(ask('q', 'open', { kind: 'question', tool: 'AskUserQuestion', input: {}, question, questions: two } as Partial<AskCard>))
    expect(html.match(/class="chat-card-field"/g)).toHaveLength(2)
    expect(render(ask('q', 'terminal', { kind: 'question', tool: 'AskUserQuestion', input: {}, question } as Partial<AskCard>))).not.toContain('chat-card-field')
  })
})

/** A terminal that shows its dialogs one after another: Enter answers the one on the screen, the next appears */
function sequence(screens: string[]) {
  let at = 0
  let lines = screens[0].split('\n')
  const keys: string[] = []
  const move = (dir: 1 | -1) => {
    const rows = lines.map((l, i) => (/^ (?:❯ | {2})(?:\d\. )?[A-Z]/.test(l) ? i : -1)).filter(i => i >= 0)
    const mark = rows.findIndex(i => lines[i].startsWith(' ❯ '))
    const to = rows[Math.max(0, Math.min(rows.length - 1, mark + dir))]
    lines = lines.map((l, i) => (i === rows[mark] ? `   ${l.slice(3)}` : i === to ? ` ❯ ${l.slice(3)}` : l))
  }
  return {
    keys,
    at: () => at,
    deps: {
      read: () => (at < screens.length ? lines.join('\n') : '❯ \n'),
      key: async (k: string) => {
        keys.push(k)
        if (k === 'down') move(1)
        if (k === 'up') move(-1)
        if (k === 'enter') { at++; lines = (screens[at] ?? '').split('\n') }
        return true
      },
      paste: async () => true,
      sleep: async () => {},
    },
  }
}

const permission = (command: string) => [
  '────────────────────────────────────────',
  ' Bash command',
  ` ${command}`,
  '',
  ' Do you want to proceed?',
  ' ❯ 1. Yes',
  "   2. Yes, and don't ask again for echo commands in ~\\work\\demo",
  '   3. No, and tell Claude what to do differently (esc)',
  '',
  ' Esc to cancel · Tab to amend',
].join('\n')

describe('one dialog after another, each answered from its card', () => {
  it('two permissions with the same options: two readings, each answered', async () => {
    const t = sequence([permission('echo one'), permission('echo two')])
    const first = parseDialog(t.deps.read())!
    expect(first.body).toContain('echo one')
    expect(await answerDialog(0, t.deps)).toEqual({ ok: true })
    const second = parseDialog(t.deps.read())!
    expect(second.body).toContain('echo two')
    // (the same options: the card is still a new one, with the new words)
    expect(second.options.map(o => o.label)).toEqual(first.options.map(o => o.label))
    expect(dialogSig(second)).not.toBe(dialogSig(first))
    expect(await answerDialog(1, t.deps)).toEqual({ ok: true })
    expect(t.keys).toEqual(['enter', 'down', 'enter'])
    expect(parseDialog(t.deps.read())).toBeNull()
  })
  it('a confirmation, then the panel it opens (RECONSTRUCTED: the shape of /rc\'s first run, then its panel)', async () => {
    const confirm = [
      '────────────────────────────────────────',
      ' Enable Remote Control?',
      ' Open the Code tab in the Claude mobile app, visit claude.ai/code in a browser.',
      '',
      ' ❯ 1. Yes',
      '   2. No',
      '',
      ' Enter to confirm · Esc to cancel',
    ].join('\n')
    const panel = read('tests/fixtures/chat/screens/reconstructed-rc-panel.txt').replace(/\r/g, '').replace(/\n+$/, '')
    const t = sequence([confirm, panel])
    expect(parseDialog(t.deps.read())!.title).toBe('Enable Remote Control?')
    expect(await answerDialog(0, t.deps)).toEqual({ ok: true })
    const next = parseDialog(t.deps.read())!
    expect(next.title).toBe('Remote Control')
    expect(next.numbered).toBe(false)
    expect(await answerDialog(0, t.deps)).toEqual({ ok: true })
    expect(t.keys).toEqual(['enter', 'up', 'up', 'enter'])
  })
  it('the card hook keeps a reading only while everything it shows is the same', () => {
    const src = read('src/components/chat/DialogCard.tsx')
    expect(src).toContain('setDialog(cur => (d && cur && dialogSig(cur) === dialogSig(d) ? cur : d))')
  })
})
