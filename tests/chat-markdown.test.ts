/**
 * src/chat/markdown.ts — the assistant's prose as a small markdown AST with no
 * HTML path at all (raw HTML stays text, links only http/https and only through
 * the app, no image is ever loaded), and its renderer (src/components/chat/
 * Markdown.tsx), which builds React elements only. Includes the adversarial set:
 * script tags, javascript:/data: links, entities, emphasis bombs, a 1 MB line,
 * unterminated fences, ragged tables, RTL and zero-width characters.
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { MD_CAP, parseMarkdown, type Block, type Inline } from '../src/chat/markdown'
import { Markdown } from '../src/components/chat/Markdown'
import { CodeBlock } from '../src/components/chat/CodeBlock'
import { linesOf } from './chat-helpers'
import { budget, growth, growthLimit, showGrowth } from './timing'

vi.mock('../src/i18n', async (orig) => ({ ...(await orig<typeof import('../src/i18n')>()), t: (k: string, v?: Record<string, unknown>) => (v ? k.replace(/\{(\w+)\}/g, (_, n) => String(v[n])) : k) }))

const ROOT = join(__dirname, '..')

/** All the text of an inline list (what a reader sees) */
function plain(xs: Inline[]): string {
  return xs.map(x => {
    switch (x.type) {
      case 'text': case 'code': return x.text
      case 'strong': case 'em': case 'del': case 'link': return plain(x.children)
      case 'autolink': return x.href
      case 'path': return x.text
      case 'br': return '\n'
    }
  }).join('')
}
const only = (src: string) => { const b = parseMarkdown(src); expect(b).toHaveLength(1); return b[0] }
const para = (src: string): Inline[] => { const b = only(src); expect(b.type).toBe('para'); return (b as Extract<Block, { type: 'para' }>).inline }
/** Every inline node, nested ones too */
function walk(blocks: Block[]): Inline[] {
  const out: Inline[] = []
  const inl = (xs: Inline[]) => { for (const x of xs) { out.push(x); if ('children' in x) inl(x.children) } }
  const blk = (bs: Block[]) => {
    for (const b of bs) {
      if (b.type === 'para' || b.type === 'heading') inl(b.inline)
      else if (b.type === 'list') b.items.forEach(blk)
      else if (b.type === 'quote') blk(b.blocks)
      else if (b.type === 'table') { b.head.forEach(inl); b.rows.forEach(r => r.forEach(inl)) }
    }
  }
  blk(blocks)
  return out
}
const render = (src: string) => renderToStaticMarkup(React.createElement(Markdown, { blocks: parseMarkdown(src), onLink: () => {}, onPath: () => {} }))

describe('blocks Claude Code prints', () => {
  it('the Greek-letter table of basic.jsonl: 2 columns, 3 rows', () => {
    const answer = linesOf('basic.jsonl').map(l => JSON.parse(l.text)).find(o => o.type === 'assistant' && Array.isArray(o.message?.content) && o.message.content.some((c: any) => c.type === 'text' && c.text.includes('|')))
    const src = answer.message.content.find((c: any) => c.type === 'text').text
    const blocks = parseMarkdown(src)
    const table = blocks.find(b => b.type === 'table') as Extract<Block, { type: 'table' }>
    expect(table.head.map(plain)).toEqual(['Letter', 'Name'])
    expect(table.rows.map(r => r.map(plain))).toEqual([['α', 'alpha'], ['β', 'beta'], ['γ', 'gamma']])
    const list = blocks.find(b => b.type === 'list') as Extract<Block, { type: 'list' }>
    expect(list.ordered).toBe(true)
    expect(list.items).toHaveLength(3)
  })

  it('a numbered list of 30 lines', () => {
    const src = Array.from({ length: 30 }, (_, i) => `${i + 1}. River number ${i + 1}`).join('\n')
    const b = only(src) as Extract<Block, { type: 'list' }>
    expect(b.type).toBe('list')
    expect(b.ordered).toBe(true)
    expect(b.start).toBe(1)
    expect(b.items).toHaveLength(30)
    expect(plain((b.items[29][0] as any).inline)).toBe('River number 30')
  })

  it('a list that starts at 3 keeps its start', () => {
    expect((only('3. c\n4. d') as any).start).toBe(3)
  })

  it('nested bullets, three levels', () => {
    const b = only('- one\n  - two\n    - three\n  - two b\n- one b') as Extract<Block, { type: 'list' }>
    expect(b.items).toHaveLength(2)
    const l2 = b.items[0].find(x => x.type === 'list') as Extract<Block, { type: 'list' }>
    expect(l2.items).toHaveLength(2)
    const l3 = l2.items[0].find(x => x.type === 'list') as Extract<Block, { type: 'list' }>
    expect(plain((l3.items[0][0] as any).inline)).toBe('three')
  })

  it('bullets under a numbered item, indented as Claude does (3 spaces)', () => {
    const b = only('1. First\n   - a\n   - b\n2. Second') as Extract<Block, { type: 'list' }>
    expect(b.items).toHaveLength(2)
    expect((b.items[0].find(x => x.type === 'list') as any).items).toHaveLength(2)
  })

  it('a fenced ts block keeps its text exactly, and an unclosed fence runs to the end', () => {
    const b = parseMarkdown('Before\n\n```ts\nconst a = 1 < 2 && "x"\n  indented\n```\nAfter')
    expect(b.map(x => x.type)).toEqual(['para', 'code', 'para'])
    expect(b[1]).toEqual({ type: 'code', lang: 'ts', text: 'const a = 1 < 2 && "x"\n  indented' })
    const open = parseMarkdown('Streaming\n~~~py\nprint(1)\n# not a heading')
    expect(open[1]).toEqual({ type: 'code', lang: 'py', text: 'print(1)\n# not a heading' })
  })

  it('headings 1–4 (5 and 6 are drawn as 4), quotes, rules', () => {
    const b = parseMarkdown('# A\n## B\n#### D\n###### F\n\n> quoted **x**\n\n---\n\ntext')
    expect(b.map(x => x.type)).toEqual(['heading', 'heading', 'heading', 'heading', 'quote', 'hr', 'para'])
    expect(b.slice(0, 4).map((x: any) => x.level)).toEqual([1, 2, 4, 4])
  })

  it('emphasis: **bold** _em_ ~~del~~ `code`', () => {
    const xs = para('**bold** _em_ ~~del~~ `code`')
    expect(xs.filter(x => x.type !== 'text').map(x => x.type)).toEqual(['strong', 'em', 'del', 'code'])
    expect(plain(xs)).toBe('bold em del code')
  })

  it('snake_case words stay words; a * inside a word may still emphasise', () => {
    expect(para('call my_long_function_name here').every(x => x.type === 'text')).toBe(true)
    expect(plain(para('call my_long_function_name here'))).toBe('call my_long_function_name here')
  })

  it('Korean prose with **강조** in the middle of a word', () => {
    const xs = para('이 함수는**반드시**두 번 불러야 해요')
    expect(xs.map(x => x.type)).toEqual(['text', 'strong', 'text'])
    expect(plain(xs)).toBe('이 함수는반드시두 번 불러야 해요')
  })

  it('a link to MDN', () => {
    const xs = para('See [MDN](https://developer.mozilla.org/x) now')
    const link = xs.find(x => x.type === 'link') as Extract<Inline, { type: 'link' }>
    expect(link.href).toBe('https://developer.mozilla.org/x')
    expect(plain(link.children)).toBe('MDN')
  })

  it('a link with parentheses in its address keeps them', () => {
    const link = para('[wiki](https://en.wikipedia.org/wiki/Rust_(language))').find(x => x.type === 'link') as any
    expect(link.href).toBe('https://en.wikipedia.org/wiki/Rust_(language)')
  })

  it('an image is a link with its alt text; nothing is loaded', () => {
    const xs = para('![a](https://e.x/i.png)')
    expect(xs).toEqual([{ type: 'link', href: 'https://e.x/i.png', children: [{ type: 'text', text: 'a' }] }])
    expect(render('![a](https://e.x/i.png)')).not.toMatch(/<img/i)
  })

  it('a bare address is an autolink without the trailing ")" and "."', () => {
    const xs = para('(see https://example.com/a).')
    expect(xs.find(x => x.type === 'autolink')).toEqual({ type: 'autolink', href: 'https://example.com/a' })
    expect(plain(xs)).toBe('(see https://example.com/a).')
  })

  it('a file path with a line is a path chip; inside backticks it is code', () => {
    const xs = para('It is in src/app/cart/LoginButton.tsx:18 and `src/app/cart/LoginButton.tsx:18`.')
    const paths = xs.filter(x => x.type === 'path') as Extract<Inline, { type: 'path' }>[]
    expect(paths).toEqual([{ type: 'path', file: 'src/app/cart/LoginButton.tsx', line: 18, text: 'src/app/cart/LoginButton.tsx:18' }])
    expect(xs.some(x => x.type === 'code' && x.text === 'src/app/cart/LoginButton.tsx:18')).toBe(true)
    const win = para('see C:\\x\\y.ts:3:7, ok').find(x => x.type === 'path')
    expect(win).toEqual({ type: 'path', file: 'C:\\x\\y.ts', line: 3, col: 7, text: 'C:\\x\\y.ts:3:7' })
    // a Korean particle right after the path is not part of it
    expect(para('src/lib/a.ts에서 고쳤어요').find(x => x.type === 'path')).toMatchObject({ file: 'src/lib/a.ts' })
    // a bare name with no folder and no line, a domain, a version: words
    for (const s of ['notes.md', 'example.com', 'v1.2.3', 'e.g.']) expect(para(s).every(x => x.type === 'text'), s).toBe(true)
  })

  it('a backslash escapes the markdown character', () => {
    expect(plain(para('\\*not em\\* and \\`not code\\`'))).toBe('*not em* and `not code`')
    expect(para('\\*not em\\*').every(x => x.type === 'text')).toBe(true)
  })

  it('line breaks inside a paragraph are kept (as the terminal shows them)', () => {
    const xs = para('one\ntwo')
    expect(xs.map(x => x.type)).toEqual(['text', 'br', 'text'])
  })
})

describe('no HTML path (adversarial)', () => {
  it('<img src=x onerror=alert(1)> is literal text', () => {
    expect(plain(para('<img src=x onerror=alert(1)>'))).toBe('<img src=x onerror=alert(1)>')
    const html = render('<img src=x onerror=alert(1)>')
    expect(html).toBe('<p>&lt;img src=x onerror=alert(1)&gt;</p>')
  })

  it('a script tag, also across lines and inside a table and a heading, is text', () => {
    const src = '<script>alert(1)</script>\n\n# <script>x</script>\n\n| a | b |\n|---|---|\n| <script>y</script> | <b>z</b> |\n\n<div onclick="x">\nhi\n</div>'
    const html = render(src)
    expect(html).not.toMatch(/<script|<b>|<div onclick/i)
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
  })

  it('[x](javascript:alert(1)) is text, as are data:, vbscript:, file: and spaced or cased variants', () => {
    expect(para('[x](javascript:alert(1))')).toEqual([{ type: 'text', text: '[x](javascript:alert(1))' }])
    for (const href of ['data:text/html;base64,PHNjcmlwdD4=', 'vbscript:msgbox(1)', 'file:///C:/x', ' javascript:alert(1)', 'JaVaScRiPt:alert(1)', 'java\tscript:alert(1)', '//evil.example/x', 'mailto:a@b.c', '/relative/path']) {
      const blocks = parseMarkdown(`[x](${href})`)
      expect(walk(blocks).some(x => x.type === 'link' || x.type === 'autolink'), href).toBe(false)
    }
    const html = render('[x](javascript:alert(1)) [y](data:text/html,<script>alert(1)</script>)')
    expect(html).not.toMatch(/href="(?!#")/)
    expect(html).not.toMatch(/="javascript:|="data:|<script/i)
    expect(html).not.toMatch(/<a /)
  })

  it('a link\'s element never carries its address as href: only "#", the address in the title', () => {
    const html = render('[MDN](https://developer.mozilla.org/x) and https://example.com/a')
    expect(html.match(/href="[^"]*"/g)).toEqual(['href="#"', 'href="#"'])
    expect(html).toContain('title="https://developer.mozilla.org/x"')
  })

  it('a quote in an address cannot break out of the title attribute', () => {
    const html = render('[x](https://e.x/a"onmouseover="alert(1))')
    expect(html).not.toMatch(/ onmouseover=/)
  })

  it('HTML entities are shown as written, never decoded into markup', () => {
    const html = render('&lt;script&gt;alert(1)&lt;/script&gt; &#60;b&#62;')
    expect(html).toContain('&amp;lt;script&amp;gt;')
    expect(html).not.toMatch(/<script|<b>/)
    expect(walk(parseMarkdown('[x](&#106;avascript:alert(1))')).some(x => x.type === 'link')).toBe(false)
  })

  it('an address with a zero-width or bidi control character is not a link', () => {
    for (const href of ['https://exa\u200bmple.com', 'https://e.x/\u202egnp.exe', 'https://e.x/\u2066a']) {
      expect(walk(parseMarkdown(`[x](${href})`)).some(x => x.type === 'link'), JSON.stringify(href)).toBe(false)
    }
    // a bare address stops at the hidden character: what is shown is exactly what would open
    const auto = walk(parseMarkdown('go https://exa\u200bmple.com now')).find(x => x.type === 'autolink') as any
    expect(auto.href).toBe('https://exa')
    expect(walk(parseMarkdown('src/\u202ea.ts:3')).some(x => x.type === 'path')).toBe(false)
  })

  it('a right-to-left override in prose stays inside its paragraph (isolated in the CSS)', () => {
    const blocks = parseMarkdown('abc \u202e def\n\nnext')
    expect(blocks.map(b => b.type)).toEqual(['para', 'para'])
    const css = readFileSync(join(ROOT, 'src', 'styles', 'chat.css'), 'utf8')
    expect(css).toMatch(/unicode-bidi:\s*isolate/)
  })
})

describe('bounded work (adversarial)', () => {
  const time = (src: string) => { const t0 = performance.now(); const b = parseMarkdown(src); return { ms: performance.now() - t0, b } }

  // Linear, proven by growth (tests/timing.ts): the time from n to 4n stays near ×4 (quadratic would be ×16), and
  // the 4n input (the size each attack had before, all of it under MD_CAP so none of it is cut away) parses within
  // a generous second. A wall-clock 300 ms alone failed on a busy CI runner and would pass a slow quadratic on a
  // fast machine.
  const linear = (make: (k: number) => string, n: number) => {
    expect(make(4 * n).length).toBeLessThanOrEqual(MD_CAP)
    const g = growth(make, parseMarkdown, n)
    const what = `${make(4).slice(0, 12)}: ${showGrowth(g)}`
    expect(g.ratio, what).toBeLessThan(growthLimit())
    expect(g.large, what).toBeLessThan(1000)
  }

  it('200 000 characters of * parse in linear time', () => {
    linear(k => '*'.repeat(k) + 'a'.repeat(k), 25_000)
  })

  it.each([
    ['**_~~', (k: number) => '**_~~'.repeat(k), 10_000],
    ['*a _b ~~c `d [e](f ', (k: number) => '*a _b ~~c `d [e](f '.repeat(k), 2_500],
    ['[…]', (k: number) => '['.repeat(k) + ']', 37_500],
    ['`x``…', (k: number) => '`' + 'x``'.repeat(k), 15_000],
    ['_', (k: number) => '_'.repeat(k), 37_500],
    ['[a](', (k: number) => '[a]('.repeat(k), 10_000],
    ['<', (k: number) => '<'.repeat(k), 37_500],
    ['https://', (k: number) => 'https://'.repeat(k), 5_000],
    ['a/…b.ts:1', (k: number) => 'a/'.repeat(k) + 'b.ts:1', 22_500],
  ])('nested emphasis bombs, unclosed brackets and backticks stay linear: %s', (_name, make, n) => {
    linear(make, n)
  })

  it('deep quotes and lists stop nesting (no stack overflow)', () => {
    const quotes = time('>'.repeat(100_000) + ' x')
    expect(quotes.ms).toBeLessThan(budget(300))
    const lists = time(Array.from({ length: 3000 }, (_, i) => `${' '.repeat(i * 2)}- item ${i}`).join('\n'))
    expect(lists.ms).toBeLessThan(budget(500))
    let depth = 0
    const deepest = (bs: Block[], d: number) => { depth = Math.max(depth, d); for (const b of bs) { if (b.type === 'list') b.items.forEach(i => deepest(i, d + 1)); if (b.type === 'quote') deepest(b.blocks, d + 1) } }
    deepest(lists.b, 0)
    expect(depth).toBeLessThanOrEqual(4)
    depth = 0
    deepest(quotes.b, 0)
    expect(depth).toBeLessThanOrEqual(8)
  })

  it('a 1 MB single line is cut at the cap, says so, and parses quickly', () => {
    const line = 'word **b** `c` [d](https://e.x) '.repeat(40_000).slice(0, 1_000_000)
    const { ms, b } = time(line)
    expect(ms).toBeLessThan(budget(500))
    expect(b[b.length - 1]).toEqual({ type: 'cut' })
    const shown = walk(b).map(x => ('text' in x ? x.text : '')).join('')
    expect(shown.length).toBeLessThanOrEqual(MD_CAP)
    expect(MD_CAP).toBe(200_000)
    expect(render('x'.repeat(MD_CAP + 10))).toContain('chat-cut')
  })

  it('many short lines (10 000) parse quickly', () => {
    const { ms } = time(Array.from({ length: 10_000 }, (_, i) => (i % 7 === 0 ? '' : `line ${i} with **bold** and \`code\``)).join('\n'))
    expect(ms).toBeLessThan(budget(500))
  })
})

describe('tables (ragged and odd)', () => {
  it('a row with fewer cells is padded, one with more is cut; alignment is read', () => {
    const t = only('| a | b | c |\n|:--|:-:|--:|\n| 1 |\n| 1 | 2 | 3 | 4 | 5 |') as Extract<Block, { type: 'table' }>
    expect(t.align).toEqual(['left', 'center', 'right'])
    expect(t.rows.map(r => r.length)).toEqual([3, 3])
    expect(t.rows[0].map(plain)).toEqual(['1', '', ''])
    expect(t.rows[1].map(plain)).toEqual(['1', '2', '3'])
  })

  it('a pipe inside code or escaped does not split a cell', () => {
    const t = only('| a | b |\n|---|---|\n| `x | y` | c \\| d |') as Extract<Block, { type: 'table' }>
    expect(t.rows[0].map(plain)).toEqual(['x | y', 'c | d'])
  })

  it('without the alignment row it is a paragraph', () => {
    expect(only('| a | b |\n| 1 | 2 |').type).toBe('para')
  })

  it('a table is wrapped for sideways scrolling', () => {
    expect(render('| a | b |\n|---|---|\n| 1 | 2 |')).toMatch(/^<div class="tbl-wrap"><table>/)
  })
})

describe('the renderer', () => {
  it('builds elements only: no dangerouslySetInnerHTML, innerHTML or eval in the chat sources', () => {
    const files: string[] = []
    for (const dir of [join(ROOT, 'src', 'chat'), join(ROOT, 'src', 'components', 'chat')]) {
      if (!existsSync(dir)) continue
      for (const f of readdirSync(dir)) if (/\.tsx?$/.test(f)) files.push(join(dir, f))
    }
    expect(files.length).toBeGreaterThanOrEqual(4)
    for (const f of files) {
      const src = readFileSync(f, 'utf8')
      expect(src, f).not.toMatch(/dangerouslySetInnerHTML|innerHTML|\beval\(|new Function\(/)
    }
  })

  it('links call onLink with the address; paths call onPath (clicked through React props, not markup)', () => {
    const blocks = parseMarkdown('[MDN](https://developer.mozilla.org/x) src/a/b.ts:18')
    const onLink = vi.fn(), onPath = vi.fn()
    const el = React.createElement(Markdown, { blocks, onLink, onPath }) as any
    // walk the element tree the component returns and press what it renders
    const tree = (el.type as any)(el.props)
    const found: any[] = []
    const visit = (n: any) => {
      if (!n || typeof n !== 'object') return
      if (Array.isArray(n)) { n.forEach(visit); return }
      if (typeof n.type === 'function') { visit(n.type(n.props)); return }
      if (n.props?.onClick) found.push(n)
      visit(n.props?.children)
    }
    visit(tree)
    const link = found.find(n => n.type === 'a')
    link.props.onClick({ preventDefault() {} })
    expect(onLink).toHaveBeenCalledWith('https://developer.mozilla.org/x')
    const chip = found.find(n => n.type === 'button')
    chip.props.onClick({ preventDefault() {} })
    expect(onPath).toHaveBeenCalledWith('src/a/b.ts', 18, undefined)
  })

  it('a code block: its language, a copy button, the text in a <pre>', () => {
    const html = renderToStaticMarkup(React.createElement(CodeBlock, { lang: 'ts', text: 'const a = "<b>"' }))
    expect(html).toContain('ts')
    expect(html).toMatch(/<button[^>]*type="button"[^>]*aria-label="코드 복사"/)
    expect(html).toContain('&lt;b&gt;')
    expect(html).toMatch(/<pre/)
  })

  it('a long code block has a head and a body that scrolls sideways (no wrap)', () => {
    const css = readFileSync(join(ROOT, 'src', 'styles', 'chat.css'), 'utf8')
    expect(css).toMatch(/\.chat-code pre[^{]*{[^}]*overflow-x:\s*auto/)
  })
})
