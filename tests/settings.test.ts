/**
 * electron/settings.cjs — the 설정 values: checked on the way in, the
 * notification filter, claude's extra arguments, the file.
 */

import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const { DEFAULTS, SCROLLBACKS, sanitize, applyPatch, toastAllowed, inQuietHours, claudeArgs, createSettingsStore } = require('../electron/settings.cjs')

const at = (hh: number, mm = 0) => new Date(2026, 10, 8, hh, mm)

describe('settings', () => {
  it('keeps the shape of the defaults: unknown keys dropped, wrong types and values fall back', () => {
    const s = sanitize({ notify: { flee: 'no', duration: 'forever', quietFrom: '25:00', extra: 1 }, session: { model: 'gpt', permissionMode: 'bypassPermissions' }, hacker: {} })
    expect(s).toEqual(DEFAULTS)
    expect(sanitize(null)).toEqual(DEFAULTS)
  })

  it('a patch changes only what it names', () => {
    const s = applyPatch(sanitize(null), { notify: { flee: false }, session: { model: 'sonnet' } })
    expect(s.notify.flee).toBe(false)
    expect(s.notify.catch).toBe(true)
    expect(s.session.model).toBe('sonnet')
    // a bad value in a later patch keeps the current one, not the default
    expect(applyPatch(s, { session: { model: 'nope' } }).session.model).toBe('sonnet')
  })

  it('filters notifications by kind, rarity and quiet hours', () => {
    const s = sanitize(null)
    const common = { kind: 'catch', tier: 'common', shiny: false }
    expect(toastAllowed(common, s, at(12))).toBe(true)
    expect(toastAllowed({ kind: 'sendout' }, s, at(12))).toBe(false)
    expect(toastAllowed({ kind: 'flee', tier: 'common' }, applyPatch(s, { notify: { flee: false } }), at(12))).toBe(false)
    const rare = applyPatch(s, { notify: { rareOnly: true } })
    expect(toastAllowed(common, rare, at(12))).toBe(false)
    expect(toastAllowed({ ...common, shiny: true }, rare, at(12))).toBe(true)
    expect(toastAllowed({ ...common, tier: 'rare' }, rare, at(12))).toBe(true)
    expect(toastAllowed({ kind: 'levelup' }, rare, at(12))).toBe(true) // rarity is for catches and escapes
    const quiet = applyPatch(s, { notify: { quiet: true, quietFrom: '23:00', quietTo: '08:00' } })
    expect(toastAllowed(common, quiet, at(23, 30))).toBe(false)
    expect(toastAllowed(common, quiet, at(7, 59))).toBe(false)
    expect(toastAllowed(common, quiet, at(8, 0))).toBe(true)
    expect(inQuietHours({ ...quiet.notify, quietFrom: '13:00', quietTo: '14:00' }, at(13, 30))).toBe(true)
    expect(inQuietHours({ ...quiet.notify, quietFrom: '13:00', quietTo: '14:00' }, at(14, 0))).toBe(false)
  })

  it('turns the session settings into claude arguments', () => {
    expect(claudeArgs(DEFAULTS.session)).toEqual([])
    expect(claudeArgs({ ...DEFAULTS.session, model: 'opus', permissionMode: 'plan' })).toEqual(['--model', 'opus', '--permission-mode', 'plan'])
    expect(applyPatch(sanitize(null), { session: { permissionMode: 'auto' } }).session.permissionMode).toBe('auto')
  })

  it('a saved 50000-line scrollback (the choice before 10000 became the most) becomes 10000', () => {
    expect(sanitize({ terminal: { scrollback: 50000, font: 'default' } }).terminal.scrollback).toBe(10000)
  })

  it('checks the terminal settings: scrollback from its list, a known font', () => {
    expect(DEFAULTS.terminal).toEqual({ scrollback: 5000, font: 'default' })
    const s = applyPatch(sanitize(null), { terminal: { scrollback: 10000, font: 'd2coding' } })
    expect(s.terminal).toEqual({ scrollback: 10000, font: 'd2coding' })
    expect(applyPatch(s, { terminal: { font: 'cascadia' } }).terminal).toEqual({ scrollback: 10000, font: 'cascadia' })
    // a number off the list, a string number, a negative, an unknown or CSS font: the current value stays
    for (const bad of [{ scrollback: 1234 }, { scrollback: '10000' }, { scrollback: -1 }, { scrollback: Infinity }, { font: 'Comic Sans' }, { font: "x'; }" }, { font: 3 }]) {
      expect(applyPatch(s, { terminal: bad }).terminal).toEqual(s.terminal)
    }
    expect(sanitize({ terminal: { scrollback: 999999, font: 'Arial', extra: true } }).terminal).toEqual(DEFAULTS.terminal)
    for (const n of [1000, 5000, 10000]) expect(applyPatch(s, { terminal: { scrollback: n } }).terminal.scrollback).toBe(n)
    expect(SCROLLBACKS).toEqual([1000, 5000, 10000])
    for (const f of ['default', 'consolas', 'cascadia', 'd2coding']) expect(applyPatch(s, { terminal: { font: f } }).terminal.font).toBe(f)
  })

  it('reads and writes its file; a broken file means the defaults', () => {
    const dir = mkdtempSync(join(tmpdir(), 'spawn-settings-'))
    const file = join(dir, 'settings.json')
    const store = createSettingsStore(file)
    // (a first start gives the chat view's default once: 1.10.5; and the user's own list order: 1.10.11)
    const FIRST = { ...DEFAULTS, session: { ...DEFAULTS.session, chatViewOn: true, manualOrderOn: true } }
    expect(store.get()).toEqual(FIRST)
    store.set({ app: { startHidden: true } })
    expect(JSON.parse(readFileSync(file, 'utf8')).app.startHidden).toBe(true)
    expect(createSettingsStore(file).get().app.startHidden).toBe(true)
    writeFileSync(file, '{ broken')
    expect(createSettingsStore(file).get()).toEqual(FIRST)
  })
})

describe('terminal font per platform', () => {
  it('keeps the stored value consolas but shows and renders Menlo on a Mac', async () => {
    const { termFontStack, termFontLabel, TERM_FONT_STACKS } = await import('../src/termFont')
    expect(termFontLabel('consolas', true)).toBe('Menlo')
    expect(termFontLabel('consolas', false)).toBe('Consolas')
    expect(termFontStack('consolas', true).startsWith('Menlo, ')).toBe(true)
    expect(termFontStack('consolas', true)).not.toContain('Consolas')
    // Windows: unchanged choice, still led by Consolas
    expect(termFontStack('consolas', false)).toBe(TERM_FONT_STACKS.consolas)
    expect(TERM_FONT_STACKS.consolas.startsWith("Consolas, 'Pretendard Variable', 'Malgun Gothic', ")).toBe(true)
    for (const f of ['default', 'cascadia', 'd2coding'] as const) expect(termFontLabel(f, true)).toBe(termFontLabel(f, false))
  })

  it("Windows stacks are main's, untouched by the Mac ones", async () => {
    const { termFontStack, TERM_FONT_STACKS } = await import('../src/termFont')
    // main (fonts bundled, 8f78a7e): Consolas before the proportional faces in the default
    const before = {
      default: "'Monaspace Neon Var', 'Monaspace Neon', Consolas, 'Pretendard Variable', 'Malgun Gothic', monospace",
      consolas: "Consolas, 'Pretendard Variable', 'Malgun Gothic', monospace",
      cascadia: "'Cascadia Mono', 'Cascadia Code', Consolas, 'Pretendard Variable', 'Malgun Gothic', monospace",
      d2coding: "D2Coding, 'D2Coding ligature', Consolas, 'Pretendard Variable', 'Malgun Gothic', monospace",
    }
    expect(TERM_FONT_STACKS).toEqual(before)
    for (const f of ['default', 'consolas', 'cascadia', 'd2coding'] as const) expect(termFontStack(f, false)).toBe(before[f])
    expect(termFontStack(undefined, false)).toBe(before.default)
  })

  it('a Mac: Menlo (on every Mac) before any proportional or CJK face, for every font setting (CI run 2: spaced-out text)', async () => {
    const { termFontStack, MAC_TERM_FONT_STACKS } = await import('../src/termFont')
    const faces = (stack: string) => stack.split(',').map(f => f.trim().replace(/^'|'$/g, ''))
    // faces that are not monospace: a cell measured from one of them is too wide
    const PROPORTIONAL = ['Pretendard Variable', 'Malgun Gothic', 'Apple SD Gothic Neo', 'Hiragino Sans', 'Uncut Sans Variable', 'system-ui', 'sans-serif']
    // monospace faces that may be missing (installed by the user, or not a system font)
    const OPTIONAL_MONO = ['Monaspace Neon Var', 'Monaspace Neon', 'Cascadia Mono', 'Cascadia Code', 'D2Coding', 'D2Coding ligature']
    for (const f of ['default', 'consolas', 'cascadia', 'd2coding', undefined] as const) {
      const list = faces(termFontStack(f, true))
      const menlo = list.indexOf('Menlo')
      expect(menlo, String(f)).toBeGreaterThanOrEqual(0)
      // everything before Menlo is a monospace face the user may have installed
      for (const face of list.slice(0, menlo)) expect(OPTIONAL_MONO, `${f}: ${face}`).toContain(face)
      // no proportional face before it, and Korean still has its fonts after it
      for (const p of PROPORTIONAL) if (list.includes(p)) expect(list.indexOf(p), `${f}: ${p}`).toBeGreaterThan(menlo)
      expect(list).toContain('Apple SD Gothic Neo')
      expect(list.at(-1)).toBe('monospace')
      expect(list).not.toContain('Consolas')
      expect(list).not.toContain('Malgun Gothic')
    }
    expect(Object.keys(MAC_TERM_FONT_STACKS).sort()).toEqual(['cascadia', 'consolas', 'd2coding', 'default'])
    // the chosen font still comes first when it is there
    expect(faces(termFontStack('default', true))[0]).toBe('Monaspace Neon Var')
    expect(faces(termFontStack('cascadia', true))[0]).toBe('Cascadia Mono')
    expect(faces(termFontStack('d2coding', true))[0]).toBe('D2Coding')
  })
})

describe('UI fonts on a Mac (.is-mac rules)', () => {
  const css = (f: string) => readFileSync(join(__dirname, '..', 'src', 'styles', f), 'utf8')
  const familyOf = (sheet: string, selector: string) => {
    const at = sheet.indexOf(`\n${selector} {`)
    expect(at, selector).toBeGreaterThanOrEqual(0)
    return /font-family:\s*([^;]+);/.exec(sheet.slice(at, sheet.indexOf('}', at)))![1].split(',').map(s => s.trim().replace(/^'|'$/g, ''))
  }

  it('the app text: the same bundled faces first as on Windows; behind them the system face before any CJK face', () => {
    const mac = familyOf(css('widget.css'), '.is-mac .widget')
    const win = familyOf(css('widget.css'), '.widget')
    // the chosen faces (shipped in public/fonts): first, in the same order, on both
    expect(mac.slice(0, 4)).toEqual(['W Uncut', 'Uncut Sans Variable', 'W Pretendard', 'Pretendard Variable'])
    expect(mac.slice(0, 4)).toEqual(win.slice(0, 4))
    expect(mac.indexOf('system-ui')).toBeGreaterThan(3)
    expect(mac.indexOf('system-ui')).toBeLessThan(mac.indexOf('Apple SD Gothic Neo'))
    expect(mac.indexOf('-apple-system')).toBeLessThan(mac.indexOf('Apple SD Gothic Neo'))
    // the shared rule (what Windows draws with): main's faces, then the Mac's fallbacks after Malgun Gothic,
    // which Windows does not have, so it draws as before
    expect(css('widget.css')).toContain("font-family: 'W Uncut', 'Uncut Sans Variable', 'W Pretendard', 'Pretendard Variable', 'Malgun Gothic', 'Apple SD Gothic Neo', 'Hiragino Sans', system-ui, sans-serif;")
  })

  it('the small monospace texts: Menlo before the proportional faces', () => {
    for (const [file, sel] of [['pokedex.css', '.is-mac .w-row-ask-what'], ['widget-expanded.css', '.is-mac .set-mono']]) {
      const f = familyOf(css(file), sel)
      expect(f.indexOf('Menlo'), sel).toBeLessThan(f.indexOf('Pretendard Variable'))
      expect(f.indexOf('Menlo'), sel).toBeLessThan(f.indexOf('Apple SD Gothic Neo'))
    }
  })
})

// The chat view's 설정 switch: stored off, shown only behind the
// features.json switch (electron/features.cjs CHAT_VIEW / src/features.ts)
describe('the chat view setting', () => {
  it('is off by default; only a real boolean is kept', () => {
    // (on by default since 1.10.5)
    expect(sanitize(null).session.chatView).toBe(true)
    expect(DEFAULTS.session.chatView).toBe(true)
    expect(sanitize({ session: { chatView: 'yes' } }).session.chatView).toBe(true)
    expect(sanitize({ session: { chatView: 1 } }).session.chatView).toBe(true)
    expect(sanitize({ session: { chatView: false } }).session.chatView).toBe(false)
    expect(sanitize({ session: { chatView: true } }).session.chatView).toBe(true)
  })

  it('a patch turns it on and off and leaves the rest alone', () => {
    const on = applyPatch(sanitize(null), { session: { chatView: true } })
    expect(on.session.chatView).toBe(true)
    expect(on.session.restoreOnStart).toBe(true)
    expect(applyPatch(on, { session: { chatView: false } }).session.chatView).toBe(false)
  })

  it('the page has the same default', async () => {
    const { DEFAULT_SETTINGS } = await import('../src/settingsStore')
    expect(DEFAULT_SETTINGS.session.chatView).toBe(true)
    expect(DEFAULT_SETTINGS.session).toEqual(DEFAULTS.session)
  })

  it('설정 shows the switch only while the features.json switch is on', () => {
    const view = readFileSync(join(__dirname, '..', 'src', 'components', 'SettingsView.tsx'), 'utf8')
    const at = view.indexOf("t('채팅으로 보기')")
    expect(at).toBeGreaterThan(0)
    expect(view.indexOf("t('채팅으로 보기')", at + 1)).toBe(-1)
    // the row is one expression on one line: {CHAT_VIEW && <Toggle … />}
    const line = view.slice(view.lastIndexOf('\n', at) + 1, view.indexOf('\n', at))
    expect(line.trim()).toMatch(/^\{CHAT_VIEW && <Toggle label=\{t\('채팅으로 보기'\)\}.*\/>\}$/)
  })

  it('link previews: off by default, only a real boolean kept, the page has the same default', async () => {
    expect(DEFAULTS.session.linkPreviews).toBe(false)
    expect(sanitize(null).session.linkPreviews).toBe(false)
    for (const v of ['yes', 1, 'true', null, {}]) expect(sanitize({ session: { linkPreviews: v } }).session.linkPreviews).toBe(false)
    expect(sanitize({ session: { linkPreviews: true } }).session.linkPreviews).toBe(true)
    const on = applyPatch(sanitize(null), { session: { linkPreviews: true } })
    expect(on.session).toMatchObject({ linkPreviews: true, chatView: true })
    expect(applyPatch(on, { session: { linkPreviews: false } }).session.linkPreviews).toBe(false)
    const { DEFAULT_SETTINGS } = await import('../src/settingsStore')
    expect(DEFAULT_SETTINGS.session.linkPreviews).toBe(false)
    // (the harness's fake bridge starts from the same defaults)
    expect(readFileSync(join(__dirname, 'visual', 'fake-bridge.js'), 'utf8')).toMatch(/chatView: false, linkPreviews: false/)
  })

  it('설정 shows 링크 미리보기 only with the features.json switch, right under 채팅으로 보기, disabled while that is off', async () => {
    const view = readFileSync(join(__dirname, '..', 'src', 'components', 'SettingsView.tsx'), 'utf8')
    const chat = view.indexOf("t('채팅으로 보기')")
    const at = view.indexOf("t('링크 미리보기 (채팅)')")
    expect(at).toBeGreaterThan(chat)
    expect(view.indexOf("t('링크 미리보기 (채팅)')", at + 1)).toBe(-1)
    const lineOf = (i: number) => view.slice(view.lastIndexOf('\n', i) + 1, view.indexOf('\n', i))
    // the next line after the chat view's row
    expect(view.indexOf('\n', chat) + 1).toBe(view.lastIndexOf('\n', at) + 1)
    const line = lineOf(at).trim()
    expect(line).toMatch(/^\{CHAT_VIEW && <Toggle label=\{t\('링크 미리보기 \(채팅\)'\)\}.*\/>\}$/)
    expect(line).toContain('on={s.session.linkPreviews}')
    expect(line).toContain('disabled={!s.session.chatView}')
    expect(line).toContain("onChange={v => set('session', { linkPreviews: v })}")
    const hint = '채팅에 나온 링크의 제목과 그림을 가져와 보여 줘요. 가져올 때 링크 주소 전체가 그 사이트로 가서, 누군가 그 링크를 열었다는 것도 알려져요. 물음표나 긴 값이 붙은 주소, 내 PC나 사내망 주소는 가져오지 않아요'
    expect(line).toContain(`hint={t('${hint}')}`)
    const { default: settingsLocale } = await import('../src/locales/settings')
    expect(settingsLocale.en['링크 미리보기 (채팅)']).toBe('Link previews (chat)')
    expect(settingsLocale.ja['링크 미리보기 (채팅)']).toBe('リンクプレビュー(チャット)')
    expect(settingsLocale.en[hint]).toBe('Shows the title and picture of links in the chat. Fetching one sends the whole address of the link to that site, which also learns someone looked at it. Addresses with a question mark or a long value in them, and addresses on this PC or a private network, are never fetched.')
    expect(settingsLocale.ja[hint]).toBe('チャットに出たリンクのタイトルと画像を表示します。取得するとリンクのアドレス全体がそのサイトに送られ、誰かがリンクを開いたことも伝わります。疑問符や長い値を含むアドレス、このPCや社内ネットワークのアドレスは取得しません。')
  })

  it('the label and the hint are in English and Japanese', async () => {
    const { default: settingsLocale } = await import('../src/locales/settings')
    const hint = 'Claude Code 세션을 대화처럼 볼 수 있어요. 터미널은 그대로 돌아가고, 세션 머리의 채팅 · 터미널로 바꿔 봐요. 켠 뒤에 여는 세션부터 돼요'
    for (const key of ['채팅으로 보기', hint]) {
      expect(settingsLocale.en[key], key).toBeTruthy()
      expect(settingsLocale.ja[key], key).toBeTruthy()
    }
    const view = readFileSync(join(__dirname, '..', 'src', 'components', 'SettingsView.tsx'), 'utf8')
    expect(view).toContain(`t('${hint}')`)
  })
})

describe("the list's order is the user's (1.10.11)", () => {
  it('a file saved with the old default 자동 gets the dragged order once; turning 자동 on later holds', () => {
    const dir = mkdtempSync(join(tmpdir(), 'spawn-settings-'))
    const file = join(dir, 'settings.json')
    writeFileSync(file, JSON.stringify({ session: { autoSort: true, chatViewOn: true } }))
    const a = createSettingsStore(file)
    expect(a.get().session).toMatchObject({ autoSort: false, manualOrderOn: true })
    a.set({ session: { autoSort: true } })
    expect(createSettingsStore(file).get().session.autoSort).toBe(true)
  })
})

describe('the chat view default given once (1.10.5)', () => {
  it('turns on a file saved with the old default off, once; a later off holds', () => {
    const dir = mkdtempSync(join(tmpdir(), 'spawn-settings-'))
    const file = join(dir, 'settings.json')
    writeFileSync(file, JSON.stringify({ session: { chatView: false } }))
    const a = createSettingsStore(file)
    expect(a.get().session).toMatchObject({ chatView: true, chatViewOn: true })
    a.set({ session: { chatView: false } })
    expect(createSettingsStore(file).get().session.chatView).toBe(false)
  })
})
