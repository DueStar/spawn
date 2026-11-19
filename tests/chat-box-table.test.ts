/**
 * Tables the terminal draws (2026-11-19, the owner's report: "since it reads the terminal's text as it is, a table Claude
 * wrote shows up as raw special characters"). Claude Code 2.1.32x draws a markdown table with box-drawing lines (its
 * renderer, read from the 2.1.328 binary: top ┌─┬─┐, the header, ├─┼─┤, each row with a ├─┼─┤ line between rows,
 * bottom └─┴─┘; a cell's words wrap onto more lines of its row; the header centred). The samples below are
 * RECONSTRUCTED from that renderer, not captured screens. The transcript's own markdown tables were already parsed
 * (checked here too); the raw characters came from text read off the screen (a dialog's body: a plan or a question
 * drawn over its choices).
 */

import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { boxSegments, boxTableAt, unboxTables } from '../src/chat/boxTable'
import { parseMarkdown } from '../src/chat/markdown'
import { parseDialog } from '../src/chat/dialog'
import { DialogCard } from '../src/components/chat/DialogCard'

const DRAWN = [
  '┌──────────┬────────────────────┬────────┐',
  '│   파일   │        설명        │  상태  │',
  '├──────────┼────────────────────┼────────┤',
  '│ app.ts   │ 진입점             │ 완료   │',
  '├──────────┼────────────────────┼────────┤',
  '│ login.ts │ 로그인 화면과 리다 │ 진행   │',
  '│          │ 이렉트 처리        │ 중     │',
  '├──────────┼────────────────────┼────────┤',
  '│ a|b.md   │ `code` 그대로      │        │',
  '└──────────┴────────────────────┴────────┘',
]

describe('boxTableAt', () => {
  it('a whole table: the header, each row (a wrapped row joined), empty cells kept', () => {
    const t = boxTableAt(DRAWN, 0)!
    expect(t.end).toBe(DRAWN.length)
    expect(t.table.head).toEqual(['파일', '설명', '상태'])
    expect(t.table.rows).toEqual([
      ['app.ts', '진입점', '완료'],
      ['login.ts', '로그인 화면과 리다 이렉트 처리', '진행 중'],
      ['a|b.md', '`code` 그대로', ''],
    ])
  })
  it('a table drawn with one ├ line only: a row per line', () => {
    const t = boxTableAt(['┌───┬───┐', '│ a │ b │', '├───┼───┤', '│ 1 │ 2 │', '│ 3 │ 4 │', '└───┴───┘'], 0)!
    expect(t.table.rows).toEqual([['1', '2'], ['3', '4']])
  })
  it('not whole: no bottom (cut), a line wrapped by a narrow terminal, a cell more or less, no header line', () => {
    expect(boxTableAt(DRAWN.slice(0, -1), 0)).toBeNull()
    expect(boxTableAt(['┌───┬───┐', '│ a │ b │', '├───┼───┤', '│ 1 │ 2', '└───┴───┘'], 0)).toBeNull()
    expect(boxTableAt(['┌───┬───┐', '│ a │ b │ c │', '├───┼───┤', '│ 1 │ 2 │', '└───┴───┘'], 0)).toBeNull()
    expect(boxTableAt(['┌───┬───┐', '│ a │ b │', '└───┴───┘'], 0)).toBeNull()
    expect(boxTableAt(DRAWN, 1)).toBeNull()
  })
})

describe('unboxTables and the chat\'s markdown', () => {
  it('a drawn table in text becomes a GFM table the markdown shows as a table (a | in a cell escaped)', () => {
    const md = unboxTables(['정리했어요:', ...DRAWN, '끝.'].join('\n'))
    expect(md).toContain('| 파일 | 설명 | 상태 |')
    expect(md).toContain('| a\\|b.md | `code` 그대로 |  |')
    const blocks = parseMarkdown(['정리했어요:', ...DRAWN.map(l => `  ${l}`), '끝.'].join('\n'))
    expect(blocks.map(b => b.type)).toEqual(['para', 'table', 'para'])
    const table = blocks[1] as Extract<(typeof blocks)[number], { type: 'table' }>
    expect(table.rows).toHaveLength(3)
    expect(table.rows[2][0]).toEqual([{ type: 'text', text: 'a|b.md' }])
    expect(table.rows[2][1][0]).toEqual({ type: 'code', text: 'code' })
  })
  it('inside fenced code: left as drawn; without a top: left as it is', () => {
    const fenced = ['```', ...DRAWN, '```'].join('\n')
    expect(unboxTables(fenced)).toBe(fenced)
    expect(parseMarkdown(fenced).map(b => b.type)).toEqual(['code'])
    const cut = DRAWN.slice(2).join('\n')
    expect(unboxTables(cut)).toBe(cut)
  })
  it('the transcript\'s own tables (already parsed): no outer pipes, alignment, code with a pipe, escaped pipes, right after a line, CJK', () => {
    expect(parseMarkdown('a | b\n--- | ---\n1 | 2').map(b => b.type)).toEqual(['table'])
    const t = parseMarkdown('표:\n| 이름 | 값 |\n|:--|--:|\n| `x|y` | p \\| q |')
    expect(t.map(b => b.type)).toEqual(['para', 'table'])
    const tb = t[1] as Extract<(typeof t)[number], { type: 'table' }>
    expect(tb.align).toEqual(['left', 'right'])
    expect(tb.rows[0][0]).toEqual([{ type: 'code', text: 'x|y' }])
    expect(tb.rows[0][1]).toEqual([{ type: 'text', text: 'p | q' }])
  })
})

describe('boxSegments (a dialog\'s body)', () => {
  it('text, a whole table, and drawn lines that are not one (monospace, so they line up)', () => {
    const segs = boxSegments(['계획:', ...DRAWN, '', '│ 1 │ 2 │', '└───┴───┘', '이대로 할까요?'])
    expect(segs.map(s => s.kind)).toEqual(['text', 'table', 'text', 'mono', 'text'])
  })
})

describe('the dialog card: a plan with a table over its choices', () => {
  const screen = [
    '────────────────────────────────────────────────',
    ' 계획',
    ...DRAWN.map(l => ` ${l}`),
    '',
    ' Would you like to proceed?',
    '',
    ' ❯ 1. Yes',
    '   2. No, keep planning',
    '',
    ' Enter to confirm · Esc to cancel',
  ].join('\n')
  it('shows the table as a table, never its drawing characters', () => {
    const d = parseDialog(screen)!
    expect(d.title).toBe('Would you like to proceed?')
    const html = renderToStaticMarkup(React.createElement(DialogCard, { id: 'plan', dialog: d, dialogKey: async () => ({ ok: true }), read: () => screen }))
    expect(html).toContain('<table>')
    expect(html).toContain('로그인 화면과 리다 이렉트 처리')
    expect(html).not.toMatch(/[┌┬┐├┼┤└┴┘│]/)
  })
})
