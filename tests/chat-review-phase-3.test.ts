/**
 * The review of Phase 3 (the composer), the minor findings that live in the components: each
 * pinned by what the component renders or does (react-dom/server, node environment), or by its
 * source where only a browser could act it out (the harness flows act them out too).
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { ControlRow } from '../src/components/chat/ControlRow'
import { UserMessage } from '../src/components/chat/UserMessage'
import { ChatContext } from '../src/components/chat/context'
import { filesOf } from '../src/components/chat/Composer'

const src = (f: string) => readFileSync(join(__dirname, '..', 'src', ...f.split('/')), 'utf8')

/** a DataTransfer as a paste from an office app gives it: text, and a picture of it */
function clipboard(text: string | null, files: { name: string; type: string }[]) {
  const fl = files.map(f => ({ ...f, size: 10 })) as unknown as File[]
  return {
    files: fl,
    items: [],
    getData: (t: string) => (t === 'text/plain' && text !== null ? text : ''),
  } as unknown as DataTransfer
}

describe('m5: a paste of text that also carries a picture of it', () => {
  it('is the text only; a picture with no text (a screenshot) comes in', () => {
    expect(filesOf(clipboard('A1\tB1\n1\t2', [{ name: 'image.png', type: 'image/png' }]), true)).toEqual([])
    expect(filesOf(clipboard(null, [{ name: 'image.png', type: 'image/png' }]), true)).toHaveLength(1)
    expect(filesOf(clipboard('   ', [{ name: 'image.png', type: 'image/png' }]), true)).toHaveLength(1)
    // a drop is never a paste: its files come in
    expect(filesOf(clipboard('x', [{ name: 'a.png', type: 'image/png' }]))).toHaveLength(1)
  })
})

describe('m12: the context meter with no number yet', () => {
  const control = (left: number | null) => ({ model: 'Opus', context: { left, tip: 'tip', label: 'HP' as const }, usage: {} })
  it('says it is not known, never 100', () => {
    const html = renderToStaticMarkup(React.createElement(ControlRow, { control: control(null), mode: null }))
    expect(html).not.toContain('aria-valuenow')
    expect(html).toContain('aria-valuetext')
    const known = renderToStaticMarkup(React.createElement(ControlRow, { control: control(42), mode: null }))
    expect(known).toContain('aria-valuenow="42"')
    expect(known).not.toContain('aria-valuetext')
  })
})

describe('m6: an unconfirmed bubble does not float for good', () => {
  it('offers 터미널에서 확인하기 and 지우기 (the outbox\'s own dismissal)', () => {
    const item = { id: 'pending:x', order: 1, at: 0, kind: 'user' as const, text: 'hi', images: 0, pending: 'unconfirmed' as const, local: 'x' }
    const ctx = { id: 'T', onTerminal() {}, onLink() {}, onPath() {}, loadAgent: async () => ({ ok: false }), waitingAgents: [] }
    const html = renderToStaticMarkup(React.createElement(ChatContext.Provider, { value: ctx }, React.createElement(UserMessage, { item, time: null })))
    expect(html).toContain('터미널에서 확인하기')
    expect(html).toContain('지우기')
    expect(src('components/chat/UserMessage.tsx')).toContain('outboxFor(id).dismiss(item.local)')
  })
})

describe('I-5: the side panel while a chat send is in flight', () => {
  const widget = src('Widget.tsx')
  // (the side box that said why is gone: removed 2026-11-16 at the owner's request)
  it('a pending /rename refused as busy stays pending (never typed into that send)', () => {
    expect(widget).toMatch(/res\.reason === 'busy' && !pendingRename\.current\.has\(id\)\) pendingRename\.current\.set\(id, name\)/)
  })
})

describe('m2 and m11: the composer', () => {
  const composer = src('components/chat/Composer.tsx')
  it('m2: the "/ goes as a command" hint only for text that goes as a command', () => {
    expect(composer).toContain("{isCommandText(text) && !chips.length ? <div className=\"chat-chint\">")
    expect(composer).not.toContain("text.startsWith('/') ? <div className=\"chat-chint\">")
  })
  it('m11: a mention picked or text inserted is the browser\'s own edit (undo keeps working), the value set only as a fallback', () => {
    expect(composer).toContain("document.execCommand('insertText', false, s)")
    expect(composer).toMatch(/replaceRange\(el, mention\.start, caret, `@\$\{f\} `\)/)
  })
  it('m7: a send whose page went away is said once as the composer opens', () => {
    expect(composer).toMatch(/chat\.stranded\(id\)\.then\(r => \{ if \(live && r\?\.stranded\) say\(/)
  })
})
