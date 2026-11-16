/**
 * 박스 without the party: one grid, no party strip, no exchange, no party words; a working Pokémon shows no
 * release button and every other one does. 랭킹's partner choices come from the most recently worked.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import BoxView, { BoxActions } from '../src/components/BoxView'
import { dispatchPokedex, type DexState, type Mon } from '../src/pokedexStore'

const ROOT = join(__dirname, '..')
const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/[^\n]*/g, '$1')

const mon = (uid: string, dex: number, extra: Partial<Mon> = {}): Mon =>
  ({ uid, dex, shiny: false, at: 1, steps: 0, how: 'wild', ...extra } as Mon)

function feed() {
  const mons = { a: mon('a', 25), b: mon('b', 1), c: mon('c', 4, { shiny: true }) }
  const state = {
    caught: {}, seen: {}, trainer: { starter: 1, since: 1 },
    mons, box: ['a', 'b', 'c'], party: [], assign: { s1: 'a' }, helpers: {}, boxLimit: 1200,
  } as unknown as DexState
  dispatchPokedex({ type: 'pokedex', state })
}

describe('BoxView: one box', () => {
  it('draws the toolbar and one grid with every Pokémon, and no party', () => {
    feed()
    const html = renderToStaticMarkup(React.createElement(BoxView))
    expect(html).not.toContain('box-party')
    expect(html).not.toContain('파티')
    expect(html).toContain('box-toolbar')
    expect((html.match(/class="box-cell /g) ?? []).length).toBe(3)
    // every cell can be dragged within the box
    expect((html.match(/draggable="true"/g) ?? []).length).toBe(3)
    expect(html).toContain('끌어서 박스 안에서 옮기기')
  })

  it('a working Pokémon shows no release button; a resting one does', () => {
    const working = renderToStaticMarkup(React.createElement(BoxActions, { working: true, releasing: false, onRelease() {}, onCancel() {} }))
    expect(working).not.toContain('놓아주기')
    const resting = renderToStaticMarkup(React.createElement(BoxActions, { working: false, releasing: false, onRelease() {}, onCancel() {} }))
    expect(resting).toContain('놓아주기')
    expect(resting).not.toContain('정말 놓아주기')
    const confirm = renderToStaticMarkup(React.createElement(BoxActions, { working: false, releasing: true, onRelease() {}, onCancel() {} }))
    expect(confirm).toContain('정말 놓아주기')
  })

  it('BoxView has no exchange, no resting prop and no party choice', () => {
    const src = code(readFileSync(join(ROOT, 'src/components/BoxView.tsx'), 'utf8'))
    expect(src).not.toMatch(/exchange/)
    expect(src).not.toMatch(/resting/)
    expect(src).not.toMatch(/box-choose|choosing/)
    expect(src).not.toMatch(/\bparty\b/i)
    expect(src).toContain("t('박스')")
  })
})

describe('PokedexView: owned rows in the box', () => {
  it('offers release when not working and names the box, with the new 박스 hint', () => {
    const src = code(readFileSync(join(ROOT, 'src/components/PokedexView.tsx'), 'utf8'))
    expect(src).not.toContain('([] as string[])')
    expect(src).toContain("hint={t('꽉 차면 새로 잡은 개체는 박사님께 가요')}")
    expect(src).toMatch(/\{!busy\.has\(m\.uid\) && \(/)
    // sub-agent helpers count as busy too, as in BoxView
    expect(src).toMatch(/const busy = new Set\(\[\.\.\.Object\.values\(state\?\.assign \?\? \{\}\), \.\.\.Object\.values\(state\?\.helpers \?\? \{\}\)\.flat\(\)\]\)/)
    expect(src).toMatch(/dex-owned-sub">\s*\{t\('박스'\)\}/)
  })
})

describe('LeaderboardView: partners from recent work', () => {
  it('uses recentPartnerDex with the chosen partner, and no party', () => {
    const src = code(readFileSync(join(ROOT, 'src/components/LeaderboardView.tsx'), 'utf8'))
    expect(src).toContain('recentPartnerDex(')
    expect(src).toMatch(/recentPartnerDex\(\s*state[^,]*,\s*profile\?\.partner \?\? null\s*\)/)
    expect(src).not.toContain('state?.party')
    expect(src).not.toMatch(/partyDex/)
  })
})
