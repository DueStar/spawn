/**
 * A question with option previews (AskUserQuestion's `preview`: a small drawing or code per option). The card shows
 * each option's preview as it is drawn (monospace, line breaks kept), and once answered the question's row says
 * which option was chosen (or the words the user wrote) with the chosen option's preview.
 */
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { ToolRow } from '../src/components/chat/ToolRow'
import { ChatContext } from '../src/components/chat/context'
import { itemProblems } from './chat-helpers'

const require = createRequire(import.meta.url)
const { createItemBuilder } = require('../electron/chatItems.cjs')

const BOX = '┌────┬────┐\n│ A  │░░░░│\n└────┴────┘'
const Q = '어디에 놓을까요?'
const input = { questions: [{ question: Q, header: '놓을 자리', multiSelect: false, options: [{ label: '칸 사이 틈', description: '틈에', preview: '│ ┊ │' }, { label: '칸의 반', description: '반쪽', preview: BOX }] }] }
const callLine = { type: 'assistant', uuid: 'u1', message: { id: 'm1', role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_ask1', name: 'AskUserQuestion', input }] } }
const resultLine = (answers: Record<string, string>) => ({ type: 'user', uuid: 'u2', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_ask1', content: `Your questions have been answered: "${Q}"="${Object.values(answers)[0]}". You can now continue.` }] }, toolUseResult: { questions: input.questions, answers, annotations: {} } })

const ctx = { id: 'T', onTerminal() {}, onLink() {}, onPath() {}, loadAgent: async () => ({ ok: false }), waitingAgents: [] }
const draw = (item: any) => renderToStaticMarkup(React.createElement(ChatContext.Provider, { value: ctx }, React.createElement(ToolRow, { item })))

describe('the question row', () => {
  it('keeps each option\'s preview, and once answered, the answer', () => {
    const b = createItemBuilder({ cwd: 'C:\\w' })
    const [call] = b.line(callLine, 10)
    expect(call.input.previews).toEqual(['│ ┊ │', BOX])
    const [done] = b.line(resultLine({ [Q]: '칸의 반' }), 20)
    expect(done.input.answer).toBe('칸의 반')
    expect(itemProblems(done)).toEqual([])
  })

  it('says which option was chosen, with its preview drawn as it is', () => {
    const b = createItemBuilder({ cwd: 'C:\\w' })
    b.line(callLine, 10)
    const [done] = b.line(resultLine({ [Q]: '칸의 반' }), 20)
    const html = draw(done)
    expect(html).toMatch(/<li class="chat-ask-chosen"[^>]*>칸의 반/)
    expect(html).toContain('chat-ask-preview')
    expect(html).toContain('░░░░')
    // (the options not chosen: plain, no preview)
    expect(html).not.toContain('│ ┊ │')
  })

  it('an answer in the user\'s own words (not an option) is said as their answer', () => {
    const b = createItemBuilder({ cwd: 'C:\\w' })
    b.line(callLine, 10)
    const [done] = b.line(resultLine({ [Q]: '둘 다 아니고 위아래로' }), 20)
    const html = draw(done)
    expect(html).toContain('chat-ask-own')
    expect(html).toContain('둘 다 아니고 위아래로')
  })
})

describe('the question card', () => {
  it('draws each option\'s preview under it (monospace, as drawn)', () => {
    const src = readFileSync(join(__dirname, '..', 'src/components/chat/QuestionCard.tsx'), 'utf8')
    expect((src.match(/chat-card-optpre/g) ?? []).length).toBeGreaterThanOrEqual(2)
    const lens = readFileSync(join(__dirname, '..', 'electron/chatLens.cjs'), 'utf8')
    expect(lens).toMatch(/preview: cutTo\(o\.preview, CARD\.preview\)/)
    const css = readFileSync(join(__dirname, '..', 'src/styles/chat.css'), 'utf8')
    expect(css).toMatch(/\.chat-card-optpre[^{]*\{[^}]*white-space: pre/)
  })
})
