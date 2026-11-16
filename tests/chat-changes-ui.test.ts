/**
 * The 변경 사항 panel (Phase 5, Task 5.4): the file tree over the index's files, the gaps between a
 * single edit's hunks, each edit drawn on its own and in order from what the transcript recorded (a
 * missing, cut or stale edit said so in the plan's words), the session header unchanged without the
 * chat's tools, the left panel's auto-fold never stored, and every string in ko / en / ja.
 */

import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { FIX } from './chat-helpers'
import { GAME_WORDS } from './helpers'
import chat from '../src/locales/chat'

vi.mock('../src/i18n', async (orig) => ({
  ...(await orig<typeof import('../src/i18n')>()),
  t: (k: string, v?: Record<string, unknown>) => k.replace(/\{(\w+)\}/g, (_, n) => String(v?.[n] ?? '')),
}))

const require = createRequire(import.meta.url)
const { createChangeIndex, scanChanges, readEdit } = require('../electron/chatChanges.cjs')

const ROOT = join(__dirname, '..')
const CWD = 'C:\\Users\\user\\work\\demo'
const MAIN = join(FIX, 'changes.jsonl')
const AGENT = join(FIX, 'changes-agent', 'subagents', 'agent-afixture02.jsonl')
const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/[^\n]*/g, '$1')

/** The index over changes.jsonl and its sub-agent, as the worker builds it */
async function indexed() {
  const index = createChangeIndex({ cwd: CWD })
  await scanChanges(MAIN, index, {})
  for (const a of index.agents()) await scanChanges(AGENT, index, { src: a.agentId })
  return index
}
/** A file's edits as chat:change-file answers them (each re-read from its line) */
async function editsOf(index: any, file: string) {
  const got = index.editsOf(file)
  const out = []
  for (const e of got.edits) {
    const r = await readEdit(e.src.file === 'main' ? MAIN : AGENT, e, { cwd: CWD })
    out.push({ toolId: e.toolId, order: e.order, at: e.at, ...(e.agentId ? { agentId: e.agentId } : {}), kind: e.kind, added: e.added, removed: e.removed, state: e.state, ...(r.state === 'ok' ? { diff: r.diff } : {}) })
  }
  return out
}

let index: any
beforeAll(async () => { index = await indexed() })

describe('fileTree', () => {
  it('over changes.jsonl: folders first, then files, alphabetical; the files outside the folder in their own group, last', async () => {
    const { fileTree } = await import('../src/chat/changes')
    const shape = (nodes: any[]): any[] => nodes.map(n => (n.kind === 'dir' ? { dir: n.name, ...(n.outside ? { outside: true } : {}), children: shape(n.children) } : n.file.file))
    expect(shape(fileTree(index.files()))).toEqual([
      { dir: 'notebooks', children: ['notebooks/rivers.ipynb'] },
      { dir: 'src', children: ['src/config.js', 'src/math.js', 'src/rivers.js', 'src/util.js'] },
      'README.md',
      { dir: '세션 폴더 밖', outside: true, children: ['C:\\Users\\user\\other\\x.txt'] },
    ])
  })

  it('a folder whose only child is a folder is joined with it (src/app/account)', async () => {
    const { fileTree } = await import('../src/chat/changes')
    const f = (file: string) => ({ file, outside: false, created: false, edits: 1, added: 1, removed: 0, unknown: 0, cut: false, agent: false, last: 1 })
    const tree = fileTree([f('src/app/account/page.tsx'), f('src/app/account/B.ts'), f('src/lib/a.ts'), f('tests/t.ts'), f('a/b/c/d.ts')])
    const shape = (nodes: any[]): any[] => nodes.map(n => (n.kind === 'dir' ? { dir: n.name, children: shape(n.children) } : n.name))
    expect(shape(tree)).toEqual([
      { dir: 'a/b/c', children: ['d.ts'] },
      { dir: 'src', children: [{ dir: 'app/account', children: ['B.ts', 'page.tsx'] }, { dir: 'lib', children: ['a.ts'] }] },
      { dir: 'tests', children: ['t.ts'] },
    ])
  })
})

describe('the lines between two hunks of one edit', () => {
  it('counted from the hunks\' own starts: the replace_all edit of math.js has 41 unchanged lines between its two', async () => {
    const { unchangedBetween } = await import('../src/chat/changes')
    const c02 = (await editsOf(index, 'src/math.js')).find(e => e.toolId === 'toolu_fixture_c02')!
    expect(c02.diff.hunks).toHaveLength(2)
    expect(unchangedBetween(c02.diff.hunks[0], c02.diff.hunks[1])).toBe(41)
  })
  it('a hunk with no old lines sits after its start line; nothing negative is ever said', async () => {
    const { unchangedBetween } = await import('../src/chat/changes')
    const h = (oldStart: number, ts: string) => ({ oldStart, newStart: oldStart, lines: [...ts].map(t => ({ t, old: null, new: null, text: '' })) })
    expect(unchangedBetween(h(5, '+'), h(9, ' '))).toBe(3)
    expect(unchangedBetween(h(1, '  '), h(6, '+'))).toBe(4)
    expect(unchangedBetween(h(1, '   '), h(4, ' '))).toBe(0)
    expect(unchangedBetween(h(10, ' '), h(4, ' '))).toBe(null)
  })
})

describe('an edit as the panel draws it', () => {
  const render = async (edit: any, n = 1) => {
    const { EditSection } = await import('../src/components/chat/ChangesPanel')
    return renderToStaticMarkup(React.createElement(EditSection as any, { edit, n, onReload() {}, onLoad() {} }))
  }

  it('the edits of math.js, each on its own and in order; the sub-agent\'s marked as theirs', async () => {
    const edits = await editsOf(index, 'src/math.js')
    expect(edits.map(e => e.toolId)).toEqual(['toolu_fixture_c01', 'toolu_fixture_c02', 'toolu_fixture_ca1', 'toolu_fixture_c12'])
    const html = await Promise.all(edits.map((e, i) => render(e, i + 1)))
    expect(html[0]).toContain('수정 1')
    expect(html[2]).toContain('보조 에이전트의 수정')
    for (const i of [0, 1, 3]) expect(html[i]).not.toContain('보조 에이전트의 수정')
    // the two hunks of one edit: the gap between them said once; no gap line between edits
    expect(html[1].match(/⋯ 41줄 그대로/g)).toHaveLength(1)
    for (const i of [0, 2, 3]) expect(html[i]).not.toContain('줄 그대로')
    // every line the record holds, as recorded (never composed with another edit's)
    for (const [i, e] of edits.entries()) {
      const lines = e.diff.hunks.flatMap((h: any) => h.lines)
      expect((html[i].match(/class="chat-dl/g) ?? []).length).toBe(lines.length)
    }
  })

  it('a created file says 새 파일', async () => {
    const [util] = await editsOf(index, 'src/util.js')
    expect(await render(util)).toContain('새 파일')
  })

  it('a missing patch is said, with no line and no count', async () => {
    const [config] = await editsOf(index, 'src/config.js')
    expect(config.state).toBe('missing')
    const html = await render(config)
    expect(html).toContain('이 수정의 내용은 기록에 없어요 · 터미널에서 보세요')
    expect(html).not.toMatch(/class="chat-dl/)
    expect(html).not.toMatch(/\+0|−0/)
  })

  it('a cut edit says 잘림', async () => {
    const [rivers] = await editsOf(index, 'src/rivers.js')
    expect(rivers.diff.truncated).toBe(true)
    expect(await render(rivers)).toContain('잘림')
    expect(await render({ ...rivers, diff: { ...rivers.diff, truncated: undefined, hidden: 12 } })).toContain('12줄은 터미널에서 보세요')
  })

  it('a stale edit says the record changed, with 다시 읽기; no line', async () => {
    const [readme] = await editsOf(index, 'README.md')
    const { diff, ...rest } = readme
    const html = await render({ ...rest, state: 'stale' })
    expect(html).toContain('기록이 바뀌어서 이 수정을 다시 읽지 못했어요')
    expect(html).toContain('다시 읽기')
    expect(html).not.toMatch(/class="chat-dl/)
  })
})

describe('the panel\'s fixed words', () => {
  it('the foot says only Edit and Write changes are listed; totals are labelled sums', async () => {
    const src = readFileSync(join(ROOT, 'src', 'components', 'chat', 'ChangesPanel.tsx'), 'utf8')
    expect(src).toContain("t('Edit·Write로 바꾼 것만 보여요. 명령으로 바꾼 파일은 터미널에서 확인해 주세요')")
    expect(src).toContain("t('수정 {n}번의 줄 수를 더한 값이에요'")
    expect(src).toContain("t('이 대화에서 바뀐 파일이 아직 없어요')")
    // the panel reads only what chat:change-file answers: no file of the project, no merge
    expect(code(src)).not.toMatch(/openPath|readFile|terminals\./)
  })
})

describe('SessionHeader', () => {
  const props = {
    parts: { picture: 'pokemon' as const, name: '로그인 리다이렉트 고치기', branch: 'fix/login-redirect', project: 'shop-web' },
    sprite: '/sprites/pokemon/icon/27.png', cwd: 'C:/code/shop-web', renaming: false,
    onRenameStart() {}, onRenameCommit() {}, onRenameCancel() {}, closing: false, onClose() {}, onCloseCancel() {},
  }
  // Captured from the component before the chat's tools were added (Task 5.4): without `chatTools` the header stays this
  const CAP_CHAT = '<div class="w-sess-head" title="C:/code/shop-web"><img class="w-sess-head-pic" src="/sprites/pokemon/icon/27.png" alt="" draggable="false"/><span class="w-sess-head-name" title="더블클릭해서 세션 이름 바꾸기">로그인 리다이렉트 고치기</span><span class="w-row-branch w-sess-head-branch" title="git 브랜치">fix/login-redirect</span><span class="w-sess-head-proj">shop-web</span><span class="w-sess-head-spacer"></span><div class="w-lens" role="group" aria-label="보기 방식"><button type="button" class="on" aria-pressed="true" title="채팅"><svg class="ico" width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2.5 3.5h11v7.5H7l-3 2.5V11H2.5z"></path></svg><span class="w-lens-word">채팅</span></button><button type="button" aria-pressed="false" title="터미널"><svg class="ico" width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="1.8" y="2.8" width="12.4" height="10.4" rx="1.8"></rect><path d="M4.5 6.5 6.5 8l-2 1.5M8 10h3"></path></svg><span class="w-lens-word">터미널</span></button><span class="w-lens-note" role="status"></span></div><button class="w-sess-head-close" title="세션 닫기" aria-label="세션 닫기">×</button></div>'
  const CAP_TERM = '<div class="w-sess-head" title="C:/code/shop-web"><img class="w-sess-head-pic" src="/sprites/pokemon/icon/27.png" alt="" draggable="false"/><span class="w-sess-head-name" title="더블클릭해서 세션 이름 바꾸기">로그인 리다이렉트 고치기</span><span class="w-row-branch w-sess-head-branch" title="git 브랜치">fix/login-redirect</span><span class="w-sess-head-proj">shop-web</span><span class="w-sess-head-spacer"></span><div class="w-lens" role="group" aria-label="보기 방식"><button type="button" aria-pressed="false" title="채팅"><svg class="ico" width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2.5 3.5h11v7.5H7l-3 2.5V11H2.5z"></path></svg><span class="w-lens-word">채팅</span></button><button type="button" class="on" aria-pressed="true" title="터미널"><svg class="ico" width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="1.8" y="2.8" width="12.4" height="10.4" rx="1.8"></rect><path d="M4.5 6.5 6.5 8l-2 1.5M8 10h3"></path></svg><span class="w-lens-word">터미널</span></button><span class="w-lens-note" role="status"></span></div><button class="w-sess-head-close" title="세션 닫기" aria-label="세션 닫기">×</button></div>'

  it('without `chatTools` the markup is exactly as captured before', async () => {
    const { SessionHeader } = await import('../src/components/SessionHeader')
    expect(renderToStaticMarkup(React.createElement(SessionHeader, { ...props, lens: { mode: 'chat', enabled: true, reason: null, onMode() {} } }))).toBe(CAP_CHAT)
    expect(renderToStaticMarkup(React.createElement(SessionHeader, { ...props, lens: { mode: 'terminal', enabled: true, reason: null, onMode() {} } }))).toBe(CAP_TERM)
  })

  it('with `chatTools`: a group before the flip, nothing else changed', async () => {
    const { SessionHeader } = await import('../src/components/SessionHeader')
    const html = renderToStaticMarkup(React.createElement(SessionHeader, { ...props, lens: { mode: 'chat', enabled: true, reason: null, onMode() {} }, chatTools: React.createElement('button', { className: 'probe' }, 'x') }))
    expect(html).toContain('<div class="w-chat-tools"><button class="probe">x</button></div><div class="w-lens"')
    expect(html.replace('<div class="w-chat-tools"><button class="probe">x</button></div>', '')).toBe(CAP_CHAT)
  })

  it('(5.11 sweep) the narrowest header (260px: 560 wide, a Mac\'s panel open) keeps its controls whole: only inside the chat tools\' container, the counts and the project give way', () => {
    const css = readFileSync(join(ROOT, 'src', 'styles', 'widget-expanded.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
    // the container exists only while the chat's tools are in the header (the terminal's header is as it was)
    expect(css).toMatch(/\.w-sess-head:has\(> \.w-chat-tools\) \{ container: sess-head \/ inline-size; \}/)
    const at = css.indexOf('@container sess-head (max-width: 420px)')
    expect(at).toBeGreaterThan(0)
    const block = css.slice(at, css.indexOf('\n}', at))
    expect(block).toMatch(/\.w-chg-counts \{ display: none; \}/)
    expect(block).toMatch(/\.w-sess-head-proj \{ flex: 0 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; \}/)
    // the button's name keeps the counts when they are not drawn
    const panel = readFileSync(join(ROOT, 'src', 'components', 'chat', 'ChangesPanel.tsx'), 'utf8')
    expect(panel).toMatch(/aria-label=\{name\}/)
    // outside the container the project's name keeps 1.4.0's rule
    expect(css).toMatch(/\n\.w-sess-head-proj \{ flex: none; font-size: var\(--t-meta\); color: var\(--ink-3\); white-space: nowrap; \}/)
  })
})

describe('Widget.tsx', () => {
  const src = code(readFileSync(join(ROOT, 'src', 'Widget.tsx'), 'utf8'))
  it('the auto-fold is derived: spawn-side-hidden is written only by the user\'s own toggle', () => {
    expect(src).toMatch(/autoFold\(/)
    expect((src.match(/setSideHidden\(/g) ?? []).length).toBe(1)
    for (const line of src.split('\n').filter(l => /setSideHidden\(|spawn-side-hidden/.test(l))) {
      expect(line).not.toMatch(/autoFold|foldNow/)
      expect(line).not.toMatch(/changesOpen|setChangesOpen/)
    }
    expect(src).toMatch(/const toggleSide = \(\) => setSideHidden\(v => \{ const next = !v; try \{ localStorage\.setItem\('spawn-side-hidden', next \? '1' : '0'\) \} catch \{\} ; return next \}\)/)
  })
  it('the panel only in the chat of a window, open and with room', () => {
    expect(src).toMatch(/lensMode === 'chat' && view === 'terminal' && mode !== 'widget' && changesOpen && canOpen\(/)
  })
  it('the chat\'s tools only in chat mode, loaded lazily', () => {
    expect(src).toMatch(/chatTools=\{lensMode === 'chat'/)
    expect(src).not.toMatch(/import [^\n]*from '\.\/components\/chat\/ChangesPanel'/)
  })
})

describe('strings', () => {
  const KEYS = [
    '변경 사항', '변경 사항 보기', '변경 사항 닫기', '파일 {n}개 · 수정 {m}번', '변경 사항을 모으는 중…',
    '기록이 너무 길어서 앞부분의 변경은 다 모으지 못했어요', '이 대화에서 바뀐 파일이 아직 없어요',
    'Edit·Write로 바꾼 것만 보여요. 명령으로 바꾼 파일은 터미널에서 확인해 주세요', '세션 폴더 밖', '수정 {n}',
    '보조 에이전트의 수정', '일부 모름', '수정 {n}번의 줄 수를 더한 값이에요', '⋯ {n}줄 그대로',
    '이 수정의 내용은 기록에 없어요 · 터미널에서 보세요', '기록이 바뀌어서 이 수정을 다시 읽지 못했어요',
    '이전 수정 {n}번 더 보기', '보조 에이전트 {n}개의 변경은 읽지 못했어요', '편집기에서 열기',
    '창이 좁아서 변경 사항을 열 수 없어요', '변경 사항 패널 폭', '파일 목록', '끌어서 폭 조절 · 두 번 누르면 기본',
    '이 수정 보기',
  ]
  it('every new key in en and ja (the panel\'s own in chat.ts), none of the game\'s words', async () => {
    const DICTS = (await import('../src/locales')).default
    for (const k of KEYS) {
      // (the resize handle's tooltip is the left panel's, already in widget.ts)
      if (k !== '끌어서 폭 조절 · 두 번 누르면 기본') {
        expect(chat.en[k], `en: ${k}`).toBeTruthy()
        expect(chat.ja[k], `ja: ${k}`).toBeTruthy()
      }
      expect(DICTS.en[k], `en: ${k}`).toBeTruthy()
      expect(DICTS.ja[k], `ja: ${k}`).toBeTruthy()
      expect(GAME_WORDS.test(k), k).toBe(false)
      expect(GAME_WORDS.test(DICTS.en[k] ?? ''), k).toBe(false)
      expect(GAME_WORDS.test(DICTS.ja[k] ?? ''), k).toBe(false)
    }
  })
  it('the plan\'s English and Japanese', () => {
    expect(chat.en['파일 {n}개 · 수정 {m}번']).toBe('{n} {n|file|files} · {m} {m|edit|edits}')
    expect(chat.ja['파일 {n}개 · 수정 {m}번']).toBe('ファイル{n}個・編集{m}回')
    expect(chat.en['⋯ {n}줄 그대로']).toBe('⋯ {n} {n|line|lines} unchanged')
    expect(chat.en['보조 에이전트의 수정']).toBe("A sub-agent's edit")
  })
})
