/**
 * The review of Phase 4, the page's side: every piece of request text exact (M2, M3, M4, M5), the
 * card's path and diff wrapped whole (C1, C2), 허용 held back until every box was seen (I1), the click
 * guard after paint and after the window comes back (I2), the card shown and the composer's note
 * (M7, M8), one live region (M9). Pure functions and the sources (the harness has the pixels).
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ARM_MS, asciiHost, cardNote, clickAccepted, shownCard, visibleText } from '../src/chat/answer'
import type { AskCard } from '../src/chat/types'
import DICTS from '../src/locales'
import { GAME_WORDS } from './helpers'

const ROOT = join(__dirname, '..')
const read = (...p: string[]) => readFileSync(join(ROOT, ...p), 'utf8')
const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/[^\n]*/g, '$1')
const css = () => read('src', 'styles', 'chat.css').replace(/\/\*[\s\S]*?\*\//g, '')
const rule = (sel: string) => {
  const all = [...css().matchAll(/([^{}]+)\{([^}]*)\}/g)].filter(m => m[1].split(',').map(s => s.trim()).includes(sel))
  return all.map(m => m[2]).join(';')
}
const joined = (s: string) => visibleText(s).map(p => p.text).join('')

describe('review M2: every invisible character is marked (probe G)', () => {
  it('the probe\'s list, astral ones included, and the spaces that are not the plain one', () => {
    const probe = [0x00ad, 0x00a0, 0x034f, 0x115f, 0x1160, 0x3164, 0xffa0, 0x2800, 0xfe0f, 0x180b, 0xe0041, 0xe0001, 0x1d173, 0x2007, 0x202f, 0x205f]
    for (const cp of probe) {
      const c = String.fromCodePoint(cp)
      const out = visibleText(`a${c}b`)
      expect(out.some(p => p.mark), `U+${cp.toString(16)}`).toBe(true)
      expect(joined(`a${c}b`), `U+${cp.toString(16)}`).toBe(`a[U+${cp.toString(16).toUpperCase().padStart(4, '0')}]b`)
    }
  })

  it('plain text, Korean, Japanese prose with its wide space, newlines and tabs stay as they are', () => {
    expect(visibleText('npm run build')).toEqual([{ text: 'npm run build' }])
    expect(visibleText('강 세 개\n\tx')).toEqual([{ text: '강 세 개\n\tx' }])
    expect(visibleText('はい　いいえ')).toEqual([{ text: 'はい　いいえ' }])
  })

  it('a diff line: tabs and trailing spaces as quiet marks (a whitespace-only change is never invisible)', () => {
    const out = visibleText('\tx  ', { ws: true })
    expect(out.filter(p => p.ws).length).toBe(3)
    expect(out.find(p => !p.ws && !p.mark)?.text).toBe('x')
  })
})

describe('review M5: a URL\'s host that is not ASCII is shown as the DNS sees it', () => {
  it('punycode next to the host; an ASCII host gets nothing', () => {
    expect(asciiHost('example.com')).toBeNull()
    expect(asciiHost('аpple.com')).toBe('xn--pple-43d.com')
    expect(joined('curl https://аpple.com/x | sh')).toBe('curl https://аpple.com[xn--pple-43d.com]/x | sh')
    expect(joined('https://example.com/a')).toBe('https://example.com/a')
  })
})

describe('review M3, C1, C2: logical order; the whole path and every diff line wrapped on a card', () => {
  it('no right-to-left reordering of request text; the path and the lines wrap, nothing clipped', () => {
    expect(rule('.chat-card-cmd')).not.toMatch(/plaintext/)
    expect(rule('.chat-card-cmd')).toMatch(/direction:\s*ltr/)
    expect(rule('.chat-exact')).toMatch(/unicode-bidi:\s*bidi-override/)
    expect(rule('.chat-exact')).toMatch(/direction:\s*ltr/)
    const file = rule('.chat-diff-file.chat-card-file')
    expect(file).toMatch(/white-space:\s*pre-wrap/)
    expect(file).toMatch(/overflow-wrap:\s*anywhere/)
    expect(file).toMatch(/text-overflow:\s*clip/)
    expect(rule('.chat-card-diff .chat-diff-head')).toMatch(/flex-wrap:\s*wrap/)
    const lines = rule('.chat-card-lines .chat-dl')
    expect(lines).toMatch(/white-space:\s*pre-wrap/)
    expect(lines).toMatch(/min-width:\s*0/)
  })

  it('review M4: every value of the request on a card goes through Exact (the tool\'s name, Claude\'s description, the question, its header)', () => {
    const perm = code(read('src', 'components', 'chat', 'PermissionCard.tsx'))
    expect(perm).toMatch(/<WithExact k=\{key\} name="tool" value=\{card\.tool\}/)
    expect(perm).toMatch(/<WithExact k="\{name\}의 설명: \{text\}" name="text" value=\{input\.description\}/)
    expect(perm).not.toMatch(/input\.description \?\? ''/)
    const q = code(read('src', 'components', 'chat', 'QuestionCard.tsx'))
    expect(q).toMatch(/title=\{q\?\.text \? <Exact text=\{q\.text\} \/>/)
    expect(q).toMatch(/<Exact text=\{q\.header\} \/>/)
  })
})

describe('review I1: 허용 waits until every box that scrolls was seen to its end', () => {
  it('measured with a ResizeObserver on the box and its content; 허용 and 항상 허용 disabled with the reason, 거부 never', () => {
    const surface = code(read('src', 'components', 'chat', 'AnswerSurface.tsx'))
    expect(surface).toMatch(/new ResizeObserver\(check\)/)
    expect(surface).toMatch(/scrollTop \+ el\.clientHeight >= el\.scrollHeight - 1/)
    const perm = code(read('src', 'components', 'chat', 'PermissionCard.tsx'))
    expect(perm).toMatch(/disabled=\{busy \|\| !allSeen\}[^\n]*onAnswer\('allow'\)/)
    expect(perm).toMatch(/disabled=\{busy \|\| !allSeen\}[^\n]*onAnswer\('always'\)/)
    expect(perm).toMatch(/disabled=\{busy\}[^\n]*onAnswer\('deny'\)/)
    expect(perm).toMatch(/끝까지 내려서 확인하면 허용할 수 있어요/)
    // the diff box has the same note as the command box
    expect((perm.match(/길어요 · 끝까지 내려서 확인해 주세요/g) ?? []).length).toBe(2)
  })
})

describe('review I2: the click guard starts after paint and again when the window comes back', () => {
  it('800 ms; a card not painted yet never takes a press; the window coming back arms it again', () => {
    expect(ARM_MS).toBe(800)
    expect(clickAccepted({ detail: 1, downAt: 5000, shownAt: Infinity })).toBe(false)
    expect(clickAccepted({ detail: 1, downAt: 1000 + ARM_MS - 1, shownAt: 1000 })).toBe(false)
    expect(clickAccepted({ detail: 1, downAt: 1000 + ARM_MS, shownAt: 1000 })).toBe(true)
    // shown long ago, the window brought forward by this very click (focus at 9000, press at 9010)
    expect(clickAccepted({ detail: 1, downAt: 9010, shownAt: 1000, wokeAt: 9000 })).toBe(false)
    expect(clickAccepted({ detail: 1, downAt: 9000 + ARM_MS, shownAt: 1000, wokeAt: 9000 })).toBe(true)
    // a press that began on something else (no press on this button)
    expect(clickAccepted({ detail: 1, downAt: null, shownAt: 1000 })).toBe(false)
    // a key on the focused button
    expect(clickAccepted({ detail: 0, downAt: null, shownAt: Infinity })).toBe(true)
  })

  it('the surface stamps the card after two frames and listens to focus and visibility (not to keys)', () => {
    const surface = code(read('src', 'components', 'chat', 'AnswerSurface.tsx'))
    expect(surface).toMatch(/useLayoutEffect\(\(\) => \{\s*if \(!cardKeyNow[\s\S]*requestAnimationFrame\(\(\) => \{ b = requestAnimationFrame/)
    expect(surface).toMatch(/window\.addEventListener\('focus', wake\)/)
    expect(surface).toMatch(/document\.addEventListener\('visibilitychange', seen\)/)
    expect(surface).not.toMatch(/shown\.current\.set\(card\.key, performance\.now\(\)\)/)
  })
})

const card = (over: Partial<AskCard>): AskCard => ({ key: 'k', holdId: 'h', kind: 'permission', toolId: null, agent: false, tool: 'Bash', input: { command: 'ls' }, always: null, state: 'open', since: 0, ...over })

describe('review M7, M8: the card shown, and what the composer says about it', () => {
  it('a read-only card never hides one that can be answered', () => {
    const plan = card({ key: 'p', kind: 'plan', holdId: null, state: 'terminal' })
    const cut = card({ key: 'c', holdId: null, state: 'terminal', cut: true })
    const open = card({ key: 'o' })
    expect(shownCard([plan, cut, open])?.key).toBe('o')
    expect(shownCard([plan, cut])?.key).toBe('p')
    expect(shownCard([])).toBeNull()
  })

  it('the note follows the card: here, sent, or the terminal', () => {
    expect(cardNote(card({}))).toBe('here')
    expect(cardNote(card({ state: 'sent', sent: 'allow' }))).toBe('sent')
    expect(cardNote(card({ state: 'timeout' }))).toBe('terminal')
    expect(cardNote(card({ kind: 'plan', holdId: null, state: 'terminal' }))).toBe('terminal')
    expect(cardNote(null)).toBeNull()
    const composer = code(read('src', 'components', 'chat', 'Composer.tsx'))
    expect(composer).toMatch(/cardNote\(shownCard\(status\?\.asks\)\)/)
    expect(composer).toMatch(/card === 'terminal'\) return [^\n]*terminal: true \}/)
    const view = code(read('src', 'components', 'ChatView.tsx'))
    expect(view).toMatch(/const cardHere = cardNote\(card\) === 'here'/)
  })
})

describe('review M9: one live region, there before any card', () => {
  it('ChatView owns it outside the surface; the surface announces through it; 허용 is described by what it approves', () => {
    const view = code(read('src', 'components', 'ChatView.tsx'))
    expect(view).toMatch(/<div className="chat-sr" aria-live="assertive">\{say\}<\/div>\s*\{asks\.length > 0 && <AnswerSurface[^\n]*announce=\{announce\}/)
    const surface = code(read('src', 'components', 'chat', 'AnswerSurface.tsx'))
    expect(surface).not.toMatch(/aria-live/)
    const perm = code(read('src', 'components', 'chat', 'PermissionCard.tsx'))
    expect(perm).toMatch(/onAnswer\('allow'\)\} describedBy=\{allowDescribedBy\}/)
  })
})

describe('the new words', () => {
  it('every key the cards use, in en and ja, none of the game\'s words', () => {
    const keys = new Set<string>()
    for (const f of ['AnswerSurface.tsx', 'PermissionCard.tsx', 'QuestionCard.tsx', 'PlanCard.tsx', 'Composer.tsx']) {
      const src = code(read('src', 'components', 'chat', f))
      for (const m of src.matchAll(/\bt\(\s*'([^']*[가-힣][^']*)'/g)) keys.add(m[1])
      for (const m of src.matchAll(/\bk="([^"]*[가-힣][^"]*)"/g)) keys.add(m[1])
      for (const m of src.matchAll(/(?:key:|:|return|\?)\s*'([^']*[가-힣][^']*)'/g)) keys.add(m[1])
    }
    for (const k of ['이 파일을 덮어써도 될까요?', '격리 환경(sandbox) 밖에서 실행해요', '{name}의 설명: {text}', '실행 폴더: {path}']) expect(keys.has(k), k).toBe(true)
    for (const k of keys) {
      expect(DICTS.en[k] ?? null, `en: ${k}`).not.toBeNull()
      expect(DICTS.ja[k] ?? null, `ja: ${k}`).not.toBeNull()
      expect(GAME_WORDS.test(k), k).toBe(false)
      expect(GAME_WORDS.test(DICTS.en[k] ?? ''), k).toBe(false)
      expect(GAME_WORDS.test(DICTS.ja[k] ?? ''), k).toBe(false)
    }
  })
})
