/**
 * Wild Pokémon in the chat's flow: src/chat/wild.ts (the game's own `catch` / `flee` events of
 * this session inside this conversation's time → entries), src/chat/rows.ts (`extra` → `wild` rows placed before the
 * first main-thread item stamped later; never inside a group, no day line, no turn head, never unread) and
 * src/components/chat/WildRow.tsx (`.chat-wild`: the sprite, 야생의 {name}{iga} 나타났다 → the ball and 잡았다 ·
 * Lv.n, 새로 등록, 놓쳤다, 색이 다른, a rare tier's word in its colour; one sentence for a screen reader; nothing in 업무 모드).
 * The events are tests/fixtures/chat/dex-events.json (the server's own shapes), the conversation turns.jsonl.
 */

import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { buildRows, unreadAfter, type Row } from '../src/chat/rows'
import { WILD_MAX, wildEntries, wildWindow, type WildEntry } from '../src/chat/wild'
import type { ChatItem, ToolItem } from '../src/chat/types'
import type { DexEvent } from '../src/pokedexStore'
import { linesOf } from './chat-helpers'
import { GAME_WORDS } from './helpers'
import chat from '../src/locales/chat'
import chatGame from '../src/locales/chatGame'
import DICTS from '../src/locales'

vi.mock('../src/i18n', async (orig) => ({
  ...(await orig<typeof import('../src/i18n')>()),
  t: (k: string, v?: Record<string, unknown>) => k.replace(/\{(\w+)\}/g, (m, n) => (v && n in v ? String(v[n]) : m)),
  // the Korean names and tier words (the app's language in this test)
  nameOf: (e: { ko: string } | null | undefined) => e?.ko ?? '',
  tierName: (k: string) => ({ common: '일반', rare: '희귀', sub: '준전설', legendary: '전설', mythical: '환상' } as Record<string, string>)[k] ?? k,
}))

const require = createRequire(import.meta.url)
const { createItemBuilder } = require('../electron/chatItems.cjs')
const { quickSkip } = require('../electron/chatSchema.cjs')

const ROOT = join(__dirname, '..')
const CWD = 'C:\\Users\\user\\work\\demo'
const read = (...p: string[]) => readFileSync(join(ROOT, ...p), 'utf8')
const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/[^\n]*/g, '$1')
const dayLabel = (at: number) => new Date(at).toISOString().slice(0, 10)
const at = (iso: string) => Date.parse(iso)

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

const DEX = JSON.parse(read('tests', 'fixtures', 'chat', 'dex-events.json')) as { log: DexEvent[]; today: DexEvent[] }
const EVENTS = [...DEX.log, ...DEX.today]
const ALL = items('turns.jsonl')
const FIRST = ALL[0].at!
const LAST = Math.max(...ALL.map(i => i.at ?? 0))
type Wild = Extract<Row, { row: 'wild' }>
const wilds = (rows: Row[]) => rows.filter((r): r is Wild => r.row === 'wild')

describe('wildEntries: this session\'s catches and flees inside the conversation\'s time', () => {
  it('the window: from the first item\'s time to now; none for a conversation with no time yet', () => {
    expect(wildWindow(ALL, 1_800_000_000_000)).toEqual({ from: at('2026-11-14T03:10:00.000Z'), to: 1_800_000_000_000 })
    // a live bubble or a pending prompt has no time of its own: the first stamped item counts
    const live = { id: 'live:x', order: -1, at: null, kind: 'live', text: '…' } as ChatItem
    expect(wildWindow([live, ...ALL], 5)?.from).toBe(FIRST)
    expect(wildWindow([], 5)).toBeNull()
    expect(wildWindow([live], 5)).toBeNull()
  })

  it('only s-1\'s catch and flee inside the window; the fields of the game event, never its via or a prompt', () => {
    const got = wildEntries(EVENTS, 's-1', { from: FIRST, to: LAST })
    expect(got.map(e => `${e.kind}:${e.dex}`)).toEqual(['catch:16', 'flee:147'])
    expect(got[0]).toEqual({
      key: `catch:${at('2026-11-14T03:10:04.000Z')}:16`, at: at('2026-11-14T03:10:04.000Z'), kind: 'catch', dex: 16,
      shiny: false, tier: 'common', level: 6, newSpecies: true, ball: 'great-ball',
    } satisfies WildEntry)
    expect(got[1]).toMatchObject({ kind: 'flee', dex: 147, tier: 'rare', shiny: false, newSpecies: false, ball: null })
    const text = JSON.stringify(got)
    for (const bad of ['via', 'prompt', 'label', 'Read(', 'place', 'sessionId', 'uid', 'name']) expect(text, bad).not.toContain(bad)
  })

  it('not another session\'s catch, the levelup, the evolve, the attendance catch before the window, an older day\'s', () => {
    const wide = wildEntries(EVENTS, 's-1', { from: 0, to: Number.MAX_SAFE_INTEGER })
    // (the attendance catch at 03:04 and the shiny one after the last line are s-1's: they appear only with the window open)
    expect(wide.map(e => e.dex)).toEqual([10, 16, 147, 129])
    expect(wildEntries(EVENTS, 's-2', { from: FIRST, to: LAST }).map(e => e.dex)).toEqual([19])
    expect(wildEntries(EVENTS, 's-3', { from: FIRST, to: LAST })).toEqual([])
    expect(wildEntries(EVENTS, 's-1', { from: FIRST, to: LAST }).some(e => e.dex === 10)).toBe(false)
    // to = now: the shiny catch after the conversation's last line is still this conversation's
    const now = wildEntries(EVENTS, 's-1', { from: FIRST, to: at('2026-11-14T03:20:00.000Z') })
    expect(now.map(e => e.dex)).toEqual([16, 147, 129])
    expect(now[2]).toMatchObject({ shiny: true, kind: 'catch', ball: 'poke-ball', level: 5 })
    // an event with no session, or a session id of another shape, is never this session's
    const loose = [{ ...DEX.log[2], sessionId: undefined }, { ...DEX.log[2], sessionId: 's-1 ' }] as DexEvent[]
    expect(wildEntries(loose, 's-1', { from: 0, to: Number.MAX_SAFE_INTEGER })).toEqual([])
  })

  it('log and today are deduplicated by kind, time and species; at most 200, the newest', () => {
    expect(DEX.today.filter(e => e.kind === 'catch' && e.id === 16)).toHaveLength(1)
    expect(wildEntries([...DEX.log, ...DEX.today, ...DEX.log], 's-1', { from: FIRST, to: LAST })).toHaveLength(2)
    const many = Array.from({ length: 250 }, (_, i) => ({ kind: 'catch', id: 16, sessionId: 's-1', at: 1000 + i * 10, tier: 'common' }) as DexEvent)
    const got = wildEntries([...many].reverse(), 's-1', { from: 0, to: 1e9 })
    expect(WILD_MAX).toBe(200)
    expect(got).toHaveLength(200)
    expect(got[0].at).toBe(1000 + 50 * 10)
    expect(got[199].at).toBe(1000 + 249 * 10)
    // oldest first, as the rows place them
    expect(got.every((e, i) => i === 0 || got[i - 1].at <= e.at)).toBe(true)
  })

  it('a malformed event is passed over (no number for its species or time)', () => {
    const odd = [{ kind: 'catch', id: 'x', sessionId: 's-1', at: 5 }, { kind: 'flee', id: 16, sessionId: 's-1', at: 'soon' }, null] as unknown as DexEvent[]
    expect(wildEntries(odd, 's-1', { from: 0, to: 10 })).toEqual([])
  })
})

describe('wild rows: where they met, never in a group, no day line, no head, not unread', () => {
  const entries = wildEntries(EVENTS, 's-1', { from: FIRST, to: at('2026-11-14T03:20:00.000Z') })
  const plain = buildRows(ALL, { dayLabel, hasOlder: false })
  const rows = buildRows(ALL, { dayLabel, hasOlder: false, extra: entries })

  it('each between the right items: Pidgey between the Read and the Edit, Dratini between turn 2\'s Edit and its answer, the shiny one last', () => {
    const w = wilds(rows)
    expect(w.map(r => r.key)).toEqual(entries.map(e => `wild:${e.key}`))
    const before = (r: Row) => rows[rows.indexOf(r) - 1]
    const after = (r: Row) => rows[rows.indexOf(r) + 1]
    const tool = (r: Row | undefined) => (r && r.row === 'tool' ? r.item.tool : r?.row)
    expect(tool(before(w[0]))).toBe('Read')
    expect(tool(after(w[0]))).toBe('Edit')
    expect(tool(before(w[1]))).toBe('Edit')
    expect(after(w[1]).row).toBe('text')
    expect((after(w[1]) as Extract<Row, { row: 'text' }>).item.text).toMatch(/^I wrote `docs\/rivers.md`/)
    expect(rows[rows.length - 1]).toBe(w[2])
    expect(w[2].entry.shiny).toBe(true)
  })

  it('the other rows stay as they were: no day line, no turn head, no foot changed; nothing unread', () => {
    expect(rows.filter(r => r.row !== 'wild')).toEqual(plain)
    expect(unreadAfter(plain, rows)).toBe(0)
    // (an empty extra or none: exactly the rows without it)
    expect(buildRows(ALL, { dayLabel, hasOlder: false, extra: [] })).toEqual(plain)
  })

  it('never inside a group: a meeting between two reads ends the group there', () => {
    const read = (n: number): ToolItem => ({ id: `r${n}`, order: n, at: 1000 + n * 1000, kind: 'tool', tool: 'Read', input: { file_path: `${CWD}\\f${n}.txt` }, state: 'done' } as ToolItem)
    const reads = [read(1), read(2), read(3), read(4)]
    const grouped = buildRows(reads, { dayLabel })
    expect(grouped.map(r => r.row)).toEqual(['day', 'turn-head', 'group'])
    // (the reads at 2000, 3000, 4000, 5000)
    const met: WildEntry = { key: 'catch:4500:16', at: 4500, kind: 'catch', dex: 16, shiny: false, tier: 'common', level: 6, newSpecies: false, ball: 'poke-ball' }
    const split = buildRows(reads, { dayLabel, extra: [met] })
    expect(split.map(r => r.row)).toEqual(['day', 'turn-head', 'group', 'wild', 'tool'])
    expect((split[2] as Extract<Row, { row: 'group' }>).items.map(i => i.id)).toEqual(['r1', 'r2', 'r3'])
    // one at the very time of an item goes after it (before the first item stamped later)
    const same = buildRows(reads, { dayLabel, extra: [{ ...met, key: 'catch:3000:16', at: 3000 }] })
    expect(same.map(r => r.row)).toEqual(['day', 'turn-head', 'group', 'wild', 'group'])
    expect(same.filter((r): r is Extract<Row, { row: 'group' }> => r.row === 'group').map(g => g.items.map(i => i.id))).toEqual([['r1', 'r2'], ['r3', 'r4']])
  })

  it('a sub-agent\'s items do not place it (main-thread items only); a live bubble stays last', () => {
    const base = [
      { id: 'a', order: 1, at: 1000, kind: 'tool', tool: 'Agent', input: {}, state: 'running' },
      { id: 'a1', order: 2, at: 2000, kind: 'text', text: 'child', parent: 'a' },
      { id: 'b', order: 3, at: 5000, kind: 'text', text: 'after' },
      { id: 'live:m', order: 2 ** 53 - 1, at: null, kind: 'live', text: '…' },
    ] as ChatItem[]
    const met: WildEntry = { key: 'flee:1500:147', at: 1500, kind: 'flee', dex: 147, shiny: false, tier: 'rare', level: 9, newSpecies: false, ball: null }
    const late: WildEntry = { ...met, key: 'flee:9000:147', at: 9000 }
    const r = buildRows(base, { dayLabel, extra: [late, met] })
    expect(r.map(x => x.key)).toEqual(['day:' + dayKey(1000), 'head:a', 'a', `wild:${met.key}`, 'b', `wild:${late.key}`, 'live:m'])
  })
})

function dayKey(at: number) { const d = new Date(at); return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}` }

// ---------------------------------------------------------------- the row

describe('WildRow', async () => {
  const { WildRow } = await import('../src/components/chat/WildRow')
  const { ChatContext } = await import('../src/components/chat/context')
  const base = { id: 't1', onTerminal() {}, onLink() {}, onPath() {}, loadAgent: () => Promise.resolve({ ok: true }), waitingAgents: [] }
  const html = (entry: WildEntry, over: Record<string, unknown> = {}) =>
    renderToStaticMarkup(React.createElement(ChatContext.Provider, { value: { ...base, ...over } }, React.createElement(WildRow, { rowKey: `wild:${entry.key}`, entry })))
  const caught: WildEntry = { key: 'catch:1:19', at: 1, kind: 'catch', dex: 19, shiny: false, tier: 'common', level: 6, newSpecies: true, ball: 'great-ball' }
  const fled: WildEntry = { key: 'flee:2:147', at: 2, kind: 'flee', dex: 147, shiny: false, tier: 'rare', level: 9, newSpecies: false, ball: null }
  const shiny: WildEntry = { key: 'catch:3:129', at: 3, kind: 'catch', dex: 129, shiny: true, tier: 'common', level: 5, newSpecies: false, ball: 'poke-ball' }
  const strip = (s: string) => s.replace(/<[^>]+>/g, '')
  const sr = (s: string) => /<span class="chat-sr">([^<]*)<\/span>/.exec(s)?.[1]

  it('a catch: the sprite (34px box), 야생의 꼬렛이 나타났다, →, the ball and 잡았다 · Lv.6, the hairline 새로 등록', () => {
    const h = html(caught)
    expect(h).toMatch(/^<div class="chat-wild" role="note">/)
    expect(h).toContain('<img class="chat-wild-mon" src="/sprites/pokemon/art/19.png" alt=""')
    expect(h).toMatch(/<img class="chat-wild-ball" src="\/sprites\/balls\/great-ball\.png[^"]*" alt=""/)
    expect(h).toContain('야생의 <b>꼬렛</b>이 나타났다')
    expect(h).toContain('<span class="chat-wild-arrow">→</span>')
    expect(strip(h)).toContain('잡았다 · Lv.6')
    expect(h).toContain('<span class="chat-wild-tag">새로 등록</span>')
    // read as one sentence; the drawn parts hidden from a screen reader
    expect(sr(h)).toBe('야생의 꼬렛이 나타났다, 잡았다 · Lv.6, 새로 등록')
    expect(h).toMatch(/<span class="chat-sr">[^<]*<\/span><span class="chat-wild-line" aria-hidden="true">/)
    // a common one says no tier
    expect(h).not.toContain('chat-wild-tier')
  })

  it('a flee: 놓쳤다 with no ball; a rare one\'s tier word in its tier colour (the dot and the word)', () => {
    const h = html(fled)
    expect(h).toContain('야생의 <b>미뇽</b>이 나타났다')
    expect(strip(h)).toContain('놓쳤다')
    expect(h).not.toContain('chat-wild-ball')
    expect(h).not.toContain('잡았다')
    expect(h).not.toContain('Lv.')
    expect(h).toContain('<span class="chat-wild-tier tier-rare"><i class="tdot" aria-hidden="true"></i>희귀</span>')
    expect(sr(h)).toBe('야생의 미뇽이 나타났다, 희귀, 놓쳤다')
  })

  it('a shiny one: 색이 다른 and the shiny picture; the particle follows the name (잉어킹이, 꼬렛이 / 피카츄가)', () => {
    const h = html(shiny)
    expect(h).toContain('src="/sprites/pokemon/art-shiny/129.png"')
    expect(h).toContain('<span class="chat-wild-tag">색이 다른</span>')
    expect(sr(h)).toBe('야생의 잉어킹이 나타났다, 색이 다른, 잡았다 · Lv.5')
    expect(html({ ...caught, dex: 25, newSpecies: false })).toContain('야생의 <b>피카츄</b>가 나타났다')
  })

  it('appear only when the view says it met it while watching; nothing at all in 업무 모드', () => {
    expect(html(caught)).not.toContain('appear')
    expect(html(caught, { wildNew: () => true })).toMatch(/^<div class="chat-wild appear" role="note">/)
    expect(html(caught, { wildNew: () => false })).not.toContain('appear')
    expect(html(caught, { workMode: true })).toBe('')
    expect(html(fled, { workMode: true, wildNew: () => true })).toBe('')
  })
})

// ---------------------------------------------------------------- where it is drawn, its words, its look

describe('the view: wild rows only outside 업무 모드, from the page\'s own game state', () => {
  const view = code(read('src', 'components', 'ChatView.tsx'))

  it('ChatView builds the entries only when the game is on (not 업무 모드, not the QA page) and passes them as extra', () => {
    expect(view).toMatch(/const game = !workMode && !fixed/)
    expect(view).toMatch(/usePokedex\(\)/)
    // the entries: none unless game (the hook runs in both modes; its result is empty in 업무 모드)
    expect(view).toMatch(/const \{ wild, wildNew, wildPlayed \} = useWild\(game \? sid : null, items\)/)
    expect(view).toMatch(/buildRows\(items, \{ dayLabel, density, hasOlder, extra: wild \}\)/)
    // the row drawn only through the wild row kind, and WildRow itself draws nothing in 업무 모드
    expect(view).toMatch(/case 'wild': return <WildRow rowKey=\{row\.key\} entry=\{row\.entry\} \/>/)
    const row = code(read('src', 'components', 'chat', 'WildRow.tsx'))
    expect(row).toMatch(/if \(workMode\) return null/)
    // no server change, no fetch of its own: the page's game state (usePokedex) only
    expect(read('src', 'chat', 'wild.ts')).not.toMatch(/fetch\(|bridge|WebSocket/)
  })

  it('the words in chatGame.ts (ko / en / ja), none in chat.ts, and no game word left for 업무 모드', () => {
    const words: Record<string, [string, string]> = {
      '야생의 {name}{iga} 나타났다': ['A wild {name} appeared', '野生の{name}が現れた'],
      '잡았다': ['Caught', '捕まえた'],
      '놓쳤다': ['Got away', '逃げられた'],
      '새로 등록': ['New entry', '新規登録'],
      '색이 다른': ['Shiny', '色違い'],
    }
    for (const [k, [en, ja]] of Object.entries(words)) {
      expect(chatGame.en[k], k).toBe(en)
      expect(chatGame.ja[k], k).toBe(ja)
      expect(DICTS.en[k], k).toBe(en)
      expect(DICTS.ja[k], k).toBe(ja)
      expect(chat.en[k], k).toBeUndefined()
    }
    for (const ko of Object.keys(chat.en)) for (const s of [ko, chat.en[ko], chat.ja[ko]]) expect(GAME_WORDS.test(s), s).toBe(false)
  })

  it('its look in chat-game.css; chat.css has none of it', () => {
    const game = read('src', 'styles', 'chat-game.css').replace(/\/\*[\s\S]*?\*\//g, '')
    expect(game).toMatch(/\.chat-wild \{[^}]*display: flex;[^}]*align-items: center;[^}]*width: 100%;[^}]*min-height: 52px;[^}]*font-size: var\(--t-ui\);[^}]*color: var\(--ink-3\);/)
    // (1.10.11) the box spans the conversation and holds its Pokémon whole
    expect(game).toMatch(/\.chat-wild-mon \{[^}]*width: 40px; height: 40px;/)
    expect(game).not.toMatch(/\.chat-wild-mon \{[^}]*margin: -/)
    expect(game).toMatch(/\.chat-wild b \{[^}]*color: var\(--ink-2\);[^}]*font-weight: var\(--w-name\);/)
    // the tag: a hairline, no fill (not the "now" style's filled yellow pill)
    const tag = /\.chat-wild-tag \{([^}]*)\}/.exec(game)
    expect(tag).toBeTruthy()
    expect(tag![1]).toMatch(/border: 1px solid var\(--line\);/)
    expect(tag![1]).toMatch(/border-radius: var\(--r-xs\);/)
    expect(tag![1]).not.toMatch(/background/)
    expect(game).toMatch(/\.chat-wild-tier \{[^}]*color: var\(--tier\);/)
    expect(game).not.toMatch(/--accent/)
    const chatCss = read('src', 'styles', 'chat.css')
    expect(chatCss).not.toMatch(/chat-wild/)
  })
})
