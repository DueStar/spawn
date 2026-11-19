/**
 * Density: 기본 / 생각 포함 / 전부. src/chat/density.ts (the levels, remembered as one
 * word, the virtual list's estimate per level, the initial open state), src/chat/rows.ts (thinking rows only
 * from 생각 포함; 기본 gives exactly the rows from before density levels; the never-collapsed rule in every level), the thinking
 * row, the header's menu and the list's props.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { buildRows, type Row } from '../src/chat/rows'
import type { ChatItem, ToolItem } from '../src/chat/types'
import { FIX, linesOf } from './chat-helpers'
import { GAME_WORDS } from './helpers'
import chat from '../src/locales/chat'

vi.mock('../src/i18n', async (orig) => ({
  ...(await orig<typeof import('../src/i18n')>()),
  t: (k: string, v?: Record<string, unknown>) => k.replace(/\{(\w+)\}/g, (_, n) => String(v?.[n] ?? '')),
}))

const require = createRequire(import.meta.url)
const { createItemBuilder } = require('../electron/chatItems.cjs')
const { quickSkip } = require('../electron/chatSchema.cjs')

const ROOT = join(__dirname, '..')
const CWD = 'C:\\Users\\user\\work\\demo'
const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/[^\n]*/g, '$1')
const read = (...p: string[]) => readFileSync(join(ROOT, ...p), 'utf8')

/** A fixture through the real builder, sorted as the store keeps it */
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
const dayLabel = (at: number) => new Date(at).toISOString().slice(0, 10)
// (the turn summary's feet are left out here: tests/chat-foot.test.ts pins them)
const noFeet = (rows: Row[]) => rows.filter(r => r.row !== 'foot')
const shape = (rows: Row[]) => noFeet(rows).map(r => r.row)
const json = (x: unknown) => JSON.parse(JSON.stringify(x))

// ---------------------------------------------------------------- rows

describe('buildRows by density', () => {
  // taken from rows.ts and chatItems.cjs before density levels changed them (tests/fixtures/chat/rows-phase2.json)
  const SNAP = JSON.parse(readFileSync(join(FIX, 'rows-phase2.json'), 'utf8')).rows as Record<string, Row[]>

  it('기본 gives exactly the pre-density rows (deep-equal to the snapshot taken before the change), with or without the option', () => {
    expect(Object.keys(SNAP)).toEqual(['tools.jsonl', 'thinking.jsonl', 'basic.jsonl', 'agent.jsonl', 'turns.jsonl', 'image.jsonl'])
    // (a progress note — thinkingDisplay "updates", a thinking block with text — shows in 기본 too:
    // thinking.jsonl has one; the rest of 기본 is the snapshot's, row for row)
    const notes = (rows: Row[]) => rows.filter(r => r.row === 'thinking' && r.item.update)
    // (a turn's head is keyed by the turn's first shown item: the note now, where it was the answer)
    const heads = (rows: unknown) => (JSON.parse(JSON.stringify(rows)) as { row: string; key: string; at?: unknown }[])
      .map(r => (r.row === 'turn-head' ? { ...r, key: 'head', at: 'the turn\'s first shown item' } : r))
    for (const [name, rows] of Object.entries(SNAP)) {
      for (const built of [buildRows(items(name), { dayLabel, density: 'default' }), buildRows(items(name), { dayLabel })]) {
        expect(heads(json(noFeet(built.filter(r => !notes([r]).length)))), name).toEqual(heads(rows))
        expect(notes(built), name).toHaveLength(name === 'thinking.jsonl' ? 1 : 0)
      }
    }
    // the thinking items are there; the hidden ones drawn by none of them
    expect(items('thinking.jsonl').filter(i => i.kind === 'thinking')).toHaveLength(4)
    expect(SNAP['thinking.jsonl'].some(r => (r as { row: string }).row === 'thinking')).toBe(false)
  })

  it('생각 포함 and 전부 add one thinking row before each answer, under the same turn head; nothing else changes', () => {
    const all = items('thinking.jsonl')
    const base = buildRows(all, { dayLabel, density: 'default' })
    for (const density of ['thinking', 'all'] as const) {
      const rows = buildRows(all, { dayLabel, density })
      expect(shape(rows)).toEqual(['day',
        'user', 'turn-head', 'thinking', 'text',
        'user', 'turn-head', 'thinking', 'text',
        'user', 'turn-head', 'thinking', 'text',
        'user', 'turn-head', 'thinking', 'text'])
      const thinking = rows.filter((r): r is Extract<Row, { row: 'thinking' }> => r.row === 'thinking')
      expect(thinking.map(r => r.key)).toEqual(all.filter(i => i.kind === 'thinking').map(i => i.id))
      expect(thinking.map(r => r.item.durationMs)).toEqual([1400, 900, 600, 2100])
      // without the thinking rows (and the head keyed by them), the rows are 기본's
      const strip = (rs: Row[]) => rs.filter(r => r.row !== 'thinking' && r.row !== 'turn-head')
      expect(json(strip(rows))).toEqual(json(strip(base)))
    }
  })

  it('a thinking row breaks a run of reads and can begin a turn head; 기본 drops it without breaking the group or adding a head', () => {
    const read = (id: string, order: number, over: Partial<ToolItem> = {}): ToolItem => ({ id, order, at: null, kind: 'tool', tool: 'Read', input: { file: `${id}.ts` }, state: 'done', ...over })
    const think = (id: string, order: number): ChatItem => ({ id, order, at: null, kind: 'thinking', text: '', durationMs: 1000 })
    const list: ChatItem[] = [{ id: 'u', order: 0, at: null, kind: 'user', text: 'x', images: 0 }, think('k0', 1), read('a', 2), think('k1', 3), read('b', 4), read('c', 5)]
    const d = buildRows(list, { dayLabel, density: 'default' })
    expect(shape(d)).toEqual(['user', 'turn-head', 'group'])
    expect(d[1].key).toBe('head:a')
    expect((d[2] as Extract<Row, { row: 'group' }>).items.map(i => i.id)).toEqual(['a', 'b', 'c'])
    const t = buildRows(list, { dayLabel, density: 'thinking' })
    expect(shape(t)).toEqual(['user', 'turn-head', 'thinking', 'tool', 'thinking', 'group'])
    expect(t[1].key).toBe('head:k0')
    expect((t[5] as Extract<Row, { row: 'group' }>).items.map(i => i.id)).toEqual(['b', 'c'])
    expect(json(buildRows(list, { dayLabel, density: 'all' }))).toEqual(json(t))
    // a sub-agent's thinking item (never sent today) makes no row of its own
    expect(shape(buildRows([...list, { ...think('k9', 6), parent: 'x' } as ChatItem], { dayLabel, density: 'all' }))).toEqual(shape(t))
  })

  it('the never-collapsed rule holds in every level: a permission wait, a failure, a running call, a question and a plan are rows of their own', () => {
    const read = (id: string, order: number, over: Partial<ToolItem> = {}): ToolItem => ({ id, order, at: null, kind: 'tool', tool: 'Read', input: { file: `${id}.ts` }, state: 'done', ...over })
    const list: ChatItem[] = [
      read('a', 1), read('b', 2), read('w', 3, { waiting: 'permission', state: 'running' }), read('c', 4), read('d', 5),
      read('f', 6, { state: 'failed' }), read('e', 7), read('r', 8, { state: 'running' }), read('g', 9),
      { id: 'q', order: 10, at: null, kind: 'tool', tool: 'AskUserQuestion', input: { question: '?' }, state: 'done' },
      read('h', 11), { id: 'p', order: 12, at: null, kind: 'tool', tool: 'ExitPlanMode', input: { plan: 'x' }, state: 'done' }, read('i', 13),
      { id: 'k', order: 14, at: null, kind: 'thinking', text: '' }, read('j', 15),
    ]
    for (const density of ['default', 'thinking', 'all'] as const) {
      const rows = buildRows(list, { dayLabel, density })
      for (const id of ['w', 'f', 'r', 'q', 'p']) {
        expect(rows.some(r => r.row === 'tool' && r.key === id), `${density}: ${id} alone`).toBe(true)
        expect(rows.some(r => r.row === 'group' && r.items.some(i => i.id === id)), `${density}: ${id} in a group`).toBe(false)
      }
    }
  })

  it('the waiting row of chat-waiting stays a row of its own in each level', () => {
    const tools = items('tools.jsonl')
    const waiting: ToolItem = { id: 'wait', order: 1e12, at: null, kind: 'tool', tool: 'Read', input: { file: 'x' }, state: 'running', waiting: 'permission' }
    for (const density of ['default', 'thinking', 'all'] as const) {
      const rows = buildRows([...tools, waiting], { dayLabel, density })
      expect(rows.at(-1)).toMatchObject({ row: 'tool', key: 'wait' })
    }
  })

  it('sameRow knows the thinking row (item identity)', async () => {
    const { sameRow } = await import('../src/components/ChatView')
    const item: ChatItem = { id: 'k', order: 1, at: null, kind: 'thinking', text: '' }
    const a: Row = { row: 'thinking', key: 'k', item: item as Extract<ChatItem, { kind: 'thinking' }> }
    expect(sameRow(a, { ...a })).toBe(true)
    expect(sameRow(a, { ...a, item: { ...item } as Extract<ChatItem, { kind: 'thinking' }> })).toBe(false)
  })
})

// ---------------------------------------------------------------- the level, remembered

describe('density.ts', () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.resetModules() })
  const storage = (init: Record<string, string> = {}, broken = false) => {
    const m = new Map(Object.entries(init))
    return {
      map: m,
      getItem: (k: string) => { if (broken) throw new Error('denied'); return m.get(k) ?? null },
      setItem: (k: string, v: string) => { if (broken) throw new Error('denied'); m.set(k, String(v)) },
      removeItem: (k: string) => { m.delete(k) },
    }
  }

  it('reads the remembered word; a bad value, none, or a storage that throws gives 기본', async () => {
    for (const [stored, want] of [['thinking', 'thinking'], ['all', 'all'], ['default', 'default'], ['ALL', 'default'], ['{"x":1}', 'default'], [undefined, 'default']] as const) {
      vi.stubGlobal('localStorage', storage(stored === undefined ? {} : { 'spawn-chat-density': stored }))
      const { readDensity } = await import('../src/chat/density')
      expect(readDensity(), String(stored)).toBe(want)
    }
    vi.stubGlobal('localStorage', storage({}, true))
    const { readDensity, writeDensity } = await import('../src/chat/density')
    expect(readDensity()).toBe('default')
    expect(() => writeDensity('all')).not.toThrow()
    vi.unstubAllGlobals()
    const { readDensity: noStorage } = await import('../src/chat/density')
    expect(noStorage()).toBe('default')
  })

  it('writes one word under spawn-chat-density and tells its listeners', async () => {
    const s = storage()
    vi.stubGlobal('localStorage', s)
    const { writeDensity, readDensity, subscribeDensity } = await import('../src/chat/density')
    const heard: string[] = []
    const off = subscribeDensity(() => heard.push(readDensity()))
    writeDensity('thinking')
    expect(s.map.get('spawn-chat-density')).toBe('thinking')
    writeDensity('all')
    off()
    writeDensity('default')
    expect(heard).toEqual(['thinking', 'all'])
    expect([...s.map.keys()]).toEqual(['spawn-chat-density'])
  })

  it('ESTIMATE and TIGHT have every level; the initial open state', async () => {
    const { DENSITIES, ESTIMATE, TIGHT, initialOpen } = await import('../src/chat/density')
    expect(DENSITIES).toEqual(['default', 'thinking', 'all'])
    expect(ESTIMATE).toEqual({ default: 44, thinking: 48, all: 140 })
    expect(TIGHT).toEqual({ default: true, thinking: true, all: false })
    for (const kind of ['tool', 'group', 'agent', 'diff'] as const) {
      expect(initialOpen('all', kind)).toBe(true)
      expect(initialOpen('thinking', kind)).toBe(false)
      expect(initialOpen('default', kind)).toBe(false)
    }
  })
})

// ---------------------------------------------------------------- the pieces

describe('the thinking row', () => {
  it('생각 · {time}, then "not in the record" when the text is empty or redacted', async () => {
    const { ThinkingRow } = await import('../src/components/chat/ThinkingRow')
    const html = renderToStaticMarkup(React.createElement(ThinkingRow, { item: { id: 'k', order: 0, at: null, kind: 'thinking', text: '', durationMs: 1400 } }))
    expect(html).toContain('생각 · 1초')
    expect(html).toContain('생각한 내용은 기록에 남지 않았어요')
    expect(html).toMatch(/^<div class="chat-think"/)
    const red = renderToStaticMarkup(React.createElement(ThinkingRow, { item: { id: 'k', order: 0, at: null, kind: 'thinking', text: '', redacted: true, durationMs: 600 } }))
    expect(red).toContain('생각한 내용은 기록에 남지 않았어요')
    // under a second reads as 1초 (never 0초); no duration: 생각 alone
    expect(red).toContain('생각 · 1초')
    const bare = renderToStaticMarkup(React.createElement(ThinkingRow, { item: { id: 'k', order: 0, at: null, kind: 'thinking', text: '' } }))
    expect(bare).toMatch(/>생각</)
    expect(bare).not.toContain('·')
  })

  it('the text when a later Claude Code writes it (as prose, cut said)', async () => {
    const { ThinkingRow } = await import('../src/components/chat/ThinkingRow')
    const html = renderToStaticMarkup(React.createElement(ThinkingRow, { item: { id: 'k', order: 0, at: null, kind: 'thinking', text: 'The Amazon drains the `largest` basin.', durationMs: 2100, truncated: true } }))
    expect(html).toContain('생각 · 2초')
    expect(html).toContain('The Amazon drains the')
    expect(html).toContain('<code>largest</code>')
    expect(html).not.toContain('기록에 남지 않았어요')
    expect(html).toContain('글이 길어서 앞부분만 보여요')
    // (the rest is read again from the record, 전체 보기, never "see the terminal")
    expect(html).not.toContain('터미널에서 보세요')
  })
})

describe('the density menu', () => {
  const src = code(read('src', 'components', 'chat', 'DensityMenu.tsx'))
  it('a menu button with three radio items, the text-size menu\'s keys, the focus back to the button', () => {
    expect(src).toMatch(/aria-haspopup="menu"/)
    expect(src).toMatch(/aria-expanded=\{open\}/)
    expect(src).toMatch(/role="menu"/)
    expect(src).toMatch(/role="menuitemradio"/)
    expect(src).toMatch(/aria-checked=\{/)
    expect(src).toMatch(/DENSITIES\.map\(/)
    expect(src).toMatch(/menuKeyIndex\(/)
    expect(src).toMatch(/'Escape'/)
    expect(src).toMatch(/'Tab'/)
    expect(src).toMatch(/btn\.current\?\.focus\(\)/)
    expect(src).toMatch(/writeDensity\(/)
    expect(src).toMatch(/tSense\('기본', DENSITY_SENSE\)|tSense\(DENSITY_LABEL\[/)
  })

  it('closed: the eye, the level\'s name and the chevron; named 보기 정도 with the level', async () => {
    const { DensityMenu } = await import('../src/components/chat/DensityMenu')
    const html = renderToStaticMarkup(React.createElement(DensityMenu))
    expect(html).toMatch(/^<div class="w-dens-anchor"><button type="button" class="w-dens"/)
    expect(html).toContain('aria-haspopup="menu"')
    expect(html).toContain('aria-expanded="false"')
    expect(html).toContain('aria-label="보기 정도: 기본"')
    expect(html).toContain('<span class="w-dens-name">기본</span>')
    expect(html).not.toContain('role="menu"')
  })

  it('the styles: hit area ≥ 22px, not a drag region, the chosen level on the quiet grey (no yellow)', () => {
    const css = read('src', 'styles', 'widget-expanded.css')
    const rule = (sel: string) => { const m = new RegExp(`${sel.replace(/[.]/g, '\\.')} \\{([^}]*)\\}`).exec(css); return m ? m[1] : '' }
    expect(rule('.w-dens')).toMatch(/height: 26px/)
    expect(rule('.w-dens')).toMatch(/-webkit-app-region: no-drag/)
    expect(css).toMatch(/\.w-dens-item:hover, \.w-dens-item\.on \{ background: var\(--sel-bg\); \}/)
    const dens = css.split('\n').filter(l => /w-dens/.test(l)).join('\n')
    expect(dens).not.toMatch(/--accent/)
    // a narrow window: the name folds away (kept for a screen reader)
    expect(css).toMatch(/@media \(max-width: 760px\) \{[^}]*\}[^@]*\.w-dens-name \{ position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset\(50%\)/)
  })
})

describe('the list, the view and the window', () => {
  it('ChatList has no literal 44 left: the estimate and tight come in as props', () => {
    const src = code(read('src', 'components', 'chat', 'ChatList.tsx'))
    expect(src).not.toMatch(/\b44\b/)
    expect(src).toMatch(/estimate: number/)
    expect(src).toMatch(/tight: boolean/)
    expect(src).not.toMatch(/const ESTIMATE/)
  })

  it('ESTIMATE / TIGHT live only in src/chat/density.ts', () => {
    const walk = (d: string): string[] => readdirSync(d).flatMap(n => { const p = join(d, n); return statSync(p).isDirectory() ? walk(p) : [p] })
    const defs = walk(join(ROOT, 'src')).filter(f => /\.(ts|tsx)$/.test(f) && /\b(const|let) (ESTIMATE|TIGHT)\b/.test(readFileSync(f, 'utf8')))
    expect(defs.map(f => f.slice(ROOT.length + 1).replace(/\\/g, '/'))).toEqual(['src/chat/density.ts'])
  })

  it('ChatView builds the rows for the level and hands the list its estimate and tight; the rows open from the level', () => {
    const src = code(read('src', 'components', 'ChatView.tsx'))
    expect(src).toMatch(/const density = useDensity\(\)/)
    expect(src).toMatch(/useMemo\(\(\) => buildRows\(items, \{ dayLabel, density, hasOlder, extra: wild \}\), \[items, lang, today, density, hasOlder, wild\]\)/)
    expect(src).toMatch(/estimate=\{ESTIMATE\[density\]\}/)
    expect(src).toMatch(/tight=\{TIGHT\[density\]\}/)
    expect(src).toMatch(/case 'thinking': return <ThinkingRow item=\{row\.item\} \/>/)
    expect(code(read('src', 'components', 'chat', 'ToolRow.tsx'))).toMatch(/useRowOpen\(item\.id, initialOpen\(ctx\.density \?\? 'default', 'tool'\)\)/)
    expect(code(read('src', 'components', 'chat', 'ToolGroup.tsx'))).toMatch(/useRowOpen\(groupOpenKey\(groupKey\), initialOpen\(density \?\? 'default', 'group'\)\)/)
    expect(code(read('src', 'components', 'chat', 'AgentGroup.tsx'))).toMatch(/useRowOpen\(item\.id, initialOpen\(ctx\.density \?\? 'default', 'agent'\)\)/)
    expect(code(read('src', 'components', 'chat', 'DiffBlock.tsx'))).toMatch(/useRowOpen\(`\$\{item\.id\}:diff`, initialOpen\(density \?\? 'default', 'diff'\)\)/)
  })

  it('the menu sits in the header\'s chat tools only (chat mode), loaded lazily', () => {
    const src = code(read('src', 'Widget.tsx'))
    expect(src).toMatch(/const DensityMenu = lazy\(\(\) => import\('\.\/components\/chat\/DensityMenu'\)\)/)
    expect(src).not.toMatch(/import [^\n]*from '\.\/components\/chat\/DensityMenu'/)
    expect(src).toMatch(/chatTools=\{lensMode === 'chat' && lens\.show \? \(\s*<Suspense fallback=\{null\}>\s*<DensityMenu \/>/)
  })

  it('the lens: a thinking item alone does not pass the canary of a turn with tools only', () => {
    const src = code(read('electron', 'chatLens.cjs'))
    expect(src).toMatch(/if \(!t\.canary\.msg\) return lines\.some\(i => i\.kind !== 'user' && i\.kind !== 'thinking'\)/)
  })
})

describe('strings', () => {
  const KEYS = ['보기 정도', '기본#density', '도구는 한 줄 요약, 실패와 질문은 늘 펼침', '생각 포함', '답하기 전에 생각한 내용도 보기', '전부', '읽은 파일과 출력까지 모두 펼치기', '생각 · {time}', '생각한 내용은 기록에 남지 않았어요', '생각']
  it('every new key in en and ja, in chat.ts, none of the game\'s words', async () => {
    const DICTS = (await import('../src/locales')).default
    for (const k of KEYS) {
      expect(chat.en[k], `en: ${k}`).toBeTruthy()
      expect(chat.ja[k], `ja: ${k}`).toBeTruthy()
      expect(DICTS.en[k], `en: ${k}`).toBeTruthy()
      expect(DICTS.ja[k], `ja: ${k}`).toBeTruthy()
      for (const s of [k, chat.en[k], chat.ja[k]]) expect(GAME_WORDS.test(s ?? ''), s).toBe(false)
    }
  })
  it('the plan\'s English and Japanese', () => {
    expect(chat.en['보기 정도']).toBe('Detail')
    expect(chat.ja['보기 정도']).toBe('表示の詳しさ')
    expect(chat.en['기본#density']).toBe('Default')
    expect(chat.ja['기본#density']).toBe('基本')
    expect(chat.en['생각 포함']).toBe('With thinking')
    expect(chat.ja['생각 포함']).toBe('思考を含む')
    expect(chat.en['전부']).toBe('Everything')
    expect(chat.ja['전부']).toBe('すべて')
    expect(chat.en['생각 · {time}']).toBe('Thinking · {time}')
    expect(chat.ja['생각 · {time}']).toBe('思考・{time}')
    expect(chat.en['생각한 내용은 기록에 남지 않았어요']).toBe("The thinking itself isn't in the record")
    expect(chat.ja['생각한 내용은 기록에 남지 않았어요']).toBe('思考の内容は記録に残っていません')
  })
  it('chat.css stays without animation', () => {
    expect(read('src', 'styles', 'chat.css')).not.toMatch(/animation|@keyframes/)
  })
})
