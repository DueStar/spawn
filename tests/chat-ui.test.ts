/**
 * Guards over the whole chat view (Phase 2, the read-only lens): it sends nothing to a
 * terminal and changes no setting of Claude Code, it reads no credentials, it has no
 * HTML path, and every one of its strings is in Korean, English and Japanese.
 *
 * (The files the chat view must leave alone — TerminalPanel.tsx, keys.ts, termFont.ts,
 * textSize.ts, server/, hooks/, scripts/, the updater, package.json — are checked by a
 * command against the release, not here: main keeps being merged into this branch.)
 */

import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import chat from '../src/locales/chat'

const ROOT = join(__dirname, '..')
const read = (f: string) => readFileSync(f, 'utf8')
const inDir = (dir: string, re: RegExp) => (existsSync(dir) ? readdirSync(dir).filter(f => re.test(f)).map(f => join(dir, f)) : [])

const MAIN = inDir(join(ROOT, 'electron'), /^chat.*\.cjs$/)
const PAGE = [
  ...inDir(join(ROOT, 'src', 'chat'), /\.tsx?$/),
  ...inDir(join(ROOT, 'src', 'components', 'chat'), /\.tsx?$/),
  join(ROOT, 'src', 'components', 'ChatView.tsx'),
]
/** Code only: a comment may say what the code never does */
const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/[^\n]*/g, '$1')

describe('the chat view sends nothing and changes nothing', () => {
  it('found its files', () => {
    expect(MAIN.map(f => f.split(/[\\/]/).pop()).sort()).toEqual(['chatChanges.cjs', 'chatCommands.cjs', 'chatFiles.cjs', 'chatFull.cjs', 'chatHolds.cjs', 'chatHooks.cjs', 'chatHost.cjs', 'chatImages.cjs', 'chatInput.cjs', 'chatItems.cjs', 'chatLens.cjs', 'chatLog.cjs', 'chatSchema.cjs', 'chatTail.cjs', 'chatWorker.cjs'])
    expect(PAGE.length).toBeGreaterThanOrEqual(15)
  })

  it('(a) no terminal write or send, no instruction, no config command, no settings file', () => {
    for (const f of [...MAIN, ...PAGE]) {
      const src = code(read(f))
      for (const bad of [/terminals\.write/, /terminals\.send/, /sendInstruction/, /pty\.write|\.write\(/, /['"`]\/model/, /['"`]\/config/, /['"`]\/login/, /['"`]\/logout/, /['"`]\/permissions/, /settings\.json/]) {
        // (2026-11-17, the owner's call: the control row's model menu sends `/model <alias>`, from the composer only)
        if (f.endsWith('Composer.tsx') && String(bad) === String(/['"`]\/model/)) {
          expect([...src.matchAll(/['"`]\/model/g)].map(m => src.slice(m.index!, m.index! + 17))).toEqual(['`/model ${alias}`'])
          continue
        }
        expect(src, `${f}: ${bad}`).not.toMatch(bad)
      }
    }
  })

  it('(a) the chat writes to a terminal only through terminals.typeForChat, in chatHost.cjs send, submit, interrupt, cycleMode and dialogKey', () => {
    const host = code(read(join(ROOT, 'electron', 'chatHost.cjs')))
    const span = (name: string): [number, number] => {
      const start = host.search(new RegExp(String.raw`\n  (?:async )?function ${name}\(`))
      expect(start, name).toBeGreaterThan(0)
      const next = host.slice(start + 1).search(/\n  (?:async )?function /)
      return [start, next < 0 ? host.length : start + 1 + next]
    }
    // (cycleMode: the mode menu's one Shift+Tab, 2026-11-17)
    // (dialogKey: the dialog card's keys, 2026-11-17)
    const spans = ['send', 'submit', 'interrupt', 'cycleMode', 'dialogKey'].map(span)
    const at = [...host.matchAll(/typeForChat\(/g)].map(m => m.index!)
    expect(at).toHaveLength(5)
    for (const i of at) expect(spans.some(([a, b]) => i > a && i < b), `typeForChat at ${i}`).toBe(true)
    for (const [a, b] of spans) expect(at.some(i => i > a && i < b)).toBe(true)
    for (const i of at) expect(host.slice(i - 10, i)).toBe('terminals.')
    for (const f of [...MAIN, ...PAGE].filter(x => !x.endsWith('chatHost.cjs'))) expect(code(read(f)), f).not.toMatch(/typeForChat/)
  })

  it('(a) Enter, Esc and the paste brackets are spelled only in chatInput.cjs', () => {
    const input = read(join(ROOT, 'electron', 'chatInput.cjs'))
    expect(input).toMatch(/const ENTER = '\\r'/)
    expect(input).toMatch(/const ESC = '\\x1b'/)
    expect(input).toMatch(/const SHIFT_TAB = '\\x1b\[Z'/)
    expect(input).toMatch(/const ARROW_UP = '\\x1b\[A'/)
    expect(input).toMatch(/const ARROW_DOWN = '\\x1b\[B'/)
    expect(input).toMatch(/const PASTE_START = '\\x1b\[200~'/)
    for (const f of [...MAIN, ...PAGE].filter(x => !x.endsWith('chatInput.cjs'))) {
      const src = code(read(f))
      // (markdown.ts reads text: it compares a character with '\r', and writes nothing anywhere)
      if (!f.endsWith('markdown.ts')) expect(src, `${f}: a '\\r' literal`).not.toMatch(/['"`]\\r['"`]/)
      for (const bad of [ /\\x1b|\\u001b|\\x0d|\\u000d|\\x7f/, /200~|201~/, /String\.fromCharCode\(\s*(13|27|0x0d|0x1b)\s*\)/]) {
        expect(src, `${f}: ${bad}`).not.toMatch(bad)
      }
    }
  })

  it('(b) the main side names no credentials', () => {
    for (const f of MAIN) {
      const src = code(read(f))
      for (const bad of [/\.credentials/, /settings\.json/, /oauth/i]) expect(src, `${f}: ${bad}`).not.toMatch(bad)
    }
  })

  it('(c) no HTML path: no dangerouslySetInnerHTML, innerHTML or eval anywhere in it', () => {
    for (const f of [...MAIN, ...PAGE]) {
      expect(read(f), f).not.toMatch(/dangerouslySetInnerHTML|innerHTML|\beval\(|new Function\(/)
    }
  })

  it('links leave the page only through the app (openUrl), files only through openPath', () => {
    const all = PAGE.map(read).join('\n')
    expect(all).not.toMatch(/window\.open\(|location\.href\s*=|<a [^>]*href=\{/)
    expect(all).toMatch(/terminals\.openUrl\(/)
    expect(all).toMatch(/terminals\.openPath\(/)
  })

  it('(d) every string has en and ja, the same keys both ways, none empty', () => {
    expect(Object.keys(chat.en).sort()).toEqual(Object.keys(chat.ja).sort())
    for (const k of Object.keys(chat.en)) {
      expect(chat.en[k].trim(), `en: ${k}`).not.toBe('')
      expect(chat.ja[k].trim(), `ja: ${k}`).not.toBe('')
    }
  })

  it('every Korean string the chat code shows is in the locale (or an existing one)', async () => {
    const DICTS = (await import('../src/locales')).default
    const keys = new Set<string>()
    for (const f of [...PAGE, join(ROOT, 'src', 'components', 'SessionHeader.tsx')]) {
      const src = code(read(f))
      for (const m of src.matchAll(/\bt\(\s*'([^']*[가-힣][^']*)'/g)) keys.add(m[1])
      // the label tables: { … : '<Korean>' }
      for (const m of src.matchAll(/:\s*'([^']*[가-힣][^']*)'/g)) keys.add(m[1])
    }
    expect(keys.size).toBeGreaterThan(40)
    for (const k of keys) {
      expect(DICTS.en[k], `en: ${k}`).toBeTruthy()
      expect(DICTS.ja[k], `ja: ${k}`).toBeTruthy()
    }
  })
})

describe('the composer (Phase 3): its look and its safety', () => {
  const css = read(join(ROOT, 'src', 'styles', 'chat.css')).replace(/\/\*[\s\S]*?\*\//g, '')
  const rules = [...css.matchAll(/([^{}]+)\{([^}]*)\}/g)].map(m => ({ sel: m[1].trim(), body: m[2] }))
  const COMPOSER = ['Composer.tsx', 'QueueStrip.tsx', 'ImageChips.tsx', 'Lightbox.tsx', 'ControlRow.tsx'].map(f => join(ROOT, 'src', 'components', 'chat', f))
  const NEW = [...COMPOSER, ...['composerKeys.ts', 'outbox.ts', 'send.ts', 'promptRow.ts'].map(f => join(ROOT, 'src', 'chat', f))]

  it('found the composer\'s files', () => {
    for (const f of NEW) expect(existsSync(f), f).toBe(true)
  })

  it('the accent only in the send button\'s rules', () => {
    for (const r of rules) if (/--accent(?!-ink)/.test(r.body)) expect(r.sel, r.sel).toMatch(/^\.chat-send(:hover)?$/)
  })

  it('no animation; a transition only of a colour', () => {
    expect(css).not.toMatch(/animation|@keyframes/)
    for (const r of rules) {
      const m = /transition\s*:\s*([^;]+)/.exec(r.body)
      if (m) for (const part of m[1].split(',')) expect(part.trim().split(/\s+/)[0], r.sel).toMatch(/^(color|background-color|border-color)$/)
    }
  })

  it('every font size a text-step token; the composer\'s fonts literal stacks', () => {
    for (const r of rules) {
      for (const m of r.body.matchAll(/font-size\s*:\s*([^;]+)/g)) expect(m[1].trim(), r.sel).toMatch(/^(var\(--t-(micro|meta|ui|prose|code|head)\)|calc\(var\(--t-[a-z]+\) [-+] \d+px\))$/)
      for (const m of r.body.matchAll(/font-family\s*:\s*([^;]+)/g)) expect(m[1], r.sel).not.toMatch(/var\(/)
    }
    const input = rules.find(r => r.sel === '.chat-input')!
    expect(input.body).toMatch(/font-family: 'W Pretendard'/)
    expect(input.body).toMatch(/font-size: var\(--t-prose\)/)
  })

  it('the textarea is never disabled (that would blur it mid-composition); no localStorage', () => {
    for (const f of [...inDir(join(ROOT, 'src', 'components', 'chat'), /\.tsx$/), join(ROOT, 'src', 'components', 'ChatView.tsx')]) {
      const src = read(f)
      for (const m of src.matchAll(/<textarea[\s\S]*?\/>/g)) expect(m[0], f).not.toMatch(/(?<![-\w])disabled\b(?!=\{false\})/)
    }
    for (const f of NEW) expect(read(f), f).not.toMatch(/localStorage|sessionStorage/)
  })

  it('the composer reads the clipboard never: only the paste event\'s own data', () => {
    for (const f of NEW) expect(code(read(f)), f).not.toMatch(/navigator\.clipboard|clipboard\.read/)
  })

  it('every refusal a send or an image can meet has its words, in ko, en and ja', async () => {
    const DICTS = (await import('../src/locales')).default
    const src = read(join(ROOT, 'src', 'components', 'chat', 'Composer.tsx'))
    for (const reason of ['waiting', 'prompt-busy', 'sending', 'duplicate', 'not-in-flight', 'no-session', 'too-long', 'images', 'not-working']) expect(src, reason).toContain(`'${reason}'`)
    for (const k of [...src.matchAll(/key: '([^']+)'/g)].map(m => m[1])) {
      expect(DICTS.en[k], `en: ${k}`).toBeTruthy()
      expect(DICTS.ja[k], `ja: ${k}`).toBeTruthy()
    }
  })

  it('1.6.2: the composer reads the dim marks, and main\'s prompt-busy quotes what is on the terminal\'s row', () => {
    const src = read(join(ROOT, 'src', 'components', 'chat', 'Composer.tsx'))
    expect(src).toContain('readDim: deps ? deps.termDim : termDim')
    expect(src).toContain('cardNote(shownCard(status?.asks)), r.row)')
    // (2026-11-17: the words quoted, and offered to be brought here or cleared — never "go to the terminal")
    expect(src).toContain('Claude Code 입력란에 쓰던 글이 남아 있어요: “{text}”')
    expect(src).toContain("t('가져와서 이어 쓰기')")
    expect(src).toContain("t('지우고 보내기')")
    expect(src).not.toContain('터미널에서 보내거나 지운 뒤')
  })
})

describe('the buttons (Phase 4): one place builds an answer, and it never names a settings file', () => {
  const walk = (dir: string, re: RegExp): string[] => (existsSync(dir) ? readdirSync(dir, { withFileTypes: true }).flatMap(d => (d.isDirectory() ? walk(join(dir, d.name), re) : re.test(d.name) ? [join(dir, d.name)] : [])) : [])
  const ELECTRON = walk(join(ROOT, 'electron'), /\.cjs$/)
  const SRC = walk(join(ROOT, 'src'), /\.tsx?$/)

  it('the answer bodies are built only in chatHolds.cjs', () => {
    for (const f of [...ELECTRON, ...SRC]) {
      if (f.endsWith('chatHolds.cjs')) continue
      expect(code(read(f)), f).not.toMatch(/hookSpecificOutput|permissionDecision|updatedPermissions/)
    }
    expect(read(join(ROOT, 'electron', 'chatHolds.cjs'))).toMatch(/hookSpecificOutput/)
  })

  it('no localSettings, userSettings or projectSettings in the chat\'s code', () => {
    for (const f of [...MAIN, ...PAGE]) expect(read(f), f).not.toMatch(/localSettings|userSettings|projectSettings/)
  })

  it('nothing in the page builds or sends a decision\'s behavior (it sends a choice; main builds the rest)', () => {
    for (const f of SRC) {
      const src = code(read(f))
      expect(src, f).not.toMatch(/behavior\s*:\s*['"`](allow|deny|ask)/)
      expect(src, f).not.toMatch(/['"`]behavior['"`]/)
    }
  })

  it('chatHost.cjs writes no file but the version cache (and removes only the old chat settings files)', () => {
    const host = code(read(join(ROOT, 'electron', 'chatHost.cjs')))
    const writes = [...host.matchAll(/\b(writeFileSync|writeFile|appendFile\w*|renameSync|rename|mkdirSync|mkdir|copyFile\w*|createWriteStream|rmSync|unlink\w*)\(/g)].map(m => m[1])
    expect(writes.sort()).toEqual(['renameSync', 'rmSync', 'writeFileSync'])
    const at = (w: string) => host.indexOf(`${w}(`)
    const cache = host.indexOf('function writeCache(')
    expect(at('writeFileSync')).toBeGreaterThan(cache)
    expect(at('renameSync')).toBeGreaterThan(cache)
    expect(host.slice(host.lastIndexOf('function ', at('rmSync')), at('rmSync'))).toMatch(/^function sweepChatFiles/)
  })

  it('HOLD is the only source of the hold times and the held entries\' timeouts', () => {
    for (const f of ['chatHooks.cjs', 'chatHost.cjs', 'chatLens.cjs', 'chatWorker.cjs', 'main.cjs'].map(n => join(ROOT, 'electron', n))) {
      expect(code(read(f)), f).not.toMatch(/\b(300_?000|330|2_?000\s*,\s*max)\b/)
    }
    expect(code(read(join(ROOT, 'electron', 'chatHooks.cjs')))).toMatch(/entryTimeoutS\('permission'\)/)
    expect(code(read(join(ROOT, 'electron', 'chatHooks.cjs')))).toMatch(/entryTimeoutS\('question'\)/)
  })
})

describe('Phase 5 guards (Task 5.11): one animation file, yellow only on send, three storage keys, logs without content', () => {
  const STYLES = join(ROOT, 'src', 'styles')
  const sheet = (f: string) => read(join(STYLES, f)).replace(/\/\*[\s\S]*?\*\//g, '')
  const rulesIn = (css: string) => [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(m => ({ sel: m[1].trim().replace(/\s+/g, ' '), body: m[2] }))
  const SHEETS = readdirSync(STYLES).filter(f => f.endsWith('.css'))
  /** The chat view's selectors (Phases 2–5): its own classes and the window's parts it added */
  const CHATTY = /\.(chat-|w-chat-|w-ch-|w-ch\b|w-chg|w-dens|dens-|find-now)/
  /** The page files of the chat view, Phase 5's included */
  const PAGE5 = [...PAGE, join(ROOT, 'src', 'changesWidth.ts')]

  it('every animation of the chat view is in chat-game.css (its one: chat-wild-in); chat.css has none; the other sheets\' keyframes are 1.4.0\'s', () => {
    expect(sheet('chat.css')).not.toMatch(/animation|@keyframes/)
    const frames = SHEETS.flatMap(f => [...sheet(f).matchAll(/@keyframes\s+([\w-]+)/g)].map(m => `${f}: ${m[1]}`)).sort()
    // release 1.4.0 (cff52ac) had exactly these six; Phase 5 adds chat-game.css's one
    // (2026-11-17: the working Pokémon's hop and halo, the owner's micro-interaction, in chat-game.css too)
    expect(frames).toEqual(['chat-game.css: chat-halo', 'chat-game.css: chat-hop', 'chat-game.css: chat-wild-in', 'pokedex.css: wMonHop', 'toast.css: toastIn', 'toast.css: toastOut', 'widget.css: wLimitPulse', 'widget.css: wLimitShimmer', 'widget.css: wNoteIn'])
    // no rule of the chat view moves outside chat-game.css
    for (const f of SHEETS.filter(x => x !== 'chat-game.css')) {
      for (const r of rulesIn(sheet(f))) {
        if (!CHATTY.test(r.sel)) continue
        expect(r.body, `${f}: ${r.sel}`).not.toMatch(/(?:^|[;\s])animation(?:-name)?\s*:\s*(?!none)/)
      }
    }
    // nor from the page's code (no Web Animations call, no inline animation)
    for (const f of PAGE5) expect(code(read(f)), f).not.toMatch(/\.animate\(|animation\s*:|animationName/)
  })

  it('--accent (the yellow) only in .chat-send among the chat view\'s rules, sheets and page code', () => {
    let sends = 0
    for (const f of SHEETS) {
      for (const r of rulesIn(sheet(f))) {
        if (!CHATTY.test(r.sel) && !['chat.css', 'chat-game.css'].includes(f)) continue
        if (!/var\(--accent(?:-hover)?\)/.test(r.body)) continue
        expect(r.sel, `${f}: ${r.sel}`).toMatch(/^\.chat-send(:hover)?$/)
        sends++
      }
    }
    expect(sends).toBe(2)
    for (const f of PAGE5) expect(code(read(f)), f).not.toMatch(/--accent(?!-ink)|#f2c94c/i)
  })

  it('the new localStorage keys are exactly spawn-chat-density, spawn-changes-w and spawn-changes-open; no other storage in the chat view', () => {
    const literals = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap(d => (d.isDirectory() ? literals(join(dir, d.name))
      : /\.tsx?$/.test(d.name) ? [...read(join(dir, d.name)).matchAll(/['"`](spawn-[a-z0-9-]+)['"`]/g)].map(m => m[1]) : []))
    const all = [...new Set(literals(join(ROOT, 'src')))].sort()
    // release 1.4.0's (cff52ac) keys, and the three of Phase 5
    // (+ spawn-pane-fracs, 2026-11-19: the split view's dragged pane widths, Widget.tsx — not the chat view's)
    // (+ spawn-list-order / spawn-list-used, 2026-11-19: the left list's 직접 order and last-used times, src/sessionOrder.ts)
    const OLD = ['spawn-box-sort', 'spawn-carry', 'spawn-dex-viewed', 'spawn-list-mode', 'spawn-list-order', 'spawn-list-used', 'spawn-pane-fracs', 'spawn-rank-npc', 'spawn-seen-version', 'spawn-session-cast', 'spawn-side-hidden', 'spawn-side-w', 'spawn-term-font', 'spawn-text-size']
    const NEW = ['spawn-changes-open', 'spawn-changes-w', 'spawn-chat-density']
    expect(all).toEqual([...OLD, ...NEW].sort())
    // the chat view's files: only the three, each written in one place through its constant (a word or a number)
    const used = PAGE5.flatMap(f => [...read(f).matchAll(/['"`](spawn-[a-z0-9-]+)['"`]/g)].map(m => m[1]))
    expect([...new Set(used)].sort()).toEqual(NEW)
    const density = code(read(join(ROOT, 'src', 'chat', 'density.ts')))
    const width = code(read(join(ROOT, 'src', 'changesWidth.ts')))
    expect(density).toMatch(/DENSITY_KEY = ['`]spawn-chat-density['`]/)
    expect(width).toMatch(/CH_KEY = ['`]spawn-changes-w['`]/)
    expect(width).toMatch(/OPEN_KEY = ['`]spawn-changes-open['`]/)
    const sets = PAGE5.flatMap(f => [...code(read(f)).matchAll(/localStorage\.setItem\(([^\n]*)/g)].map(m => m[1].trim().replace(/\s+/g, ' '))).sort()
    // (a width as a whole number, a level's word (one of DENSITIES, checked by chat-density.test.ts), '1' / '0')
    expect(sets).toEqual(['CH_KEY, String(Math.round(px)))', 'DENSITY_KEY, d) } catch { }', "OPEN_KEY, open ? '1' : '0')"])
    for (const f of PAGE5) expect(code(read(f)), f).not.toMatch(/sessionStorage|indexedDB|document\.cookie|caches\.open/)
  })

  it('no log line of the chat view (electron/chat*.cjs, electron/link*.cjs, src/chat/, src/components/chat/) interpolates anything but fixed words and numbers', () => {
    const files = [
      ...inDir(join(ROOT, 'electron'), /^(chat|link).*\.cjs$/),
      ...inDir(join(ROOT, 'src', 'chat'), /\.tsx?$/),
      ...inDir(join(ROOT, 'src', 'components', 'chat'), /\.tsx?$/),
      join(ROOT, 'src', 'components', 'ChatView.tsx'),
    ]
    // what a log line may interpolate: a fixed word (a reason, a kind, a state, an event's name, an error's code or
    // kind through errWord) or a number; never a message, a path, a URL, a host or an item's text
    // (Phase 6: `number` and `verdict`, the lens's line for a version first seen in a transcript: digits and a fixed word)
    // (the final review M8: an error only through errWord, a version only through versionWord; no err?.code, err?.name or
    // a raw `claude --version` line any more)
    const ALLOWED = new Set(['code', 'why', 'status', 'event', 'word', 'k.count', 'c.kind', 'c.state', "c.why ?? ''", 'versionWord(version)', 'number', 'verdict',
      'errWord(err)',
      // 1.5.3 (chatHost diag / refused): a screen's shape with every letter and digit masked twice (page and main;
      // tests/chat-send-diag.test.ts), and a refusal's fixed reason word
      'shape', 'kind', 'String(r.reason).slice(0, 30)'])
    const CALL = /\blogOnce\(|\blog\(|console\.\w+\(|\bmsg:\s*`|\bwrite\(`/g
    let lines = 0
    for (const f of files) {
      const name = f.split(/[\\/]/).pop()!
      for (const line of code(read(f)).split('\n')) {
        for (const m of line.matchAll(CALL)) {
          if (m[0] === 'write(`' && !name.startsWith('link')) continue
          lines++
          let rest = line.slice(m.index!)
          // logOnce(t, key, message): the key is never written
          if (m[0] === 'logOnce(') rest = rest.replace(/^logOnce\(\s*\w+\s*,\s*(`(?:[^`\\]|\\.)*`|'[^']*')\s*,/, 'logOnce(')
          for (const tpl of rest.matchAll(/`((?:[^`\\]|\\.)*)`/g)) {
            for (const x of tpl[1].matchAll(/\$\{((?:[^{}]|\{[^{}]*\})*)\}/g)) {
              expect(ALLOWED.has(x[1].trim()), `${name}: ${line.trim().slice(0, 140)} → \${${x[1]}}`).toBe(true)
            }
          }
        }
      }
    }
    expect(lines).toBeGreaterThanOrEqual(25)
  })

  it('errWord (electron/chatLog.cjs) names an error by its code or kind, never its message', async () => {
    const { errWord } = (await import('../electron/chatLog.cjs')) as any
    const fsErr = Object.assign(new Error("ENOENT: no such file or directory, open 'C:\\Users\\user\\work\\demo\\a.txt'"), { code: 'ENOENT' })
    expect(errWord(fsErr)).toBe('ENOENT')
    expect(errWord(new TypeError('x of https://a.example/ is undefined'))).toBe('TypeError')
    expect(errWord(Object.assign(new Error('m'), { code: 'C:\\Users\\user\\a.txt' }))).toBe('Error')
    expect(errWord(Object.assign(new Error('m'), { name: 'https://a.example' }))).toBe('error')
    for (const v of ['text', 42, null, undefined, {}]) expect(errWord(v)).toBe('error')
  })

  // The app's own version is left out: a release bumps it, and that is not a dependency
  it('package.json and the lock file are as at release 1.4.0, the version aside: no new dependency', () => {
    const sha = (f: string) => {
      const j = JSON.parse(read(join(ROOT, f)))
      delete j.version
      if (j.packages?.['']) delete j.packages[''].version
      return createHash('sha256').update(JSON.stringify(j)).digest('hex')
    }
    // (2026-11-17: one dependency added on purpose, @phosphor-icons/react 2.1.10 (MIT) — the owner's icon system;
    // anything else new still fails here; 2026-11-19: build.nsis and the nsis target, the Windows installer — no dependency)
    expect(sha('package.json')).toBe('d4f0f830bf4ee497fe116393571e5472558e6b162eadb7f7a461e16377cf5599')
    expect(sha('package-lock.json')).toBe('bbc6b9de9af963d8b8cbdbc659d634095d1b89e030f9bbbd86f6b33c7c2a4976')
  })
})
