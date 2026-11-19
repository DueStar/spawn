/**
 * The composer's / menu (2026-11-19, the owner's report: typing / showed no command menu, and /rc's choices showed only
 * in the terminal): which draft opens it, how it filters, what a pick puts in the draft, its keys, its look, and the
 * dialog card's 취소 and link for a panel a command opened.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { BUILTIN_COMMANDS, COMMAND_PANEL_MS, commandRecent, filterCommands, mergeCommands, noteCommand, slashAt, type SlashCommand } from '../src/chat/slash'
import { keyAction } from '../src/chat/composerKeys'
import { SlashMenu } from '../src/components/chat/SlashMenu'
import { DialogCard } from '../src/components/chat/DialogCard'
import { parseDialog } from '../src/chat/dialog'

const read = (p: string) => readFileSync(join(__dirname, '..', p), 'utf8')
const names = (l: SlashCommand[]) => l.map(c => c.name)

describe('slashAt: the draft that opens the menu', () => {
  it('one token starting with /, the caret in it', () => {
    expect(slashAt('/', 1)).toEqual({ query: '' })
    expect(slashAt('/rc', 3)).toEqual({ query: 'rc' })
    expect(slashAt('/rc', 1)).toEqual({ query: 'rc' })
    expect(slashAt('/plugin:skill', 5)).toEqual({ query: 'plugin:skill' })
  })
  it('not: text after it, a space before it (sent as text), a path, the caret before the /, no /', () => {
    expect(slashAt('/model sonnet', 3)).toBeNull()
    expect(slashAt('/rc ', 4)).toBeNull()
    expect(slashAt(' /rc', 4)).toBeNull()
    expect(slashAt('/usr/bin', 4)).toBeNull()
    expect(slashAt('/rc', 0)).toBeNull()
    expect(slashAt('rc', 2)).toBeNull()
    expect(slashAt('line\n/rc', 8)).toBeNull()
  })
})

describe('filterCommands', () => {
  it('Claude Code\'s own commands, with the ones the owner named', () => {
    const all = names([...BUILTIN_COMMANDS])
    for (const n of ['model', 'effort', 'clear', 'compact', 'resume', 'rename', 'remote-control', 'mcp', 'init', 'status', 'help', 'config', 'memory', 'permissions', 'doctor', 'login', 'logout', 'exit', 'usage']) expect(all, n).toContain(n)
    expect(BUILTIN_COMMANDS.find(c => c.name === 'remote-control')!.aliases).toContain('rc')
    expect(BUILTIN_COMMANDS.find(c => c.name === 'usage')!.aliases).toContain('cost')
    expect(new Set(all).size).toBe(all.length)
  })
  it('a prefix of the name or of an alias, any case; the name\'s own match first', () => {
    expect(names(filterCommands(BUILTIN_COMMANDS, 'rc'))).toEqual(['remote-control'])
    expect(names(filterCommands(BUILTIN_COMMANDS, 'RE')).slice(0, 3)).toEqual(['recap', 'release-notes', 'reload-plugins'])
    expect(names(filterCommands(BUILTIN_COMMANDS, 'mod'))).toEqual(['model'])
    expect(names(filterCommands(BUILTIN_COMMANDS, 'cost'))).toEqual(['usage'])
    expect(filterCommands(BUILTIN_COMMANDS, 'zzz')).toEqual([])
    // an exact name before longer names it starts
    expect(names(filterCommands(BUILTIN_COMMANDS, 'plan'))[0]).toBe('plan')
  })
  it('the empty query: everything, by name; a name seen twice keeps the first (Claude Code\'s own)', () => {
    const list = mergeCommands([{ name: 'clear', desc: 'my clear', kind: 'user' }, { name: 'deploy', desc: 'Ship it', kind: 'project' }])
    const all = filterCommands(list, '', 500)
    expect(all.filter(c => c.name === 'clear')).toHaveLength(1)
    expect(all.find(c => c.name === 'clear')!.kind).toBe('builtin')
    expect(names(all)).toEqual([...names(all)].sort())
    // at the same rank Claude Code's own come before the rest when letters are typed
    expect(names(filterCommands(mergeCommands([{ name: 'coach', desc: '', kind: 'skill' }]), 'co'))).toEqual(['color', 'compact', 'config', 'context', 'copy', 'coach', 'usage'])
  })
})

describe('mergeCommands: what main read, checked again', () => {
  it('names and kinds as they may be; anything else left out', () => {
    const list = mergeCommands([
      { name: 'superpowers:brainstorming', desc: 'Plan first', kind: 'plugin', hint: '<topic>' },
      { name: 'hallmark', desc: 'x'.repeat(400), kind: 'skill' },
      { name: '../evil', desc: '', kind: 'user' },
      { name: 'ok', desc: 3, kind: 'weird' },
      null, 'str', { desc: 'no name' },
    ])
    const mine = list.filter(c => c.kind !== 'builtin')
    expect(mine.map(c => [c.name, c.kind])).toEqual([['superpowers:brainstorming', 'plugin'], ['hallmark', 'skill'], ['ok', 'user']])
    expect(mine[0].hint).toBe('<topic>')
    expect(mine[1].desc).toHaveLength(300)
    expect(mergeCommands('nope')).toHaveLength(BUILTIN_COMMANDS.length)
  })
})

describe('the menu\'s keys (the @ menu\'s: src/chat/composerKeys.ts)', () => {
  const k = (key: string, extra: Partial<Parameters<typeof keyAction>[0]> = {}) => ({ key, shiftKey: false, ctrlKey: false, metaKey: false, altKey: false, ...extra })
  const open = { composing: false, working: true, menuOpen: true, mentionOpen: true, lightbox: false }
  it('↑ ↓ move, Enter and Tab pick, Esc closes the menu and never stops the work', () => {
    expect(keyAction(k('ArrowUp'), open)).toBe('menu-up')
    expect(keyAction(k('ArrowDown'), open)).toBe('menu-down')
    expect(keyAction(k('Enter'), open)).toBe('menu-pick')
    expect(keyAction(k('Tab'), open)).toBe('menu-pick')
    expect(keyAction(k('Escape'), open)).toBe('menu-close')
    expect(keyAction(k('Escape'), { ...open, menuOpen: false })).toBe('menu-close')
    expect(keyAction(k('Enter', { isComposing: true }), open)).toBeNull()
  })
  it('the composer: a pick fills `/name ` and never sends; Enter on a command typed out in full (or one it does not know) sends', () => {
    const src = read('src/components/chat/Composer.tsx')
    expect(src).toContain('replaceRange(el, 0, el.value.length, `/${c.name} `)')
    expect(src).toMatch(/slashOpen && a === 'menu-pick' && e\.key === 'Enter' && \(slashTyped\(sel\) \|\| !n\)\) \{ e\.preventDefault\(\); setSlash\(null\); if \(!busy\) void send\(\); return \}/)
    expect(src).toMatch(/mentionOpen: !!mention \|\| !!slash/)
    expect(src).toContain('chat.commands({ id })')
  })
})

describe('the menu\'s look', () => {
  it('each row: /name, its aliases, a kind for the session\'s own, its description; the chosen row marked', () => {
    const list = filterCommands(mergeCommands([{ name: 'deploy', desc: 'Ship it', kind: 'project' }]), 're')
    const html = renderToStaticMarkup(React.createElement(SlashMenu, { listId: 'm', commands: list, sel: 0, onPick() {}, onHover() {} }))
    expect(html).toContain('<code>/recap</code>')
    expect(html).toContain('<code>/remote-control</code><span class="chat-mi-alias">/rc</span>')
    expect(html).toContain('Control this session from your phone or claude.ai/code')
    expect(html).toMatch(/id="m-0" role="option" aria-selected="true" class="chat-mi cmd sel"/)
    const own = renderToStaticMarkup(React.createElement(SlashMenu, { listId: 'm', commands: filterCommands(mergeCommands([{ name: 'deploy', desc: 'Ship it', kind: 'project' }]), 'dep'), sel: 0, onPick() {}, onHover() {} }))
    expect(own).toContain('<span class="chat-mi-kind">프로젝트</span>')
    expect(renderToStaticMarkup(React.createElement(SlashMenu, { listId: 'm', commands: [], sel: 0, onPick() {}, onHover() {} }))).toContain('맞는 명령이 없어요')
  })
})

describe('main: chat:commands', () => {
  it('is in the preload and the bridge type, for the session id only', () => {
    expect(read('electron/preload.cjs')).toContain("commands: (p) => ipcRenderer.invoke('chat:commands', { id: String(p?.id ?? '') })")
    expect(read('src/desktop.ts')).toContain('commands?(p: { id: string }): Promise<{ ok: true; commands: unknown[] } | { ok: false }>')
  })
})

describe('a panel a command opened: its card', () => {
  const rc = read('tests/fixtures/chat/screens/reconstructed-rc-panel.txt')
  const card = (id: string) => renderToStaticMarkup(React.createElement(DialogCard, { id, dialog: parseDialog(rc)!, dialogKey: async () => ({ ok: true }), read: () => rc }))
  it('shows the rows as buttons and the link whole, to select or copy', () => {
    const html = card('t-link')
    expect(html).toContain('Disconnect this session')
    expect(html).toContain('Scan with your phone to open this session')
    expect(html).toContain('<code><span class="chat-exact">https://claude.ai/code/session_01AbCdEfGhIjKlMnOpQrStUv</span></code>')
    expect(html).toContain('링크 복사')
  })
  it('offers 취소 (Esc) only when the panel came right after the composer sent a command', () => {
    expect(card('t-none')).not.toContain('>취소<')
    noteCommand('t-cmd', Date.now())
    expect(commandRecent('t-cmd', Date.now())).toBe(true)
    expect(commandRecent('t-cmd', Date.now() + COMMAND_PANEL_MS + 1)).toBe(false)
    expect(card('t-cmd')).toContain('>취소<')
  })
  it('the composer: the "continue in the terminal" note only when no dialog is on the screen a moment later', () => {
    const src = read('src/components/chat/Composer.tsx')
    expect(src).toMatch(/if \(parseDialog\(readScreen\(id\)\)\) return/)
    expect(src).toContain('noteCommand(id, Date.now())')
    expect(src).not.toMatch(/if \(r\.command\) say\(/)
  })
})
