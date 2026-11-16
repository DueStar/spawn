/**
 * Which rows of the chat view get a link preview card (Phase 5, Task 5.10): the whole ChatView drawn with
 * react-dom/server over a fixed conversation, LinkCard stood in by a marker (the real one asks for its card
 * only once mounted, in an effect, so a server render could not see it). Only links of a finished assistant
 * text get one: never a user's message, a tool's command or output, a code block or inline code, an
 * interrupted (partial) answer or the live bubble; at most 3 per text; each after the block holding it; and
 * none at all unless the flag, 채팅으로 보기 and 링크 미리보기 are all on.
 */

import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { ChatItem } from '../src/chat/types'

const S = vi.hoisted(() => ({ chatView: true, linkPreviews: true }))

vi.mock('../src/i18n', async (orig) => ({
  ...(await orig<typeof import('../src/i18n')>()),
  t: (k: string, v?: Record<string, unknown>) => k.replace(/\{(\w+)\}/g, (_, n) => String(v?.[n] ?? '')),
}))
vi.mock('../src/settingsStore', async (orig) => {
  const real = await orig<typeof import('../src/settingsStore')>()
  return { ...real, useSettings: () => ({ ...real.DEFAULT_SETTINGS, session: { ...real.DEFAULT_SETTINGS.session, chatView: S.chatView, linkPreviews: S.linkPreviews } }) }
})
vi.mock('../src/components/chat/LinkCard', async () => {
  const R = await import('react')
  return { LinkCard: ({ url }: { url: string }) => R.createElement('i', { className: 'lc', 'data-url': url }) }
})

const { ChatView } = await import('../src/components/ChatView')

const NOW = Date.parse('2026-11-14T05:00:00Z')
let order = 0
const base = (id: string) => ({ id, order: ++order, at: NOW - 60_000 + order * 1000 })
const ITEMS: ChatItem[] = [
  { ...base('u1'), kind: 'user', text: 'Read https://user.example/a and tell me', images: 0 },
  { ...base('toolu_1'), kind: 'tool', tool: 'Bash', input: { command: 'curl https://cmd.example/x' }, state: 'done', output: { text: 'see https://output.example/y', lines: 1, truncated: false, error: false } },
  { ...base('a1'), kind: 'text', text: [
    'See [MDN](https://developer.mozilla.org/docs/Web/API/URL/URL) for the constructor.',
    '',
    '```',
    'https://code.example/block',
    '```',
    '',
    'Inline `https://inline.example/x` is code.',
    '',
    '- a https://list.example/1 item',
  ].join('\n') },
  { ...base('a2'), kind: 'text', text: 'Five: https://one.example/ https://two.example/ https://one.example/\n\nhttps://three.example/ https://four.example/ https://five.example/' },
  { ...base('a3'), kind: 'text', text: 'Stopped at https://partial.example/', partial: true },
  { id: 'live:msg_1', order: 2 ** 53 - 1, at: null, kind: 'live', text: 'Writing https://live.example/ now' },
]
const fixed = { rev: 1, items: ITEMS, status: { state: 'working', since: NOW - 5000, label: null, banner: null, note: null, version: '2.1.323', hasOlder: false, empty: false } } as any
const term = { id: 't1', sessionId: 's1', createdAt: 1, tool: 'claude', title: 'demo', cwd: 'C:\\Users\\user\\work\\demo', status: 'running', chat: 'armed' } as any
const who = { picture: 'glyph' as const, name: '에이전트' }

function draw(): string {
  return renderToStaticMarkup(React.createElement(ChatView, { term, who, project: 'demo', branch: null, onTerminal: () => {}, state: fixed, workMode: true }))
}
const cards = (html: string) => [...html.matchAll(/<i class="lc" data-url="([^"]+)"/g)].map(m => m[1])

describe('ChatView: link preview cards (react-dom/server over a fixed conversation)', () => {
  it('draws every row (the virtual list holds them all)', () => {
    const html = draw()
    for (const s of ['user.example', 'cmd.example', 'MDN</a>', 'one.example', 'partial.example', 'live.example']) expect(html, s).toContain(s)
  })

  it('cards only for links of a finished assistant text: not the user, a tool, code, a partial answer or the live bubble', () => {
    const got = cards(draw())
    expect(got).toEqual([
      'https://developer.mozilla.org/docs/Web/API/URL/URL', 'https://list.example/1',
      'https://one.example/', 'https://two.example/', 'https://three.example/',
    ])
    for (const never of ['user.example', 'cmd.example', 'output.example', 'code.example', 'inline.example', 'partial.example', 'live.example', 'four.example', 'five.example']) {
      expect(got.join(' '), never).not.toContain(never)
    }
  })

  it('at most 3 per text, each right after the block that holds it', () => {
    const html = draw()
    const at = (s: string) => html.indexOf(s)
    // the MDN card after its paragraph, before the code block
    expect(at('data-url="https://developer.mozilla.org')).toBeGreaterThan(at('for the constructor.</p>'))
    expect(at('data-url="https://developer.mozilla.org')).toBeLessThan(at('https://code.example/block'))
    // the list's card after the list
    expect(at('data-url="https://list.example/1"')).toBeGreaterThan(at('</ul>'))
    // two after the first paragraph of a2, the third after the second paragraph
    const p2 = at('https://four.example/')
    expect(at('data-url="https://two.example/"')).toBeLessThan(p2)
    expect(at('data-url="https://three.example/"')).toBeGreaterThan(p2)
  })

  it('none while 링크 미리보기 is off, or 채팅으로 보기 is off', () => {
    S.linkPreviews = false
    expect(cards(draw())).toEqual([])
    S.linkPreviews = true
    S.chatView = false
    expect(cards(draw())).toEqual([])
    S.chatView = true
    expect(cards(draw())).toHaveLength(5)
  })
})
