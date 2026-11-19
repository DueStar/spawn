/**
 * The answer surface: the keys a card hears (only inside it, never an answer by
 * a key of its own: a click, or Enter / Space on its focused button), what a card shows of a command
 * (control and direction characters made visible), the guard against a click that was aimed at
 * something else, and the source rules: no global key, no focus taken, outside the virtual list,
 * calm colours, every string in ko, en and ja and none of the game's words.
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { cardKey } from '../src/chat/composerKeys'
import { ARM_MS, clickAccepted, visibleText } from '../src/chat/answer'
import DICTS from '../src/locales'
import { GAME_WORDS } from './helpers'

const ROOT = join(__dirname, '..')
const read = (p: string) => readFileSync(p, 'utf8')
const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/[^\n]*/g, '$1')
const CARDS = ['AnswerSurface.tsx', 'PermissionCard.tsx', 'QuestionCard.tsx', 'PlanCard.tsx'].map(f => join(ROOT, 'src', 'components', 'chat', f))
const key = (k: string, over: Record<string, unknown> = {}) => ({ key: k, shiftKey: false, ctrlKey: false, metaKey: false, altKey: false, ...over })

describe('cardKey: moving between a card\'s buttons, never answering', () => {
  it('arrows move; digits, Enter, Space and letters do nothing here (Enter / Space are the focused button\'s own)', () => {
    expect(cardKey(key('ArrowRight'), false)).toBe('next')
    expect(cardKey(key('ArrowDown'), false)).toBe('next')
    expect(cardKey(key('ArrowLeft'), false)).toBe('prev')
    expect(cardKey(key('ArrowUp'), false)).toBe('prev')
    for (const k of ['1', '2', '3', '4', 'Enter', ' ', 'y', 'n', 'Escape', 'Tab']) expect(cardKey(key(k), false), k).toBeNull()
    expect(cardKey(key('ArrowRight', { shiftKey: true }), false)).toBeNull()
  })

  it('while an IME composes: nothing', () => {
    expect(cardKey(key('ArrowRight'), true)).toBeNull()
    expect(cardKey(key('ArrowRight', { isComposing: true }), false)).toBeNull()
    expect(cardKey(key('ArrowRight', { keyCode: 229 }), false)).toBeNull()
  })
})

describe('visibleText: what a command holds, shown as it is', () => {
  it('plain text, newlines and tabs as they are', () => {
    expect(visibleText('npm run build')).toEqual([{ text: 'npm run build' }])
    expect(visibleText('a\n\tb')).toEqual([{ text: 'a\n\tb' }])
    expect(visibleText('강 세 개 🌊')).toEqual([{ text: '강 세 개 🌊' }])
  })

  it('control, direction and invisible characters become visible marks', () => {
    expect(visibleText('rm x\u202etxt.exe')).toEqual([{ text: 'rm x' }, { text: '[U+202E]', mark: true }, { text: 'txt.exe' }])
    expect(visibleText('a\u001b[2Jb')).toEqual([{ text: 'a' }, { text: '[U+001B]', mark: true }, { text: '[2Jb' }])
    expect(visibleText('a\rb').map(s => s.text).join('')).toBe('a[U+000D]b')
    for (const c of ['\u0000', '\u0007', '\u007f', '\u0085', '\u200b', '\u200e', '\u200f', '\u2066', '\u2069', '\u061c', '\ufeff', '\u2028', '\u2029', '\u2060']) {
      const out = visibleText(`x${c}y`)
      expect(out.some(s => s.mark), `U+${c.charCodeAt(0).toString(16)}`).toBe(true)
      expect(out.map(s => s.text).join('')).not.toContain(c)
    }
  })
})

describe('a click must be aimed at the card', () => {
  it('a pointer press that began before the card had been shown a moment is not an answer; a key on the focused button is', () => {
    expect(clickAccepted({ detail: 1, downAt: 1000 + ARM_MS - 1, shownAt: 1000 })).toBe(false)
    expect(clickAccepted({ detail: 1, downAt: null, shownAt: 1000 })).toBe(false)
    expect(clickAccepted({ detail: 1, downAt: 1000 + ARM_MS, shownAt: 1000 })).toBe(true)
    expect(clickAccepted({ detail: 0, downAt: null, shownAt: 1000 })).toBe(true)
    expect(ARM_MS).toBeGreaterThanOrEqual(300)
  })
})

describe('the cards\' sources', () => {
  it('exist', () => { for (const f of CARDS) expect(existsSync(f), f).toBe(true) })

  it('no window or document key listener, no autoFocus, no .focus() but the arrows\' own move; cardKey only in a card\'s own onKeyDown', () => {
    for (const f of CARDS) {
      const src = code(read(f))
      expect(src, f).not.toMatch(/(window|document)\.addEventListener\(\s*['"]key/)
      expect(src, f).not.toMatch(/autoFocus/)
      // the one focus move: an arrow pressed on one of the card's buttons, to its next button
      for (const m of src.matchAll(/\.focus\(/g)) {
        expect(f.endsWith('AnswerSurface.tsx'), f).toBe(true)
        expect(src.slice(Math.max(0, m.index! - 700), m.index!), f).toMatch(/onKeyDown[\s\S]*cardKey\(/)
      }
    }
    const users = [...CARDS, join(ROOT, 'src', 'components', 'ChatView.tsx'), join(ROOT, 'src', 'components', 'chat', 'Composer.tsx')].filter(f => /cardKey\(/.test(code(read(f))))
    expect(users.map(f => f.split(/[\\/]/).pop())).toEqual(['AnswerSurface.tsx'])
    const surface = code(read(CARDS[0]))
    for (const m of surface.matchAll(/cardKey\(/g)) expect(surface.slice(Math.max(0, m.index! - 300), m.index!)).toMatch(/onKeyDown/)
  })

  it('the page sends a choice only: no answer body, no behavior, no settings', () => {
    for (const f of CARDS) {
      const src = code(read(f))
      expect(src, f).not.toMatch(/hookSpecificOutput|permissionDecision|updatedPermissions|behavior|destination|localSettings/)
    }
  })

  it('the surface sits outside the virtual list, between it and the composer', () => {
    const view = code(read(join(ROOT, 'src', 'components', 'ChatView.tsx')))
    const list = view.indexOf('<ChatList')
    const surface = view.indexOf('<AnswerSurface')
    const footer = view.indexOf('{footer}')
    expect(list).toBeGreaterThan(0)
    expect(surface).toBeGreaterThan(list)
    expect(footer).toBeGreaterThan(surface)
    // the list's element closes before the surface starts
    expect(view.slice(list, surface)).toMatch(/\/>\s*\)\}/)
  })

  it('calm: no yellow on a card, 거부 not red-filled, 허용 the ink button, weights 400 / 500, no animation', () => {
    const css = read(join(ROOT, 'src', 'styles', 'chat.css')).replace(/\/\*[\s\S]*?\*\//g, '')
    const rules = [...css.matchAll(/([^{}]+)\{([^}]*)\}/g)].map(m => ({ sel: m[1].trim(), body: m[2] }))
    const card = rules.filter(r => /\.chat-card|\.chat-answer/.test(r.sel))
    expect(card.length).toBeGreaterThan(5)
    for (const r of card) {
      expect(r.body, r.sel).not.toMatch(/--accent(?!-ink)|--yellow|--red(?!-text)|animation/)
      for (const m of r.body.matchAll(/font-weight\s*:\s*([^;]+)/g)) expect(m[1].trim(), r.sel).toMatch(/^(400|500|var\(--w-(body|name|strong|mono)\))$/)
    }
    expect(card.some(r => /\.chat-card\.ask::before/.test(r.sel) && /--amber/.test(r.body))).toBe(true)
    const src = read(CARDS[1])
    expect(src).toMatch(/className="chat-btn solid chat-card-btn"[^\n]*>\{t\('허용'\)\}/)
    for (const line of src.split('\n').filter(l => /\{t\('(거부|항상 허용)'\)\}/.test(l))) expect(line).not.toMatch(/solid/)
  })

  it('every string in ko, en and ja; none of the game\'s words', () => {
    const keys = new Set<string>()
    for (const f of CARDS) {
      const src = code(read(f))
      for (const m of src.matchAll(/\bt\(\s*'([^']*[가-힣][^']*)'/g)) keys.add(m[1])
      for (const m of src.matchAll(/:\s*'([^']*[가-힣][^']*)'/g)) keys.add(m[1])
    }
    expect(keys.size).toBeGreaterThan(15)
    for (const k of keys) {
      expect(DICTS.en[k] ?? null, `en: ${k}`).not.toBeNull()
      expect(DICTS.ja[k] ?? null, `ja: ${k}`).not.toBeNull()
      expect(GAME_WORDS.test(k), k).toBe(false)
      expect(GAME_WORDS.test(DICTS.en[k] ?? ''), k).toBe(false)
      expect(GAME_WORDS.test(DICTS.ja[k] ?? ''), k).toBe(false)
    }
  })
})
