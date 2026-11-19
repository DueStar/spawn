/**
 * The re-review's fixes (rereview.md, the third wave), the parts a test can hold without a page:
 * a UNC or device path never reaches the file system from the chat (I-2), the main-process
 * lens and host (m-1 … m-4, m-10, m-14), the page's pure parts (m-5 … m-11, m-14), a compaction
 * summary as a notice, and a prompt typed while Claude works. The keyboard (I-3) is a harness
 * step (chat-scroll); the settings file (I-1) is in terminals.test.ts.
 */

import { createRequire } from 'node:module'
import { describe, expect, it, vi } from 'vitest'
import { isRemotePath, parseMarkdown, type Inline } from '../src/chat/markdown'

const require = createRequire(import.meta.url)
const { openFromChat, isRemotePath: mainRemote } = require('../electron/links.cjs')

const inlines = (src: string): Inline[] => {
  const out: Inline[] = []
  const walk = (xs: Inline[]) => { for (const x of xs) { out.push(x); if ('children' in x) walk(x.children) } }
  for (const b of parseMarkdown(src)) if (b.type === 'para' || b.type === 'heading') walk(b.inline)
  return out
}
const paths = (src: string) => inlines(src).filter(x => x.type === 'path')

describe('I-2: a UNC or device path from the chat never reaches the file system', () => {
  const REMOTE = ['\\\\evil-host\\x\\setup.ts', '//evil-host/x/setup.ts', '\\\\?\\C:\\a\\b.ts', '\\\\.\\pipe\\x.ts', '\\/evil\\x.ts', '/\\evil/x.ts']

  it('both sides call the same paths remote, and no ordinary path', () => {
    for (const p of REMOTE) { expect(mainRemote(p), p).toBe(true); expect(isRemotePath(p), p).toBe(true) }
    for (const p of ['C:\\Users\\user\\a.ts', 'src/a.ts', '/Users/user/a.ts', '.\\a.ts', '\\a.ts', 'a\\\\b.ts']) {
      expect(mainRemote(p), p).toBe(false)
      expect(isRemotePath(p), p).toBe(false)
    }
  })

  it('main refuses one before any stat, also when the session folder makes a relative path remote', async () => {
    const statSync = vi.fn(() => ({ isFile: () => true }))
    const openExternal = vi.fn(async () => {})
    const showItemInFolder = vi.fn()
    const opts = { statSync, openExternal, showItemInFolder, hasScheme: () => true, platform: 'win32' }
    for (const p of REMOTE) expect(await openFromChat({ cwd: 'C:\\Users\\user\\work' }, p, { ...opts, line: 2 }), p).toBe(false)
    expect(await openFromChat({ cwd: '\\\\host\\share\\proj' }, 'src\\a.ts', opts)).toBe(false)
    expect(statSync).not.toHaveBeenCalled()
    expect(openExternal).not.toHaveBeenCalled()
    expect(showItemInFolder).not.toHaveBeenCalled()
  })

  it('an ordinary file: stat, then the editor at its line, else the folder; a missing one opens nothing', async () => {
    const statSync = vi.fn((p: string) => { if (p.endsWith('gone.ts')) throw Object.assign(new Error('x'), { code: 'ENOENT' }); return { isFile: () => true } })
    const openExternal = vi.fn(async () => {})
    const showItemInFolder = vi.fn()
    const term = { cwd: 'C:\\Users\\user\\work' }
    expect(await openFromChat(term, 'src\\a.ts', { statSync, openExternal, showItemInFolder, hasScheme: (s: string) => s === 'vscode', platform: 'win32', line: 3 })).toBe(true)
    expect(openExternal).toHaveBeenCalledWith('vscode://file/C:/Users/user/work/src/a.ts:3')
    expect(await openFromChat(term, 'src\\a.ts', { statSync, openExternal, showItemInFolder, hasScheme: () => false, platform: 'win32' })).toBe(true)
    expect(showItemInFolder).toHaveBeenCalledWith('C:\\Users\\user\\work\\src\\a.ts')
    expect(await openFromChat(term, 'gone.ts', { statSync, openExternal, showItemInFolder, hasScheme: () => true, platform: 'win32' })).toBe(false)
    expect(await openFromChat(null, 'a.ts', { statSync, openExternal, showItemInFolder, platform: 'win32' })).toBe(false)
    expect(await openFromChat(term, 'x'.repeat(1025), { statSync, openExternal, showItemInFolder, platform: 'win32' })).toBe(false)
  })

  it('the page: a UNC path stays whole text, a drive path is still a chip', () => {
    expect(paths('see \\\\host\\share\\a.ts:2 and C:\\work\\b.ts:3')).toEqual([{ type: 'path', file: 'C:\\work\\b.ts', line: 3, text: 'C:\\work\\b.ts:3' }])
    expect(paths('//host/share/a.ts:2')).toEqual([])
    expect(paths('\\\\?\\C:\\a\\b.ts:1')).toEqual([])
  })

  it('a diff whose file is a UNC path names it as text, not a button', async () => {
    const React = (await import('react')).default
    const { renderToStaticMarkup } = await import('react-dom/server')
    const { DiffBlock } = await import('../src/components/chat/DiffBlock')
    const diff = { file: '//host/share/a.ts', kind: 'edit', added: 1, removed: 0, hidden: 0, hunks: [{ oldStart: 1, newStart: 1, lines: [{ t: '+', old: null, new: 1, text: 'x' }] }] }
    const item = { id: 't', order: 0, at: null, kind: 'tool', tool: 'Edit', input: {}, state: 'done', diff }
    const html = renderToStaticMarkup(React.createElement(DiffBlock as any, { item, diff }))
    expect(html).toMatch(/<span class="chat-diff-file">\/\/host\/share\/a\.ts<\/span>/)
    expect(html).not.toMatch(/<button[^>]*chat-diff-file/)
    const local = { ...diff, file: 'src/a.ts' }
    expect(renderToStaticMarkup(React.createElement(DiffBlock as any, { item, diff: local }))).toMatch(/<button[^>]*chat-diff-file/)
  })

  it('the page never even asks main to open one', async () => {
    const { openFileFromChat } = await import('../src/chat/lensMode')
    const { bridge } = await import('../src/desktop')
    // (no desktop bridge in a test: the call is a no-op either way; the guard is in the source)
    expect(bridge ?? null).toBeNull()
    expect(() => openFileFromChat('t', '\\\\host\\x.ts')).not.toThrow()
    const src = (await import('node:fs')).readFileSync(new URL('../src/chat/lensMode.ts', import.meta.url), 'utf8')
    const fn = src.slice(src.indexOf('export function openFileFromChat'), src.indexOf('export function openUrlFromChat'))
    expect(fn.indexOf("if (/^[\\\\/]{2}/.test(file)) return")).toBeGreaterThan(0)
    expect(fn.indexOf("if (/^[\\\\/]{2}/.test(file)) return")).toBeLessThan(fn.indexOf('openPath('))
  })
})

describe('the item builder: commands and a compaction summary', () => {
  const { createItemBuilder } = require('../electron/chatItems.cjs')
  const sys = (content: string) => ({ type: 'system', subtype: 'local_command', content, uuid: '00000000-0000-4000-8000-000000000a01', timestamp: '2026-11-14T12:00:00.000Z' })
  const userLine = (content: unknown, extra: Record<string, unknown> = {}) => ({ type: 'user', message: { role: 'user', content }, uuid: '00000000-0000-4000-8000-000000000a02', timestamp: '2026-11-14T12:00:00.000Z', ...extra })

  it('m-2: a local command line that starts with white space is still a command; "s<command-name>" is not', () => {
    const b = createItemBuilder({ cwd: '/Users/user/work' })
    expect(b.line(sys('\n  <command-name>/model</command-name><command-args>haiku</command-args>'), 1)).toMatchObject([{ kind: 'notice', notice: 'command', text: '/model haiku' }])
    expect(b.line(sys('s<command-name>/model</command-name>'), 2)).toEqual([])
    expect(b.line(userLine('s<command-name>/x</command-name> is how it looks'), 3)).toMatchObject([{ kind: 'user' }])
  })

  it('a compaction summary (isCompactSummary, as text or blocks, even marked meta) is a summary notice, never a user message', () => {
    const b = createItemBuilder({ cwd: '/Users/user/work' })
    const text = 'This session is being continued from a previous conversation that ran out of context. Summary: made up.'
    expect(b.line(userLine(text, { isCompactSummary: true }), 1)).toMatchObject([{ kind: 'notice', notice: 'summary' }])
    expect(b.line(userLine([{ type: 'text', text }], { isCompactSummary: true, isMeta: true }), 2)).toMatchObject([{ kind: 'notice', notice: 'summary' }])
    expect(b.line(userLine(text), 3)).toMatchObject([{ kind: 'notice', notice: 'summary' }])
    expect(b.line(userLine('continue from where we left off'), 4)).toMatchObject([{ kind: 'user' }])
  })

  it('the page says it quietly, as a notice row, in ko, en and ja', async () => {
    const { buildRows } = await import('../src/chat/rows')
    const rows = buildRows([{ id: 'n', order: 1, at: null, kind: 'notice', notice: 'summary' }] as any, { dayLabel: () => '' })
    expect(rows.map(r => r.row)).toEqual(['notice'])
    // (the notice's words moved to src/chat/find.ts NOTICE_WORDS: find searches them as the row says them)
    const src = (await import('node:fs')).readFileSync(new URL('../src/chat/find.ts', import.meta.url), 'utf8')
    expect(src).toMatch(/summary: '대화가 요약되어 이어졌어요'/)
    expect((await import('node:fs')).readFileSync(new URL('../src/components/ChatView.tsx', import.meta.url), 'utf8')).toMatch(/noticeText\(item\)/)
    const DICTS = (await import('../src/locales/index')).default
    for (const lang of ['en', 'ja'] as const) expect(DICTS[lang]['대화가 요약되어 이어졌어요']).toBeTruthy()
  })
})

describe('m-14: terminalFor keeps only the alive check', () => {
  it('no comparison of a status object with a string', () => {
    const src = (require('node:fs') as typeof import('node:fs')).readFileSync(require.resolve('../electron/chatLens.cjs'), 'utf8')
    const fn = src.slice(src.indexOf('function terminalFor'), src.indexOf('async function transcriptAllowed'))
    expect(fn).not.toMatch(/status !== 'exited'/)
    expect(fn).toMatch(/t\.alive !== false/)
  })
})

describe('the page\'s minor ones', () => {
  it('m-5: an Agent row asks once per moment of its sub-agent — not again when the answer\'s rows arrive — and again when rows it had seen went away', async () => {
    const { shouldAskAgent } = await import('../src/components/chat/AgentGroup')
    const asked = { moment: 'running:1', rowsSeen: false }
    // the answer's rows arrived: same moment, nothing more to ask
    expect(shouldAskAgent({ open: true, inFlight: false, hasRows: true, asked, moment: 'running:1' })).toBe(false)
    // the sub-agent moved on while the request was in flight: asked once it settles
    expect(shouldAskAgent({ open: true, inFlight: true, hasRows: true, asked, moment: 'running:2' })).toBe(false)
    expect(shouldAskAgent({ open: true, inFlight: false, hasRows: true, asked, moment: 'running:2' })).toBe(true)
    // rows seen, then let go by main: asked again; never seen (nothing came): not again
    expect(shouldAskAgent({ open: true, inFlight: false, hasRows: false, asked: { ...asked, rowsSeen: true }, moment: 'running:1' })).toBe(true)
    expect(shouldAskAgent({ open: true, inFlight: false, hasRows: false, asked, moment: 'running:1' })).toBe(false)
    // the effect looks again when a request settles
    const src = (await import('node:fs')).readFileSync(new URL('../src/components/chat/AgentGroup.tsx', import.meta.url), 'utf8')
    expect(src).toMatch(/finally\(\(\) => \{ inFlight\.delete\(key\); setSettled\(n => n \+ 1\) \}\)/)
    expect(src).toMatch(/\}, \[open, key, moment, hasRows, settled\]\)/)
  })

  it('m-6: the accepted markdown trade-offs hold as noted', () => {
    const text = (src: string) => inlines(src).map(x => ('text' in x ? x.text : x.type === 'autolink' ? `<${x.href}>` : '')).join('')
    // two escapes in one run: the backslashes stay (a run like a Windows path is never escaped)
    expect(text('\\*\\*not bold\\*\\*')).toBe('\\*\\*not bold\\*\\*')
    expect(inlines('\\*\\*not bold\\*\\*').some(x => x.type === 'strong')).toBe(false)
    // a bare address ends where Korean starts; written as a link it is whole
    expect(inlines('https://ko.wikipedia.org/wiki/한국어').find(x => x.type === 'autolink')).toEqual({ type: 'autolink', href: 'https://ko.wikipedia.org/wiki/' })
    expect(inlines('[한국어](https://ko.wikipedia.org/wiki/한국어)').find(x => x.type === 'link')).toMatchObject({ href: 'https://ko.wikipedia.org/wiki/한국어' })
    const src = (require('node:fs') as typeof import('node:fs')).readFileSync(require.resolve('../src/chat/markdown.ts'), 'utf8')
    expect(src).toContain('https://ko.wikipedia.org/wiki/한국어, links only up to /wiki/')
    expect(src).toContain('(`\\*\\*not bold\\*\\*`) keeps its backslashes on screen')
  })

  it('m-7: 답 복사 on an answer cut at the cap says its cut part was not copied (ko, en, ja)', async () => {
    const { copyWord } = await import('../src/components/chat/CodeBlock')
    expect(copyWord('ok', true)).toBe('잘린 부분은 복사되지 않았어요')
    expect(copyWord('ok')).toBe('복사했어요')
    expect(copyWord('fail', true)).toBe('복사하지 못했어요')
    expect(copyWord('idle', true)).toBe('복사')
    const DICTS = (await import('../src/locales/index')).default
    for (const lang of ['en', 'ja'] as const) expect(DICTS[lang]['잘린 부분은 복사되지 않았어요']).toBeTruthy()
    const view = (require('node:fs') as typeof import('node:fs')).readFileSync(require.resolve('../src/components/ChatView.tsx'), 'utf8')
    expect(view).toMatch(/<CopyButton text=\{item\.text\} label=\{t\('답 복사'\)\} cut=\{item\.truncated === true\} \/>/)
  })

  it('m-8: a memoised row follows the language itself', () => {
    const view = (require('node:fs') as typeof import('node:fs')).readFileSync(require.resolve('../src/components/ChatView.tsx'), 'utf8')
    const row = view.slice(view.indexOf('const RowView = React.memo('), view.indexOf('}, (p, n) => p.who === n.who && sameRow(p.row, n.row))'))
    expect(row).toMatch(/useLang\(\)/)
  })

  it('m-9: a group keeps its own open state, never its first call\'s', async () => {
    const { groupOpenKey } = await import('../src/components/chat/ToolGroup')
    expect(groupOpenKey('toolu_fixture01')).not.toBe('toolu_fixture01')
    const fs = require('node:fs') as typeof import('node:fs')
    expect(fs.readFileSync(require.resolve('../src/components/chat/ToolGroup.tsx'), 'utf8')).toMatch(/useRowOpen\(groupOpenKey\(groupKey\), initialOpen\(density \?\? 'default', 'group'\)\)/)
    // (closed until opened, unless the density is 전부)
    expect(fs.readFileSync(require.resolve('../src/components/chat/ToolRow.tsx'), 'utf8')).toMatch(/useRowOpen\(item\.id, initialOpen\(ctx\.density \?\? 'default', 'tool'\)\)/)
  })

  it('m-11: chat.open refusing a session not armed (or off, or not Claude) is said as such, not as a stopped reader', async () => {
    const { openRefusal, createChatStore } = await import('../src/chat/store')
    expect(openRefusal('version')).toBe('version')
    for (const r of ['unarmed', 'off', 'not-claude']) expect(openRefusal(r)).toBe('unarmed')
    expect(openRefusal(undefined)).toBe('worker')
    const store = createChatStore({ open: async () => ({ ok: false, reason: 'unarmed' }) as any, close: () => {}, resync: async () => ({ ok: true }), onUpdate: () => {} } as any)
    store.subscribe('t1', () => {})
    await new Promise(r => setTimeout(r, 0))
    expect(store.get('t1').status?.banner).toEqual({ reason: 'unarmed' })
    const { bannerLine } = await import('../src/components/chat/ChatBanner')
    expect(bannerLine('unarmed', null)).toBe('이 세션은 채팅 보기를 켜기 전에 열렸어요. 다시 열면 채팅으로 볼 수 있어요')
  })

  it('m-14: a tab launched again under the same id scrolls afresh (the memory is per launch)', async () => {
    const { scrollKey } = await import('../src/components/chat/ChatList')
    expect(scrollKey({ id: 't', createdAt: 1 })).not.toBe(scrollKey({ id: 't', createdAt: 2 }))
    expect(scrollKey({ id: 't', createdAt: 1 })).toBe(scrollKey({ id: 't', createdAt: 1 }))
    const view = (require('node:fs') as typeof import('node:fs')).readFileSync(require.resolve('../src/components/ChatView.tsx'), 'utf8')
    expect(view).toMatch(/key=\{scrollKey\(term\)\}\n\s+id=\{scrollKey\(term\)\}/)
  })
})
