/**
 * src/textSize.ts — one text-size step (a percent, 80–130%) for the whole app (the UI's type scale and the
 * terminal's font size together): the step tables, stepping, and the migration from the
 * old terminal-only size (spawn-term-font, 10–24px) to the nearest step, ties going larger.
 * And src/termFont.ts keeps the names TerminalPanel.tsx imports (a source check).
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { DEFAULT_STEP, nextStep, OLD_TERM_KEY, readInitialStep, stepFromTermPx, TERM_PX, TEXT_KEY, textStepLabel, TEXT_STEPS, UI_PX } from '../src/textSize'

const ROOT = join(__dirname, '..')
const src = (p: string) => readFileSync(join(ROOT, p), 'utf8')

// (2026-11-17: the steps are percents of 100%, 80–130 by 10; 작게 / 보통 / 크게 / 아주 크게 until then)
describe('the steps', () => {
  it('six percents, their labels and sizes', () => {
    expect([...TEXT_STEPS]).toEqual(['80', '90', '100', '110', '120', '130'])
    expect(DEFAULT_STEP).toBe('100')
    expect(TEXT_STEPS.map(textStepLabel)).toEqual(['80%', '90%', '100%', '110%', '120%', '130%'])
    expect(UI_PX).toEqual({ 80: 10, 90: 11, 100: 12, 110: 13, 120: 14, 130: 16 })
    expect(TERM_PX).toEqual({ 80: 10, 90: 12, 100: 13, 110: 14, 120: 16, 130: 17 })
    expect([TEXT_KEY, OLD_TERM_KEY]).toEqual(['spawn-text-size', 'spawn-term-font'])
  })
})

describe('stepFromTermPx: an old terminal size to the nearest step, a tie to the larger', () => {
  it.each([
    [10, '80'], [11, '90'], [12, '90'], [13, '100'], [14, '110'], [15, '120'],
    [16, '120'], [17, '130'], [20, '130'], [24, '130'],
  ] as const)('%ipx → %s%%', (px, step) => {
    expect(stepFromTermPx(px)).toBe(step)
  })
})

describe('nextStep', () => {
  it('10% up or down, held at both ends', () => {
    expect(nextStep('80', -1)).toBe('80')
    expect(nextStep('80', 1)).toBe('90')
    expect(nextStep('100', 1)).toBe('110')
    expect(nextStep('100', -1)).toBe('90')
    expect(nextStep('130', 1)).toBe('130')
    expect(nextStep('130', -1)).toBe('120')
  })
})

describe('readInitialStep', () => {
  const store = (o: Record<string, string>) => ({ getItem: (k: string) => (k in o ? o[k] : null) })

  it('nothing stored: 100%', () => {
    expect(readInitialStep(null)).toBe('100')
    expect(readInitialStep(undefined)).toBe('100')
    expect(readInitialStep(store({}))).toBe('100')
  })

  it('a step stored by its old name moves to its percent', () => {
    expect(['small', 'normal', 'large', 'xlarge'].map(v => readInitialStep(store({ 'spawn-text-size': v })))).toEqual(['90', '100', '110', '120'])
  })

  it('the old terminal size carries over to its nearest step', () => {
    expect(readInitialStep(store({ 'spawn-term-font': '15' }))).toBe('120')
    expect(readInitialStep(store({ 'spawn-term-font': '14' }))).toBe('110')
    expect(readInitialStep(store({ 'spawn-term-font': '20' }))).toBe('130')
    expect(readInitialStep(store({ 'spawn-term-font': '10' }))).toBe('80')
  })

  it('a step the user picked wins over the old size (never migrated again)', () => {
    expect(readInitialStep(store({ 'spawn-term-font': '15', 'spawn-text-size': '90' }))).toBe('90')
    expect(readInitialStep(store({ 'spawn-term-font': '24', 'spawn-text-size': '100' }))).toBe('100')
  })

  it('garbage or out of range: 100%', () => {
    expect(readInitialStep(store({ 'spawn-term-font': 'abc' }))).toBe('100')
    expect(readInitialStep(store({ 'spawn-term-font': '99' }))).toBe('100')
    expect(readInitialStep(store({ 'spawn-term-font': '9' }))).toBe('100')
    expect(readInitialStep(store({ 'spawn-term-font': '' }))).toBe('100')
    expect(readInitialStep(store({ 'spawn-text-size': 'huge' }))).toBe('100')
    expect(readInitialStep(store({ 'spawn-text-size': '105' }))).toBe('100')
  })

  it('an unknown step falls back to the old size', () => {
    expect(readInitialStep(store({ 'spawn-text-size': 'huge', 'spawn-term-font': '17' }))).toBe('130')
  })

  it('it only reads', () => {
    const writes: string[] = []
    const s = { getItem: (k: string) => (k === 'spawn-term-font' ? '15' : null), setItem: (k: string) => { writes.push(k) }, removeItem: (k: string) => { writes.push(k) } }
    readInitialStep(s)
    expect(writes).toEqual([])
  })

  it('a storage that throws: 100%', () => {
    expect(readInitialStep({ getItem: () => { throw new Error('denied') } })).toBe('100')
  })
})

describe('the terminal follows the step (source checks)', () => {
  it('TerminalPanel.tsx still imports exactly the same names from termFont', () => {
    const m = /import \{([^}]*)\} from '\.\.\/termFont'/.exec(src('src/components/TerminalPanel.tsx'))
    expect(m).not.toBeNull()
    expect(m![1].split(',').map(s => s.trim()).filter(Boolean).sort()).toEqual(['getTermFont', 'resetTermFont', 'stepTermFont', 'subscribeTermFont', 'termFontStack'])
  })

  it('termFont.ts sizes come from the step: no presets, no setter, no size state of its own', () => {
    const tf = src('src/termFont.ts')
    expect(tf).not.toMatch(/FONT_PRESETS|\bsetTermFont\b|spawn-term-font/)
    expect(tf).toMatch(/TERM_PX\[getTextStep\(\)\]/)
  })

  it('no unused hook is left (useTermFont had no caller: final review M6)', () => {
    expect(src('src/termFont.ts')).not.toMatch(/useTermFont|useSyncExternalStore/)
  })
})

describe('the text-size control (source checks)', () => {
  it('the header has − 가 + in place of the Aa trio', () => {
    const w = src('src/Widget.tsx')
    // (folded to one 가 button when the bar is narrow: the bar's level 2)
    expect(w).toMatch(/<TextSizeControl compact=\{barLevel >= 2\} \/>/)
    expect(w).not.toMatch(/w-font-switch/)
    expect(w).not.toMatch(/Aa<\/button>/)
    for (const css of ['src/styles/pokedex.css', 'src/styles/widget-expanded.css']) expect(src(css)).not.toMatch(/w-font-switch/)
  })

  it('설정 › 앱 has a 글자 크기 row', () => {
    expect(src('src/components/SettingsView.tsx')).toContain("t('글자 크기')")
  })

  it('the words in English and Japanese; the trio\'s words are gone', async () => {
    const { default: WIDGET } = await import('../src/locales/widget')
    for (const lang of ['en', 'ja'] as const) {
      for (const k of ['글자 크기', '글자 작게', '글자 크게', '글자 크기 ({mod}+= / {mod}+-)']) expect(WIDGET[lang][k], `${lang} ${k}`).toBeTruthy()
      for (const k of ['소', '중', '대', '글자 {size}', '글자 크기 {size}']) expect(WIDGET[lang][k], `${lang} ${k}`).toBeUndefined()
    }
  })

  // (2026-11-17: the steps are shown as percents, the same in every language; no step names to translate)
  it('the control and 설정 show the step as its percent, never a name', () => {
    for (const f of ['src/components/TextSizeControl.tsx', 'src/components/SettingsView.tsx']) {
      expect(src(f), f).toContain('textStepLabel(')
      expect(src(f), f).not.toMatch(/TEXT_STEP_LABEL|TEXT_STEP_SENSE/)
    }
    expect(src('src/components/TextSizeControl.tsx')).not.toMatch(/>가</)
  })

  it('the menu works from the keyboard: it opens on the checked step, arrows / Home / End move, Esc and Tab close it (final review M7)', async () => {
    const { menuKeyIndex } = await import('../src/menuKeys')
    expect(menuKeyIndex('ArrowDown', 0, 4)).toBe(1)
    expect(menuKeyIndex('ArrowDown', 3, 4)).toBe(0)
    expect(menuKeyIndex('ArrowUp', 0, 4)).toBe(3)
    expect(menuKeyIndex('ArrowUp', 2, 4)).toBe(1)
    expect(menuKeyIndex('ArrowDown', -1, 4)).toBe(0)
    expect(menuKeyIndex('ArrowUp', -1, 4)).toBe(3)
    expect(menuKeyIndex('Home', 2, 4)).toBe(0)
    expect(menuKeyIndex('End', 1, 4)).toBe(3)
    expect(menuKeyIndex('Enter', 1, 4)).toBeNull()
    expect(menuKeyIndex('ArrowDown', 0, 0)).toBeNull()
    const c = src('src/components/TextSizeControl.tsx')
    expect(c).toContain('role="menu"')
    expect(c).toContain("box.current?.querySelector<HTMLElement>('.w-textsize-item.on')?.focus()")
    expect(c).toContain('menuKeyIndex(e.key, at, items.length)')
    expect(c).toMatch(/if \(e\.key === 'Tab'\) \{ setOpen\(false\); cur\.current\?\.focus\(\); return \}/)
    expect(c).toMatch(/e\.key === 'Escape'[\s\S]{0,120}cur\.current\?\.focus\(\)/)
  })
})
