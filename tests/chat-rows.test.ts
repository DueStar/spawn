/**
 * src/chat/rows.ts — the conversation's items become display rows: day lines,
 * one turn head per turn, finished reads and searches folded into one group,
 * sub-agent items under their Agent row, and the rows that must never fold
 * (a permission wait, a failure, a running call, a question, a plan).
 */

import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'
import { buildRows, unreadAfter, type Row } from '../src/chat/rows'
import type { ChatItem, ToolItem } from '../src/chat/types'
import { linesOf } from './chat-helpers'

const require = createRequire(import.meta.url)
const { createItemBuilder } = require('../electron/chatItems.cjs')
const { quickSkip } = require('../electron/chatSchema.cjs')

const CWD = 'C:\\Users\\user\\work\\demo'

/** A fixture through the real builder, sorted as the store keeps it */
function items(name: string, opts: Record<string, unknown> = { cwd: CWD }): ChatItem[] {
  const b = createItemBuilder(opts)
  const byId = new Map<string, ChatItem>()
  for (const { text, offset } of linesOf(name)) {
    if (quickSkip(text)) continue
    let obj
    try { obj = JSON.parse(text) } catch { continue }
    for (const it of b.line(obj, offset)) byId.set(it.id, it)
  }
  return [...byId.values()].sort((a, b) => a.order - b.order || (a.id < b.id ? -1 : 1))
}

const dayLabel = (at: number) => new Date(at).toISOString().slice(0, 10)
const shape = (rows: Row[]) => rows.map(r => r.row)

describe('buildRows over tools.jsonl', () => {
  const rows = buildRows(items('tools.jsonl'), { dayLabel })

  it('a day line, the prompt, one turn head, then the turn', () => {
    expect(shape(rows)).toEqual(['day', 'user', 'turn-head', 'group', 'tool', 'tool', 'tool', 'tool', 'tool', 'text', 'foot'])
  })

  it('Read + Grep + Glob, all done in a row, are one group: 1 file, 2 searches', () => {
    const g = rows.find(r => r.row === 'group') as Extract<Row, { row: 'group' }>
    expect(g.items.map(i => i.tool)).toEqual(['Read', 'Grep', 'Glob'])
    expect(g.files).toBe(1)
    expect(g.searches).toBe(2)
  })

  it('the failed Bash is a row of its own, not folded', () => {
    const failed = rows.filter(r => r.row === 'tool' && r.item.state === 'failed') as Extract<Row, { row: 'tool' }>[]
    expect(failed.map(r => r.item.id)).toEqual(['toolu_fixture05', 'toolu_fixture06'])
  })

  it('the turn head carries the time of the turn\'s first item', () => {
    const head = rows.find(r => r.row === 'turn-head') as Extract<Row, { row: 'turn-head' }>
    expect(head.at).toBe(items('tools.jsonl')[1].at)
  })

  it('every key is unique', () => {
    expect(new Set(rows.map(r => r.key)).size).toBe(rows.length)
  })

  it('a turn end makes only the turn\'s foot (tests/chat-foot.test.ts)', () => {
    expect(rows.filter(r => (r as any).item?.kind === 'turn-end').map(r => r.row)).toEqual(['foot'])
  })
})

describe('the rows that never fold (anti-goal: a permission request hidden in a collapsed group)', () => {
  const read = (id: string, order: number, extra: Partial<ToolItem> = {}): ToolItem => ({ id, order, at: null, kind: 'tool', tool: 'Read', input: { file: `${id}.ts` }, state: 'done', ...extra })

  it('a Read waiting for permission is never in a group, and it breaks the run', () => {
    const rows = buildRows([read('a', 1), read('b', 2), read('w', 3, { waiting: 'permission', state: 'running' }), read('c', 4), read('d', 5)], { dayLabel })
    expect(shape(rows)).toEqual(['turn-head', 'group', 'tool', 'group'])
    expect((rows[2] as any).item.waiting).toBe('permission')
  })

  it('a waiting row is never folded even when its state says done', () => {
    const rows = buildRows([read('a', 1), read('w', 2, { waiting: 'permission' }), read('b', 3)], { dayLabel })
    expect(shape(rows)).toEqual(['turn-head', 'tool', 'tool', 'tool'])
  })

  it('running and failed reads stay rows; a single finished read stays a row', () => {
    const rows = buildRows([read('a', 1), read('r', 2, { state: 'running' }), read('b', 3), read('f', 4, { state: 'failed' })], { dayLabel })
    expect(shape(rows)).toEqual(['turn-head', 'tool', 'tool', 'tool', 'tool'])
  })

  it('a question and a plan are never folded', () => {
    const ask: ToolItem = { id: 'q', order: 3, at: null, kind: 'tool', tool: 'AskUserQuestion', input: { question: '?' }, state: 'done' }
    const plan: ToolItem = { id: 'p', order: 6, at: null, kind: 'tool', tool: 'ExitPlanMode', input: { plan: 'x' }, state: 'done' }
    const rows = buildRows([read('a', 1), read('b', 2), ask, read('c', 4), read('d', 5), plan], { dayLabel })
    expect(shape(rows)).toEqual(['turn-head', 'group', 'tool', 'group', 'tool'])
  })

  it('a group needs reads or searches only: anything else in between breaks it', () => {
    const bash: ToolItem = { id: 'x', order: 2, at: null, kind: 'tool', tool: 'Bash', input: {}, state: 'done' }
    const rows = buildRows([read('a', 1), bash, read('b', 3)], { dayLabel })
    expect(shape(rows)).toEqual(['turn-head', 'tool', 'tool', 'tool'])
  })

  it('reads in two turns are two groups, not one', () => {
    const u: ChatItem = { id: 'u', order: 3, at: null, kind: 'user', text: 'next', images: 0 }
    const rows = buildRows([read('a', 1), read('b', 2), u, read('c', 4), read('d', 5)], { dayLabel })
    expect(shape(rows)).toEqual(['turn-head', 'group', 'user', 'turn-head', 'group'])
  })
})

describe('sub-agents and turns', () => {
  it('the sub-agent\'s items nest under their Agent row and make no rows of their own', () => {
    const main = items('agent.jsonl')
    const sub = items('agent/subagents/agent-afixture01.jsonl', { cwd: CWD, parent: 'toolu_fixture41' })
    expect(sub.length).toBeGreaterThan(0)
    const rows = buildRows([...main, ...sub].sort((a, b) => a.order - b.order), { dayLabel })
    const agent = rows.find(r => r.row === 'tool' && r.item.id === 'toolu_fixture41') as Extract<Row, { row: 'tool' }>
    expect(agent.children.map(c => c.id).sort()).toEqual(sub.map(i => i.id).sort())
    for (const s of sub) expect(rows.some(r => (r as any).item?.id === s.id)).toBe(false)
  })

  it('one turn head per turn: after the prompt, and again after the sub-agent\'s notice', () => {
    const rows = buildRows(items('agent.jsonl'), { dayLabel })
    expect(shape(rows)).toEqual(['day', 'user', 'turn-head', 'tool', 'text', 'foot', 'notice', 'turn-head', 'text', 'foot'])
  })

  it('a list that starts mid-turn starts with a turn head', () => {
    const all = items('tools.jsonl')
    const rows = buildRows(all.slice(3), { dayLabel })
    expect(rows[0].row).toBe('day')
    expect(rows[1].row).toBe('turn-head')
  })

  it('the provisional bubble is a live row', () => {
    const rows = buildRows([{ id: 'u', order: 1, at: null, kind: 'user', text: 'hi', images: 0 }, { id: 'live:m', order: Number.MAX_SAFE_INTEGER, at: null, kind: 'live', text: 'Hel' }], { dayLabel })
    expect(shape(rows)).toEqual(['user', 'turn-head', 'live'])
  })

  it('a kind the page does not know is said as content it cannot show, never silently nothing (review M4)', () => {
    const rows = buildRows([{ id: 'z', order: 1, at: null, kind: 'hologram' } as unknown as ChatItem], { dayLabel })
    expect(rows).toEqual([{ row: 'notice', key: 'z', item: { id: 'z', order: 1, at: null, kind: 'notice', notice: 'unknown-block' } }])
  })
})

describe('days', () => {
  it('a day line before the first item of each calendar day (local time)', () => {
    const d1 = new Date(2026, 10, 13, 23, 50).getTime()
    const d2 = new Date(2026, 10, 14, 0, 10).getTime()
    const rows = buildRows([
      { id: 'u1', order: 1, at: d1, kind: 'user', text: 'a', images: 0 },
      { id: 't1', order: 2, at: d1 + 1000, kind: 'text', text: 'b' },
      { id: 'u2', order: 3, at: d2, kind: 'user', text: 'c', images: 0 },
      { id: 't2', order: 4, at: null, kind: 'text', text: 'd' },
    ], { dayLabel: at => `day ${new Date(at).getDate()}` })
    expect(rows.filter(r => r.row === 'day').map(r => (r as any).label)).toEqual(['day 13', 'day 14'])
    expect(shape(rows)).toEqual(['day', 'user', 'turn-head', 'text', 'day', 'user', 'turn-head', 'text'])
  })
})

describe('unreadAfter', () => {
  const rowsOf = (list: ChatItem[]) => buildRows(list, { dayLabel })
  const base: ChatItem[] = [
    { id: 'u', order: 1, at: null, kind: 'user', text: 'a', images: 0 },
    { id: 't', order: 2, at: null, kind: 'text', text: 'b' },
  ]

  // the bubble is pinned at the bottom (LIVE_ORDER): new rows arrive above it
  it('a provisional bubble never counts; its text counts once, whether it replaces the bubble in one update or two', () => {
    const live = { id: 'live:m', order: Number.MAX_SAFE_INTEGER, at: null, kind: 'live', text: 'streaming' } as ChatItem
    const answer = { id: 'n1', order: 3, at: null, kind: 'text', text: 'streaming, done' } as ChatItem
    expect(unreadAfter(rowsOf(base), rowsOf([...base, live]))).toBe(0)
    expect(unreadAfter(rowsOf([...base, live]), rowsOf([...base, answer]))).toBe(1)
    const both = rowsOf([...base, answer, live])
    expect(unreadAfter(rowsOf([...base, live]), both) + unreadAfter(both, rowsOf([...base, answer]))).toBe(1)
  })

  it('a row that arrives above a pinned bubble counts', () => {
    const live = { id: 'live:m', order: Number.MAX_SAFE_INTEGER, at: null, kind: 'live', text: 'streaming' } as ChatItem
    const tool = { id: 'tl', order: 2 ** 52 + 1, at: null, kind: 'tool', tool: 'Bash', input: {}, state: 'running' } as ChatItem
    expect(unreadAfter(rowsOf([...base, live]), rowsOf([...base, tool, live]))).toBe(1)
  })

  it('two new texts at the end → 2', () => {
    const next = [...base, { id: 'n1', order: 3, at: null, kind: 'text', text: 'c' }, { id: 'n2', order: 4, at: null, kind: 'text', text: 'd' }] as ChatItem[]
    expect(unreadAfter(rowsOf(base), rowsOf(next))).toBe(2)
  })

  it('a changed existing row → 0', () => {
    const next = [base[0], { ...base[1], text: 'b, longer' }] as ChatItem[]
    expect(unreadAfter(rowsOf(base), rowsOf(next))).toBe(0)
  })

  it('older rows loaded above are not new messages; turn heads and days do not count', () => {
    const older: ChatItem[] = [{ id: 'o', order: 0, at: Date.now(), kind: 'text', text: 'old' }]
    expect(unreadAfter(rowsOf(base), rowsOf([...older, ...base]))).toBe(0)
    const nextTurn: ChatItem[] = [...base, { id: 'u2', order: 3, at: null, kind: 'user', text: 'x', images: 0 }, { id: 't2', order: 4, at: null, kind: 'text', text: 'y' }]
    expect(unreadAfter(rowsOf(base), rowsOf(nextTurn))).toBe(2)
  })

  it('a first load is not unread', () => {
    expect(unreadAfter([], rowsOf(base))).toBe(0)
  })
})
