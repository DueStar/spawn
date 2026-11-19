/**
 * The turn summary: src/chat/rows.ts `foot` rows (a finished turn's time, its tool calls and
 * changed files only when the turn's start is loaded, the answer's text for its copy) and
 * src/components/chat/TurnFoot.tsx (time · 도구 n회 · 파일 n개 바꿈 · the step count when the ledger knows it and the
 * view is not in 업무 모드 · 복사). A turn with no turn_duration (running, interrupted) has no foot, and its text rows
 * keep their own copy (Decision 10).
 */

import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { FOOT_SLACK_MS, buildRows, footCopies, footCopy, type Row } from '../src/chat/rows'
import type { ChatItem, TextItem, ToolItem, TurnEndItem, UserItem } from '../src/chat/types'
import { linesOf } from './chat-helpers'
import { GAME_WORDS } from './helpers'
import chat from '../src/locales/chat'
import chatGame from '../src/locales/chatGame'
import DICTS from '../src/locales'

vi.mock('../src/i18n', async (orig) => ({
  ...(await orig<typeof import('../src/i18n')>()),
  t: (k: string, v?: Record<string, unknown>) => k.replace(/\{(\w+)\}/g, (_, n) => String(v?.[n] ?? '')),
}))

const require = createRequire(import.meta.url)
const { createItemBuilder } = require('../electron/chatItems.cjs')
const { quickSkip } = require('../electron/chatSchema.cjs')

const ROOT = join(__dirname, '..')
const CWD = 'C:\\Users\\user\\work\\demo'
const read = (...p: string[]) => readFileSync(join(ROOT, ...p), 'utf8')
const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/[^\n]*/g, '$1')
const dayLabel = (at: number) => new Date(at).toISOString().slice(0, 10)

function items(name: string): ChatItem[] {
  const b = createItemBuilder({ cwd: CWD })
  const byId = new Map<string, ChatItem>()
  for (const { text, offset } of linesOf(name)) {
    if (quickSkip(text)) continue
    let obj
    try { obj = JSON.parse(text) } catch { continue }
    for (const it of b.line(obj, offset)) byId.set(it.id, it)
  }
  return [...byId.values()].sort((a, b) => a.order - b.order || (a.id < b.id ? -1 : 1))
}
type Foot = Extract<Row, { row: 'foot' }>
const feet = (rows: Row[]) => rows.filter((r): r is Foot => r.row === 'foot')
const texts = (all: ChatItem[]) => all.filter((i): i is TextItem => i.kind === 'text' && !i.parent)

describe('feet over turns.jsonl', () => {
  const all = items('turns.jsonl')
  const rows = buildRows(all, { dayLabel, hasOlder: false })

  it('two feet, after each finished turn, with the right durations, tools and files', () => {
    const f = feet(rows)
    expect(f).toHaveLength(2)
    const ends = all.filter((i): i is TurnEndItem => i.kind === 'turn-end')
    expect(f.map(r => r.key)).toEqual(ends.map(e => `foot:${e.id}`))
    expect(f.map(r => r.item)).toEqual(ends)
    expect(f.map(r => r.item.durationMs)).toEqual([15100, 10100])
    expect(f.map(r => r.whole)).toEqual([true, true])
    // turn 1: Read, Edit, Bash over src/math.js; turn 2: Write docs/rivers.md, Edit src/math.js
    expect(f.map(r => r.tools)).toEqual([3, 2])
    expect(f.map(r => r.files)).toEqual([1, 2])
    const [t1, t2, t3] = texts(all)
    expect(f[0].texts).toEqual([t1])
    expect(f[1].texts).toEqual([t2])
    expect(t3.text).toMatch(/^1\. Rivers begin/)
  })

  it('the foot ends the turn: it follows the turn\'s last row, and the next prompt opens a new turn', () => {
    const shape = rows.map(r => r.row)
    const i = shape.indexOf('foot')
    expect(shape[i - 1]).toBe('text')
    expect(shape[i + 1]).toBe('user')
    expect(shape.slice(i + 1, i + 3)).toEqual(['user', 'turn-head'])
    expect(new Set(rows.map(r => r.key)).size).toBe(rows.length)
  })

  it('the interrupted turn has no foot, and its text row keeps its own copy', () => {
    const copies = footCopies(rows)
    const [t1, t2, t3] = texts(all)
    expect(copies.has(t1.id)).toBe(true)
    expect(copies.has(t2.id)).toBe(true)
    expect(copies.has(t3.id)).toBe(false)
    // after the last foot: the third turn's rows and its 요청을 멈췄어요, no foot
    const last = rows.map(r => r.row).lastIndexOf('foot')
    expect(rows.slice(last + 1).some(r => r.row === 'foot')).toBe(false)
    expect(rows.slice(last + 1).map(r => r.row)).toContain('notice')
  })

  it('the queued prompt taken mid-turn does not split the turn', () => {
    const queued = all.find((i): i is UserItem => i.kind === 'user' && i.text === 'Also, which river is the longest?')!
    expect(queued).toBeTruthy()
    const f = feet(rows)[1]
    // the Write before it and the Edit after it are both the turn's
    const tools = all.filter((i): i is ToolItem => i.kind === 'tool' && i.order > feet(rows)[0].item.order && i.order < f.item.order)
    expect(tools.map(t => t.tool)).toEqual(['Write', 'Edit'])
    expect(tools[0].order).toBeLessThan(queued.order)
    expect(tools[1].order).toBeGreaterThan(queued.order)
    expect(f.tools).toBe(2)
    expect(f.whole).toBe(true)
  })

  it('the copy is the turn\'s texts joined by a blank line, and says when one was cut', () => {
    const f = feet(rows)[1]
    expect(footCopy(f)).toEqual({ text: f.texts.map(t => t.text).join('\n\n'), cut: false })
    const two: Foot = { ...f, texts: [{ ...f.texts[0], text: 'a' }, { ...f.texts[0], id: 'x', text: 'b', truncated: true }] }
    expect(footCopy(two)).toEqual({ text: 'a\n\nb', cut: true })
  })
})

describe('a turn whose start is not loaded: no counts, no copy taken', () => {
  const all = items('turns.jsonl')

  it('a reset whose items begin mid-turn gives whole: false and null counts (the next turn is whole)', () => {
    const edit = all.findIndex(i => i.kind === 'tool' && i.tool === 'Edit')
    const rows = buildRows(all.slice(edit), { dayLabel, hasOlder: true })
    const f = feet(rows)
    expect(f).toHaveLength(2)
    expect(f[0]).toMatchObject({ whole: false, tools: null, files: null })
    expect(f[1]).toMatchObject({ whole: true, tools: 2, files: 2 })
    // the half-loaded turn's text keeps its own copy (the foot cannot copy the whole answer)
    const copies = footCopies(rows)
    const [t1, t2] = texts(all)
    expect(copies.has(t1.id)).toBe(false)
    expect(copies.has(t2.id)).toBe(true)
  })

  it('a reset that begins at a prompt is not taken for the turn\'s start while older items exist (it could be a queued one)', () => {
    const queued = all.findIndex(i => i.kind === 'user' && i.text === 'Also, which river is the longest?')
    const rows = buildRows(all.slice(queued), { dayLabel, hasOlder: true })
    expect(feet(rows)[0]).toMatchObject({ whole: false, tools: null, files: null })
    // with nothing older, the first item is the conversation's start
    const first = buildRows(all.slice(0), { dayLabel, hasOlder: false })
    expect(feet(first)[0].whole).toBe(true)
    // (no hasOlder given: as false)
    expect(feet(buildRows(all, { dayLabel }))[0].whole).toBe(true)
  })

  it('a turn that ended without turn_duration or an interrupt is not counted into the next one (its start time says so)', () => {
    const at = (s: number) => Date.UTC(2026, 10, 14, 3, 0, s)
    const tool = (id: string, s: number): ToolItem => ({ id, order: s * 10, at: at(s), kind: 'tool', tool: 'Bash', input: { command: 'x' }, state: 'done' })
    const list: ChatItem[] = [
      { id: 'u1', order: 0, at: at(0), kind: 'user', text: 'one', images: 0 },
      tool('a', 2),
      { id: 'u2', order: 300, at: at(30), kind: 'user', text: 'two', images: 0 },
      tool('b', 32),
      { id: 'x2', order: 330, at: at(33), kind: 'text', text: 'done' },
      { id: 'e2', order: 340, at: at(34), kind: 'turn-end', durationMs: 4000 },
    ]
    expect(feet(buildRows(list, { dayLabel, hasOlder: false }))[0]).toMatchObject({ whole: false, tools: null, files: null })
    // the same turn alone, within the slack of its start: whole
    const alone = list.slice(2)
    expect(feet(buildRows(alone, { dayLabel, hasOlder: false }))[0]).toMatchObject({ whole: true, tools: 1, files: 0 })
    expect(FOOT_SLACK_MS).toBeGreaterThan(0)
    expect(FOOT_SLACK_MS).toBeLessThanOrEqual(5000)
  })

  it('a turn_duration right after an interrupt (no new prompt between) has a foot with its time only', () => {
    const list: ChatItem[] = [
      { id: 'u1', order: 0, at: 1000, kind: 'user', text: 'one', images: 0 },
      { id: 'a', order: 10, at: 2000, kind: 'tool', tool: 'Bash', input: {}, state: 'done' },
      { id: 'n', order: 20, at: 3000, kind: 'notice', notice: 'interrupted' },
      { id: 'e', order: 30, at: 3100, kind: 'turn-end', durationMs: 2100 },
    ]
    expect(feet(buildRows(list, { dayLabel, hasOlder: false }))[0]).toMatchObject({ whole: false, tools: null, files: null })
  })

  it('a sub-agent\'s calls are not the turn\'s own', () => {
    const list: ChatItem[] = [
      { id: 'u1', order: 0, at: 1000, kind: 'user', text: 'one', images: 0 },
      { id: 'ag', order: 10, at: 1100, kind: 'tool', tool: 'Agent', input: {}, state: 'done' },
      { id: 'c1', order: 1, at: 1200, kind: 'tool', tool: 'Edit', input: {}, state: 'done', parent: 'ag', diff: { file: 'a.js', kind: 'edit', added: 1, removed: 0, hunks: [], hidden: 0 } },
      { id: 'e', order: 30, at: 3000, kind: 'turn-end', durationMs: 2000 },
    ]
    expect(feet(buildRows(list, { dayLabel, hasOlder: false }))[0]).toMatchObject({ whole: true, tools: 1, files: 0 })
  })
})

describe('the existing rows around feet', () => {
  it('feet in every density, and nothing else changes in 기본 (the pre-density rows with the feet taken out)', () => {
    const all = items('turns.jsonl')
    for (const density of ['default', 'thinking', 'all'] as const) expect(feet(buildRows(all, { dayLabel, density }))).toHaveLength(2)
  })

  it('a foot is not a new message (unreadAfter counts none)', async () => {
    const { unreadAfter } = await import('../src/chat/rows')
    const all = items('turns.jsonl')
    const end = all.findIndex(i => i.kind === 'turn-end')
    const before = buildRows(all.slice(0, end), { dayLabel })
    const after = buildRows(all.slice(0, end + 1), { dayLabel })
    expect(unreadAfter(before, after)).toBe(0)
  })

  it('sameRow knows a foot: the item, its counts, whole and its texts', async () => {
    const { sameRow } = await import('../src/components/ChatView')
    const f = feet(buildRows(items('turns.jsonl'), { dayLabel }))[0]
    expect(sameRow(f, { ...f })).toBe(true)
    expect(sameRow(f, { ...f, whole: false })).toBe(false)
    expect(sameRow(f, { ...f, tools: 9 })).toBe(false)
    expect(sameRow(f, { ...f, files: 9 })).toBe(false)
    expect(sameRow(f, { ...f, texts: [] })).toBe(false)
    expect(sameRow(f, { ...f, texts: [...f.texts] })).toBe(true)
  })
})

// ---------------------------------------------------------------- the foot drawn

describe('TurnFoot', () => {
  const all = items('turns.jsonl')
  const [f1, f2] = feet(buildRows(all, { dayLabel }))

  async function render(row: Foot, ctx: Record<string, unknown> = {}) {
    const { TurnFoot } = await import('../src/components/chat/TurnFoot')
    const { ChatContext } = await import('../src/components/chat/context')
    const value = { id: 't1', onTerminal() {}, onLink() {}, onPath() {}, loadAgent: () => Promise.resolve({ ok: true }), waitingAgents: [], ...ctx }
    return renderToStaticMarkup(React.createElement(ChatContext.Provider, { value: value as never }, React.createElement(TurnFoot, { row, name: '모래두지' })))
  }

  it('time · 도구 n회 · 파일 n개 바꿈 · 복사 (no steps without the ledger)', async () => {
    const html = await render(f1)
    expect(html).toMatch(/^<div class="chat-foot"/)
    expect(html).toContain('15초')
    expect(html).toContain('도구 3회')
    expect(html).toContain('파일 1개 바꿈')
    expect(html).toContain('aria-label="답 복사"')
    expect(html).not.toContain('chat-steps')
    expect(html).not.toContain('걸음')
  })

  it('no 파일 when the turn changed none; no counts and no copy when the turn is not whole', async () => {
    const none = await render({ ...f1, files: 0 })
    expect(none).toContain('도구 3회')
    expect(none).not.toContain('바꿈')
    const half = await render({ ...f1, whole: false, tools: null, files: null })
    expect(half).toContain('15초')
    expect(half).not.toContain('도구')
    expect(half).not.toContain('바꿈')
    expect(half).not.toContain('chat-copy')
    // a turn with nothing to copy: no button
    expect(await render({ ...f1, texts: [] })).not.toContain('chat-copy')
  })

  it('the step count with the paw glyph and its title when the ledger knows it; none in 업무 모드', async () => {
    const stepsFor = (id: string) => (id === f2.item.id ? 8 : null)
    const html = await render(f2, { stepsFor, stepsSubscribe: () => () => {} })
    expect(html).toContain('class="chat-steps"')
    expect(html).toContain('8걸음')
    expect(html).toContain('title="이 턴 동안 모래두지가 걸은 걸음"')
    expect(html).toMatch(/class="chat-steps"[^>]*><svg/)
    expect(await render(f1, { stepsFor, stepsSubscribe: () => () => {} })).not.toContain('걸음')
    const work = await render(f2, { stepsFor, stepsSubscribe: () => () => {}, workMode: true })
    expect(work).not.toContain('걸음')
    expect(work).not.toContain('chat-steps')
    expect(work).not.toContain('모래두지')
  })
})

describe('the view: the per-row copy moves into the foot', () => {
  const src = code(read('src', 'components', 'ChatView.tsx'))

  it('text rows a whole foot covers lose their own copy; the others keep it', () => {
    expect(src).toMatch(/footCopies\(rows\)/)
    expect(src).toMatch(/case 'foot': return <TurnFoot row=\{row\} name=\{who\.name\} \/>/)
    expect(src).toMatch(/<TextRow item=\{row\.item\} copy=\{!noCopy\} \/>/)
    // the copy button itself is unchanged
    expect(src).toMatch(/\{copy && <div className="chat-text-acts"><CopyButton text=\{item\.text\} label=\{t\('답 복사'\)\} cut=\{item\.truncated === true\} \/><\/div>\}/)
  })

  it('the rows are built knowing whether older items exist', () => {
    expect(src).toMatch(/buildRows\(items, \{ dayLabel, density, hasOlder, extra: wild \}\)/)
  })
})

describe('the words and the look', () => {
  it('the foot\'s words in chat.ts (ko / en / ja, no game word); the steps\' in chatGame.ts', () => {
    for (const k of ['도구 {n}회', '파일 {n}개 바꿈']) {
      expect(chat.en[k], k).toBeTruthy()
      expect(chat.ja[k], k).toBeTruthy()
      for (const s of [k, chat.en[k], chat.ja[k]]) expect(GAME_WORDS.test(s), s).toBe(false)
    }
    expect(chat.en['도구 {n}회']).toBe('{n} tool {n|call|calls}')
    expect(chat.ja['파일 {n}개 바꿈']).toBe('ファイル{n}個を変更')
    expect(chatGame.en['{n}걸음']).toBe('{n} steps')
    expect(chatGame.ja['{n}걸음']).toBe('{n}歩')
    // (the foot's own sense with the plural forms; 도감 and 박스 keep release 1.4.0's '{n} steps')
    expect(chatGame.en['{n}걸음#chat']).toBe('{n} {n|step|steps}')
    expect(chatGame.ja['{n}걸음#chat']).toBe('{n}歩')
    expect(chatGame.en['이 턴 동안 {name}{iga} 걸은 걸음']).toBe('Steps {name} took this turn')
    expect(chatGame.ja['이 턴 동안 {name}{iga} 걸은 걸음']).toBe('このターンに{name}が歩いた歩数')
    for (const k of Object.keys(chatGame.en)) {
      expect(chat.en[k], `${k} is a game word: chatGame.ts only`).toBeUndefined()
      expect(DICTS.en[k]).toBe(chatGame.en[k])
      expect(DICTS.ja[k]).toBe(chatGame.ja[k])
    }
    expect(Object.keys(chatGame.ja).sort()).toEqual(Object.keys(chatGame.en).sort())
  })

  it('the foot in chat.css (.turn-foot, no animation); the step count in chat-game.css', () => {
    const css = read('src', 'styles', 'chat.css').replace(/\/\*[\s\S]*?\*\//g, '')
    expect(css).toMatch(/\.chat-foot \{[^}]*display: flex;[^}]*flex-wrap: wrap;[^}]*gap: 4px 12px;[^}]*font-size: var\(--t-meta\);[^}]*color: var\(--ink-3\);/)
    expect(css).toMatch(/\.chat-foot \.chat-copy \{[^}]*margin-left: auto;/)
    expect(css).not.toMatch(/animation|@keyframes/)
    expect(css).not.toMatch(/chat-steps/)
    const game = read('src', 'styles', 'chat-game.css').replace(/\/\*[\s\S]*?\*\//g, '')
    expect(game).toMatch(/\.chat-steps \{[^}]*display: inline-flex;[^}]*gap: 4px;/)
    for (const m of game.matchAll(/font-size\s*:\s*([^;]+)/g)) expect(m[1].trim()).toMatch(/^var\(--t-(micro|meta|ui|prose|code)\)$/)
    expect(game).not.toMatch(/--accent/)
    expect(read('src', 'components', 'ChatView.tsx')).toMatch(/import '\.\.\/styles\/chat-game\.css'/)
  })
})
