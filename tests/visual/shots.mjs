#!/usr/bin/env node
/**
 * shots.mjs — screenshots of the real built UI (dist/) with made-up sessions,
 * for comparing every restyle with the design lab. See tests/visual/README.md.
 *
 * How: the repo's own server (server/index.js) runs as a child on its own port
 * (3397) and its own home (tests/visual/.home), only to serve dist/ and the
 * Pokémon pictures. Headless Chromium (playwright-core, loaded from outside the
 * repo: no dependency) opens the app's page with a fake desktop bridge
 * (fake-bridge.js) and answers its WebSocket with the fixture snapshot
 * (fixture.mjs). No Electron, no pty, nothing of the owner's is read.
 *
 * Run `node tests/visual/shots.mjs --help` for the options.
 */

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import * as fixture from './fixture.mjs'
import * as chatFixture from './chatFixture.mjs'
import pngjs from 'pngjs'

const { PNG } = pngjs
const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..', '..')
const DIST = join(ROOT, 'dist')
const HOME = join(HERE, '.home')
const PORT = 3397
const BASE = `http://127.0.0.1:${PORT}`
// Both outside the repo, beside it in the user's Documents (no absolute path in a tracked file)
const PLAYWRIGHT = process.env.PLAYWRIGHT_CORE ?? join(homedir(), 'Documents', 'spawn-promo', 'video', 'node_modules', 'playwright-core')
const LAB = process.env.LAB_SHOTS ?? join(homedir(), 'Documents', 'spawn-site-lab', 'calm-lab', 'shots-v5')
const VERSION = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version
/** The composer's fake terminal screens (tests/fixtures/chat/screens/*.txt), by name, for window.__SCREEN__ */
const SCREENS = Object.fromEntries(readdirSync(join(ROOT, 'tests', 'fixtures', 'chat', 'screens')).filter(f => f.endsWith('.txt')).map(f => [f.slice(0, -4), readFileSync(join(ROOT, 'tests', 'fixtures', 'chat', 'screens', f), 'utf8')]))

/** What the Electron window paints behind the page (electron/main.cjs): window #0b0c10; the widget is see-through, so a desktop grey */
const WINDOW_BG = '#0b0c10'
const DESKTOP_BG = '#23252b'
/** --lang: the page's locale (설정's 언어 is 자동, so the app follows it) */
const LOCALE = { en: 'en-US', ja: 'ja-JP' }

/**
 * A Korean string as the page shows it in `lang` (null: Korean), read from the app's own
 * src/locales/settings.ts, so a step that names a control (설정's button, its 앱 section) works
 * in every language the harness runs.
 */
function shown(ko, lang) {
  if (!lang) return ko
  const text = readFileSync(join(ROOT, 'src', 'locales', 'settings.ts'), 'utf8')
  const at = text.indexOf('const ja')
  const part = lang === 'ja' ? text.slice(at) : text.slice(0, at)
  const m = new RegExp(`'${ko}': '([^']*)'`).exec(part)
  return m ? m[1] : ko
}

/** No Pokémon word, name, level or "HP" in 업무 모드 — copied from tests/work-mode.test.ts (GAME) */
const GAME = /포켓몬|몬스터볼|도감|박스|잡았|포획|파티|트레이너|Lv\.|\bHP\b|Pok[eé]|Poké|Pokédex|ポケモン|図鑑|ボックス|ゲット|トレーナー|モンスターボール/i

const USAGE = `
Screenshots of the built UI (dist/) with fixture sessions.

  node tests/visual/shots.mjs [--out <dir>] [--only a,b] [--size WxH] [--side <px>] [--text <step>] [--check fit|work] [--flow <name>]
  node tests/visual/shots.mjs --sheet <surface>[,<surface>] [--size WxH] --out <dir>

Before: npx vite build   (the harness reads dist/, it never builds)

  --out <dir>      where the PNGs go (default tests/visual/.home/shots). Made if missing.
  --only a,b       only these surface ids (default: all of them, below)
  --size WxH       only this size (1440x900 or 1100x720); with --sheet, the size to compare
  --side <px>      the left panel at this width (seeds spawn-side-w); the files end in -side<px>
  --lang <en|ja>   every shot in this language (the page's locale: 설정's 언어 is 자동); files end in -en / -ja
  --text <step>    every shot at this text step: small, large or xlarge (seeds spawn-text-size);
                   the files end in -ts-<step> (--only dex --text xlarge → dex-1440x900-ts-xlarge.png)
  --check fit      in every shot page: no sideways page scroll, and no child of
                   .w-term-tabs / .w-list-head / .w-sess-bar / .w-row, or of a row in 도감 / 박스 /
                   기록 / 랭킹 (numbers, filters, toolbars, list rows), ends past its parent;
                   the instruction box's field is not a box drawn inside another box; the usage
                   labels are not cut
  --check work     in every -work shot: no img[src*="/sprites/pokemon"], no Pokémon word in
                   the visible text, titles or aria-labels, and the first .w-row has the same
                   left and width as in the same surface without 업무 모드 (shot too if needed);
                   folded, every rail item keeps its place and size (the ball's slot stays, empty)
                   (both checks may be given: --check fit --check work, or --check fit,work;
                   --check work refuses a run with no -work surface in it)
  --flow <name>    an interaction flow (exits non-zero when it finds a problem):
                   tabs-gone  close / rename / drag in 상세, 간략 and folded, the list header's
                              >_ + 간략 상세, the rail's >_, switching by rail and Ctrl+Tab, the
                              chosen row in sight among twelve, 업무 모드's header, an ended 간략
                              row dimmed, the widget's >_ that opens no shell (no window, a note)
                   side-resize  the left panel's edge: drag (clamped 240–420, remembered, the
                              terminal refits once), double-click and Home reset, ← / →,
                              a narrow window, hidden when folded and in widget mode
                   text-size  the one text step: where a page starts (migration from the old
                              terminal size), its class, the terminal's px; Ctrl/⌘ += - 0 once per
                              press, the wheel, − 가 + and its menu, 설정's row (with --out: a
                              picture of the open menu, flow-text-size-menu.png)
                   hit-areas  every control the restyle touched, measured against its size on main (0dbb6c9):
                              none smaller, each with its own floor; 로그인 and the update button in
                              ko, en and ja (with --out: hit-areas.json)
                   keyboard   the list's rows from the keyboard (Tab, Enter, Space, F2, their buttons,
                              the focus ring, their names for a screen reader) in 상세 and 간략, and
                              the text-size menu's keys
                   seg-hover  a hovered option looks unlike the chosen one (도감, 박스, 랭킹, 설정)
                   narrow     560 and 640 wide, Windows and Mac, the panel open and folded: the top
                              bar fits (the window buttons whole, the text size folded to 가 when it
                              must, its menu inside the window), the Mac's 78px room, the fit check
                              (with --out: flow-narrow-<win|mac>-<open|folded>-<width>.png)
                   chat-flip  채팅 / 터미널 in the session header: the terminal stays mounted (same element,
                              its output while the chat showed, its scroll as a session switch keeps it,
                              the focus back), one chat.open and nothing written; per session; a reload
                   chat-banner  the read-failed banner: dimmed conversation, 다시 읽기 (one chat.reload),
                              터미널로 보기
                   chat-unarmed  a session opened before the chat view: 채팅 disabled with the reason
                   chat-long  2000 items: ≤ 300 rows in the page anywhere, one chat.older at the top, older rows
                              above keep the row in view, 새 메시지 3개 and its jump, scroll time
                   chat-off   no chat key: no flip, no chat code loaded, no chat call; session (both sizes),
                              session-work (both) and session-mac equal the app's with the chat view off pixel for pixel (baselines in
                              CHAT_OFF_BASELINE or <out>/../00-before/, made from a build of this version with features.json
                              chatView false — not cff52ac any more: 1.5.2 removed the side panel's instruction box; missing = a failure):
                              another take (five at most) only when a take differs by the two known frame-noise
                              signatures (the blinking caret's cell, a corner of the instruction field), any other
                              difference fails at once; every differing take printed
                   chat-scroll  wheel and ↑ leave the bottom, rows arriving above it leave the view, at the bottom new
                              rows followed and announced, a row opened at the bottom stays, Tab walks past the first rows;
                              at the bottom of a long session Tab / Shift+Tab move nothing and it still follows, and
                              Shift+Tab from the 새 메시지 pill reaches the rows in view without scrolling
                   chat-wait  a wait while scrolled up: the amber pill and its jump; a sub-agent's wait on its Agent row,
                              and the main thread's own unpaired wait on none
                   chat-focus  typing (mid-composition) in the side panel's box while the chat mounts, fills and clears
                   chat-send  the composer: Enter → one chat.send (screen 'empty'), the echo → one chat.submit 'ok', the
                              bubble sending → sent → replaced by the record's line
                   chat-send-ime  Korean composition: Enter, Backspace, Esc during it do nothing; after it Enter sends once;
                              a blur keeps the text
                   chat-send-multiline  Shift+Enter twice → one chat.send with two newlines
                   chat-send-double  a double click on 보내기 and two quick Enters → one chat.send each
                   chat-send-refuse  a dialog on screen → nothing sent, the note, 터미널로 보기 flips; prompt-busy → the note,
                              the draft kept; waiting → nothing sent; no echo → submit 'timeout', "남아 있어요", the draft cleared
                   chat-queue  Claude Code's queue of 2 → 대기 중 2 and its first text, a click lists both; none → no strip
                   chat-stop  멈추기 in the working line → one chat.interrupt; Esc in the composer → one more; waiting: no 멈추기
                   chat-image  a pasted PNG → one chat.image and a chip; the lightbox and Esc (the focus back); × →
                              chat.dropImage; a dropped .txt → the type note; a text paste → no chat.image
                   chat-compose-focus  the flip to 채팅 focuses the composer; rows arriving keep a composition
                              through a reset; a composition in the composer survives rows arriving
                   chat-compose-grow  at the bottom, a draft of 1 → 6 lines keeps the list at the bottom; past 8 lines it scrolls
                   chat-robust  open { ok: false } → banner (unarmed: its own words); nothing sent → 불러오는 중…; a
                              sub-agent's rows asked once, and again once let go; a cut answer copied says so; a row
                              that throws leaves the window standing; older { ok: false } clears its line
                   chat-allow  (phase 4) at the top of a long session a card shows in view, the focus stays in the
                              composer; a press the moment it appears answers nothing, nor do digits; Tab to 허용 and
                              Enter → one chat.answer allow; 보내는 중…; sent; gone with the next status
                   chat-always  the rule said under the buttons and in 항상 허용's title; a click → always; no 항상 허용 without a rule
                   chat-deny  거부 a hairline button (not filled, not red); → → from 허용 reaches it; Space → deny
                   chat-ask-enter  a draft and a card: Enter sends nothing and answers nothing, the note points to the card
                   chat-ask-timeout  a timed-out card: no buttons, its words, 터미널에서 답하기 flips
                   chat-ask-terminal-first  chat.answer refused (gone) → 보내지 못했어요 · 터미널에서 답해 주세요; gone with the next status
                   chat-question  chat.visible(id) at mount; the options as buttons; Tab, Tab, Enter → option 1
                   chat-question-hidden  the flip to 터미널 → chat.visible(null); a card handed to the terminal is read-only
                   chat-plan  read-only: no answer button, 더 보기, 터미널에서 답하기 flips
                   chat-ask-a11y  a card arriving mid-composition moves nothing; between the list and the composer;
                              its group named; announced once; Shift+Tab from the composer reaches it; buttons ≥ 22px
                   chat-ask-gate  (review I1) a 300-line command: 허용 and 항상 허용 wait, with the reason, until the
                              box is scrolled to its end (거부 does not); a diff box says 길어요 and holds 허용 too
                   chat-ask-guard  (review I2) a press under 800 ms after the card is painted, or after the window comes
                              back (focus), answers nothing; a press begun on one card and let go on the next neither
                   chat-ask-wrap  (review C1, C2) a 300-character path's file name in view on the card; a diff line's
                              far tail wrapped into view; nothing on a card scrolls sideways
                   chat-ask-facts  (review C3, C4, M2–M5, M13) sandbox-off with the amber dot (no fill), background, the
                              time limit, the folder, Claude's description labelled, the URL host in punycode, a direction
                              mark marked; a Write over a file titled as an overwrite, no 새 파일
                   chat-ask-retry  (review I3) chat.answer refused as hidden: the buttons stay with 다시 눌러 주세요; pressed
                              again → answered
                   chat-ask-order  (review M7, M8, M9) a plan before an open card: the open one shown; the composer's note
                              per card state (here / terminal / sent); one live region, there before any card
                   chat-reload-size  (7-48) the shown chat's hidden terminal: at load and after a reload fitted (not 80
                              columns), never focused (sampled every frame), hidden again, the pane opaque, the composer
                              sends, no chat.redraw; a background session switched to in chat: one chat.redraw, not a
                              second; its flip to 터미널 resizes as a session switch does; hidden while the terminals
                              mount: one chat.redraw; terminal mode: none, and no resize of a terminal never shown
                   chat-changes  (phase 5) the 변경 사항 panel: the header button's counts, pressed, toggling; a diff block's
                              +N −N opens the panel at that file with that edit in view; the tree's keys; the edge's drag,
                              ← / →, Home and double-click; the width and the open state remembered across a reload
                   chat-changes-fold  at 1200 wide the left panel folds to the rail for the panel and comes back on close or
                              widening, never stored; the rail's unfold closes the panel; 560 wide: no panel, nothing clipped
                   chat-changes-terminal  the panel open (folded at 1200), the flip to 터미널: the terminal's box and resizes as
                              without the panel, no panel or chat tools; a load in chat with it open: the shown size only
                   chat-changes-widget  the widget mode: no panel, no button, no chat.changes
                   chat-density  (phase 5) 보기 정도 by keyboard (↓ opens on the checked level, ↓ ↑ Home End, Esc / Tab close,
                              the focus back), remembered across a reload, the chosen level grey; 생각 포함 shows thinking
                              rows; 전부 opens rows but not one the user closed; chat-long: each switch holds the rows in
                              view (2px), settles in ≤ 300 ms, ≤ 300 rows; chat-waiting: the waiting row its own in each level
                   chat-foot  (phase 5) the turn summary: a foot per finished turn (time, 도구 n회, 파일 n개 바꿈), whose 복사
                              writes the turn's answer (a clipboard stub) and takes the rows' own; a turn with no foot keeps
                              its row's; no GET /pokedex at load; a turn ending live while watched: 8걸음 after 1.5 s (two
                              routed reads), a second turn with no new start none; a reload: the feet, no steps, no read;
                              업무 모드: no read at all, no steps
                   chat-wild  (phase 5) wild Pokémon: the conversation's meetings from the snapshot's game state, none
                              animating at load; a pokedex message with a new catch of the shown session: one more row,
                              with appear (its animation runs; none under reduced motion); another session's catch, a
                              level-up: no row; a reload: every row, none with appear; 업무 모드: no .chat-wild, ever
                   chat-a11y-walk  (phase 6) keyboard only over chat-changes: Tab in visual order (header, list, composer,
                              panel), never to <body> or a hidden terminal, every stop named and >= 22px; Esc gives the focus
                              back (density menu, find); Ctrl+F from the list, the composer, the tree; the accessibility tree
                              named (tree items with level and selected); reduced motion: nothing runs, scrolling auto
                   chat-perf  (phase 6) the long session's page budgets: a 5,000-item reset (4,000 kept, the cut's line at
                              the top) → first rows ≤ 300 ms; 30 × 400px steps ≤ 16 ms of work each (fail > 50); 기본 → 전부
                              settled ≤ 300 ms, ≤ 300 rows; find's Enter to a hit ~3,000 rows up placed ≤ 200 ms
                   chat-soak  (phase 6) an hour of streaming in the page: 20,280 pushes after 60 warm-up turns; after a forced
                              gc the JS heap grows ≤ 40 MB, DOM nodes ≤ 1.2×, blob: URLs ≤ 64, listeners not growing
                              (SOAK_ROUNDS=<n> runs a shorter one)
                   chat-find  (phase 5) find in the conversation: Ctrl+F opens the bar (role search, named controls ≥ 22px,
                              the terminal's place) with the focus in it; typing searched after 120 ms, never mid-
                              composition; matches painted (CSS highlights), Enter / Shift+Enter move; a hit in a closed
                              read group opens it; a flip and back keeps the bar; Esc closes, nothing painted, the focus
                              back; chat-long: a hit 1,500 rows up placed in view and painted, 1/1, ≤ 300 rows, the
                              loaded-only note; in the terminal Ctrl+F opens the terminal's own bar; the Mac: ⌘F (not Ctrl+F)
                   chat-preview-off  (phase 5) link previews off (the default; or on with 채팅으로 보기 off): chat-link scrolled
                              end to start: no chat.preview call, no card, no blob: URL, no request beyond the harness's server
                   chat-preview  (phase 5) link previews on: chat.preview only for links of rows drawn (never a user's, a tool's,
                              code's, a stopped answer's or a fourth link), once each; the MDN card (its name, its own host, a
                              blob: picture 104×68, after its paragraph), a click opens it through the app; the redirect's
                              → host, a page naming another site shows the link's host; off: cards gone, every blob: URL
                              revoked, nothing asked; the view gone: every blob: URL revoked; chat-link-long: the calls are
                              exactly the links of the rows drawn, at load and after scrolling 1,000 rows up
  --sheet <s>      no shots: writes <out>/sheet-<s>[-WxH].png = before (<out>/../00-before/),
                   the lab reference, after (<out>), side by side or stacked
  --help           this

Surfaces (each at 1440x900 and 1100x720 unless noted):
  session session-compact session-12 session-12-compact session-nomon size-small size-xlarge dex box log rank settings rail
                   (session-nomon: the last session has no Pokémon yet, the plain glyph)
  resume throw swap notes find   (opened by a click: 이어하기, 던지기, 교체, 패치노트, the terminal's find bar)
  widget widget-plain widget-xlarge (340x820; widget-plain: nobody waiting, no question card, as the lab)   toast qa (full page, 1440 wide)   status-card (300x96)
  -work: session-work session-compact-work session-nomon-work rail-work widget-work widget-plain-work settings-work
  -mac:  session-mac rail-mac chat-mac
  chat chat-long chat-tools chat-diff chat-failed chat-agent chat-stream chat-waiting chat-banner chat-empty
                   (the chat view: the first session as chat, conversations from chatFixture.mjs)
  -work (chat): chat-work chat-banner-work chat-empty-work
  chat-compose chat-compose-fail chat-compose-pending (the composer: a draft with two images and a queue of one;
                   the prompt-busy note; a bubble sending and one not in the record yet), -work, chat-compose-mac
  chat-ask-bash chat-ask-edit chat-ask-agent chat-ask-question chat-ask-plan chat-ask-timeout (phase 4: the answer
                   cards above the composer), chat-ask-longpath chat-ask-longline chat-ask-sandbox chat-ask-overwrite
                   chat-ask-long (the review of phase 4), each also -work and -mac
  chat-changes chat-changes-missing chat-changes-empty (1440x900) chat-changes-1100 (1100x720, folded to the rail):
                   the 변경 사항 panel (phase 5); chat-changes also -work and -mac
  chat-thinking chat-all  density (phase 5, seeded spawn-chat-density): 생각 포함 over thinking.jsonl and the lab's
                   turn; 전부 over chat (rows opened); both also -work
  chat-foot        the turn summary (phase 5): the lab's turn finished, the next one ended live with 8걸음 (GET
                   /pokedex routed); also -work (no steps, no read)
  chat-wild        wild Pokémon (phase 5): the lab's work turn with a new Rattata caught (잡았다 · Lv.6 · 새로 등록), a rare
                   Dratini that got away and a shiny Eevee, from the snapshot's game events; also -work (no row)
  chat-find        find in the conversation (phase 5): Ctrl+F, safeRedirect typed and Enter: the bar at the terminal's
                   find place, the matches in grey, the current one stronger
  chat-link        link preview cards (phase 5, 링크 미리보기 seeded on): the lab answer's MDN card under its paragraph;
                   also -work and -mac.   chat-link-settings (1440x900): 설정 › 세션's 링크 미리보기 row under 채팅으로 보기

Files: <surface>-<W>x<H>.png (qa and toast: the PNG's real size, e.g. toast-1342x1630.png).
Exit code 0 only when every requested shot was written and every requested check passed.

Environment: PLAYWRIGHT_CORE (path to playwright-core, default the spawn-promo copy),
SHOTS_BROWSER (a browser executable to use instead of Chromium / Edge / Chrome),
LAB_SHOTS (the lab's reference folder, default calm-lab/shots-v5).
Uses port ${PORT} and tests/visual/.home only.
`

// ---------------------------------------------------------------- surfaces

/**
 * What each base surface opens. view: the carried view (spawn-carry); mode: the window
 * kind; local: extra page storage; then a step to reach it (click a cell, open 설정).
 */
/** 설정 with link previews on (채팅으로 보기 and 링크 미리보기): the link preview surfaces and flows (phase 5) */
const LINK_ON = { session: { chatView: true, linkPreviews: true } }

const SURFACES = {
  session: { view: 'terminal' },
  'session-compact': { view: 'terminal', local: { 'spawn-list-mode': 'compact' } },
  'session-12': { view: 'terminal', twelve: true },
  'session-12-compact': { view: 'terminal', twelve: true, local: { 'spawn-list-mode': 'compact' } },
  // The last session has no Pokémon yet (none rested when it opened): the plain glyph, no Lv, no swap
  'session-nomon': { view: 'terminal', noMon: 1 },
  // spawn-text-size arrives in Task 7 (harmless before); spawn-term-font is today's terminal size
  // and the key the step migrates from, so the before set shows the terminal at that size too
  'size-small': { view: 'terminal', local: { 'spawn-text-size': 'small', 'spawn-term-font': '12' } },
  'size-xlarge': { view: 'terminal', local: { 'spawn-text-size': 'xlarge', 'spawn-term-font': '17' } },
  dex: { view: 'dex', click: '.dex-grid .dex-cell.caught' },
  box: { view: 'box', click: '.box-grid .box-cell' },
  log: { view: 'today', ready: '.today' },
  // The board's own twelve rows (the viewer 7th), as the lab shows them: practice rivals hidden
  rank: { view: 'rank', ready: '.rank-name', local: { 'spawn-rank-npc': '0' } },
  settings: { view: 'terminal', settings: true },
  // The pickers and dialogs, opened by a click as a user would (window mode, the session view)
  resume: { view: 'terminal', open: async page => { await page.locator('.w-side .w-launch-alt').nth(1).click() }, ready: '.resume-item' },
  throw: { view: 'terminal', open: async page => { await page.locator('.w-side .w-launch-main').click() }, ready: '.w-swap-cell' },
  swap: {
    view: 'terminal', ready: '.w-swap-cell',
    open: async page => { const row = page.locator('.w-party .w-row').first(); await row.hover(); await row.locator('.w-row-swap').click() },
  },
  notes: { view: 'terminal', open: async page => { await page.locator('.w-side .w-brand').click() }, ready: '.w-notes-body h3' },
  find: {
    view: 'terminal', ready: '.term-search',
    open: async page => { await page.locator('.w-term-body .xterm').first().click(); await page.keyboard.press('Control+f'); await page.locator('.term-search input').fill('login') },
  },
  rail: { view: 'terminal', local: { 'spawn-side-hidden': '1' } },
  widget: { mode: 'widget', sizes: [[340, 820]] },
  // The lab's widget has no session waiting: no question card over the lower rows (the plain widget above keeps one)
  'widget-plain': { mode: 'widget', sizes: [[340, 820]], plain: true },
  'widget-xlarge': { mode: 'widget', sizes: [[340, 820]], local: { 'spawn-text-size': 'xlarge', 'spawn-term-font': '17' } },
  toast: { page: 'qa', clip: '.qa-section', sizes: [[1440, 900]] },
  qa: { page: 'qa', fullPage: true, sizes: [[1440, 900]] },
  'status-card': { page: 'status-card', sizes: [[300, 96]] },
  // The chat view (chat view phase 2): the first session shown as chat — its terminal armed, 채팅
  // chosen in the carry, chat.open answered with the conversation of chatFixture.mjs by that name
  ...Object.fromEntries(chatFixture.NAMES.map(n => [n, { view: 'terminal', chat: n }])),
  'chat-agent': {
    view: 'terminal', chat: 'chat-agent', ready: '.chat-agent-body .chat-tool',
    open: async page => { await page.locator('.chat-agent .chat-tool-toggle').first().click() },
  },
  // The composer (chat view phase 3): a two-line draft with two pasted images, Claude Code's queue of
  // one and the control row; the prompt-busy refusal; a bubble sending and one not in the record yet
  'chat-compose': { view: 'terminal', chat: 'chat', ready: '.chat-composer .chat-ichip + .chat-ichip', open: async page => composeDraft(page) },
  'chat-compose-fail': { view: 'terminal', chat: 'chat', ready: '.chat-cnote .chat-btn', open: async page => composeFail(page) },
  'chat-compose-pending': { view: 'terminal', chat: 'chat', ready: '.chat-user.pending.sending', open: async page => composePending(page) },
  // The 변경 사항 panel (chat view phase 5): open (spawn-changes-open), changes.jsonl's index built by the real
  // electron/chatChanges.cjs (chatFixture.mjs changes()); the latest changed file (src/math.js: four edits, the third a
  // sub-agent's, the second two hunks 41 lines apart); the patchless edit of src/config.js; a conversation with no edit;
  // at 1100 wide the left panel folded to the rail for it (the lab's narrow, app.css 453)
  'chat-changes': { view: 'terminal', chat: 'chat-changes', sizes: [[1440, 900]], local: { 'spawn-changes-open': '1' }, ready: '.chat-changes .chat-ch-edit .chat-dl', open: async page => changesFile(page, 'math.js') },
  'chat-changes-missing': { view: 'terminal', chat: 'chat-changes', sizes: [[1440, 900]], local: { 'spawn-changes-open': '1' }, ready: '.chat-changes .chat-ch-edit .chat-ch-note', open: async page => changesFile(page, 'config.js') },
  'chat-changes-empty': { view: 'terminal', chat: 'chat-changes-empty', sizes: [[1440, 900]], local: { 'spawn-changes-open': '1' }, ready: '.chat-changes .chat-ch-empty', open: async page => { await page.waitForSelector('.chat-changes', { timeout: 10_000 }) } },
  'chat-changes-1100': { view: 'terminal', chat: 'chat-changes', sizes: [[1100, 720]], local: { 'spawn-changes-open': '1' }, ready: '.widget.side-hidden .chat-changes .chat-ch-edit .chat-dl', open: async page => changesFile(page, 'math.js') },
  // Density (chat view phase 5, seeded spawn-chat-density): 생각 포함 over thinking.jsonl and the lab's turn (each thinking
  // block a row: its time and 생각한 내용은 기록에 남지 않았어요, the one with text shown); 전부 over the chat conversation
  // (the read group, the outputs and the diff opened, the lab's app.css 253–254)
  'chat-thinking': { view: 'terminal', chat: 'chat-thinking', local: { 'spawn-chat-density': 'thinking' }, ready: '.chat .chat-think',
    // (the turns of thinking.jsonl and the lab turn's thinking row above its answer in view)
    // (the list's own scroll only: scrollIntoView would also move the page when the list cannot scroll that far)
    open: async page => {
      await page.waitForSelector('.chat .chat-think')
      await page.evaluate(() => {
        const all = document.querySelectorAll('.chat-think')
        const el = all[all.length - 1].closest('.chat-row')
        const box = document.querySelector('.chat .chat-scroll')
        const a = el.getBoundingClientRect(), b = box.getBoundingClientRect()
        box.scrollTop += a.top - b.top - (b.height - a.height) / 2
      })
      await sleep(400)
    } },
  'chat-all': { view: 'terminal', chat: 'chat', local: { 'spawn-chat-density': 'all' }, ready: '.chat .chat-tool.open',
    // (the work turn in view: its diff whole, the test run's output and the failed lint opened)
    open: async page => {
      for (let k = 0; k < 40 && !(await page.locator('.chat .chat-diff').count()); k++) { await page.evaluate(() => { document.querySelector('.chat-scroll').scrollTop -= 300 }); await sleep(120) }
      // (the list's own scroll only: scrollIntoView moved the whole right column at 1100x720, where the list cannot
      // scroll the diff's row up to its top)
      await page.evaluate(() => {
        const el = document.querySelector('.chat-diff').closest('.chat-row')
        const box = document.querySelector('.chat .chat-scroll')
        box.scrollTop += el.getBoundingClientRect().top - box.getBoundingClientRect().top
      })
      await sleep(500)
    } },
  // The turn summary (chat view phase 5): the lab's first turn finished (1분 48초 · 도구 5회 · 복사), then its second
  // arriving live while the session works; two GET /pokedex reads (routed: 10, then 18 steps) bracket it, so its foot
  // says 8걸음 1.5 s after its end (-work: no read at all, no steps; the same boxes)
  'chat-foot': { view: 'terminal', chat: 'chat-foot', ready: '.chat .chat-foot', open: async page => footShot(page) },
  // Wild Pokémon (chat view phase 5, the lab's .wild): the lab's work turn with a new Rattata caught after the edit (잡았다 ·
  // Lv.6 · 새로 등록), a rare Dratini that got away, a shiny Eevee after the turn, from the game's own events in the snapshot
  // (chatFixture.mjs wild); another session's catch and a level-up make no row. -work: no row at all, the same turn
  'chat-wild': { view: 'terminal', chat: 'chat-wild', ready: '.chat .chat-foot',
    open: async page => {
      const work = await page.evaluate(() => !!window.__SHOT__.workMode)
      if (!work) await page.waitForSelector('.chat .chat-wild', { timeout: 10_000 })
      // (the work turn's edit, its meeting and what follows in view; -work: the same place, by the edit)
      // (the list's own scroll only: scrollIntoView would also move the page)
      await page.evaluate(() => {
        const el = (document.querySelector('.chat .chat-wild') ?? [...document.querySelectorAll('.chat .chat-diff')].pop())?.closest('.chat-row')
        const box = document.querySelector('.chat .chat-scroll')
        if (!el || !box) return
        const a = el.getBoundingClientRect(), b = box.getBoundingClientRect()
        box.scrollTop += a.top - b.top - (b.height - a.height) / 2
      })
      await sleep(600)
    } },
  // Find in the conversation (chat view phase 5): Ctrl+F over the chat conversation, a word typed and Enter pressed: the
  // bar at the terminal's find place (top right), every match a light grey, the current one a stronger grey (no yellow)
  'chat-find': { view: 'terminal', chat: 'chat', ready: '.chat .chat-find',
    open: async page => {
      await page.waitForSelector('.chat .chat-row', { timeout: 15_000 })
      await page.locator('.chat .chat-scroll').focus()
      // (⌘F on the Mac: there Ctrl+F is the session's own key)
      await page.keyboard.press((await page.evaluate(() => document.documentElement.classList.contains('is-mac'))) ? 'Meta+f' : 'Control+f')
      await page.waitForSelector('.chat-find input', { timeout: 5000 })
      await page.keyboard.type('safeRedirect')
      await sleep(400)
      await page.keyboard.press('Enter')
      await sleep(1000)
    } },
  // Link preview cards (chat view phase 5, the lab's .og): 링크 미리보기 on (설정 seeded), the chat-link conversation at its
  // end: the lab's answer with its MDN link and the card under that paragraph (its picture drawn by chatFixture.mjs, shown
  // from a blob: URL the page made). -work: the same card (nothing of the game in it); -mac: the same
  'chat-link': { view: 'terminal', chat: 'chat-link', appSettings: LINK_ON, ready: '.chat .chat-og img', open: async page => linkShot(page) },
  // 설정 › 세션 with the chat view on: 링크 미리보기 (채팅) right under 채팅으로 보기 (off, and enabled)
  'chat-link-settings': { view: 'terminal', chat: 'chat', appSettings: { session: { chatView: true } }, sizes: [[1440, 900]], ready: '.set-modal', open: async page => sessionSettings(page) },
  // (phase 6) a Claude Code newer than the verified range: the quiet note with 자세히 open (what is off, and the way to the help)
  'chat-new-version': { view: 'terminal', chat: 'chat-new-version', ready: '.chat .chat-note', open: async page => {
    await page.locator('.chat .chat-note .chat-link-btn').first().click()
    await page.waitForSelector('.chat .chat-note-more', { timeout: 5000 })
    await sleep(200)
  } },
  // (phase 6) 설정 › 세션 with the chat view on and 채팅 보기란? open: its five lines
  'chat-help-settings': { view: 'terminal', chat: 'chat', appSettings: { session: { chatView: true } }, ready: '.set-modal', open: async page => {
    await sessionSettings(page)
    await page.locator('.set-help-toggle').click()
    await page.waitForSelector('.set-help-lines', { timeout: 5000 })
    await page.evaluate(() => document.querySelector('.set-help')?.scrollIntoView({ block: 'center' }))
    await sleep(300)
  } },
}
const ASK_SURFACES = ['chat-ask-bash', 'chat-ask-edit', 'chat-ask-agent', 'chat-ask-question', 'chat-ask-plan', 'chat-ask-timeout', 'chat-ask-longpath', 'chat-ask-longline', 'chat-ask-sandbox', 'chat-ask-overwrite', 'chat-ask-long']
const WORK = ['session', 'session-compact', 'session-nomon', 'rail', 'widget', 'widget-plain', 'settings', 'chat', 'chat-banner', 'chat-empty', 'chat-compose', 'chat-compose-fail', 'chat-compose-pending', ...ASK_SURFACES, 'chat-changes', 'chat-thinking', 'chat-all', 'chat-foot', 'chat-wild', 'chat-link', 'chat-new-version', 'chat-help-settings']
const MAC = ['session', 'rail', 'chat', 'chat-compose', ...ASK_SURFACES, 'chat-changes', 'chat-thinking', 'chat-foot', 'chat-wild', 'chat-find', 'chat-link', 'chat-new-version']
const SIZES = [[1440, 900], [1100, 720]]

const ALL_IDS = [...Object.keys(SURFACES), ...WORK.map(s => `${s}-work`), ...MAC.map(s => `${s}-mac`)]

/** 'session-compact-work' -> { base: 'session-compact', work: true, mac: false } */
function parseId(id) {
  let base = id, work = false, mac = false
  if (base.endsWith('-mac')) { mac = true; base = base.slice(0, -4) }
  if (base.endsWith('-work')) { work = true; base = base.slice(0, -5) }
  if (!SURFACES[base] || (work && !WORK.includes(base)) || (mac && !MAC.includes(base))) return null
  return { id, base, work, mac, ...SURFACES[base] }
}

/** The lab picture a surface is compared with (docs/superpowers/plans/2026-11-14-calm-style-2.md) */
const LAB_REF = {
  session: 's2-session-terminal.png', 'session-compact': 's2-chat-compact.png', 'session-12-compact': 's2-chat-compact.png', 'session-work': 's2-work-terminal.png',
  'size-small': 's2-size-smallest-terminal.png', 'size-xlarge': 's2-size-largest-terminal.png',
  dex: 'dex-calm2.png', box: 'box-calm2.png', log: 'log-calm2.png', rank: 'rank-calm2.png', settings: 'settings-calm2.png', toast: 'toast-calm2.png',
  widget: 'widget-calm2.png', 'widget-work': 'widget-calm2-work.png', 'widget-plain': 'widget-calm2.png', 'widget-plain-work': 'widget-calm2-work.png', rail: 'rail-calm2.png', 'rail-work': 'rail-calm2-work.png',
  chat: 's2-chat-detail.png', 'chat-work': 's2-work-chat.png', 'chat-compose': 's2-chat-detail.png', 'chat-compose-work': 's2-work-chat.png', 'chat-banner': 's2-chat-detail.png', 'chat-tools': 's2-chat-detail.png', 'chat-diff': 's2-chat-detail.png',
  'chat-changes': 's2-chat-panel.png', 'chat-changes-missing': 's2-chat-panel.png', 'chat-changes-empty': 's2-chat-panel.png', 'chat-changes-work': 's2-work-chat.png', 'chat-changes-1100': 's2-chat-1100.png',
  'chat-thinking': 's2-chat-detail.png', 'chat-thinking-work': 's2-work-chat.png', 'chat-all': 's2-chat-detail.png', 'chat-all-work': 's2-work-chat.png',
  'chat-foot': 's2-chat-panel.png', 'chat-foot-work': 's2-work-chat.png',
  'chat-wild': 's2-chat-panel.png', 'chat-wild-work': 's2-work-chat.png',
  'chat-find': 's2-chat-detail.png',
  'chat-link': 's2-chat-panel.png', 'chat-link-work': 's2-work-chat.png', 'chat-link-settings': 'settings-calm2.png',
}
const LAB_1100 = new Set(['session', 'session-compact', 'session-12', 'session-12-compact', 'session-mac', 'chat', 'chat-mac'])
function labRef(surface, size) {
  if (size === '1100x720' && LAB_1100.has(surface)) return 's2-chat-1100.png'
  return LAB_REF[surface] ?? LAB_REF[surface.replace(/-mac$/, '')] ?? null
}

// ---------------------------------------------------------------- arguments

function parseArgs(argv) {
  const o = { out: join(HOME, 'shots'), only: null, size: null, side: null, text: null, lang: null, checks: new Set(), flows: [], sheets: [], help: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    const val = () => { const v = argv[++i]; if (v === undefined || v.startsWith('--')) fail(`${a} needs a value`); return v }
    if (a === '--help' || a === '-h') o.help = true
    else if (a === '--out') o.out = resolve(val())
    else if (a === '--only') o.only = val().split(',').map(s => s.trim()).filter(Boolean)
    else if (a === '--size') o.size = val()
    else if (a === '--side') o.side = val()
    else if (a === '--text') o.text = val()
    else if (a === '--lang') o.lang = val()
    else if (a === '--check') for (const c of val().split(',')) o.checks.add(c.trim())
    else if (a === '--flow') o.flows.push(val())
    else if (a === '--sheet') o.sheets.push(...val().split(',').map(s => s.trim()).filter(Boolean))
    else fail(`unknown argument ${a} (see --help)`)
  }
  for (const c of o.checks) if (c !== 'fit' && c !== 'work') fail(`unknown check "${c}": fit or work`)
  if (o.size && !/^\d+x\d+$/.test(o.size)) fail(`--size wants WxH, e.g. 1100x720`)
  if (o.side !== null && !/^\d+$/.test(o.side)) fail(`--side wants a width in px, e.g. 240`)
  if (o.text !== null && !['small', 'large', 'xlarge'].includes(o.text)) fail(`--text wants small, large or xlarge`)
  if (o.lang !== null && !['en', 'ja'].includes(o.lang)) fail(`--lang wants en or ja`)
  for (const id of [...(o.only ?? []), ...o.sheets]) if (!parseId(id)) fail(`unknown surface "${id}". Surfaces: ${ALL_IDS.join(' ')}`)
  for (const f of o.flows) if (!FLOWS[f]) fail(`unknown flow "${f}". Flows: ${Object.keys(FLOWS).join(' ')}`)
  return o
}

/** The server child while it runs: killed on every way out (a child outlives process.exit on Windows) */
let serverChild = null
function stopServer() {
  if (serverChild && serverChild.exitCode === null) { try { serverChild.kill() } catch { /* already gone */ } }
  serverChild = null
}
process.on('exit', stopServer)
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK']) {
  process.on(sig, () => { stopServer(); process.exit(130) })
}
process.on('uncaughtException', err => { console.error(err); stopServer(); process.exit(1) })
process.on('unhandledRejection', err => { console.error(err); stopServer(); process.exit(1) })

function fail(msg) {
  console.error(`shots: ${msg}`)
  stopServer()
  process.exit(2)
}

// ---------------------------------------------------------------- flows

/** name -> async (ctx) => string[] (problems) */
const FLOWS = {
  /**
   * The session tab row is gone (calm-style plan, Task 5): every job it did still has a home.
   * In 상세, in 간략 and with the left panel folded: × asks 닫기 once, the ask clears when the
   * mouse leaves, a second click closes (one terminals.close with that row's terminal); rename
   * opens exactly one field and Enter sends one terminals.rename; a drag sends one
   * terminals.move. Also: the list header's >_ / + / 간략·상세, the rail's >_, switching by the
   * rail and by Ctrl+Tab / Ctrl+Shift+Tab (the header follows), the chosen row kept in sight
   * among twelve, and 업무 모드's header with no picture. And (the final review's M1, M2): an
   * ended session's 간략 row is dimmed; the widget's >_ that opens no shell keeps the widget and
   * its note.
   */
  'tabs-gone': async ({ browser }) => {
    const problems = []
    const run = async (label, setup, steps) => {
      let app
      try {
        app = await openApp(browser, setup)
        await steps(app, m => problems.push(`${label}: ${m}`))
      } catch (err) {
        problems.push(`${label}: ${String(err.message).split('\n')[0]}`)
      } finally {
        if (app) await app.ctx.close()
      }
    }
    for (const [label, local] of [['상세', {}], ['간략', { 'spawn-list-mode': 'compact' }]]) {
      await run(label, { local }, async ({ page, shot }, bad) => {
        const rows = page.locator('.w-party .w-row')
        const compact = await page.locator('.w-rows.compact').count()
        if (!!compact !== (label === '간략')) bad(`.w-rows.compact is ${compact ? 'there' : 'missing'}`)
        if (await page.locator('.w-sess-tabs, .w-sess-tab').count()) bad('a session tab row is still drawn')
        if (!(await page.locator('.w-sess-bar .w-sess-head').count())) bad('no session header')
        // 간략 rows are one line: no second line, no bottom line
        if (label === '간략' && await page.locator('.w-row .w-row-line2, .w-row .w-row-bottom').count()) bad('a 간략 row has a second or bottom line')
        if (label === '간략') {
          // The status is a plain dot (확인 필요 too: hovered, the × takes its place, so no button there)
          if (await page.locator('.w-rows.compact button.w-pill').count()) bad('a 간략 row draws its status as a button')
          // The name has no tooltip of its own (it would hide the row's); the row's says how to rename
          if (await page.locator('.w-rows.compact .w-row-name[title]').count()) bad("a 간략 row's name has its own tooltip")
          const tip = await rows.nth(0).getAttribute('title')
          if (!tip?.includes('\n더블클릭해서 세션 이름 바꾸기')) bad(`the 간략 row's tooltip does not say how to rename: ${JSON.stringify(tip)}`)
        }
        await closeAsksThenCloses(page, rows.nth(1), rows.nth(1).locator('.w-row-close'), shot.terminals[1].id, bad)
        // Double-click row 1's name: exactly one field, in that row; Enter renames once
        await rows.nth(0).locator('.w-row-name').dblclick()
        await renameOnce(page, rows.nth(0).locator('input.w-row-rename'), shot.terminals[0].id, '새 이름', bad)
        // Drag row 1 below row 2: one terminals.move with row 1's terminal
        const b1 = await rows.nth(0).boundingBox(), b2 = await rows.nth(1).boundingBox()
        const x = b1.x + 70, y = b1.y + b1.height / 2
        await page.mouse.move(x, y)
        await page.mouse.down()
        for (let k = 1; k <= 12; k++) await page.mouse.move(x, y + ((b2.height + 6) * k) / 12)
        await page.mouse.up()
        await sleep(150)
        const moves = (await calls(page)).filter(c => c.fn === 'move')
        if (moves.length !== 1 || moves[0].args[0] !== shot.terminals[0].id) bad(`drag: expected one move of ${shot.terminals[0].id}, got ${JSON.stringify(moves)}`)
        if (label !== '상세') return
        // The list header: >_ opens a shell, + asks who goes (the picker), 간략 / 상세 switch and are kept
        await page.locator('.w-list-head .w-list-shell').click()
        await sleep(100)
        const shells = (await calls(page)).filter(c => c.fn === 'create')
        if (shells.length !== 1 || shells[0].args[0]?.tool !== 'shell') bad(`>_: expected one create { tool: 'shell' }, got ${JSON.stringify(shells)}`)
        await page.locator('.w-list-head .w-list-btn:not(.w-list-shell)').click()
        if (!(await page.locator('.resume-modal[role="dialog"]').count())) bad('+ did not open the "who goes?" picker')
        else await page.locator('.resume-backdrop').click({ position: { x: 4, y: 4 } })
        await page.locator('.w-list-mode button', { hasText: '간략' }).click()
        const kept = await page.evaluate(() => localStorage.getItem('spawn-list-mode'))
        if (!(await page.locator('.w-rows.compact').count()) || kept !== 'compact') bad(`간략 did not switch the list (stored ${kept})`)
        if (await page.locator('.w-list-mode button[aria-pressed="true"]').textContent() !== '간략') bad('간략 is not the pressed button')
        await page.locator('.w-list-mode button', { hasText: '상세' }).click()
        if (await page.locator('.w-rows.compact').count()) bad('상세 did not switch the list back')
      })
    }
    // The left panel folded: the header and the rail do it all
    await run('접힘', { local: { 'spawn-side-hidden': '1' } }, async ({ page, shot }, bad) => {
      const head = page.locator('.w-sess-head')
      await closeAsksThenCloses(page, head, head.locator('.w-sess-head-close'), shot.terminals[0].id, bad)
      await head.locator('.w-sess-head-name').dblclick()
      await renameOnce(page, head.locator('input.w-sess-head-rename'), shot.terminals[0].id, '새 이름', bad)
      const name = () => head.locator('.w-sess-head-name').textContent()
      const titles = shot.terminals.map(t => t.title ?? '새 세션')
      await page.locator('.w-rail-session').nth(1).click()
      if (await name() !== titles[1]) bad(`the rail's 2nd session: the header reads "${await name()}", not "${titles[1]}"`)
      await page.keyboard.press('Control+Tab')
      if (await name() !== titles[2]) bad(`Ctrl+Tab: the header reads "${await name()}", not "${titles[2]}"`)
      await page.keyboard.press('Control+Shift+Tab')
      await page.keyboard.press('Control+Shift+Tab')
      if (await name() !== titles[0]) bad(`Ctrl+Shift+Tab twice: the header reads "${await name()}", not "${titles[0]}"`)
      // The header's rename field open, then another session shown: the field goes and does not come
      // back with the first session (the rename state is cleared, nothing renamed)
      const renamesBefore = (await calls(page)).filter(c => c.fn === 'rename').length
      await head.locator('.w-sess-head-name').dblclick()
      if (!(await head.locator('input.w-sess-head-rename').count())) bad('double-click on the header name opened no field')
      await page.keyboard.press('Control+Tab')
      await sleep(80)
      if (await page.locator('input.w-sess-head-rename, input.w-row-rename').count()) bad('a rename field is open after Ctrl+Tab to another session')
      await page.keyboard.press('Control+Shift+Tab')
      await sleep(80)
      if (await page.locator('input.w-sess-head-rename, input.w-row-rename').count()) bad('the header rename field came back with the first session (stale rename state)')
      if ((await calls(page)).filter(c => c.fn === 'rename').length !== renamesBefore) bad('switching away from an open rename field renamed the session')
      await page.locator('.w-rail .w-rail-newshell').click()
      await sleep(100)
      const shells = (await calls(page)).filter(c => c.fn === 'create')
      if (shells.length !== 1 || shells[0].args[0]?.tool !== 'shell') bad(`the rail's >_: expected one create { tool: 'shell' }, got ${JSON.stringify(shells)}`)
    })
    // Twelve sessions in a small window: the chosen row is scrolled into sight
    await run('12개', { twelve: true, size: [1100, 720] }, async ({ page, shot }, bad) => {
      await page.keyboard.press('Control+Shift+Tab')
      await sleep(300)
      const seen = await page.evaluate(() => {
        const list = document.querySelector('.w-party').getBoundingClientRect()
        const row = document.querySelector('.w-row.chosen')?.getBoundingClientRect()
        return row ? row.top >= list.top - 0.5 && row.bottom <= list.bottom + 0.5 : null
      })
      if (seen !== true) bad(`the chosen row (the last of ${shot.terminals.length}) is ${seen === null ? 'missing' : 'out of sight'} after Ctrl+Shift+Tab`)
    })
    // The same picked with the panel folded: unfolding it brings the chosen row into sight
    await run('12개 접힘', { twelve: true, size: [1100, 720], local: { 'spawn-side-hidden': '1' } }, async ({ page, shot }, bad) => {
      await page.keyboard.press('Control+Shift+Tab')
      await sleep(200)
      await page.locator('.w-rail .w-side-toggle').click()
      await sleep(300)
      const seen = await page.evaluate(() => {
        const list = document.querySelector('.w-party').getBoundingClientRect()
        const row = document.querySelector('.w-row.chosen')?.getBoundingClientRect()
        return row ? row.top >= list.top - 0.5 && row.bottom <= list.bottom + 0.5 : null
      })
      if (seen !== true) bad(`unfolded: the chosen row (the last of ${shot.terminals.length}) is ${seen === null ? 'missing' : 'out of sight'}`)
    })
    // 간략 in the widget: a click on a session waiting on you opens its terminal (the 확인 필요 button's job in 상세)
    await run('간략 위젯', { mode: 'widget', size: [340, 820], local: { 'spawn-list-mode': 'compact' } }, async ({ page }, bad) => {
      const row = page.locator('.w-rows.compact .w-row.mood-needs-you').first()
      if (!(await row.count())) { bad('no needs-you row in the fixture'); return }
      await row.locator('.w-row-name').click()
      await sleep(200)
      if (!(await page.locator('.widget.mode-window').count())) bad('a click on the needs-you row did not open the window')
      else if (!(await page.locator('.w-sess-bar .w-sess-head').count())) bad('the window opened, but not on the sessions view')
    })
    // 간략: an ended session is dimmed, as the rail does (its dot alone would read as 쉬는 중)
    await run('간략 종료', { ended: 3, local: { 'spawn-list-mode': 'compact' } }, async ({ page }, bad) => {
      const o = await page.evaluate(() => [...document.querySelectorAll('.w-rows.compact .w-row')].map(r => ({ ended: r.classList.contains('mood-ended'), opacity: parseFloat(getComputedStyle(r).opacity) })))
      if (!o[3]?.ended) { bad('row 4 is not drawn as ended (the fixture marks its terminal exited)'); return }
      if (o[3].opacity > 0.6) bad(`an ended 간략 row is not dimmed (opacity ${o[3].opacity})`)
      if (o.some((r, i) => i !== 3 && r.opacity < 1)) bad('a live 간략 row is dimmed')
    })
    // The widget's >_ when no shell opens (here the bridge refuses: no pty; also at the limit): the
    // widget stays a widget and its note says why (the window would be built anew and lose it)
    await run('위젯 >_', { mode: 'widget', size: [340, 820] }, async ({ page }, bad) => {
      await page.locator('.w-list-head .w-list-shell').click()
      await sleep(400)
      if (await page.locator('.widget.expanded, .widget.mode-window').count()) bad('a refused >_ opened the window')
      const note = await page.locator('.w-note').textContent().catch(() => null)
      if (!note?.includes('세션을 열 수 없어요')) bad(`no note says the shell did not open (note: ${JSON.stringify(note)})`)
    })
    // 업무 모드, folded: the header shows a glyph, no picture
    await run('업무 모드', { work: true, local: { 'spawn-side-hidden': '1' } }, async ({ page }, bad) => {
      if (await page.locator('.w-sess-head img').count()) bad('a picture in the session header')
      if (!(await page.locator('.w-sess-head .w-sess-head-glyph').count())) bad('no glyph in the session header')
    })
    return problems
  },

  /**
   * The left panel's right edge (calm-style plan, Task 6): 300px at first, dragged to a width
   * clamped to 240–420 and remembered (spawn-side-w), the terminal fitted again once it rests
   * (fewer columns, and the session told the new size); double-click and Home go back to 300
   * and forget it; ← / → move 16px; a window too narrow keeps the terminal 320px; no edge
   * when the panel is folded or in widget mode. The centre line shows only while dragged or hovered.
   */
  'side-resize': async ({ browser }) => {
    const problems = []
    let app
    try {
      app = await openApp(browser, { smoke: true, commits: true })
      const { page, shot } = app
      const bad = m => problems.push(m)
      const id = shot.terminals[0].id
      const width = () => page.evaluate(() => document.querySelector('.w-side').getBoundingClientRect().width)
      const stored = () => page.evaluate(() => localStorage.getItem('spawn-side-w'))
      const line = () => page.evaluate(() => getComputedStyle(document.querySelector('.w-side-resize'), '::after').backgroundColor)
      const near = (a, b) => Math.abs(a - b) <= 1
      const handle = page.locator('.w-side-resize')
      if ((await handle.count()) !== 1) { bad(`${await handle.count()} resize edge(s)`); return problems }
      if (!near(await width(), 300)) bad(`the panel starts at ${await width()}px, not 300`)
      if ((await line()) !== 'rgba(0, 0, 0, 0)') bad(`the edge's line shows at rest (${await line()})`)
      await sleep(400)
      const cols0 = await termCols(page, id)
      if (!cols0) bad('no terminal metrics (spawnTermMetrics)')
      const commits = () => page.evaluate(() => window.__COMMITS__ ?? null)
      const drag = async (toX, check, { cancel = false } = {}) => {
        const b = await handle.boundingBox()
        const x = b.x + b.width / 2, y = b.y + 300
        await page.mouse.move(x, y)
        await page.mouse.down()
        await sleep(50)
        const c0 = await commits()
        for (let k = 1; k <= 8; k++) await page.mouse.move(x + ((toX - x) * k) / 8, y)
        // The page is not drawn again for each move: the edge sets the width itself and React hears once, on release
        const during = (await commits()) - c0
        if (c0 !== null && during > 2) bad(`dragging re-rendered the app ${during} times for 8 moves`)
        if (check) await check()
        // A cancelled drag (the system took the pointer): the panel goes back to the stored width
        if (cancel) await handle.evaluate(el => el.dispatchEvent(new PointerEvent('pointercancel', { pointerId: 1, bubbles: true })))
        await page.mouse.up()
        await sleep(400)
      }
      await drag(350, null, { cancel: true })
      if (await page.locator('.widget.resizing').count()) bad('.widget.resizing stayed after a cancelled drag')
      if (!near(await width(), 300) || await stored() !== null) bad(`a cancelled drag: the panel is ${await width()}px, stored ${await stored()} (want 300, none: the screen as stored)`)
      // Released where it started (the last move showed 350, the release lands on the width it
      // already had): the panel shows the width it keeps, and says so
      {
        const b = await handle.boundingBox()
        const x = b.x + b.width / 2, y = b.y + 300
        await page.mouse.move(x, y)
        await page.mouse.down()
        await page.mouse.move(x + 50, y)
        await handle.evaluate((el, cx) => el.dispatchEvent(new PointerEvent('pointerup', { pointerId: 1, bubbles: true, clientX: cx, clientY: 300, button: 0, pointerType: 'mouse' })), x)
        await page.mouse.up()
        await sleep(300)
        const now = await handle.getAttribute('aria-valuenow')
        if (!near(await width(), 300) || now !== '300') bad(`released back at 300 after showing 350: the panel is ${await width()}px, aria-valuenow ${now} (want 300)`)
        await handle.dblclick()
        await sleep(100)
      }
      // Focused (keyboard), the edge's line is visible: 3:1 against the panel beside it
      await handle.focus()
      const focusLine = await page.evaluate(() => {
        const lum = c => { const [r, g, b] = c.match(/[\d.]+/g).slice(0, 3).map(Number).map(v => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4 }); return 0.2126 * r + 0.7152 * g + 0.0722 * b }
        const line = getComputedStyle(document.querySelector('.w-side-resize'), '::after').backgroundColor
        const side = getComputedStyle(document.querySelector('.w-side')).backgroundColor
        const a = Number((line.match(/[\d.]+/g) ?? [])[3] ?? 1)
        const [l, s] = [line, side].map(c => c.match(/[\d.]+/g).slice(0, 3).map(Number))
        const mixed = `rgb(${l.map((v, i) => Math.round(v * a + s[i] * (1 - a))).join(',')})`
        const x = lum(mixed), y = lum(side)
        return { line, ratio: (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05) }
      })
      if (focusLine.ratio < 3) bad(`the focused edge's line (${focusLine.line}) is ${focusLine.ratio.toFixed(2)}:1 on the panel, under 3:1`)
      await handle.blur()
      const before = (await calls(page)).length
      await drag(380, async () => {
        if (!(await page.locator('.widget.resizing').count())) bad('no .widget.resizing while dragging')
        if ((await line()) === 'rgba(0, 0, 0, 0)') bad("the edge's line is hidden while dragging")
        if (!near(await width(), 380)) bad(`while dragging to 380 the panel is ${await width()}px`)
      })
      if (await page.locator('.widget.resizing').count()) bad('.widget.resizing stayed after the drag')
      if (!near(await width(), 380)) bad(`dragged to 380: the panel is ${await width()}px`)
      if (await stored() !== '380') bad(`dragged to 380: spawn-side-w is ${await stored()}`)
      const cols1 = await termCols(page, id)
      if (!(cols1 < cols0)) bad(`the terminal did not fit again: ${cols0} → ${cols1} columns`)
      const sizes = (await calls(page)).slice(before).filter(c => c.fn === 'resize' && c.args[0] === id)
      if (sizes.length !== 1 || sizes[0].args[1] !== cols1) bad(`the session was not told ${cols1} columns once: ${JSON.stringify(sizes)}`)
      await drag(900)
      if (!near(await width(), 420) || await stored() !== '420') bad(`dragged far right: ${await width()}px, stored ${await stored()} (want 420)`)
      await drag(40)
      if (!near(await width(), 240) || await stored() !== '240') bad(`dragged far left: ${await width()}px, stored ${await stored()} (want 240)`)
      await handle.dblclick()
      await sleep(100)
      if (!near(await width(), 300) || await stored() !== null) bad(`double-click: ${await width()}px, stored ${await stored()} (want 300, none)`)
      await handle.focus()
      await page.keyboard.press('ArrowRight')
      if (!near(await width(), 316) || await stored() !== '316') bad(`→: ${await width()}px, stored ${await stored()} (want 316)`)
      await page.keyboard.press('ArrowLeft')
      await page.keyboard.press('ArrowLeft')
      if (!near(await width(), 284) || await stored() !== '284') bad(`← twice: ${await width()}px, stored ${await stored()} (want 284)`)
      if (await handle.getAttribute('aria-valuenow') !== '284') bad(`aria-valuenow ${await handle.getAttribute('aria-valuenow')}, not 284`)
      await page.keyboard.press('Home')
      if (!near(await width(), 300) || await stored() !== null) bad(`Home: ${await width()}px, stored ${await stored()} (want 300, none)`)
      // A narrow window: the terminal keeps 320px, the panel never under 240
      for (let k = 0; k < 10; k++) await page.keyboard.press('ArrowRight')
      if (await stored() !== '420') bad(`→ ten times: stored ${await stored()} (want 420)`)
      await page.setViewportSize({ width: 700, height: 720 })
      await sleep(400)
      if (!near(await width(), 380)) bad(`420 in a 700px window: the panel is ${await width()}px, not 380`)
      await page.setViewportSize({ width: 560, height: 720 })
      await sleep(400)
      if (!near(await width(), 240)) bad(`in a 560px window: the panel is ${await width()}px, not 240`)
      await page.setViewportSize({ width: 1440, height: 900 })
      await sleep(400)
      if (!near(await width(), 420)) bad(`back to 1440: the panel is ${await width()}px, not the remembered 420`)
      // Folded and widget mode: no edge
      await page.locator('.w-head .w-side-toggle').click()
      if (await handle.count()) bad('an edge while the panel is folded')
      await page.locator('.w-rail .w-side-toggle').click()
      if ((await handle.count()) !== 1) bad('no edge after unfolding')
      await page.locator('.w-widget-toggle').click()
      await sleep(200)
      if (!(await page.locator('.widget.mode-widget').count())) bad('the widget toggle did not switch to widget mode')
      if (await handle.count()) bad('an edge in widget mode')
    } catch (err) {
      problems.push(String(err.message).split('\n')[0])
    } finally {
      if (app) await app.ctx.close()
    }
    return problems
  },

  /**
   * One text step for the UI and the terminal (calm-style plan, Task 7): the step a page
   * starts on (picked, or carried over from the old terminal size, nearest step, ties larger,
   * nothing written), its <html> class, the terminal's px, the UI's name size, the lockup the
   * same at every step, and the terminal's rows inside its box (measured with the bundled face).
   */
  'text-size': async ({ browser, opts }) => {
    const problems = []
    const cases = [
      ['nothing stored', {}, 'normal'],
      ['old 12px', { 'spawn-term-font': '12' }, 'small'],
      ['old 14px (a tie)', { 'spawn-term-font': '14' }, 'large'],
      ['old 17px', { 'spawn-term-font': '17' }, 'xlarge'],
      ['old 20px', { 'spawn-term-font': '20' }, 'xlarge'],
      ['old garbage', { 'spawn-term-font': 'abc' }, 'normal'],
      ['picked 크게 over old 12px', { 'spawn-text-size': 'large', 'spawn-term-font': '12' }, 'large'],
    ]
    const TERM = { small: 12, normal: 13, large: 15, xlarge: 17 }
    const NAME = { small: 11, normal: 12, large: 13, xlarge: 14 }
    let lockup = null
    for (const [label, local, want] of cases) {
      let app
      const bad = m => problems.push(`${label}: ${m}`)
      try {
        app = await openApp(browser, { local, smoke: true })
        const { page, shot } = app
        await sleep(500)
        const got = await textState(page, shot.terminals[0].id)
        if (got.cls !== (want === 'normal' ? '' : `ts-${want}`)) bad(`<html> has "${got.cls}", want ${want}`)
        if (got.term?.fontSize !== TERM[want]) bad(`the terminal is ${got.term?.fontSize}px, want ${TERM[want]}`)
        if (got.name !== `${NAME[want]}px`) bad(`--t-name is ${got.name}, want ${NAME[want]}px`)
        if (got.stored !== (local['spawn-text-size'] ?? null)) bad(`spawn-text-size was written: ${got.stored}`)
        if (got.old !== (local['spawn-term-font'] ?? null)) bad(`spawn-term-font changed: ${got.old}`)
        if (!got.fits) bad(`the terminal's rows overflow its box: ${JSON.stringify(got.box)}`)
        lockup ??= got.lockup
        if (JSON.stringify(got.lockup) !== JSON.stringify(lockup)) bad(`the lockup changed: ${JSON.stringify(got.lockup)} vs ${JSON.stringify(lockup)}`)
        console.log(`      ${label}: ${got.cls || '(보통)'} · terminal ${got.term?.fontSize}px ${got.term?.cols}×${got.term?.rows} · --t-name ${got.name} · lockup ${got.lockup.font} ${got.lockup.w}px`)
      } catch (err) {
        bad(String(err.message).split('\n')[0])
      } finally {
        if (app) await app.ctx.close()
      }
    }
    // Task 8: the keys, the wheel and the − 가 + control move the same step, once per press
    for (const mac of [false, true]) {
      let app
      const label = mac ? 'Mac' : 'Windows'
      const bad = m => problems.push(`${label}: ${m}`)
      const mod = mac ? 'Meta' : 'Control'
      try {
        app = await openApp(browser, { smoke: true, mac })
        const { page, shot } = app
        const id = shot.terminals[0].id
        const cls = async () => (await textState(page, id)).cls || '(보통)'
        const expectStep = async (want, after) => {
          await sleep(350)
          const got = await textState(page, id)
          const c = got.cls || '(보통)'
          if (c !== want) bad(`${after}: <html> is ${c}, want ${want}`)
          const step = want === '(보통)' ? 'normal' : want.slice(3)
          if (got.term?.fontSize !== TERM[step]) bad(`${after}: the terminal is ${got.term?.fontSize}px, want ${TERM[step]}`)
          if (!got.fits) bad(`${after}: the terminal's rows overflow its box ${JSON.stringify(got.box)}`)
        }
        const control = page.locator('.w-term-tabs .w-textsize')
        if ((await control.count()) !== 1) bad(`${await control.count()} text-size control(s) in the bar`)
        const curText = async () => (await control.locator('.w-textsize-cur').textContent()).trim()
        if (await curText() !== '100%') bad(`the control reads "${await curText()}", not 100%`)
        const tip = await control.locator('.w-textsize-cur').getAttribute('title')
        if (!tip.includes(mac ? '⌘+=' : 'Ctrl+=') || (mac && tip.includes('Ctrl'))) bad(`the tooltip names the wrong key: ${tip}`)
        // Keys with the terminal focused: one step per press, the terminal's own handler never doubles it
        await page.locator('.w-term-body .xterm-helper-textarea').first().focus()
        await page.keyboard.press(`${mod}+Equal`)
        await expectStep('ts-110', `${mod}+= once in the terminal`)
        await page.keyboard.press(`${mod}+Equal`)
        await page.keyboard.press(`${mod}+Equal`)
        await expectStep('ts-130', `${mod}+= three times in the terminal`)
        if (await curText() !== '130%') bad(`at 130% the control reads "${await curText()}"`)
        if (!(await control.locator('.w-textsize-step').last().isDisabled())) bad('+ is not disabled at 130%')
        // Another view: the keys still act (held at the top)
        await page.locator('.w-view-tabs button').nth(1).click()
        await page.waitForSelector('.w-dex-body', { timeout: 10_000 })
        await page.keyboard.press(`${mod}+Equal`)
        if (await cls() !== 'ts-130') bad(`${mod}+= on 도감 at the top: ${await cls()}`)
        await page.keyboard.press(`${mod}+Minus`)
        if (await cls() !== 'ts-120') bad(`${mod}+- on 도감: ${await cls()}, want ts-120`)
        await page.keyboard.press(`${mod}+Digit0`)
        if (await cls() !== '(보통)') bad(`${mod}+0 on 도감: ${await cls()}, want no ts- class`)
        await page.locator('.w-view-tabs button').nth(0).click()
        await sleep(200)
        // The wheel with the modifier: over the list (the window's listener) and over the terminal (the terminal's), once each
        await page.locator('.w-party .w-row').first().hover()
        await page.keyboard.down(mod)
        await page.mouse.wheel(0, -100)
        await page.keyboard.up(mod)
        await expectStep('ts-110', `${mod}+wheel up over the list`)
        await page.locator('.w-term-body .term-view').first().hover({ position: { x: 200, y: 200 } })
        await page.keyboard.down(mod)
        await page.mouse.wheel(0, 100)
        await page.keyboard.up(mod)
        await expectStep('(보통)', `${mod}+wheel down over the terminal`)
        // A plain wheel is a scroll, not a step
        await page.locator('.w-party .w-row').first().hover()
        await page.mouse.wheel(0, -100)
        await expectStep('(보통)', 'a plain wheel')
        // The control: − / +, the menu (pick, Esc, outside press)
        await control.locator('.w-textsize-step').first().click()
        await expectStep('ts-90', '− once')
        await control.locator('.w-textsize-step').first().click()
        await expectStep('ts-80', '− twice')
        if (!(await control.locator('.w-textsize-step').first().isDisabled())) bad('− is not disabled at 80%')
        await control.locator('.w-textsize-step').last().click()
        await control.locator('.w-textsize-step').last().click()
        await expectStep('(보통)', '+ twice')
        await control.locator('.w-textsize-cur').click()
        const menu = control.locator('.w-textsize-menu')
        if (!(await menu.count())) bad('the middle button did not open the menu')
        else {
          const items = await menu.locator('.w-textsize-item').allTextContents()
          if (items.join('|') !== '80%|90%|100%|110%|120%|130%') bad(`the menu rows: ${items.join(' | ')}`)
          if ((await menu.locator('.w-textsize-item.on').textContent()).indexOf('100%') !== 0) bad('100% is not the checked row')
          const mb = await menu.boundingBox(), term = await page.locator('.w-term').boundingBox()
          if (mb.x + mb.width > term.x + term.width + 0.5 || mb.width !== 140) bad(`the menu is ${mb.width}px wide, ends at ${mb.x + mb.width} (card ${term.x + term.width})`)
          const top = await page.evaluate(() => { const m = document.querySelector('.w-textsize-menu').getBoundingClientRect(); const el = document.elementFromPoint(m.left + 20, m.bottom - 12); return !!el?.closest('.w-textsize-menu') })
          if (!top) bad('the menu is covered by something (the terminal?)')
          // A picture of the open menu, for the record
          if (opts?.out) await page.screenshot({ path: join(opts.out, `flow-text-size-menu${mac ? '-mac' : ''}.png`), animations: 'disabled', caret: 'hide' })
          await menu.locator('.w-textsize-item', { hasText: '120%' }).click()
          await expectStep('ts-120', 'picking 120%')
          if (await menu.count()) bad('the menu stayed open after a pick')
        }
        await control.locator('.w-textsize-cur').click()
        await page.keyboard.press('Escape')
        if (await menu.count()) bad('Esc did not close the menu')
        await control.locator('.w-textsize-cur').click()
        await page.mouse.click(700, 500)
        if (await menu.count()) bad('a press outside did not close the menu')
        if (await page.evaluate(() => localStorage.getItem('spawn-text-size')) !== '120') bad('the step was not remembered')
        // The bar never scrolls: at 아주 크게 the views drop to icons when it is narrow
        await page.setViewportSize({ width: 900, height: 700 })
        await sleep(300)
        const bar = await page.evaluate(() => { const b = document.querySelector('.w-term-tabs'); return { sw: b.scrollWidth, cw: b.clientWidth, icons: !!b.querySelector('.w-view-icons') } })
        if (bar.sw > bar.cw + 1) bad(`at 900px the bar overflows: ${bar.sw} > ${bar.cw}`)
        console.log(`      ${label}: keys, wheel, − 가 + and the menu checked; at 900px the bar is ${bar.cw}px, views ${bar.icons ? 'icons only' : 'named'}`)
        // Narrower still: the views must drop to icons (the bar's level reads scrollWidth, the bar is overflow: visible).
        // (Near the window's 560px minimum the text size folds and the widget toggle goes: --flow narrow)
        await page.setViewportSize({ width: 640, height: 700 })
        await sleep(400)
        const narrow = await page.evaluate(() => { const b = document.querySelector('.w-term-tabs'); return { sw: b.scrollWidth, cw: b.clientWidth, icons: !!b.querySelector('.w-view-icons'), kids: [...b.children].map(c => `${c.className.split(' ')[0]}:${Math.round(c.getBoundingClientRect().width)}`).join(' ') } })
        if (!narrow.icons) bad(`at 640px the views kept their names: bar ${narrow.sw} / ${narrow.cw} (${narrow.kids})`)
        console.log(`      ${label}: at 640px the bar is ${narrow.cw}px, views ${narrow.icons ? 'icons only' : 'named'}; content ${narrow.sw}px (${narrow.kids})`)
        // 설정 › 앱: the 글자 크기 row follows and sets the same step
        await page.setViewportSize({ width: 1440, height: 900 })
        await page.locator('.w-head .w-icon[aria-label="설정"]').click()
        await page.locator('.set-nav button', { hasText: /^앱$/ }).click()
        const row = page.locator('.set-row', { hasText: '글자 크기' })
        if ((await row.locator('button.on').textContent()) !== '120%') bad(`설정 shows ${await row.locator('button.on').textContent()}, not 120%`)
        await row.locator('button', { hasText: /^90%$/ }).click()
        if (await cls() !== 'ts-90') bad(`설정's 90%: ${await cls()}`)
      } catch (err) {
        bad(String(err.message).split('\n')[0])
      } finally {
        if (app) await app.ctx.close()
      }
    }
    return problems
  },

  /**
   * Hit areas (calm-style plan, Task 14; the final review's C1): the size of every control the
   * restyle touched, at 1440×900 보통, against the sizes on main before the plan (0dbb6c9, measured
   * with this same flow: HIT_BEFORE_RUN=1 on that build) — none smaller. Each control has its own
   * floor (the 도감 segments and the tier chips apart); the header's 로그인 and update button are
   * also measured in English and Japanese. A control new in the restyle is at least 22px each way.
   * With --out: hit-areas.json.
   */
  'hit-areas': async ({ browser, opts }) => {
    const problems = []
    // The smallest width and height each control had on main (px; measured on the 0dbb6c9 build
    // with this flow, HIT_BEFORE_RUN=1). The launcher's main button is measured with the panel at
    // main's 328px, so the two compare
    const BEFORE = {
      'view tab': [59.8, 23], 'window button': [30, 28], 'widget toggle': [30, 28], 'header icon': [24, 22],
      'launcher main (panel 328)': [207, 34], 'launcher side': [40, 34], 'row rename ✎': [21, 19], 'row swap': [19, 19], 'row close ×': [17.2, 16],
      'rail button': [38, 38], 'rail session': [38, 38], 'dex segment': [25.2, 22], 'tier chip': [39, 24],
      '확인 필요 button': [50.6, 16], 'header 로그인': [46.5, 20], 'header 로그인 (en)': [52.1, 20], 'header 로그인 (ja)': [59.3, 20],
      'update button': [58, 22], 'update button (en)': [58.1, 22], 'update button (ja)': [81.9, 22],
    }
    // Named exceptions: a control that cannot meet its pre-plan floor, with why and the floor it is held to
    const EXCEPTIONS = {
      'launcher main': {
        floor: [199, 34],
        why: 'at the plan\'s 300px default panel (ruling 1; pre-plan 328px) the row is 28px narrower; at 328 it is held to 207 above',
      },
      'launcher side': {
        floor: [30, 34],
        why: 'the owner (2026-11-16): narrower, so the folder and resume icons read as one pair beside 새로운 세션 시작하기',
      },
      // the owner (2026-11-16): the update button is an icon, the header's own 26 × 26, so the profile never shrinks
      'update button': { floor: [26, 26], why: 'an icon button now (1.6.1), the size of the header\'s other icons' },
      'update button (en)': { floor: [26, 26], why: 'an icon button now (1.6.1), the size of the header\'s other icons' },
      'update button (ja)': { floor: [26, 26], why: 'an icon button now (1.6.1), the size of the header\'s other icons' },
    }
    const NEW = ['list mode', 'list button', 'session header ×', 'text size', '간략 row ×',
      // the chat view (chat view phase 2)
      'chat flip', 'chat tool row', 'chat group head', 'chat 복사', 'chat diff file', 'chat 새 메시지 pill', 'chat banner button', 'chat 터미널로 보기',
      'chat path chip', 'chat 답 복사',
      // the composer (chat view phase 3)
      'composer +', 'composer @', 'composer 보내기', 'composer chip picture', 'composer chip ×', 'composer 멈추기', 'composer note button',
      'composer mention row', 'composer thumbnail', 'composer lightbox ×']
    const measure = (page, sel, { hitAfter = false } = {}) => page.evaluate(([s, after]) => {
      const els = [...document.querySelectorAll(s)].filter(el => { const r = el.getBoundingClientRect(); return r.width && r.height && getComputedStyle(el).visibility !== 'hidden' })
      if (!els.length) return null
      let w = Infinity, h = Infinity
      for (const el of els) {
        const r = el.getBoundingClientRect()
        // a ::after that reaches further (the list mode's 22px hit strip) counts
        const a = after ? parseFloat(getComputedStyle(el, '::after').height) || 0 : 0
        w = Math.min(w, r.width); h = Math.min(h, Math.max(r.height, a))
      }
      return [Math.round(w * 10) / 10, Math.round(h * 10) / 10, els.length]
    }, [sel, hitAfter])
    const got = {}
    const take = async (page, name, sel, o) => { const m = await measure(page, sel, o); if (m) got[name] = m; else got[name] ??= null }
    // An update on offer, so the header shows its button (as a user sees it)
    const update = { status: 'available', latest: '9.9.9' }
    let app
    try {
      app = await openApp(browser, { update })
      const { page } = app
      // (the account's state comes with the server's snapshot, a moment after the rows)
      await page.waitForSelector('.w-side .w-head .w-signin', { timeout: 10_000 })
      await take(page, 'view tab', '.w-view-tabs button')
      await take(page, 'window button', '.w-win-controls .w-icon')
      await take(page, 'widget toggle', '.w-widget-toggle')
      await take(page, 'header icon', '.w-side .w-head .w-icon')
      await take(page, 'header 로그인', '.w-side .w-head .w-signin')
      await take(page, 'update button', '.w-side .w-head .w-update')
      await take(page, 'launcher main', '.w-side .w-launch-main')
      await take(page, 'launcher side', '.w-side .w-launch-alt')
      await take(page, 'list mode', '.w-list-mode button', { hitAfter: true })
      await take(page, 'list button', '.w-list-btn')
      await take(page, 'session header ×', '.w-sess-head-close')
      await take(page, 'text size', '.w-term-tabs .w-textsize > button')
      // 상세's 확인 필요: the needs-you row's status is a button that opens its terminal
      await take(page, '확인 필요 button', '.w-party .w-row .w-pill.as-button')
      const row = page.locator('.w-party .w-row').nth(1)
      await row.hover()
      await sleep(150)
      await take(page, 'row rename ✎', '.w-row:hover .w-row-edit')
      await take(page, 'row swap', '.w-row:hover .w-row-swap')
      await take(page, 'row close ×', '.w-row:hover .w-row-tools .w-row-close')
      await page.locator('.w-view-tabs button').nth(1).click()
      await page.waitForSelector('.dex-seg button', { timeout: 10_000 })
      // the segments and the tier chips apart (one minimum over both hid the chips' loss)
      await take(page, 'dex segment', '.dex-seg button')
      await take(page, 'tier chip', '.dex-chips button')
      await app.ctx.close()
      // English and Japanese: 로그인 as most see it (no update on offer: on main a Japanese header
      // with both wrapped 로그인 onto two lines), then the update button
      for (const lang of ['en', 'ja']) {
        app = await openApp(browser, { lang })
        await app.page.waitForSelector('.w-side .w-head .w-signin', { timeout: 10_000 })
        await take(app.page, `header 로그인 (${lang})`, '.w-side .w-head .w-signin')
        await app.ctx.close()
        app = await openApp(browser, { update, lang })
        await app.page.waitForSelector('.w-side .w-head .w-update', { timeout: 10_000 })
        await take(app.page, `update button (${lang})`, '.w-side .w-head .w-update')
        await app.ctx.close()
      }
      app = await openApp(browser, { local: { 'spawn-side-hidden': '1' } })
      await take(app.page, 'rail button', '.w-rail > .w-rail-btn:not(.w-rail-brand):not(.w-rail-update):not(.w-rail-signin)')
      await take(app.page, 'rail session', '.w-rail-session')
      await app.ctx.close()
      app = await openApp(browser, { local: { 'spawn-list-mode': 'compact' } })
      await app.page.locator('.w-party .w-row').nth(1).hover()
      await sleep(150)
      await take(app.page, '간략 row ×', '.w-rows.compact .w-row:hover .w-row-close')
      await app.ctx.close()
      app = await openApp(browser, { local: { 'spawn-side-w': '328' } })
      await take(app.page, 'launcher main (panel 328)', '.w-side .w-launch-main')
      if (!process.env.HIT_BEFORE_RUN) {
        // The chat view's controls (new in chat view phase 2: 22px each way)
        await app.ctx.close()
        app = await openApp(browser, { chat: 'chat' })
        await app.page.waitForSelector('.chat .chat-row', { timeout: 10_000 })
        await sleep(300)
        await take(app.page, 'chat flip', '.w-lens button')
        await take(app.page, 'chat tool row', '.chat-tool-toggle')
        await take(app.page, 'chat group head', '.chat-group .chat-tool-toggle')
        await take(app.page, 'chat 복사', '.chat-code .chat-copy')
        // (phase 5: a finished turn's 답 복사 is in its foot)
        await take(app.page, 'chat 답 복사', '.chat-foot .chat-copy, .chat-text-acts .chat-copy')
        await take(app.page, 'chat path chip', '.fchip')
        // the diff and the failed command are in the first turn: up there
        await app.page.evaluate(() => { document.querySelector('.chat-scroll').scrollTop = 0 })
        await sleep(400)
        await take(app.page, 'chat diff file', '.chat-diff-file')
        const t1 = fixture.terminals[0].id
        await app.page.evaluate(id => window.__CHAT_PUSH__(id, [{ op: 'upsert', items: [1, 2, 3].map(k => ({ id: `hit-${k}`, order: 1e12 + k, at: null, kind: 'text', text: 'x' })) }]), t1)
        await sleep(400)
        await take(app.page, 'chat 새 메시지 pill', '.chat-jump')
        await app.ctx.close()
        app = await openApp(browser, { chat: 'chat-banner' })
        await app.page.waitForSelector('.chat-banner', { timeout: 10_000 })
        await take(app.page, 'chat banner button', '.chat-banner .chat-btn')
        await app.ctx.close()
        app = await openApp(browser, { chat: 'chat-waiting' })
        await app.page.waitForSelector('.chat .chat-row', { timeout: 10_000 })
        await take(app.page, 'chat 터미널로 보기', '.chat-tool-head .chat-btn, .chat-status .chat-btn')
        // the composer's controls (chat view phase 3)
        await app.ctx.close()
        app = await openApp(browser, { chat: 'chat' })
        const page = app.page
        const id = await firstTerm(page)
        await page.waitForSelector(COMPOSER, { timeout: 15_000 })
        await take(page, 'composer +', '.chat-cbar .chat-ib:not(.mono)')
        await take(page, 'composer @', '.chat-cbar .chat-ib:nth-of-type(2)')
        await take(page, 'composer 보내기', '.chat-composer .chat-send')
        await composerField(page).click()
        await pasteImage(page, 1)
        await page.waitForSelector('.chat-ichip', { timeout: 3000 })
        await take(page, 'composer chip picture', '.chat-ichip-pic')
        await take(page, 'composer chip ×', '.chat-ichip-x')
        await page.locator('.chat-ichip-pic').click()
        await page.waitForSelector('.chat-lightbox', { timeout: 3000 })
        await take(page, 'composer lightbox ×', '.chat-lightbox-x')
        await page.keyboard.press('Escape')
        await composerField(page).click()
        await page.keyboard.type(' @s')
        await page.waitForSelector('.chat-mi', { timeout: 3000 }).catch(() => {})
        await take(page, 'composer mention row', '.chat-mi')
        await page.keyboard.press('Escape')
        await pushStatus(page, id, { state: 'working', since: fixture.NOW })
        await take(page, 'composer 멈추기', '.chat-status .chat-stop')
        await screenTo(page, id, 'dialog-bash')
        await page.keyboard.press('Enter')
        await page.waitForSelector('.chat-cnote .chat-btn', { timeout: 3000 }).catch(() => {})
        await take(page, 'composer note button', '.chat-cnote .chat-btn')
        // a message sent from here, with its picture
        await pushStatus(page, id, {})
        await chatScript(page, { send: { ok: true, expect: { head: 'Without tools, name thre', images: 1, long: false }, command: false }, submit: 'hang' })
        await screenTo(page, id, 'idle-empty')
        await composerField(page).fill('')
        await page.keyboard.type('look')
        await pasteImage(page, 1)
        await page.waitForSelector('.chat-ichip', { timeout: 3000 })
        await page.keyboard.press('Enter')
        await page.waitForSelector('.chat-thumb', { timeout: 3000 }).catch(() => {})
        await take(page, 'composer thumbnail', '.chat-thumb')
      }
    } catch (err) {
      problems.push(String(err.message).split('\n')[0])
    } finally {
      if (app) await app.ctx.close().catch(() => {})
    }
    for (const [name, m] of Object.entries(got)) {
      const ex = EXCEPTIONS[name]
      const want = ex?.floor ?? BEFORE[name] ?? (NEW.includes(name) ? [22, 22] : null)
      console.log(`      ${name.padEnd(26)} ${m ? `${m[0]} × ${m[1]}  (${m[2]})` : 'none'}${want ? `   floor ${want[0]} × ${want[1]}` : ''}${ex ? `   (exception: ${ex.why})` : ''}`)
      if (process.env.HIT_BEFORE_RUN) continue // measuring the pre-plan build: no judging
      if (!m) { problems.push(`${name}: not found`); continue }
      // (the numbers are rounded to 0.1px)
      if (want && (m[0] < want[0] - 0.05 || m[1] < want[1] - 0.05)) problems.push(`${name}: ${m[0]} × ${m[1]}, smaller than ${want[0]} × ${want[1]}`)
    }
    if (opts?.out) writeFileSync(join(opts.out, 'hit-areas.json'), JSON.stringify(got, null, 2))
    return problems
  },

  /**
   * The keyboard and screen readers (the final review's I2 and M7). In 상세 and in 간략: Tab
   * reaches the rows (after the list header's buttons), each row is a button whose name says the
   * session's name and status (간략 too, where only the dot shows), the one in view is
   * aria-current; a focused row shows a quiet hairline ring (no yellow) and a click shows none;
   * Enter and Space open a row (the session header follows); F2 opens one rename field, Enter
   * renames once and the focus comes back to the row; Tab from a row reaches its × (in 간략 the ×
   * shows on keyboard focus) and, in 상세, its ✎. The text-size menu: Enter opens it on the
   * checked step, ↓ ↑ Home End move (wrapping), Esc closes it with the focus back on the button,
   * Enter on a step picks it.
   */
  keyboard: async ({ browser }) => {
    const problems = []
    const run = async (label, setup, steps) => {
      let app
      try {
        app = await openApp(browser, setup)
        await steps(app, m => problems.push(`${label}: ${m}`))
      } catch (err) {
        problems.push(`${label}: ${String(err.message).split('\n')[0]}`)
      } finally {
        if (app) await app.ctx.close()
      }
    }
    // What has the focus: its class, and the index of its row (-1: not in a row)
    const focus = page => page.evaluate(() => {
      const el = document.activeElement
      const row = el?.closest('.w-party .w-row')
      return { cls: el?.className ?? '', tag: el?.tagName ?? '', row: row ? [...document.querySelectorAll('.w-party .w-row')].indexOf(row) : -1, isRow: !!el?.matches('.w-row'), visible: !!el && el.getBoundingClientRect().width > 0 && getComputedStyle(el).opacity !== '0' }
    })
    for (const [label, local] of [['상세', {}], ['간략', { 'spawn-list-mode': 'compact' }]]) {
      await run(label, { local }, async ({ page, shot }, bad) => {
        const titles = shot.terminals.map(t => t.title ?? '새 세션')
        const rows = page.locator('.w-party .w-row')
        // Every row: a focusable button; its name has the session's name and its status word
        const a11y = await page.evaluate(() => [...document.querySelectorAll('.w-party .w-row')].map(r => ({
          role: r.getAttribute('role'), tab: r.getAttribute('tabindex'), current: r.getAttribute('aria-current'),
          label: r.getAttribute('aria-label') ?? '',
          // the status word for its mood (Widget.tsx MOOD_LABEL); a shell's 상세 row draws none, its name still says it
          status: { working: '일하는 중', idle: '쉬는 중', 'needs-you': '확인 필요', error: '오류', ended: '종료' }[[...r.classList].find(c => c.startsWith('mood-'))?.slice(5)] ?? '',
        })))
        a11y.forEach((r, i) => {
          if (r.role !== 'button' || r.tab !== '0') bad(`row ${i + 1}: role ${r.role}, tabindex ${r.tab} (want button, 0)`)
          if (!r.label.includes(titles[i])) bad(`row ${i + 1}: its name "${r.label}" lacks the session's name "${titles[i]}"`)
          if (!r.status || !r.label.includes(r.status)) bad(`row ${i + 1}: its name "${r.label}" lacks the status "${r.status}"`)
          if ((r.current === 'true') !== (i === 0)) bad(`row ${i + 1}: aria-current ${r.current} (the session in view is row 1)`)
        })
        // A click focuses no ring
        await rows.nth(2).click({ position: { x: 60, y: 8 } })
        await sleep(100)
        const clicked = await page.evaluate(() => { const r = document.querySelectorAll('.w-party .w-row')[2]; return { ring: r.matches(':focus-visible'), outline: getComputedStyle(r).outlineStyle } })
        if (clicked.ring || clicked.outline !== 'none') bad(`a click on a row shows a focus ring (${clicked.outline})`)
        // From the list header's + button, Tab reaches row 1 (after the shown terminal has taken its focus:
        // TerminalView focuses on the next frame after a switch, which could land after the + button's)
        await rows.nth(0).click({ position: { x: 60, y: 8 } })
        await sleep(300)
        await page.locator('.w-list-head .w-list-btn:not(.w-list-shell)').focus()
        await page.keyboard.press('Tab')
        let f = await focus(page)
        if (!f.isRow || f.row !== 0) bad(`Tab from the list header's + lands on ${f.tag}.${f.cls} (row ${f.row + 1}), not row 1`)
        const ring = await page.evaluate(() => { const r = document.activeElement; const cs = getComputedStyle(r); return { fv: r.matches(':focus-visible'), style: cs.outlineStyle, width: cs.outlineWidth, color: cs.outlineColor } })
        if (!ring.fv || ring.style === 'none' || ring.width === '0px') bad(`a row focused from the keyboard shows no ring (${JSON.stringify(ring)})`)
        if (/255,\s*2[01]\d,\s*[0-9]{1,2}\b|ffd84a/i.test(ring.color)) bad(`the row's ring is yellow (${ring.color})`)
        // Tab within row 1: its buttons (상세: 확인 필요, ✎, swap, ×; 간략: the × only), each visible
        const inside = []
        for (let k = 0; k < 6; k++) {
          await page.keyboard.press('Tab')
          f = await focus(page)
          if (f.row !== 0 || f.isRow) break
          inside.push(f.cls.split(' ')[0])
          if (!f.visible) bad(`Tab reaches ${f.cls} in row 1, but it is not shown`)
        }
        const want = label === '간략' ? ['w-row-close'] : ['w-pill', 'w-row-edit', 'w-row-swap', 'w-row-close']
        if (inside.join(',') !== want.join(',')) bad(`Tab inside row 1 reaches [${inside.join(', ')}], want [${want.join(', ')}]`)
        if (!f.isRow || f.row !== 1) bad(`Tab after row 1's buttons lands on ${f.tag}.${f.cls} (row ${f.row + 1}), not row 2`)
        // Enter on row 2 opens it; Space on row 3
        const head = () => page.locator('.w-sess-head .w-sess-head-name').textContent()
        await page.keyboard.press('Enter')
        await sleep(100)
        if (await head() !== titles[1]) bad(`Enter on row 2: the header reads "${await head()}", not "${titles[1]}"`)
        if (await rows.nth(1).getAttribute('aria-current') !== 'true' || await rows.nth(0).getAttribute('aria-current')) bad('Enter on row 2: aria-current did not move to it')
        await rows.nth(2).focus()
        await page.keyboard.press('Space')
        await sleep(100)
        if (await head() !== titles[2]) bad(`Space on row 3: the header reads "${await head()}", not "${titles[2]}"`)
        // F2 on row 4: one field, in that row; Enter renames once and the focus is back on the row
        await rows.nth(3).focus()
        await page.keyboard.press('F2')
        await sleep(80)
        const fields = await page.locator('input.w-row-rename').count()
        if (fields !== 1 || !(await rows.nth(3).locator('input.w-row-rename').count())) bad(`F2 on row 4 opened ${fields} field(s)${fields === 1 ? ' (in another row)' : ''}`)
        else {
          await renameOnce(page, rows.nth(3).locator('input.w-row-rename'), shot.terminals[3].id, '키보드 이름', bad)
          await sleep(100)
          f = await focus(page)
          if (!f.isRow || f.row !== 3) bad(`after Enter in the rename field the focus is on ${f.tag}.${f.cls} (row ${f.row + 1}), not row 4`)
          // Esc cancels: no rename, the focus back on the row
          const before = (await calls(page)).filter(c => c.fn === 'rename').length
          await page.keyboard.press('F2')
          await page.locator('input.w-row-rename').fill('버릴 이름')
          await page.keyboard.press('Escape')
          await sleep(100)
          f = await focus(page)
          if ((await calls(page)).filter(c => c.fn === 'rename').length !== before) bad('Esc in the rename field renamed the session')
          if (!f.isRow || f.row !== 3) bad(`after Esc in the rename field the focus is on ${f.tag}.${f.cls}, not row 4`)
        }
        // 간략: the × shows only for the keyboard (a click leaves the dot)
        if (label === '간략') {
          await rows.nth(4).click({ position: { x: 60, y: 8 } })
          await page.mouse.move(700, 600)
          await sleep(100)
          const shown = await rows.nth(4).locator('.w-row-close').isVisible()
          if (shown) bad('a click on a 간략 row left its × showing after the mouse went away')
        }
      })
    }
    // The chat view (chat view phase 2): Tab reaches the flip, Enter flips; in the conversation Tab
    // reaches the tool rows (buttons with aria-expanded), the links and the 복사 buttons, each with a
    // visible ring that is not yellow; Enter opens a row; the banner is a status, the pill a polite live region
    await run('채팅', { chat: 'chat', chatMode: false }, async ({ page }, bad) => {
      await page.locator('.w-win-controls .w-win-close').focus()
      await page.keyboard.press('Tab')
      const onFlip = await page.evaluate(() => ({ flip: !!document.activeElement?.closest('.w-lens'), text: document.activeElement?.textContent ?? '' }))
      if (!onFlip.flip || onFlip.text !== '채팅') bad(`Tab after the window buttons lands on "${onFlip.text}", not the flip's 채팅`)
      await page.keyboard.press('Enter')
      await page.waitForSelector('.chat .chat-row', { timeout: 10_000 }).catch(() => bad('Enter on 채팅 did not open the chat'))
      if (await page.locator('.w-lens button[aria-pressed="true"]').innerText() !== '채팅') bad('after Enter the flip does not say 채팅')
      // (phase 3: the composer takes the focus on the user's own flip)
      if (!(await page.evaluate(() => document.activeElement?.matches('textarea.chat-input:not(.chat-input-twin)')))) bad(`the composer did not take the focus (${await page.evaluate(() => document.activeElement?.className)})`)
      // The list is announced as a list of rows
      const roles = await page.evaluate(() => ({ list: document.querySelector('.chat-rows')?.getAttribute('role'), item: document.querySelector('.chat-row')?.getAttribute('role'), region: document.querySelector('.chat-scroll')?.getAttribute('aria-label') }))
      if (roles.list !== 'list' || roles.item !== 'listitem' || !roles.region) bad(`the conversation's roles: ${JSON.stringify(roles)}`)
      // From the top of the conversation, Tab through it
      await page.evaluate(() => { const el = document.querySelector('.chat-scroll'); el.scrollTop = 0; el.focus() })
      await sleep(400)
      const seen = new Set()
      let toggled = false
      for (let k = 0; k < 40; k++) {
        await page.keyboard.press('Tab')
        const f = await page.evaluate(() => {
          const el = document.activeElement
          // (past the rows: the composer, walked in its own run below)
          if (!el?.closest('.chat') || el.closest('.chat-composer')) return null
          const cs = getComputedStyle(el)
          return { kind: el.matches('.chat-tool-toggle') ? 'tool' : el.matches('a') ? 'link' : el.matches('.chat-copy') ? 'copy' : el.matches('.fchip') ? 'path' : el.matches('.chat-diff-file') ? 'diff' : el.tagName, expanded: el.getAttribute('aria-expanded'), ring: el.matches(':focus-visible') && cs.outlineStyle !== 'none' && cs.outlineWidth !== '0px', color: cs.outlineColor }
        })
        if (!f) break
        seen.add(f.kind)
        if (!f.ring) bad(`a focused ${f.kind} in the chat shows no ring`)
        if (/255,\s*2[01]\d,\s*[0-9]{1,2}\b|242,\s*201,\s*76/i.test(f.color)) bad(`the ${f.kind}'s ring is yellow (${f.color})`)
        if (f.kind === 'tool' && f.expanded === null) bad('a tool row button has no aria-expanded')
        if (f.kind === 'tool' && f.expanded === 'false' && !toggled) {
          await page.keyboard.press('Enter')
          await sleep(150)
          const now = await page.evaluate(() => document.activeElement?.getAttribute('aria-expanded'))
          if (now !== 'true') bad(`Enter on a closed tool row left aria-expanded ${now}`)
          toggled = true
        }
      }
      for (const kind of ['tool', 'link', 'copy']) if (!seen.has(kind)) bad(`Tab through the conversation never reached a ${kind} (reached: ${[...seen].join(', ')})`)
    })
    await run('채팅 배너', { chat: 'chat-banner' }, async ({ page }, bad) => {
      await page.waitForSelector('.chat-banner', { timeout: 10_000 })
      if (await page.locator('.chat-banner').getAttribute('role') !== 'status') bad('the banner is not role="status"')
      if (await page.locator('.chat-jump-live').getAttribute('aria-live') !== 'polite') bad('the 새 메시지 place is not aria-live="polite"')
      // the banner's buttons from the keyboard: 터미널로 보기 then 다시 읽기
      await page.locator('.chat-banner .chat-btn').first().focus()
      if (await page.evaluate(() => document.activeElement?.textContent) !== '터미널로 보기') bad('the banner\'s first button is not 터미널로 보기')
      await page.keyboard.press('Tab')
      if (await page.evaluate(() => document.activeElement?.textContent) !== '다시 읽기') bad('Tab from 터미널로 보기 does not reach 다시 읽기')
    })
    // The text-size menu from the keyboard
    await run('글자 크기 메뉴', {}, async ({ page }, bad) => {
      const cur = page.locator('.w-term-tabs .w-textsize-cur')
      const item = () => page.evaluate(() => document.activeElement?.closest('.w-textsize-item')?.querySelector('.w-textsize-item-name')?.textContent ?? `(${document.activeElement?.className})`)
      await cur.focus()
      await page.keyboard.press('Enter')
      await sleep(80)
      if (!(await page.locator('.w-textsize-menu').count())) { bad('Enter on the text size opened no menu'); return }
      if (await item() !== '100%') bad(`the menu opened with the focus on ${await item()}, not the checked 100%`)
      for (const [key, want] of [['ArrowDown', '110%'], ['ArrowDown', '120%'], ['ArrowDown', '130%'], ['ArrowDown', '80%'], ['ArrowUp', '130%'], ['Home', '80%'], ['End', '130%']]) {
        await page.keyboard.press(key)
        if (await item() !== want) bad(`${key}: the focus is on ${await item()}, want ${want}`)
      }
      await page.keyboard.press('Escape')
      await sleep(80)
      if (await page.locator('.w-textsize-menu').count()) bad('Esc did not close the menu')
      if (!(await page.evaluate(() => document.activeElement?.classList.contains('w-textsize-cur')))) bad('after Esc the focus is not back on the button')
      // Open again (↓ on the button), move to 크게, pick it with Enter
      await page.keyboard.press('ArrowDown')
      await sleep(80)
      if (!(await page.locator('.w-textsize-menu').count())) { bad('↓ on 가 opened no menu'); return }
      await page.keyboard.press('ArrowDown')
      await page.keyboard.press('Enter')
      await sleep(80)
      const step = await page.evaluate(() => localStorage.getItem('spawn-text-size'))
      if (step !== 'large') bad(`Enter on 크게 left the step at ${step}`)
      if (await page.locator('.w-textsize-menu').count()) bad('the menu stayed open after Enter on a step')
      if (!(await page.evaluate(() => document.activeElement?.classList.contains('w-textsize-cur')))) bad('after a pick the focus is not back on the button')
    })
    // The composer (chat view phase 3): the DOM order is the visual order (list → queue strip → chips →
    // field → + → @ → 보내기 → control row); Tab and Shift+Tab walk it; every control names itself
    await run('the composer', { chat: 'chat' }, async ({ page }, bad) => {
      const id = await firstTerm(page)
      await page.waitForSelector(COMPOSER, { timeout: 15_000 })
      await pushStatus(page, id, { queued: [{ text: '그 다음에 정리', truncated: false }], queuedCount: 1 })
      await composerField(page).click()
      await page.keyboard.type('draft')
      await pasteImage(page, 1)
      await page.waitForSelector('.chat-ichip', { timeout: 3000 })
      const order = await page.evaluate(() => {
        const sel = ['.chat-scroll', '.chat-queue', '.chat-ichip-pic', '.chat-ichip-x', 'textarea.chat-input:not(.chat-input-twin)', '.chat-cbar .chat-ib', '.chat-cbar .chat-ib:nth-of-type(2)', '.chat-send', '.chat-ctrl']
        const els = sel.map(q => document.querySelector(q))
        const missing = sel.filter((q, i) => !els[i])
        const wrong = []
        for (let i = 1; i < els.length; i++) if (els[i - 1] && els[i] && !(els[i - 1].compareDocumentPosition(els[i]) & Node.DOCUMENT_POSITION_FOLLOWING)) wrong.push(`${sel[i - 1]} → ${sel[i]}`)
        return { missing, wrong }
      })
      if (order.missing.length) bad(`not in the page: ${order.missing.join(', ')}`)
      if (order.wrong.length) bad(`the DOM order is not the visual order: ${order.wrong.join('; ')}`)
      const at = () => page.evaluate(() => { const el = document.activeElement; return el ? (el.getAttribute('aria-label') || el.className) : '' })
      await composerField(page).focus()
      const walk = []
      for (let k = 0; k < 3; k++) { await page.keyboard.press('Tab'); walk.push(await at()) }
      if (walk.join(' | ') !== '이미지 붙이기 | 파일 멘션 | 보내기') bad(`Tab from the field: ${walk.join(' | ')}`)
      for (let k = 0; k < 3; k++) await page.keyboard.press('Shift+Tab')
      if (!(await page.evaluate(() => document.activeElement?.matches('textarea.chat-input:not(.chat-input-twin)')))) bad(`Shift+Tab back did not reach the field (${await at()})`)
      await page.keyboard.press('Shift+Tab')
      if (!(await at()).startsWith('빼기')) bad(`Shift+Tab from the field: ${await at()} (the chip's ×)`)
      // every control of the composer has a name
      const unnamed = await page.evaluate(() => [...document.querySelectorAll('.chat-composer button, .chat-composer textarea:not(.chat-input-twin)')].filter(el => !(el.getAttribute('aria-label') || el.textContent.trim())).map(el => el.className))
      if (unnamed.length) bad(`controls with no name: ${unnamed.join(', ')}`)
      // a visible focus: the field's box border, a button's ring
      await composerField(page).focus()
      const ring = await page.evaluate(() => getComputedStyle(document.querySelector('.chat-cbox')).borderColor)
      await page.keyboard.press('Tab')
      const btn = await page.evaluate(() => getComputedStyle(document.activeElement).outlineStyle)
      if (btn === 'none') bad('a focused composer button shows no ring')
      if (!/rgba?\(255, 255, 255, 0\.1[56]/.test(ring) && !/0\.16\)/.test(ring)) bad(`the focused field's box keeps its quiet border (${ring})`)
    })
    return problems
  },

  /**
   * Hovered is not chosen (the final review's M4): in 도감 (filters, tier chips), 박스 (sort),
   * 랭킹 (boards) and 설정 (a choice), a hovered option's words differ from the chosen one's, and
   * hovering the chosen one leaves it as it was.
   */
  'seg-hover': async ({ browser }) => {
    const problems = []
    let app
    try {
      app = await openApp(browser, {})
      const { page } = app
      const look = el => el.evaluate(b => { const cs = getComputedStyle(b); return `${cs.color} on ${cs.backgroundColor}` })
      const check = async (where, group) => {
        const on = group.locator('button.on').first()
        const off = group.locator('button:not(.on)').first()
        if (!(await on.count()) || !(await off.count())) { problems.push(`${where}: no chosen and plain option to compare`); return }
        await page.mouse.move(2, 2)
        await sleep(200)
        const chosen = await look(on)
        await off.hover()
        await sleep(200)
        const hovered = await look(off)
        const hc = hovered.split(' on ')[0], cc = chosen.split(' on ')[0]
        if (hc === cc) problems.push(`${where}: a hovered option (${hovered}) has the chosen one's words (${chosen})`)
        await on.hover()
        await sleep(200)
        if (await look(on) !== chosen) problems.push(`${where}: hovering the chosen option changes it (${chosen} → ${await look(on)})`)
        console.log(`      ${where}: chosen ${chosen} · hovered ${hovered}`)
      }
      await page.locator('.w-view-tabs button').nth(1).click()
      await page.waitForSelector('.dex-seg button', { timeout: 10_000 })
      await check('도감 filter', page.locator('.dex-seg').first())
      // a tier chip on (the chips start all off): pick the first, compare with the second
      await page.locator('.dex-chips button').first().click()
      await check('도감 tier chip', page.locator('.dex-chips'))
      await page.locator('.w-view-tabs button').nth(2).click()
      await page.waitForSelector('.box-toolbar .dex-seg button', { timeout: 10_000 })
      await check('박스 sort', page.locator('.box-toolbar .dex-seg').first())
      await page.locator('.w-view-tabs button').nth(4).click()
      await page.waitForSelector('.rank-boards button', { timeout: 10_000 })
      await check('랭킹 board', page.locator('.rank-boards'))
      await page.locator('.w-head .w-icon[aria-label="설정"]').click()
      await page.locator('.set-nav button', { hasText: /^앱$/ }).click()
      await check('설정 choice', page.locator('.set-row', { hasText: '글자 크기' }).locator('.dex-seg'))
    } catch (err) {
      problems.push(String(err.message).split('\n')[0])
    } finally {
      if (app) await app.ctx.close()
    }
    return problems
  },

  /**
   * A narrow window (calm-style plan, Task 14): at 560 (the window's minimum) and 640 wide, on
   * Windows and on a Mac, the left panel open and folded, the top bar fits its card — nothing
   * past the bar's end, the window buttons whole and on top (Windows), the text size still
   * reachable (folded to one 가 button when it must, its menu inside the window), the traffic
   * lights' 78px left room kept (Mac), and the page's own fit check.
   */
  narrow: async ({ browser, opts }) => {
    const problems = []
    // (and at 560 with the chat view shown: its 채팅 / 터미널 flip in the session bar; chat view phase 2)
    for (const chat of [false, true]) for (const mac of [false, true]) for (const folded of [false, true]) for (const width of chat ? [560] : [560, 640]) {
      const label = `${mac ? 'Mac' : 'Windows'} ${folded ? 'folded' : 'open'} ${width}${chat ? ' chat' : ''}`
      const bad = m => problems.push(`${label}: ${m}`)
      let app
      try {
        app = await openApp(browser, { mac, size: [width, 720], local: { 'spawn-side-hidden': folded ? '1' : '0' }, ...(chat ? { chat: 'chat' } : {}) })
        const { page } = app
        await sleep(400)
        if (chat) {
          // the session bar holds the flip and the × whole; nothing of the chat under the traffic lights
          const sess = await page.evaluate(() => {
            const bar = document.querySelector('.w-sess-bar')
            const br = bar.getBoundingClientRect()
            const lens = document.querySelector('.w-lens')?.getBoundingClientRect()
            const x = document.querySelector('.w-sess-head-close')?.getBoundingClientRect()
            const chatBox = document.querySelector('.chat')?.getBoundingClientRect()
            return { sw: bar.scrollWidth, cw: bar.clientWidth, right: br.right, lens: lens ? { l: lens.left, r: lens.right } : null, x: x ? { r: x.right, w: x.width } : null, chatLeft: chatBox?.left ?? null, chatTop: chatBox?.top ?? null }
          })
          if (!sess.lens) bad('no 채팅 / 터미널 flip in the session bar')
          else if (sess.lens.r > sess.right + 0.5) bad(`the flip ends at ${sess.lens.r}, past the session bar (${sess.right})`)
          if (!sess.x || sess.x.r > sess.right + 0.5) bad('the session ×  is cut')
          if (sess.sw > sess.cw + 1) bad(`the session bar's content is ${sess.sw}px in ${sess.cw}px`)
          if (sess.chatLeft === null) bad('the chat view is not shown')
          if (mac && sess.chatTop !== null && sess.chatTop < 40 && sess.chatLeft < 78) bad('the chat view reaches under the traffic lights')
        }
        const got = await page.evaluate(() => {
          const bar = document.querySelector('.w-term-tabs')
          const card = document.querySelector('.w-term').getBoundingClientRect()
          const br = bar.getBoundingClientRect()
          const past = []
          // inside the bar's right padding too (8px: the close button never touches the window's edge)
          const end = Math.min(card.right, br.right - parseFloat(getComputedStyle(bar).paddingRight), innerWidth)
          for (const el of bar.querySelectorAll('button, .w-textsize, .w-win-controls, .w-view-switch')) {
            const cs = getComputedStyle(el)
            const r = el.getBoundingClientRect()
            if (cs.display === 'none' || !r.width) continue
            if (r.right > end + 0.5) past.push(`${el.className || el.tagName} ends at ${r.right.toFixed(1)} (bar content ends ${end.toFixed(1)}, card ${card.right.toFixed(1)})`)
          }
          const close = document.querySelector('.w-win-close')
          const cr = close && getComputedStyle(close.parentElement).display !== 'none' ? close.getBoundingClientRect() : null
          const onTop = cr ? document.elementFromPoint(cr.left + cr.width / 2, cr.top + cr.height / 2)?.closest('.w-win-close') === close : null
          const ts = document.querySelector('.w-term-tabs .w-textsize')
          const first = folded => {
            const host = folded ? bar : document.querySelector('.w-side .w-head')
            const kid = [...host.children].find(c => getComputedStyle(c).display !== 'none' && c.getBoundingClientRect().width)
            return kid ? kid.getBoundingClientRect().left : null
          }
          return {
            sw: bar.scrollWidth, cw: bar.clientWidth, past,
            close: cr ? { left: cr.left, right: cr.right, w: cr.width, h: cr.height } : null, onTop,
            textsize: ts ? (ts.classList.contains('compact') ? 'compact' : 'full') : 'none',
            toggle: !!document.querySelector('.w-term-tabs .w-widget-toggle'),
            views: document.querySelector('.w-view-icons') ? 'icons' : 'named',
            firstOpen: first(false), firstFolded: first(true),
            sideW: document.querySelector('.w-side').getBoundingClientRect().width,
          }
        }, folded)
        if (got.sw > got.cw + 1) bad(`the bar's content is ${got.sw}px in a ${got.cw}px bar`)
        for (const p of got.past) bad(p)
        if (!mac) {
          if (!got.close) bad('no window close button')
          else {
            if (got.close.w < 30 - 0.5 || got.close.h < 28 - 0.5) bad(`the close button is ${got.close.w}×${got.close.h}, not 30×28`)
            if (!got.onTop) bad('the close button is covered at its centre')
          }
        } else if (got.close) bad('a Mac shows the page\'s own window buttons')
        if (got.textsize === 'none') bad('no text-size control')
        // Mac: nothing under the traffic lights (x 14–68): the panel's header starts 78px in; folded, the bar 78px in
        if (mac && !folded && got.firstOpen !== null && got.firstOpen < 78 - 0.5) bad(`the panel header's first item starts at ${got.firstOpen}, under the traffic lights`)
        if (mac && folded && got.firstFolded !== null && got.firstFolded < 78 - 0.5) bad(`the bar's first item starts at ${got.firstFolded}, under the traffic lights`)
        // The text size still works: the menu opens inside the window and sets a step
        await page.locator('.w-term-tabs .w-textsize-cur').click()
        const mb = await page.locator('.w-textsize-menu').boundingBox()
        if (!mb) bad('the text-size menu did not open')
        else {
          if (mb.x < -0.5 || mb.x + mb.width > width + 0.5) bad(`the text-size menu runs out of the window: ${mb.x.toFixed(1)}–${(mb.x + mb.width).toFixed(1)}`)
          await page.locator('.w-textsize-item', { hasText: '110%' }).first().click()
          const cls = await page.evaluate(() => document.documentElement.className)
          if (!/ts-110/.test(cls)) bad(`picking 110% in the menu left <html class="${cls}">`)
        }
        for (const p of await fitProblems(page)) bad(`fit: ${p}`)
        if (opts?.out) await page.screenshot({ path: join(opts.out, `flow-narrow-${mac ? 'mac' : 'win'}-${folded ? 'folded' : 'open'}-${width}${chat ? '-chat' : ''}.png`), animations: 'disabled', caret: 'hide' })
        console.log(`      ${label}: panel ${Math.round(got.sideW)}px, bar ${got.cw}px (content ${got.sw}), views ${got.views}, text size ${got.textsize}, widget toggle ${got.toggle ? 'shown' : 'hidden'}${got.close ? `, close at ${got.close.left.toFixed(0)}–${got.close.right.toFixed(0)}` : ''}`)
      } catch (err) {
        bad(String(err.message).split('\n')[0])
      } finally {
        if (app) await app.ctx.close()
      }
    }
    // The bar measures again when what is in it changes: stepped down from 아주 크게 to 작게, it gives
    // back what a page opened at 작게 shows (the widths it needed at 아주 크게 are not kept)
    const level = page => page.evaluate(() => (document.querySelector('.w-view-icons') ? 1 : 0)
      + (document.querySelector('.w-term-tabs .w-textsize.compact') ? 1 : 0) + (document.querySelector('.w-term-tabs .w-widget-toggle') ? 0 : 1))
    for (const width of [640, 700, 760, 820, 900]) {
      const bad = m => problems.push(`stepping at ${width}: ${m}`)
      let app
      try {
        app = await openApp(browser, { size: [width, 720], local: { 'spawn-text-size': 'small' } })
        await sleep(300)
        const fresh = await level(app.page)
        await app.ctx.close()
        app = await openApp(browser, { size: [width, 720], local: { 'spawn-text-size': 'xlarge' } })
        await sleep(300)
        const big = await level(app.page)
        for (let k = 0; k < 3; k++) await app.page.keyboard.press('Control+Minus')
        await sleep(400)
        const stepped = await level(app.page)
        if (stepped !== fresh) bad(`at 작게 after stepping down the bar is at level ${stepped}, a page opened at 작게 at ${fresh}`)
        console.log(`      stepping at ${width}: 아주 크게 level ${big} → 작게 ${stepped} (fresh 작게 ${fresh})`)
      } catch (err) {
        bad(String(err.message).split('\n')[0])
      } finally {
        if (app) await app.ctx.close()
      }
    }
    return problems
  },

  /**
   * The 채팅 / 터미널 flip (chat view phase 2, Task 15): the terminal stays mounted and keeps
   * working while the chat is shown. Terminal 1 armed, 200 lines of output, scrolled up: 채팅
   * opens the chat (one chat.open, nothing written, created or closed, the same terminals);
   * output sent meanwhile reaches the terminal; 터미널 shows the same xterm again with its scroll
   * kept as a session switch keeps it (the same rule as session 2 and back), the output in its
   * buffer and the focus in it. The choice is per session and survives a reload (the carry).
   */
  'chat-flip': async ({ browser }) => {
    const problems = []
    const bad = m => problems.push(m)
    let app
    try {
      app = await openApp(browser, { chat: 'chat', chatMode: false, smoke: true })
      const { page, shot } = app
      const t1 = shot.terminals[0].id
      const lens = name => page.locator('.w-lens button', { hasText: name })
      await page.waitForSelector('.w-term-body .xterm', { timeout: 15_000 })
      if (await lens('터미널').getAttribute('aria-pressed') !== 'true') bad('at first 터미널 is not the pressed one')
      await termPush(page, t1, Array.from({ length: 200 }, (_, i) => `fixture output line ${i + 1}`).join('\r\n') + '\r\n')
      await sleep(300)
      await scrollTermUp(page)
      const before = await termScroll(page)
      if (!before || before.atBottom) bad(`could not scroll the terminal up (${JSON.stringify(before)})`)
      const xterms = await page.locator('.xterm').count()
      await page.evaluate(() => { window.__XT = [...document.querySelectorAll('.w-term-body .xterm')].find(e => e.offsetParent) })
      const callsBefore = (await calls(page)).length

      await lens('채팅').click()
      await page.waitForSelector('.chat .chat-row', { timeout: 10_000 })
      const during = (await calls(page)).slice(callsBefore)
      if (!during.some(c => c.fn === 'chat.open' && c.args[0] === t1)) bad(`채팅: no chat.open for ${t1} (${JSON.stringify(during)})`)
      for (const fn of ['chat.close', 'create', 'write', 'send', 'close']) if (during.some(c => c.fn === fn)) bad(`채팅 made a ${fn} call`)
      if (await page.locator('.xterm').count() !== xterms) bad(`the terminals changed: ${xterms} → ${await page.locator('.xterm').count()}`)
      if (!(await page.evaluate(() => window.__XT?.isConnected))) bad('the terminal element was taken out of the page')
      if (await page.evaluate(() => !!window.__XT?.offsetParent)) bad('the terminal still shows under the chat')
      if (await lens('채팅').getAttribute('aria-pressed') !== 'true') bad('채팅 is not pressed in chat')

      await termPush(page, t1, 'pushed-while-in-chat\r\n')
      await sleep(200)

      await lens('터미널').click()
      await sleep(500)
      if (await page.locator('.chat').count()) bad('the chat view stayed after 터미널')
      if (!(await page.evaluate(() => !!window.__XT?.offsetParent && window.__XT.isConnected))) bad('터미널 did not show the same terminal element again')
      const after = await termScroll(page)
      if (!((await termInfo(page, t1))?.text ?? '').includes('pushed-while-in-chat')) bad('the output sent while the chat showed is not in the terminal')
      if (!(await page.evaluate(() => !!document.activeElement?.closest('.term-view')))) bad(`the focus is not back in the terminal (${await page.evaluate(() => document.activeElement?.className)})`)
      const flipped = (await calls(page)).slice(callsBefore)
      for (const fn of ['create', 'write', 'send', 'close']) if (flipped.some(c => c.fn === fn)) bad(`the flip made a ${fn} call`)

      // The same rule as switching to session 2 and back with output arriving meanwhile
      const rows = page.locator('.w-party .w-row')
      await scrollTermUp(page)
      const before2 = await termScroll(page)
      await rows.nth(1).locator('.w-row-name').click()
      await sleep(300)
      await termPush(page, t1, 'pushed-while-away\r\n')
      await sleep(200)
      await rows.nth(0).locator('.w-row-name').click()
      await sleep(500)
      const after2 = await termScroll(page)
      // (a line arriving below moves the slider up a little while the view stays: 1 % of the track is "kept";
      // a slider as tall as its track has not been laid out again yet: unmeasured)
      const kind = (b, a) => (!b || !a || a.height >= a.track - 1 ? 'unmeasured' : Math.abs(a.top - b.top) <= Math.max(4, a.track * 0.01) ? 'kept' : a.atBottom ? 'bottom' : 'moved')
      const flipKind = kind(before, after), switchKind = kind(before2, after2)
      if (flipKind !== 'kept' && flipKind !== 'bottom') bad(`after the flip the terminal's scroll ${flipKind} (${JSON.stringify({ before, after })})`)
      if (switchKind !== 'unmeasured' && switchKind !== flipKind) bad(`the flip leaves the scroll ${flipKind}, a session switch ${switchKind} (${JSON.stringify({ before, after, before2, after2 })})`)
      console.log(`      scroll after the flip: ${flipKind}; after a session switch: ${switchKind}`)

      // Per session: 채팅 on session 1, session 2 stays 터미널, session 1 comes back in 채팅
      await lens('채팅').click()
      await page.waitForSelector('.chat .chat-row', { timeout: 10_000 }).catch(async () => bad(`채팅 a second time did not show the chat (${JSON.stringify((await calls(page)).slice(-4))})`))
      await rows.nth(1).locator('.w-row-name').click()
      await sleep(300)
      if (await page.locator('.chat').count()) bad('session 2 opened in 채팅 (the choice is per session)')
      if (await lens('터미널').getAttribute('aria-pressed') !== 'true') bad('session 2: 터미널 is not pressed')
      await rows.nth(0).locator('.w-row-name').click()
      await page.waitForSelector('.chat .chat-row', { timeout: 10_000 }).catch(() => bad('session 1 did not come back in 채팅'))
      const carry = await page.evaluate(() => JSON.parse(localStorage.getItem('spawn-carry') || '{}'))
      if (carry.chatModes?.[shot.terminals[0].sessionId] !== 'chat') bad(`the carry does not keep 채팅 for session 1: ${JSON.stringify(carry.chatModes)}`)
      if (Object.keys(carry.chatModes ?? {}).some(k => !shot.terminals.some(t => t.sessionId === k))) bad('the carry keeps something other than session ids')
      // A reload: session 1 opens in 채팅 again (from the carry the page kept)
      await page.evaluate(() => sessionStorage.setItem('harness-keep-storage', '1'))
      await page.reload()
      await page.waitForSelector('.chat .chat-row', { timeout: 15_000 }).catch(() => bad('after a reload session 1 is not in 채팅'))
    } catch (err) {
      bad(String(err.message).split('\n')[0])
    } finally {
      if (app) await app.ctx.close()
    }
    return problems
  },

  /**
   * The read-failed banner: shown with the conversation dimmed to 0.45; 다시 읽기 asks main for a
   * fresh read once; 터미널로 보기 shows the terminal and the flip says 터미널.
   */
  'chat-banner': async ({ browser }) => {
    const problems = []
    const bad = m => problems.push(m)
    let app
    try {
      app = await openApp(browser, { chat: 'chat-banner' })
      const { page } = app
      const banner = page.locator('.chat-banner')
      await banner.waitFor({ timeout: 10_000 })
      if (await banner.getAttribute('role') !== 'status') bad('the banner is not role="status"')
      const text = await banner.innerText()
      if (!text.includes('이 세션을 채팅으로 읽지 못하고 있어요') || !text.includes('방금 끝난 답이 세션 기록에서 보이지 않아요')) bad(`the banner says: ${JSON.stringify(text)}`)
      const opacity = await page.evaluate(() => parseFloat(getComputedStyle(document.querySelector('.chat-scroll')).opacity))
      if (Math.abs(opacity - 0.45) > 0.01) bad(`the conversation under the banner has opacity ${opacity}, not 0.45`)
      await banner.locator('button', { hasText: '다시 읽기' }).click()
      await sleep(150)
      const reloads = (await calls(page)).filter(c => c.fn === 'chat.reload')
      if (reloads.length !== 1) bad(`다시 읽기: ${reloads.length} chat.reload calls`)
      await banner.locator('button', { hasText: '터미널로 보기' }).click()
      await sleep(400)
      if (await page.locator('.chat').count()) bad('터미널로 보기 left the chat view up')
      if (!(await page.locator('.w-term-body .xterm').first().isVisible())) bad('터미널로 보기 did not show the terminal')
      if (await page.locator('.w-lens button[aria-pressed="true"]').innerText() !== '터미널') bad('the flip does not say 터미널 after 터미널로 보기')
    } catch (err) {
      bad(String(err.message).split('\n')[0])
    } finally {
      if (app) await app.ctx.close()
    }
    return problems
  },

  /** A session opened before the chat view was on: 채팅 is offered, disabled, says why, and does nothing */
  'chat-unarmed': async ({ browser }) => {
    const problems = []
    const bad = m => problems.push(m)
    let app
    try {
      app = await openApp(browser, { chat: 'chat', armed: { 1: 'unarmed' }, chatMode: false })
      const { page } = app
      await page.locator('.w-party .w-row').nth(1).locator('.w-row-name').click()
      await sleep(300)
      const chat = page.locator('.w-lens button', { hasText: '채팅' })
      if (!(await chat.count())) { bad('no 채팅 button for the unarmed session'); return problems }
      if (await chat.getAttribute('aria-disabled') !== 'true') bad('채팅 is not aria-disabled')
      const title = await chat.getAttribute('title')
      if (title !== '이 세션은 채팅 보기를 켜기 전에 열렸어요. 다시 열면 채팅으로 볼 수 있어요') bad(`채팅's title: ${JSON.stringify(title)}`)
      const n = (await calls(page)).length
      await chat.click({ force: true }) // (aria-disabled: Playwright would wait for it to be enabled)
      await sleep(300)
      if (await page.locator('.chat').count()) bad('a click on the disabled 채팅 opened the chat')
      if ((await calls(page)).slice(n).length) bad(`a click on the disabled 채팅 made calls: ${JSON.stringify((await calls(page)).slice(n))}`)
      if (await page.locator('.w-lens button[aria-pressed="true"]').innerText() !== '터미널') bad('the flip left 터미널')
      // the click says why, under the pair, to the eye and a screen reader (review M14)
      const note = page.locator('.w-lens-note')
      if (await note.getAttribute('role') !== 'status') bad('the reason line is not role="status"')
      if ((await note.innerText()).trim() !== '이 세션은 채팅 보기를 켜기 전에 열렸어요. 다시 열면 채팅으로 볼 수 있어요') bad(`after the click the reason line says ${JSON.stringify(await note.innerText())}`)
    } catch (err) {
      bad(String(err.message).split('\n')[0])
    } finally {
      if (app) await app.ctx.close()
    }
    return problems
  },

  /**
   * A long session (chat view phase 2, Task 16): 2000 items. The DOM holds ≤ 300 rows at the bottom,
   * in the middle and at the top; the top asks chat.older exactly once until the next update; 150
   * older rows pushed above keep the first row in view within 2px; 3 new rows below while scrolled
   * up show "새 메시지 3개", which lands at the bottom and goes; 30 scroll steps of 400px, timed.
   */
  'chat-long': async ({ browser }) => {
    const problems = []
    const bad = m => problems.push(m)
    let app
    try {
      app = await openApp(browser, { chat: 'chat-long' })
      const { page, shot } = app
      const t1 = shot.terminals[0].id
      await page.waitForSelector('.chat .chat-row', { timeout: 15_000 })
      await sleep(500)
      const rowCount = () => page.locator('.chat-row').count()
      const scroller = '.chat-scroll'
      const setTop = async top => { await page.evaluate(([sel, y]) => { const el = document.querySelector(sel); el.scrollTop = y === 'bottom' ? el.scrollHeight : y }, [scroller, top]); await sleep(250) }
      const geo = () => page.evaluate(sel => { const el = document.querySelector(sel); return { top: el.scrollTop, height: el.scrollHeight, view: el.clientHeight } }, scroller)
      const total = shot.chat[t1].ops[0].items.length
      const counts = {}
      counts.bottom = await rowCount()
      const g = await geo()
      await setTop(Math.round(g.height / 2))
      counts.middle = await rowCount()
      // the first row in view, and where it is
      const firstInView = () => page.evaluate(sel => {
        const el = document.querySelector(sel)
        const top = el.getBoundingClientRect().top
        const row = [...el.querySelectorAll('.chat-row')].find(r => r.getBoundingClientRect().bottom > top + 1)
        return row ? { key: row.dataset.key, y: row.getBoundingClientRect().top - top } : null
      }, scroller)
      const olders = async () => (await calls(page)).filter(c => c.fn === 'chat.older').length
      if (await olders()) bad('chat.older was called before reaching the top')
      // to the top: one older request, however much it scrolls there
      await setTop(0)
      await setTop(10)
      await setTop(0)
      await page.mouse.move(800, 400)
      await page.mouse.wheel(0, -300)
      await sleep(300)
      counts.top = await rowCount()
      if (await olders() !== 1) bad(`at the top chat.older was called ${await olders()} times, not once`)
      for (const [where, n] of Object.entries(counts)) if (n > 300) bad(`${n} .chat-row elements in the page ${where} (of ${total} items)`)
      console.log(`      ${total} items: .chat-row ${counts.bottom} at the bottom, ${counts.middle} in the middle, ${counts.top} at the top`)
      // 150 older rows arrive: the row in view stays put
      await setTop(120)
      const before = await firstInView()
      await page.evaluate(([id, items]) => window.__CHAT_PUSH__(id, [{ op: 'upsert', items }, { op: 'status', status: { state: 'idle', since: null, label: null, banner: null, note: null, version: '2.1.323', hasOlder: true, empty: false } }]), [t1, chatFixture.olderItems(150)])
      await sleep(700)
      const after = await page.evaluate(([sel, key]) => {
        const el = document.querySelector(sel)
        const row = el.querySelector(`.chat-row[data-key="${CSS.escape(key)}"]`)
        return row ? row.getBoundingClientRect().top - el.getBoundingClientRect().top : null
      }, [scroller, before?.key ?? ''])
      if (!before || after === null) bad(`the row in view before the older rows came (${JSON.stringify(before)}) is gone`)
      else if (Math.abs(after - before.y) > 2) bad(`older rows above moved the row in view by ${Math.round((after - before.y) * 10) / 10}px`)
      if (!(await page.locator('.chat-row[data-key="older-0"]').count()) && (await geo()).top < 200) bad('the older rows did not arrive at the top')
      // 3 new rows below while scrolled up: 새 메시지 3개, which goes to the bottom
      await setTop(Math.round((await geo()).height / 3))
      const last = shot.chat[t1].ops[0].items.reduce((m, i) => Math.max(m, i.order), 0)
      const fresh = [1, 2, 3].map(k => ({ id: `fresh-${k}`, order: last + k * 10, at: null, kind: 'text', text: `새 답 ${k}` }))
      await page.evaluate(([id, items]) => window.__CHAT_PUSH__(id, [{ op: 'upsert', items }]), [t1, fresh])
      await sleep(400)
      const pill = page.locator('.chat-jump')
      if (!(await pill.count())) bad('no 새 메시지 pill after 3 new rows while scrolled up')
      else {
        const text = (await pill.innerText()).trim()
        if (text !== '새 메시지 3개') bad(`the pill says ${JSON.stringify(text)}`)
        if (await page.locator('.chat-jump-live').getAttribute('aria-live') !== 'polite') bad('the pill is not in a polite live region')
        await pill.click()
        await sleep(1200)
        const end = await geo()
        if (end.height - end.top - end.view > 4) bad(`the pill did not land at the bottom (${end.height - end.top - end.view}px left)`)
        if (await pill.count()) bad('the pill stayed after it was clicked')
        if (!(await page.locator('.chat-row[data-key="fresh-3"]').isVisible())) bad('the newest row is not in view after the pill')
      }
      // frame time: 30 steps of 400px, each until the next frame
      await setTop(0)
      // (each step: scroll, then two frames; the same two frames with no scroll are the baseline, taken off)
      const { step, idle } = await page.evaluate(async sel => {
        const el = document.querySelector(sel)
        const frames = () => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))
        const avg = xs => xs.reduce((a, b) => a + b, 0) / xs.length
        const base = []
        for (let k = 0; k < 10; k++) { const t0 = performance.now(); await frames(); base.push(performance.now() - t0) }
        const times = []
        for (let k = 0; k < 30; k++) {
          const t0 = performance.now()
          el.scrollTop += 400
          await frames()
          times.push(performance.now() - t0)
        }
        return { step: avg(times), idle: avg(base) }
      }, scroller)
      const ms = Math.max(0, step - idle)
      console.log(`      scrolling: ${Math.round(ms * 10) / 10} ms of work per 400px step (${Math.round(step * 10) / 10} ms with its two frames, ${Math.round(idle * 10) / 10} ms without)`)
      if (ms > 50) bad(`scrolling takes ${Math.round(ms)} ms per step`)
      const rowsNow = await rowCount()
      if (rowsNow > 300) bad(`${rowsNow} .chat-row elements after scrolling`)
    } catch (err) {
      bad(String(err.message).split('\n')[0])
    } finally {
      if (app) await app.ctx.close()
    }
    return problems
  },

  /**
   * Scrolling the conversation (review C1, M7, M15, M1): from the bottom, a wheel of −100 and ↑ move
   * the view up and it stays there; rows arriving while scrolled up leave it and show 새 메시지 N개;
   * at the bottom new rows are followed and a new answer is announced; a row opened at the bottom keeps
   * its place (no snap to the end); Tab walks on past the rows mounted at first.
   */
  'chat-scroll': async ({ browser }) => {
    const problems = []
    const bad = m => problems.push(m)
    const geo = page => page.evaluate(() => { const el = document.querySelector('.chat-scroll'); return { top: el.scrollTop, gap: el.scrollHeight - el.scrollTop - el.clientHeight } })
    const push = (page, id, ops) => page.evaluate(([i, o]) => window.__CHAT_PUSH__(i, o), [id, ops])
    let app
    try {
      app = await openApp(browser, { chat: 'chat' })
      const { page, shot } = app
      const t1 = shot.terminals[0].id
      await page.waitForSelector('.chat .chat-row', { timeout: 15_000 })
      await sleep(500)
      let g = await geo(page)
      if (g.gap > 2) bad(`the chat does not open at the bottom (${g.gap}px left)`)
      const box = await page.locator('.chat-scroll').boundingBox()
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
      await page.mouse.wheel(0, -100)
      await sleep(500)
      const afterWheel = await geo(page)
      if (g.top - afterWheel.top < 90) bad(`a wheel of −100 from the bottom moved the view ${Math.round(g.top - afterWheel.top)}px (want ≥ 90)`)
      await page.evaluate(() => document.querySelector('.chat-scroll').focus())
      for (let k = 0; k < 3; k++) await page.keyboard.press('ArrowUp')
      await sleep(500)
      const afterKeys = await geo(page)
      if (afterWheel.top - afterKeys.top < 30) bad(`↑ ×3 moved the view ${Math.round(afterWheel.top - afterKeys.top)}px`)
      // rows arriving while scrolled up: the view stays, the pill says so
      const last = shot.chat[t1].ops[0].items.reduce((m, i) => Math.max(m, i.order), 0)
      const fresh = k => ({ id: `scroll-${k}`, order: last + k * 10, at: null, kind: 'text', text: `새 답 ${k}` })
      await push(page, t1, [{ op: 'upsert', items: [fresh(1), fresh(2)] }])
      await sleep(500)
      const afterPush = await geo(page)
      if (Math.abs(afterPush.top - afterKeys.top) > 2) bad(`rows arriving while scrolled up moved the view ${Math.round(afterPush.top - afterKeys.top)}px`)
      const pill = (await page.locator('.chat-jump').innerText().catch(() => '')).trim()
      if (pill !== '새 메시지 2개') bad(`while scrolled up the pill says ${JSON.stringify(pill)}, not 새 메시지 2개`)
      // back at the bottom: new rows are followed, a new answer announced
      await page.locator('.chat-jump').click()
      await sleep(1200)
      await push(page, t1, [{ op: 'upsert', items: [fresh(3)] }])
      await sleep(500)
      g = await geo(page)
      if (g.gap > 2) bad(`at the bottom a new row was not followed (${Math.round(g.gap)}px left)`)
      const said = await page.evaluate(() => [...document.querySelectorAll('.chat .chat-sr[aria-live], .chat-list > .chat-sr')].map(e => e.textContent).join('|'))
      if (!said.includes('새 답이 왔어요')) bad(`a new answer at the bottom was not announced (${JSON.stringify(said)})`)
      // a row opened at the bottom keeps its place: a 20-line diff arrives, then 더 보기
      const diffLines = Array.from({ length: 20 }, (_, k) => ({ t: '+', old: null, new: k + 1, text: `line ${k + 1}` }))
      await push(page, t1, [{ op: 'upsert', items: [{ id: 'scroll-diff', order: last + 100, at: null, kind: 'tool', tool: 'Write', input: { file: 'src/long.ts' }, state: 'done', diff: { file: 'src/long.ts', kind: 'create', added: 20, removed: 0, hidden: 0, hunks: [{ oldStart: 0, newStart: 1, lines: diffLines }] } }] }])
      await sleep(600)
      const head = () => page.evaluate(() => { const el = document.querySelector('.chat-row[data-key="scroll-diff"] .chat-diff-head'); return el ? el.getBoundingClientRect().top : null })
      const before = await head()
      await page.locator('.chat-row[data-key="scroll-diff"] .chat-diff-more').click()
      await sleep(500)
      const afterOpen = await head()
      if (before === null || afterOpen === null) bad('the diff row is not in view')
      else if (Math.abs(afterOpen - before) > 2) bad(`opening a diff at the bottom moved its head by ${Math.round(afterOpen - before)}px (the view snapped to the end)`)
      await app.ctx.close()
      app = null
      // Tab walks on past the rows mounted at first (a long session, from the top)
      app = await openApp(browser, { chat: 'chat-long' })
      const p2 = app.page
      await p2.waitForSelector('.chat .chat-row', { timeout: 15_000 })
      await sleep(400)
      await p2.evaluate(() => { const el = document.querySelector('.chat-scroll'); el.scrollTop = 0; el.focus() })
      await sleep(500)
      const firstEnd = await p2.evaluate(() => Math.max(...[...document.querySelectorAll('.chat-row')].map(r => Number(r.getAttribute('aria-posinset')))))
      let far = 0
      let lost = 0
      for (let k = 0; k < 120; k++) {
        await p2.keyboard.press('Tab')
        const f = await p2.evaluate(() => { const a = document.activeElement; const row = a?.closest('.chat-row'); return { body: a === document.body || !a, row: row ? Number(row.getAttribute('aria-posinset')) : 0, inChat: !!a?.closest('.chat') } })
        if (f.body) lost++
        if (!f.inChat) break
        far = Math.max(far, f.row)
      }
      if (far <= firstEnd) bad(`Tab stopped at row ${far} of the first mounted ${firstEnd} (it left the conversation early)`)
      if (lost) bad(`Tab dropped the focus to the page ${lost} time(s)`)
      console.log(`      Tab: mounted at first up to row ${firstEnd}, reached row ${far}`)
      await app.ctx.close()
      app = null
      // at the bottom of a long session, the conversation focused (as after a keyboard flip): Tab goes to the first
      // control in view and Shift+Tab leaves it, neither moves the view, and it still follows new rows (re-review I-3)
      app = await openApp(browser, { chat: 'chat-long' })
      const p3 = app.page
      const t3 = app.shot.terminals[0].id
      await p3.waitForSelector('.chat .chat-row', { timeout: 15_000 })
      await sleep(600)
      const lastOrder = app.shot.chat[t3].ops[0].items.reduce((m, i) => Math.max(m, i.order), 0)
      let fresh3 = 0
      const followed = async (what) => {
        fresh3++
        await push(p3, t3, [{ op: 'upsert', items: [{ id: `i3-${fresh3}`, order: lastOrder + fresh3 * 10, at: null, kind: 'text', text: `새 답 ${fresh3}` }] }])
        await sleep(500)
        const g3 = await geo(p3)
        if (g3.gap > 2) bad(`after ${what} at the bottom a new row was not followed (${Math.round(g3.gap)}px left)`)
      }
      for (const key of ['Tab', 'Shift+Tab']) {
        await p3.evaluate(() => { const el = document.querySelector('.chat-scroll'); el.scrollTop = el.scrollHeight; el.focus() })
        await sleep(500)
        const g0 = await geo(p3)
        if (g0.gap > 2) bad(`${key}: the long session is not at its bottom before the key (${Math.round(g0.gap)}px)`)
        await p3.keyboard.press(key)
        await sleep(400)
        const g1 = await geo(p3)
        const f = await p3.evaluate(() => {
          const a = document.activeElement
          const row = a?.closest('.chat-row')
          const s = document.querySelector('.chat-scroll').getBoundingClientRect()
          const r = a?.getBoundingClientRect()
          return { tag: a?.tagName, cls: a?.className, inRow: !!row, inView: !!r && r.bottom > s.top && r.top < s.bottom, sentinel: !!a?.classList?.contains('chat-sentinel'), inChat: !!a?.closest('.chat') }
        })
        console.log(`      ${key} at the bottom: moved ${Math.round(g0.top - g1.top)}px, gap ${Math.round(g1.gap)}, focus ${f.tag}.${String(f.cls).split(' ')[0]}${f.inRow ? ' (a row, in view)' : ''}`)
        if (Math.abs(g1.top - g0.top) > 3) bad(`${key} at the bottom moved the view ${Math.round(g0.top - g1.top)}px`)
        if (g1.gap > 2) bad(`${key} at the bottom left the bottom (${Math.round(g1.gap)}px)`)
        if (f.sentinel) bad(`${key} left the focus on a sentinel`)
        if (key === 'Tab' && !(f.inRow && f.inView)) bad(`Tab from the conversation did not focus a control in view (${f.tag}.${f.cls})`)
        await followed(key)
      }
      // scrolled up, with 새 메시지 below: Shift+Tab from the pill reaches the rows in view, it does not scroll down
      await p3.evaluate(() => { const el = document.querySelector('.chat-scroll'); el.scrollTop = Math.round(el.scrollHeight / 2) })
      await sleep(600)
      fresh3++
      await push(p3, t3, [{ op: 'upsert', items: [{ id: `i3-${fresh3}`, order: lastOrder + fresh3 * 10, at: null, kind: 'text', text: `새 답 ${fresh3}` }] }])
      await sleep(600)
      const newPill = p3.locator('.chat-jump')
      if (!(await newPill.count())) bad('scrolled up with a new row below: no pill to start Shift+Tab from')
      else {
        await newPill.focus()
        const m0 = await geo(p3)
        await p3.keyboard.press('Shift+Tab')
        await sleep(400)
        const m1 = await geo(p3)
        const f = await p3.evaluate(() => {
          const a = document.activeElement
          const s = document.querySelector('.chat-scroll').getBoundingClientRect()
          const r = a?.getBoundingClientRect()
          return { inRow: !!a?.closest('.chat-row'), inView: !!r && r.bottom > s.top && r.top < s.bottom, cls: a?.className }
        })
        console.log(`      Shift+Tab from the pill: moved ${Math.round(m1.top - m0.top)}px, focus ${String(f.cls).split(' ')[0]}${f.inRow && f.inView ? ' (a row, in view)' : ''}`)
        if (Math.abs(m1.top - m0.top) > 3) bad(`Shift+Tab from the pill moved the view ${Math.round(m1.top - m0.top)}px`)
        if (!(f.inRow && f.inView)) bad(`Shift+Tab from the pill did not reach a control in view (${f.cls})`)
      }
    } catch (err) {
      bad(String(err.message).split('\n')[0])
    } finally {
      if (app) await app.ctx.close()
    }
    return problems
  },

  /**
   * A wait on the user while scrolled up (review I1): the pill turns amber and says who waits, and it
   * jumps to the waiting row; a sub-agent's wait (no row of its own) shows on its Agent row.
   */
  'chat-wait': async ({ browser }) => {
    const problems = []
    const bad = m => problems.push(m)
    let app
    try {
      app = await openApp(browser, { chat: 'chat' })
      const { page, shot } = app
      const t0 = shot.terminals[0].id
      await page.waitForSelector('.chat .chat-row', { timeout: 15_000 })
      await sleep(400)
      const lastOrder = shot.chat[t0].ops[0].items.reduce((m, i) => Math.max(m, i.order), 0)
      await page.evaluate(([id, order]) => window.__CHAT_PUSH__(id, [
        { op: 'upsert', items: [{ id: 'wait-1', order: order + 10, at: null, kind: 'tool', tool: 'Bash', input: { command: 'npm run build', description: '빌드해서 확인' }, state: 'running', waiting: 'permission' }] },
        { op: 'status', status: { state: 'waiting', since: Date.now(), label: null, banner: null, note: null, version: '2.1.323', hasOlder: false, empty: false } },
      ]), [t0, lastOrder])
      await sleep(500)
      await page.evaluate(() => { document.querySelector('.chat-scroll').scrollTop = 0 })
      await sleep(500)
      const pill = page.locator('.chat-jump.wait')
      if (!(await pill.count())) bad('scrolled up while a permission waits: no amber pill')
      else {
        const text = (await pill.innerText()).trim()
        if (text !== '모래두지가 허락을 기다려요') bad(`the waiting pill says ${JSON.stringify(text)}`)
        if (!(await pill.locator('.chat-dot.amber').count())) bad('the waiting pill has no amber dot')
        await pill.click()
        await sleep(1000)
        const inView = await page.evaluate(() => {
          const s = document.querySelector('.chat-scroll').getBoundingClientRect()
          const r = document.querySelector('.chat-tool.wait')?.getBoundingClientRect()
          return r ? r.top >= s.top - 1 && r.bottom <= s.bottom + 1 : null
        })
        if (inView !== true) bad(`the pill did not bring the waiting row into view (${inView})`)
      }
      await app.ctx.close()
      app = null
      // a sub-agent's permission: the status waits, no row of its own; its Agent row says so
      app = await openApp(browser, { chat: 'chat-agent' })
      const p2 = app.page
      const t1 = app.shot.terminals[0].id
      await p2.waitForSelector('.chat-agent', { timeout: 15_000 })
      const agentRow = { ...app.shot.chat[t1].ops[0].items.find(i => i.tool === 'Agent'), state: 'running' }
      agentRow.agentId ??= 'afixture01'
      const waitStatus = extra => ({ state: 'waiting', since: Date.now(), label: null, banner: null, note: null, version: '2.1.323', hasOlder: false, empty: false, ...extra })
      // first the main thread's own wait the lens could not pair (no waitingAgent): no Agent row is blamed (re-review m-10)
      await p2.evaluate(([id, row, st]) => window.__CHAT_PUSH__(id, [{ op: 'upsert', items: [row] }, { op: 'status', status: st }]), [t1, agentRow, waitStatus({})])
      await sleep(500)
      if (await p2.locator('.chat-agent .chat-dot.amber').count()) bad('the main thread\'s own wait (not paired) is put on a running Agent row')
      // then the sub-agent's (status.waitingAgent): its Agent row says so
      await p2.evaluate(([id, st]) => window.__CHAT_PUSH__(id, [{ op: 'status', status: st }]), [t1, waitStatus({ waitingAgent: agentRow.agentId })])
      await sleep(500)
      const meta = (await p2.locator('.chat-agent .chat-tool-meta').innerText().catch(() => '')).trim()
      if (!meta.includes('터미널에서 답해 주세요')) bad(`a sub-agent's wait does not show on its Agent row (${JSON.stringify(meta)})`)
      if (!(await p2.locator('.chat-agent .chat-dot.amber').count())) bad('the Agent row of a waiting sub-agent has no amber dot')
    } catch (err) {
      bad(String(err.message).split('\n')[0])
    } finally {
      if (app) await app.ctx.close()
    }
    return problems
  },

  /**
   * The focus is the user's (review I2): typing in the side panel's box — mid-composition — while the
   * chat mounts, fills, updates and is cleared (/clear) keeps the focus and the text there.
   */
  'chat-focus': async ({ browser }) => {
    const problems = []
    const bad = m => problems.push(m)
    let app
    try {
      app = await openApp(browser, { chat: 'chat-empty' })
      const { page, shot } = app
      const t1 = shot.terminals[0].id
      await page.waitForSelector('.chat .chat-empty', { timeout: 15_000 })
      // (Phase 3: while the chat shows, the side panel's box points to the composer; the typing is the composer's)
      await page.waitForSelector('.chat-composer textarea.chat-input:not(.chat-input-twin)', { timeout: 10_000 })
      const box = page.locator('.chat-composer textarea.chat-input:not(.chat-input-twin)')
      await box.click()
      await page.keyboard.type('첫 지시 ')
      // a Korean composition in progress (compositionstart, text going in, no end yet)
      await box.evaluate(el => el.dispatchEvent(new CompositionEvent('compositionstart', { data: '' })))
      await page.keyboard.insertText('하')
      const items = chatFixture.update('chat', t1).ops[0].items
      const status = (over = {}) => ({ state: 'idle', since: null, label: null, banner: null, note: null, version: '2.1.323', hasOlder: false, empty: false, ...over })
      const steps = [
        ['the first rows arrive', [{ op: 'reset', items: items.slice(0, 5), status: status({ state: 'working', since: Date.now() }) }]],
        ['more rows', [{ op: 'upsert', items: items.slice(5) }]],
        ['/clear: an empty session again', [{ op: 'reset', items: [], status: status({ empty: true }) }]],
        ['the new session\'s first row', [{ op: 'reset', items: items.slice(0, 2), status: status() }]],
      ]
      for (const [what, ops] of steps) {
        await page.evaluate(([id, o]) => window.__CHAT_PUSH__(id, o), [t1, ops])
        await sleep(450)
        const f = await page.evaluate(() => ({ tag: document.activeElement?.tagName, inBox: !!document.activeElement?.closest('.chat-composer'), value: document.querySelector('.chat-composer textarea.chat-input:not(.chat-input-twin)')?.value }))
        if (!f.inBox) bad(`${what}: the focus left the composer (now ${f.tag})`)
        if (f.value !== '첫 지시 하') bad(`${what}: the box's text is ${JSON.stringify(f.value)}`)
      }
      await box.evaluate(el => el.dispatchEvent(new CompositionEvent('compositionend', { data: '하' })))
      // the user's own flip (a click) still brings the focus to the conversation
      await app.ctx.close()
      app = await openApp(browser, { chat: 'chat', chatMode: false })
      await app.page.waitForSelector('.w-term-body .xterm', { timeout: 15_000 })
      await app.page.locator('.w-lens button', { hasText: '채팅' }).click()
      await app.page.waitForSelector('.chat .chat-row', { timeout: 10_000 })
      await sleep(300)
      await app.page.waitForSelector('.chat-composer textarea.chat-input:not(.chat-input-twin)', { timeout: 10_000 })
      await sleep(200)
      if (!(await app.page.evaluate(() => !!document.activeElement?.closest('.chat-composer')))) bad(`the user's own flip did not focus the composer (${await app.page.evaluate(() => document.activeElement?.outerHTML.slice(0, 80))})`)
    } catch (err) {
      bad(String(err.message).split('\n')[0])
    } finally {
      if (app) await app.ctx.close()
    }
    return problems
  },

  /**
   * When main cannot answer, a sub-agent's rows let go, a row that throws (review I3, I4, I6, M12):
   * open answered { ok: false } → the banner; nothing sent → 불러오는 중… (never a blank pane); an open
   * Agent row whose rows went away asks again; a row that throws leaves the window and its terminals
   * standing, says so and offers the terminal; an older page answered { ok: false } clears its line.
   */
  'chat-robust': async ({ browser }) => {
    const problems = []
    const bad = m => problems.push(m)
    const run = async (label, setup, steps) => {
      let app
      try {
        app = await openApp(browser, setup)
        await steps(app, m => bad(`${label}: ${m}`))
      } catch (err) {
        bad(`${label}: ${String(err.message).split('\n')[0]}`)
      } finally {
        if (app) await app.ctx.close()
      }
    }
    await run('open { ok: false }', { chat: 'chat', chatOpts: { openFails: true } }, async ({ page }, no) => {
      const banner = page.locator('.chat-banner')
      await banner.waitFor({ timeout: 5000 }).catch(() => {})
      const text = (await banner.innerText().catch(() => '')).trim()
      if (!text.includes('채팅을 읽는 부분이 멈췄어요')) no(`no banner (${JSON.stringify(text)})`)
      if (!(await banner.locator('button', { hasText: '터미널로 보기' }).count())) no('the banner offers no 터미널로 보기')
    })
    // a refusal for a session not armed (a race the flip should keep out) says so, not that the reader stopped (re-review m-11)
    await run('open { ok: false, reason: unarmed }', { chat: 'chat', chatOpts: { openFails: 'unarmed' } }, async ({ page }, no) => {
      const banner = page.locator('.chat-banner')
      await banner.waitFor({ timeout: 5000 }).catch(() => {})
      const text = (await banner.innerText().catch(() => '')).trim()
      if (!text.includes('채팅 보기를 켜기 전에 열렸어요')) no(`an unarmed refusal says ${JSON.stringify(text)}`)
      if (text.includes('채팅을 읽는 부분이 멈췄어요')) no('an unarmed refusal says the reader stopped')
    })
    await run('nothing sent', { chat: 'chat', chatOpts: { silent: true } }, async ({ page }, no) => {
      await sleep(800)
      const text = (await page.locator('.chat').innerText().catch(() => '')).trim()
      if (!text.includes('불러오는 중…')) no(`a view with nothing heard draws ${JSON.stringify(text)}`)
    })
    await run('sub-agent rows let go', { chat: 'chat-agent' }, async ({ page, shot }, no) => {
      const t1 = shot.terminals[0].id
      await page.locator('.chat-agent .chat-tool-toggle').first().click()
      await page.waitForSelector('.chat-agent-body .chat-tool', { timeout: 5000 })
      const asks = async () => (await calls(page)).filter(c => c.fn === 'chat.agent').length
      await sleep(600)
      const n = await asks()
      // the answer's rows arriving is no reason to ask again (re-review m-5)
      if (n !== 1) no(`opening the Agent row asked for its rows ${n} times`)
      // main let the view go (a minute away, 다시 읽기): its reset comes without the sub-agent's rows
      await page.evaluate(([id, u]) => window.__CHAT_PUSH__(id, u.ops), [t1, shot.chat[t1]])
      await sleep(600)
      if (await asks() <= n) no('the open Agent row did not ask for its rows again')
      if (!(await page.locator('.chat-agent-body .chat-tool').count())) no('the sub-agent\'s rows did not come back')
    })
    // 답 복사 on an answer cut at the lens's cap: the head is copied, and the button says the rest was not (re-review m-7)
    await run('a cut answer copied', { chat: 'chat' }, async ({ page, shot }, no) => {
      const t1 = shot.terminals[0].id
      await page.waitForSelector('.chat .chat-row', { timeout: 15_000 })
      await page.evaluate(() => { Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (s) => { window.__COPIED__ = s } } }) })
      const last = shot.chat[t1].ops[0].items.reduce((m, i) => Math.max(m, i.order), 0)
      await page.evaluate(([id, order]) => window.__CHAT_PUSH__(id, [{ op: 'upsert', items: [
        { id: 'cut-1', order: order + 10, at: null, kind: 'text', text: '아주 긴 답의 앞부분이에요.', truncated: true },
        { id: 'whole-1', order: order + 20, at: null, kind: 'text', text: '짧은 답이에요.' },
      ] }]), [t1, last])
      await sleep(600)
      const said = async (key) => {
        const row = page.locator(`.chat-row[data-key="${key}"]`)
        await row.hover()
        await row.locator('.chat-copy').click()
        await sleep(150)
        return (await row.locator('.chat-copy').innerText()).trim()
      }
      const cut = await said('cut-1')
      if (cut !== '잘린 부분은 복사되지 않았어요') no(`a cut answer, copied, says ${JSON.stringify(cut)}`)
      if (await page.evaluate(() => window.__COPIED__) !== '아주 긴 답의 앞부분이에요.') no('the cut answer\'s head was not what was copied')
      const whole = await said('whole-1')
      if (whole !== '복사했어요') no(`a whole answer, copied, says ${JSON.stringify(whole)}`)
    })
    await run('a row that throws', { chat: 'chat' }, async ({ page, shot }, no) => {
      const t1 = shot.terminals[0].id
      await page.waitForSelector('.chat .chat-row', { timeout: 15_000 })
      const rows = await page.locator('.w-party .w-row').count()
      const xterms = await page.locator('.xterm').count()
      // a question whose options are not a list (a shape this page does not expect)
      await page.evaluate(id => window.__CHAT_PUSH__(id, [{ op: 'upsert', items: [{ id: 'odd', order: 1e12, at: null, kind: 'tool', tool: 'AskUserQuestion', input: { question: 'q', options: 'abc' }, state: 'running', waiting: 'question' }] }]), t1)
      await sleep(600)
      const failed = page.locator('.w-chat-failed')
      if (!(await failed.count())) no('no "채팅 보기를 그리지 못했어요" in the chat pane')
      else if (!(await failed.innerText()).includes('채팅 보기를 그리지 못했어요')) no(`the pane says ${JSON.stringify(await failed.innerText())}`)
      if (await page.locator('.w-party .w-row').count() !== rows) no('the session list went with the chat')
      if (await page.locator('.xterm').count() !== xterms) no('the terminals went with the chat')
      await failed.locator('button').click()
      await sleep(500)
      if (!(await page.locator('.w-term-body .xterm').first().isVisible())) no('터미널로 보기 did not show the terminal')
      if (await page.locator('.w-lens button[aria-pressed="true"]').innerText() !== '터미널') no('the flip does not say 터미널')
    })
    await run('older { ok: false }', { chat: 'chat-long', chatOpts: { olderFails: true } }, async ({ page }, no) => {
      await page.waitForSelector('.chat .chat-row', { timeout: 15_000 })
      await page.evaluate(() => { document.querySelector('.chat-scroll').scrollTop = 0 })
      await sleep(800)
      const line = (await page.locator('.chat-older').first().innerText().catch(() => '')).trim()
      if (line.includes('불러오는 중')) no(`an older page answered { ok: false } leaves ${JSON.stringify(line)}`)
      if (!(await calls(page)).some(c => c.fn === 'chat.older')) no('no older page was asked for')
    })
    return problems
  },

  /**
   * Off is 1.4.0: terminals with no chat key → no flip, no chat code loaded, no chat call; and the
   * session view's picture equals the 1.4.0 one pixel for pixel (the baseline: CHAT_OFF_BASELINE, or
   * <out>/../00-before/session-1440x900.png made from release 1.4.0's build).
   */
  /**
   * The composer sends (chat view phase 3): Enter → exactly one chat.send with the screen's verdict, the
   * echo on the fake screen → exactly one chat.submit 'ok'; the bubble says 보내는 중… and then is sent; the
   * record's user line replaces it (one row, no bubble left).
   */
  'chat-send': async ({ browser }) => {
    const problems = []
    const bad = m => problems.push(m)
    let app
    try {
      app = await openApp(browser, { chat: 'chat' })
      const { page } = app
      const id = await firstTerm(page)
      await page.waitForSelector('.chat-composer textarea.chat-input:not(.chat-input-twin)', { timeout: 15_000 })
      await screenTo(page, id, 'idle-empty')
      await chatScript(page, { send: { ok: true, expect: { head: 'Without tools, name thre', images: 0, long: false }, command: false } })
      await composerField(page).click()
      await page.keyboard.type('hello')
      await page.keyboard.press('Enter')
      await sleep(200)
      const sends = await callsOf(page, 'chat.send')
      if (sends.length !== 1) bad(`${sends.length} chat.send calls after one Enter`)
      else if (sends[0].args[0].screen !== 'empty' || sends[0].args[0].text !== 'hello') bad(`chat.send got ${JSON.stringify(sends[0].args[0])}`)
      if (!(await page.locator('.chat-user.pending.sending').count())) bad('no 보내는 중 bubble while the send runs')
      if ((await callsOf(page, 'chat.submit')).length) bad('chat.submit before the echo')
      await screenTo(page, id, 'echo-plain')
      await page.waitForSelector('.chat-user.pending.sent', { timeout: 3000 }).catch(() => bad('the bubble never became sent'))
      const subs = await callsOf(page, 'chat.submit')
      if (subs.length !== 1 || subs[0].args[0].echo !== 'ok' || subs[0].args[0].sendId !== sends[0]?.args[0].sendId) bad(`chat.submit calls: ${JSON.stringify(subs.map(c => c.args[0]))}`)
      if (await composerField(page).inputValue() !== '') bad('the draft was not cleared after the send')
      // the record's own line
      const top = Math.max(...chatFixture.update('chat', id).ops[0].items.map(i => i.order))
      await page.evaluate(([i, item]) => window.__CHAT_PUSH__(i, [{ op: 'upsert', items: [item] }]), [id, { id: 'u-sent', order: top + 1000, at: fixture.NOW, kind: 'user', text: 'hello', images: 0 }])
      await sleep(400)
      const rows = await page.locator('.chat-user .chat-bubble', { hasText: /^hello$/ }).count()
      if (rows !== 1) bad(`${rows} user rows say hello after the record's line came`)
      if (await page.locator('.chat-user.pending').count()) bad('a bubble is left after the record\'s line came')
    } catch (err) { bad(String(err.message).split('\n')[0]) } finally { if (app) await app.ctx.close() }
    return problems
  },

  /**
   * The Korean IME in the composer: during a composition Enter sends nothing, Backspace and Esc (even while
   * working) do nothing of the composer's; after compositionend one Enter sends the whole syllables once;
   * losing the focus mid-composition keeps the text.
   */
  'chat-send-ime': async ({ browser }) => {
    const problems = []
    const bad = m => problems.push(m)
    let app
    try {
      app = await openApp(browser, { chat: 'chat' })
      const { page } = app
      const id = await firstTerm(page)
      await page.waitForSelector('.chat-composer textarea.chat-input:not(.chat-input-twin)', { timeout: 15_000 })
      await screenTo(page, id, 'idle-empty')
      const field = composerField(page)
      await field.click()
      const fire = (type, init) => field.evaluate((el, [t, i]) => {
        if (t === 'keydown') el.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...i }))
        else el.dispatchEvent(new CompositionEvent(t, { bubbles: true, ...i }))
      }, [type, init])
      await fire('compositionstart', { data: '' })
      await page.keyboard.insertText('안녕')
      await fire('keydown', { key: 'Enter', code: 'Enter', isComposing: true })
      await fire('keydown', { key: 'Process', code: 'Enter', isComposing: true })
      await sleep(150)
      if ((await callsOf(page, 'chat.send')).length) bad('Enter during the composition sent')
      await fire('compositionend', { data: '녕' })
      await page.keyboard.press('Enter')
      await sleep(200)
      const sends = await callsOf(page, 'chat.send')
      if (sends.length !== 1) bad(`${sends.length} chat.send after the composition ended and Enter`)
      else if (sends[0].args[0].text !== '안녕') bad(`the send's text is ${JSON.stringify(sends[0].args[0].text)}`)
      await sleep(1800) // the send runs out (no echo on this screen)
      // Backspace during a composition: nothing of the composer's (no call, the text stays)
      await field.fill('')
      await field.click()
      await fire('compositionstart', { data: '' })
      await page.keyboard.insertText('가')
      await fire('keydown', { key: 'Backspace', code: 'Backspace', isComposing: true })
      await sleep(100)
      if ((await calls(page)).filter(c => /^chat\.(send|dropImage|interrupt)$/.test(c.fn)).length !== 1) bad('Backspace during a composition made a call')
      // a blur mid-composition keeps the text
      await field.evaluate(el => el.blur())
      await sleep(100)
      if (!(await field.inputValue()).includes('가')) bad(`a blur mid-composition lost the text (${JSON.stringify(await field.inputValue())})`)
      // Esc during a composition, while Claude works: no stop
      await pushStatus(page, id, { state: 'working', since: fixture.NOW })
      await field.click()
      await fire('compositionstart', { data: '' })
      await page.keyboard.insertText('다')
      await fire('keydown', { key: 'Escape', code: 'Escape', isComposing: true })
      await sleep(150)
      if ((await callsOf(page, 'chat.interrupt')).length) bad('Esc during a composition stopped the work')
      await fire('compositionend', { data: '다' })
    } catch (err) { bad(String(err.message).split('\n')[0]) } finally { if (app) await app.ctx.close() }
    return problems
  },

  /** Shift+Enter twice → one chat.send whose text has two newlines (never one prompt per line) */
  'chat-send-multiline': async ({ browser }) => {
    const problems = []
    const bad = m => problems.push(m)
    let app
    try {
      app = await openApp(browser, { chat: 'chat' })
      const { page } = app
      const id = await firstTerm(page)
      await page.waitForSelector('.chat-composer textarea.chat-input:not(.chat-input-twin)', { timeout: 15_000 })
      await screenTo(page, id, 'idle-empty')
      await composerField(page).click()
      await page.keyboard.type('one')
      await page.keyboard.press('Shift+Enter')
      await page.keyboard.type('two')
      await page.keyboard.press('Shift+Enter')
      await page.keyboard.type('three')
      if ((await callsOf(page, 'chat.send')).length) bad('Shift+Enter sent')
      await page.keyboard.press('Enter')
      await sleep(200)
      const sends = await callsOf(page, 'chat.send')
      if (sends.length !== 1 || sends[0].args[0].text !== 'one\ntwo\nthree') bad(`chat.send calls: ${JSON.stringify(sends.map(c => c.args[0].text))}`)
    } catch (err) { bad(String(err.message).split('\n')[0]) } finally { if (app) await app.ctx.close() }
    return problems
  },

  /** A double click on 보내기, and two Enters 30 ms apart: one chat.send each time */
  'chat-send-double': async ({ browser }) => {
    const problems = []
    const bad = m => problems.push(m)
    let app
    try {
      app = await openApp(browser, { chat: 'chat' })
      const { page } = app
      const id = await firstTerm(page)
      await page.waitForSelector('.chat-composer textarea.chat-input:not(.chat-input-twin)', { timeout: 15_000 })
      await screenTo(page, id, 'idle-empty')
      await composerField(page).click()
      await page.keyboard.type('add a mul function')
      await page.locator('.chat-composer .chat-send').dblclick()
      await sleep(150)
      if ((await callsOf(page, 'chat.send')).length !== 1) bad(`a double click on 보내기: ${(await callsOf(page, 'chat.send')).length} chat.send`)
      await screenTo(page, id, 'typed')
      await page.waitForFunction(() => (window.__CALLS__ || []).filter(c => c.fn === 'chat.submit').length === 1, null, { timeout: 3000 }).catch(() => bad('the first send never submitted'))
      await sleep(200)
      await screenTo(page, id, 'idle-empty')
      await composerField(page).click()
      await page.keyboard.type('add a mul function')
      await page.keyboard.press('Enter')
      await sleep(30)
      await page.keyboard.press('Enter')
      await sleep(200)
      if ((await callsOf(page, 'chat.send')).length !== 2) bad(`two quick Enters: ${(await callsOf(page, 'chat.send')).length - 1} chat.send`)
    } catch (err) { bad(String(err.message).split('\n')[0]) } finally { if (app) await app.ctx.close() }
    return problems
  },

  /**
   * Refusals: a dialog on the terminal's screen → no chat.send, the note and 터미널로 보기 (which flips);
   * main's prompt-busy → its note, the draft kept; the session waiting → the local note, no call; the echo
   * never coming → chat.submit 'timeout', the "남아 있어요" note, the draft cleared.
   */
  'chat-send-refuse': async ({ browser }) => {
    const problems = []
    const bad = m => problems.push(m)
    let app
    try {
      app = await openApp(browser, { chat: 'chat' })
      const { page } = app
      const id = await firstTerm(page)
      const note = () => page.locator('.chat-cnote').innerText()
      await page.waitForSelector('.chat-composer textarea.chat-input:not(.chat-input-twin)', { timeout: 15_000 })
      await screenTo(page, id, 'dialog-bash')
      await composerField(page).click()
      await page.keyboard.type('hi')
      await page.keyboard.press('Enter')
      await sleep(200)
      if ((await callsOf(page, 'chat.send')).length) bad('a send went through with a dialog on the screen')
      if (!(await note()).includes('확인하지 못했어요')) bad(`the dialog: the note says ${JSON.stringify(await note())}`)
      await page.locator('.chat-cnote .chat-btn').click()
      await sleep(400)
      if (await page.locator('.chat').count()) bad('터미널로 보기 did not flip to the terminal')
      await page.locator('.w-lens button', { hasText: '채팅' }).click()
      await page.waitForSelector('.chat-composer textarea.chat-input:not(.chat-input-twin)', { timeout: 10_000 })
      if (await composerField(page).inputValue() !== 'hi') bad('the draft was lost across the flip')
      // main says the prompt row has text (1.6.2: as it now only does, typed text on the row, read as `typed` by its
      // dim marks: the fixture is written in plain colour; the note quotes it)
      await screenTo(page, id, 'typed')
      await chatScript(page, { send: { ok: false, reason: 'prompt-busy' } })
      await composerField(page).click()
      await page.keyboard.press('Enter')
      await sleep(250)
      if ((await callsOf(page, 'chat.send')).length !== 1) bad('prompt-busy: no single chat.send')
      if ((await callsOf(page, 'chat.send'))[0]?.args[0]?.screen !== 'typed') bad(`prompt-busy: the row went as ${JSON.stringify((await callsOf(page, 'chat.send'))[0]?.args[0]?.screen)}, not typed`)
      if (!(await note()).includes('터미널 입력란에 쓰던 글이 있어요: “add a mul function”')) bad(`prompt-busy: the note says ${JSON.stringify(await note())}`)
      if (await composerField(page).inputValue() !== 'hi') bad('prompt-busy: the draft was not kept')
      if (await page.locator('.chat-user.pending').count()) bad('prompt-busy: a bubble stayed')
      // the session waits on the user
      await pushStatus(page, id, { state: 'waiting', since: fixture.NOW })
      await page.keyboard.press('Enter')
      await sleep(200)
      if ((await callsOf(page, 'chat.send')).length !== 1) bad('waiting: a send went to main')
      if (!(await note()).includes('먼저 답해 주세요')) bad(`waiting: the note says ${JSON.stringify(await note())}`)
      // the echo never comes
      await pushStatus(page, id, {})
      await chatScript(page, { send: { ok: true, expect: { head: 'hi', images: 0, long: false }, command: false } })
      await page.keyboard.press('Enter')
      await page.waitForFunction(() => (window.__CALLS__ || []).some(c => c.fn === 'chat.submit'), null, { timeout: 4000 }).catch(() => bad('no chat.submit after the echo wait'))
      await sleep(200)
      const subs = await callsOf(page, 'chat.submit')
      if (subs.length !== 1 || subs[0].args[0].echo !== 'timeout') bad(`no echo: chat.submit calls ${JSON.stringify(subs.map(c => c.args[0].echo))}`)
      if (!(await note()).includes('남아 있어요')) bad(`no echo: the note says ${JSON.stringify(await note())}`)
      if (await composerField(page).inputValue() !== '') bad('no echo: the draft was not cleared (sending it again would double it)')
    } catch (err) { bad(String(err.message).split('\n')[0]) } finally { if (app) await app.ctx.close() }
    return problems
  },

  /** Claude Code's own queue: 대기 중 2 and the first text; no button in the strip; none → no strip */
  // 2026-11-17: the session tabs — a row dragged onto the right side opens a tab (the drop says where), Ctrl+click
  // too, at most three (the fourth is refused, said so), a tab's × closes only the tab, a tab click shows it
  // the split view (2026-11-19, src/splitPanes.ts): open tabs side by side, each with its own header, chat and composer
  'session-tabs': async ({ browser, opts }) => {
    const problems = []
    const bad = m => problems.push(m)
    let app
    try {
      app = await openApp(browser, { chat: 'chat' })
      const { page } = app
      const rows = page.locator('.w-party .w-row')
      const heads = page.locator('.w-sess-bar.split .w-pane-head')
      const panes = page.locator('.w-chat-pane.split')
      if (await heads.count()) bad('panes drawn with one session in view')
      // drag the second row onto the right side: the hint while over it, then two panes side by side
      const body = page.locator('.w-term-body')
      const box = await body.boundingBox()
      await rows.nth(1).dragTo(body, { targetPosition: { x: box.width / 2, y: box.height / 2 } })
      await sleep(600)
      if ((await heads.count()) !== 2) bad(`after a drop: ${await heads.count()} pane headers, want 2`)
      if ((await panes.count()) !== 2) bad(`after a drop: ${await panes.count()} chat panes, want 2`)
      if ((await page.locator('.w-pane-head.on').count()) !== 1) bad('not exactly one pane in view after the drop')
      // Ctrl+click the third: three panes; the fourth is refused, said so
      await rows.nth(2).click({ modifiers: ['Control'] })
      await sleep(600)
      if ((await heads.count()) !== 3) bad(`after Ctrl+click: ${await heads.count()} panes, want 3`)
      if ((await page.locator('.chat-composer textarea.chat-input:not(.chat-input-twin)').count()) !== 3) bad('not one composer per pane')
      await rows.nth(3).click({ modifiers: ['Control'] })
      await sleep(200)
      if ((await heads.count()) !== 3) bad(`a fourth pane opened: ${await heads.count()}`)
      if (!(await page.locator('.w-tab-note').count())) bad('the fourth was refused without a word')
      // the panes sit side by side, left to right, without overlapping
      const boxes = []
      for (let i = 0; i < await panes.count(); i++) boxes.push(await panes.nth(i).boundingBox())
      for (let i = 1; i < boxes.length; i++) if (boxes[i].x < boxes[i - 1].x + boxes[i - 1].width - 2) bad(`pane ${i} overlaps pane ${i - 1}`)
      if (opts?.out) await page.screenshot({ path: join(opts.out, 'flow-split-chat.png'), animations: 'disabled', caret: 'hide' })
      // a click in another pane puts it in view
      await panes.nth(0).click({ position: { x: 40, y: 80 } })
      await sleep(200)
      if (!(await heads.nth(0).evaluate(el => el.classList.contains('on')))) bad('a click in a pane did not put it in view')
      // its × closes only the pane
      await heads.nth(1).locator('.w-sess-head-close').click()
      await sleep(400)
      if ((await heads.count()) !== 2) bad(`after a pane's ×: ${await heads.count()} panes, want 2`)
      if ((await rows.count()) < 4) bad('closing a pane closed a session')
      // 터미널: each pane shows its own terminal, side by side
      await page.locator('.w-split-tools .w-lens button').nth(1).click()
      await sleep(800)
      const views = page.locator('.w-term-body .term-wrap[style*="contents"] .term-view')
      const n = await views.count()
      if (n !== 2) bad(`terminal mode: ${n} terminals shown, want 2`)
      else {
        const a = await views.nth(0).boundingBox(), b2 = await views.nth(1).boundingBox()
        if (!a || !b2 || Math.abs(a.x - b2.x) < 50) bad('the two terminals are not side by side')
      }
      if (opts?.out) await page.screenshot({ path: join(opts.out, 'flow-split-terminal.png'), animations: 'disabled', caret: 'hide' })
    } catch (err) { bad(String(err.message).split('\n')[0]) } finally { if (app) await app.ctx.close() }
    return problems
  },

  'chat-queue': async ({ browser }) => {
    const problems = []
    const bad = m => problems.push(m)
    let app
    try {
      app = await openApp(browser, { chat: 'chat' })
      const { page } = app
      const id = await firstTerm(page)
      await page.waitForSelector('.chat-composer textarea.chat-input:not(.chat-input-twin)', { timeout: 15_000 })
      await pushStatus(page, id, { state: 'working', since: fixture.NOW, queued: [{ text: '끝나면 테스트도 돌려 주세요', truncated: false }, { text: '그리고 정리', truncated: false }], queuedCount: 2 })
      await sleep(300)
      const strip = page.locator('.chat-queue')
      if (!(await strip.count())) bad('no queue strip')
      else {
        const text = await strip.innerText()
        if (!text.includes('대기 중 2') || !text.includes('끝나면 테스트도 돌려 주세요')) bad(`the strip says ${JSON.stringify(text)}`)
        // (display only: nothing to send now or take out; the strip itself opens the list)
        if (await strip.locator('button').count()) bad('a button in the queue strip (display only)')
        await strip.click()
        await sleep(150)
        const items = await page.locator('.chat-queue-list li').allInnerTexts()
        if (items.length !== 2 || !items[1].includes('그리고 정리')) bad(`the opened list says ${JSON.stringify(items)}`)
      }
      await pushStatus(page, id, { state: 'working', since: fixture.NOW })
      await sleep(300)
      if (await page.locator('.chat-queue').count()) bad('the strip stayed with nothing queued')
    } catch (err) { bad(String(err.message).split('\n')[0]) } finally { if (app) await app.ctx.close() }
    return problems
  },

  /** 멈추기: in the working line while working → one chat.interrupt; Esc in the composer → one more; waiting: none */
  'chat-stop': async ({ browser }) => {
    const problems = []
    const bad = m => problems.push(m)
    let app
    try {
      app = await openApp(browser, { chat: 'chat' })
      const { page } = app
      const id = await firstTerm(page)
      await page.waitForSelector('.chat-composer textarea.chat-input:not(.chat-input-twin)', { timeout: 15_000 })
      if (await page.locator('.chat-stop').count()) bad('멈추기 shown while idle')
      await pushStatus(page, id, { state: 'working', since: fixture.NOW })
      await page.waitForSelector('.chat-status .chat-stop', { timeout: 3000 }).catch(() => bad('no 멈추기 in the working line'))
      await page.locator('.chat-stop').click()
      await sleep(150)
      if ((await callsOf(page, 'chat.interrupt')).length !== 1) bad(`멈추기: ${(await callsOf(page, 'chat.interrupt')).length} chat.interrupt`)
      await composerField(page).click()
      await page.keyboard.press('Escape')
      await sleep(150)
      if ((await callsOf(page, 'chat.interrupt')).length !== 2) bad(`Esc in the composer: ${(await callsOf(page, 'chat.interrupt')).length - 1} chat.interrupt`)
      await pushStatus(page, id, { state: 'waiting', since: fixture.NOW })
      await sleep(200)
      if (await page.locator('.chat-stop').count()) bad('멈추기 shown while the session waits on the user')
    } catch (err) { bad(String(err.message).split('\n')[0]) } finally { if (app) await app.ctx.close() }
    return problems
  },

  /**
   * Images: a pasted PNG → one chat.image with its bytes and a chip; the chip opens the lightbox, Esc
   * closes it and the focus is back on the chip; × → chat.dropImage; a dropped .txt → the type note and
   * no call; a paste of text only → no chat.image.
   */
  'chat-image': async ({ browser }) => {
    const problems = []
    const bad = m => problems.push(m)
    let app
    try {
      app = await openApp(browser, { chat: 'chat' })
      const { page } = app
      await page.waitForSelector('.chat-composer textarea.chat-input:not(.chat-input-twin)', { timeout: 15_000 })
      await composerField(page).click()
      await pasteImage(page, 1)
      await page.waitForSelector('.chat-ichip', { timeout: 3000 }).catch(() => bad('no chip after the paste'))
      const imgs = await callsOf(page, 'chat.image')
      if (imgs.length !== 1) bad(`${imgs.length} chat.image calls for one pasted image`)
      else if (imgs[0].args[0].head.join(',') !== '137,80,78,71,13,10,26,10' || imgs[0].args[0].size < 30) bad(`chat.image got ${JSON.stringify(imgs[0].args[0])}`)
      await page.locator('.chat-ichip-pic').click()
      await page.waitForSelector('.chat-lightbox', { timeout: 2000 }).catch(() => bad('no lightbox'))
      if (!(await page.evaluate(() => document.activeElement?.classList.contains('chat-lightbox-x')))) bad('the lightbox did not take the focus to its close button')
      await page.keyboard.press('Escape')
      await sleep(200)
      if (await page.locator('.chat-lightbox').count()) bad('Esc did not close the lightbox')
      if (!(await page.evaluate(() => document.activeElement?.classList.contains('chat-ichip-pic')))) bad(`the focus did not come back to the chip (${await page.evaluate(() => document.activeElement?.className)})`)
      if ((await callsOf(page, 'chat.interrupt')).length) bad('Esc in the lightbox reached the composer')
      await page.locator('.chat-ichip-x').click()
      await sleep(150)
      if ((await callsOf(page, 'chat.dropImage')).length !== 1) bad('× made no chat.dropImage')
      if (await page.locator('.chat-ichip').count()) bad('the chip stayed after ×')
      await page.evaluate(() => {
        const dt = new DataTransfer()
        dt.items.add(new File(['plain words'], 'notes.txt', { type: 'text/plain' }))
        document.querySelector('.chat-cbox').dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }))
      })
      await sleep(150)
      if ((await callsOf(page, 'chat.image')).length !== 1) bad('a dropped .txt went to main')
      if (!(await page.locator('.chat-cnote').innerText()).includes('PNG, JPEG, GIF, WebP')) bad('a dropped .txt: no type note')
      await page.evaluate(() => {
        const dt = new DataTransfer()
        dt.setData('text/plain', 'just words')
        document.querySelector('.chat-composer textarea.chat-input:not(.chat-input-twin)').dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }))
      })
      await sleep(150)
      if ((await callsOf(page, 'chat.image')).length !== 1) bad('a text paste made a chat.image')
    } catch (err) { bad(String(err.message).split('\n')[0]) } finally { if (app) await app.ctx.close() }
    return problems
  },

  /**
   * The composer owns the focus by Phase 2's rules: the user's flip to 채팅 puts it in the composer; a
   * composition in the composer survives rows arriving.
   */
  'chat-compose-focus': async ({ browser }) => {
    const problems = []
    const bad = m => problems.push(m)
    let app
    try {
      app = await openApp(browser, { chat: 'chat', chatMode: false })
      const { page } = app
      const id = await firstTerm(page)
      await page.waitForSelector('.w-term-body .xterm', { timeout: 15_000 })
      await page.locator('.w-lens button', { hasText: '채팅' }).click()
      await page.waitForSelector('.chat-composer textarea.chat-input:not(.chat-input-twin)', { timeout: 10_000 })
      await sleep(400)
      if (!(await page.evaluate(() => !!document.activeElement?.closest('.chat-composer')))) bad(`the flip did not focus the composer (${await page.evaluate(() => document.activeElement?.className)})`)
      // mid-composition in the composer while rows arrive
      const field = composerField(page)
      await field.evaluate(el => el.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: '' })))
      await page.keyboard.insertText('하')
      const items = chatFixture.update('chat', id).ops[0].items
      for (const ops of [[{ op: 'upsert', items: items.slice(-3) }], [{ op: 'reset', items, status: chatStatus({ state: 'working', since: fixture.NOW }) }]]) {
        await page.evaluate(([i, o]) => window.__CHAT_PUSH__(i, o), [id, ops])
        await sleep(400)
        const f = await page.evaluate(() => ({ inComposer: !!document.activeElement?.closest('.chat-composer'), value: document.querySelector('.chat-composer textarea.chat-input:not(.chat-input-twin)')?.value }))
        if (!f.inComposer || f.value !== '하') bad(`rows arriving moved the focus or the text: ${JSON.stringify(f)}`)
      }
      await field.evaluate(el => el.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '하' })))
    } catch (err) { bad(String(err.message).split('\n')[0]) } finally { if (app) await app.ctx.close() }
    return problems
  },

  /** At the bottom, a draft growing from 1 to 6 lines keeps the list at the bottom; past 8 lines the field scrolls */
  'chat-compose-grow': async ({ browser }) => {
    const problems = []
    const bad = m => problems.push(m)
    let app
    try {
      app = await openApp(browser, { chat: 'chat' })
      const { page } = app
      await page.waitForSelector('.chat-composer textarea.chat-input:not(.chat-input-twin)', { timeout: 15_000 })
      await sleep(500)
      // (measured once the page has drawn two frames since the key: the list follows the box's size in the frame after it)
      const gapNow = () => page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(() => { const s = document.querySelector('.chat-scroll'); r(s ? Math.round(s.scrollHeight - s.scrollTop - s.clientHeight) : null) }))))
      // settled: back at the bottom within 600 ms of the key (a loaded machine may draw the frame after it late)
      const gap = async () => { let g = await gapNow(); for (let k = 0; k < 6 && (g === null || g > 2); k++) { await sleep(100); g = await gapNow() } return g }
      if ((await gap()) > 2) bad(`not at the bottom to begin with (gap ${await gap()})`)
      await composerField(page).click()
      await page.keyboard.type('line 1')
      for (let n = 2; n <= 6; n++) {
        await page.keyboard.press('Shift+Enter')
        await page.keyboard.type(`line ${n}`)
        await sleep(120)
        const g = await gap()
        if (g === null || g > 2) bad(`at ${n} lines the list left the bottom (gap ${g}px)`)
      }
      for (let n = 7; n <= 12; n++) { await page.keyboard.press('Shift+Enter'); await page.keyboard.type(`line ${n}`) }
      await sleep(150)
      const f = await composerField(page).evaluate(el => ({ h: el.clientHeight, full: el.scrollHeight, overflow: getComputedStyle(el).overflowY }))
      if (f.h > 160 || f.full <= f.h || f.overflow !== 'auto') bad(`past 8 lines the field does not scroll: ${JSON.stringify(f)}`)
      const g = await gap()
      if (g === null || g > 2) bad(`at 12 lines the list left the bottom (gap ${g}px)`)
    } catch (err) { bad(String(err.message).split('\n')[0]) } finally { if (app) await app.ctx.close() }
    return problems
  },

  // ---------------------------------------------------------------- the answer cards (chat view phase 4)

  /**
   * 허용: scrolled to the top of a long session, a card pushed is in view without scrolling and the focus
   * stays where it was; a pointer press that began as the card appeared answers nothing; digits answer
   * nothing; Tab to 허용 and Enter → one chat.answer allow; 보내는 중… then the sent words, then gone
   */
  'chat-allow': async ({ browser }) => {
    const problems = []
    const bad = m => problems.push(m)
    let app
    try {
      app = await openApp(browser, { chat: 'chat-long' })
      const { page } = app
      const id = await firstTerm(page)
      await page.waitForSelector('.chat .chat-row', { timeout: 15_000 })
      await sleep(400)
      await page.evaluate(() => { document.querySelector('.chat-scroll').scrollTop = 0 })
      await composerField(page).click()
      await sleep(200)
      await pushAsks(page, id, [chatFixture.ASKS.bash()])
      // pressed at once, where the card now is (a press meant for what was there before): no answer
      const allow = askButton(page, '허용')
      await allow.waitFor({ timeout: 3000 })
      const box = await allow.boundingBox()
      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
      await sleep(100)
      if ((await callsOf(page, 'chat.answer')).length) bad('a click the moment the card appeared answered it')
      await composerField(page).click()
      await sleep(500)
      const seen = await page.evaluate(() => {
        const c = document.querySelector('.chat-answer .chat-card')?.getBoundingClientRect()
        return c ? c.top >= 0 && c.bottom <= innerHeight : null
      })
      if (seen !== true) bad(`the card is not in view at the top of a long session (${seen})`)
      if (!(await page.evaluate(() => !!document.activeElement?.closest('.chat-composer')))) bad('the card took the focus from the composer')
      if (!(await page.evaluate(() => document.querySelector('.chat-scroll').scrollTop === 0))) bad('the card scrolled the conversation')
      await page.locator('.chat-answer .chat-card').focus()
      for (const k of ['1', '2', '3']) await page.keyboard.press(k)
      await sleep(150)
      if ((await callsOf(page, 'chat.answer')).length) bad('a digit answered the card (no shortcut: a click, or Enter on the focused button)')
      await page.keyboard.press('Tab')
      const focused = await page.evaluate(() => document.activeElement?.textContent?.trim())
      if (focused !== '허용') bad(`Tab from the card lands on ${JSON.stringify(focused)}, not 허용`)
      await page.keyboard.press('Enter')
      await sleep(200)
      const answers = await callsOf(page, 'chat.answer')
      if (answers.length !== 1 || answers[0].args[0].choice !== 'allow' || answers[0].args[0].holdId !== 'hold0bash' || answers[0].args[0].id !== id) bad(`Enter on 허용: ${JSON.stringify(answers.map(a => a.args[0]))}`)
      if (!(await page.locator('.chat-card .chat-card-hint', { hasText: '보내는 중…' }).count())) bad('no 보내는 중… after the answer')
      await page.keyboard.press('Enter')
      await sleep(150)
      if ((await callsOf(page, 'chat.answer')).length !== 1) bad('a second Enter answered again')
      await pushAsks(page, id, [{ ...chatFixture.ASKS.bash(), state: 'sent', sent: 'allow' }])
      if (!(await page.locator('.chat-card-state', { hasText: '허용을 보냈어요 · 확인 중' }).count())) bad('the sent card does not say 허용을 보냈어요 · 확인 중')
      if (await askButton(page, '허용').count()) bad('the sent card still has its buttons')
      await pushStatus(page, id, { state: 'working', since: fixture.NOW })
      if (await page.locator('.chat-answer').count()) bad('the surface stays after the card is gone')
    } catch (err) { bad(String(err.message).split('\n')[0]) } finally { if (app) await app.ctx.close() }
    return problems
  },

  /** 항상 허용: the rule is said; a click → always; a card without a rule has no 항상 허용, and 2 does nothing */
  'chat-always': async ({ browser }) => {
    const problems = []
    const bad = m => problems.push(m)
    let app
    try {
      app = await openApp(browser, { chat: 'chat' })
      const { page } = app
      const id = await firstTerm(page)
      await page.waitForSelector('.chat .chat-row', { timeout: 15_000 })
      await pushAsks(page, id, [chatFixture.ASKS.bash()])
      const always = askButton(page, '항상 허용')
      if (!(await always.count())) bad('no 항상 허용 for a card with a rule')
      const rule = (await page.locator('.chat-card-rule').innerText().catch(() => '')).trim()
      if (!rule.includes('Bash(npm run build)')) bad(`the rule is not said under the buttons (${JSON.stringify(rule)})`)
      if (!String(await always.getAttribute('title')).includes('Bash(npm run build)')) bad('항상 허용\'s title does not name its rule')
      await sleep(ARMED)
      await always.click()
      await sleep(200)
      const a = await callsOf(page, 'chat.answer')
      if (a.length !== 1 || a[0].args[0].choice !== 'always') bad(`항상 허용 clicked: ${JSON.stringify(a.map(x => x.args[0]))}`)
      await pushAsks(page, id, [chatFixture.ASKS.norule()])
      if (await askButton(page, '항상 허용').count()) bad('항상 허용 offered for a card without a rule')
      await page.locator('.chat-answer .chat-card').focus()
      await page.keyboard.press('2')
      await sleep(150)
      if ((await callsOf(page, 'chat.answer')).length !== 1) bad('2 answered a card')
    } catch (err) { bad(String(err.message).split('\n')[0]) } finally { if (app) await app.ctx.close() }
    return problems
  },

  /** 거부: the arrows move to it, Space answers deny; it is a hairline button (not red, not filled) */
  'chat-deny': async ({ browser }) => {
    const problems = []
    const bad = m => problems.push(m)
    let app
    try {
      app = await openApp(browser, { chat: 'chat' })
      const { page } = app
      const id = await firstTerm(page)
      await page.waitForSelector('.chat .chat-row', { timeout: 15_000 })
      await pushAsks(page, id, [chatFixture.ASKS.bash()])
      const deny = askButton(page, '거부')
      const look = await deny.evaluate(el => { const s = getComputedStyle(el); return { bg: s.backgroundColor, color: s.color, border: s.borderColor } })
      if (!/rgba\(0, 0, 0, 0\)|transparent/.test(look.bg)) bad(`거부 is filled: ${JSON.stringify(look)}`)
      if (/\b(2[0-9]{2}), ([0-9]{1,2}), ([0-9]{1,2})\b/.test(look.color)) bad(`거부 is red: ${look.color}`)
      await page.locator('.chat-answer .chat-card').focus()
      await page.keyboard.press('Tab')
      await page.keyboard.press('ArrowRight')
      await page.keyboard.press('ArrowRight')
      const focused = await page.evaluate(() => document.activeElement?.textContent?.trim())
      if (focused !== '거부') bad(`→ → from 허용 lands on ${JSON.stringify(focused)}`)
      if ((await callsOf(page, 'chat.answer')).length) bad('moving with the arrows answered')
      await page.keyboard.press('Space')
      await sleep(200)
      const a = await callsOf(page, 'chat.answer')
      if (a.length !== 1 || a[0].args[0].choice !== 'deny') bad(`Space on 거부: ${JSON.stringify(a.map(x => x.args[0]))}`)
    } catch (err) { bad(String(err.message).split('\n')[0]) } finally { if (app) await app.ctx.close() }
    return problems
  },

  /** A card while a draft is in the composer: Enter sends nothing and answers nothing (the note points to the card); digits typed there stay text */
  'chat-ask-enter': async ({ browser }) => {
    const problems = []
    const bad = m => problems.push(m)
    let app
    try {
      app = await openApp(browser, { chat: 'chat' })
      const { page } = app
      const id = await firstTerm(page)
      await page.waitForSelector(COMPOSER, { timeout: 15_000 })
      await screenTo(page, id, 'idle-empty')
      await composerField(page).click()
      await page.keyboard.type('빌드 끝나면 알려 줘')
      await pushAsks(page, id, [chatFixture.ASKS.bash()])
      await sleep(500)
      await page.keyboard.press('Enter')
      await sleep(300)
      if ((await callsOf(page, 'chat.answer')).length) bad('Enter in the composer answered the card')
      if ((await callsOf(page, 'chat.send')).length) bad('Enter in the composer sent while a card waits')
      const note = (await page.locator('.chat-cnote').innerText().catch(() => '')).trim()
      if (!note.includes('위 카드에서 먼저 답해 주세요')) bad(`the composer's note does not point to the card (${JSON.stringify(note)})`)
      await page.keyboard.type('123')
      await sleep(150)
      if ((await callsOf(page, 'chat.answer')).length) bad('digits typed in the composer answered the card')
      if ((await composerField(page).inputValue()) !== '빌드 끝나면 알려 줘123') bad(`the draft is not kept as typed (${JSON.stringify(await composerField(page).inputValue())})`)
    } catch (err) { bad(String(err.message).split('\n')[0]) } finally { if (app) await app.ctx.close() }
    return problems
  },

  /** A card whose time ran out: no answer buttons, the words, 터미널에서 답하기 flips to the terminal */
  'chat-ask-timeout': async ({ browser }) => {
    const problems = []
    const bad = m => problems.push(m)
    let app
    try {
      app = await openApp(browser, { chat: 'chat-ask-timeout' })
      const { page } = app
      await page.waitForSelector('.chat-answer .chat-card', { timeout: 15_000 })
      for (const name of ['허용', '항상 허용', '거부']) if (await askButton(page, name).count()) bad(`a timed-out card has ${name}`)
      if (!(await page.locator('.chat-card-state', { hasText: '답할 시간이 지나 터미널로 넘겼어요' }).count())) bad('the timed-out card does not say so')
      await page.locator('.chat-card button', { hasText: '터미널에서 답하기' }).click()
      await sleep(400)
      if (await page.locator('.chat').count()) bad('터미널에서 답하기 did not flip to the terminal')
      if ((await callsOf(page, 'chat.answer')).length) bad('a timed-out card sent an answer')
    } catch (err) { bad(String(err.message).split('\n')[0]) } finally { if (app) await app.ctx.close() }
    return problems
  },

  /** The terminal answered first: main refuses (gone) → 보내지 못했어요 · 터미널에서 답해 주세요; the card goes with the next push */
  'chat-ask-terminal-first': async ({ browser }) => {
    const problems = []
    const bad = m => problems.push(m)
    let app
    try {
      app = await openApp(browser, { chat: 'chat' })
      const { page } = app
      const id = await firstTerm(page)
      await page.waitForSelector('.chat .chat-row', { timeout: 15_000 })
      await chatScript(page, { answer: { ok: false, reason: 'gone' } })
      await pushAsks(page, id, [chatFixture.ASKS.bash()])
      await sleep(ARMED)
      await askButton(page, '허용').click()
      await sleep(250)
      if (!(await page.locator('.chat-card-state', { hasText: '보내지 못했어요 · 터미널에서 답해 주세요' }).count())) bad('a refused answer is not said')
      if (await askButton(page, '허용').count()) bad('a refused card still offers 허용')
      await pushStatus(page, id, { state: 'working', since: fixture.NOW })
      if (await page.locator('.chat-answer').count()) bad('the card stays after its call settled')
    } catch (err) { bad(String(err.message).split('\n')[0]) } finally { if (app) await app.ctx.close() }
    return problems
  },

  /** A question: chat.visible with its id at mount; the options are buttons; Tab to the second, Enter → option 1; a digit nothing */
  'chat-question': async ({ browser }) => {
    const problems = []
    const bad = m => problems.push(m)
    let app
    try {
      app = await openApp(browser, { chat: 'chat-ask-question' })
      const { page } = app
      const id = await firstTerm(page)
      await page.waitForSelector('.chat-answer .chat-card-opt', { timeout: 15_000 })
      const vis = await callsOf(page, 'chat.visible')
      if (!vis.length || vis[vis.length - 1].args[0] !== id) bad(`chat.visible at mount: ${JSON.stringify(vis.map(v => v.args[0]))}`)
      const opts = await page.locator('.chat-card-opt').allInnerTexts()
      if (opts.length !== 2 || !opts[0].includes('네') || !opts[1].includes('코드만 고쳐요')) bad(`the options: ${JSON.stringify(opts)}`)
      await sleep(500)
      await page.locator('.chat-answer .chat-card').focus()
      await page.keyboard.press('2')
      await sleep(100)
      if ((await callsOf(page, 'chat.answer')).length) bad('a digit answered the question')
      await page.keyboard.press('Tab')
      await page.keyboard.press('Tab')
      await page.keyboard.press('Enter')
      await sleep(200)
      const a = await callsOf(page, 'chat.answer')
      if (a.length !== 1 || a[0].args[0].choice !== 'option' || a[0].args[0].option !== 1 || a[0].args[0].holdId !== 'hold0question') bad(`the second option: ${JSON.stringify(a.map(x => x.args[0]))}`)
    } catch (err) { bad(String(err.message).split('\n')[0]) } finally { if (app) await app.ctx.close() }
    return problems
  },

  /** A question while the chat goes: the flip to 터미널 → chat.visible(null); back with the card handed to the terminal → read-only */
  'chat-question-hidden': async ({ browser }) => {
    const problems = []
    const bad = m => problems.push(m)
    let app
    try {
      app = await openApp(browser, { chat: 'chat-ask-question' })
      const { page } = app
      const id = await firstTerm(page)
      await page.waitForSelector('.chat-answer .chat-card-opt', { timeout: 15_000 })
      await page.locator('.w-lens button', { hasText: '터미널' }).click()
      await sleep(300)
      const vis = await callsOf(page, 'chat.visible')
      if (vis[vis.length - 1]?.args[0] !== null) bad(`the flip to 터미널 did not say no chat is shown: ${JSON.stringify(vis.map(v => v.args[0]))}`)
      // back to 채팅: main released it meanwhile (hidden), so its card is the terminal's now (the fake bridge
      // answers chat.open with the conversation as first opened: the lens's word comes after it)
      await page.locator('.w-lens button', { hasText: '채팅' }).click()
      await page.waitForSelector('.chat-answer .chat-card', { timeout: 5000 })
      await sleep(300)
      await pushAsks(page, id, [{ ...chatFixture.ASKS.question(), state: 'terminal' }], 'working')
      if (await page.locator('.chat-card-opt').count()) bad('a question handed to the terminal still has its option buttons')
      if (!(await page.locator('.chat-card-state', { hasText: '터미널에서 답해 주세요' }).count())) bad('the read-only question does not point to the terminal')
      if (!(await page.locator('.chat-card-optlist li').count())) bad('the read-only question does not list its options')
    } catch (err) { bad(String(err.message).split('\n')[0]) } finally { if (app) await app.ctx.close() }
    return problems
  },

  /** A plan: read-only, its first lines, 더 보기, and 터미널에서 답하기 flips */
  'chat-plan': async ({ browser }) => {
    const problems = []
    const bad = m => problems.push(m)
    let app
    try {
      app = await openApp(browser, { chat: 'chat-ask-plan' })
      const { page } = app
      await page.waitForSelector('.chat-answer .chat-card.plan', { timeout: 15_000 })
      for (const name of ['허용', '거부']) if (await askButton(page, name).count()) bad(`the plan card has ${name}`)
      if (await page.locator('.chat-card-opt').count()) bad('the plan card has answer buttons')
      const before = (await page.locator('.chat-card-plan').innerText()).includes('커밋은 하지 않아요')
      if (before) bad('the plan shows past its first lines before 더 보기')
      await page.locator('.chat-card-more').click()
      await sleep(150)
      if (!(await page.locator('.chat-card-plan').innerText()).includes('커밋은 하지 않아요')) bad('더 보기 does not show the rest')
      await page.locator('.chat-card button', { hasText: '터미널에서 답하기' }).click()
      await sleep(400)
      if (await page.locator('.chat').count()) bad('터미널에서 답하기 did not flip to the terminal')
    } catch (err) { bad(String(err.message).split('\n')[0]) } finally { if (app) await app.ctx.close() }
    return problems
  },

  /**
   * The card for the keyboard and the eye: in the DOM (and the Tab order) after the list and before the
   * composer; a group with its title; announced once; every button at least 22px; a card pushed during a
   * composition in the composer leaves the focus and the composition alone
   */
  'chat-ask-a11y': async ({ browser }) => {
    const problems = []
    const bad = m => problems.push(m)
    let app
    try {
      app = await openApp(browser, { chat: 'chat' })
      const { page } = app
      const id = await firstTerm(page)
      await page.waitForSelector(COMPOSER, { timeout: 15_000 })
      await sleep(300)
      const field = composerField(page)
      await field.click()
      await field.evaluate(el => el.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: '' })))
      await page.keyboard.insertText('하')
      await pushAsks(page, id, [chatFixture.ASKS.bash()])
      await sleep(300)
      const f = await page.evaluate(() => ({ inComposer: !!document.activeElement?.closest('.chat-composer'), value: document.querySelector('.chat-composer textarea.chat-input:not(.chat-input-twin)')?.value }))
      if (!f.inComposer || f.value !== '하') bad(`a card arriving mid-composition moved the focus or the text: ${JSON.stringify(f)}`)
      await field.evaluate(el => el.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '하' })))
      const order = await page.evaluate(() => {
        const list = document.querySelector('.chat-list')
        const card = document.querySelector('.chat-answer')
        const comp = document.querySelector('.chat-composer')
        return !!(list && card && comp && (list.compareDocumentPosition(card) & 4) && (card.compareDocumentPosition(comp) & 4) && !list.contains(card))
      })
      if (!order) bad('the card is not between the list and the composer in the page')
      const group = page.locator('.chat-answer [role="group"]')
      if ((await group.getAttribute('aria-label')) !== '이 명령을 실행해도 될까요?') bad('the card\'s group is not named by its title')
      const said = (await page.locator('.chat > .chat-sr[aria-live="assertive"]').innerText()).trim()
      if (!said.includes('허락을 기다려요') || !said.includes('이 명령을 실행해도 될까요?')) bad(`the card is not announced: ${JSON.stringify(said)}`)
      await pushAsks(page, id, [chatFixture.ASKS.bash()])
      if ((await page.locator('.chat > .chat-sr[aria-live="assertive"]').innerText()).trim() !== said) bad('the same card was announced again')
      // Shift+Tab from the composer's field goes back into the card (its last control)
      await field.click()
      await page.keyboard.press('Shift+Tab')
      if (!(await page.evaluate(() => !!document.activeElement?.closest('.chat-answer')))) bad(`Shift+Tab from the composer does not reach the card (${await page.evaluate(() => document.activeElement?.className)})`)
      for (const b of await page.locator('.chat-answer button').all()) {
        const r = await b.boundingBox()
        if (!r || r.height < 22 || r.width < 22) bad(`a card button under 22px: ${JSON.stringify(r)} ${await b.innerText()}`)
      }
    } catch (err) { bad(String(err.message).split('\n')[0]) } finally { if (app) await app.ctx.close() }
    return problems
  },

  // ---------------------------------------------------------------- the review of phase 4

  /** I1: a 300-line command — 허용 and 항상 허용 wait (and say why) until the box was scrolled to its end; 거부 never waits */
  'chat-ask-gate': async ({ browser }) => {
    const problems = []
    const bad = m => problems.push(m)
    let app
    try {
      app = await openApp(browser, { chat: 'chat-ask-long' })
      const { page } = app
      await page.waitForSelector('.chat-answer .chat-card-cmd', { timeout: 15_000 })
      await sleep(ARMED)
      const allow = askButton(page, '허용')
      const always = askButton(page, '항상 허용')
      if (!(await allow.isDisabled())) bad('허용 is live while the command\'s end is out of view')
      if (!(await always.isDisabled())) bad('항상 허용 is live while the command\'s end is out of view')
      if (await askButton(page, '거부').isDisabled()) bad('거부 waits for the scroll too')
      const hint = (await page.locator('.chat-card-hint').innerText()).trim()
      if (!hint.includes('끝까지 내려서 확인하면 허용할 수 있어요')) bad(`the disabled 허용 does not say why (${JSON.stringify(hint)})`)
      if (!(await page.locator('.chat-card-sub', { hasText: '길어요 · 끝까지 내려서 확인해 주세요' }).count())) bad('no 길어요 note under the long command')
      await allow.click({ force: true }).catch(() => {})
      await sleep(150)
      if ((await callsOf(page, 'chat.answer')).length) bad('a disabled 허용 answered')
      // halfway is not the end
      await page.locator('.chat-card-cmd').evaluate(el => { el.scrollTop = el.scrollHeight / 2 })
      await sleep(200)
      if (!(await allow.isDisabled())) bad('허용 came alive halfway down the command')
      await page.locator('.chat-card-cmd').evaluate(el => { el.scrollTop = el.scrollHeight })
      await sleep(200)
      if (await allow.isDisabled()) bad('허용 still waits after the command was scrolled to its end')
      if (await page.locator('.chat-card-sub', { hasText: '길어요' }).count()) bad('the 길어요 note stays once the end was seen')
      // scrolled back up: seen once is seen
      await page.locator('.chat-card-cmd').evaluate(el => { el.scrollTop = 0 })
      await sleep(150)
      if (await allow.isDisabled()) bad('scrolling back up took 허용 away again')
      await allow.click()
      await sleep(200)
      const a = await callsOf(page, 'chat.answer')
      if (a.length !== 1 || a[0].args[0].choice !== 'allow') bad(`허용 after the scroll: ${JSON.stringify(a.map(x => x.args[0]))}`)
      // a diff that scrolls holds 허용 the same way (its own 길어요 note)
      const id = await firstTerm(page)
      const many = { ...chatFixture.ASKS.edit(), key: 'hold0many', holdId: 'hold0many' }
      many.diff = { ...many.diff, added: 120, removed: 0, hunks: [{ oldStart: 1, newStart: 1, lines: Array.from({ length: 120 }, (_, i) => ({ t: '+', old: null, new: i + 1, text: `line ${i + 1}` })) }] }
      await pushAsks(page, id, [many])
      await sleep(ARMED)
      if (!(await askButton(page, '허용').isDisabled())) bad('허용 is live while the diff\'s end is out of view')
      if (!(await page.locator('.chat-card-sub', { hasText: '길어요 · 끝까지 내려서 확인해 주세요' }).count())) bad('no 길어요 note under the long diff')
      await page.locator('.chat-card-lines').evaluate(el => { el.scrollTop = el.scrollHeight })
      await sleep(200)
      if (await askButton(page, '허용').isDisabled()) bad('허용 still waits after the diff was scrolled to its end')
      // a short card is seen at once
      await pushAsks(page, id, [chatFixture.ASKS.bash()])
      await sleep(200)
      if (await askButton(page, '허용').isDisabled()) bad('a card that fits holds 허용 back')
    } catch (err) { bad(String(err.message).split('\n')[0]) } finally { if (app) await app.ctx.close() }
    return problems
  },

  /** I2: a press too soon after the card is painted, or after the window comes back, answers nothing; nor one begun on another card */
  'chat-ask-guard': async ({ browser }) => {
    const problems = []
    const bad = m => problems.push(m)
    let app
    try {
      app = await openApp(browser, { chat: 'chat' })
      const { page } = app
      const id = await firstTerm(page)
      await page.waitForSelector('.chat .chat-row', { timeout: 15_000 })
      await pushAsks(page, id, [chatFixture.ASKS.bash()])
      await askButton(page, '허용').waitFor({ timeout: 3000 })
      // 0.5 s after it appeared: inside the 800 ms
      await sleep(350)
      await askButton(page, '허용').click()
      await sleep(100)
      if ((await callsOf(page, 'chat.answer')).length) bad('a click 0.5 s after the card appeared answered it')
      await sleep(ARMED)
      // the window comes back (the click that brings it forward lands on 허용)
      await page.evaluate(() => window.dispatchEvent(new Event('focus')))
      await askButton(page, '허용').click()
      await sleep(100)
      if ((await callsOf(page, 'chat.answer')).length) bad('the click that brought the window back answered the card')
      await sleep(ARMED)
      // pressed on this card, let go after the next one took its place
      const box = await askButton(page, '허용').boundingBox()
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
      await page.mouse.down()
      await pushAsks(page, id, [{ ...chatFixture.ASKS.norule(), key: 'hold0next', holdId: 'hold0next' }])
      await sleep(ARMED)
      await page.mouse.up()
      await sleep(150)
      if ((await callsOf(page, 'chat.answer')).length) bad('a press begun on one card answered the next')
      await sleep(200)
      await askButton(page, '허용').click()
      await sleep(150)
      const a = await callsOf(page, 'chat.answer')
      if (a.length !== 1 || a[0].args[0].holdId !== 'hold0next') bad(`a deliberate click on the shown card: ${JSON.stringify(a.map(x => x.args[0]))}`)
    } catch (err) { bad(String(err.message).split('\n')[0]) } finally { if (app) await app.ctx.close() }
    return problems
  },

  /** C1, C2: the whole path wraps (its file name on the card); a diff line's far tail wraps into the box; nothing scrolls sideways */
  'chat-ask-wrap': async ({ browser }) => {
    const problems = []
    const bad = m => problems.push(m)
    let app
    try {
      for (const size of [[1100, 720], [1440, 900]]) {
        app = await openApp(browser, { chat: 'chat-ask-longpath', size })
        let page = app.page
        await page.waitForSelector('.chat-answer .chat-card-file', { timeout: 15_000 })
        const name = await page.evaluate(() => {
          const el = document.querySelector('.chat-card-file')
          const card = document.querySelector('.chat-answer .chat-card').getBoundingClientRect()
          const walk = document.createTreeWalker(el, NodeFilter.SHOW_TEXT)
          let hit = null
          for (let n = walk.nextNode(); n; n = walk.nextNode()) {
            const at = n.textContent.indexOf('redirect-guard.ts')
            if (at < 0) continue
            const r = document.createRange(); r.setStart(n, at); r.setEnd(n, at + 'redirect-guard.ts'.length)
            const b = r.getBoundingClientRect()
            hit = { inCard: b.left >= card.left && b.right <= card.right + 0.5 && b.width > 0, text: el.textContent.length, sw: el.scrollWidth, cw: el.clientWidth }
          }
          return hit
        })
        if (!name || !name.inCard) bad(`${size[0]}: the file name of a long path is not on the card (${JSON.stringify(name)})`)
        else if (name.sw > name.cw + 0.5) bad(`${size[0]}: the path scrolls sideways (${name.sw} > ${name.cw})`)
        await app.ctx.close()
        app = await openApp(browser, { chat: 'chat-ask-longline', size })
        page = app.page
        await page.waitForSelector('.chat-answer .chat-card-lines', { timeout: 15_000 })
        await page.locator('.chat-card-lines').evaluate(el => { el.scrollTop = el.scrollHeight })
        await sleep(150)
        const tail = await page.evaluate(() => {
          const box = document.querySelector('.chat-card-lines')
          const b = box.getBoundingClientRect()
          const walk = document.createTreeWalker(box, NodeFilter.SHOW_TEXT)
          let seen = null
          for (let n = walk.nextNode(); n; n = walk.nextNode()) {
            const at = n.textContent.indexOf('child_process')
            if (at < 0) continue
            const r = document.createRange(); r.setStart(n, at); r.setEnd(n, at + 13)
            const x = r.getBoundingClientRect()
            seen = x.width > 0 && x.left >= b.left && x.right <= b.right + 0.5
          }
          return { seen, sw: box.scrollWidth, cw: box.clientWidth }
        })
        if (!tail.seen) bad(`${size[0]}: the far tail of a long diff line is out of the box (${JSON.stringify(tail)})`)
        if (tail.sw > tail.cw + 0.5) bad(`${size[0]}: the diff box scrolls sideways (${tail.sw} > ${tail.cw})`)
        await app.ctx.close()
        app = null
      }
    } catch (err) { bad(String(err.message).split('\n')[0]) } finally { if (app) await app.ctx.close() }
    return problems
  },

  /** C3, C4, M2–M5, M13: each fact on a line of its own, the request's own text exact; an overwrite said as one */
  'chat-ask-facts': async ({ browser }) => {
    const problems = []
    const bad = m => problems.push(m)
    let app
    try {
      app = await openApp(browser, { chat: 'chat-ask-sandbox' })
      let page = app.page
      await page.waitForSelector('.chat-answer .chat-card-cmd', { timeout: 15_000 })
      const facts = await page.locator('.chat-card-fact').allInnerTexts()
      const has = (s) => facts.some(f => f.includes(s))
      for (const s of ['격리 환경(sandbox) 밖에서 실행해요', '백그라운드에서 실행해요', '시간 제한 120초', '실행 폴더: ', '의 설명: 설치 스크립트를 받아 실행해요']) if (!has(s)) bad(`no fact line "${s}" (${JSON.stringify(facts)})`)
      const warn = await page.locator('.chat-card-fact.warn').evaluate(el => ({ dot: !!el.querySelector('.chat-dot.amber'), bg: getComputedStyle(el).backgroundColor, text: el.textContent }))
      if (!warn.dot || !warn.text.includes('sandbox')) bad(`sandbox-off is not called out with the amber dot: ${JSON.stringify(warn)}`)
      if (!/rgba\(0, 0, 0, 0\)|transparent/.test(warn.bg)) bad(`sandbox-off is filled (${warn.bg})`)
      const cmd = await page.locator('.chat-card-cmd').innerText()
      if (!cmd.includes('[xn--pple-43d.com]')) bad(`the URL's non-ASCII host is not shown in punycode: ${JSON.stringify(cmd)}`)
      if (!cmd.includes('[U+202E]')) bad('a direction override in the command is not marked')
      const dir = await page.locator('.chat-card-cmd .chat-exact').evaluate(el => ({ d: getComputedStyle(el).direction, b: getComputedStyle(el).unicodeBidi }))
      if (dir.d !== 'ltr' || dir.b !== 'bidi-override') bad(`the command is not in logical order: ${JSON.stringify(dir)}`)
      await app.ctx.close()
      app = await openApp(browser, { chat: 'chat-ask-overwrite' })
      page = app.page
      await page.waitForSelector('.chat-answer .chat-card', { timeout: 15_000 })
      const title = (await page.locator('.chat-card-title').innerText()).trim()
      if (title !== '이 파일을 덮어써도 될까요?') bad(`a Write over a file is titled ${JSON.stringify(title)}`)
      if (await page.locator('.chat-answer .chat-diff-kind', { hasText: '새 파일' }).count()) bad('an overwrite says 새 파일')
      if (!(await page.locator('.chat-card-fact', { hasText: '기존 내용을 모두 바꿔요' }).count())) bad('an overwrite does not say it replaces the contents')
    } catch (err) { bad(String(err.message).split('\n')[0]) } finally { if (app) await app.ctx.close() }
    return problems
  },

  /** I3, the page's side: refused as hidden (the window was swapping) → the buttons stay, 다시 눌러 주세요; pressed again → answered */
  'chat-ask-retry': async ({ browser }) => {
    const problems = []
    const bad = m => problems.push(m)
    let app
    try {
      app = await openApp(browser, { chat: 'chat' })
      const { page } = app
      const id = await firstTerm(page)
      await page.waitForSelector('.chat .chat-row', { timeout: 15_000 })
      await chatScript(page, { answer: { ok: false, reason: 'hidden' } })
      await pushAsks(page, id, [chatFixture.ASKS.bash()])
      await sleep(ARMED)
      await askButton(page, '허용').click()
      await sleep(250)
      if (await page.locator('.chat-card-state', { hasText: '보내지 못했어요 · 터미널에서 답해 주세요' }).count()) bad('a refusal for "not shown" stuck the card on the terminal')
      if (!(await page.locator('.chat-card-hint', { hasText: '보내지 못했어요 · 다시 눌러 주세요' }).count())) bad('a refusal for "not shown" is not said')
      await chatScript(page, { answer: { ok: true } })
      await askButton(page, '허용').click()
      await sleep(250)
      if ((await callsOf(page, 'chat.answer')).length !== 2) bad('pressed again, the card did not answer')
    } catch (err) { bad(String(err.message).split('\n')[0]) } finally { if (app) await app.ctx.close() }
    return problems
  },

  /** M7, M8, M9: an open card is never hidden behind a read-only one; the composer's note follows the card; one live region */
  'chat-ask-order': async ({ browser }) => {
    const problems = []
    const bad = m => problems.push(m)
    let app
    try {
      app = await openApp(browser, { chat: 'chat' })
      const { page } = app
      const id = await firstTerm(page)
      await page.waitForSelector(COMPOSER, { timeout: 15_000 })
      const region = page.locator('.chat > .chat-sr[aria-live="assertive"]')
      if ((await region.count()) !== 1) bad('the chat has no live region before any card')
      await pushAsks(page, id, [chatFixture.ASKS.plan(), chatFixture.ASKS.bash()])
      if (!(await askButton(page, '허용').count())) bad('a plan card hides the open card behind it')
      if (!(await page.locator('.chat-answer-more', { hasText: '1건 더 기다려요' }).count())) bad('the plan is not counted as one more')
      const said = (await region.innerText()).trim()
      if (!said.includes('계획을 확인해 주세요') || !said.includes('이 명령을 실행해도 될까요?')) bad(`two cards at once are not both announced: ${JSON.stringify(said)}`)
      if ((await page.locator('[aria-live="assertive"]').count()) !== 1) bad('more than one live region')
      const note = async () => {
        await composerField(page).click()
        await composerField(page).fill('다음 할 일')
        await page.keyboard.press('Enter')
        await sleep(250)
        return { text: (await page.locator('.chat-cnote').innerText().catch(() => '')).trim(), terminal: await page.locator('.chat-cnote .chat-btn', { hasText: '터미널로 보기' }).count() }
      }
      let n = await note()
      if (!n.text.includes('위 카드에서 먼저 답해 주세요') || n.terminal) bad(`an open card: the note ${JSON.stringify(n)}`)
      await pushAsks(page, id, [chatFixture.ASKS.plan()])
      n = await note()
      if (!n.text.includes('터미널에서 먼저 답해 주세요') || !n.terminal) bad(`a read-only card: the note ${JSON.stringify(n)}`)
      await pushAsks(page, id, [{ ...chatFixture.ASKS.bash(), state: 'sent', sent: 'allow' }], 'working')
      n = await note()
      if (!n.text.includes('처리하는 중이에요') || !n.terminal) bad(`an answer sent: the note ${JSON.stringify(n)}`)
      if ((await callsOf(page, 'chat.send')).length) bad('a send went while a card waited')
    } catch (err) { bad(String(err.message).split('\n')[0]) } finally { if (app) await app.ctx.close() }
    return problems
  },

  /**
   * 7-48 (Task 5.2): the shown chat session's hidden terminal gets its real size. Shown as chat at load
   * and after a reload: fitted (not xterm's 80 columns), never focused, hidden again, no chat.redraw, and
   * the composer sends over the prompt row. A background session switched to in chat: one chat.redraw,
   * never a second. Its flip to 터미널: the same terminals.resize calls as a session switch. A page
   * hidden while its terminals mount (the swap's hidden window): one chat.redraw. Terminal mode: none.
   */
  'chat-reload-size': async ({ browser }) => {
    const problems = []
    const bad = m => problems.push(m)
    let app
    // From the page's first script, every frame: which terminal (its place in the list) held the focus
    const watchFocus = () => {
      window.__TERM_FOCUS__ = {}
      const look = () => {
        const a = document.activeElement
        const wrap = a && a.closest ? a.closest('.w-term-body .term-wrap') : null
        if (wrap) { const i = [...wrap.parentElement.children].filter(e => e.classList.contains('term-wrap')).indexOf(wrap); window.__TERM_FOCUS__[i] = (window.__TERM_FOCUS__[i] || 0) + 1 }
        requestAnimationFrame(look)
      }
      requestAnimationFrame(look)
    }
    // The page hidden (document.visibilityState) while its terminals mount, shown 500 ms after the first one is
    // in the page: the widget → window swap builds the new window hidden and shows it once painted
    const hiddenFirst = () => {
      let hidden = true
      Object.defineProperty(Document.prototype, 'visibilityState', { get: () => (hidden ? 'hidden' : 'visible'), configurable: true })
      Object.defineProperty(Document.prototype, 'hidden', { get: () => hidden, configurable: true })
      const poll = setInterval(() => {
        if (!document.querySelector('.w-term-body .term-wrap')) return
        clearInterval(poll)
        setTimeout(() => { hidden = false; document.dispatchEvent(new Event('visibilitychange')) }, 500)
      }, 20)
    }
    const redraws = async page => (await callsOf(page, 'chat.redraw')).map(c => c.args[0])
    const focusIn = page => page.evaluate(() => window.__TERM_FOCUS__)
    const shownWraps = page => page.evaluate(() => [...document.querySelectorAll('.w-term-body .term-wrap')].filter(w => w.style.display !== 'none').length)
    const paneBg = page => page.evaluate(() => { const p = document.querySelector('.w-chat-pane'); return p ? getComputedStyle(p).backgroundColor : null })
    const opaque = bg => !!bg && bg !== 'transparent' && !/rgba\(.*,\s*0\)$/.test(bg)
    const waitRedraw = page => page.waitForFunction(() => window.__CALLS__.some(c => c.fn === 'chat.redraw'), null, { timeout: 5000 }).catch(() => {})
    /** The composer sends over the terminal's prompt row as read now: chat.send with screen 'empty', not refused */
    const sendsOnce = async (page, id, label) => {
      await page.waitForSelector(COMPOSER, { timeout: 15_000 })
      const before = (await callsOf(page, 'chat.send')).length
      await screenTo(page, id, 'idle-empty')
      await composerField(page).click()
      await page.keyboard.type('hello')
      await page.keyboard.press('Enter')
      await sleep(400)
      const sends = (await callsOf(page, 'chat.send')).slice(before)
      if (sends.length !== 1 || sends[0].args[0].screen !== 'empty') bad(`${label}: the composer did not send over the prompt row (${sends.length} chat.send; note: ${(await page.locator('.chat-cnote').innerText().catch(() => '')).trim() || 'none'})`)
    }
    /** Shown as chat: fitted, hidden again, the pane opaque, never focused, sends */
    const settledInChat = async (page, id, label) => {
      const info = await termInfo(page, id)
      if (!info) bad(`${label}: no reading of the terminal`)
      else if (info.cols === 80) bad(`${label}: the terminal kept xterm's 80 columns`)
      else console.log(`      ${label}: the terminal is ${info.cols}x${info.rows}`)
      if (await shownWraps(page)) bad(`${label}: a terminal is still active under the chat`)
      if (!opaque(await paneBg(page))) bad(`${label}: the chat pane is not opaque (${await paneBg(page)})`)
      const f = await focusIn(page)
      if (Object.keys(f).length) bad(`${label}: the focus was in a terminal (${JSON.stringify(f)})`)
      await sendsOnce(page, id, label)
    }
    try {
      // 1. Session 1 in chat from the start: warm, fitted first: no redraw
      app = await openApp(browser, { chat: 'chat', smoke: true, init: watchFocus })
      let { page, shot } = app
      const T = shot.terminals.map(t => t.id)
      await page.waitForSelector(COMPOSER, { timeout: 15_000 })
      await sleep(1000)
      await settledInChat(page, T[0], 'at load')
      if ((await redraws(page)).length) bad(`at load: chat.redraw ${JSON.stringify(await redraws(page))} for a terminal fitted first`)

      // 2. A reload: the same
      await page.evaluate(() => sessionStorage.setItem('harness-keep-storage', '1'))
      await page.reload()
      await page.waitForSelector('.w-sess-head', { timeout: 15_000 })
      await page.waitForSelector(COMPOSER, { timeout: 15_000 })
      await sleep(1000)
      await settledInChat(page, T[0], 'after a reload')
      if ((await redraws(page)).length) bad(`after a reload: chat.redraw ${JSON.stringify(await redraws(page))}`)
      await app.ctx.close()
      app = null

      // 3. Session 1 in its terminal, session 2 (chat) mounted hidden in the background, then switched to
      const S = fixture.terminals.map(t => t.sessionId)
      app = await openApp(browser, { chat: 'chat', smoke: true, init: watchFocus, local: { 'spawn-carry': JSON.stringify({ view: 'terminal', target: S[0], chatModes: { [S[1]]: 'chat' } }) } })
      ;({ page, shot } = app)
      const rows = page.locator('.w-party .w-row')
      const lens = name => page.locator('.w-lens button', { hasText: name })
      await page.waitForSelector('.w-term-body .xterm', { timeout: 15_000 })
      await sleep(800)
      if ((await redraws(page)).length) bad('a chat.redraw before any chat was shown')
      // (session 1's terminal had the focus, as in 1.4.0: from here on, any focus in a terminal is the warm one's)
      const unfocus = () => page.evaluate(() => { document.activeElement?.blur?.(); window.__TERM_FOCUS__ = {} })
      await unfocus()
      await rows.nth(1).locator('.w-row-name').click()
      await page.waitForSelector('.w-chat-pane', { timeout: 10_000 })
      if (!opaque(await paneBg(page))) bad(`session 2 in chat, loading: the chat pane is not opaque (${await paneBg(page)})`)
      await waitRedraw(page)
      await sleep(400)
      let r = await redraws(page)
      if (JSON.stringify(r) !== JSON.stringify([T[1]])) bad(`session 2 (replayed first) in chat: chat.redraw ${JSON.stringify(r)}, not once for it`)
      const info2 = await termInfo(page, T[1])
      if (!info2 || info2.cols === 80) bad(`session 2: the terminal is not fitted (${JSON.stringify(info2 && [info2.cols, info2.rows])})`)
      if (await shownWraps(page)) bad('session 2: a terminal is still active under the chat')
      if (Object.keys(await focusIn(page)).length) bad(`session 2: the focus was in a terminal (${JSON.stringify(await focusIn(page))})`)
      await rows.nth(0).locator('.w-row-name').click()
      await sleep(500)
      await unfocus()
      await rows.nth(1).locator('.w-row-name').click()
      await sleep(1000)
      r = await redraws(page)
      if (r.length !== 1) bad(`the next switch to session 2: chat.redraw ${JSON.stringify(r)} (a second one)`)
      if (Object.keys(await focusIn(page)).length) bad(`session 2 again: the focus was in a terminal (${JSON.stringify(await focusIn(page))})`)

      // 4. Its flip to 터미널: the resizes 1.4.0 makes when a session switch first shows a terminal mounted in the
      // background (session 3, never shown: in 1.4.0 session 2's terminal would never have been shown either)
      let mark = (await calls(page)).length
      await lens('터미널').click()
      await sleep(700)
      const flip = (await calls(page)).slice(mark).filter(c => c.fn === 'resize')
      mark = (await calls(page)).length
      await rows.nth(2).locator('.w-row-name').click()
      await sleep(700)
      const sw = (await calls(page)).slice(mark).filter(c => c.fn === 'resize')
      const shape = list => list.map(c => c.args.slice(1).join('x'))
      if (!flip.every(c => c.args[0] === T[1]) || !sw.every(c => c.args[0] === T[2])) bad(`resizes for another terminal: flip ${JSON.stringify(flip)}, switch ${JSON.stringify(sw)}`)
      if (!flip.length || JSON.stringify(shape(flip)) !== JSON.stringify(shape(sw))) bad(`the flip to 터미널 resized ${JSON.stringify(shape(flip))}, a session switch ${JSON.stringify(shape(sw))}`)
      else console.log(`      flip to 터미널: resize ${shape(flip).join(', ')} (a first switch to a background session: ${shape(sw).join(', ')})`)
      // (and a terminal shown before, shown again: once, for the record)
      mark = (await calls(page)).length
      await rows.nth(0).locator('.w-row-name').click()
      await sleep(700)
      console.log(`      a switch back to session 1 (shown before): resize ${shape((await calls(page)).slice(mark).filter(c => c.fn === 'resize')).join(', ')}`)
      if (info2 && flip.length && shape(flip)[0] !== `${info2.cols}x${info2.rows}`) bad(`the flip changed the size the warm fit gave (${info2.cols}x${info2.rows} → ${shape(flip)[0]})`)
      if ((await redraws(page)).length !== 1) bad(`after the flip: chat.redraw ${JSON.stringify(await redraws(page))}`)
      await app.ctx.close()
      app = null

      // 5. The page hidden while its terminals mount (the swap's window): session 1 in chat replayed first → one redraw
      app = await openApp(browser, { chat: 'chat', smoke: true, init: [watchFocus, hiddenFirst] })
      ;({ page, shot } = app)
      await waitRedraw(page)
      await page.waitForSelector(COMPOSER, { timeout: 15_000 })
      await sleep(600)
      r = await redraws(page)
      if (JSON.stringify(r) !== JSON.stringify([T[0]])) bad(`hidden at mount: chat.redraw ${JSON.stringify(r)}, not once for session 1`)
      await settledInChat(page, T[0], 'hidden at mount')
      await app.ctx.close()
      app = null

      // 6. Terminal mode only (hidden at mount too, switches, a reload): never a chat.redraw; resizes only for shown terminals
      app = await openApp(browser, { chat: 'chat', chatMode: false, smoke: true, init: hiddenFirst })
      ;({ page, shot } = app)
      const rows6 = page.locator('.w-party .w-row')
      await page.waitForSelector('.w-term-body .xterm', { timeout: 15_000 })
      await sleep(1200)
      for (const i of [1, 2, 0]) { await rows6.nth(i).locator('.w-row-name').click(); await sleep(500) }
      let resizes = (await callsOf(page, 'resize')).map(c => c.args[0])
      await page.evaluate(() => sessionStorage.setItem('harness-keep-storage', '1'))
      const before = await redraws(page)
      await page.reload()
      await page.waitForSelector('.w-term-body .xterm', { timeout: 15_000 })
      await sleep(1200)
      for (const i of [1, 0]) { await rows6.nth(i).locator('.w-row-name').click(); await sleep(500) }
      resizes = resizes.concat((await callsOf(page, 'resize')).map(c => c.args[0]))
      const after = await redraws(page)
      if (before.length || after.length) bad(`terminal mode: chat.redraw ${JSON.stringify([...before, ...after])}`)
      if (resizes.some(id => id === T[3] || id === T[4])) bad(`terminal mode: a terminal never shown was resized (${JSON.stringify([...new Set(resizes)])})`)
      if (!resizes.length) bad('terminal mode: no resize at all')
    } catch (err) { bad(String(err.message).split('\n')[0]) } finally { if (app) await app.ctx.close() }
    return problems
  },

  /**
   * Density (phase 5): 보기 정도 in the header by keyboard (↓ opens on the checked level, ↓ ↑ Home End wrap, Esc and
   * Tab close with the focus back, Enter picks), the choice remembered across a reload, the chosen level on the
   * quiet grey; 생각 포함 shows the thinking rows; 전부 opens rows without reopening one the user closed; over
   * chat-long each switch keeps the rows in view where they were (within 2px), settled within 300 ms, ≤ 300 rows in
   * the page; chat-waiting's waiting row stays a row of its own in each level.
   */
  'chat-density': async ({ browser }) => {
    const problems = []
    const bad = m => problems.push(m)
    let app
    const active = page => page.evaluate(() => {
      const a = document.activeElement
      return a ? { cls: typeof a.className === 'string' ? a.className : '', role: a.getAttribute('role'), text: (a.textContent || '').trim(), body: a === document.body } : null
    })
    const pick = async (page, name) => {
      await page.locator('.w-dens').click()
      await page.waitForSelector('.w-dens-menu', { timeout: 3000 })
      await page.locator('.w-dens-item', { has: page.locator('.w-dens-item-name', { hasText: new RegExp(`^${name}$`) }) }).click()
      await sleep(250)
    }
    try {
      app = await openApp(browser, { chat: 'chat-thinking' })
      const { page } = app
      await page.waitForSelector('.chat .chat-row', { timeout: 15_000 })
      await page.waitForSelector('.w-chat-tools .w-dens', { timeout: 10_000 })
      const btn = page.locator('.w-dens')
      if (await btn.getAttribute('aria-haspopup') !== 'menu') bad('보기 정도 has no aria-haspopup="menu"')
      if (await btn.getAttribute('aria-expanded') !== 'false') bad('보기 정도 is expanded before it was opened')
      if (await btn.getAttribute('aria-label') !== '보기 정도: 기본') bad(`보기 정도's name: ${await btn.getAttribute('aria-label')}`)
      const box = await btn.boundingBox()
      if (!box || box.width < 22 || box.height < 22) bad(`보기 정도 is smaller than 22px (${JSON.stringify(box)})`)
      if (await page.locator('.w-chat-tools').evaluate(el => getComputedStyle(el).getPropertyValue('-webkit-app-region')).catch(() => '') === 'drag') bad('the chat tools are a window drag region')
      if (await page.locator('.chat-think').count()) bad('기본 shows thinking rows')
      // the order in the header: 보기 정도, 변경 사항, then the 채팅 · 터미널 pair
      const order = await page.evaluate(() => [...document.querySelectorAll('.w-sess-head .w-dens, .w-sess-head .w-chg, .w-sess-head .w-lens')].map(e => e.className.split(' ')[0]))
      if (order.join(',') !== 'w-dens,w-chg,w-lens') bad(`the header's order: ${order}`)
      // ↓ opens on the checked level
      await btn.focus()
      await page.keyboard.press('ArrowDown')
      await page.waitForSelector('.w-dens-menu[role="menu"]', { timeout: 3000 }).catch(() => bad('↓ on 보기 정도 did not open the menu'))
      if (await btn.getAttribute('aria-expanded') !== 'true') bad('open, 보기 정도 is not aria-expanded')
      const items = await page.evaluate(() => [...document.querySelectorAll('.w-dens-menu [role="menuitemradio"]')].map(e => ({ name: e.querySelector('.w-dens-item-name')?.textContent, checked: e.getAttribute('aria-checked') })))
      if (JSON.stringify(items) !== JSON.stringify([{ name: '기본', checked: 'true' }, { name: '생각 포함', checked: 'false' }, { name: '전부', checked: 'false' }])) bad(`the menu's items: ${JSON.stringify(items)}`)
      const at = async () => (await active(page))?.text ?? ''
      if (!(await at()).startsWith('기본')) bad(`opened, the focus is on ${JSON.stringify(await at())}, not the checked level`)
      const steps = [['ArrowDown', '생각 포함'], ['ArrowUp', '기본'], ['End', '전부'], ['Home', '기본'], ['ArrowUp', '전부'], ['ArrowDown', '기본']]
      for (const [key, want] of steps) {
        await page.keyboard.press(key)
        if (!(await at()).startsWith(want)) bad(`${key} in the menu went to ${JSON.stringify(await at())}, not ${want}`)
      }
      // the chosen level on the quiet selection grey, never the accent
      const colours = await page.evaluate(() => {
        const probe = v => { const d = document.createElement('div'); d.style.background = `var(${v})`; document.body.appendChild(d); const c = getComputedStyle(d).backgroundColor; d.remove(); return c }
        return { on: getComputedStyle(document.querySelector('.w-dens-item.on')).backgroundColor, sel: probe('--sel-bg'), accent: probe('--accent') }
      })
      if (colours.on !== colours.sel || colours.on === colours.accent) bad(`the chosen level's background ${colours.on} (sel ${colours.sel}, accent ${colours.accent})`)
      // Esc closes, the focus back on the button
      await page.keyboard.press('Escape')
      await sleep(100)
      if (await page.locator('.w-dens-menu').count()) bad('Esc did not close the menu')
      if (!/\bw-dens\b/.test((await active(page))?.cls ?? '')) bad(`after Esc the focus is on ${JSON.stringify(await active(page))}`)
      // Enter opens (a click), Tab closes and goes on from the button
      await page.keyboard.press('Enter')
      await page.waitForSelector('.w-dens-menu', { timeout: 3000 }).catch(() => bad('Enter on 보기 정도 did not open the menu'))
      await page.keyboard.press('Tab')
      await sleep(100)
      if (await page.locator('.w-dens-menu').count()) bad('Tab did not close the menu')
      const afterTab = await active(page)
      if (!afterTab || afterTab.body || /w-dens-item/.test(afterTab.cls)) bad(`after Tab the focus is on ${JSON.stringify(afterTab)}`)
      // ↓ ↓ Enter: 생각 포함, the focus back, remembered as one word
      await btn.focus()
      await page.keyboard.press('ArrowDown')
      await page.waitForSelector('.w-dens-menu', { timeout: 3000 })
      await page.keyboard.press('ArrowDown')
      await page.keyboard.press('Enter')
      await sleep(250)
      if (await page.locator('.w-dens-menu').count()) bad('Enter on a level did not close the menu')
      if (!/\bw-dens\b/.test((await active(page))?.cls ?? '')) bad(`after picking, the focus is on ${JSON.stringify(await active(page))}`)
      if (await btn.getAttribute('aria-label') !== '보기 정도: 생각 포함') bad(`after picking 생각 포함 the button says ${await btn.getAttribute('aria-label')}`)
      if (await page.evaluate(() => localStorage.getItem('spawn-chat-density')) !== 'thinking') bad('생각 포함 was not remembered as "thinking"')
      if (await page.locator('.chat-think').count() < 1) bad('생각 포함 shows no thinking row')
      if (!(await page.locator('.chat-think', { hasText: '생각한 내용은 기록에 남지 않았어요' }).count())) bad('an empty thinking row does not say it is not in the record')
      if (!(await page.locator('.chat-think-head', { hasText: /^생각 · 6초$/ }).count())) bad('the lab turn\'s thinking row does not read 생각 · 6초')
      // remembered across a reload
      await page.evaluate(() => sessionStorage.setItem('harness-keep-storage', '1'))
      await page.reload()
      await page.waitForSelector('.chat .chat-think', { timeout: 15_000 }).catch(() => bad('after a reload 생각 포함 is not kept'))
      await page.waitForSelector('.w-dens', { timeout: 10_000 })
      if (await page.locator('.w-dens').getAttribute('aria-label') !== '보기 정도: 생각 포함') bad('after a reload the button does not say 생각 포함')
      // 전부: the read group opens; one the user closes stays closed through 기본 and back
      await pick(page, '전부')
      if (!(await page.locator('.chat-group.open').count())) bad('전부 did not open the read group')
      await page.locator('.chat-group > .chat-tool-head .chat-tool-toggle').first().click()
      await sleep(150)
      if (await page.locator('.chat-group.open').count()) bad('the group did not close on a click in 전부')
      await pick(page, '기본')
      await pick(page, '전부')
      if (await page.locator('.chat-group.open').count()) bad('전부 opened again a group the user closed')
      if (await page.locator('.chat-think').count() < 1) bad('전부 shows no thinking rows')
      await app.ctx.close()
      app = null

      // chat-long: each switch keeps the rows in view where they were, settled within 300 ms, ≤ 300 rows in the page
      app = await openApp(browser, { chat: 'chat-long' })
      const p2 = app.page
      await p2.waitForSelector('.chat .chat-row', { timeout: 15_000 })
      await p2.waitForSelector('.w-dens', { timeout: 10_000 })
      await sleep(400)
      await p2.evaluate(() => { const el = document.querySelector('.chat-scroll'); el.scrollTop = Math.round(el.scrollHeight / 2) })
      await sleep(400)
      for (const [name, word] of [['전부', 'all'], ['생각 포함', 'thinking'], ['기본', 'default'], ['전부', 'all']]) {
        await p2.locator('.w-dens').click()
        await p2.waitForSelector('.w-dens-menu', { timeout: 3000 })
        const r = await p2.evaluate(async ([label]) => {
          const el = document.querySelector('.chat-scroll')
          const top = () => el.getBoundingClientRect().top
          // the rows in view (a thinking row, or a head keyed by one, may go: then the next one kept is the one to hold)
          const keys = [...el.querySelectorAll('.chat-row')].filter(x => x.getBoundingClientRect().bottom > top() + 1).slice(0, 6).map(x => ({ key: x.dataset.key, y: x.getBoundingClientRect().top - top() }))
          const item = [...document.querySelectorAll('.w-dens-item')].find(x => x.querySelector('.w-dens-item-name')?.textContent === label)
          const frame = () => new Promise(res => requestAnimationFrame(() => res()))
          const where = k => { const row = el.querySelector(`.chat-row[data-key="${CSS.escape(k)}"]`); return row ? row.getBoundingClientRect().top - top() : null }
          const t0 = performance.now()
          item.click()
          let settled = null
          let last = null
          let still = 0
          while (performance.now() - t0 < 1500) {
            await frame()
            const hold = keys.find(k => where(k.key) !== null)
            const y = hold ? where(hold.key) : null
            const sig = `${y === null ? 'x' : Math.round(y)}:${el.querySelectorAll('.chat-row').length}:${Math.round(el.scrollTop)}`
            if (sig === last) {
              still++
              if (still >= 3) break
            } else { still = 0; settled = performance.now() - t0 }
            last = sig
          }
          if (still < 3) settled = null
          await new Promise(res => setTimeout(res, 600))
          const hold = keys.find(k => where(k.key) !== null)
          return { first: keys[0]?.key, hold: hold ? { key: hold.key, before: hold.y, after: where(hold.key) } : null, settled, rows: el.querySelectorAll('.chat-row').length, open: el.querySelectorAll('.chat-tool.open, .chat-group.open').length, think: el.querySelectorAll('.chat-think').length }
        }, [name])
        const stored = await p2.evaluate(() => localStorage.getItem('spawn-chat-density'))
        if (stored !== word) bad(`chat-long ${name}: remembered ${stored}`)
        if (!r.hold) bad(`chat-long ${name}: none of the rows in view before the switch is mounted after it`)
        else if (Math.abs(r.hold.after - r.hold.before) > 2) bad(`chat-long ${name}: the row in view moved ${Math.round((r.hold.after - r.hold.before) * 10) / 10}px (${r.hold.key})`)
        if (r.settled === null || r.settled > 300) bad(`chat-long ${name}: settled after ${r.settled === null ? 'more than 1500' : Math.round(r.settled)} ms`)
        if (r.rows > 300) bad(`chat-long ${name}: ${r.rows} .chat-row in the page`)
        if (word === 'all' && !r.open) bad('chat-long 전부: nothing opened in view')
        if (word === 'thinking' && !r.think) bad('chat-long 생각 포함: no thinking row in view')
        if (word === 'default' && r.think) bad('chat-long 기본: thinking rows still there')
        console.log(`      chat-long → ${name}: settled ${r.settled === null ? '—' : Math.round(r.settled)} ms, ${r.rows} rows, held ${r.hold?.key === r.first ? 'the first row' : `a later row (${r.hold?.key})`} ${r.hold ? Math.round((r.hold.after - r.hold.before) * 10) / 10 : '?'}px`)
      }
      await app.ctx.close()
      app = null

      // chat-waiting: the waiting row stays a row of its own in each level
      app = await openApp(browser, { chat: 'chat-waiting' })
      const p3 = app.page
      await p3.waitForSelector('.chat .chat-tool.wait', { timeout: 15_000 })
      await p3.waitForSelector('.w-dens', { timeout: 10_000 })
      for (const name of ['기본', '생각 포함', '전부']) {
        if (name !== '기본') await pick(p3, name)
        const w = await p3.evaluate(() => {
          const t = document.querySelector('.chat-tool.wait')
          return t ? { row: t.closest('.chat-row')?.className ?? '', inGroup: !!t.closest('.chat-group') } : null
        })
        if (!w) bad(`${name}: the waiting row is gone`)
        else if (!/\bk-tool\b/.test(w.row) || w.inGroup) bad(`${name}: the waiting row is not a row of its own (${JSON.stringify(w)})`)
      }
    } catch (err) {
      bad(String(err.message).split('\n')[0])
    } finally {
      if (app) await app.ctx.close()
    }
    return problems
  },

  /**
   * The turn summary (phase 5): a foot per finished turn (its time, 도구 n회, 파일 n개 바꿈) whose 복사 writes the turn's
   * answer and takes over its rows' own; a turn with no foot keeps its row's. No GET /pokedex at load (the feet there
   * are history); a turn that ends live while the chat is watched: the start read when the session goes to work, the
   * end read 1.5 s after its end, 8걸음 then and not before; a second turn with no new start: no steps, no read; a
   * reload: the same feet, no steps, no read. 업무 모드: no read at all, no steps. The reads carry no cookie or token.
   */
  'chat-foot': async ({ browser }) => {
    const problems = []
    const bad = m => problems.push(m)
    const run = async (label, setup, steps) => {
      let app
      try {
        app = await openApp(browser, setup)
        await steps(app, m => bad(`${label}: ${m}`))
      } catch (err) {
        bad(`${label}: ${String(err.message).split('\n')[0]}`)
      } finally {
        if (app) await app.ctx.close()
      }
    }
    // what a flow pushed, kept across a reload: the fake bridge's next chat.open answers with it after the fixture's
    const keepPushed = () => {
      try {
        const x = sessionStorage.getItem('foot-flow-extra')
        if (!x) return
        const s = window.__SHOT__
        const u = s.chat[s.terminals[0].id]
        u.ops[0].items = u.ops[0].items.concat(JSON.parse(x))
      } catch { /* nothing kept */ }
    }
    const flat = s => s.replace(/\s+/g, ' ').trim()
    const footOf = (page, id) => page.locator(`.chat-row[data-key="foot:${id}"] .chat-foot`)

    await run('watched', { chat: 'chat-foot', init: keepPushed }, async ({ page, shot }, no) => {
      const dex = await routeDex(page)
      const t1 = shot.terminals[0].id
      const items = shot.chat[t1].ops[0].items
      await page.waitForSelector('.chat .chat-foot', { timeout: 15_000 })
      await sleep(2000)
      if (dex.n) no(`GET /pokedex read ${dex.n} time(s) at load (no turn was watched)`)
      if (await page.locator('.chat-steps').count()) no('a step count at load')
      // the lab turn: its foot says its time and its five calls (it changed no file), and its answer has no copy of its own
      const ends = items.filter(i => i.kind === 'turn-end')
      const lab = ends[ends.length - 1]
      const answer = items.filter(i => i.kind === 'text').pop()
      const labFoot = footOf(page, lab.id)
      if (!(await labFoot.count())) no('no foot after the lab turn')
      else {
        const text = flat(await labFoot.innerText())
        if (!text.startsWith('1분 48초') || !text.includes('도구 5회') || text.includes('바꿈') || !text.includes('복사')) no(`the lab turn's foot says ${JSON.stringify(text)}`)
      }
      if (await page.locator(`.chat-row[data-key="${answer.id}"] .chat-text-acts`).count()) no('the lab answer kept its own copy under a foot')
      // its 복사 writes the turn's answer
      await page.evaluate(() => { Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (s) => { window.__COPIED__ = s } } }) })
      await labFoot.locator('.chat-copy').click()
      await sleep(200)
      if (await page.evaluate(() => window.__COPIED__) !== answer.text) no('the foot\'s 복사 did not write the turn\'s answer')
      if (await labFoot.locator('.chat-copy').getAttribute('aria-label') !== '답 복사') no('the foot\'s copy is not named 답 복사')
      const box = await labFoot.locator('.chat-copy').boundingBox()
      if (!box || box.width < 22 || box.height < 22) no(`the foot's 복사 is smaller than 22px (${JSON.stringify(box)})`)

      // a turn that ends live while watched
      const live = await footTurn(page)
      await sleep(1000)
      if (await page.locator('.chat-steps').count()) no('steps before the end read (1.5 s after the turn end)')
      if (dex.n !== 1) no(`${dex.n} read(s) by 1 s after the turn end (want the start read only)`)
      await sleep(1500)
      const liveFoot = footOf(page, live.end.id)
      const steps = liveFoot.locator('.chat-steps')
      if (!(await steps.count())) no('no step count 2.5 s after the turn end')
      else {
        if (flat(await steps.innerText()) !== '8걸음') no(`the step count says ${JSON.stringify(await steps.innerText())}`)
        if (!/걸은 걸음$/.test(await steps.getAttribute('title') ?? '')) no(`the step count's title: ${await steps.getAttribute('title')}`)
        if (!(await steps.locator('svg').count())) no('no paw glyph')
      }
      if (dex.n !== 2) no(`${dex.n} reads for one watched turn (want 2)`)
      const liveText = flat(await liveFoot.innerText().catch(() => ''))
      if (!liveText.startsWith('1분 0초') || !liveText.includes('도구 3회') || !liveText.includes('파일 1개 바꿈')) no(`the live turn's foot says ${JSON.stringify(liveText)}`)
      for (const [i, url] of dex.urls.entries()) {
        if (!/^http:\/\/127\.0\.0\.1:\d+\/pokedex$/.test(url)) no(`a read went to ${url}`)
        const h = dex.headers[i]
        for (const k of ['cookie', 'authorization', 'x-spawn-token']) if (h[k] !== undefined) no(`a read carried ${k}`)
      }

      // a second turn under no new start (as a queued prompt's): its foot, no steps, no read
      const top = Math.max(...live.items.map(i => i.order))
      const queued = [
        { id: 'foot-q-text', order: top + 10, at: fixture.NOW - 1000, kind: 'text', text: '나일강이 가장 길어요.' },
        { id: 'foot-q-end', order: top + 20, at: fixture.NOW, kind: 'turn-end', durationMs: 2000 },
      ]
      await page.evaluate(([id, list]) => window.__CHAT_PUSH__(id, [{ op: 'upsert', items: list }]), [t1, queued])
      await sleep(2200)
      if (!(await footOf(page, 'foot-q-end').count())) no('no foot for the second turn')
      if (await footOf(page, 'foot-q-end').locator('.chat-steps').count()) no('steps for a turn with no start of its own')
      if (dex.n !== 2) no(`the second turn read GET /pokedex (${dex.n} reads)`)
      // a turn with no foot (still running, or stopped): its answer keeps its own copy
      const open = { id: 'foot-open-text', order: top + 30, at: fixture.NOW, kind: 'text', text: '아직 끝나지 않은 답이에요.' }
      await page.evaluate(([id, it]) => window.__CHAT_PUSH__(id, [{ op: 'upsert', items: [it] }]), [t1, open])
      await sleep(500)
      if (!(await page.locator('.chat-row[data-key="foot-open-text"] .chat-text-acts .chat-copy').count())) no('a turn with no foot lost its answer\'s copy')

      // a reload: the same turns as history — their feet, no steps, no read
      await page.evaluate(x => sessionStorage.setItem('foot-flow-extra', x), JSON.stringify([...live.items, ...queued, open]))
      await page.reload()
      await page.waitForSelector('.chat .chat-foot', { timeout: 15_000 })
      await sleep(2500)
      if (await page.locator('.chat-steps').count()) no('steps for old turns after a reload')
      if (dex.n !== 2) no(`the reload read GET /pokedex (${dex.n} reads)`)
      if (!flat(await footOf(page, live.end.id).innerText().catch(() => '')).includes('도구 3회')) no('after the reload the live turn\'s foot is not there')
    })

    await run('업무 모드', { chat: 'chat-foot', work: true }, async ({ page }, no) => {
      const dex = await routeDex(page)
      await page.waitForSelector('.chat .chat-foot', { timeout: 15_000 })
      const live = await footTurn(page)
      await sleep(2600)
      if (dex.n) no(`GET /pokedex read ${dex.n} time(s) in 업무 모드`)
      if (await page.locator('.chat-steps').count()) no('a step count in 업무 모드')
      const text = flat(await footOf(page, live.end.id).innerText().catch(() => ''))
      if (!text.includes('도구 3회') || !text.includes('복사')) no(`the live turn's foot in 업무 모드 says ${JSON.stringify(text)}`)
    })
    return problems
  },

  /**
   * Wild Pokémon (phase 5, Task 5.7): the conversation's meetings come from the game's state the page already has (the
   * snapshot), each where it happened, none animating at load. A pokedex message with a new catch of the shown session
   * adds one row with `appear` (its picture's animation running; under reduced motion none); another session's catch
   * and a level-up add none. A reload shows them all, none with `appear`. 업무 모드: no .chat-wild, ever.
   */
  'chat-wild': async ({ browser }) => {
    const problems = []
    const bad = m => problems.push(m)
    const run = async (label, setup, steps) => {
      let app
      try {
        app = await openApp(browser, setup)
        await steps(app, m => bad(`${label}: ${m}`))
      } catch (err) {
        bad(`${label}: ${String(err.message).split('\n')[0]}`)
      } finally {
        if (app) await app.ctx.close()
      }
    }
    const wildRows = page => page.$$eval('.chat .chat-wild', els => els.map(e => {
      const row = e.closest('.chat-row')
      const sib = (el, dir) => { let s = el; do { s = dir < 0 ? s.previousElementSibling : s.nextElementSibling } while (s && !s.classList.contains('chat-row')); return s?.dataset.key ?? null }
      const mon = e.querySelector('.chat-wild-mon')
      return {
        key: row.dataset.key, prev: sib(row, -1), next: sib(row, 1), appear: e.classList.contains('appear'), role: e.getAttribute('role'),
        sr: e.querySelector('.chat-sr')?.textContent ?? '', text: e.textContent, anims: mon ? mon.getAnimations().length : -1,
        animName: mon ? getComputedStyle(mon).animationName : '',
      }
    }))
    const wildAnims = page => page.evaluate(() => document.getAnimations().filter(a => a.animationName === 'chat-wild-in' && a.playState === 'running').length)
    const ev = (o) => ({ shiny: false, place: '@wild|shop-web|forest||0', gender: 'female', nature: 4, pity: false, attendance: false, toProfessor: false, newSpecies: false, via: { tool: 'Read', label: 'Read(x)', prompt: '비밀 요청' }, ...o })

    await run('watched', { chat: 'chat-wild' }, async ({ page, shot, pushDex }, no) => {
      const sid = shot.terminals[0].sessionId
      await page.waitForSelector('.chat .chat-wild', { timeout: 15_000 })
      await page.evaluate(() => document.querySelector('.chat .chat-wild').closest('.chat-row').scrollIntoView({ block: 'center' }))
      await sleep(800)
      const first = await wildRows(page)
      const shape = first.map(r => r.key.replace(/^wild:(\w+):\d+:(\d+)$/, '$1:$2'))
      if (shape.join(' ') !== 'catch:19 flee:147 catch:133') no(`the rows at load: ${JSON.stringify(shape)} (want the Rattata, the Dratini, the shiny Eevee; not the other session's Pidgey or the level-up)`)
      if (first.some(r => r.appear)) no('a row there at load has appear')
      if (await wildAnims(page)) no('an animation ran for rows there at load')
      if (first.some(r => r.role !== 'note')) no('a row is not role="note"')
      const [rat, dratini, eevee] = first
      if (rat) {
        if (rat.sr !== '야생의 꼬렛이 나타났다, 잡았다 · Lv.6, 새로 등록') no(`the Rattata row reads ${JSON.stringify(rat.sr)}`)
        if (!/toolu_fixture86$/.test(rat.prev ?? '') || !/toolu_fixture87$/.test(rat.next ?? '')) no(`the Rattata row is not between the edit and the test run (${rat.prev} / ${rat.next})`)
      }
      if (dratini && (!dratini.sr.includes('희귀') || !dratini.sr.endsWith('놓쳤다'))) no(`the Dratini row reads ${JSON.stringify(dratini.sr)}`)
      if (eevee && !eevee.sr.includes('색이 다른')) no(`the Eevee row reads ${JSON.stringify(eevee.sr)}`)
      if (first.some(r => /요청|Edit\(|forest/.test(r.text))) no('a row shows the catch\'s request or place')

      // another session's catch and this session's level-up: no row
      pushDex([ev({ kind: 'catch', id: 16, name: '구구', tier: 'common', ball: 'great-ball', level: 5, sessionId: 'other-session', at: fixture.NOW - 30_000 })])
      pushDex([{ kind: 'levelup', id: 27, name: '모래두지', level: 19, sessionId: sid, uid: 'p1', at: fixture.NOW - 29_000 }])
      await sleep(800)
      if ((await wildRows(page)).length !== 3) no('another session\'s catch or a level-up made a row')

      // a catch of the shown session while watching: one more row, with appear, its picture moving
      const met = ev({ kind: 'catch', id: 16, name: '구구', tier: 'common', ball: 'great-ball', level: 8, newSpecies: false, sessionId: sid, at: fixture.NOW - 20_000 })
      pushDex([met])
      await page.waitForFunction(() => document.querySelectorAll('.chat .chat-wild').length === 4, null, { timeout: 5000 }).catch(() => {})
      const after = await wildRows(page)
      const fresh = after.filter(r => !first.some(f => f.key === r.key))
      if (fresh.length !== 1) no(`${fresh.length} new rows for one catch`)
      else {
        if (fresh[0].key !== `wild:catch:${met.at}:16`) no(`the new row's key: ${fresh[0].key}`)
        if (!fresh[0].appear) no('the row met while watching has no appear')
        if (fresh[0].anims < 1 || fresh[0].animName !== 'chat-wild-in') no(`the new row's picture does not animate (${fresh[0].anims}, ${fresh[0].animName})`)
        if (fresh[0].prev !== eevee?.key) no(`the new row is not after the last meeting (${fresh[0].prev})`)
      }
      if (after.filter(r => r.appear).length !== 1) no(`${after.filter(r => r.appear).length} rows with appear (want 1)`)
      // (the new row is not a new message: no "새 메시지" pill)
      if (await page.locator('.chat-jump:not(.wait)').count()) no('the meeting counted as a new message (새 메시지)')

      // under reduced motion: the class, no animation
      await page.emulateMedia({ reducedMotion: 'reduce' })
      const calm = ev({ kind: 'flee', id: 10, name: '캐터피', tier: 'common', ball: null, level: 3, sessionId: sid, at: fixture.NOW - 10_000 })
      pushDex([calm])
      await page.waitForFunction(() => document.querySelectorAll('.chat .chat-wild').length === 5, null, { timeout: 5000 }).catch(() => {})
      const still = (await wildRows(page)).find(r => r.key === `wild:flee:${calm.at}:10`)
      if (!still) no('no row for the catch under reduced motion')
      else if (!still.appear || still.anims !== 0 || still.animName !== 'none') no(`under reduced motion: appear ${still.appear}, ${still.anims} animations, ${still.animName}`)
      await page.emulateMedia({ reducedMotion: 'no-preference' })

      // a reload: every row, none with appear, nothing moving
      await page.reload()
      await page.waitForSelector('.chat .chat-wild', { timeout: 15_000 })
      await sleep(1200)
      const reloaded = await wildRows(page)
      if (reloaded.length !== 5) no(`${reloaded.length} rows after the reload (want 5)`)
      if (reloaded.some(r => r.appear)) no('a row has appear after the reload')
      if (await wildAnims(page)) no('an animation ran after the reload')
    })

    await run('업무 모드', { chat: 'chat-wild', work: true }, async ({ page, shot, pushDex }, no) => {
      await page.waitForSelector('.chat .chat-foot', { timeout: 15_000 })
      await sleep(800)
      if (await page.locator('.chat-wild').count()) no('a wild row in 업무 모드')
      pushDex([ev({ kind: 'catch', id: 16, name: '구구', tier: 'common', ball: 'great-ball', level: 8, sessionId: shot.terminals[0].sessionId, at: fixture.NOW - 5000 })])
      await sleep(1000)
      if (await page.locator('.chat-wild').count()) no('a wild row in 업무 모드 after a catch')
      if (await page.locator('.chat img[src*="/sprites/pokemon/"]').count()) no('a Pokémon picture in the chat in 업무 모드')
      const text = await page.locator('.chat').innerText()
      if (GAME.test(text)) no(`a game word in the chat in 업무 모드: ${text.match(GAME)[0]}`)
    })
    return problems
  },

  /**
   * Keyboard only, names, reduced motion (phase 6, Task 6.4), over chat-changes with the panel open (the header's
   * density and changes controls, diff chips, the foot's copy, the composer, the panel's edge, tree and buttons):
   * from a fresh load Tab walks every control in visual order (header → list → composer → panel), never to <body>
   * after the first stop and never into a hidden terminal; every stop has a name; Esc closes the density menu and
   * find with the focus back where it was; Ctrl+F opens find from a list control, the composer and the panel. A CDP
   * accessibility snapshot: every button, link, menu item, tree item, separator and field named, tree items with level
   * and selected. Reduced motion: no animation runs after a wild catch, the conversation scrolls 'auto'.
   */
  'chat-a11y-walk': async ({ browser }) => {
    const problems = []
    const bad = m => problems.push(m)
    let app
    try {
      app = await openApp(browser, { chat: 'chat-changes', size: [1440, 900], local: { 'spawn-changes-open': '1' } })
      const { page, shot, pushDex } = app
      await page.waitForSelector('.chat .chat-row', { timeout: 15_000 })
      await page.waitForSelector('.chat-changes [role="tree"]', { timeout: 10_000 })
      await sleep(600)
      await page.evaluate(() => { document.activeElement?.blur?.(); document.body.focus() })
      const here = () => page.evaluate(() => {
        const el = document.activeElement
        if (!el || el === document.body) return { body: true }
        const r = el.getBoundingClientRect()
        const name = (el.getAttribute('aria-label') || el.getAttribute('title') || el.textContent || el.getAttribute('placeholder') || '').trim().replace(/\s+/g, ' ').slice(0, 40)
        const zone = el.closest('.chat-changes') ? 'panel' : el.closest('.chat-composer') ? 'composer' : el.closest('.chat-answer') ? 'answer' : el.closest('.chat-scroll') ? 'list' : el.closest('.w-sess-head') ? 'header' : el.closest('.w-side, .w-rail') ? 'side' : 'top'
        return { body: false, tag: el.tagName.toLowerCase(), cls: String(el.className).slice(0, 40), name, zone, inTerm: !!el.closest('.term-view'), w: Math.round(r.width), h: Math.round(r.height) }
      })
      const stops = []
      for (let k = 0; k < 160; k++) {
        await page.keyboard.press('Tab')
        const h = await here()
        stops.push(h)
        // (past the last control the focus leaves the page for a moment, as at the end of any page: the cycle is done)
        if (h.body && stops.some(s => s.zone === 'panel')) { stops.pop(); break }
      }
      const seenZones = []
      for (const st of stops) if (!st.body && seenZones.at(-1) !== st.zone) seenZones.push(st.zone)
      console.log(`      Tab walk: ${stops.length} stops, zones in order: ${seenZones.join(' → ')}`)
      if (stops.slice(1).some(st => st.body)) bad(`the focus fell to <body> at stop ${stops.findIndex((st, i) => i > 0 && st.body) + 1}`)
      if (stops.some(st => st.inTerm)) bad('the focus went into a hidden terminal')
      for (const st of stops) if (!st.body && !st.name) bad(`a stop without a name: ${st.tag}.${st.cls}`)
      const order = ['header', 'list', 'composer', 'panel']
      const firstAt = order.map(z => stops.findIndex(st => st.zone === z))
      if (firstAt.some(i => i < 0)) bad(`the walk missed a part: ${order.filter((z, i) => firstAt[i] < 0).join(', ')}`)
      else if (!firstAt.every((v, i) => i === 0 || v > firstAt[i - 1])) bad(`not in visual order: ${order.map((z, i) => `${z}@${firstAt[i]}`).join(' ')}`)
      for (const st of stops) if (!st.body && ['header', 'list', 'composer', 'panel'].includes(st.zone) && (st.w < 22 || st.h < 22) && !/chat-input|chat-scroll/.test(st.cls)) bad(`a stop smaller than 22px: ${st.tag}.${st.cls} ${st.w}×${st.h} (${st.name})`)
      // Esc: the density menu and find give the focus back
      await page.locator('.w-dens').focus()
      await page.keyboard.press('Enter')
      await page.waitForSelector('.w-dens-menu', { timeout: 3000 }).catch(() => bad('Enter on 보기 정도 opened no menu'))
      await page.keyboard.press('Escape')
      await sleep(200)
      if (await page.locator('.w-dens-menu').count()) bad('Esc left the density menu open')
      if (!(await page.evaluate(() => document.activeElement?.classList.contains('w-dens')))) bad('after Esc the focus is not back on 보기 정도')
      for (const [where, sel] of [['a diff chip', '.chat .chat-diff-head button'], ['the composer', '.chat-composer textarea.chat-input:not(.chat-input-twin)'], ['the tree', '.chat-changes [role="treeitem"]']]) {
        await page.locator(sel).first().focus()
        const id = () => page.evaluate(() => { const a = document.activeElement; return a ? `${a.className}@${a.closest('[data-key]')?.dataset.key ?? ''}` : '' })
        const before = await id()
        await page.keyboard.press('Control+f')
        const open = await page.waitForSelector('.chat-find input', { timeout: 2000 }).then(() => true, () => false)
        if (!open) { bad(`Ctrl+F from ${where} opened no find`); continue }
        await page.keyboard.press('Escape')
        await sleep(200)
        // (the same control: its class in the same row)
        const after = await id()
        if (after !== before) bad(`Esc from find did not give the focus back to ${where} (${before} → ${after})`)
      }
      // the page's storage after the walk (privacy, Task 6.5): only the known keys; the chat's a word or a number; the
      // carry's chatModes ids and words; no conversation text anywhere
      const store = await page.evaluate(() => Object.fromEntries(Object.keys(localStorage).map(k => [k, localStorage.getItem(k)])))
      const KNOWN = new Set(['spawn-box-sort', 'spawn-carry', 'spawn-changes-open', 'spawn-changes-w', 'spawn-chat-density', 'spawn-dex-viewed', 'spawn-list-mode', 'spawn-rank-npc', 'spawn-seen-version', 'spawn-session-cast', 'spawn-side-hidden', 'spawn-side-w', 'spawn-term-font', 'spawn-text-size'])
      for (const [k, v] of Object.entries(store)) {
        if (!KNOWN.has(k)) bad(`localStorage holds an unknown key ${k}`)
        if (/^spawn-(changes|chat)-/.test(k) && !/^[a-z0-9.]{1,16}$/.test(String(v))) bad(`localStorage ${k} holds more than a word or a number: ${String(v).slice(0, 40)}`)
        if (/safeRedirect|math\.js|README|rivers|\.js\b/.test(String(v)) && k !== 'spawn-dex-viewed') bad(`localStorage ${k} holds conversation text`)
      }
      const carry = JSON.parse(store['spawn-carry'] ?? '{}')
      for (const [sid, mode] of Object.entries(carry.chatModes ?? {})) if (!/^[\w-]{1,64}$/.test(sid) || !['chat', 'terminal'].includes(mode)) bad(`the carry's chatModes holds ${sid}: ${mode}`)
      console.log(`      localStorage after the walk: ${Object.keys(store).sort().join(' ')}`)
      // names, through the accessibility tree
      const cdp = await page.context().newCDPSession(page)
      const { nodes } = await cdp.send('Accessibility.getFullAXTree')
      const ROLES = new Set(['button', 'link', 'menuitem', 'menuitemradio', 'treeitem', 'textbox', 'searchbox', 'combobox', 'switch', 'checkbox', 'tab'])
      let named = 0
      for (const n of nodes) {
        const role = n.role?.value
        const props = Object.fromEntries((n.properties ?? []).map(p => [p.name, p.value?.value]))
        if (n.ignored || !(ROLES.has(role) || (role === 'separator' && props.focusable))) continue
        const name = (n.name?.value ?? '').trim()
        if (!name) bad(`an unnamed ${role} in the accessibility tree`)
        else named++
        if (role === 'treeitem') {
          if (props.level === undefined) bad(`a tree item without aria-level (${name})`)
          if (props.selected === undefined) bad(`a tree item without aria-selected (${name})`)
        }
      }
      console.log(`      accessibility tree: ${named} named controls`)
      // reduced motion: a wild catch while watching moves nothing; the list scrolls 'auto'
      await page.emulateMedia({ reducedMotion: 'reduce' })
      pushDex([{ kind: 'catch', id: 19, name: '꼬렛', tier: 'common', ball: 'poke-ball', level: 4, newSpecies: false, shiny: false, sessionId: shot.terminals[0].sessionId, uid: 'a11y1', place: '@wild|x', gender: 'female', nature: 1, pity: false, attendance: false, toProfessor: false, via: null, at: Date.now() }])
      await sleep(1200)
      const motion = await page.evaluate(() => ({ anims: document.getAnimations().filter(a => a.playState === 'running').map(a => a.animationName ?? 'x'), scroll: getComputedStyle(document.querySelector('.chat-scroll')).scrollBehavior }))
      if (motion.anims.length) bad(`animations running under reduced motion: ${motion.anims.join(', ')}`)
      if (motion.scroll !== 'auto') bad(`the conversation scrolls ${motion.scroll} under reduced motion`)
    } catch (err) {
      bad(String(err.message).split('\n')[0])
    } finally {
      if (app) await app.ctx.close()
    }
    return problems
  },

  /**
   * The budgets of a long session, page side (phase 6, Task 6.1): a 5,000-item reset (the page keeps 4,000, 더 이전
   * 대화는 터미널에서 보세요 at the top) → the first rows painted ≤ 300 ms after the flip to 채팅; 30 steps of 400 px, the
   * work per step ≤ 16 ms on average (fail > 50); 기본 → 전부 settled ≤ 300 ms with ≤ 300 rows in the page; find's
   * Enter to a hit about 3,000 rows up placed and painted ≤ 200 ms. Each number printed.
   */
  'chat-perf': async ({ browser }) => {
    const problems = []
    const bad = m => problems.push(m)
    let app
    try {
      app = await openApp(browser, { chat: 'chat-perf', chatMode: false })
      const { page } = app
      await page.waitForSelector('.w-lens button', { timeout: 15_000 })
      await sleep(600)
      // 1. the flip to 채팅: chat.open answers with the 5,000-item reset; until the first row is painted
      const first = await page.evaluate(async () => {
        const btn = [...document.querySelectorAll('.w-lens button')].find(b => b.textContent.trim() === '채팅')
        const t0 = performance.now()
        btn.click()
        while (performance.now() - t0 < 5000) {
          await new Promise(r => requestAnimationFrame(() => r()))
          if (document.querySelector('.chat .chat-row')) { await new Promise(r => requestAnimationFrame(() => r())); return performance.now() - t0 }
        }
        return null
      })
      console.log(`      5,000-item reset → first rows painted: ${first === null ? '—' : Math.round(first)} ms (budget 300)`)
      if (first === null || first > 300) bad(`the first rows took ${first === null ? 'more than 5000' : Math.round(first)} ms`)
      await sleep(800)
      const top = await page.evaluate(async () => {
        const el = document.querySelector('.chat-scroll')
        for (let k = 0; k < 40 && !document.querySelector('.chat-older'); k++) { el.scrollTop = 0; await new Promise(r => setTimeout(r, 60)) }
        return { older: document.querySelector('.chat-older')?.textContent ?? null, rows: document.querySelectorAll('.chat-row').length, setsize: Number(document.querySelector('.chat-row')?.getAttribute('aria-setsize') ?? 0) }
      })
      if (top.older !== '더 이전 대화는 터미널에서 보세요') bad(`at the top: ${JSON.stringify(top.older)}, not the cut's line`)
      if (top.rows > 300) bad(`${top.rows} rows in the page at the top`)
      console.log(`      at the top: "${top.older}", ${top.rows} rows mounted of ${top.setsize}`)
      // 2. scrolling: 30 steps of 400px from the top, the work per step (its two frames' baseline taken off)
      const { step, idle } = await page.evaluate(async () => {
        const el = document.querySelector('.chat-scroll')
        const frames = () => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))
        const avg = xs => xs.reduce((a, b) => a + b, 0) / xs.length
        const base = []
        for (let k = 0; k < 10; k++) { const t0 = performance.now(); await frames(); base.push(performance.now() - t0) }
        const times = []
        for (let k = 0; k < 30; k++) { const t0 = performance.now(); el.scrollTop += 400; await frames(); times.push(performance.now() - t0) }
        return { step: avg(times), idle: avg(base) }
      })
      const work = Math.max(0, step - idle)
      console.log(`      scrolling: ${Math.round(work * 10) / 10} ms of work per 400px step (budget 16, fail > 50; ${Math.round(step * 10) / 10} ms with its two frames)`)
      if (work > 50) bad(`scrolling takes ${Math.round(work)} ms per step`)
      // 3. 기본 → 전부 from the middle
      await page.evaluate(() => { const el = document.querySelector('.chat-scroll'); el.scrollTop = Math.round(el.scrollHeight / 2) })
      await sleep(400)
      await page.locator('.w-dens').click()
      await page.waitForSelector('.w-dens-menu', { timeout: 3000 })
      const dens = await page.evaluate(async () => {
        const el = document.querySelector('.chat-scroll')
        const item = [...document.querySelectorAll('.w-dens-item')].find(x => x.querySelector('.w-dens-item-name')?.textContent === '전부')
        const frame = () => new Promise(res => requestAnimationFrame(() => res()))
        const t0 = performance.now()
        item.click()
        let settled = null, last = null, still = 0
        while (performance.now() - t0 < 1500) {
          await frame()
          const sig = `${el.querySelectorAll('.chat-row').length}:${Math.round(el.scrollTop)}:${Math.round(el.scrollHeight)}`
          if (sig === last) { if (++still >= 3) break } else { still = 0; settled = performance.now() - t0 }
          last = sig
        }
        return { settled: still >= 3 ? settled : null, rows: el.querySelectorAll('.chat-row').length }
      })
      console.log(`      기본 → 전부: settled ${dens.settled === null ? '—' : Math.round(dens.settled)} ms (budget 300), ${dens.rows} rows in the page`)
      if (dens.settled === null || dens.settled > 300) bad(`기본 → 전부 settled after ${dens.settled === null ? 'more than 1500' : Math.round(dens.settled)} ms`)
      if (dens.rows > 300) bad(`${dens.rows} rows in the page after 기본 → 전부`)
      // (back to 기본, remembered for the next flows)
      await page.locator('.w-dens').click()
      await page.waitForSelector('.w-dens-menu', { timeout: 3000 })
      await page.locator('.w-dens-item', { hasText: '기본' }).first().click()
      await sleep(600)
      // 4. find: the needle far up, from the bottom; Enter → placed in view and painted
      await page.evaluate(() => { const el = document.querySelector('.chat-scroll'); el.scrollTop = el.scrollHeight })
      await sleep(500)
      await page.locator('.chat .chat-scroll').focus()
      await page.keyboard.press('Control+f')
      await page.waitForSelector('.chat-find input', { timeout: 3000 })
      await page.keyboard.type('양수리')
      await page.waitForFunction(() => document.querySelector('.chat-find-count')?.textContent === '1/1', null, { timeout: 3000 }).catch(() => {})
      const found = await page.evaluate(async () => {
        const input = document.querySelector('.chat-find input')
        const t0 = performance.now()
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true }))
        const v = () => document.querySelector('.chat .chat-scroll').getBoundingClientRect()
        while (performance.now() - t0 < 3000) {
          await new Promise(r => requestAnimationFrame(() => r()))
          const now = CSS.highlights?.get('chat-find-now')
          const range = now ? [...now][0] : null
          const rr = range?.getBoundingClientRect()
          const box = v()
          if (rr && rr.height > 0 && rr.top >= box.top - 1 && rr.bottom <= box.bottom + 1) {
            const row = range.startContainer.parentElement?.closest('.chat-row')
            return { ms: performance.now() - t0, up: row ? Number(row.getAttribute('aria-setsize')) - Number(row.getAttribute('aria-posinset')) : null, rows: document.querySelectorAll('.chat-row').length }
          }
        }
        return { ms: null, up: null, rows: document.querySelectorAll('.chat-row').length }
      })
      console.log(`      find: a hit ${found.up ?? '?'} rows up placed and painted in ${found.ms === null ? '—' : Math.round(found.ms)} ms (budget 200), ${found.rows} rows in the page`)
      if (found.ms === null || found.ms > 200) bad(`find's Enter placed the hit after ${found.ms === null ? 'more than 3000' : Math.round(found.ms)} ms`)
      if ((found.up ?? 0) < 2500) bad(`the hit was only ${found.up} rows up (want about 3,000)`)
      if (found.rows > 300) bad(`${found.rows} rows in the page after find`)
    } catch (err) {
      bad(String(err.message).split('\n')[0])
    } finally {
      if (app) await app.ctx.close()
    }
    return problems
  },

  /**
   * An hour of streaming in the page (phase 6, Task 6.1): 20,000 pushes into the shown chat (answers with links and
   * their cards, tool rows running then done, live bubbles that come and go, turn ends, wild meetings), in batches as
   * main sends them. The page's JS heap after a forced gc grows ≤ 40 MB, its DOM nodes stay ≤ 1.2× where they were,
   * the live blob: URLs ≤ 64, and the event listeners do not grow (CDP HeapProfiler.collectGarbage,
   * Runtime.getHeapUsage, Memory.getDOMCounters).
   */
  'chat-soak': async ({ browser }) => {
    const problems = []
    const bad = m => problems.push(m)
    let app
    try {
      app = await openApp(browser, { chat: 'chat-link-long', settings: LINK_ON, init: previewWitness })
      const { page, shot, pushDex } = app
      const t1 = shot.terminals[0].id
      const sid = shot.terminals[0].sessionId
      await page.waitForSelector('.chat .chat-row', { timeout: 15_000 })
      await sleep(1500)
      const cdp = await page.context().newCDPSession(page)
      const measure = async () => {
        await cdp.send('HeapProfiler.collectGarbage')
        await cdp.send('HeapProfiler.collectGarbage')
        const heap = await cdp.send('Runtime.getHeapUsage')
        const dom = await cdp.send('Memory.getDOMCounters')
        const blobs = await page.evaluate(() => { const w = window.__PREVIEW__?.(); return w ? w.made.filter(u => !w.revoked.includes(u)).length : -1 })
        return { mb: heap.usedSize / (1024 * 1024), nodes: dom.nodes, listeners: dom.jsEventListeners, blobs }
      }
      // (the baseline after 60 turns of the same kind (a wild row and link cards among them): the rows in view are then soak rows, as at the end)
      const WARM = 60
      let start = null
      const last = shot.chat[t1].ops[0].items.reduce((m, i) => Math.max(m, i.order), 0)
      let order = last
      let pushes = 0
      const samples = []
      const ROUNDS = Number(process.env.SOAK_ROUNDS) || 580
      for (let round = 0; round < ROUNDS; round++) {
        if (round === WARM) { await sleep(1500); start = await measure(); }
        // one turn as main sends it: 39 pushes (a prompt, 3 tools running then done, 30 live batches, the answer, the end)
        const ops = await page.evaluate(([id, base, r]) => {
          let o = base
          const at = Date.now()
          const send = (ops) => window.__CHAT_PUSH__(id, ops)
          let n = 0
          send([{ op: 'upsert', items: [{ id: `soak-u${r}`, order: (o += 10), at, kind: 'user', text: `강 ${r}번을 정리해 주세요`, images: 0 }] }]); n++
          for (let k = 0; k < 3; k++) {
            const tid = `soak-t${r}-${k}`
            send([{ op: 'upsert', items: [{ id: tid, order: (o += 10), at, kind: 'tool', tool: 'Bash', input: { command: `npm test -- r${r}` }, state: 'running' }] }]); n++
            send([{ op: 'upsert', items: [{ id: tid, order: o, at, kind: 'tool', tool: 'Bash', input: { command: `npm test -- r${r}` }, state: 'done', output: { text: `ok ${r}\n`.repeat(8), lines: 8, truncated: false, error: false }, durationMs: 900 }] }]); n++
          }
          let said = ''
          for (let k = 0; k < 30; k++) {
            said += `강 ${r}번은 계속 흘러요 ${k}. `
            send([{ op: 'upsert', items: [{ id: `live:soak${r}`, order: Number.MAX_SAFE_INTEGER, at: null, kind: 'live', text: said }] }])
            n++
          }
          send([{ op: 'remove', ids: [`live:soak${r}`] }, { op: 'upsert', items: [{ id: `soak-a${r}`, order: (o += 10), at, kind: 'text', text: `${said}\n\n참고: https://rivers.example/soak${r % 300}` }] }]); n++
          send([{ op: 'upsert', items: [{ id: `soak-e${r}`, order: (o += 10), at, kind: 'turn-end', durationMs: 6000 }] }]); n++
          return { order: o, n }
        }, [t1, order, round])
        order = ops.order
        pushes += ops.n
        if (round % 40 === 39) pushDex([{ kind: 'catch', id: 16 + (round % 100), name: '구구', tier: 'common', ball: 'poke-ball', level: 5, newSpecies: false, shiny: false, sessionId: sid, uid: `soak${round}`, place: '@wild|x', gender: 'female', nature: 1, pity: false, attendance: false, toProfessor: false, via: null, at: Date.now() }])
        // the page keeps up (one frame between turns), and now and then the view is scrolled up and back
        await page.evaluate(() => new Promise(r => requestAnimationFrame(() => r())))
        if (round % 50 === 25) { await page.evaluate(() => { const el = document.querySelector('.chat-scroll'); el.scrollTop = Math.round(el.scrollHeight / 3) }); await sleep(300); await page.evaluate(() => { const el = document.querySelector('.chat-scroll'); el.scrollTop = el.scrollHeight }) }
        if (round % 100 === 99 && round > WARM) { await sleep(500); samples.push(await measure()) }
      }
      await sleep(1500)
      const end = await measure()
      const fmt = m => `${m.mb.toFixed(1)} MB, ${m.nodes} nodes, ${m.listeners} listeners, ${m.blobs} blobs`
      console.log(`      ${pushes - WARM * 39} pushes after ${WARM} warm-up turns: start ${fmt(start)}; end ${fmt(end)}`)
      console.log(`      every 100 turns: ${samples.map(fmt).join(' | ')}`)
      if (end.mb - start.mb > 40) bad(`the JS heap grew ${(end.mb - start.mb).toFixed(1)} MB after gc (budget 40)`)
      if (end.nodes > start.nodes * 1.2) bad(`DOM nodes ${start.nodes} → ${end.nodes} (more than 1.2×)`)
      if (end.blobs > 64) bad(`${end.blobs} blob: URLs alive`)
      if (samples.length >= 2 && end.listeners > Math.max(...samples.map(s => s.listeners)) + 20 && end.listeners > start.listeners * 1.2) bad(`event listeners keep growing: ${start.listeners} → ${samples.map(s => s.listeners).join(' → ')} → ${end.listeners}`)
      if (pushes - WARM * 39 < 20_000) bad(`only ${pushes - WARM * 39} pushes after the baseline`)
    } catch (err) {
      bad(String(err.message).split('\n')[0])
    } finally {
      if (app) await app.ctx.close()
    }
    return problems
  },

  /**
   * Find in the conversation (phase 5, Task 5.8). In the chat: Ctrl+F opens the bar (role search, its controls named and
   * ≥ 22px, not a drag region, at the terminal's find place) with the focus in its field; typing is searched after
   * 120 ms and never mid-composition; the matches are painted (CSS.highlights 'chat-find' / 'chat-find-now', grey
   * rules); Enter and Shift+Enter move; a hit in a closed read group opens the group; a flip to 터미널 and back keeps
   * the bar and its words; Esc closes it, nothing stays painted, the focus is back in the composer. chat-long: a word in
   * one answer 1,500 rows up: 1/1 and the loaded-only note, Enter places its row in view (≤ 300 rows in the page) with
   * the match painted. In the terminal: Ctrl+F opens the terminal's own bar, not this one. The Mac: ⌘F opens it, Ctrl+F
   * does not (it is the session's there).
   */
  'chat-find': async ({ browser, opts }) => {
    const problems = []
    const bad = m => problems.push(m)
    const run = async (label, setup, steps) => {
      let app
      try {
        app = await openApp(browser, setup)
        await steps(app, m => bad(`${label}: ${m}`))
      } catch (err) {
        bad(`${label}: ${String(err.message).split('\n')[0]}`)
      } finally {
        if (app) await app.ctx.close()
      }
    }
    const state = page => page.evaluate(() => {
      const bar = document.querySelector('.chat-find')
      const reg = globalThis.CSS && CSS.highlights ? CSS.highlights : null
      const all = reg?.get('chat-find')
      const now = reg?.get('chat-find-now')
      const range = now ? [...now][0] : null
      const row = range ? range.startContainer.parentElement?.closest('.chat-row') : null
      const rr = range?.getBoundingClientRect()
      const v = document.querySelector('.chat .chat-scroll')?.getBoundingClientRect()
      const ae = document.activeElement
      return {
        open: !!bar, role: bar?.getAttribute('role') ?? null,
        count: bar?.querySelector('.chat-find-count')?.textContent ?? null,
        live: bar?.querySelector('.chat-find-count')?.getAttribute('aria-live') ?? null,
        note: bar?.querySelector('.chat-find-note')?.textContent ?? null,
        value: bar?.querySelector('input')?.value ?? null,
        inField: !!bar && ae === bar.querySelector('input'),
        inComposer: !!ae?.matches?.('.chat-composer textarea.chat-input'),
        all: all ? all.size : 0, now: now ? now.size : 0,
        nowText: range ? range.toString() : null,
        nowKey: row?.dataset.key ?? null,
        nowUp: row ? Number(row.getAttribute('aria-setsize')) - Number(row.getAttribute('aria-posinset')) : null,
        inView: !!(rr && v && rr.height > 0 && rr.top >= v.top - 1 && rr.bottom <= v.bottom + 1),
        rows: document.querySelectorAll('.chat-row').length,
        outline: document.querySelectorAll('.chat-row.find-now').length,
      }
    })
    const composer = page => page.locator('.chat-composer textarea.chat-input:not(.chat-input-twin)')
    const until = async (page, test, ms = 3000) => {
      const t0 = Date.now()
      let s = await state(page)
      while (!test(s) && Date.now() - t0 < ms) { await sleep(50); s = await state(page) }
      return { s, ms: Date.now() - t0 }
    }

    await run('chat', { chat: 'chat' }, async ({ page }, no) => {
      await composer(page).waitFor({ timeout: 15_000 })
      await composer(page).click()
      await page.keyboard.press('Control+f')
      await page.waitForSelector('.chat-find', { timeout: 3000 }).catch(() => no('Ctrl+F in the chat did not open find'))
      let s = await state(page)
      if (!s.inField) no('opened, the focus is not in the find field')
      if (s.role !== 'search') no(`the bar's role: ${s.role}`)
      if (s.live !== 'polite') no(`the count's aria-live: ${s.live}`)
      if (s.note !== null) no('the loaded-only note with nothing older')
      const ctrls = await page.$$eval('.chat-find input, .chat-find button', els => els.map(e => { const r = e.getBoundingClientRect(); return { name: e.getAttribute('aria-label'), title: e.getAttribute('title'), w: r.width, h: r.height, drag: getComputedStyle(e).getPropertyValue('-webkit-app-region') } }))
      if (ctrls.map(c => c.name).join(',') !== '찾을 말,이전 결과,다음 결과,찾기 닫기') no(`the controls' names: ${ctrls.map(c => c.name)}`)
      for (const c of ctrls) {
        if (c.h < 22 || c.w < 22) no(`${c.name} is ${Math.round(c.w)}×${Math.round(c.h)} (< 22px)`)
        if (c.drag === 'drag') no(`${c.name} is a window drag region`)
      }
      if (!/\(Ctrl\+F\)$/.test(ctrls[0]?.title ?? '')) no(`the field's tooltip: ${ctrls[0]?.title}`)
      // the terminal's find place: 10px from the top, 18px from the right of the pane
      const place = await page.evaluate(() => { const b = document.querySelector('.chat-find').getBoundingClientRect(), c = document.querySelector('.chat').getBoundingClientRect(); return { top: b.top - c.top, right: c.right - b.right } })
      if (Math.abs(place.top - 10) > 1 || Math.abs(place.right - 18) > 1) no(`the bar sits at ${JSON.stringify(place)}, not the terminal's 10 / 18`)
      // typed: searched after the pause, then painted
      await page.keyboard.type('safeRedirect')
      await sleep(40)
      if ((await state(page)).count) no('searched before the 120 ms pause')
      await sleep(400)
      s = await state(page)
      if (!/^\d+\/\d+$/.test(s.count ?? '')) no(`the count after typing: ${JSON.stringify(s.count)}`)
      const total = Number((s.count ?? '0/0').split('/')[1])
      if (total < 3) no(`${total} matches of safeRedirect (the answer, its code, the diff)`)
      if (s.all + s.now < 1) no('nothing painted after typing')
      const rules = await page.evaluate(() => [...document.styleSheets].flatMap(sh => { try { return [...sh.cssRules].map(r => r.cssText) } catch { return [] } }).filter(t => t.includes('::highlight(chat-find')))
      if (!rules.some(r => /::highlight\(chat-find\)/.test(r) && /--find-bg/.test(r)) || !rules.some(r => /chat-find-now/.test(r) && /--find-now-bg/.test(r))) no(`the highlight rules: ${JSON.stringify(rules)}`)
      // Enter: the current one painted stronger and in view; Enter again moves on, Shift+Enter back
      await page.keyboard.press('Enter')
      s = (await until(page, x => x.now === 1 && x.inView)).s
      if (s.now !== 1 || (s.nowText ?? '').toLowerCase() !== 'saferedirect') no(`after Enter the current match: ${s.now} ${JSON.stringify(s.nowText)}`)
      if (!s.inView) no('after Enter the current match is not in view')
      if (s.outline) no('an outline as well as the painted match')
      const first = s.count
      await page.keyboard.press('Enter')
      s = (await until(page, x => x.count !== first && x.inView)).s
      if (Number(s.count?.split('/')[0]) !== (Number(first?.split('/')[0]) % total) + 1) no(`Enter went from ${first} to ${s.count}`)
      await page.keyboard.press('Shift+Enter')
      s = (await until(page, x => x.count === first && x.inView)).s
      if (s.count !== first) no(`Shift+Enter went to ${s.count}, not back to ${first}`)
      // a hit inside a closed read group opens it
      if (await page.locator('.chat-group.open').count()) no('the read group is open before find')
      await page.locator('.chat-find input').fill('actions.ts')
      await sleep(400)
      await page.keyboard.press('Enter')
      s = (await until(page, x => x.now === 1 && x.inView)).s
      const group = await page.evaluate(() => document.querySelector('.chat-group')?.closest('.chat-row')?.dataset.key ?? null)
      if (!(await page.locator('.chat-group.open').count())) no('a hit in the closed read group did not open it')
      if (!group || s.nowKey !== group) no(`the current match is in row ${s.nowKey}, not the group ${group}`)
      if ((s.nowText ?? '').toLowerCase() !== 'actions.ts') no(`the group's match: ${JSON.stringify(s.nowText)}`)
      // a flip to 터미널 and back: the bar and its words kept (per session, in memory)
      await page.locator('.w-lens button', { hasText: '터미널' }).click()
      await sleep(300)
      if (await page.locator('.chat-find').count()) no('the find bar stays over the terminal')
      await page.locator('.w-lens button', { hasText: '채팅' }).click()
      await page.waitForSelector('.chat-find', { timeout: 3000 }).catch(() => no('after a flip back the bar is gone'))
      s = await state(page)
      if (s.value !== 'actions.ts') no(`after a flip back the field holds ${JSON.stringify(s.value)}`)
      await sleep(300)
      if ((await state(page)).inField) no('the bar kept open took the focus by itself after the flip back')
      // an IME composition is never searched: only its end is
      const field = page.locator('.chat-find input')
      await field.fill('')
      await sleep(300)
      const fire = (type, init) => field.evaluate((el, [t, i]) => {
        if (t === 'keydown') el.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...i }))
        else el.dispatchEvent(new CompositionEvent(t, { bubbles: true, ...i }))
      }, [type, init])
      await fire('compositionstart', { data: '' })
      await page.keyboard.insertText('세이프')
      await fire('keydown', { key: 'Enter', code: 'Enter', isComposing: true })
      await sleep(400)
      s = await state(page)
      if (s.count) no(`searched mid-composition (${s.count})`)
      if (!s.open) no('Enter mid-composition closed or broke the bar')
      await fire('compositionend', { data: '프' })
      await sleep(400)
      s = await state(page)
      if (s.count !== '결과 없음') no(`after the composition the count says ${JSON.stringify(s.count)}, not 결과 없음`)
      // Ctrl+F again from the composer: the field takes the focus with its words selected; Esc: closed, nothing
      // painted, the focus back where it was (the composer)
      await composer(page).click()
      await page.keyboard.press('Control+f')
      await sleep(100)
      s = await state(page)
      if (!s.inField) no('Ctrl+F with the bar open did not bring the focus back to it')
      if (await field.evaluate(el => el.selectionStart !== 0 || el.selectionEnd !== el.value.length)) no('Ctrl+F with the bar open did not select its words')
      await page.keyboard.type('safeRedirect')
      await sleep(400)
      if ((await state(page)).all + (await state(page)).now < 1) no('nothing painted for safeRedirect')
      await page.keyboard.press('Escape')
      await sleep(300)
      s = await state(page)
      if (s.open) no('Esc did not close the bar')
      if (s.all || s.now) no('highlights left after Esc')
      if (!s.inComposer) no(`after Esc the focus is not back in the composer (${await page.evaluate(() => document.activeElement?.outerHTML.slice(0, 80))})`)
      // (the final review M7) 설정 open on top: Ctrl+F does nothing for the chat (no bar opens under the dialog)
      await page.locator('.w-head .w-icon[aria-label="설정"]').click()
      await page.waitForSelector('.set-modal', { timeout: 5000 })
      await page.keyboard.press('Control+f')
      await sleep(300)
      if ((await state(page)).open) no('Ctrl+F with 설정 open opened the chat\'s find bar under it')
      await page.locator('.set-modal .set-close').click()
      await page.waitForSelector('.set-modal', { state: 'detached', timeout: 5000 }).catch(() => no('설정 did not close'))
      await composer(page).click()
      await page.keyboard.press('Control+f')
      await page.waitForSelector('.chat-find', { timeout: 3000 }).catch(() => no('with 설정 closed again, Ctrl+F did not open find'))
    })

    await run('chat-long', { chat: 'chat-find-long' }, async ({ page }, no) => {
      await page.waitForSelector('.chat .chat-row', { timeout: 15_000 })
      await sleep(600)
      await page.locator('.chat .chat-scroll').focus()
      await page.keyboard.press('Control+f')
      await page.waitForSelector('.chat-find input', { timeout: 3000 })
      await page.keyboard.type('두물머리')
      await sleep(400)
      let s = await state(page)
      if (s.count !== '1/1') no(`the count: ${JSON.stringify(s.count)} (want 1/1)`)
      if (s.note !== '불러온 대화에서만 찾아요') no(`the loaded-only note: ${JSON.stringify(s.note)}`)
      if (await page.locator('.chat-row', { hasText: '두물머리' }).count()) no('the hit was mounted before going there (not far up)')
      await page.keyboard.press('Enter')
      const got = await until(page, x => x.now === 1 && x.inView, 4000)
      s = got.s
      if (s.now !== 1 || s.nowText !== '두물머리') no(`the match is not painted (${s.now}, ${JSON.stringify(s.nowText)})`)
      if (!s.inView) no('the match is not in view')
      if ((s.nowUp ?? 0) < 1500) no(`the hit was only ${s.nowUp} rows up (want ≥ 1500)`)
      if (s.rows > 300) no(`${s.rows} rows in the page`)
      if (s.count !== '1/1') no(`after going there the count says ${s.count}`)
      console.log(`      chat-find chat-long: ${s.nowUp} rows up, placed and painted in ${got.ms} ms, ${s.rows} rows in the page`)
      // (with --out: the picture of it, the loaded-only note under the field)
      if (opts?.out) { await sleep(400); await page.screenshot({ path: join(opts.out, 'flow-chat-find-long.png'), animations: 'disabled', caret: 'hide' }) }
    })

    await run('terminal', { chat: 'chat' }, async ({ page }, no) => {
      await composer(page).waitFor({ timeout: 15_000 })
      await page.locator('.w-lens button', { hasText: '터미널' }).click()
      await sleep(400)
      await page.locator('.w-term-body .xterm >> visible=true').first().click()
      await page.keyboard.press('Control+f')
      await page.waitForSelector('.term-search', { timeout: 3000 }).catch(() => no('Ctrl+F in the terminal did not open the terminal\'s bar'))
      if (await page.locator('.chat-find').count()) no('Ctrl+F in the terminal opened the chat\'s find')
      await page.keyboard.press('Escape')
      await page.locator('.w-lens button', { hasText: '채팅' }).click()
      await sleep(500)
      if (await page.locator('.chat-find').count()) no('the chat\'s find is open after Ctrl+F in the terminal')
    })

    await run('mac', { chat: 'chat', mac: true }, async ({ page }, no) => {
      await composer(page).waitFor({ timeout: 15_000 })
      await composer(page).click()
      await page.keyboard.press('Control+f')
      await sleep(300)
      if (await page.locator('.chat-find').count()) no('Ctrl+F opened find on the Mac (it is the session\'s there)')
      await page.keyboard.press('Meta+f')
      await page.waitForSelector('.chat-find', { timeout: 3000 }).catch(() => no('⌘F did not open find'))
      const s = await state(page)
      if (!s.inField) no('opened by ⌘F, the focus is not in the field')
      const title = await page.locator('.chat-find input').getAttribute('title')
      if (!/\(⌘F\)$/.test(title ?? '')) no(`the field's tooltip on the Mac: ${title}`)
      await page.keyboard.press('Escape')
      await sleep(300)
      if (!(await state(page)).inComposer) no('after Esc the focus is not back in the composer')
    })
    return problems
  },

  /**
   * Link previews off (phase 5, Task 5.10): with 링크 미리보기 off (the default), or on while 채팅으로 보기 is off, the whole
   * chat-link conversation scrolled through from its end to its start makes no chat.preview call, draws no card and
   * makes no blob: URL, and the page makes no request of any kind beyond the harness's own server.
   */
  'chat-preview-off': async ({ browser }) => {
    const problems = []
    const bad = m => problems.push(m)
    const cases = [
      ['default (both off)', null],
      ['채팅으로 보기 on, 링크 미리보기 off', { session: { chatView: true, linkPreviews: false } }],
      ['링크 미리보기 on, 채팅으로 보기 off', { session: { chatView: false, linkPreviews: true } }],
    ]
    for (const [label, settings] of cases) {
      let app
      try {
        app = await openApp(browser, { chat: 'chat-link', settings, init: previewWitness })
        const { page } = app
        const later = []
        page.on('request', req => later.push(req.url()))
        await page.waitForSelector('.chat .chat-row', { timeout: 15_000 })
        await sleep(600)
        // the whole conversation, from its end to its start
        await scrollChatTo(page, 'top')
        await sleep(600)
        const w = await page.evaluate(() => window.__PREVIEW__())
        const asked = await callsOf(page, 'chat.preview')
        if (asked.length) bad(`${label}: ${asked.length} chat.preview calls`)
        if (await page.locator('.chat-og').count()) bad(`${label}: a card is drawn`)
        if (w.made.length) bad(`${label}: ${w.made.length} blob: URLs made`)
        const loaded = await page.evaluate(() => performance.getEntriesByType('resource').map(e => e.name))
        const foreign = [...loaded, ...later].filter(u => !u.startsWith(BASE) && !/^(data|blob):/.test(u))
        if (foreign.length) bad(`${label}: requests beyond the harness's server: ${foreign.slice(0, 3).join(' ')}`)
        // (the flow saw the links: every one of them was drawn, none asked for)
        for (const u of ['https://rivers.example/han', 'https://developer.mozilla.org/docs/Web/API/URL/URL']) if (!w.seen.includes(u)) bad(`${label}: ${u} was never drawn (the flow saw nothing)`)
        console.log(`      ${label}: ${w.seen.length} links drawn, ${asked.length} chat.preview calls, ${w.made.length} blob: URLs, ${foreign.length} foreign requests`)
      } catch (err) {
        bad(`${label}: ${String(err.message).split('\n')[0]}`)
      } finally {
        if (app) await app.ctx.close()
      }
    }
    return problems
  },

  /**
   * Link previews on (phase 5, Task 5.10). chat-link: chat.preview only for links of rows drawn (never one that was not,
   * never a user's, a tool's, code's, a stopped answer's or a fourth link), once each; the MDN card under its paragraph
   * (named 링크 미리보기: …, its URL in its title, the link's own host, its picture from a blob: URL, 104×68, ≤ 480px
   * wide), a click opens the URL through the app; up at the never-a-card turn: three cards, one through a redirect
   * (→ host), the one whose page names another site shows the link's own host. Off: every card goes, every blob: URL
   * revoked, nothing asked while scrolling; on again and the view goes (a flip to 터미널): every blob: URL revoked.
   * chat-link-long (a link in every answer of 2,000 rows): the calls at load are exactly the links of the rows drawn,
   * a small part of all; scrolling 1,000 rows up adds calls only for rows that mounted.
   */
  'chat-preview': async ({ browser }) => {
    const problems = []
    const bad = m => problems.push(m)
    const run = async (label, setup, steps) => {
      let app
      try {
        app = await openApp(browser, setup)
        await steps(app, m => bad(`${label}: ${m}`))
      } catch (err) {
        bad(`${label}: ${String(err.message).split('\n')[0]}`)
      } finally {
        if (app) await app.ctx.close()
      }
    }
    const MDN = 'https://developer.mozilla.org/docs/Web/API/URL/URL'
    const witness = page => page.evaluate(() => window.__PREVIEW__())
    const asked = async page => (await callsOf(page, 'chat.preview')).map(c => c.args[0].url)
    const cards = page => page.$$eval('.chat .chat-og', els => els.map(a => {
      const r = a.getBoundingClientRect(), img = a.querySelector('img'), ir = img?.getBoundingClientRect()
      const block = a.previousElementSibling
      return {
        url: a.title, label: a.getAttribute('aria-label'), href: a.getAttribute('href'), host: a.querySelector('.chat-og-host')?.textContent ?? '',
        via: a.querySelector('.chat-og-via')?.textContent ?? null, title: a.querySelector('.chat-og-title')?.textContent ?? '',
        src: img?.getAttribute('src') ?? null, w: r.width, h: r.height, iw: ir?.width ?? 0, ih: ir?.height ?? 0,
        after: block ? `${block.tagName.toLowerCase()}:${(block.textContent ?? '').slice(0, 400)}` : '',
      }
    }))

    await run('chat-link', { chat: 'chat-link', settings: LINK_ON, init: previewWitness }, async ({ page }, no) => {
      await page.waitForSelector('.chat .chat-og img', { timeout: 15_000 })
      await sleep(800)
      const check = async (when) => {
        const w = await witness(page)
        const urls = await asked(page)
        for (const u of urls) {
          if (!w.seen.includes(u)) no(`${when}: chat.preview for a link never drawn: ${u}`)
          if (chatFixture.LINK_NEVER.includes(u)) no(`${when}: chat.preview for a link that never gets a card: ${u}`)
        }
        if (new Set(urls).size !== urls.length) no(`${when}: a link asked twice (${urls.length} calls, ${new Set(urls).size} links)`)
        return urls
      }
      const atLoad = await check('at load')
      if (!atLoad.includes(MDN)) no(`at load no call for the MDN link (${JSON.stringify(atLoad)})`)
      // (the final review's M2) each ask names the view it is for (main asks the worker only for an open view's links)
      const ids = (await callsOf(page, 'chat.preview')).map(c => c.args[0]?.id)
      if (!ids.length || ids.some(x => typeof x !== 'string' || !x)) no(`a chat.preview call without the view's id: ${JSON.stringify(ids)}`)
      // (the final review's I1) the drawn search link with a query string is never asked for
      const w0 = await witness(page)
      if (w0.seen.includes('https://rivers.example/search?q=nile') && atLoad.includes('https://rivers.example/search?q=nile')) no('chat.preview for the link with a query string')
      const mdn = (await cards(page)).find(c => c.url === MDN)
      if (!mdn) no('no MDN card')
      else {
        if (mdn.label !== '링크 미리보기: URL() 생성자 - Web API | MDN') no(`the card's name: ${mdn.label}`)
        if (mdn.href !== '#') no(`the card's href: ${mdn.href}`)
        if (mdn.host !== 'developer.mozilla.org' || mdn.via !== null) no(`the site line: ${mdn.host} ${mdn.via}`)
        if (!/^blob:/.test(mdn.src ?? '')) no(`the picture's src: ${mdn.src}`)
        if (Math.round(mdn.iw) !== 104 || Math.round(mdn.ih) !== 68) no(`the picture is ${mdn.iw}×${mdn.ih}`)
        if (mdn.w > 480.5) no(`the card is ${mdn.w}px wide`)
        if (mdn.h < 22) no(`the card is ${mdn.h}px high`)
        if (!/^p:.*MDN의 URL\(\) 생성자 문서/.test(mdn.after)) no(`the card is not right after its paragraph (${mdn.after})`)
      }
      if (await page.locator('.chat img[src^="http"]').count()) no('a picture in the chat with a remote src')
      // a click opens the address as written through the app; nothing asked again
      const n = (await asked(page)).length
      await page.locator(`.chat .chat-og[title="${MDN}"]`).click()
      await sleep(300)
      if ((await witness(page)).opened.join() !== MDN) no(`a click opened ${JSON.stringify((await witness(page)).opened)}`)
      if ((await asked(page)).length !== n) no('a click asked again')

      // up at the never-a-card turn: its three cards
      await scrollChatTo(page, 'top', 400, () => document.querySelector('.chat .chat-og[title="https://rivers.example/amazon"]'))
      await sleep(800)
      await check('scrolled up')
      const up = await cards(page)
      const by = u => up.find(c => c.url === u)
      const han = by('https://rivers.example/han'), nile = by('https://rivers.example/nile'), amazon = by('https://rivers.example/amazon')
      if (!han || !nile || !amazon) no(`the turn's cards: ${JSON.stringify(up.map(c => c.url))}`)
      if (han && (han.host !== 'rivers.example' || han.via !== '→ www.rivers.example')) no(`the redirected card's site line: ${han.host} ${han.via}`)
      if (amazon && amazon.host !== 'rivers.example') no(`a page naming another site made the card say ${amazon.host}`)
      if (amazon && amazon.src !== null) no('the card with no picture has one')
      if (up.some(c => chatFixture.LINK_NEVER.includes(c.url))) no(`a card for ${up.find(c => chatFixture.LINK_NEVER.includes(c.url)).url}`)
      if (han && !/^p:/.test(han.after)) no(`the first card is not after its paragraph (${han.after})`)
      if (nile && !/^ul:/.test(nile.after)) no(`the list's cards are not after the list (${nile.after})`)
      if (await page.locator('.chat .chat-user .chat-og, .chat .chat-tool .chat-og').count()) no('a card under a user message or a tool row')

      // off: every card goes, every blob: URL revoked, nothing asked while scrolling
      await page.evaluate(() => window.spawn.settings.set({ session: { linkPreviews: false } }))
      await sleep(500)
      if (await page.locator('.chat-og').count()) no('cards stay after 링크 미리보기 went off')
      const off = await witness(page)
      const left = off.made.filter(u => !off.revoked.includes(u))
      if (left.length) no(`${left.length} blob: URLs not revoked after previews went off`)
      const calledOff = (await asked(page)).length
      await scrollChatTo(page, 'bottom')
      await sleep(500)
      if ((await asked(page)).length !== calledOff) no('chat.preview called while off')
      console.log(`      off: ${off.made.length} blob: URLs made, ${off.revoked.length} revoked`)

      // on again, then the view goes (a flip to 터미널): every blob: URL revoked
      await page.evaluate(() => window.spawn.settings.set({ session: { linkPreviews: true } }))
      await page.waitForSelector('.chat .chat-og img', { timeout: 5000 }).catch(() => no('no card after turning previews on again'))
      await sleep(300)
      await page.locator('.w-lens button', { hasText: '터미널' }).click()
      await sleep(600)
      const gone = await witness(page)
      const kept = gone.made.filter(u => !gone.revoked.includes(u))
      if (kept.length) no(`${kept.length} of ${gone.made.length} blob: URLs not revoked after the view went`)
      console.log(`      the view went: ${gone.made.length} blob: URLs made, ${gone.revoked.length} revoked`)
    })

    await run('chat-link-long', { chat: 'chat-link-long', settings: LINK_ON, init: previewWitness }, async ({ page }, no) => {
      await page.waitForSelector('.chat .chat-og', { timeout: 15_000 })
      await sleep(800)
      const RIVER = /^https:\/\/rivers\.example\/r\d+$/
      const all = await page.evaluate(() => { const s = window.__SHOT__; return s.chat[s.terminals[0].id].ops[0].items.filter(i => i.kind === 'text' && /rivers\.example\/r\d+/.test(i.text)).length })
      const drawn = async () => (await witness(page)).seen.filter(u => RIVER.test(u))
      // the links of the rows mounted now (each has stayed mounted long enough to ask)
      const mountedNow = () => page.$$eval('.chat .chat-prose a[title]:not(.chat-og)', els => els.map(a => a.title)).then(l => l.filter(u => RIVER.test(u)))
      // every call is for a link of a row that was drawn; every row mounted now has asked
      const fits = async (when, calls, seen) => {
        const strays = calls.filter(u => !seen.includes(u))
        if (strays.length) no(`${when}: ${strays.length} calls for links never drawn (${strays.slice(0, 3).join(' ')})`)
        const missing = (await mountedNow()).filter(u => !calls.includes(u))
        if (missing.length) no(`${when}: ${missing.length} links of mounted rows never asked (${missing.slice(0, 3).join(' ')})`)
      }
      const first = [...new Set(await asked(page))]
      const seen0 = await drawn()
      if (!first.length) no('no call at load')
      await fits('at load', first, seen0)
      if (first.length > 60 || first.length * 10 > all) no(`${first.length} calls at load for ${all} links (more than the rows on screen)`)
      const posTop = () => page.evaluate(() => Math.min(...[...document.querySelectorAll('.chat .chat-row')].map(r => Number(r.getAttribute('aria-posinset')))))
      const from = await posTop()
      // (a margin of 20 rows: once the scrolling stops, the mounted window settles by a row or two — the overscan is
      // measured again — and the check below must not hang on that)
      for (let k = 0; k < 600 && (await posTop()) > from - 1020; k++) {
        await page.evaluate(() => { document.querySelector('.chat .chat-scroll').scrollTop -= 500 })
        await sleep(40)
      }
      await sleep(800)
      const to = await posTop()
      if (to > from - 1000) no(`scrolled only ${from - to} rows up`)
      const after = [...new Set(await asked(page))]
      const seen1 = await drawn()
      await fits('after scrolling', after, seen1)
      if (after.length >= all) no(`every link was asked for (${after.length} of ${all})`)
      const mounted = await page.locator('.chat .chat-row').count()
      if (mounted > 300) no(`${mounted} rows in the page`)
      console.log(`      chat-link-long: ${all} links in all; ${first.length} asked at load (${seen0.length} drawn); ${after.length} after scrolling ${from - to} rows up (${seen1.length} drawn on the way, the rest flown past); ${mounted} rows mounted`)
    })
    return problems
  },

  /**
   * The 변경 사항 panel (phase 5): the header button (its counts, pressed, toggles, remembered), a diff block's +N −N
   * opens the panel at that file and scrolls that edit into view, the tree's keys (↑↓, ← →, Home End, Enter), the
   * edge's drag, keys and double-click, the width remembered across a reload; the chat pane ends where the panel starts.
   */
  'chat-changes': async ({ browser }) => {
    const problems = []
    const bad = m => problems.push(m)
    let app
    try {
      app = await openApp(browser, { chat: 'chat-changes', size: [1440, 900] })
      const { page } = app
      await page.waitForSelector('.chat .chat-row', { timeout: 15_000 })
      await page.waitForSelector('.w-sess-head .w-chg', { timeout: 10_000 })
      let st = await changesState(page)
      if (st.open) bad('the panel is open before anything opened it')
      if (st.button?.pressed !== 'false') bad(`the header button is pressed with the panel closed (${JSON.stringify(st.button)})`)
      if (!/\+25/.test(st.button?.text ?? '') || !/−6/.test(st.button?.text ?? '')) bad(`the header button does not show the summary's +25 −6: ${JSON.stringify(st.button)}`)
      if (await page.locator('.w-chat-tools').evaluate(el => getComputedStyle(el).webkitAppRegion ?? getComputedStyle(el).getPropertyValue('-webkit-app-region')).catch(() => 'no-drag') === 'drag') bad('the chat tools are a window drag region')
      // a diff block's +N −N: the second edit of src/math.js (two hunks), at the top of the conversation
      await page.locator('.chat-scroll').evaluate(el => { el.scrollTop = 0 })
      await sleep(500)
      const chip = page.locator('.chat-diff', { has: page.locator('.chat-diff-file', { hasText: /^src\/math\.js$/ }) }).nth(1).locator('.chat-counts-btn')
      await chip.scrollIntoViewIfNeeded()
      const before = (await calls(page)).length
      await chip.click()
      await page.waitForSelector('.chat-changes .chat-ch-edit .chat-dl', { timeout: 10_000 })
      await sleep(400)
      st = await changesState(page)
      const asked = (await calls(page)).slice(before)
      if (!asked.some(c => c.fn === 'chat.changes')) bad('opening the panel asked no chat.changes')
      if (!asked.some(c => c.fn === 'chat.changeFile' && c.args[0].file === 'src/math.js')) bad(`no chat.changeFile for src/math.js (${JSON.stringify(asked.map(c => c.fn))})`)
      if (st.button?.pressed !== 'true') bad('the header button is not pressed with the panel open')
      if (st.stored.open !== '1') bad(`spawn-changes-open is ${st.stored.open} after opening`)
      if (st.rows.find(r => r.selected === 'true')?.name !== 'math.js') bad(`the chip did not select math.js: ${JSON.stringify(st.rows.filter(r => r.selected === 'true'))}`)
      const c02 = st.edits.find(e => e.tool === 'toolu_fixture_c02')
      if (!c02?.inView) bad(`the chip's edit is not scrolled into view: ${JSON.stringify(st.edits)}`)
      if (st.edits.map(e => e.tool).join(',') !== 'toolu_fixture_c01,toolu_fixture_c02,toolu_fixture_ca1,toolu_fixture_c12') bad(`math.js's edits not in order: ${st.edits.map(e => e.tool)}`)
      if (st.paneRight === null || Math.abs(st.paneRight - st.box.left) > 1) bad(`the chat pane (right ${st.paneRight}) and the panel (left ${st.box?.left}) overlap or leave a gap`)
      if (Math.abs(st.box.width - 320) > 1) bad(`the panel is ${st.box.width}px wide, not the default 320`)

      // the tree by keyboard
      await page.locator('.chat-ch-tn[aria-selected="true"]').focus()
      const focused = async () => (await changesState(page)).rows.find(r => r.focused)?.name ?? null
      await page.keyboard.press('ArrowDown')
      if (await focused() !== 'rivers.js') bad(`↓ from math.js focused ${await focused()}`)
      await page.keyboard.press('Enter')
      await sleep(400)
      st = await changesState(page)
      if (st.rows.find(r => r.selected === 'true')?.name !== 'rivers.js' || st.fname !== 'src/rivers.js') bad(`Enter did not select rivers.js (${st.fname})`)
      await page.keyboard.press('Home')
      if (await focused() !== 'notebooks') bad(`Home focused ${await focused()}`)
      await page.keyboard.press('ArrowLeft')
      st = await changesState(page)
      if (st.rows.find(r => r.name === 'notebooks')?.expanded !== 'false' || st.rows.some(r => r.name === 'rivers.ipynb')) bad('← did not close the folder')
      await page.keyboard.press('ArrowRight')
      await page.keyboard.press('ArrowRight')
      if (await focused() !== 'rivers.ipynb') bad(`→ → from a closed folder focused ${await focused()}`)
      await page.keyboard.press('ArrowLeft')
      if (await focused() !== 'notebooks') bad(`← from a file did not go to its folder (${await focused()})`)
      await page.keyboard.press('End')
      if (!/x\.txt$/.test(await focused() ?? '')) bad(`End focused ${await focused()}`)
      await page.keyboard.press('ArrowUp')
      if (await focused() !== '세션 폴더 밖') bad(`↑ from the last file focused ${await focused()}`)

      // the edge: a drag, the keys, a double-click, Home
      const rz = page.locator('.chat-ch-rz')
      const hb = await rz.boundingBox()
      await page.mouse.move(hb.x + hb.width / 2, hb.y + 200)
      await page.mouse.down()
      await page.mouse.move(hb.x + hb.width / 2 - 40, hb.y + 200, { steps: 4 })
      await page.mouse.move(hb.x + hb.width / 2 - 80, hb.y + 200, { steps: 4 })
      await page.mouse.up()
      await sleep(300)
      st = await changesState(page)
      if (Math.abs(st.box.width - 400) > 2) bad(`dragged 80px left, the panel is ${st.box.width}px (not 400)`)
      if (st.stored.w !== String(Math.round(st.box.width))) bad(`the dragged width is not remembered (${st.stored.w})`)
      if (Math.abs(st.paneRight - st.box.left) > 1) bad('after the drag the chat pane does not end where the panel starts')
      await rz.focus()
      await page.keyboard.press('ArrowLeft')
      await sleep(150)
      const wider = (await changesState(page)).box.width
      await page.keyboard.press('ArrowRight')
      await page.keyboard.press('ArrowRight')
      await sleep(150)
      const narrower = (await changesState(page)).box.width
      if (Math.round(wider - st.box.width) !== 16 || Math.round(st.box.width - narrower) !== 16) bad(`← / → did not move the edge 16px (${st.box.width} → ${wider} → ${narrower})`)
      if (await rz.getAttribute('aria-valuenow') !== String(Math.round(narrower))) bad(`aria-valuenow ${await rz.getAttribute('aria-valuenow')} is not the width ${narrower}`)
      for (const a of ['role', 'aria-orientation', 'aria-valuemin', 'aria-valuemax', 'aria-label']) if (!(await rz.getAttribute(a))) bad(`the edge has no ${a}`)
      await page.keyboard.press('Home')
      await sleep(150)
      st = await changesState(page)
      if (Math.abs(st.box.width - 320) > 1 || st.stored.w !== null) bad(`Home did not give the default (${st.box.width}, stored ${st.stored.w})`)
      await page.keyboard.press('ArrowLeft')
      await page.keyboard.press('ArrowLeft')
      await sleep(150)
      await rz.dblclick()
      await sleep(150)
      st = await changesState(page)
      if (Math.abs(st.box.width - 320) > 1 || st.stored.w !== null) bad(`a double-click did not give the default (${st.box.width}, stored ${st.stored.w})`)
      // remembered across a reload: open, at the width left
      const hb2 = await rz.boundingBox()
      await page.mouse.move(hb2.x + hb2.width / 2, hb2.y + 200)
      await page.mouse.down()
      await page.mouse.move(hb2.x + hb2.width / 2 - 60, hb2.y + 200, { steps: 5 })
      await page.mouse.up()
      await sleep(300)
      const left = (await changesState(page)).box.width
      await page.evaluate(() => sessionStorage.setItem('harness-keep-storage', '1'))
      await page.reload()
      await page.waitForSelector('.chat-changes .chat-ch-edit', { timeout: 15_000 }).catch(() => bad('after a reload the panel is not open'))
      await sleep(300)
      st = await changesState(page)
      if (!st.open || Math.abs(st.box.width - left) > 1) bad(`after a reload the panel is ${st.open ? `${st.box.width}px` : 'closed'}, not ${left}px`)

      // the header button: closes and opens, pressed accordingly, the open state remembered
      await page.locator('.w-chg').click()
      await sleep(200)
      st = await changesState(page)
      if (st.open || st.button?.pressed !== 'false' || st.stored.open !== '0') bad(`the button did not close the panel (${JSON.stringify({ open: st.open, b: st.button, s: st.stored })})`)
      await page.locator('.w-chg').click()
      await page.waitForSelector('.chat-changes', { timeout: 5000 }).catch(() => bad('the button did not open the panel again'))
      st = await changesState(page)
      if (st.button?.pressed !== 'true') bad('the button is not pressed after opening again')
      // × closes, and the focus goes back to the header button
      await page.locator('.chat-ch-x').click()
      await sleep(200)
      if ((await changesState(page)).open) bad('× did not close the panel')
      if (!(await page.evaluate(() => document.activeElement?.classList.contains('w-chg')))) bad('after × the focus is not on the header button')
    } catch (err) {
      bad(String(err.message).split('\n')[0])
    } finally {
      if (app) await app.ctx.close()
    }
    return problems
  },

  /**
   * The left panel folds to the rail for the open panel at 1200 wide and comes back when it closes or the window
   * widens, never written to spawn-side-hidden; the rail's unfold closes the panel; at 560 wide no panel, the button
   * says why, nothing clipped.
   */
  'chat-changes-fold': async ({ browser }) => {
    const problems = []
    const bad = m => problems.push(m)
    let app
    try {
      app = await openApp(browser, { chat: 'chat-changes', size: [1200, 800] })
      const { page } = app
      await page.waitForSelector('.chat .chat-row', { timeout: 15_000 })
      await page.waitForSelector('.w-chg', { timeout: 10_000 })
      let st = await changesState(page)
      if (st.folded || st.rail) bad('folded before the panel opened')
      await page.locator('.w-chg').click()
      await page.waitForSelector('.chat-changes', { timeout: 5000 })
      await sleep(300)
      st = await changesState(page)
      if (!st.folded || !st.rail) bad('at 1200 wide the left panel did not fold to the rail for the panel')
      if (st.sideHidden !== '0') bad(`spawn-side-hidden became ${st.sideHidden}`)
      if (Math.abs(st.box.width - 320) > 1) bad(`the panel is ${st.box.width}px at 1200 (not 320)`)
      await page.locator('.chat-ch-x').click()
      await sleep(300)
      st = await changesState(page)
      if (st.folded || st.rail) bad('closing the panel did not bring the left panel back')
      if (st.sideHidden !== '0') bad(`spawn-side-hidden became ${st.sideHidden} after closing`)
      await page.locator('.w-chg').click()
      await page.waitForSelector('.chat-changes', { timeout: 5000 })
      await sleep(200)
      await page.setViewportSize({ width: 1440, height: 900 })
      await sleep(400)
      st = await changesState(page)
      if (st.folded || st.rail || !st.open) bad(`widened to 1440: folded ${st.folded}, open ${st.open}`)
      await page.setViewportSize({ width: 1200, height: 800 })
      await sleep(400)
      st = await changesState(page)
      if (!st.folded) bad('narrowed again to 1200: not folded')
      // the rail's unfold, while the panel folded it: the panel closes and the left panel comes back
      await page.locator('.w-rail .w-side-toggle').click()
      await sleep(300)
      st = await changesState(page)
      if (st.open || st.folded) bad(`the rail's unfold: open ${st.open}, folded ${st.folded}`)
      if (st.sideHidden !== '0') bad(`spawn-side-hidden became ${st.sideHidden} after the rail's unfold`)
      // the user's own fold stays theirs: folded, the panel opens without changing it
      await page.locator('.w-head .w-side-toggle').click()
      await sleep(200)
      if ((await changesState(page)).sideHidden !== '1') bad('the user\'s own fold was not stored')
      await page.locator('.w-chg').click()
      await sleep(300)
      await page.locator('.chat-ch-x').click()
      await sleep(300)
      st = await changesState(page)
      if (!st.folded || st.sideHidden !== '1') bad('closing the panel undid the user\'s own fold')
      await page.locator('.w-rail .w-side-toggle').click()
      await sleep(200)
      // 560 wide: no room even folded → no panel, the button says why, nothing clipped
      await page.locator('.w-chg').click()
      await sleep(200)
      await page.setViewportSize({ width: 560, height: 720 })
      await sleep(500)
      st = await changesState(page)
      if (st.open) bad('a panel at 560 wide')
      if (st.button && st.button.disabled !== 'true') bad(`at 560 the button is not disabled (${JSON.stringify(st.button)})`)
      if (st.button && st.button.title !== '창이 좁아서 변경 사항을 열 수 없어요') bad(`at 560 the button's title is "${st.button.title}"`)
      if (st.folded) bad('at 560 the left panel folded for a panel that is not there')
      const sideways = await page.evaluate(() => document.scrollingElement.scrollWidth - window.innerWidth)
      if (sideways > 0) bad(`at 560 the page scrolls sideways by ${sideways}px`)
      const fit = await fitProblems(page)
      for (const p of fit) bad(`560: fit: ${p}`)
      await page.setViewportSize({ width: 1440, height: 900 })
      await sleep(400)
      if (!(await changesState(page)).open) bad('back at 1440 the remembered open panel did not come back')
    } catch (err) {
      bad(String(err.message).split('\n')[0])
    } finally {
      if (app) await app.ctx.close()
    }
    return problems
  },

  /**
   * With the panel open (and the left panel folded for it, at 1200 wide), the flip to 터미널: the terminal's box is the
   * one it had before the panel ever opened, its resizes are those of the same flip without the panel, no panel and
   * no chat tools in the header. At a load in chat with the panel open and folded, the terminal fitted under the chat
   * gets the size it is shown at.
   */
  'chat-changes-terminal': async ({ browser }) => {
    const problems = []
    const bad = m => problems.push(m)
    let app
    try {
      app = await openApp(browser, { chat: 'chat-changes', chatMode: false, size: [1200, 800] })
      const { page, shot } = app
      const t1 = shot.terminals[0].id
      const lens = name => page.locator('.w-lens button', { hasText: name })
      await page.waitForSelector('.w-term-body .xterm', { timeout: 15_000 })
      await sleep(600)
      const r0 = await termRect(page)
      if (await page.locator('.w-chat-tools, .w-chg').count()) bad('chat tools in the header in terminal mode')
      const resizesAfter = async n => (await calls(page)).slice(n).filter(c => c.fn === 'resize' && c.args[0] === t1).map(c => c.args.slice(1).join('x'))
      // the flip there and back without the panel: what 1.4.0-with-the-flip does
      await lens('채팅').click()
      await page.waitForSelector('.chat .chat-row', { timeout: 10_000 })
      await sleep(300)
      let n = (await calls(page)).length
      await lens('터미널').click()
      await sleep(700)
      const plain = await resizesAfter(n)
      const r1 = await termRect(page)
      if (r1 !== r0) bad(`the flip alone moved the terminal: ${r0} → ${r1}`)
      // the same with the panel opened in between (it folds the left panel at 1200)
      await lens('채팅').click()
      await page.waitForSelector('.chat .chat-row', { timeout: 10_000 })
      n = (await calls(page)).length
      await page.locator('.w-chg').click()
      await page.waitForSelector('.chat-changes .chat-ch-edit', { timeout: 10_000 })
      await sleep(400)
      if (!(await changesState(page)).folded) bad('the panel did not fold the left panel at 1200 (the case this flow is for)')
      const byPanel = await resizesAfter(n)
      if (byPanel.length) bad(`opening the panel resized the terminal: ${byPanel}`)
      n = (await calls(page)).length
      await lens('터미널').click()
      await sleep(700)
      const withPanel = await resizesAfter(n)
      const r2 = await termRect(page)
      if (r2 !== r0) bad(`with the panel open, the flip to 터미널 left the terminal at ${r2}, not ${r0}`)
      if (withPanel.join(' ') !== plain.join(' ')) bad(`the flip's resizes with the panel (${withPanel}) differ from without (${plain})`)
      if (await page.locator('.chat-changes').count()) bad('the panel is there in terminal mode')
      if (await page.locator('.w-chat-tools, .w-chg').count()) bad('chat tools in the header in terminal mode')
      if (await page.locator('.widget.side-hidden').count()) bad('the left panel stayed folded in terminal mode')
      // a load in chat: the terminal fitted warm under the chat (Task 5.2), first with the panel closed (what it does
      // without the panel), then with it open and the left panel folded for it: the same resizes, the shown size last
      const loadInChat = async open => {
        await page.evaluate(o => { localStorage.setItem('spawn-changes-open', o ? '1' : '0'); sessionStorage.setItem('harness-keep-storage', '1') }, open)
        await page.reload()
        await page.waitForSelector('.chat .chat-row', { timeout: 15_000 })
        if (open) await page.waitForSelector('.chat-changes .chat-ch-edit', { timeout: 15_000 })
        await sleep(900)
        if (open && !(await changesState(page)).folded) bad('after the reload the left panel is not folded for the panel')
        const warm = await resizesAfter(0)
        await lens('터미널').click()
        await sleep(700)
        const rect = await termRect(page)
        const all = await resizesAfter(0)
        await lens('채팅').click()
        await page.waitForSelector('.chat .chat-row', { timeout: 10_000 })
        return { warm, all, rect }
      }
      await lens('채팅').click()
      await page.waitForSelector('.chat .chat-row', { timeout: 10_000 })
      const closedLoad = await loadInChat(false)
      const openLoad = await loadInChat(true)
      if (openLoad.warm.join(' ') !== closedLoad.warm.join(' ')) bad(`at a load in chat the terminal fitted under the chat got ${openLoad.warm} with the panel, ${closedLoad.warm} without`)
      if (openLoad.all.join(' ') !== closedLoad.all.join(' ')) bad(`a load in chat, then 터미널: ${openLoad.all} with the panel, ${closedLoad.all} without`)
      if (openLoad.rect !== r0 || closedLoad.rect !== r0) bad(`after a load in chat, 터미널 shows the terminal at ${openLoad.rect} (panel) / ${closedLoad.rect}, not ${r0}`)
      console.log(`      terminal ${r0}; flip resizes ${plain.join(' ') || 'none'}; with the panel ${withPanel.join(' ') || 'none'}; load in chat ${closedLoad.all.join(' ')}; with the panel ${openLoad.all.join(' ')}`)
    } catch (err) {
      bad(String(err.message).split('\n')[0])
    } finally {
      if (app) await app.ctx.close()
    }
    return problems
  },

  /** The widget mode has no panel, no chat tools and asks nothing, even with the panel left open */
  'chat-changes-widget': async ({ browser }) => {
    const problems = []
    const bad = m => problems.push(m)
    let app
    try {
      app = await openApp(browser, { chat: 'chat-changes', mode: 'widget', size: [340, 820], local: { 'spawn-changes-open': '1' } })
      const { page } = app
      await sleep(1200)
      if (await page.locator('.chat-changes, .w-chg, .w-chat-tools, .w-chat-pane').count()) bad('the widget shows the panel, its button or the chat')
      if ((await calls(page)).some(c => c.fn === 'chat.changes' || c.fn === 'chat.changeFile')) bad('the widget asked for changes')
      await app.ctx.close()
      app = null
      // a window with the panel open, then the widget
      app = await openApp(browser, { chat: 'chat-changes', size: [1440, 900], local: { 'spawn-changes-open': '1' } })
      const p2 = app.page
      await p2.waitForSelector('.chat-changes', { timeout: 15_000 })
      await p2.evaluate(() => window.spawn.widget.setMode('widget'))
      await sleep(800)
      if (await p2.locator('.chat-changes, .w-chg, .w-chat-tools').count()) bad('after the switch to the widget the panel or its button stayed')
    } catch (err) {
      bad(String(err.message).split('\n')[0])
    } finally {
      if (app) await app.ctx.close()
    }
    return problems
  },

  'chat-off': async ({ browser, opts }) => {
    const problems = []
    const bad = m => problems.push(m)
    let app
    try {
      app = await openApp(browser, {})
      const { page } = app
      const chatRequests = []
      page.on('request', r => { if (/ChatView|Composer|chat-/i.test(r.url())) chatRequests.push(r.url()) })
      await page.waitForSelector('.w-term-body .xterm', { timeout: 15_000 })
      await sleep(600)
      if (await page.locator('[aria-label="보기 방식"], .w-lens').count()) bad('a 채팅 / 터미널 flip with the chat view off')
      if (await page.locator('.chat, .w-chat-pane').count()) bad('a chat view with the chat view off')
      if (await page.locator('.chat-composer, .w-compose textarea').count()) bad('a composer or an instruction box with the chat view off')
      if ((await calls(page)).some(c => String(c.fn).startsWith('chat.'))) bad('a chat call with the chat view off')
      const loaded = await page.evaluate(() => performance.getEntriesByType('resource').map(e => e.name).filter(n => /ChatView|Composer/.test(n)))
      if (loaded.length || chatRequests.length) bad(`the chat view's code was loaded: ${[...loaded, ...chatRequests].join(', ')}`)
      await app.ctx.close()
      app = null
      // the pictures, against 1.4.0's own (a baseline is required: without it this flow fails)
      const dir = process.env.CHAT_OFF_BASELINE ?? join(opts.out, '..', '00-before')
      for (const [surface, size] of [['session', [1440, 900]], ['session', [1100, 720]], ['session-work', [1440, 900]], ['session-work', [1100, 720]], ['session-mac', [1440, 900]]]) {
        const base = join(dir, `${surface}-${size[0]}x${size[1]}.png`)
        if (!existsSync(base)) { bad(`no baseline ${base} (make it from a build of this version with features.json chatView false)`); continue }
        // Another take only for the two known frame-noise signatures (re-review m-12; NOISE_AREAS: the blinking
        // caret's cell, a corner of the instruction field), measured in each take's own page. Any other
        // difference fails the surface at once: it cannot pass by retrying. A take that is noise is printed
        // too, so a noise that grows is seen. Up to five takes; one must equal 1.4.0's pixel for pixel.
        const name = `${surface} ${size.join('x')}`
        let equal = 0
        for (let take = 1; take <= 5 && !equal; take++) {
          const pic = await surfacePicture(browser, surface, size)
          const d = pngDiff(readFileSync(base), pic.buf)
          if (!d) { equal = take; break }
          const noise = d.noise(pic.noise)
          console.log(`      ${name} take ${take} differs: ${d.detail} — ${noise ? `frame noise (${noise.join(', ')}), taken again` : 'not frame noise'}`)
          if (!noise) { bad(`${name} differs from 1.4.0's (take ${take}, not frame noise): ${d.detail}`); equal = -1 }
        }
        if (equal > 0) console.log(`      ${name} equals 1.4.0's pixel for pixel${equal > 1 ? ` (take ${equal})` : ''}`)
        else if (equal === 0) bad(`${name}: no take of five equals 1.4.0's (each differed by frame noise only)`)
      }
    } catch (err) {
      bad(String(err.message).split('\n')[0])
    } finally {
      if (app) await app.ctx.close()
    }
    return problems
  },
}

/**
 * The text step as the page shows it: the <html> class, the stored keys, --t-name, the
 * lockup's size, the terminal's metrics and whether its rows fit its box
 */
async function textState(page, id) {
  return page.evaluate(i => {
    const html = document.documentElement
    const term = (window.spawnTermMetrics?.() ?? []).find(m => m.id === i) ?? null
    const view = document.querySelector('.w-term-body .term-view:not([style*="display: none"])') ?? document.querySelector('.w-term-body .term-view')
    const screen = view?.querySelector('.xterm-screen')
    const box = view ? { view: view.clientHeight, screen: screen?.getBoundingClientRect().height ?? null, rows: term?.rows, cell: term?.cellHeight } : null
    // (the ball alone since 1.6.1: no wordmark beside it)
    const brand = document.querySelector('.w-brand')
    const b = brand?.getBoundingClientRect()
    return {
      cls: [...html.classList].filter(c => c.startsWith('ts-')).join(' '),
      stored: localStorage.getItem('spawn-text-size'),
      old: localStorage.getItem('spawn-term-font'),
      name: getComputedStyle(html).getPropertyValue('--t-name').trim(),
      term,
      box,
      fits: !!(term && box && term.rows * term.cellHeight <= box.view + 0.5),
      lockup: brand ? { font: getComputedStyle(brand).fontSize, w: Math.round(b.width * 10) / 10, h: Math.round(b.height * 10) / 10 } : null,
    }
  }, id)
}

/** The bridge calls the page made so far (fake-bridge.js) */
const calls = page => page.evaluate(() => window.__CALLS__)

/** Terminal output after the replay (fake-bridge.js __TERM_PUSH__) */
const termPush = (page, id, data) => page.evaluate(([i, d]) => window.__TERM_PUSH__(i, d), [id, data])

/** The terminal in view, scrolled up with the wheel */
async function scrollTermUp(page) {
  const box = await page.evaluate(() => {
    const x = [...document.querySelectorAll('.w-term-body .xterm')].find(e => e.offsetParent)
    const r = x?.getBoundingClientRect()
    return r ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : null
  })
  if (!box) return
  await page.mouse.move(box.x, box.y)
  await page.mouse.wheel(0, -1200)
  await sleep(400)
}

/** Where the terminal in view is scrolled: its scrollbar's slider (xterm draws no DOM text with WebGL) */
const termScroll = page => page.evaluate(() => {
  const x = [...document.querySelectorAll('.w-term-body .xterm')].find(e => e.offsetParent)
  const slider = x?.querySelector('.scrollbar.vertical .slider')
  if (!slider) return null
  const track = slider.parentElement.clientHeight
  const top = parseFloat(slider.style.top) || slider.offsetTop
  const height = slider.offsetHeight
  return { top, height, track, atBottom: top + height >= track - 2 }
})

/** A surface's picture, taken exactly as a shot of it is (for the off = 1.4.0 comparison) */
async function surfacePicture(browser, surface, size) {
  const dir = join(HOME, 'chat-off')
  mkdirSync(dir, { recursive: true })
  const report = []
  await shoot(browser, parseId(surface), size, { out: dir, checks: new Set(), side: null, text: null, lang: null, noise: true }, report)
  if (!report[0]?.file) throw new Error(`the ${surface} shot failed: ${report[0]?.problems?.join('; ')}`)
  return { buf: readFileSync(report[0].file), noise: report[0].noise ?? [] }
}

/**
 * Two PNGs the same, pixel for pixel: null, else what differs (`detail`: the count, the first pixel and
 * the box around them all; `noise(areas)`: the frame-noise signatures the difference is wholly made of —
 * every pixel inside one of the areas, none over an area's most — else null)
 */
function pngDiff(a, b) {
  const A = PNG.sync.read(a), B = PNG.sync.read(b)
  if (A.width !== B.width || A.height !== B.height) return { detail: `size ${A.width}x${A.height} vs ${B.width}x${B.height}`, noise: () => null }
  const at = []
  for (let i = 0; i < A.data.length; i += 4) {
    if (A.data[i] !== B.data[i] || A.data[i + 1] !== B.data[i + 1] || A.data[i + 2] !== B.data[i + 2] || A.data[i + 3] !== B.data[i + 3]) at.push(i / 4)
  }
  if (!at.length) return null
  const xy = p => [p % A.width, Math.floor(p / A.width)]
  let [x0, y0] = xy(at[0]), x1 = x0, y1 = y0
  for (const p of at) { const [x, y] = xy(p); x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y) }
  return {
    detail: `${at.length} pixels differ, the first at ${xy(at[0]).join(',')}, all within ${x0},${y0}–${x1},${y1}`,
    noise: areas => {
      const hits = new Map()
      for (const p of at) {
        const [x, y] = xy(p)
        const a = areas.find(r => x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h)
        if (!a) return null
        hits.set(a, (hits.get(a) ?? 0) + 1)
      }
      for (const [a, n] of hits) if (n > a.max) return null
      return [...new Set([...hits.keys()].map(a => a.what))]
    },
  }
}

/**
 * The two frame-noise signatures of a 1.4.0 surface (chat-off), measured in the page in CSS px (the shots
 * are at device scale 1), each with the most pixels it may cover. Seen on cff52ac's build as on this one:
 *   caret          the terminal's cursor cell, which blinks (xterm's cursorBlink; TerminalPanel is not ours to
 *                  change): one cell, where xterm keeps its helper textarea (8×17 px at 보통: 136 pixels)
 *   field corner   two pixels one colour level off on the rounded corner of the side panel's instruction
 *                  field (.w-compose textarea, radius 8): a corner's radius square, 8 pixels at most
 */
const NOISE_AREAS = () => {
  const out = []
  for (const t of document.querySelectorAll('.w-term-body .xterm-helper-textarea')) {
    const r = t.getBoundingClientRect()
    if (r.width && r.height && t.closest('.term-view')?.getClientRects().length) out.push({ what: 'caret', x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height), max: Math.round(r.width) * Math.round(r.height) })
  }
  for (const f of document.querySelectorAll('.w-compose textarea')) {
    const r = f.getBoundingClientRect()
    if (!r.width) continue
    const k = Math.ceil(parseFloat(getComputedStyle(f).borderTopLeftRadius) || 0)
    if (!k) continue
    for (const [x, y] of [[r.left, r.top], [r.right - k, r.top], [r.left, r.bottom - k], [r.right - k, r.bottom - k]]) out.push({ what: 'field corner', x: Math.round(x), y: Math.round(y), w: k, h: k, max: 8 })
  }
  return out
}

/** A terminal's metrics (src/termMetrics.ts; the page opened with &smoke): its font size and columns */
const termInfo = (page, id) => page.evaluate(i => (window.spawnTermMetrics?.() ?? []).find(m => m.id === i) ?? null, id)
const termCols = async (page, id) => (await termInfo(page, id))?.cols ?? null

/** ×: the first click asks (닫기, nothing closed), leaving clears it, two clicks close it once */
async function closeAsksThenCloses(page, hoverOn, x, terminalId, bad) {
  await hoverOn.hover()
  await x.click()
  if ((await x.textContent()).trim() !== '닫기') bad(`× after one click reads "${(await x.textContent()).trim()}", not 닫기`)
  if ((await calls(page)).some(c => c.fn === 'close')) bad('× closed at once, without asking')
  await page.mouse.move(2, 2)
  await sleep(80)
  if ((await x.textContent()).trim() !== '×') bad('the 닫기 ask stayed after the mouse left')
  await hoverOn.hover()
  await x.click()
  await x.click()
  await sleep(80)
  const closes = (await calls(page)).filter(c => c.fn === 'close')
  if (closes.length !== 1 || closes[0].args[0] !== terminalId) bad(`× twice: expected one close of ${terminalId}, got ${JSON.stringify(closes)}`)
}

/** A rename field is open: exactly one in the page, the expected one; Enter sends one rename */
async function renameOnce(page, field, terminalId, value, bad) {
  const all = await page.locator('input.w-row-rename, input.w-sess-head-rename').count()
  if (all !== 1 || (await field.count()) !== 1) bad(`double-click: ${all} rename field(s) in the page, ${await field.count()} where expected`)
  if (!(await field.count())) return
  await field.fill(value)
  await field.press('Enter')
  await sleep(80)
  const renames = (await calls(page)).filter(c => c.fn === 'rename')
  if (renames.length !== 1 || renames[0].args[0] !== terminalId || renames[0].args[1] !== value) bad(`Enter: expected one rename of ${terminalId} to "${value}", got ${JSON.stringify(renames)}`)
  if (await page.locator('input.w-row-rename, input.w-sess-head-rename').count()) bad('the rename field stayed open after Enter')
}

/** Page errors seen by the flows' pages (openApp) */
const flowPageErrors = []

/** The app with the fixture in a page of its own, for a flow (window mode) */
/**
 * A page of the app with the fixture. lang: 'en' / 'ja' (the page's locale); update: the bridge's
 * update state (an update on offer); ended: the index of a terminal that has exited (its session ended);
 * noMon: the last n sessions have no Pokémon yet (fixture.snapshotNoMon)
 */
async function openApp(browser, { local = {}, twelve = false, noMon = 0, size = [1440, 900], work = false, mac = false, smoke = false, mode = 'window', commits = false, lang = null, update = null, ended = null, chat = undefined, armed = {}, chatMode = true, chatOpts = null, init = null, settings = null } = {}) {
  const base0 = twelve ? fixture.terminals12 : fixture.terminals
  // chat: a conversation's name (chatFixture.mjs), or null for armed terminals with nothing to show;
  // left out: no terminal has the chat key (the app as 1.4.0). chatMode: 채팅 chosen in the carry
  const chatData = chat === undefined ? null : chatShot(base0, chat, armed)
  const base = chatData ? chatData.terminals : base0
  const shot = {
    mode, workMode: work, version: VERSION, update,
    terminals: ended === null ? base : base.map((t, i) => i === ended ? { ...t, status: 'exited' } : t),
    board: fixture.board, branches: fixture.branches, history: fixture.history,
    transcript: fixture.transcript, shellTranscript: fixture.shellTranscript,
    ...(chatData ? { chat: chatData.chat, chatAgent: chatData.chatAgent, changes: chatData.changes, previews: chatData.previews, previewAll: chatData.previewAll, screens: SCREENS } : {}),
    ...(chatOpts ? { chatOpts } : {}),
    // (설정's values laid over the defaults, e.g. 링크 미리보기 on: fake-bridge.js)
    ...(settings ? { settings } : {}),
  }
  // (a conversation's wild Pokémon: its game events in the snapshot; pushDex sends more, kept for a reload)
  let snapshot = withDex(twelve ? fixture.snapshot12 : noMon ? fixture.snapshotNoMon(noMon) : fixture.snapshot, chat ? chatFixture.wild(chat, shot.terminals[0].sessionId) : null)
  const sockets = new Set()
  const all = {
    'spawn-carry': JSON.stringify({ view: 'terminal', target: shot.terminals[0].sessionId, ...(chatData && chatMode ? { chatModes: chatData.chatModes } : {}) }),
    'spawn-side-hidden': '0', 'spawn-seen-version': VERSION, 'spawn-dex-viewed': JSON.stringify(fixture.VIEWED),
    ...local,
  }
  const ctx = await browser.newContext({
    viewport: { width: size[0], height: size[1] }, deviceScaleFactor: 1, locale: LOCALE[lang] ?? 'ko-KR', timezoneId: 'Asia/Seoul',
    colorScheme: 'dark', bypassCSP: true,
  })
  try {
    await ctx.clock.setFixedTime(fixture.NOW)
    const page = await ctx.newPage()
    // A page error during a flow fails the flow (main reads this list after each one)
    page.on('pageerror', err => flowPageErrors.push(`page error: ${String(err.message).split('\n')[0]}`))
    await page.addInitScript(pageSetup, { shot, local: all, mac, origin: BASE })
    // commits: React's commits counted in window.__COMMITS__ (a stand-in for the DevTools hook,
    // which React calls on every commit, production build included)
    if (commits) {
      await page.addInitScript(() => {
        window.__COMMITS__ = 0
        window.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
          isDisabled: false, supportsFiber: true, renderers: new Map(),
          inject() { return 1 }, checkDCE() {},
          onCommitFiberRoot() { window.__COMMITS__++ }, onCommitFiberUnmount() {}, onPostCommitFiberRoot() {}, onScheduleFiberRoot() {},
        }
      })
    }
    await page.addInitScript({ path: join(HERE, 'fake-bridge.js') })
    // init: a flow's own script before the app's code, on every load of this page (chat-reload-size)
    for (const s of init ? [init].flat() : []) await page.addInitScript(s)
    await page.routeWebSocket(/\/ws$/, ws => {
      sockets.add(ws)
      ws.onClose(() => sockets.delete(ws))
      const send = () => ws.send(JSON.stringify(snapshot))
      send()
      ws.onMessage(send)
    })
    /**
     * A game event as the server broadcasts it (server/pokedex.js: `{ type: 'pokedex', state, event }`): the events
     * join the snapshot's log and today (a reload's snapshot has them too), and the last one is the message's event
     */
    const pushDex = (events) => {
      snapshot = withDex(snapshot, events)
      const msg = JSON.stringify({ type: 'pokedex', state: snapshot.pokedex, event: events[events.length - 1] })
      for (const ws of sockets) { try { ws.send(msg) } catch { sockets.delete(ws) } }
    }
    // &smoke: the page offers window.spawnTermMetrics() (src/termMetrics.ts): each terminal's font size and columns
    await page.goto(`${BASE}/?widget&mode=${mode}${smoke ? '&smoke' : ''}`)
    await page.waitForFunction(n => document.querySelectorAll('.w-party .w-row').length === n, shot.terminals.length, { timeout: 15_000 })
    // (HIT_BEFORE_RUN: the hit-areas flow measuring the pre-plan build, which has no session header)
    if (mode !== 'widget' && !process.env.HIT_BEFORE_RUN) await page.waitForSelector('.w-sess-head', { timeout: 15_000 })
    return { ctx, page, shot, pushDex }
  } catch (err) {
    await ctx.close()
    throw err
  }
}

/** A snapshot whose game state also holds these events (in its log and, as the server's today overlaps it, its today) */
function withDex(snap, events) {
  if (!events || !events.length) return snap
  const dex = snap.pokedex
  return { ...snap, pokedex: { ...dex, log: [...dex.log, ...events], today: [...(dex.today ?? []), ...events] } }
}

/**
 * A chat surface's page data: every Claude Code terminal armed (TerminalInfo.chat), chat.open for the
 * first one answered with the named conversation (chatFixture.mjs), its Agent rows' sub-agent items for
 * chat.agent, and 채팅 chosen for its session in the carry (chatModes). `armed` overrides per terminal
 * index ('unarmed', 'version', null for no key).
 */
function chatShot(base, name, armed = {}) {
  const terminals = base.map((t, i) => {
    if (t.tool !== 'claude') return t
    const v = i in armed ? armed[i] : 'armed'
    if (v === null) return t
    return { ...t, chat: v }
  })
  const first = terminals[0]
  const chat = name ? { [first.id]: chatFixture.update(name, first.id) } : {}
  const agentRows = name ? chat[first.id].ops[0].items.filter(i => i.kind === 'tool' && (i.tool === 'Agent' || i.tool === 'Task')) : []
  const chatAgent = Object.fromEntries(agentRows.map(r => [r.id, chatFixture.agentItems(r.id)]))
  // the 변경 사항 panel's answers (chat:changes, chat:change-file) for the conversations that have an index
  const found = name ? chatFixture.changes(name) : null
  const changes = found ? { [first.id]: found } : {}
  // link preview cards (phase 5): what chat.preview answers (chat-link-long: a made-up card for any rivers.example link)
  const previews = (name && chatFixture.previews(name)) || {}
  return { terminals, chat, chatAgent, changes, previews, previewAll: name === 'chat-link-long', chatModes: name ? { [first.sessionId]: 'chat' } : {} }
}

// ---------------------------------------------------------------- the composer (chat view phase 3)

const firstTerm = page => page.evaluate(() => window.__SHOT__.terminals[0].id)
/** A fixture screen written into the terminal's real xterm (fake-bridge.js __SCREEN__): what termText() reads */
const screenTo = async (page, id, name) => { await page.evaluate(([i, n]) => window.__SCREEN__(i, n), [id, name]); await sleep(120) }
/** The fake bridge's answers for the composer's calls (window.__CHAT_SCRIPT__), merged */
const chatScript = (page, o) => page.evaluate(x => { window.__CHAT_SCRIPT__ = Object.assign(window.__CHAT_SCRIPT__ || {}, x) }, o)
const callsOf = async (page, fn) => (await calls(page)).filter(c => c.fn === fn)
const chatStatus = (over = {}) => ({ state: 'idle', since: null, label: null, banner: null, note: null, version: '2.1.323', hasOlder: false, empty: false, ...over })
const pushStatus = async (page, id, over) => { await page.evaluate(([i, st]) => window.__CHAT_PUSH__(i, [{ op: 'status', status: st }]), [id, chatStatus(over)]); await sleep(150) }

// ---------------------------------------------------------------- the turn summary (chat view phase 5)

/**
 * GET /pokedex answered by the harness (the turn summary's step reads, src/chat/steps.ts): the first terminal's
 * session as Pokémon `u-foot` with these steps, read after read (the last one repeats). Returns the count of reads.
 */
async function routeDex(page, steps = [10, 18]) {
  const sid = await page.evaluate(() => window.__SHOT__.terminals[0].sessionId)
  const seen = { n: 0, urls: [], headers: [] }
  await page.route('**/pokedex', route => {
    const req = route.request()
    seen.urls.push(req.url())
    seen.headers.push(req.headers())
    const n = steps[Math.min(seen.n, steps.length - 1)]
    seen.n++
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ assign: { [sid]: 'u-foot' }, mons: { 'u-foot': { uid: 'u-foot', steps: n } } }) })
  })
  return seen
}

/**
 * A turn that ends live (chatFixture.mjs footLive, the lab's second turn): the session goes to work (idle →
 * working: the start read), then the turn's lines and its turn_duration arrive with the session idle again.
 */
async function footTurn(page) {
  const { t1, last } = await page.evaluate(() => {
    const s = window.__SHOT__
    const id = s.terminals[0].id
    return { t1: id, last: Math.max(...s.chat[id].ops[0].items.map(i => i.order)) }
  })
  const items = chatFixture.footLive(last)
  await pushStatus(page, t1, { state: 'working', since: fixture.NOW - 61_000 })
  await sleep(250)
  await page.evaluate(([id, list, st]) => window.__CHAT_PUSH__(id, [{ op: 'upsert', items: list }, { op: 'status', status: st }]), [t1, items, chatStatus()])
  return { t1, items, end: items.find(i => i.kind === 'turn-end') }
}

/** The chat-foot surface: the live turn, and (outside 업무 모드) its 8걸음 */
async function footShot(page) {
  const work = await page.evaluate(() => !!window.__SHOT__.workMode)
  await routeDex(page)
  await footTurn(page)
  if (work) await sleep(2200)
  else await page.waitForSelector('.chat .chat-steps', { timeout: 6000 })
  await sleep(300)
}
// ---------------------------------------------------------------- link preview cards (chat view phase 5)

/**
 * The chat's list scrolled step by step to its top or bottom (each step a real scroll, so the virtual list mounts the
 * rows on the way), or until `until` (a function run in the page) is true. True when `until` was met.
 */
async function scrollChatTo(page, where, step = 500, until = null) {
  let still = 0
  for (let i = 0; i < 800; i++) {
    if (until && await page.evaluate(until)) return true
    const moved = await page.evaluate(([w, s]) => {
      const b = document.querySelector('.chat .chat-scroll')
      if (!b) return false
      const before = b.scrollTop
      b.scrollTop += w === 'top' ? -s : s
      return b.scrollTop !== before
    }, [where, step])
    await sleep(60)
    if (moved) still = 0
    else if (++still >= 4) return false
  }
  return false
}

/** The chat-link surface: the lab answer's MDN card in the middle of the list (the list's own scroll only) */
async function linkShot(page) {
  await page.waitForSelector('.chat .chat-og img', { timeout: 10_000 })
  await page.evaluate(() => {
    const el = [...document.querySelectorAll('.chat .chat-og')].find(a => a.title.includes('developer.mozilla.org'))?.closest('.chat-row')
    const box = document.querySelector('.chat .chat-scroll')
    if (!el || !box) return
    const a = el.getBoundingClientRect(), b = box.getBoundingClientRect()
    box.scrollTop += a.bottom - b.bottom + 120
  })
  await sleep(600)
}

/** 설정 › 세션, its last rows (the chat view's two) in view */
async function sessionSettings(page) {
  const lang = await page.evaluate(() => (navigator.language.startsWith('ja') ? 'ja' : navigator.language.startsWith('en') ? 'en' : null))
  await page.locator(`.w-head .w-icon[aria-label="${shown('설정', lang)}"]`).click()
  await page.locator('.set-nav button', { hasText: new RegExp(`^${shown('세션', lang)}$`) }).click()
  await page.waitForSelector('.set-modal', { timeout: 10_000 })
  await page.evaluate(() => { const rows = document.querySelectorAll('.set-modal .set-row'); rows[rows.length - 1]?.scrollIntoView({ block: 'center' }) })
  await sleep(300)
}

/**
 * The previews' witness (an init script, after the fake bridge): every blob: URL the page made and revoked, every link
 * address the chat ever drew (`a[title]` in a row's prose: what a mounted row shows), and the app's openUrl calls
 */
function previewWitness() {
  const made = new Set(), revoked = new Set(), seen = new Set(), opened = []
  const create = URL.createObjectURL.bind(URL), revoke = URL.revokeObjectURL.bind(URL)
  URL.createObjectURL = (b) => { const u = create(b); made.add(u); return u }
  URL.revokeObjectURL = (u) => { revoked.add(u); revoke(u) }
  const look = () => { for (const a of document.querySelectorAll('.chat .chat-prose a[title]:not(.chat-og)')) seen.add(a.getAttribute('title')) }
  new MutationObserver(look).observe(document, { subtree: true, childList: true })
  if (window.spawn?.terminals) { const o = window.spawn.terminals.openUrl; window.spawn.terminals.openUrl = (u) => { opened.push(u); return o(u) } }
  window.__PREVIEW__ = () => ({ made: [...made], revoked: [...revoked], seen: [...seen], opened: [...opened] })
}

const COMPOSER = '.chat-composer textarea.chat-input:not(.chat-input-twin)'
const composerField = page => page.locator(COMPOSER)
/** The answer cards (phase 4): a status with these cards (waiting unless said), and a card button by its exact name */
const pushAsks = (page, id, asks, state = 'waiting') => pushStatus(page, id, { state, since: fixture.NOW, asks })
const askButton = (page, name) => page.locator('.chat-answer button').getByText(name, { exact: true })
/** Long enough for a card to take a pointer press (src/chat/answer.ts ARM_MS 800, after paint) */
const ARMED = 1000
/** PNG files drawn in the page (16×16), pasted into the composer as a paste event carries them */
const pasteImage = (page, count = 1) => page.evaluate(async (n) => {
  const dt = new DataTransfer()
  for (let i = 0; i < n; i++) {
    const c = document.createElement('canvas')
    c.width = 16; c.height = 16
    const g = c.getContext('2d')
    g.fillStyle = i ? '#3b82f6' : '#e5484d'; g.fillRect(0, 0, 16, 16)
    g.fillStyle = '#ffffff'; g.fillRect(4, 4, 8, 8)
    const blob = await new Promise(r => c.toBlob(r, 'image/png'))
    dt.items.add(new File([blob], `shot-${i + 1}.png`, { type: 'image/png' }))
  }
  document.querySelector('.chat-composer textarea.chat-input:not(.chat-input-twin)').dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }))
}, count)

/** chat-compose: a two-line draft, two pasted images, Claude Code's queue of one, the permission mode */
async function composeDraft(page) {
  const id = await firstTerm(page)
  await page.waitForSelector('.chat-composer textarea.chat-input:not(.chat-input-twin)', { timeout: 10_000 })
  await pushStatus(page, id, { mode: 'acceptEdits', queued: [{ text: '끝나면 README의 "로그인" 절에도 바뀐 점 적어 주세요', truncated: false }], queuedCount: 1 })
  await composerField(page).click()
  await page.keyboard.type('빌드 끝나면 src/lib/safe-redirect.ts 에')
  await page.keyboard.press('Shift+Enter')
  await page.keyboard.type('주석 한 줄만 더 달아 주세요')
  await pasteImage(page, 2)
}

/** chat-compose-fail: main says the terminal's prompt row has text (prompt-busy) */
async function composeFail(page) {
  const id = await firstTerm(page)
  await page.waitForSelector('.chat-composer textarea.chat-input:not(.chat-input-twin)', { timeout: 10_000 })
  // (1.6.2: typed text on the terminal's row, which the note now quotes)
  await screenTo(page, id, 'typed')
  await chatScript(page, { send: { ok: false, reason: 'prompt-busy' } })
  await composerField(page).click()
  await page.keyboard.type('테스트도 같이 돌려 주세요')
  await page.keyboard.press('Enter')
}

/** chat-compose-pending: one bubble sent and not in the record 9 s later, one whose Enter is still on its way */
async function composePending(page) {
  const id = await firstTerm(page)
  await page.waitForSelector('.chat-composer textarea.chat-input:not(.chat-input-twin)', { timeout: 10_000 })
  await screenTo(page, id, 'idle-empty')
  await composerField(page).click()
  await page.keyboard.type('Without tools, name three rivers')
  await page.keyboard.press('Enter')
  await sleep(200)
  await screenTo(page, id, 'echo-plain')
  await page.waitForSelector('.chat-user.pending.sent', { timeout: 5000 })
  await page.context().clock.setFixedTime(fixture.NOW + 9_000)
  await pushStatus(page, id, {})
  await page.waitForSelector('.chat-user.pending.unconfirmed', { timeout: 5000 })
  await chatScript(page, { submit: 'hang' })
  await page.keyboard.type('and three lakes')
  await page.keyboard.press('Enter')
}

// ---------------------------------------------------------------- the 변경 사항 panel (chat view phase 5)

/** The panel open, the file whose name in the tree is `name` chosen by a click */
async function changesFile(page, name) {
  await page.waitForSelector('.chat-changes .chat-ch-tree [role="treeitem"]', { timeout: 10_000 })
  await page.locator('.chat-changes .chat-ch-tn.file', { has: page.locator('.chat-ch-nm', { hasText: new RegExp(`^${name.replace(/[.]/g, '\\.')}$`) }) }).first().click()
  await sleep(300)
}
/** What the panel shows: its box, the tree's rows (name, selected, expanded, focused), the edits' tool ids, the chat pane's right edge */
const changesState = page => page.evaluate(() => {
  const panel = document.querySelector('.chat-changes')
  const r = panel?.getBoundingClientRect()
  const pane = document.querySelector('.w-chat-pane')?.getBoundingClientRect()
  const rows = [...document.querySelectorAll('.chat-ch-tree [role="treeitem"]')].map(el => ({
    name: el.querySelector('.chat-ch-nm')?.textContent ?? '', selected: el.getAttribute('aria-selected'), expanded: el.getAttribute('aria-expanded'), focused: document.activeElement === el,
  }))
  const scroller = document.querySelector('.chat-ch-diff')?.getBoundingClientRect()
  const edits = [...document.querySelectorAll('.chat-ch-edit')].map(el => { const b = el.getBoundingClientRect(); return { tool: el.getAttribute('data-tool'), top: b.top, inView: !!scroller && b.top >= scroller.top - 1 && b.top < scroller.bottom } })
  return {
    open: !!panel, box: r ? { left: r.left, right: r.right, width: r.width } : null, paneRight: pane?.right ?? null, rows, edits,
    fname: document.querySelector('.chat-ch-fname')?.textContent ?? null,
    folded: !!document.querySelector('.widget.side-hidden'), rail: !!document.querySelector('.w-rail'),
    sideHidden: localStorage.getItem('spawn-side-hidden'), stored: { w: localStorage.getItem('spawn-changes-w'), open: localStorage.getItem('spawn-changes-open') },
    button: (() => { const b = document.querySelector('.w-chg'); return b ? { pressed: b.getAttribute('aria-pressed'), disabled: b.getAttribute('aria-disabled'), text: b.textContent, label: b.getAttribute('aria-label'), title: b.getAttribute('title') } : null })(),
  }
})
/** The shown terminal's box (the one with a layout), rounded */
const termRect = page => page.evaluate(() => {
  const v = [...document.querySelectorAll('.w-term-body .term-view')].find(e => e.offsetParent)
  const r = v?.getBoundingClientRect()
  return r ? [r.left, r.top, r.width, r.height].map(n => Math.round(n * 10) / 10).join(',') : null
})

// ---------------------------------------------------------------- small helpers

const sleep = ms => new Promise(r => setTimeout(r, ms))

function pngSize(buf) {
  return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) }
}

async function loadPlaywright() {
  const entry = existsSync(join(PLAYWRIGHT, 'index.mjs')) ? pathToFileURL(join(PLAYWRIGHT, 'index.mjs')).href : PLAYWRIGHT
  try {
    return await import(entry)
  } catch (err) {
    fail(`cannot load playwright-core from ${PLAYWRIGHT} (${err.message}). Set PLAYWRIGHT_CORE to a playwright-core folder.`)
  }
}

/**
 * Playwright's own Chromium when its revision is installed, else the installed Edge, else Chrome;
 * SHOTS_BROWSER (a browser executable) is tried alone when set
 */
async function launchBrowser(chromium) {
  const tries = process.env.SHOTS_BROWSER
    ? [{ executablePath: process.env.SHOTS_BROWSER }]
    : [{}, { channel: 'msedge' }, { channel: 'chrome' }]
  const errors = []
  for (const opts of tries) {
    try {
      const browser = await chromium.launch({ headless: true, ...opts })
      return { browser, name: opts.executablePath ?? opts.channel ?? 'chromium' }
    } catch (err) {
      errors.push(`${opts.executablePath ?? opts.channel ?? 'chromium'}: ${String(err.message).split('\n')[0]}`)
    }
  }
  fail(`no browser could start:\n  ${errors.join('\n  ')}`)
}

// ---------------------------------------------------------------- the server

async function answers(url) {
  try { const r = await fetch(url, { signal: AbortSignal.timeout(1000) }); return r.ok } catch { return false }
}

async function startServer() {
  if (await answers(`${BASE}/`)) fail(`port ${PORT} already answers: another harness run (or something else) is using it`)
  mkdirSync(join(HOME, 'registry'), { recursive: true })
  mkdirSync(join(HOME, 'claude'), { recursive: true })
  const env = {
    ...process.env,
    SPAWN_HOME: HOME,
    SPAWN_REGISTRY_DIR: join(HOME, 'registry'),
    SPAWN_PORT: String(PORT),
    SPAWN_UI_DIR: DIST,
    // Not the owner's: the server reads 프롬프트 숨기기 from the app's settings file, and ~/.claude
    SPAWN_SETTINGS_FILE: join(HOME, 'settings.json'),
    CLAUDE_CONFIG_DIR: join(HOME, 'claude'),
  }
  for (const k of Object.keys(env)) if (k.startsWith('CLAUDEX_')) delete env[k]
  const child = spawn(process.execPath, [join(ROOT, 'server', 'index.js')], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] })
  serverChild = child
  let output = ''
  child.stdout.on('data', d => { output += d })
  child.stderr.on('data', d => { output += d })
  let exited = null
  child.on('exit', code => { exited = code })
  const until = Date.now() + 20_000
  while (Date.now() < until) {
    if (exited !== null) fail(`the server stopped (exit ${exited}):\n${output}`)
    if (await answers(`${BASE}/`)) return { child, log: () => output }
    await sleep(200)
  }
  fail(`the server did not answer on ${BASE} within 20 s:\n${output}`)
}

// ---------------------------------------------------------------- one shot

/** Runs in the page before its own code: the shot, page storage, the Mac platform */
function pageSetup({ shot, local, mac, origin }) {
  window.__SHOT__ = shot
  // The same "random" picks every run (the instruction box's line is picked at random)
  let seed = 0x2f6b1d
  Math.random = () => {
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  // (a flow that reloads to see what the page kept sets harness-keep-storage in sessionStorage first)
  let keep = false
  try { keep = sessionStorage.getItem('harness-keep-storage') === '1' } catch { /* no storage */ }
  if (location.origin === origin && !keep) {
    try { for (const [k, v] of Object.entries(local)) localStorage.setItem(k, v) } catch { /* no storage */ }
  }
  if (mac) {
    // src/platform.ts reads userAgentData.platform first, then navigator.platform
    Object.defineProperty(Navigator.prototype, 'platform', { get: () => 'MacIntel', configurable: true })
    Object.defineProperty(Navigator.prototype, 'userAgentData', { get: () => ({ platform: 'macOS', mobile: false, brands: [] }), configurable: true })
  }
}

/** Every <img> on screen has finished (loaded or failed); lazy ones below the fold are left */
async function imagesSettled(page, timeout = 30_000) {
  await page.waitForFunction(() => [...document.images].every(img => {
    const r = img.getBoundingClientRect()
    const onScreen = r.width > 0 && r.height > 0 && r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth
    return !onScreen || img.complete
  }), null, { timeout, polling: 200 })
}

async function fitProblems(page) {
  return page.evaluate(() => {
    const bad = []
    const name = el => `${el.tagName.toLowerCase()}${el.className && typeof el.className === 'string' ? '.' + el.className.trim().split(/\s+/).join('.') : ''}`
    const sw = document.documentElement.scrollWidth
    if (sw > innerWidth) bad.push(`the page scrolls sideways: scrollWidth ${sw} > ${innerWidth}`)
    // the window's own frame never scrolled (a scrollIntoView or a focus() can move a clipped column: the top bar gone)
    for (let el = document.querySelector('.w-term-body')?.parentElement; el; el = el.parentElement) {
      if (el.scrollTop || el.scrollLeft) bad.push(`${name(el)} is scrolled (${el.scrollLeft}, ${el.scrollTop}): the window's frame moved`)
    }
    const ROWS = '.w-head, .w-launch, .w-term-tabs, .w-list-head, .w-sess-bar, .w-row, ' +
      // the views: 도감's numbers and filters, 박스's bars, 기록's summary and rows, 랭킹's rows
      '.dex-stats, .dex-stat, .dex-tiers, .dex-tiercol, .dex-filterbar, .dex-fgroup, .dex-card-tags, .dex-owned-top, ' +
      '.box-toolbar, .box-tools, .box-actions, .today-sum, .today-row, .today-text, ' +
      '.rank-top, .rank-me, .rank-row, ' +
      // the chat view: the flip, tool rows, the banner, a diff's head, every row of the conversation
      '.w-lens, .chat-tool-head, .chat-banner, .chat-banner-acts, .chat-diff-head, .chat-row, .chat-status, .chat-empty'
    for (const parent of document.querySelectorAll(ROWS)) {
      const pr = parent.getBoundingClientRect()
      if (!pr.width) continue
      for (const child of parent.children) {
        const cs = getComputedStyle(child)
        if (cs.display === 'none' || cs.visibility === 'hidden') continue
        const r = child.getBoundingClientRect()
        if (!r.width && !r.height) continue
        if (r.right > pr.right + 0.5) bad.push(`${name(child)} ends at ${r.right.toFixed(1)}, past its parent ${name(parent)} (${pr.right.toFixed(1)})`)
      }
    }
    // One line each: a label that wraps (the header's 로그인, 기록's time) or a dot squeezed out of its row
    // (the lines its words are laid out on: its text's boxes, icons left out, grouped by their vertical middle: a
    // box whose middle lies within the box before it is on the same line. Text of another font on one line (the
    // Japanese 停止 beside the Latin <kbd>Esc</kbd>) has boxes of other tops and heights, not another line)
    const lines = el => {
      const boxes = []
      const walk = document.createTreeWalker(el, NodeFilter.SHOW_TEXT)
      for (let n = walk.nextNode(); n; n = walk.nextNode()) {
        if (!n.textContent.trim()) continue
        const range = document.createRange()
        range.selectNodeContents(n)
        for (const r of range.getClientRects()) if (r.width) boxes.push(r)
      }
      boxes.sort((a, b) => a.top - b.top)
      let count = 0
      let line = null
      for (const r of boxes) {
        const mid = r.top + r.height / 2
        if (line && mid > line.top && mid < line.bottom) continue
        count++
        line = r
      }
      return count
    }
    // (a question's option is a label with its description under it: two lines by design)
    for (const el of document.querySelectorAll('.w-head .w-signin, .w-head .w-update, .w-launch-main, .today-time, .w-list-count, .w-sess-head-proj, .w-lens button, .chat-btn:not(.chat-card-opt), .chat-jump, .chat-tool-meta, .chat-tool-label, .chat-copy')) {
      if (el.getBoundingClientRect().width && lines(el) > 1) bad.push(`${name(el)} wraps onto ${lines(el)} lines (${el.textContent.trim().slice(0, 20)})`)
    }
    // A fixed column whose text must fit it (기록's time): not wider than the column
    for (const el of document.querySelectorAll('.today-time')) {
      if (el.scrollWidth > el.clientWidth + 0.5) bad.push(`${name(el)} is ${el.scrollWidth}px of text in a ${el.clientWidth}px column (${el.textContent.trim()})`)
    }
    // The composer's control row (model, mode, HP, 5시간, 주간): every item inside the row and none of its text cut
    // (a narrow chat drops items, src/components/chat/ControlRow.tsx; they are never clipped)
    for (const row of document.querySelectorAll('.chat-ctrl')) {
      const pr = row.getBoundingClientRect()
      if (!pr.width) continue
      for (const child of row.querySelectorAll('.chat-ctrl-item, .chat-ctrl-meter, .chat-ctrl-item > span, .chat-ctrl-item > b')) {
        const r = child.getBoundingClientRect()
        if (!r.width) continue
        if (r.right > pr.right + 0.5) bad.push(`${name(child)} ends at ${r.right.toFixed(1)}, past the control row (${pr.right.toFixed(1)}): "${child.textContent.trim().slice(0, 20)}"`)
        if (child.scrollWidth > child.clientWidth + 0.5) bad.push(`${name(child)} cuts its text: ${child.scrollWidth}px in ${child.clientWidth}px ("${child.textContent.trim().slice(0, 20)}")`)
      }
    }
    // The side box's pointer to the composer (chat view): its words whole, wrapped not cut (Phase 6 en / ja)
    for (const el of document.querySelectorAll('.w-input-pointer > span')) {
      const r = el.getBoundingClientRect()
      if (!r.width) continue
      const box = el.closest('.w-input').getBoundingClientRect()
      if (el.scrollWidth > el.clientWidth + 0.5 || r.bottom > box.bottom + 0.5 || r.top < box.top - 0.5) bad(`the side box's pointer "${el.textContent.trim()}" is cut (${el.scrollWidth}px in ${el.clientWidth}px, ${Math.round(r.top)}–${Math.round(r.bottom)} in ${Math.round(box.top)}–${Math.round(box.bottom)})`)
    }
    // The usage labels ("5-hour", "Weekly", 5時間) are never cut, at any text size or language
    for (const el of document.querySelectorAll('.w-limit > .w-label')) {
      if (el.getBoundingClientRect().width && el.scrollWidth > el.clientWidth + 0.5) bad.push(`the usage label "${el.textContent.trim()}" is cut: ${el.scrollWidth}px of text in ${el.clientWidth}px`)
    }
    for (const el of document.querySelectorAll('.w-head .w-conn, .w-row-tick, .w-pill-dot, .w-rail-dot')) {
      const r = el.getBoundingClientRect()
      const cs = getComputedStyle(el)
      if (cs.display !== 'none' && el.offsetParent && r.width < parseFloat(cs.height) - 0.5) bad.push(`${name(el)} squeezed to ${r.width.toFixed(1)}px wide`)
    }
    // The answer cards (chat view phase 4, review C1, C2): nothing of what a card asks is cut or out of
    // sight sideways — the whole path, every diff line, the command, the facts, the title
    for (const el of document.querySelectorAll('.chat-card-file, .chat-card-cmd, .chat-card-lines, .chat-card-fact, .chat-card-title')) {
      if (!el.getBoundingClientRect().width) continue
      if (el.scrollWidth > el.clientWidth + 0.5) bad.push(`${name(el)} hides ${el.scrollWidth - el.clientWidth}px of its text sideways`)
    }
    // The instruction box is one box (the lab's widget): its field is not a bordered box drawn
    // inside another bordered box (a card around it)
    const boxed = el => {
      const cs = getComputedStyle(el)
      return ['Top', 'Right', 'Bottom', 'Left'].every(s => parseFloat(cs[`border${s}Width`]) > 0 && !/,\s*0\)$/.test(cs[`border${s}Color`]))
    }
    for (const field of document.querySelectorAll('.w-compose textarea')) {
      if (!field.getBoundingClientRect().width || !boxed(field)) continue
      for (let a = field.parentElement; a && !a.classList.contains('widget'); a = a.parentElement) {
        if (boxed(a)) { bad.push(`${name(field)} is a box inside the box ${name(a)} (the instruction box is one box)`); break }
      }
    }
    return bad
  })
}

/**
 * 업무 모드 problems. The 설정 dialog (.set-backdrop) is left out of the words: settings may
 * speak of the game (src/workMode.ts WORK_MODE_SETTING_TEXT — a passer-by does not open
 * them), so settings-work checks the page around it. Pictures are checked everywhere.
 */
async function workProblems(page) {
  return page.evaluate((src) => {
    const GAME = new RegExp(src, 'i')
    const bad = []
    // The mode is really on: without the class the checks below would pass for nothing
    if (!document.documentElement.classList.contains('work-mode')) bad.push('<html> has no work-mode class: 업무 모드 is not on')
    const pics = document.querySelectorAll('img[src*="/sprites/pokemon"]')
    if (pics.length) bad.push(`${pics.length} Pokémon picture(s), first ${pics[0].getAttribute('src')}`)
    // A session drawn as a picture at all (a Pokémon, or the stand-in ball while it has none)
    const sessionPics = document.querySelectorAll('img.w-row-mon, .w-row img, .w-rail-session img, .w-sess-tab img, .w-sess-head img, .w-party img')
    if (sessionPics.length) bad.push(`${sessionPics.length} picture(s) in session rows / tabs / rail / party, first ${sessionPics[0].getAttribute('src')}`)
    const balls = [...document.querySelectorAll('img[src*="/sprites/spawn-ball"]')].filter(i => { const r = i.getBoundingClientRect(); return r.width > 0 && r.height > 0 })
    if (balls.length) bad.push(`${balls.length} visible Poké Ball stand-in picture(s)`)
    const dialogs = [...document.querySelectorAll('.set-backdrop')]
    const was = dialogs.map(d => d.style.display)
    dialogs.forEach(d => { d.style.display = 'none' })
    const texts = [['text', document.body.innerText]]
    dialogs.forEach((d, i) => { d.style.display = was[i] })
    for (const el of document.querySelectorAll('[title], [aria-label]')) {
      if (el.closest('.set-backdrop')) continue
      for (const attr of ['title', 'aria-label']) { const v = el.getAttribute(attr); if (v) texts.push([attr, v]) }
    }
    for (const [where, text] of texts) {
      for (const line of text.split('\n')) {
        const m = line.match(GAME)
        if (m) bad.push(`"${m[0]}" in ${where}: ${line.trim().slice(0, 90)}`)
      }
    }
    return [...new Set(bad)]
  }, GAME.source)
}

/**
 * Where things sit, to compare a -work shot with its plain twin: the first row's left and width,
 * and with the panel folded every rail item's box (the first slot is the ball, or the empty slot
 * kept for it in 업무 모드), the open sessions one by one
 */
async function firstRowBox(page) {
  return page.evaluate(() => {
    const row = document.querySelector('.w-row')
    const r = row?.getBoundingClientRect()
    const rail = document.querySelector('.w-rail')
    const items = rail ? [...rail.children].flatMap(el => el.classList.contains('w-rail-sessions') ? [el, ...el.children] : [el]) : []
    return {
      left: r?.left ?? null, width: r?.width ?? null,
      rail: rail ? items.map(el => { const b = el.getBoundingClientRect(); return { name: el.className.split(' ').filter(c => c !== 'w-rail-btn' && !c.startsWith('mood-')).join('.') || el.tagName, top: b.top, left: b.left, w: b.width, h: b.height } }) : null,
    }
  })
}

/** Rail items that moved or changed size between the plain shot and its -work twin (the first slot's content may differ, not its box) */
function railMoves(plain, work) {
  if (!plain || !work) return []
  if (plain.length !== work.length) return [`the rail has ${work.length} items in 업무 모드, ${plain.length} without`]
  const out = []
  plain.forEach((a, i) => {
    const b = work[i]
    if (['top', 'left', 'w', 'h'].some(k => Math.abs(a[k] - b[k]) > 0.5)) out.push(`rail item ${i} (${a.name} → ${b.name}) moved: ${a.left},${a.top} ${a.w}×${a.h} → ${b.left},${b.top} ${b.w}×${b.h}`)
  })
  return out
}

async function shoot(browser, s, [W, H], opts, report) {
  const sizeName = `${W}x${H}`
  const label = `${s.id} ${sizeName}`
  const twelve = !!s.twelve
  const noMon = s.noMon ?? 0
  const chat = s.chat ? chatShot(fixture.terminals, s.chat) : null
  const shot = {
    mode: s.mode ?? 'window', workMode: s.work, version: VERSION,
    terminals: chat ? chat.terminals : twelve ? fixture.terminals12 : fixture.terminals,
    board: fixture.board, branches: fixture.branches, history: fixture.history,
    transcript: fixture.transcript, shellTranscript: fixture.shellTranscript,
    ...(chat ? { chat: chat.chat, chatAgent: chat.chatAgent, changes: chat.changes, previews: chat.previews, previewAll: chat.previewAll, screens: SCREENS } : {}),
    // (설정's values laid over the defaults: a surface's appSettings, e.g. 링크 미리보기 on)
    ...(s.appSettings ? { settings: s.appSettings } : {}),
  }
  // (a conversation's wild Pokémon: its game events for the first session, chatFixture.mjs wild)
  const snapshot = withDex(twelve ? fixture.snapshot12 : noMon ? fixture.snapshotNoMon(noMon) : s.plain ? fixture.snapshotPlain : fixture.snapshot, s.chat ? chatFixture.wild(s.chat, shot.terminals[0].sessionId) : null)
  const local = {
    'spawn-carry': JSON.stringify({ view: s.view ?? 'terminal', target: shot.terminals[0].sessionId, ...(chat ? { chatModes: chat.chatModes } : {}) }),
    'spawn-side-hidden': '0',
    // No "what's new" over the page, and every caught species opened but one (the NEW dot)
    'spawn-seen-version': VERSION,
    'spawn-dex-viewed': JSON.stringify(fixture.VIEWED),
    ...(s.local ?? {}),
    ...(opts.side ? { 'spawn-side-w': opts.side } : {}),
    ...(opts.text ? { 'spawn-text-size': opts.text } : {}),
  }
  const ctx = await browser.newContext({
    viewport: { width: W, height: H }, deviceScaleFactor: 1, locale: LOCALE[opts.lang] ?? 'ko-KR', timezoneId: 'Asia/Seoul',
    colorScheme: 'dark', bypassCSP: true, reducedMotion: 'no-preference',
  })
  const result = { id: s.id, size: sizeName, file: null, problems: [], warnings: [], row: null }
  try {
    await ctx.clock.setFixedTime(fixture.NOW)
    const page = await ctx.newPage()
    page.on('pageerror', err => result.warnings.push(`page error: ${err.message.split('\n')[0]}`))
    page.on('response', res => {
      const url = res.url()
      if (/\/sprites\/pokemon\//.test(url) && res.status() !== 200) result.warnings.push(`picture ${url.replace(BASE, '')} answered ${res.status()}${res.status() === 302 ? ` → ${res.headers().location}` : ''}`)
    })
    let wsMessages = 0
    if (s.page !== 'status-card') {
      await page.addInitScript(pageSetup, { shot, local, mac: s.mac, origin: BASE })
      await page.addInitScript({ path: join(HERE, 'fake-bridge.js') })
      // The server's first message on every connection is the snapshot; the page sends
      // nothing first, so it goes out at once, and again for anything the page says
      await page.routeWebSocket(/\/ws$/, ws => {
        const send = () => { wsMessages++; ws.send(JSON.stringify(snapshot)) }
        send()
        ws.onMessage(send)
      })
    }

    if (s.page === 'status-card') {
      await page.goto(pathToFileURL(join(ROOT, 'electron', 'status-card.html')).href + '?step=starting&lang=ko')
      await page.addStyleTag({ content: `html, body { background: ${DESKTOP_BG} !important; }` })
      await page.evaluate(() => document.fonts.ready)
      await page.waitForFunction(() => document.getElementById('msg')?.textContent)
    } else if (s.page === 'qa') {
      await page.goto(`${BASE}/?qa`)
      await page.waitForSelector('.qa-section .w-toast', { timeout: 15_000 })
      await page.evaluate(() => document.fonts.ready)
    } else {
      await page.goto(`${BASE}/?widget&mode=${s.mode ?? 'window'}`)
      await page.addStyleTag({ content: `html { background: ${(s.mode ?? 'window') === 'widget' ? DESKTOP_BG : WINDOW_BG} !important; }` })
      // The fixture is in: a row per terminal, the usage numbers, and (outside 업무 모드) every
      // session drawn as its Pokémon rather than the stand-in ball
      await page.waitForFunction(({ rows, work }) => {
        if (document.querySelectorAll('.w-party .w-row').length !== rows) return false
        if (!document.querySelector('.w-limits:not(.idle) .w-limit:not(.loading)')) return false
        if (!work && [...document.querySelectorAll('img.w-row-mon')].some(i => /spawn-ball/.test(i.src))) return false
        return true
      }, { rows: shot.terminals.length, work: s.work }, { timeout: 15_000 })
      await page.evaluate(() => document.fonts.ready)
      const view = s.work ? 'terminal' : (s.view ?? 'terminal')
      if (s.chat) {
        // The chat view in place of the terminal: its conversation (or its empty state) drawn
        await page.waitForSelector('.chat .chat-row, .chat .chat-empty', { timeout: 15_000 })
        await sleep(400)
      } else if (s.mode !== 'widget' && view === 'terminal') {
        // The terminal in view has replayed its transcript
        await page.waitForSelector('.w-term-body .xterm', { timeout: 15_000 })
        await sleep(600)
      }
      if (s.mode !== 'widget' && view !== 'terminal' && !s.work) {
        if (s.ready) await page.waitForSelector(s.ready, { timeout: 15_000 })
        if (s.click) {
          await page.waitForSelector(s.click, { timeout: 15_000 })
          await page.locator(s.click).first().click()
          await page.waitForSelector('.dex-detail .dex-card', { timeout: 10_000 })
        }
      }
      if (s.settings) {
        await page.locator(`.w-head .w-icon[aria-label="${shown('설정', opts.lang)}"]`).click()
        await page.locator('.set-nav button', { hasText: new RegExp(`^${shown('앱', opts.lang)}$`) }).click()
        await page.waitForSelector('.set-modal', { timeout: 10_000 })
      }
      if (s.open) {
        await s.open(page)
        await page.waitForSelector(s.ready, { timeout: 10_000 })
      }
      // Away from anything hovered (a tooltip or hover tools would differ run to run)
      await page.mouse.move(W - 1, H - 1)
    }
    await imagesSettled(page)
    await sleep(250)
    if (s.page !== 'status-card' && !wsMessages && s.page !== 'qa') result.warnings.push('the page never opened its WebSocket')

    // The picture
    let buf
    if (s.clip) buf = await page.locator(s.clip).first().screenshot({ animations: 'disabled', caret: 'hide' })
    else buf = await page.screenshot({ fullPage: !!s.fullPage, animations: 'disabled', caret: 'hide' })
    const { w, h } = pngSize(buf)
    const file = join(opts.out, `${s.id}-${s.clip || s.fullPage ? `${w}x${h}` : sizeName}${opts.side ? `-side${opts.side}` : ''}${opts.text ? `-ts-${opts.text}` : ''}${opts.lang ? `-${opts.lang}` : ''}.png`)
    writeFileSync(file, buf)
    result.file = file
    // (chat-off: where a take may differ by a frame, measured in this page)
    if (opts.noise) result.noise = await page.evaluate(NOISE_AREAS)

    // The checks, in the same page
    if (opts.checks.has('fit')) result.problems.push(...(await fitProblems(page)).map(p => `fit: ${p}`))
    // 기록's time column: the widest time against the column (a note, for the record)
    if (opts.checks.has('fit')) {
      const col = await page.evaluate(() => { const els = [...document.querySelectorAll('.today-time')]; if (!els.length) return null; const range = document.createRange(); let w = 0, text = ''; for (const el of els) { range.selectNodeContents(el); const r = range.getBoundingClientRect().width; if (r > w) { w = r; text = el.textContent.trim() } } return { text, w: Math.round(w * 10) / 10, col: els[0].clientWidth } })
      if (col) result.notes = [`기록's time: widest "${col.text}" ${col.w}px in a ${col.col}px column`]
    }
    if (opts.checks.has('work') && s.work) result.problems.push(...(await workProblems(page)).map(p => `work: ${p}`))
    if (opts.checks.has('work')) result.row = await firstRowBox(page)
  } catch (err) {
    result.problems.push(`shot failed: ${String(err.message).split('\n')[0]}`)
  } finally {
    await ctx.close()
  }
  report.push(result)
  const mark = result.file && !result.problems.length ? 'ok ' : 'BAD'
  console.log(`${mark} ${label}${result.file ? `  → ${result.file}` : ''}`)
  for (const p of result.problems) console.log(`      ${p}`)
  for (const wmsg of [...new Set(result.warnings)]) console.log(`      (warning) ${wmsg}`)
  for (const n of result.notes ?? []) console.log(`      (note) ${n}`)
}

// ---------------------------------------------------------------- sheets

function findShot(dir, surface, size) {
  if (!existsSync(dir)) return null
  if (size) { const f = join(dir, `${surface}-${size}.png`); return existsSync(f) ? f : null }
  const names = readdirSync(dir).filter(n => new RegExp(`^${surface.replace(/[-]/g, '\\-')}-\\d+x\\d+\\.png$`).test(n)).sort()
  const preferred = names.find(n => n.endsWith('-1440x900.png'))
  return preferred ? join(dir, preferred) : names[0] ? join(dir, names[0]) : null
}

async function sheet(browser, surface, opts) {
  const before = findShot(resolve(opts.out, '..', '00-before'), surface, opts.size)
  const after = findShot(opts.out, surface, opts.size)
  if (!after) return `${surface}: no after shot ${surface}-${opts.size ?? '*'}.png in ${opts.out} (take the shots first)`
  const size = /-(\d+x\d+)\.png$/.exec(after)[1]
  const labName = labRef(surface, size)
  const lab = labName && existsSync(join(LAB, labName)) ? join(LAB, labName) : null
  const dataUrl = f => `data:image/png;base64,${readFileSync(f).toString('base64')}`
  const { w, h } = pngSize(readFileSync(after))
  const stacked = w > h
  const col = (title, file, note) => `<figure><figcaption><b>${title}</b> ${note}</figcaption>${file ? `<img src="${dataUrl(file)}">` : '<div class="none">none</div>'}</figure>`
  const html = `<!doctype html><meta charset="utf-8"><style>
    body { margin: 0; background: #2a2c33; color: #e8e9ee; font: 14px/1.4 system-ui, sans-serif; }
    main { display: flex; flex-direction: ${stacked ? 'column' : 'row'}; gap: 16px; padding: 16px; align-items: flex-start; width: max-content; }
    figure { margin: 0; } figcaption { margin: 0 0 6px; color: #b9bcc6; } figcaption b { color: #fff; }
    img { display: block; ${stacked ? 'width: 1440px;' : ''} outline: 1px solid #555; }
    .none { width: ${stacked ? 1440 : w}px; height: 120px; display: grid; place-items: center; outline: 1px dashed #666; color: #999; }
  </style><main>
    ${col('before', before, before ? before.split(/[\\/]/).slice(-2).join('/') : '(no 00-before shot)')}
    ${col('lab', lab, lab ? labName : '(no lab reference for this surface)')}
    ${col('after', after, after.split(/[\\/]/).slice(-2).join('/'))}
  </main>`
  const page = await browser.newPage({ viewport: { width: 800, height: 600 }, deviceScaleFactor: 1 })
  try {
    await page.setContent(html)
    await page.evaluate(() => Promise.all([...document.images].map(i => i.decode().catch(() => {}))))
    const file = join(opts.out, `sheet-${surface}${opts.size ? `-${opts.size}` : ''}.png`)
    await page.locator('main').screenshot({ path: file })
    console.log(`ok  sheet ${surface} ${size}  → ${file}`)
    return null
  } finally {
    await page.close()
  }
}

// ---------------------------------------------------------------- main

/** The newest modification time of any file under dir (0 when there is none) */
function newestIn(dir) {
  let newest = 0
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name)
    newest = Math.max(newest, entry.isDirectory() ? newestIn(p) : statSync(p).mtimeMs)
  }
  return newest
}

/** dist/ built before the last change under src/: the shots would show the old UI */
function warnIfStale() {
  const built = statSync(join(DIST, 'index.html')).mtimeMs
  if (newestIn(join(ROOT, 'src')) > built) console.warn('shots: (warning) stale dist: src/ changed after the last build — run npx vite build')
}

async function main() {
  const opts = parseArgs(process.argv.slice(2))
  if (opts.help) { console.log(USAGE); return 0 }
  mkdirSync(opts.out, { recursive: true })
  const { chromium } = await loadPlaywright()

  if (opts.sheets.length) {
    const { browser } = await launchBrowser(chromium)
    try {
      const errors = []
      for (const s of opts.sheets) { const e = await sheet(browser, s, opts); if (e) { errors.push(e); console.log(`BAD ${e}`) } }
      return errors.length ? 1 : 0
    } finally {
      await browser.close()
    }
  }

  if (!existsSync(join(DIST, 'index.html'))) fail(`dist/index.html is missing: run \`npx vite build\` first`)

  // Which shots: the asked surfaces (all by default), each at its sizes; --check work also
  // needs each -work surface's plain twin to compare the first row with
  // --flow alone (no --only, no --check) runs the flow without taking every shot first
  const ids = new Set(opts.only ?? (opts.flows.length && !opts.checks.size ? [] : ALL_IDS))
  if (opts.checks.has('work')) for (const id of [...ids]) if (parseId(id).work) ids.add(id.replace(/-work(-mac)?$/, '$1'))
  const jobs = []
  for (const id of ids) {
    const s = parseId(id)
    for (const size of s.sizes ?? SIZES) if (!opts.size || opts.size === `${size[0]}x${size[1]}` || s.sizes) jobs.push([s, size])
  }
  // A work check with no 업무 모드 shot would check nothing and pass
  if (opts.checks.has('work') && !jobs.some(([s]) => s.work)) {
    fail(`--check work needs at least one -work surface (${ALL_IDS.filter(id => id.includes('-work')).join(' ')}); none is in this run`)
  }
  warnIfStale()

  // The browser first: if none starts, no server was started to leave behind
  const { browser, name } = await launchBrowser(chromium)
  let server = null
  const report = []
  try {
    server = await startServer()
    console.log(`spawn ${VERSION} · ${name} · ${BASE} · ${jobs.length} shot(s) → ${opts.out}`)
    for (const [s, size] of jobs) await shoot(browser, s, size, opts, report)
    for (const f of opts.flows) {
      flowPageErrors.length = 0
      const problems = await FLOWS[f]({ browser, opts, fixture, BASE })
      problems.push(...new Set(flowPageErrors))
      report.push({ id: `flow ${f}`, size: '', file: 'flow', problems, warnings: [] })
      console.log(`${problems.length ? 'BAD' : 'ok '} flow ${f}`)
      for (const p of problems) console.log(`      ${p}`)
    }
  } finally {
    stopServer()
    await browser.close().catch(() => {})
  }

  // 업무 모드 keeps the rows where they were
  if (opts.checks.has('work')) {
    for (const r of report.filter(x => parseId(x.id)?.work)) {
      const twin = report.find(x => x.id === r.id.replace(/-work(-mac)?$/, '$1') && x.size === r.size)
      if (!r.row || !twin?.row) continue
      const moved = railMoves(twin.row.rail, r.row.rail).map(m => `work: ${m}`)
      if (Math.abs(r.row.left - twin.row.left) > 0.5 || Math.abs(r.row.width - twin.row.width) > 0.5) {
        moved.unshift(`work: the first row moved: left ${twin.row.left} → ${r.row.left}, width ${twin.row.width} → ${r.row.width}`)
      }
      if (moved.length) {
        r.problems.push(...moved)
        console.log(`BAD ${r.id} ${r.size}\n      ${moved.join('\n      ')}`)
      }
    }
  }

  const bad = report.filter(r => !r.file || r.problems.length)
  console.log(`\n${report.length - bad.length} of ${report.length} passed${bad.length ? `; failed: ${bad.map(r => `${r.id} ${r.size}`.trim()).join(', ')}` : ''}`)
  return bad.length ? 1 : 0
}

main().then(code => process.exit(code), err => { console.error(err); process.exit(1) })
