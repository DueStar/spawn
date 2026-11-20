/**
 * The page half's review fixes (review-11-17.md), the parts a test can hold without a page:
 * Windows paths and Korean-glued addresses in the markdown (I5, M10), stable block keys (seam),
 * the store when main cannot answer (I3), a sub-agent's rows asked again (I4), where a wait on
 * the user is (I1), the group key (M3), a failed call in words (M5), rows drawn again only when
 * their items change (M9), the per-session memory let go (M16), and a path chip that never runs
 * a file (I7: main side). The rest is checked by the harness flows (chat-scroll, chat-focus, …).
 */

import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { blockKeys, MD_CAP, parseMarkdown, type Block, type Inline } from '../src/chat/markdown'
import { buildRows, unreadAfter } from '../src/chat/rows'
import { createChatStore, EMPTY_CHAT } from '../src/chat/store'
import { toolMeta } from '../src/chat/toolLabel'
import { askChatFocus, forgetChatTerminal, onChatForget, takeChatFocus } from '../src/chat/lensMode'
import type { ChatItem, ChatUpdate, LensStatus, ToolItem } from '../src/chat/types'
import { budget, growthLimit, showGrowth, steadyGrowth } from './timing'

const require = createRequire(import.meta.url)
const { chatOpenPlan, vscodeUrl } = require('../electron/links.cjs')
const ROOT = join(__dirname, '..')
const read = (...p: string[]) => readFileSync(join(ROOT, ...p), 'utf8')

const all = (blocks: Block[]): Inline[] => {
  const out: Inline[] = []
  const inl = (xs: Inline[]) => { for (const x of xs) { out.push(x); if ('children' in x) inl(x.children) } }
  for (const b of blocks) if (b.type === 'para' || b.type === 'heading') inl(b.inline)
  return out
}
const of = (src: string, type: Inline['type']) => all(parseMarkdown(src)).filter(x => x.type === type) as any[]
const textOf = (src: string) => all(parseMarkdown(src)).map(x => ('text' in x ? x.text : x.type === 'autolink' ? x.href : '')).join('')

describe('I5: Windows paths keep their backslashes; an address ends where Korean starts', () => {
  it('a drive path with \\. is one path chip, whole', () => {
    expect(of('경로는 C:\\Users\\me\\proj\\.github\\workflows\\ci.yml:3 이에요', 'path')).toEqual([{ type: 'path', file: 'C:\\Users\\me\\proj\\.github\\workflows\\ci.yml', line: 3, text: 'C:\\Users\\me\\proj\\.github\\workflows\\ci.yml:3' }])
  })
  it('a [id] folder keeps its brackets and makes a chip', () => {
    expect(of('C:\\repo\\src\\[id]\\page.tsx 를 보세요', 'path')).toMatchObject([{ file: 'C:\\repo\\src\\[id]\\page.tsx' }])
  })
  it('a UNC path keeps both leading backslashes, as text: never a chip (re-review I-2)', () => {
    expect(of('UNC \\\\server\\share\\a.ts:2', 'path')).toEqual([])
    expect(textOf('UNC \\\\server\\share\\a.ts:2')).toBe('UNC \\\\server\\share\\a.ts:2')
  })
  it('Hangul, kana and Han end a bare address', () => {
    expect(of('https://example.com에서 확인했어요', 'autolink')).toEqual([{ type: 'autolink', href: 'https://example.com' }])
    expect(of('자세한 건 https://github.com/a/b/pull/12를 보세요', 'autolink')).toEqual([{ type: 'autolink', href: 'https://github.com/a/b/pull/12' }])
    expect(of('https://example.jp/a、それから', 'autolink')).toEqual([{ type: 'autolink', href: 'https://example.jp/a' }])
    expect(of('https://e.x/中文', 'autolink')).toEqual([{ type: 'autolink', href: 'https://e.x/' }])
    expect(textOf('https://example.com에서 확인했어요')).toBe('https://example.com에서 확인했어요')
  })
  it('an escape outside a path still escapes', () => {
    expect(textOf('\\*not em\\* and a\\_b')).toBe('*not em* and a_b')
  })
})

describe('M10: a link with a title, an address in angle brackets', () => {
  it('[a](url "title") is a link to url', () => {
    expect(of('see [a](https://e.x/p "the title") now', 'link')).toEqual([{ type: 'link', href: 'https://e.x/p', children: [{ type: 'text', text: 'a' }] }])
    expect(textOf('see [a](https://e.x/p "the title") now')).toBe('see a now')
  })
  it('<https://x> is the address without its brackets; <not a url> stays text', () => {
    expect(of('go <https://e.x/a> now', 'autolink')).toEqual([{ type: 'autolink', href: 'https://e.x/a' }])
    expect(textOf('go <https://e.x/a> now')).toBe('go https://e.x/a now')
    expect(textOf('a <b> c')).toBe('a <b> c')
  })
  it('the title and bracket paths stay linear on hostile input', () => {
    // by growth (tests/timing.ts): n to 4n near ×4 (held below growthLimit(): 8, 12 on a CI runner), the 4n input
    // (each attack's size before, under MD_CAP) within a generous second
    for (const [unit, n] of [['[a](', 10_000], ['[a](x "', 5_000], ['<h', 20_000], ['<https://', 5_000]] as const) {
      expect(unit.repeat(4 * n).length).toBeLessThanOrEqual(MD_CAP)
      const g = steadyGrowth(k => unit.repeat(k), parseMarkdown, n)
      expect(g.ratio, `${unit}: ${showGrowth(g)}`).toBeLessThan(growthLimit())
      expect(g.large, `${unit}: ${showGrowth(g)}`).toBeLessThan(budget(1000))
    }
  })
})

describe('seam: a block keeps its key as the text streams in', () => {
  it('keys by kind and place among its kind', () => {
    const a = blockKeys(parseMarkdown('one\n\n## h\n\ntwo'))
    const b = blockKeys(parseMarkdown('one\n\n## h\n\ntwo\n\n- x\n\nthree'))
    expect(a).toEqual(['para-0', 'heading-0', 'para-1'])
    expect(b.slice(0, 3)).toEqual(a)
    expect(new Set(b).size).toBe(b.length)
  })
})

describe('M3, M4, M5: the group key, an unknown kind, a failed call in words', () => {
  const read1 = (id: string, order: number): ToolItem => ({ id, order, at: null, kind: 'tool', tool: 'Read', input: { file: `${id}.ts` }, state: 'done' })
  it('a second read joining a single one is not a new message', () => {
    const before = buildRows([{ id: 'u', order: 0, at: null, kind: 'user', text: 'x', images: 0 }, read1('r1', 1)], { dayLabel: String })
    const after = buildRows([{ id: 'u', order: 0, at: null, kind: 'user', text: 'x', images: 0 }, read1('r1', 1), read1('r2', 2)], { dayLabel: String })
    expect(after[after.length - 1].row).toBe('group')
    expect(unreadAfter(before, after)).toBe(0)
  })
  it('a failed Edit, Read or Write says 실패 beside it; a command already says it in its label', () => {
    for (const tool of ['Edit', 'Read', 'Write', 'Grep']) expect(toolMeta({ ...read1('x', 1), tool, state: 'failed' })).toEqual({ text: '실패' })
    expect(toolMeta({ ...read1('x', 1), tool: 'Bash', state: 'failed' })).toBeNull()
  })
})

describe('I3: the store when main cannot answer, and before the reset', () => {
  const STATUS: LensStatus = { state: 'idle', since: null, label: null, banner: null, note: null, version: '2.1.323', hasOlder: false, empty: false }
  function bridge(answers: { open?: unknown; resync?: unknown; reload?: unknown } = {}) {
    let listener: ((u: ChatUpdate) => void) | null = null
    const b = {
      open: vi.fn(async () => answers.open ?? { ok: true }),
      close: vi.fn(),
      resync: vi.fn(async () => answers.resync ?? { ok: true }),
      reload: vi.fn(async () => answers.reload ?? { ok: true }),
      onUpdate: vi.fn((fn: (u: ChatUpdate) => void) => { listener = fn; return () => {} }),
    }
    return { b: b as any, push: (u: ChatUpdate) => listener?.(u) }
  }
  const flush = () => new Promise(r => setTimeout(r, 0))

  it('opened on a busy session the page never heard of: its statuses count until the reset, nothing is resynced', () => {
    const { b, push } = bridge()
    const store = createChatStore(b)
    store.subscribe('t1', () => {})
    push({ id: 't1', rev: 13, ops: [{ op: 'status', status: { ...STATUS, state: 'working' } }] })
    push({ id: 't1', rev: 15, ops: [{ op: 'upsert', items: [] }, { op: 'status', status: { ...STATUS, state: 'waiting' } }] })
    expect(b.resync).not.toHaveBeenCalled()
    expect(store.get('t1').status?.state).toBe('waiting')
    push({ id: 't1', rev: 16, ops: [{ op: 'reset', items: [{ id: 'a', order: 1, at: null, kind: 'text', text: 'a' }], status: STATUS }] })
    expect(store.get('t1').items.map(i => i.id)).toEqual(['a'])
    push({ id: 't1', rev: 18, ops: [{ op: 'status', status: { ...STATUS, banner: { reason: 'stalled' } } }] })
    expect(b.resync).toHaveBeenCalledTimes(1) // a real gap after the reset
    expect(store.get('t1').status?.banner).toEqual({ reason: 'stalled' }) // its status taken all the same
  })

  it('open answered { ok: false }: the view says it cannot read (a banner), never a blank pane', async () => {
    const { b } = bridge({ open: { ok: false } })
    const store = createChatStore(b)
    const seen = vi.fn()
    store.subscribe('t1', seen)
    await flush()
    expect(store.get('t1').status?.banner).toEqual({ reason: 'worker' })
    expect(seen).toHaveBeenCalled()
    const { b: b2 } = bridge({ open: { ok: false, reason: 'version' } })
    const s2 = createChatStore(b2)
    s2.subscribe('t1', () => {})
    await flush()
    expect(s2.get('t1').status?.banner).toEqual({ reason: 'version' })
  })

  it('a resync answered { ok: false }: a banner, and later updates are not dropped', async () => {
    const { b, push } = bridge({ resync: { ok: false } })
    const store = createChatStore(b)
    store.subscribe('t1', () => {})
    push({ id: 't1', rev: 1, ops: [{ op: 'reset', items: [], status: STATUS }] })
    push({ id: 't1', rev: 9, ops: [{ op: 'upsert', items: [] }] })
    await flush()
    expect(store.get('t1').status?.banner).toEqual({ reason: 'worker' })
    push({ id: 't1', rev: 11, ops: [{ op: 'upsert', items: [] }] })
    expect(b.resync).toHaveBeenCalledTimes(2) // asked again: the first is no longer in flight
  })

  it('다시 읽기 answered { ok: false } says so too', async () => {
    const { b } = bridge({ reload: { ok: false } })
    const store = createChatStore(b)
    store.subscribe('t1', () => {})
    store.reload('t1')
    await flush()
    expect(store.get('t1').status?.banner).toEqual({ reason: 'worker' })
    expect(store.get('nobody')).toBe(EMPTY_CHAT)
  })
})

describe('I4: an open Agent row asks for its rows again', () => {
  it('when it has none (main let them go), and when the sub-agent moved on; one request at a time', async () => {
    const { shouldAskAgent } = await import('../src/components/chat/AgentGroup')
    const base = { open: true, inFlight: false, hasRows: false, asked: undefined as { moment: string; rowsSeen: boolean } | undefined, moment: 'done:2' }
    expect(shouldAskAgent(base)).toBe(true)
    expect(shouldAskAgent({ ...base, open: false })).toBe(false)
    expect(shouldAskAgent({ ...base, inFlight: true })).toBe(false)
    expect(shouldAskAgent({ ...base, asked: { moment: 'done:2', rowsSeen: false } })).toBe(false) // asked at this moment, nothing came
    expect(shouldAskAgent({ ...base, asked: { moment: 'done:2', rowsSeen: true } })).toBe(true) // its rows were let go: ask again
    expect(shouldAskAgent({ ...base, hasRows: true, asked: { moment: 'running:1', rowsSeen: true }, moment: 'running:2' })).toBe(true) // it moved on
  })
})

describe('I1: where a wait on the user is', () => {
  it('a waiting row; a sub-agent\'s waiting row is found at its Agent row; a wait with no row at the running Agent row or the bottom', async () => {
    const { findWait } = await import('../src/components/ChatView')
    const STATUS: LensStatus = { state: 'waiting', since: 1, label: null, banner: null, note: null, version: null, hasOlder: false, empty: false }
    const tool = (id: string, extra: Partial<ToolItem> = {}): ToolItem => ({ id, order: 1, at: null, kind: 'tool', tool: 'Bash', input: {}, state: 'running', ...extra })
    expect(findWait([tool('a'), tool('b', { waiting: 'permission' })], STATUS)).toEqual({ kind: 'permission', key: 'b', agents: [] })
    expect(findWait([tool('ag', { tool: 'Agent' }), tool('c', { parent: 'ag', waiting: 'question' })], STATUS)).toEqual({ kind: 'question', key: 'ag', agents: ['ag'] })
    // a sub-agent's permission (status.waitingAgent): its Agent row; the main thread's own, unpaired: none blamed (re-review m-10)
    expect(findWait([tool('ag', { tool: 'Agent' }), tool('x', { tool: 'Task', state: 'done' })], { ...STATUS, waitingAgent: 'a1' })).toEqual({ kind: 'permission', key: 'ag', agents: ['ag'] })
    expect(findWait([tool('ag', { tool: 'Agent', agentId: 'a1' }), tool('ah', { tool: 'Agent', agentId: 'a2' })], { ...STATUS, waitingAgent: 'a1' })).toEqual({ kind: 'permission', key: 'ag', agents: ['ag'] })
    expect(findWait([tool('ag', { tool: 'Agent' }), tool('x', { tool: 'Task', state: 'done' })], STATUS)).toEqual({ kind: 'permission', key: null, agents: [] })
    expect(findWait([tool('a')], STATUS)).toEqual({ kind: 'permission', key: null, agents: [] })
    expect(findWait([tool('a')], { ...STATUS, state: 'working' })).toBeNull()
  })
})

describe('M9: a row is drawn again only when its items changed', () => {
  it('sameRow: the same items are the same row; a replaced item, a new child or a new label is not', async () => {
    const { sameRow } = await import('../src/components/ChatView')
    const item: ChatItem = { id: 'a', order: 1, at: null, kind: 'text', text: 'x' }
    expect(sameRow({ row: 'text', key: 'a', item: item as any }, { row: 'text', key: 'a', item: item as any })).toBe(true)
    expect(sameRow({ row: 'text', key: 'a', item: item as any }, { row: 'text', key: 'a', item: { ...item } as any })).toBe(false)
    const tool = { id: 't', order: 1, at: null, kind: 'tool', tool: 'Agent', input: {}, state: 'running' } as ToolItem
    const kid = { ...tool, id: 'k', parent: 't' }
    expect(sameRow({ row: 'tool', key: 't', item: tool, children: [kid] }, { row: 'tool', key: 't', item: tool, children: [kid] })).toBe(true)
    expect(sameRow({ row: 'tool', key: 't', item: tool, children: [kid] }, { row: 'tool', key: 't', item: tool, children: [kid, { ...kid, id: 'k2' }] })).toBe(false)
    expect(sameRow({ row: 'day', key: 'd', label: '오늘' }, { row: 'day', key: 'd', label: '어제' })).toBe(false)
  })
  it('Widget keeps who the same object while nothing about it changed; rows are memoised', () => {
    expect(read('src', 'Widget.tsx')).toMatch(/const who = useMemo\(\(\) => chatWho\(/)
    expect(read('src', 'components', 'ChatView.tsx')).toMatch(/const RowView = React\.memo\(/)
  })
})

describe('M11, M8: 오늘 / 어제 move on at midnight; rows are measured again for a new width or text step', () => {
  it('the rows are built again when the day changes', () => {
    // (items: the record's, with the composer's provisional bubbles after it)
    // (and when the density changes, or whether older items exist: the first turn's foot)
    expect(read('src', 'components', 'ChatView.tsx')).toMatch(/useMemo\(\(\) => buildRows\(items, \{ dayLabel, density, hasOlder, extra: wild \}\), \[items, lang, today, density, hasOlder, wild\]\)/)
  })
  it('the measured heights are forgotten on a new width or a class change of <html> (the text step)', () => {
    const src = read('src', 'components', 'chat', 'ChatList.tsx')
    expect(src).toMatch(/new MutationObserver\(forget\)/)
    expect(src).toMatch(/attributeFilter: \['class'\]/)
    expect(src).toMatch(/if \(el\.clientWidth !== width\) \{ width = el\.clientWidth; forget\(\) \}/)
  })
})

describe('M16: a session gone takes its chat memory with it', () => {
  it('forgetChatTerminal reaches every registered memory', () => {
    const seen: string[] = []
    onChatForget(id => seen.push(`a:${id}`))
    onChatForget(id => seen.push(`b:${id}`))
    forgetChatTerminal('t9')
    expect(seen).toEqual(['a:t9', 'b:t9'])
    for (const f of ['ChatList.tsx', 'context.ts', 'AgentGroup.tsx']) expect(read('src', 'components', 'chat', f), f).toMatch(/onChatForget\(/)
    expect(read('src', 'Widget.tsx')).toMatch(/forgetChatTerminal\(id\)/)
  })
})

describe('I7: a path chip in the chat never runs a file', () => {
  it('the editor when one answers, at the line; otherwise the folder — never the default app', () => {
    const abs = 'C:\\Users\\user\\work\\demo\\setup.cmd'
    expect(chatOpenPlan(abs, { line: 3, col: 2, hasScheme: (s: string) => s === 'vscode', platform: 'win32' })).toEqual({ url: `${vscodeUrl(abs, { platform: 'win32' })}:3:2` })
    expect(chatOpenPlan(abs, { hasScheme: (s: string) => s === 'cursor', platform: 'win32' })).toEqual({ url: vscodeUrl(abs, { scheme: 'cursor', platform: 'win32' }) })
    expect(chatOpenPlan(abs, { line: 3, hasScheme: () => false, platform: 'win32' })).toEqual({ folder: abs })
  })
  it('a page, a PDF or a picture (no line) opens to be looked at, in its default app; nothing that runs ever does', () => {
    const at = (f: string) => ['C:', 'Users', 'user', 'work', 'demo', f].join(String.fromCharCode(92))
    for (const f of ['report.html', 'page.HTM', 'doc.pdf', 'shot.png', 'a.jpg', 'b.jpeg', 'c.gif', 'd.webp']) {
      expect(chatOpenPlan(at(f), { hasScheme: (s: string) => s === 'vscode', platform: 'win32' }), f).toEqual({ view: at(f) })
    }
    // with a line it is code to read: the editor
    expect(chatOpenPlan(at('report.html'), { line: 4, hasScheme: (s: string) => s === 'vscode', platform: 'win32' })).toEqual({ url: `${vscodeUrl(at('report.html'), { platform: 'win32' })}:4` })
    for (const f of ['setup.cmd', 'run.bat', 'x.ps1', 'a.js', 'a.exe', 'a.lnk', 'a.url', 'a.svg', 'a.hta', 'a.html.cmd', 'a.vbs', 'a.msi']) {
      expect(chatOpenPlan(at(f), { hasScheme: () => false, platform: 'win32' }), f).toEqual({ folder: at(f) })
    }
  })
  it('main: a chat-origin call takes that way before anything else, and calls no shell.openPath', () => {
    const main = read('electron', 'main.cjs')
    const at = main.indexOf("ipcMain.handle('terminals:open-path'")
    const body = main.slice(at, main.indexOf("ipcMain.handle('terminals:rename'", at))
    const chat = body.slice(body.indexOf("if (from === 'chat')"), body.indexOf('    if (!term ||'))
    // its own checks first (links.cjs openFromChat), before any of the 1.4.0 lines touch the file system (re-review I-2)
    expect(body.indexOf("if (from === 'chat')")).toBeGreaterThan(0)
    expect(body.indexOf("if (from === 'chat')")).toBeLessThan(body.indexOf('fs.statSync'))
    expect(chat).toMatch(/return openFromChat\(term, file, \{/)
    expect(chat).toMatch(/shell\.showItemInFolder\(abs\)/)
    // (the default app only through openView, which links.cjs calls for a page, a PDF or a picture alone)
    expect(chat).toMatch(/openView: \(abs\) => shell\.openPath\(abs\)/)
    expect(chat.replace(/openView: \(abs\) => shell\.openPath\(abs\)/, '')).not.toMatch(/shell\.openPath|statSync|resolveRef/)
    expect(body).toContain(`    if (!term || typeof file !== 'string' || file.length > 1024) return false
    const abs = resolveRef(term.cwd, file)
    try { if (!fs.statSync(abs).isFile()) return false } catch { return false }
    if (!(Number(line) > 0)`)
    // a terminal's Ctrl+click: the 1.4.0 lines, as they were
    expect(body).toContain(`    if (!(Number(line) > 0) && VIEW_IN_DEFAULT_APP.has(path.extname(abs).toLowerCase())) {
      return (await shell.openPath(abs)) === ''
    }
    const at = \`\${Number(line) > 0 ? \`:\${Math.floor(Number(line))}\` : ''}\${Number(line) > 0 && Number(col) > 0 ? \`:\${Math.floor(Number(col))}\` : ''}\`
    for (const scheme of ['vscode', 'cursor']) {
      if (app.getApplicationNameForProtocol(\`\${scheme}://\`)) {
        await shell.openExternal(\`\${vscodeUrl(abs, { scheme })}\${at}\`)
        return true
      }
    }
    return (await shell.openPath(abs)) === ''`)
  })
  it('the preload sends the 1.4.0 payload for a terminal and adds from: chat only for the chat', () => {
    const preload = read('electron', 'preload.cjs')
    expect(preload).toContain("openPath: (id, file, line, col, opts) => ipcRenderer.invoke('terminals:open-path', opts && opts.from === 'chat' ? { id, file, line, col, from: 'chat' } : { id, file, line, col }),")
    expect(read('src', 'chat', 'lensMode.ts')).toMatch(/terminals\.openPath\(id, file, line, col, \{ from: 'chat' \}\)/)
    expect(read('src', 'components', 'TerminalPanel.tsx')).not.toMatch(/from: 'chat'/)
  })
})

describe('I2: the conversation takes the focus only right after it was asked for', () => {
  it('nothing asked: never; asked: once, within two seconds', () => {
    expect(takeChatFocus()).toBe(false)
    askChatFocus()
    expect(takeChatFocus()).toBe(true)
    expect(takeChatFocus()).toBe(false) // once
    askChatFocus()
    expect(takeChatFocus(Date.now() + 2500)).toBe(false) // a view drawn later on its own takes nothing
  })
  it('the list never takes it from an input, a textarea, contenteditable or a terminal in view; the view asks only through takeChatFocus', () => {
    const list = read('src', 'components', 'chat', 'ChatList.tsx')
    expect(list).toMatch(/if \(el && !isTypingTarget\(document\.activeElement\)\) el\.focus\(/)
    expect(list).toMatch(/tag === 'INPUT' \|\| tag === 'TEXTAREA'/)
    expect(list).toMatch(/isContentEditable/)
    expect(list).not.toMatch(/autoFocus/)
    expect(read('src', 'components', 'ChatView.tsx')).toMatch(/takeChatFocus\(\)\) listRef\.current\.focus\(\)/)
    const widget = read('src', 'Widget.tsx')
    expect(widget).toMatch(/if \(m === 'chat'\) askChatFocus\(\)/)
    expect(widget).toMatch(/lastShownSid\.current !== lensSid\) askChatFocus\(\)/)
  })
})
