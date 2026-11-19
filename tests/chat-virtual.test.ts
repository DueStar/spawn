/**
 * The chat view's list and look: the virtual list's arithmetic (src/chat/virtual.ts),
 * who speaks in each mode (src/chat/lensMode.ts chatWho), and what src/styles/chat.css
 * may use (차분하게 2: literal font stacks, no yellow, weights 380–600 with 600 only on
 * markdown headings, the token radii, no animation, the text steps' sizes only).
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { atBottom, prependAnchor, visibleRange } from '../src/chat/virtual'
import { chatWho } from '../src/chat/lensMode'
import { GAME_WORDS } from './helpers'

const ROOT = join(__dirname, '..')

describe('visibleRange', () => {
  it('1000 rows of 40px, scrolled to 20 000 in an 800px view: rows 485–535 with their padding', () => {
    const heights = Array(1000).fill(40)
    const r = visibleRange({ heights, estimate: 40, scrollTop: 20_000, viewport: 800 })
    expect(r.start).toBe(485)
    expect(r.end).toBe(535)
    expect(r.padTop).toBe(485 * 40)
    expect(r.padBottom).toBe((1000 - 535) * 40)
    expect(r.padTop + (r.end - r.start) * 40 + r.padBottom).toBe(40_000)
  })

  it('an unmeasured row counts as the estimate', () => {
    const heights: (number | undefined)[] = Array(100).fill(undefined)
    heights[0] = 400
    const r = visibleRange({ heights, estimate: 50, scrollTop: 0, viewport: 300, overscan: 0 })
    expect(r.start).toBe(0)
    expect(r.end).toBe(1) // the first row alone fills the view
    expect(r.padBottom).toBe(99 * 50)
  })

  it('at the top and at the bottom; an empty list', () => {
    const heights = Array(50).fill(20)
    expect(visibleRange({ heights, estimate: 20, scrollTop: 0, viewport: 100, overscan: 0 })).toMatchObject({ start: 0, end: 5, padTop: 0 })
    expect(visibleRange({ heights, estimate: 20, scrollTop: 900, viewport: 100, overscan: 0 })).toMatchObject({ start: 45, end: 50, padBottom: 0 })
    expect(visibleRange({ heights: [], estimate: 20, scrollTop: 0, viewport: 100 })).toEqual({ start: 0, end: 0, padTop: 0, padBottom: 0 })
  })

  it('never renders more than the view and its overscan hold', () => {
    const heights = Array(4000).fill(30)
    const r = visibleRange({ heights, estimate: 30, scrollTop: 60_000, viewport: 900 })
    expect(r.end - r.start).toBeLessThanOrEqual(Math.ceil((900 + 1200) / 30) + 2)
  })
})

describe('prependAnchor', () => {
  it('rows added above move the scroll by their height, so the first visible row stays put', () => {
    const old = [40, 40, 40]
    const added = [30, 50, 20]
    expect(prependAnchor(old, [...added, ...old], 3)).toBe(100)
    // the anchor is the row that was first in view: its offset in the new list less the old one
    expect(prependAnchor(old, [...added, ...old], 3, 2)).toBe(100)
    expect(prependAnchor(old, old, 0)).toBe(0)
  })
})

describe('atBottom', () => {
  it('within 160px of the end is the bottom', () => {
    expect(atBottom(1000 - 600 - 159, 1000, 600)).toBe(true)
    expect(atBottom(1000 - 600 - 161, 1000, 600)).toBe(false)
    expect(atBottom(0, 300, 600)).toBe(true) // shorter than the view
  })
})

describe('chatWho', () => {
  const row = { name: '모래두지', sprite: '/sprites/pokemon/27.png' }
  it('outside 업무 모드: the session\'s Pokémon and its name', () => {
    expect(chatWho(row, false)).toEqual({ picture: 'pokemon', sprite: '/sprites/pokemon/27.png', name: '모래두지' })
  })
  it('in 업무 모드: a glyph and 에이전트, nothing of the game', () => {
    const who = chatWho(row, true)
    expect(who.picture).toBe('glyph')
    expect(who.sprite).toBeUndefined()
    expect(JSON.stringify(who)).not.toMatch(GAME_WORDS)
    expect(JSON.stringify(who)).not.toContain('모래두지')
    expect(JSON.stringify(who)).not.toContain('pokemon')
  })
})

describe('chat.css, what the calm look allows', () => {
  const css = readFileSync(join(ROOT, 'src', 'styles', 'chat.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
  const rules = [...css.matchAll(/([^{}]+)\{([^}]*)\}/g)].map(m => ({ sel: m[1].trim(), body: m[2] }))
  const vals = (body: string, prop: string) => [...body.matchAll(new RegExp(String.raw`(?:^|[;\s])${prop}\s*:\s*([^;]+)`, 'g'))].map(m => m[1].trim())

  it('is only imported by ChatView (off: none of it loads)', () => {
    const imports = (f: string) => readFileSync(join(ROOT, 'src', f), 'utf8').includes("styles/chat.css'")
    expect(imports('components/ChatView.tsx')).toBe(true)
    for (const f of ['Widget.tsx', 'QaPage.tsx', 'main.tsx', 'Toast.tsx']) expect(imports(f), f).toBe(false)
  })

  it('font stacks are literal (no var() in font-family)', () => {
    for (const r of rules) for (const v of vals(r.body, 'font-family')) expect(v, r.sel).not.toMatch(/var\(/)
  })

  it('yellow only on the composer\'s send button; nothing else is yellow', () => {
    expect(css.toLowerCase()).not.toContain('#f2c94c')
    const yellow = rules.filter(r => /var\(--accent\)|var\(--accent-hover\)/.test(r.body))
    expect(yellow.map(r => r.sel)).toEqual(['.chat-send', '.chat-send:hover'])
  })

  it('weights 380 / 400 / 500 / 600 (or the mono token); 600 only on the markdown headings', () => {
    let seen = 0
    for (const r of rules) {
      for (const w of vals(r.body, 'font-weight')) {
        seen++
        expect(['380', '400', '500', '600', 'var(--w-mono)', 'var(--w-name)', 'inherit'].includes(w), `${r.sel}: ${w}`).toBe(true)
        if (w === '600') for (const p of r.sel.split(',')) expect(p.trim(), r.sel).toMatch(/^\.chat-prose h[1-4]$/)
      }
    }
    expect(seen).toBeGreaterThan(5)
  })

  it('radii from the tokens only (or 0, 50 %)', () => {
    for (const r of rules) for (const v of vals(r.body, 'border-radius')) expect(v, r.sel).toMatch(/^(var\(--r-(xs|s|m|l)\)|0|50%)$/)
  })

  it('nothing animates', () => {
    expect(css).not.toMatch(/animation|@keyframes|transition/)
  })

  it('every font size is a text-step token (or a calc of one)', () => {
    let seen = 0
    for (const r of rules) {
      for (const v of vals(r.body, 'font-size')) {
        seen++
        expect(v, r.sel).toMatch(/^(var\(--t-(micro|meta|ui|prose|code|head)\)|calc\(var\(--t-(micro|meta|ui|prose|code|head)\) [-+] \d+px\))$/)
      }
    }
    expect(seen).toBeGreaterThan(10)
  })

  it('the reading column is the --read-w token', () => {
    expect(css).toMatch(/max-width:\s*var\(--read-w\)/)
  })
})

describe('the virtual list holds no old render (the soak test: a leak of about 1 MB a turn)', () => {
  it("a row's ref callback is made outside the render (it holds only its key and the two refs), and the map is pruned", async () => {
    const { readFileSync } = await import('node:fs')
    const src = readFileSync(new URL('../src/components/chat/ChatList.tsx', import.meta.url), 'utf8')
    const refFor = src.slice(src.indexOf('const refFor = '), src.indexOf('return fn', src.indexOf('const refFor = ')))
    expect(refFor).toContain('rowRef(key, elements, observer)')
    expect(refFor).not.toMatch(/=>\s*\{[\s\S]*elements\.current/)
    expect(src).toMatch(/^function rowRef\(/m)
    // (pruned with the rows by src/chat/virtual.ts pruneToRows, as the heights are)
    expect(src).toMatch(/pruneToRows\(refs\.current, rows, elements\.current\)/)
  })
})
