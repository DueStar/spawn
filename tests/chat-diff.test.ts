/**
 * electron/chatItems.cjs buildDiff — a diff block and +N −N from the
 * transcript's structuredPatch (Edit) or a created file's content (Write),
 * never from the disk; any shape it does not know gives no diff at all.
 */

import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { itemProblems, linesOf } from './chat-helpers'

const require = createRequire(import.meta.url)
const { buildDiff, createItemBuilder } = require('../electron/chatItems.cjs')
const { quickSkip } = require('../electron/chatSchema.cjs')

const CWD = 'C:\\Users\\user\\work\\demo'

function toolsItems() {
  const b = createItemBuilder({ cwd: CWD })
  const items = new Map<string, any>()
  for (const { text, offset } of linesOf('tools.jsonl')) {
    if (quickSkip(text)) continue
    for (const it of b.line(JSON.parse(text), offset)) items.set(it.id, it)
  }
  return items
}

describe('an Edit', () => {
  it('gives the hunk with its line numbers and +4 −1', () => {
    const lines = linesOf('tools.jsonl')
    const r = JSON.parse(lines.find(l => l.text.includes('"tool_use_id":"toolu_fixture07"'))!.text).toolUseResult
    const d = buildDiff(r, { cwd: CWD })
    expect(d).toMatchObject({ file: 'src/math.js', kind: 'edit', added: 4, removed: 1, hidden: 0 })
    expect(d.hunks).toHaveLength(1)
    expect(d.hunks[0]).toMatchObject({ oldStart: 6, newStart: 6 })
    expect(d.hunks[0].lines).toEqual([
      { t: ' ', old: 6, new: 6, text: '  return a - b' },
      { t: ' ', old: 7, new: 7, text: '}' },
      { t: ' ', old: 8, new: 8, text: '' },
      { t: '-', old: 9, new: null, text: 'module.exports = { add, sub }' },
      { t: '+', old: null, new: 9, text: 'function mul(a, b) {' },
      { t: '+', old: null, new: 10, text: '  return a * b' },
      { t: '+', old: null, new: 11, text: '}' },
      { t: '+', old: null, new: 12, text: 'module.exports = { add, sub, mul }' },
    ])
  })

  it('the builder puts it on the done Edit row; the failed Edit has none', () => {
    const items = toolsItems()
    expect(items.get('toolu_fixture07').diff).toMatchObject({ kind: 'edit', added: 4, removed: 1 })
    expect(items.get('toolu_fixture06').diff).toBeUndefined()
    expect(items.get('toolu_fixture04').diff).toBeUndefined() // a Bash row
    for (const it of items.values()) expect(itemProblems(it)).toEqual([])
  })
})

describe('a Write', () => {
  it('a created file: every line added, numbered from 1', () => {
    const items = toolsItems()
    const d = items.get('toolu_fixture08').diff
    expect(d).toMatchObject({ file: 'src/notes.md', kind: 'create', added: 5, removed: 0, hidden: 0 })
    expect(d.hunks[0]).toMatchObject({ oldStart: 0, newStart: 1 })
    expect(d.hunks[0].lines.map((l: any) => [l.t, l.new, l.text])).toEqual([['+', 1, '# Notes'], ['+', 2, ''], ['+', 3, 'alpha'], ['+', 4, 'beta'], ['+', 5, 'gamma']])
  })

  it('800 created lines: 600 shown, 200 hidden, all 800 counted', () => {
    const content = Array.from({ length: 800 }, (_, i) => `line ${i + 1}`).join('\n') + '\n'
    const d = buildDiff({ type: 'create', filePath: `${CWD}\\big.txt`, content, structuredPatch: [], originalFile: null }, { cwd: CWD })
    expect(d).toMatchObject({ kind: 'create', added: 800, removed: 0, hidden: 200 })
    expect(d.hunks[0].lines).toHaveLength(600)
  })

  it('over an existing file (type update with a patch): a write diff', () => {
    const d = buildDiff({ type: 'update', filePath: `${CWD}\\a.txt`, content: 'b\n', structuredPatch: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-a', '+b'] }] }, { cwd: CWD })
    expect(d).toMatchObject({ file: 'a.txt', kind: 'write', added: 1, removed: 1 })
  })
})

describe('shapes it does not know give no diff (nothing invented)', () => {
  const hunk = { oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-a', '+b'] }
  it('malformed hunks', () => {
    expect(buildDiff({ filePath: 'x', structuredPatch: [{ ...hunk, lines: undefined }] }, { cwd: CWD })).toBeNull()
    expect(buildDiff({ filePath: 'x', structuredPatch: [{ ...hunk, oldStart: '1' }] }, { cwd: CWD })).toBeNull()
    expect(buildDiff({ filePath: 'x', structuredPatch: [{ ...hunk, lines: ['?odd'] }] }, { cwd: CWD })).toBeNull()
    expect(buildDiff({ structuredPatch: [hunk] }, { cwd: CWD })).toBeNull() // no file
  })

  it('an empty patch on anything but a create', () => {
    expect(buildDiff({ filePath: 'x', structuredPatch: [] }, { cwd: CWD })).toBeNull()
    expect(buildDiff({ type: 'update', filePath: 'x', structuredPatch: [] }, { cwd: CWD })).toBeNull()
  })

  it('no patch, or no result at all (an unverified MultiEdit shape): null or a valid block, never a crash', () => {
    for (const r of [null, undefined, 'Error: x', 42, {}, { edits: [] }, { filePath: 'x', structuredPatch: 'nope' }]) expect(buildDiff(r, { cwd: CWD })).toBeNull()
    const multi = buildDiff({ filePath: `${CWD}\\m.ts`, edits: [{ old_string: 'a', new_string: 'b' }], structuredPatch: [hunk, { oldStart: 9, oldLines: 1, newStart: 9, newLines: 2, lines: [' x', '+y'] }] }, { cwd: CWD })
    expect(multi).toMatchObject({ kind: 'edit', added: 2, removed: 1, file: 'm.ts' })
  })

  it('"\\ No newline at end of file" lines are left out', () => {
    const d = buildDiff({ filePath: 'x', structuredPatch: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-a', '\\ No newline at end of file', '+b'] }] }, { cwd: CWD })
    expect(d.hunks[0].lines.map((l: any) => l.t)).toEqual(['-', '+'])
  })
})

describe('no disk', () => {
  it('buildDiff never reads a file', () => {
    const src = readFileSync(join(__dirname, '..', 'electron', 'chatItems.cjs'), 'utf8')
    const start = src.indexOf('function buildDiff(')
    expect(start).toBeGreaterThan(0)
    const body = src.slice(start, src.indexOf('\n}\n', start))
    expect(body).not.toMatch(/fs\.|readFile|originalFile/)
    expect(src).not.toMatch(/require\(['"](node:)?fs['"]\)/)
  })
})

// I3: a minified file or a long-line Write must not send megabytes per row
describe('size caps', () => {
  it('each line is cut, and the block says it is cut', () => {
    const d = buildDiff({ type: 'create', filePath: `${CWD}\\bundle.min.js`, content: 'x'.repeat(3_000_000), structuredPatch: [], originalFile: null }, { cwd: CWD })
    expect(d.hunks[0].lines[0].text.length).toBeLessThanOrEqual(2000)
    expect(d.truncated).toBe(true)
    expect(d.added).toBe(1)
    const e = buildDiff({ filePath: `${CWD}\\a.json`, structuredPatch: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-' + 'a'.repeat(3_000_000), '+' + 'b'.repeat(3_000_000)] }] }, { cwd: CWD })
    expect(JSON.stringify(e).length).toBeLessThan(10_000)
    expect(e.truncated).toBe(true)
    expect(e).toMatchObject({ added: 1, removed: 1 })
  })

  it('the whole block is capped: the lines past it are counted as hidden', () => {
    const content = Array.from({ length: 500 }, () => 'y'.repeat(1500)).join('\n') + '\n' // 750 000 characters
    const d = buildDiff({ type: 'create', filePath: `${CWD}\\big.txt`, content, structuredPatch: [], originalFile: null }, { cwd: CWD })
    const sent = d.hunks.flatMap((h: any) => h.lines).reduce((n: number, l: any) => n + l.text.length, 0)
    expect(sent).toBeLessThanOrEqual(200_000)
    expect(d.added).toBe(500)
    expect(d.hidden).toBe(500 - d.hunks[0].lines.length)
    expect(d.truncated).toBe(true)
  })

  it('an ordinary diff is not marked', () => {
    const items = toolsItems()
    expect(items.get('toolu_fixture07').diff.truncated).toBeUndefined()
  })
})

describe('the page says a cut diff is cut (I3)', () => {
  it('잘림 in the head of a truncated diff, nothing on an ordinary one', async () => {
    const React = (await import('react')).default
    const { renderToStaticMarkup } = await import('react-dom/server')
    const { DiffBlock } = await import('../src/components/chat/DiffBlock')
    const DICTS = (await import('../src/locales/index')).default
    const cut = buildDiff({ type: 'create', filePath: `${CWD}\\bundle.min.js`, content: 'x'.repeat(5000) }, { cwd: CWD })
    const item = { id: 't', order: 0, at: null, kind: 'tool', tool: 'Write', input: {}, state: 'done', diff: cut }
    const head = renderToStaticMarkup(React.createElement(DiffBlock as any, { item, diff: cut }))
    expect(head).toContain('잘림')
    // the Windows path in the folder is named from it (`\\b` in the fixture is a backslash and a b, not a backspace)
    expect(head).toContain('>bundle.min.js</button>')
    const plain = toolsItems().get('toolu_fixture07')
    expect(renderToStaticMarkup(React.createElement(DiffBlock as any, { item: plain, diff: plain.diff }))).not.toContain('잘림')
    for (const lang of ['en', 'ja'] as const) expect(DICTS[lang]['잘림']).toBeTruthy()
  })
})
