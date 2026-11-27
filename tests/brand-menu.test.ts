/**
 * The logo's menu (2026-11-27): the ball opens 패치노트 · 설정 (in the panel's header and on the folded rail), and
 * the gear goes — except in 업무 모드, where no ball is drawn and the gear stays the way to 설정.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

vi.mock('../src/i18n', async (orig) => ({
  ...(await orig<typeof import('../src/i18n')>()),
  t: (k: string, v?: Record<string, unknown>) => k.replace(/\{(\w+)\}/g, (_, n) => String(v?.[n] ?? '')),
}))

const ROOT = join(__dirname, '..')
const read = (...p: string[]) => readFileSync(join(ROOT, ...p), 'utf8')
const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/[^\n]*/g, '$1')

describe('BrandMenu', () => {
  it('closed: one button that says it opens a menu', async () => {
    const { BrandMenu } = await import('../src/components/BrandMenu')
    const html = renderToStaticMarkup(React.createElement(BrandMenu, { className: 'w-brand', title: 'spawn 1.10.17', onNotes: () => {}, onSettings: () => {} }, 'ball'))
    expect(html).toMatch(/<button[^>]*class="w-brand"[^>]*aria-haspopup="menu"[^>]*aria-expanded="false"/)
    expect(html).not.toMatch(/role="menu"/)
  })
  it('open: 패치노트 then 설정, as menu items', async () => {
    const { BrandMenu } = await import('../src/components/BrandMenu')
    const html = renderToStaticMarkup(React.createElement(BrandMenu, { className: 'w-brand', title: 'x', onNotes: () => {}, onSettings: () => {}, initialOpen: true }, 'ball'))
    expect(html).toMatch(/role="menu"/)
    const items = [...html.matchAll(/role="menuitem"[^>]*>(?:<[^>]*>)*([^<]+)/g)].map(m => m[1])
    expect(items).toEqual(['패치노트', '설정'])
  })
  it('keyboard and closing as the text-size menu: menuKeyIndex, Esc, Tab, a press outside', () => {
    const src = code(read('src', 'components', 'BrandMenu.tsx'))
    expect(src).toMatch(/menuKeyIndex\(/)
    expect(src).toMatch(/'Escape'/)
    expect(src).toMatch(/'Tab'/)
    expect(src).toMatch(/addEventListener\('pointerdown'/)
  })
})

describe('Widget: the ball opens the menu; the gear only in 업무 모드', () => {
  const w = code(read('src', 'Widget.tsx'))
  it('both balls (header and rail) are a BrandMenu', () => {
    expect((w.match(/<BrandMenu\b/g) ?? []).length).toBe(2)
    expect(w).not.toMatch(/className="w-brand" onClick=\{\(\) => setNotesOpen\(true\)\}/)
    expect(w).not.toMatch(/className="w-rail-btn w-rail-brand" onClick=\{\(\) => setNotesOpen\(true\)\}/)
  })
  it('every gear button is drawn only in 업무 모드', () => {
    const gears = [...w.matchAll(/([^\n]*)<GearIcon/g)].map(m => m[1])
    expect(gears.length).toBe(2)
    for (const line of gears) expect(line).toMatch(/workMode && <button/)
  })
})
