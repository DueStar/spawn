/**
 * Find in the conversation: src/chat/find.ts searches plain text taken from the store's items
 * (markdown removed), only what is loaded; each match names the row it is drawn in (a group's member → the group, a
 * sub-agent's row → its Agent row) and openFor lists what must open for it to show. The keys come through appShortcut
 * in ChatView; src/keys.ts is not edited. setRowOpen opens a row from outside it (context.ts).
 */

import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { buildRows } from '../src/chat/rows'
import type { ChatItem, DiffLine, NoticeItem, TextItem, ThinkingItem, ToolItem, UserItem } from '../src/chat/types'
import { DIFF_PREVIEW_LINES, FIND_LIMIT, findMatches, findOwner, fold, markdownText, openFor, plainOf } from '../src/chat/find'
import { ChatContext, setRowOpen, useRowOpen } from '../src/components/chat/context'
import { GAME_WORDS } from './helpers'
import chat from '../src/locales/chat'

vi.mock('../src/i18n', async (orig) => ({
  ...(await orig<typeof import('../src/i18n')>()),
  t: (k: string, v?: Record<string, unknown>) => k.replace(/\{(\w+)\}/g, (_, n) => String(v?.[n] ?? '')),
}))

const ROOT = join(__dirname, '..')
const read = (...p: string[]) => readFileSync(join(ROOT, ...p), 'utf8')
const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/[^\n]*/g, '$1')
const dayLabel = (at: number) => new Date(at).toISOString().slice(0, 10)

let n = 0
const T0 = Date.UTC(2026, 10, 14, 3, 0, 0)
const base = () => { n++; return { id: `i${n}`, order: n * 100, at: T0 + n * 1000 } }
const user = (text: string): UserItem => ({ ...base(), kind: 'user', text, images: 0 })
const text = (s: string, over: Partial<TextItem> = {}): TextItem => ({ ...base(), kind: 'text', text: s, ...over })
const tool = (name: string, input: ToolItem['input'], over: Partial<ToolItem> = {}): ToolItem => ({ ...base(), kind: 'tool', tool: name, input, state: 'done', ...over })
const thinking = (s: string): ThinkingItem => ({ ...base(), kind: 'thinking', text: s, durationMs: 3000 })
const notice = (kind: NoticeItem['notice'], s?: string): NoticeItem => ({ ...base(), kind: 'notice', notice: kind, ...(s ? { text: s } : {}) })
const rowsOf = (items: ChatItem[], density: 'default' | 'thinking' | 'all' = 'default') => buildRows(items, { dayLabel, density })
const find = (items: ChatItem[], q: string, density: 'default' | 'thinking' | 'all' = 'default', limit?: number) =>
  findMatches(items, rowsOf(items, density), q, density, limit)

describe('fold: NFC and toLocaleLowerCase, the offsets kept', () => {
  it('a decomposed é and Hangul jamo match their composed forms, mapped back to the raw text', () => {
    const raw = 'Café 각 X'      // Café (e + ◌́) · 각 as jamo · X
    const f = fold(raw)
    expect(f.text).toBe('café 각 x')
    const at = f.text.indexOf('각')
    expect(raw.slice(f.map ? f.map[at] : at, f.map ? f.map[at + 1] : at + 1)).toBe('각')
    const e = f.text.indexOf('é')
    expect(raw.slice(f.map![e], f.map![e + 1])).toBe('é')
  })
  it('plain text folds with no map (the fast path)', () => {
    expect(fold('Hello URL').text).toBe('hello url')
    expect(fold('Hello URL').map).toBeNull()
    expect(fold('남한강').map).toBeNull()
  })
})

describe('findMatches over the store', () => {
  it('a Korean query over a Korean answer, every place, in order', () => {
    const items = [user('강 이름을 알려 주세요'), text('## 세 강\n\n1. **한강**은 서울을 지나요.\n2. 낙동강은 남쪽으로 흘러요.')]
    const r = find(items, '강')
    expect(r.more).toBe(false)
    expect(r.matches.map(m => m.itemId)).toEqual([items[0].id, items[1].id, items[1].id, items[1].id])
    const t = markdownText(items[1].kind === 'text' ? items[1].text : '')
    for (const m of r.matches.slice(1)) expect(t.slice(m.start, m.end)).toBe('강')
  })

  it('Latin is matched without case; NFC on both sides', () => {
    const items = [text('Use the `URL` constructor, not url.parse; see Café docs.')]
    expect(find(items, 'url').matches).toHaveLength(2)
    expect(find(items, 'URL').matches).toHaveLength(2)
    expect(find(items, 'café').matches).toHaveLength(1)
    expect(find(items, 'CAFÉ'.normalize('NFD')).matches).toHaveLength(1)
  })

  it('markdown: **bold** matches bold, never the stars; link text and code are text, the address of a link is not', () => {
    const items = [text('This is **bold** and `code()` and [the docs](https://example.com/zzz).')]
    expect(find(items, 'bold').matches).toHaveLength(1)
    expect(find(items, '**').matches).toHaveLength(0)
    expect(find(items, 'is bold and').matches).toHaveLength(1)
    expect(find(items, 'code()').matches).toHaveLength(1)
    expect(find(items, 'the docs').matches).toHaveLength(1)
    expect(find(items, 'zzz').matches).toHaveLength(0)
    expect(markdownText('```ts\nconst a = 1\n```\n\n| a | b |\n|---|---|\n| x | y |')).toContain('const a = 1')
  })

  it('a hit in a group\'s Grep pattern maps to the group\'s row; openFor names the group and the tool', () => {
    const a = tool('Read', { file: 'src/middleware.ts' }, { output: { text: 'x', lines: 58, truncated: false, error: false } })
    const g = tool('Grep', { pattern: 'next=', path: 'src' }, { output: { text: 'Found 7 files', lines: 1, truncated: false, error: false } })
    const items = [user('찾아 주세요'), a, g, text('끝')]
    const rows = rowsOf(items)
    const group = rows.find(r => r.row === 'group')!
    expect(group.key).toBe(a.id)
    const r = findMatches(items, rows, 'next=', 'default')
    expect(r.matches).toHaveLength(1)
    expect(r.matches[0]).toMatchObject({ itemId: g.id, rowKey: group.key, field: 'pattern' })
    expect(openFor(r.matches[0])).toEqual([`group:${group.key}`, g.id])
    // a grouped call's output is not drawn in the group: not found there
    expect(findMatches(items, rows, 'Found 7', 'default').matches).toHaveLength(0)
  })

  it('a hit in a tool\'s output past 8 lines opens the row; a hit in its detail opens nothing', () => {
    const out = Array.from({ length: 12 }, (_, i) => `line ${i + 1}`).join('\n') + '\nneedle here'
    const b = tool('Bash', { command: 'npm test', description: 'run the tests' }, { output: { text: out, lines: 13, truncated: false, error: false } })
    const items = [user('테스트'), b]
    const hit = find(items, 'needle')
    expect(hit.matches).toHaveLength(1)
    expect(hit.matches[0]).toMatchObject({ itemId: b.id, rowKey: b.id, field: 'output' })
    expect(openFor(hit.matches[0])).toEqual([b.id])
    const detail = find(items, 'the tests')
    expect(detail.matches[0]).toMatchObject({ field: 'description' })
    expect(openFor(detail.matches[0])).toEqual([])
  })

  it('a hit in a diff\'s 20th line opens :diff; one in the first 8 lines opens nothing', () => {
    const lines: DiffLine[] = Array.from({ length: 24 }, (_, i) => ({ t: '+', old: null, new: i + 1, text: i === 19 ? 'const twentieth = 20' : i === 2 ? 'const third = 3' : `x${i}` }))
    const e = tool('Edit', { file: 'src/a.ts' }, { diff: { file: 'src/a.ts', kind: 'edit', added: 24, removed: 0, hidden: 0, hunks: [{ oldStart: 1, newStart: 1, lines }] }, output: { text: 'The file has been updated', lines: 1, truncated: false, error: false } })
    const items = [user('고쳐요'), e]
    const deep = find(items, 'twentieth')
    expect(deep.matches).toHaveLength(1)
    expect(deep.matches[0].field).toBe('diff:19')
    expect(openFor(deep.matches[0])).toEqual([`${e.id}:diff`])
    expect(openFor(find(items, 'third').matches[0])).toEqual([])
    // a drawn diff shows no output: the tool's output text is not searched
    expect(find(items, 'has been updated').matches).toHaveLength(0)
    // a gap between hunks counts as a line of the preview (as DiffBlock draws it)
    const two = tool('Edit', { file: 'b.ts' }, { diff: { file: 'b.ts', kind: 'edit', added: 9, removed: 0, hidden: 0, hunks: [
      { oldStart: 1, newStart: 1, lines: lines.slice(0, 7) },
      { oldStart: 40, newStart: 40, lines: [{ t: '+', old: null, new: 40, text: 'second hunk' }] },
    ] } })
    const m = find([two], 'second hunk').matches[0]
    expect(m.field).toBe('diff:8')
    expect(openFor(m)).toEqual([`${two.id}:diff`])
  })

  it('a sub-agent\'s row maps to its Agent row, which opens (and the child\'s own fold)', () => {
    const agent = tool('Agent', { description: 'look around' }, { agentId: 'a1' })
    const child = { ...tool('Bash', { command: 'ls' }, { output: { text: 'secret-file.txt', lines: 1, truncated: false, error: false } }), parent: agent.id }
    const sub = { ...text('the sub-agent found a lighthouse'), parent: agent.id }
    const items = [user('go'), agent, child, sub]
    const r = find(items, 'secret-file')
    expect(r.matches[0]).toMatchObject({ itemId: child.id, rowKey: agent.id })
    expect(openFor(r.matches[0])).toEqual([agent.id, child.id])
    const s = find(items, 'lighthouse').matches[0]
    expect(s).toMatchObject({ itemId: sub.id, rowKey: agent.id })
    expect(openFor(s)).toEqual([agent.id])
    expect(find(items, 'look around').matches[0]).toMatchObject({ itemId: agent.id, rowKey: agent.id, field: 'description' })
  })

  it('thinking text only in 생각 포함 and 전부', () => {
    const items = [user('q'), thinking('pondering the lighthouse'), text('answer')]
    expect(find(items, 'lighthouse', 'default').matches).toHaveLength(0)
    expect(find(items, 'lighthouse', 'thinking').matches).toHaveLength(1)
    expect(find(items, 'lighthouse', 'all').matches).toHaveLength(1)
    expect(plainOf(items[1], 'default')).toEqual([])
  })

  it('notices by their words; turn ends, wild rows, day lines and live bubbles hold nothing to find', () => {
    const items: ChatItem[] = [user('q'), notice('command', '/compact'), text('a'), { ...base(), kind: 'turn-end', durationMs: 5000 }, { ...base(), kind: 'live', text: 'streaming lighthouse' }]
    expect(find(items, '/compact').matches).toHaveLength(1)
    expect(find(items, 'lighthouse').matches).toHaveLength(0)
    expect(find(items, '2026').matches).toHaveLength(0)
  })

  it('at the limit it stops and says there are more', () => {
    const items = [text(Array.from({ length: 1200 }, () => 'ab').join(' '))]
    const r = find(items, 'ab')
    expect(FIND_LIMIT).toBe(1000)
    expect(r.matches).toHaveLength(1000)
    expect(r.more).toBe(true)
    expect(find(items, 'ab', 'default', 10).matches).toHaveLength(10)
    expect(find(items, '').matches).toHaveLength(0)
    expect(find(items, '   ').matches).toHaveLength(0)
  })

  it('the open keys are the rows\' own: DiffBlock\'s preview and ToolGroup\'s key', async () => {
    const { DIFF_PREVIEW } = await import('../src/components/chat/DiffBlock')
    const { groupOpenKey } = await import('../src/components/chat/ToolGroup')
    expect(DIFF_PREVIEW_LINES).toBe(DIFF_PREVIEW)
    expect(groupOpenKey('k1')).toBe('group:k1')
  })

  it('plainOf is cached by the item\'s identity', () => {
    const it = text('**once**')
    expect(plainOf(it, 'default')).toBe(plainOf(it, 'default'))
    expect(plainOf({ ...it }, 'default')).not.toBe(plainOf(it, 'default'))
  })
})

describe('setRowOpen: a row opened from outside it', () => {
  it('the row reads it on its next render; per terminal', () => {
    const Probe: React.FC<{ k: string }> = ({ k }) => { const [open] = useRowOpen(k, false); return React.createElement('i', null, open ? 'open' : 'closed') }
    const html = (id: string) => renderToStaticMarkup(React.createElement(ChatContext.Provider,
      { value: { id, onTerminal: () => {}, onLink: () => {}, onPath: () => {}, loadAgent: () => Promise.resolve({ ok: true }), waitingAgents: [] } },
      React.createElement(Probe, { k: 'group:x' })))
    expect(html('t-find')).toBe('<i>closed</i>')
    setRowOpen('t-find', 'group:x', true)
    expect(html('t-find')).toBe('<i>open</i>')
    expect(html('t-other')).toBe('<i>closed</i>')
  })
})

describe('findOwner: in the split view only the pane that is on answers Ctrl/⌘+F', () => {
  const pane = (...cls: string[]) => ({ classList: { contains: (c: string) => cls.includes(c) } })
  it('a pane of the split view: only the one on; one chat alone or no pane: always', () => {
    expect(findOwner(pane('w-chat-pane', 'split', 'on'))).toBe(true)
    expect(findOwner(pane('w-chat-pane', 'split'))).toBe(false)
    expect(findOwner(pane('w-chat-pane'))).toBe(true)
    expect(findOwner(null)).toBe(true)
  })
  it('ChatView asks it before opening the bar (2026-11-27: every pane opened its bar, the first took the focus)', () => {
    const src = code(read('src', 'components', 'ChatView.tsx'))
    expect(src).toMatch(/findOwner\(rootRef\.current\?\.closest\('\.w-chat-pane'\) \?\? null\)/)
  })
  it('the bar floats over the conversation: a shadow and a firmer border', () => {
    const css = read('src', 'styles', 'chat.css').replace(/\/\*[\s\S]*?\*\//g, '')
    const rule = /\.chat-find \{([^}]*)\}/.exec(css)![1]
    expect(rule).toMatch(/box-shadow:/)
    expect(rule).toMatch(/border: 1px solid var\(--line-hover\)/)
  })
})

describe('the keys and the source', () => {
  it('ChatView reads Ctrl/⌘+F through appShortcut in a bubble-phase window listener, never inside a terminal or mid-composition', () => {
    const src = code(read('src', 'components', 'ChatView.tsx'))
    expect(src).toMatch(/import \{ appShortcut \} from '\.\.\/keys'/)
    expect(src).toMatch(/appShortcut\(e\) !== 'find'/)
    expect(src).toMatch(/isComposing/)
    expect(src).toMatch(/closest\?\.\('\.term-view'\)/)
    expect(src).toMatch(/window\.addEventListener\('keydown', onFindKey\)/)
    expect(src).not.toMatch(/window\.addEventListener\('keydown', onFindKey, true\)/)
    // the find state per terminal, in memory, let go with the session
    expect(code(read('src', 'components', 'chat', 'FindBar.tsx'))).toMatch(/onChatForget\(id => memory\.delete\(id\)\)/)
  })
  it('src/keys.ts is as release 1.4.0 has it (cff52ac), and Widget\'s capture handler lets find through', () => {
    const s = read('src', 'keys.ts').replace(/\r\n/g, '\n')
    expect(createHash('sha256').update(s).digest('hex')).toBe('6860c1e0393e3bf798ec6377f18369de23d3a57440aadb7cc678b5483bcd94a2')
    const w = code(read('src', 'Widget.tsx'))
    expect(w).not.toMatch(/action === 'find'/)
  })
  it('ChatList places a row by its centre and says when it is placed', () => {
    const src = code(read('src', 'components', 'chat', 'ChatList.tsx'))
    expect(src).toMatch(/scrollToKey\(key: string, opts\?: \{ align\?: 'center' \}\): Promise<boolean>/)
  })
  it('painted with the Custom Highlight API in greys (no yellow), an outline without it', () => {
    const css = read('src', 'styles', 'chat.css').replace(/\/\*[\s\S]*?\*\//g, '')
    expect(css).toMatch(/::highlight\(chat-find\)\s*\{[^}]*background-color:\s*var\(--find-bg\)/)
    expect(css).toMatch(/::highlight\(chat-find-now\)\s*\{[^}]*background-color:\s*var\(--find-now-bg\);[^}]*color:\s*var\(--ink\)/)
    for (const m of css.matchAll(/([^{}]*(?:chat-find|find-now)[^{}]*)\{([^}]*)\}/g)) expect(m[2], m[1]).not.toMatch(/--accent|#f2c94c|yellow/i)
    const bar = code(read('src', 'components', 'chat', 'FindBar.tsx'))
    // (CSS.highlights, read through globalThis so a page without it outlines instead)
    expect(bar).toMatch(/CSS\?: \{ highlights\?/)
    expect(bar).toMatch(/reg\.set\('chat-find', /)
    expect(bar).toMatch(/reg\.set\('chat-find-now', /)
    expect(bar).toMatch(/role="search"/)
    expect(bar).toMatch(/aria-live="polite"/)
    expect(bar).toMatch(/isComposing/)
    expect(bar).toMatch(/modCombo\('F'\)/)
  })
})

describe('strings', () => {
  const KEYS = ['대화에서 찾기', '찾을 말', '결과 없음', '{n}개 넘음', '이전 결과', '다음 결과', '찾기 닫기', '불러온 대화에서만 찾아요']
  it('every new key in en and ja, in chat.ts, none of the game\'s words', () => {
    for (const k of KEYS) {
      expect(chat.en[k], `en: ${k}`).toBeTruthy()
      expect(chat.ja[k], `ja: ${k}`).toBeTruthy()
      for (const s of [k, chat.en[k], chat.ja[k]]) expect(GAME_WORDS.test(s ?? ''), s).toBe(false)
    }
    expect(chat.en['찾을 말']).toBe('Find')
    expect(chat.ja['{n}개 넘음']).toBe('{n}件以上')
    expect(chat.en['불러온 대화에서만 찾아요']).toBe('Searching only what is loaded')
  })
})
