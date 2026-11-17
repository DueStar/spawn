/**
 * The 채팅 / 터미널 flip (src/chat/lensMode.ts, src/components/SessionHeader.tsx,
 * src/Widget.tsx): when a session offers it, which view is in effect, the choice kept
 * per session in the carry (24 at most), the header's markup unchanged without it, and
 * every terminal staying mounted whatever the choice.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { chatWho, effectiveMode, lensAvailability, readLensModes, writeLensMode, LENS_KEEP } from '../src/chat/lensMode'
import type { TerminalInfo } from '../src/desktop'
import { SessionHeader } from '../src/components/SessionHeader'

vi.mock('../src/i18n', async (orig) => ({ ...(await orig<typeof import('../src/i18n')>()), t: (k: string) => k }))

const ROOT = join(__dirname, '..')
const term = (over: Partial<TerminalInfo> = {}): TerminalInfo => ({ id: 't1', sessionId: 's1', cwd: '', project: 'p', status: 'running', createdAt: 0, exitCode: null, title: null, tool: 'claude', ...over })

/** (2026-11-17: icons belong to the icon system, tests/icons.test.ts; the captures check the markup around them) */
const noSvg = (h: string) => h.replace(/<svg[\s\S]*?<\/svg>/g, '<svg/>')

describe('lensAvailability', () => {
  it('no chat key (off, or not Claude Code): no flip', () => {
    expect(lensAvailability(term(), 'window')).toEqual({ show: false, enabled: false, reason: null })
    expect(lensAvailability(term({ tool: 'shell' }), 'window').show).toBe(false)
    expect(lensAvailability(undefined, 'window').show).toBe(false)
  })
  it('the widget never shows the chat', () => {
    expect(lensAvailability(term({ chat: 'armed' }), 'widget').show).toBe(false)
  })
  it('armed: shown and enabled, in a window and full screen', () => {
    expect(lensAvailability(term({ chat: 'armed' }), 'window')).toEqual({ show: true, enabled: true, reason: null })
    expect(lensAvailability(term({ chat: 'armed' }), 'fullscreen')).toEqual({ show: true, enabled: true, reason: null })
  })
  it('unarmed, version, starting: shown, not enabled, with the reason', () => {
    for (const r of ['unarmed', 'version', 'starting'] as const) {
      expect(lensAvailability(term({ chat: r }), 'window')).toEqual({ show: true, enabled: false, reason: r })
    }
  })
})

describe('effectiveMode', () => {
  it('chat only when offered, enabled and chosen', () => {
    expect(effectiveMode(term({ chat: 'armed' }), 'window', 'chat')).toBe('chat')
    expect(effectiveMode(term({ chat: 'armed' }), 'window', 'terminal')).toBe('terminal')
    expect(effectiveMode(term({ chat: 'armed' }), 'widget', 'chat')).toBe('terminal')
    expect(effectiveMode(term({ chat: 'unarmed' }), 'window', 'chat')).toBe('terminal')
    expect(effectiveMode(term({ tool: 'shell' }), 'window', 'chat')).toBe('terminal')
    expect(effectiveMode(term(), 'window', 'chat')).toBe('terminal') // turned off: the key is gone
    expect(effectiveMode(undefined, 'window', 'chat')).toBe('terminal')
  })
})

describe('chatWho', () => {
  it('a session with no Pokémon: the glyph and 에이전트, in either mode', () => {
    expect(chatWho({ name: '피카츄', sprite: 'x', noPokemon: true }, false)).toEqual({ picture: 'glyph', name: '에이전트' })
    expect(chatWho({ name: '피카츄', sprite: 'x', noPokemon: true }, true)).toEqual({ picture: 'glyph', name: '에이전트' })
    expect(chatWho({ name: '피카츄', sprite: 'x' }, false)).toEqual({ picture: 'pokemon', sprite: 'x', name: '피카츄' })
  })
})

describe('the choice, per session, in the carry', () => {
  const store = new Map<string, string>()
  beforeEach(() => {
    store.clear()
    vi.stubGlobal('localStorage', { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, String(v)) }, removeItem: (k: string) => { store.delete(k) } })
  })
  afterEach(() => vi.unstubAllGlobals())

  it('defaults to the terminal and keeps the rest of the carry', () => {
    store.set('spawn-carry', JSON.stringify({ view: 'dex', target: 's9', text: 'hi' }))
    expect(readLensModes()).toEqual({})
    writeLensMode('s1', 'chat')
    expect(readLensModes()).toEqual({ s1: 'chat' })
    const carry = JSON.parse(store.get('spawn-carry')!)
    expect(carry).toMatchObject({ view: 'dex', target: 's9', text: 'hi', chatModes: { s1: 'chat' } })
  })

  it(`keeps the ${24} most recent sessions only`, () => {
    expect(LENS_KEEP).toBe(24)
    for (let i = 0; i < 30; i++) writeLensMode(`s${i}`, i % 2 ? 'chat' : 'terminal')
    const modes = readLensModes()
    expect(Object.keys(modes)).toHaveLength(24)
    expect(modes.s0).toBeUndefined()
    expect(modes.s29).toBe('chat')
    // choosing again makes it recent
    writeLensMode('s6', 'chat')
    writeLensMode('s100', 'chat')
    expect(readLensModes().s6).toBe('chat')
    expect(readLensModes().s7).toBeUndefined()
  })

  it('a damaged value reads as nothing chosen', () => {
    store.set('spawn-carry', JSON.stringify({ chatModes: { s1: 'chat', s2: 'banana', s3: 4 } }))
    expect(readLensModes()).toEqual({ s1: 'chat' })
    store.set('spawn-carry', JSON.stringify({ chatModes: 'x' }))
    expect(readLensModes()).toEqual({})
  })
})

describe('SessionHeader', () => {
  const props = {
    parts: { picture: 'pokemon' as const, name: '로그인 리다이렉트 고치기', branch: 'fix/login-redirect', project: 'shop-web' },
    sprite: '/sprites/pokemon/icon/27.png', cwd: 'C:/code/shop-web', renaming: false,
    onRenameStart() {}, onRenameCommit() {}, onRenameCancel() {}, closing: false, onClose() {}, onCloseCancel() {},
  }
  // Captured from the component before the flip was added (chat view phase 2, Task 15): without
  // `lens` the header's markup stays exactly this
  const BEFORE_1 = '<div class="w-sess-head" title="C:/code/shop-web"><img class="w-sess-head-pic" src="/sprites/pokemon/icon/27.png" alt="" draggable="false"/><span class="w-sess-head-name" title="더블클릭해서 세션 이름 바꾸기">로그인 리다이렉트 고치기</span><span class="w-row-branch w-sess-head-branch" title="git 브랜치">fix/login-redirect</span><span class="w-sess-head-proj">shop-web</span><span class="w-sess-head-spacer"></span><button class="w-sess-head-close" title="세션 닫기" aria-label="세션 닫기">×</button></div>'
  const BEFORE_2 = '<div class="w-sess-head" title="C:/code/shop-web"><span class="w-sess-head-pic w-sess-head-glyph" aria-hidden="true"><svg class="ico" width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="1.8" y="2.8" width="12.4" height="10.4" rx="1.8"></rect><path d="M4.5 6.5 6.5 8l-2 1.5M8 10h3"></path></svg></span><span class="w-sess-head-name" title="더블클릭해서 세션 이름 바꾸기">새 세션</span><span class="w-sess-head-proj">docs</span><span class="w-sess-head-spacer"></span><button class="w-sess-head-close confirm" title="한 번 더 누르면 세션을 닫아요" aria-label="세션 닫기">닫기</button></div>'

  it('without `lens` the markup is exactly as before the flip', () => {
    expect(noSvg(renderToStaticMarkup(React.createElement(SessionHeader, props)))).toBe(noSvg(BEFORE_1))
    expect(noSvg(renderToStaticMarkup(React.createElement(SessionHeader, { ...props, parts: { picture: 'glyph', name: null, branch: null, project: 'docs' }, closing: true })))).toBe(noSvg(BEFORE_2))
  })

  it('with `lens`: a group of two pressed-state buttons before the ×, 채팅 pressed when chat is shown', () => {
    const html = renderToStaticMarkup(React.createElement(SessionHeader, { ...props, lens: { mode: 'chat', enabled: true, reason: null, onMode() {} } }))
    expect(html).toMatch(/<div class="w-lens" role="group" aria-label="보기 방식">/)
    expect(html).toMatch(/<button[^>]*aria-pressed="true"[^>]*>(?:(?!<\/button>).)*채팅(?:<\/span>)?<\/button>/)
    expect(html).toMatch(/<button[^>]*aria-pressed="false"[^>]*>(?:(?!<\/button>).)*터미널(?:<\/span>)?<\/button>/)
    expect(html.indexOf('w-lens')).toBeLessThan(html.indexOf('w-sess-head-close'))
  })

  it('not enabled: 채팅 is aria-disabled with the reason as its title', () => {
    const html = renderToStaticMarkup(React.createElement(SessionHeader, { ...props, lens: { mode: 'terminal', enabled: false, reason: 'unarmed', onMode() {} } }))
    expect(html).toMatch(/aria-disabled="true"[^>]*title="이 세션은 채팅 보기를 켜기 전에 열렸어요. 다시 열면 채팅으로 볼 수 있어요"/)
  })
})

describe('Widget.tsx: every terminal stays mounted', () => {
  const src = readFileSync(join(ROOT, 'src', 'Widget.tsx'), 'utf8')
  it('imports TerminalView as before and renders one per terminal whatever the view', () => {
    expect(src).toContain("const TerminalView = lazy(() => loadTerminal().then(m => ({ default: m.TerminalView })))")
    expect(src).toMatch(/\{withTerminal\.map\(r => \{\s*if \(!r\.terminal\) return null[^]*?<TerminalView key=\{r\.terminal\.id\} term=\{r\.terminal\}/)
    // the chat only takes the terminal's `active`, nothing else about it
    // (by session id, not object identity: a refactor of the rows can never leave the terminal active under the chat; review M17)
    // (Task 5.2: `|| warm`, the shown chat session's terminal until it has fitted once: tests/chat-term-warm.test.ts)
    expect(src).toMatch(/const active = \(view === 'terminal' && shown\?\.sessionId === r\.sessionId && !\(r\.sessionId === shown\?\.sessionId && lensMode === 'chat'\)\) \|\| warm\n/)
  })
  it('the chat view is loaded lazily, and only in the chat mode', () => {
    expect(src).toMatch(/const ChatView = lazy\(\(\) => import\('\.\/components\/ChatView'\)\)/)
    expect(src).not.toMatch(/import [^\n]*from '\.\/components\/ChatView'/)
    expect(src).toMatch(/lensMode === 'chat' && view === 'terminal'/)
  })
  it('no new keyboard shortcut, and nothing chat-related in the key handling', () => {
    expect(readFileSync(join(ROOT, 'src', 'keys.ts'), 'utf8')).not.toMatch(/\bchat|\blens/i)
  })
})


// ---- the composer in the chat view (Phase 3, Task 3.9) -------------------------------------------------

/** The side panel's instruction box as release 1.4.0 draws it (pinned before the composer came) */

describe('the composer in the chat view; the side panel\'s box', () => {
  const widget = readFileSync(join(ROOT, 'src', 'Widget.tsx'), 'utf8')

  it('no instruction box in the side panel (removed 2026-11-16 at the owner\'s request): a note keeps a card of its own', () => {
    expect(widget).not.toMatch(/<textarea/)
    expect(widget).not.toMatch(/w-compose-pointer|채팅 아래 입력란에서 보내요/)
    expect(widget).toMatch(/\{note && \(\s*<section className="w-card w-compose">/)
  })

  it('the composer takes the focus only on the user\'s own flip or switch, never from something being typed into', () => {
    const composer = readFileSync(join(ROOT, 'src', 'components', 'chat', 'Composer.tsx'), 'utf8')
    expect(composer).toMatch(/takeChatFocus\(\)/)
    expect(composer).toMatch(/isTypingTarget\(document\.activeElement\)/)
    const view = readFileSync(join(ROOT, 'src', 'components', 'ChatView.tsx'), 'utf8')
    // the list takes it only when there is no composer
    expect(view).toMatch(/!footer && listRef\.current && takeChatFocus\(\)/)
  })

  it('no new keyboard shortcut in the composer: its keys act only inside its own field', () => {
    const composer = readFileSync(join(ROOT, 'src', 'components', 'chat', 'Composer.tsx'), 'utf8')
    expect(composer).not.toMatch(/(window|document)\.addEventListener\(['"]key/)
  })
})
