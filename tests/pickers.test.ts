/**
 * The pickers (던지기, 교체): every resting Pokémon (in the box, not working a session, not helping a subagent), most
 * recently worked first, a name / number search, and a first page of PICKER_PAGE cells so 1,200 resting Pokémon
 * paint fast. No party anywhere.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PICKER_PAGE, SwapPicker, ThrowPicker, pickerList } from '../src/components/PartyPickers'
import { pokemonById } from '../src/theme'
import { levelOf, type DexState, type Mon } from '../src/pokedexStore'
import { nameOf } from '../src/i18n'

vi.mock('../src/i18n', async (orig) => ({
  ...(await orig<typeof import('../src/i18n')>()),
  t: (k: string, v?: Record<string, unknown>) => k.replace(/\{(\w+)\}/g, (_, n) => String(v?.[n] ?? '')),
}))

const ROOT = join(__dirname, '..')
const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/[^\n]*/g, '$1')

const uidOf = (dex: number) => `u${dex}`

/** 300 box Pokémon (dex 1..300): dex 1 and 2 work sessions, dex 3 helps a subagent; outAt on 100 (newest), 200, 50 and on working dex 1 (newer still) */
function dexState(): DexState {
  const mons: Record<string, Mon> = {}
  const box: string[] = []
  for (let d = 1; d <= 300; d++) {
    const uid = uidOf(d)
    mons[uid] = { uid, dex: d, steps: 0, evos: 0, shiny: d === 100, how: 'wild' as Mon['how'], place: '', at: d, metLevel: 5, workMs: 0 }
    box.push(uid)
  }
  mons[uidOf(1)].outAt = 9_000
  mons[uidOf(100)].outAt = 3_000
  mons[uidOf(200)].outAt = 2_000
  mons[uidOf(50)].outAt = 1_000
  return {
    caught: {}, seen: {}, trainer: null, mons, box,
    assign: { s1: uidOf(1), s2: uidOf(2) },
    helpers: { s1: [uidOf(3)] },
    encounters: 0, sinceLegend: 0, sinceMythical: 0, pity: 0, pityMythical: 0, total: 300, log: [],
  }
}

const cells = (html: string) => html.match(/<button[^>]*class="w-swap-cell[^"]*"[^>]*>/g) ?? []
const labelOf = (cell: string) => /aria-label="([^"]*)"/.exec(cell)?.[1]
const label = (m: Mon) => `${m.shiny ? '✦ ' : ''}${nameOf(pokemonById(m.dex))} Lv.${levelOf(m)}`
const noop = () => {}

afterEach(() => { vi.unstubAllGlobals() })

describe('ThrowPicker: every resting Pokémon, recent first, one page', () => {
  const dex = dexState()
  const html = renderToStaticMarkup(React.createElement(ThrowPicker, { dex, resume: false, onPick: noop, onClose: noop }))

  it('shows exactly PICKER_PAGE cells and one 더 보기', () => {
    expect(PICKER_PAGE).toBe(120)
    expect(cells(html)).toHaveLength(PICKER_PAGE)
    expect(html.split('더 보기').length - 1).toBe(1)
  })

  it('starts with the most recently worked resting Pokémon, in outAt order', () => {
    const labels = cells(html).map(labelOf)
    expect(labels.slice(0, 3)).toEqual([label(dex.mons[uidOf(100)]), label(dex.mons[uidOf(200)]), label(dex.mons[uidOf(50)])])
    expect(labels[0]).toMatch(/^✦ /)
    // title says the same
    expect(/title="([^"]*)"/.exec(cells(html)[0])?.[1]).toBe(labels[0])
  })

  it('never offers a working or helping Pokémon', () => {
    const labels = cells(html).map(labelOf)
    for (const d of [1, 2, 3]) expect(labels).not.toContain(label(dex.mons[uidOf(d)]))
  })

  it('one search field, one grid, no party or helper words', () => {
    expect(html.match(/aria-label="이름 검색"/g)).toHaveLength(1)
    expect(html.match(/class="w-swap-box"/g)).toHaveLength(1)
    expect(html).not.toContain('파티')
    expect(html).not.toContain('조력자')
    expect(html).not.toContain('w-swap-item')
  })

  it('keeps the resume title and hint and the AI-tool radio group', () => {
    const r = renderToStaticMarkup(React.createElement(ThrowPicker, {
      dex, resume: true, tools: [{ id: 'codex', name: 'Codex' } as any], onPick: noop, onClose: noop,
    }))
    expect(r).toContain('이 세션에 보낼 포켓몬')
    expect(r).toContain('w-throw-hint')
    expect(r).toContain('role="radiogroup"')
    expect(cells(r)).toHaveLength(PICKER_PAGE)
  })
})

describe('SwapPicker', () => {
  it('lists the same resting Pokémon, and says none rests when every one works', () => {
    const dex = dexState()
    const html = renderToStaticMarkup(React.createElement(SwapPicker, { dex, currentDex: 1, onPick: noop, onClose: noop }))
    expect(cells(html)).toHaveLength(PICKER_PAGE)
    expect(labelOf(cells(html)[0])).toBe(label(dex.mons[uidOf(100)]))
    expect(html).not.toContain('파티')
    expect(html).not.toContain('조력자')

    const all = dexState()
    all.assign = Object.fromEntries(all.box.map((u, i) => [`s${i}`, u]))
    const none = renderToStaticMarkup(React.createElement(SwapPicker, { dex: all, currentDex: 1, onPick: noop, onClose: noop }))
    expect(none).toContain('쉬고 있는 포켓몬이 없어요')
    expect(cells(none)).toHaveLength(0)
    expect(none).not.toContain('더 보기')
  })
})

describe('pickerList: search by the shown name or the dex number', () => {
  it('finds a number exactly', () => {
    const got = pickerList(dexState(), ' 25 ')
    expect(got.map(m => m.dex)).toEqual([25])
  })

  it('no query: every resting Pokémon, recent first', () => {
    const got = pickerList(dexState(), '')
    expect(got).toHaveLength(297)
    expect(got.slice(0, 3).map(m => m.dex)).toEqual([100, 200, 50])
  })

  it('matches the name in the shown language (en)', () => {
    vi.stubGlobal('navigator', { language: 'en-US' })
    const dex = dexState()
    expect(pickerList(dex, 'PIKA').map(m => m.dex)).toEqual([25])
    expect(pickerList(dex, '피카')).toEqual([])
  })

  it('matches the Korean name in Korean', () => {
    vi.stubGlobal('navigator', { language: 'ko-KR' })
    expect(pickerList(dexState(), '피카').map(m => m.dex)).toContain(25)
  })
})

describe('source: no party in the pickers', () => {
  it('has no dex.party, partyOut or helper prop', () => {
    const src = code(readFileSync(join(ROOT, 'src/components/PartyPickers.tsx'), 'utf8'))
    expect(src).not.toMatch(/dex\.party/)
    expect(src).not.toMatch(/partyOut/)
    expect(src).not.toMatch(/\bhelper\??\s*:/)
    expect(src).not.toMatch(/\bhelper\s*=/)
  })
})
