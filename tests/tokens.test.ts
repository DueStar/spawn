/**
 * src/styles/tokens.css — the one place the calm look's design values live
 * (차분하게 2). Pins the values the plan's token table fixes, the contrast floors
 * (body text 4.5:1, secondary and meta text 3:1 on every background it sits on),
 * and that no other stylesheet redefines them.
 */

import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = join(__dirname, '..')
const read = (...p: string[]) => readFileSync(join(ROOT, ...p), 'utf8')
const css = read('src', 'styles', 'tokens.css').replace(/\/\*[\s\S]*?\*\//g, '')

/** `--name: value` pairs of the first block whose selector matches `selector` exactly */
function block(selector: string): Record<string, string> {
  const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const m = css.match(new RegExp(`(?:^|[}\\s])${esc}\\s*{([^}]*)}`))
  if (!m) throw new Error(`no ${selector} block in tokens.css`)
  const out: Record<string, string> = {}
  for (const [, name, value] of m[1].matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) out[name] = value.trim()
  return out
}

const root = block(':root')

/** A token's value with var() references followed */
function resolve(name: string, depth = 0): string {
  const v = root[name]
  if (v === undefined) throw new Error(`${name} is not on :root`)
  const ref = v.match(/^var\((--[\w-]+)\)$/)
  if (ref && depth < 5) return resolve(ref[1], depth + 1)
  return v
}

// WCAG relative luminance and contrast ratio
function rgb(c: string): number[] {
  if (c.startsWith('#')) {
    const n = c.length === 4 ? c.replace(/#(.)(.)(.)/, '#$1$1$2$2$3$3') : c
    return [1, 3, 5].map(i => parseInt(n.substr(i, 2), 16))
  }
  throw new Error(`not an opaque hex colour: ${c}`)
}
const lum = (c: string) =>
  rgb(c)
    .map(v => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4) })
    .reduce((a, v, i) => a + v * [0.2126, 0.7152, 0.0722][i], 0)
function contrast(fg: string, bg: string): number {
  const x = lum(fg), y = lum(bg)
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05)
}

const TYPE = ['--t-micro', '--t-meta', '--t-ui', '--t-name', '--t-prose', '--t-num', '--t-head', '--t-big', '--t-code']
const px = (...n: number[]) => Object.fromEntries(TYPE.map((k, i) => [k, `${n[i]}px`]))

describe('tokens.css', () => {
  it('holds the three greys, the line, the radii and the measures of the table', () => {
    expect(root['--ink']).toBe('#d7dae3')
    expect(root['--ink-2']).toBe('#a4a9b6')
    expect(root['--ink-3']).toBe('#7d8291')
    expect(root['--line']).toBe('rgba(255, 255, 255, 0.07)')
    expect([root['--r-xs'], root['--r-s'], root['--r-m'], root['--r-l']]).toEqual(['3px', '4px', '6px', '8px'])
    expect(root['--side-w']).toBe('300px')
    expect(root['--head-h']).toBe('44px')
  })

  it('usage bars: grey, amber from 80 %, the danger red from 90 %', () => {
    expect(root['--bar']).toBe('var(--ink-3)')
    expect(root['--bar-warn']).toBe('var(--amber)')
    expect(root['--bar-danger']).toBe('var(--danger)')
    expect(resolve('--bar-danger')).toBe('#ff6464')
    expect(root['--bar-h']).toBe('2px')
  })

  // (percents of 100%, each size the 100% one scaled and rounded, never under 9px)
  it('holds the text steps exactly (100% on :root, 80–130% by 10)', () => {
    const pick = (o: Record<string, string>) => Object.fromEntries(TYPE.map(k => [k, o[k]]))
    const base = [10, 11, 12, 12, 13, 12, 14, 15, 12]
    expect(pick(root)).toEqual(px(...base))
    for (const pct of [80, 90, 110, 120, 130]) {
      expect(block(`:root.ts-${pct}`), `${pct}%`).toEqual(px(...base.map(v => Math.max(9, Math.floor(v * pct / 100 + 0.5)))))
    }
  })

  const SURFACES = ['--bg', '--side-bg', '--card', '--card-2', '--mon-bg', '--term-bg']
  it('body text is 4.5:1 and secondary text 3:1 on every surface', () => {
    for (const bg of SURFACES) {
      expect(contrast(resolve('--ink'), resolve(bg)), `--ink on ${bg}`).toBeGreaterThanOrEqual(4.5)
      for (const fg of ['--ink-2', '--ink-3', '--red-text', '--amber', '--green', '--hp']) {
        expect(contrast(resolve(fg), resolve(bg)), `${fg} on ${bg}`).toBeGreaterThanOrEqual(3)
      }
    }
  })

  it('the chat view\'s tokens: the reading column, and diff rows tinted so the text keeps its contrast', () => {
    expect(root['--read-w']).toBe('840px')
    expect(root['--add-bg']).toBe('rgba(116, 214, 139, 0.07)')
    expect(root['--del-bg']).toBe('rgba(255, 100, 100, 0.07)')
    // a tint over the code ground (--term-bg), as the diff block draws it
    const over = (tint: string, bg: string) => {
      const m = tint.match(/^rgba\((\d+),\s*(\d+),\s*(\d+),\s*([\d.]+)\)$/)!
      const [r, g, b, a] = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])]
      const base = rgb(bg)
      return '#' + [r, g, b].map((v, i) => Math.round(v * a + base[i] * (1 - a)).toString(16).padStart(2, '0')).join('')
    }
    const add = over(root['--add-bg'], resolve('--term-bg'))
    const del = over(root['--del-bg'], resolve('--term-bg'))
    expect(contrast(resolve('--ink'), add)).toBeGreaterThanOrEqual(4.5)
    expect(contrast(resolve('--ink-2'), del)).toBeGreaterThanOrEqual(3)
    // the numbers and signs on them too
    for (const fg of ['--ink-3', '--green']) expect(contrast(resolve(fg), add), fg).toBeGreaterThanOrEqual(3)
    for (const fg of ['--ink-3', '--red-text']) expect(contrast(resolve(fg), del), fg).toBeGreaterThanOrEqual(3)
  })

  it('the 변경 사항 panel (on --side-bg): its diff rows keep --ink-2 at 3:1, the selected file reads at 4.5:1', () => {
    const over = (tint: string, bg: string) => {
      const m = tint.match(/^rgba\((\d+),\s*(\d+),\s*(\d+),\s*([\d.]+)\)$/)!
      const [r, g, b, a] = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])]
      const base = rgb(bg)
      return '#' + [r, g, b].map((v, i) => Math.round(v * a + base[i] * (1 - a)).toString(16).padStart(2, '0')).join('')
    }
    const side = resolve('--side-bg')
    for (const tint of ['--add-bg', '--del-bg']) {
      const bg = over(root[tint], side)
      expect(contrast(resolve('--ink-2'), bg), `--ink-2 on ${tint}`).toBeGreaterThanOrEqual(3)
      expect(contrast(resolve('--ink'), bg), `--ink on ${tint}`).toBeGreaterThanOrEqual(4.5)
      expect(contrast(resolve('--ink-3'), bg), `--ink-3 on ${tint}`).toBeGreaterThanOrEqual(3)
    }
    expect(contrast(resolve('--green'), over(root['--add-bg'], side))).toBeGreaterThanOrEqual(3)
    expect(contrast(resolve('--red-text'), over(root['--del-bg'], side))).toBeGreaterThanOrEqual(3)
    // the selected file (and the pressed header button): --ink on the quiet selection grey, never yellow
    const sel = over(root['--sel-bg'], side)
    expect(contrast(resolve('--ink'), sel)).toBeGreaterThanOrEqual(4.5)
    expect(contrast(resolve('--ink-2'), sel)).toBeGreaterThanOrEqual(3)
    expect(contrast(resolve('--ink'), over(root['--sel-bg'], resolve('--bg')))).toBeGreaterThanOrEqual(4.5)
    // the panel's rules: the selection on --sel-bg, no accent anywhere in them
    const css = readFileSync(join(ROOT, 'src', 'styles', 'chat.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
    expect(css).toMatch(/\.chat-ch-tn\[aria-selected="true"\][^{]*\{[^}]*background:\s*var\(--sel-bg\)/)
    for (const m of css.matchAll(/([^{}]*\.chat-ch[^{}]*)\{([^}]*)\}/g)) expect(m[2], m[1]).not.toMatch(/--accent/)
  })

  it('find in the conversation: grey highlights over prose, bubbles, code and diff rows keep the text readable', () => {
    expect(root['--find-bg']).toBe('rgba(255, 255, 255, 0.12)')
    expect(root['--find-now-bg']).toBe('rgba(255, 255, 255, 0.28)')
    const over = (tint: string, bg: string) => {
      const m = tint.match(/^rgba\((\d+),\s*(\d+),\s*(\d+),\s*([\d.]+)\)$/)!
      const [r, g, b, a] = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])]
      const base = rgb(bg)
      return '#' + [r, g, b].map((v, i) => Math.round(v * a + base[i] * (1 - a)).toString(16).padStart(2, '0')).join('')
    }
    const term = resolve('--term-bg')
    // what a match can sit on: the page (prose, tool rows, notices), a user's bubble, a code block, inline code,
    // a diff's added and removed rows, a sub-agent's rows (the same page)
    const grounds: Record<string, string> = {
      page: resolve('--bg'), bubble: resolve('--card-2'), code: term, inline: over('rgba(255, 255, 255, 0.06)', resolve('--bg')),
      added: over(root['--add-bg'], term), removed: over(root['--del-bg'], term),
    }
    for (const [name, ground] of Object.entries(grounds)) {
      // every match: the text keeps its own colour (--ink and --ink-2 at the body's 4.5:1)
      const hit = over(root['--find-bg'], ground)
      for (const fg of ['--ink', '--ink-2']) expect(contrast(resolve(fg), hit), `${fg} on chat-find over ${name}`).toBeGreaterThanOrEqual(4.5)
      // (the quiet grey of a thinking row's text, on the page only: 3:1, as secondary text)
      if (name === 'page') expect(contrast(resolve('--ink-3'), hit), '--ink-3 on chat-find over the page').toBeGreaterThanOrEqual(3)
      // the current one: --ink on the stronger grey
      expect(contrast(resolve('--ink'), over(root['--find-now-bg'], ground)), `--ink on chat-find-now over ${name}`).toBeGreaterThanOrEqual(4.5)
    }
  })

  it('a link preview card: its title 4.5:1, its description and site line 3:1, at rest and hovered; hairline, no fill, no yellow', () => {
    const over = (tint: string, bg: string) => {
      const m = tint.match(/^rgba\((\d+),\s*(\d+),\s*(\d+),\s*([\d.]+)\)$/)!
      const [r, g, b, a] = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])]
      const base = rgb(bg)
      return '#' + [r, g, b].map((v, i) => Math.round(v * a + base[i] * (1 - a)).toString(16).padStart(2, '0')).join('')
    }
    const chat = readFileSync(join(ROOT, 'src', 'styles', 'chat.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
    const rule = (sel: string) => { const m = chat.match(new RegExp(`(?:^|[}\\s])${sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([^}]*)\\}`)); if (!m) throw new Error(`no ${sel}`); return m[1] }
    const hover = rule('.chat-og:hover').match(/background:\s*(rgba\([^)]*\))/)![1]
    for (const ground of [resolve('--bg'), over(hover, resolve('--bg'))]) {
      expect(contrast(resolve('--ink'), ground)).toBeGreaterThanOrEqual(4.5)
      expect(contrast(resolve('--ink-2'), ground)).toBeGreaterThanOrEqual(4.5)
      expect(contrast(resolve('--ink-3'), ground)).toBeGreaterThanOrEqual(3)
    }
    // the parts read those colours
    expect(rule('.chat-og-title')).toMatch(/color:\s*var\(--ink\)/)
    expect(rule('.chat-og-desc')).toMatch(/color:\s*var\(--ink-2\)/)
    expect(rule('.chat-og-site')).toMatch(/color:\s*var\(--ink-3\)/)
    // a hairline box
    expect(rule('.chat-prose a.chat-og')).toMatch(/border:\s*1px solid var\(--line\)/)
    expect(rule('.chat-prose a.chat-og')).toMatch(/max-width:\s*480px/)
    for (const m of chat.matchAll(/([^{}]*\.chat-og[^{}]*)\{([^}]*)\}/g)) expect(m[2], m[1]).not.toMatch(/--accent/)
  })

  it('the turn summary, the thinking rows, the new-version note and the 채팅 보기 help: only the three greys, on surfaces that hold them', () => {
    const chat = readFileSync(join(ROOT, 'src', 'styles', 'chat.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
    const app = readFileSync(join(ROOT, 'src', 'styles', 'widget-expanded.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
    const colours = (css: string, sel: RegExp) => [...css.matchAll(/([^{}]*)\{([^}]*)\}/g)].filter(m => sel.test(m[1])).flatMap(m => [...m[2].matchAll(/(?:^|;)\s*color:\s*var\((--[\w-]+)\)/g)].map(x => x[1]))
    const used = [...colours(chat, /\.chat-(foot|think|note)/), ...colours(app, /\.set-help/)]
    expect(used.length).toBeGreaterThan(5)
    for (const c of used) expect(['--ink', '--ink-2', '--ink-3'], c).toContain(c)
    // the grounds they sit on: the page (the chat), the card (설정's modal)
    for (const bg of ['--bg', '--card']) {
      expect(contrast(resolve('--ink-3'), resolve(bg)), `--ink-3 on ${bg}`).toBeGreaterThanOrEqual(3)
      expect(contrast(resolve('--ink-2'), resolve(bg)), `--ink-2 on ${bg}`).toBeGreaterThanOrEqual(4.5)
    }
  })

  it('every tier colour is 3:1 on the page, the card and the toast', () => {
    const tiers = ['common', 'rare', 'sub', 'legendary', 'mythical']
    for (const tier of tiers) {
      const colour = block(`.tier-${tier}`)['--tier']
      expect(colour, `.tier-${tier}`).toMatch(/^#[0-9a-f]{6}$/i)
      for (const bg of ['--bg', '--card', '--toast-bg']) {
        expect(contrast(colour, resolve(bg)), `.tier-${tier} on ${bg}`).toBeGreaterThanOrEqual(3)
      }
    }
  })

  it('a tier is a coloured dot beside its word, never a filled chip (the dot rule lives here)', () => {
    const dot = css.match(/(?:^|[}\s])\.tdot\s*{([^}]*)}/)
    expect(dot, '.tdot rule in tokens.css').not.toBeNull()
    expect(dot![1]).toMatch(/background:\s*var\(--tier\)/)
    expect(dot![1]).toMatch(/border-radius:\s*50%/)
    const dex = read('src', 'components', 'PokedexView.tsx')
    // Every tier chip: the dot, then the tier's word as text (the word keeps tiers apart without hue)
    const chip = dex.match(/<div className="dex-chips">([\s\S]*?)<\/div>/)
    expect(chip, 'the tier chips').not.toBeNull()
    expect(chip![1]).toMatch(/<i className="tdot" aria-hidden="true" \/>\s*\{TIER_LABEL\[k\]\}/)
    // The detail card's tier: the dot and the word, too
    expect(dex).toMatch(/className=\{`dex-tier tier-[^`]*`\}><i className="tdot" aria-hidden="true" \/>\{TIER_LABEL\[/)
    // 박스's card and 기록's lines name the tier the same way
    for (const f of ['BoxView.tsx', 'TodayLog.tsx']) {
      expect(read('src', 'components', f), f).toMatch(/className=\{`w-toast-tier tier-[^`]*`\}><i className="tdot" aria-hidden="true" \/>\{TIER_LABEL\[/)
    }
  })

  it('no other stylesheet defines the tokens or the tier colours', () => {
    const others = readdirSync(join(ROOT, 'src', 'styles')).filter(f => f.endsWith('.css') && f !== 'tokens.css')
    expect(others.length).toBeGreaterThan(0)
    for (const f of others) {
      const text = read('src', 'styles', f).replace(/\/\*[\s\S]*?\*\//g, '')
      expect(text, `${f} defines --ink`).not.toMatch(/--ink\s*:/)
      expect(text, `${f} defines --card`).not.toMatch(/--card\s*:/)
      expect(text, `${f} defines .tier-common`).not.toMatch(/\.tier-common\s*{/)
    }
  })

  it('each page imports tokens.css before every other stylesheet', () => {
    for (const page of ['Widget.tsx', 'QaPage.tsx', 'Toast.tsx']) {
      const imports = [...read('src', page).matchAll(/^import\s+['"]([^'"]+\.css)['"]/gm)].map(m => m[1])
      expect(imports[0], page).toBe('./styles/tokens.css')
    }
  })
})

describe('the two pages apart from the app (toast window, status card)', () => {
  it('the status card writes in --ink at 500 (its CSP keeps the app CSS out, so the value is inlined)', () => {
    const html = read('electron', 'status-card.html')
    expect(html).toContain('color: #d7dae3')
    expect(html).toContain('font-weight: 500')
    expect(html).not.toContain('#f1f2f5')
    expect(resolve('--ink').toLowerCase()).toBe('#d7dae3')
  })

  it('the catch card: the tier as a dot and its word, the card at the toast radius', () => {
    expect(read('src', 'Toast.tsx')).toMatch(/<span className="w-toast-tier"><i className="tdot" aria-hidden="true" \/>\{TIER_LABEL\[/)
    const toast = read('src', 'styles', 'toast.css').replace(/\/\*[\s\S]*?\*\//g, '')
    const card = toast.match(/\.toast-host \.w-toast\s*{([^}]*)}/)
    expect(card, '.toast-host .w-toast rule').not.toBeNull()
    expect(card![1]).toMatch(/border-radius:\s*var\(--r-toast\)/)
    // no grey literals left: every grey is a token
    for (const lit of ['#9aa0ad', '#a3a8b5', '#c9cdd6', '#fff;', '#fff ', '#d7dae3', '#7d8291']) expect(toast, lit).not.toContain(lit)
  })

  it('the toast page never follows the text step (a fixed-size window: it does not load textSize.ts)', () => {
    expect(read('src', 'Toast.tsx')).not.toMatch(/textSize|termFont|TextSizeControl/)
  })
})

// ---------------------------------------------------------------- the guards (calm style)

/** Every stylesheet but tokens.css, comments stripped */
const SHEETS = readdirSync(join(ROOT, 'src', 'styles'))
  .filter(f => f.endsWith('.css') && f !== 'tokens.css')
  .map(f => ({ file: f, text: read('src', 'styles', f).replace(/\/\*[\s\S]*?\*\//g, '') }))

interface Rule { file: string; sel: string; body: string; at: string | null }
/** The rules of a stylesheet, each with the at-rule it sits in (@media …, @keyframes …) */
function rulesOf(file: string, text: string): Rule[] {
  const out: Rule[] = []
  const at: string[] = []
  let buf = ''
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (ch === '{') {
      const pre = buf.trim()
      buf = ''
      if (pre.startsWith('@')) { at.push(pre); continue }
      const end = text.indexOf('}', i)
      out.push({ file, sel: pre.replace(/\s+/g, ' '), body: text.slice(i + 1, end), at: at[at.length - 1] ?? null })
      i = end
    } else if (ch === '}') { at.pop(); buf = '' } else buf += ch
  }
  return out
}
const RULES = SHEETS.flatMap(s => rulesOf(s.file, s.text)).filter(r => !r.at?.startsWith('@keyframes'))
/** The values a property takes in a rule's body */
const values = (r: Rule, prop: string) => [...r.body.matchAll(new RegExp(String.raw`(?:^|[;\s{])${prop}\s*:\s*([^;]+)`, 'g'))].map(m => m[1].trim())
const parts = (sel: string) => sel.split(',').map(s => s.trim())
const where = (r: Rule) => `${r.file}: ${r.sel}`
/** A selector part names this selector exactly: not as the start of a longer class (.picked, not .picked-x) */
const names = (part: string, sel: string) => new RegExp(`${sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w-])`).test(part)

describe('the guards: what the calm look allows', () => {
  it('(a) no old greys and no --accent-soft left', () => {
    expect(SHEETS.length).toBeGreaterThanOrEqual(6)
    for (const s of SHEETS) {
      for (const bad of ['#f1f2f5', '#6e7381', '--accent-soft']) expect(s.text.toLowerCase(), `${s.file} has ${bad}`).not.toContain(bad)
    }
  })

  // (exact names; .qa- is the QA page's prefix: any class under it)
  const HEADINGS = ['.w-brand', '.set-title', '.set-body h3', '.dex-card-name', '.w-toast-title', '.resume-head', '.w-setup-title', '.w-notes-body h3',
    // the chat view's markdown headings (src/styles/chat.css)
    '.chat-prose h1', '.chat-prose h2', '.chat-prose h3', '.chat-prose h4']
  const isHeading = (p: string) => HEADINGS.some(h => names(p, h)) || /\.qa-[\w-]/.test(p)
  it('(b) weights are 380 / 400 / 500 / 600 or a token; 600 only on the wordmark and headings', () => {
    const seen: string[] = []
    for (const r of RULES) {
      // font-weight, and a weight in the font shorthand: a number first (font: 500 10px/1 …) or a keyword
      const short = values(r, 'font').map(v => v.match(/^(\d{3})\s/)?.[1] ?? v.match(/(?:^|\s)(bold|bolder|lighter)(?=\s)/)?.[1]).filter((w): w is string => !!w)
      const weights = [...values(r, 'font-weight'), ...short]
      for (const w of weights) {
        seen.push(w)
        expect(['380', '400', '500', '600', 'inherit'].includes(w) || /^var\(--w-[\w-]+\)$/.test(w), `${where(r)}: font-weight ${w}`).toBe(true)
        if (w === '600' || w === 'var(--w-head)') {
          for (const p of parts(r.sel)) expect(isHeading(p), `${r.file}: ${p} is not a heading but weighs ${w}`).toBe(true)
        }
      }
    }
    expect(seen.length).toBeGreaterThan(50)
  })

  it('(c) radii only from the tokens, 0 / 1px / 2px and 50 %; 999px in the switch and the toast badges', () => {
    const seen: string[] = []
    for (const r of RULES) {
      // border-radius and its four longhands (border-top-left-radius …)
      for (const v of values(r, 'border(?:-(?:top|bottom)-(?:left|right))?-radius')) {
        seen.push(v)
        const terms = v.replace(/calc\(|\)|[-+*/]\s/g, ' ').split(/\s+/).filter(Boolean)
        for (const term of terms) {
          if (term === '999px') {
            for (const p of parts(r.sel)) expect(names(p, '.set-switch') || /\.w-toast-(new|badge)(?![\w-])/.test(p), `${where(r)}: 999px outside the switch and the toast badges`).toBe(true)
            continue
          }
          expect(['0', '1px', '2px', '50%'].includes(term) || /^var\(--r-[\w-]+$/.test(term) || /^var\(--r-[\w-]+\)$/.test(term), `${where(r)}: border-radius ${v}`).toBe(true)
        }
      }
    }
    expect(seen.length).toBeGreaterThan(50)
  })

  // (each matched exactly: .picked, not .picked-x)
  const YELLOW = ['.w-row.chosen', '.w-rail-session.on', '.picked', '.drop', '.ins-before', '.ins-after', '.w-send', '.chat-send', '.w-update', '.set-switch.on', ':focus-visible']
  // (.w-update: the update button wears the primary colour)
  it('(d) yellow only on the chosen session, the picked cell (and its drop / insert marks), send, the update button and focus rings', () => {
    let uses = 0
    for (const r of RULES) {
      if (!/var\(--accent\)/.test(r.body)) continue
      uses++
      for (const p of parts(r.sel)) expect(YELLOW.some(y => names(p, y)), `${r.file}: ${p} is yellow`).toBe(true)
    }
    expect(uses).toBeGreaterThan(3)
    // the wordmark's hover went neutral (the lockup's own rules are untouched)
    expect(RULES.some(r => r.sel.includes('.w-brand:hover') && /--accent/.test(r.body))).toBe(false)
  })

  it('(e) no working glint or spinner; every animation stops when the system asks for less motion', () => {
    for (const s of SHEETS) {
      expect(s.text, s.file).not.toMatch(/\.w-glint|w-spin/)
    }
    for (const f of ['Widget.tsx', 'QaPage.tsx']) expect(read('src', f), f).not.toMatch(/w-glint|w-spin/)
    const reduced = new Set(RULES.filter(r => r.at?.includes('prefers-reduced-motion') && /animation(?:-name)?\s*:\s*none/.test(r.body)).flatMap(r => parts(r.sel)))
    let animated = 0
    for (const r of RULES) {
      if (r.at?.includes('prefers-reduced-motion')) continue
      // the shorthand and animation-name
      const anim = values(r, 'animation(?:-name)?').filter(v => v !== 'none')
      if (!anim.length) continue
      animated++
      for (const p of parts(r.sel)) expect(reduced.has(p), `${r.file}: ${p} animates (${anim[0]}) with no reduced-motion rule`).toBe(true)
    }
    expect(animated).toBeGreaterThanOrEqual(6)
  })

  it('(f) the chat view\'s one animation: a wild Pokémon met while watching, in chat-game.css, none under reduced motion; chat.css has none', () => {
    const game = SHEETS.find(s => s.file === 'chat-game.css')!
    expect(game, 'chat-game.css').toBeTruthy()
    const rules = rulesOf(game.file, game.text)
    const moving = rules.filter(r => !r.at?.startsWith('@keyframes') && !r.at?.includes('prefers-reduced-motion') && values(r, 'animation(?:-name)?').some(v => v !== 'none'))
    // (the working Pokémon's halo and hop)
    // (the sub-agents at work — a chip comes in, a finished one goes, a running one's dot breathes on the
    // working Pokémon's beat, the panel slides in)
    expect(moving.map(r => r.sel)).toEqual(['.chat-wild.appear .chat-wild-mon', '.chat-status.working .chat-pic.head > *',
      '.chat-agent-chip', '.chat-agent-chip.gone', '.chat-agent-chip:not(.gone):not(.wait) .chat-agent-mark i', '.chat-ag-state.run i', '.chat-ag-panel'])
    // the wild Pokémon's entrance: 0.5 s, once
    expect(values(moving[0], 'animation')[0]).toMatch(/^chat-wild-in \.5s cubic-bezier\(\.2, \.8, \.2, 1\) both$/)
    expect([...game.text.matchAll(/@keyframes\s+([\w-]+)/g)].map(m => m[1])).toEqual(['chat-wild-in', 'chat-hop', 'chat-halo', 'chat-chip-in', 'chat-chip-out', 'chat-ag-in'])
    const stop = rules.filter(r => r.at?.includes('prefers-reduced-motion') && /animation\s*:\s*none/.test(r.body))
    expect(stop.flatMap(r => parts(r.sel))).toContain('.chat-wild.appear .chat-wild-mon')
    // nothing else of the chat moves
    for (const f of ['chat.css']) {
      const s = SHEETS.find(x => x.file === f)!
      expect(s.text, f).not.toMatch(/animation|@keyframes/)
    }
  })
})
