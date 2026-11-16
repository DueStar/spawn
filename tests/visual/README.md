# Screenshot harness

Shots of the real built UI (`dist/`) with fixture sessions, to compare each restyle with the design lab.

    npx vite build
    node tests/visual/shots.mjs --out <dir> [--only session,dex] [--size 1100x720] [--check fit --check work]
    node tests/visual/shots.mjs --sheet session --out <dir>     # before | lab | after → <dir>/sheet-session.png
    node tests/visual/shots.mjs --flow tabs-gone                # close / rename / drag / switch without the tab row
    node tests/visual/shots.mjs --only session --side 240 --out <dir>   # the left panel at 240px (files end in -side240)
    node tests/visual/shots.mjs --only dex --text xlarge --check fit --out <dir>   # at a text step (files end in -ts-xlarge)
    node tests/visual/shots.mjs --flow side-resize              # drag / double-click / keys on the left panel's edge
    node tests/visual/shots.mjs --flow text-size [--out <dir>]  # the text step: migration, keys, wheel, − 가 +, its menu, 설정
    node tests/visual/shots.mjs --only log --lang ja --check fit --out <dir>     # in English or Japanese (files end in -en / -ja)
    node tests/visual/shots.mjs --flow narrow [--out <dir>]     # 560 / 640 wide, Windows and Mac, panel open and folded: the top bar fits; a step change re-measures
    node tests/visual/shots.mjs --flow hit-areas [--out <dir>]  # every touched control's size vs main's (0dbb6c9), each its own floor (HIT_BEFORE_RUN=1: measure only)
    node tests/visual/shots.mjs --flow keyboard                 # the list's rows and the text-size menu from the keyboard; the rows' names for a screen reader
    node tests/visual/shots.mjs --flow seg-hover                # a hovered option looks unlike the chosen one (도감, 박스, 랭킹, 설정)
    node tests/visual/shots.mjs --only resume,throw,swap,notes,find --out <dir>   # dialogs opened by a click
    node tests/visual/shots.mjs --only chat,chat-banner,chat-work --check fit --check work --out <dir>   # the chat view's surfaces
    node tests/visual/shots.mjs --flow chat-flip --flow chat-banner --flow chat-unarmed --flow chat-long   # 채팅 / 터미널, the banner, an unarmed session, 2000 items
    node tests/visual/shots.mjs --flow chat-off --out <dir>     # off = 1.4.0: no flip, no chat code; session ×2, session-work ×2, session-mac vs <dir>/../00-before/
    node tests/visual/shots.mjs --flow chat-scroll --flow chat-wait --flow chat-focus --flow chat-robust   # the chat view's review fixes
    node tests/visual/shots.mjs --only chat-compose,chat-compose-fail,chat-compose-pending --check fit --out <dir>   # the composer (phase 3)
    node tests/visual/shots.mjs --flow chat-send --flow chat-send-ime --flow chat-send-multiline --flow chat-send-double   # sending, the IME
    node tests/visual/shots.mjs --flow chat-send-refuse --flow chat-queue --flow chat-stop --flow chat-image   # refusals, the queue, 멈추기, images
    node tests/visual/shots.mjs --flow chat-side-box --flow chat-compose-focus --flow chat-compose-grow   # the side box's pointer, the focus, the growing draft
    node tests/visual/shots.mjs --only chat-ask-bash,chat-ask-edit,chat-ask-agent,chat-ask-question,chat-ask-plan,chat-ask-timeout --check fit --out <dir>   # the answer cards (phase 4)
    node tests/visual/shots.mjs --flow chat-allow --flow chat-always --flow chat-deny --flow chat-ask-enter --flow chat-ask-timeout   # answering, and never by a stray key
    node tests/visual/shots.mjs --flow chat-ask-terminal-first --flow chat-question --flow chat-question-hidden --flow chat-plan --flow chat-ask-a11y
    node tests/visual/shots.mjs --only chat-ask-longpath,chat-ask-longline,chat-ask-sandbox,chat-ask-overwrite,chat-ask-long --check fit --out <dir>   # the review of phase 4: what a card shows whole
    node tests/visual/shots.mjs --flow chat-ask-gate --flow chat-ask-guard --flow chat-ask-wrap --flow chat-ask-facts --flow chat-ask-retry --flow chat-ask-order
    node tests/visual/shots.mjs --flow chat-reload-size         # 7-48: the shown chat's hidden terminal fitted (warm mount), one chat.redraw only when it replayed first
    node tests/visual/shots.mjs --only chat-changes,chat-changes-missing,chat-changes-empty,chat-changes-1100,chat-changes-work --check fit --check work --out <dir>   # the 변경 사항 panel (phase 5)
    node tests/visual/shots.mjs --flow chat-changes --flow chat-changes-fold --flow chat-changes-terminal --flow chat-changes-widget
    node tests/visual/shots.mjs --only chat-thinking,chat-all,chat-thinking-work,chat-all-work --check fit --check work --out <dir>   # density (phase 5), seeded
    node tests/visual/shots.mjs --flow chat-density   # 보기 정도 by keyboard, remembered; 전부 over chat-long holds the view; the waiting row in each level
    node tests/visual/shots.mjs --only chat-foot,chat-foot-work --check fit --check work --out <dir>   # the turn summary (phase 5): GET /pokedex routed (10, then 18 steps)
    node tests/visual/shots.mjs --flow chat-foot      # the foot's 복사; no read at load; 8걸음 1.5 s after a watched turn; none after a reload or in 업무 모드
    node tests/visual/shots.mjs --only chat-wild,chat-wild-work --check fit --check work --out <dir>   # wild Pokémon (phase 5): the game's events in the snapshot (chatFixture.mjs wild)
    node tests/visual/shots.mjs --flow chat-wild      # a pushed pokedex catch of the shown session: one row with appear; none at load, after a reload or in 업무 모드
    node tests/visual/shots.mjs --only chat-find --check fit --out <dir>   # find in the conversation (phase 5): the bar open on a query, the matches in grey (also --lang en / ja)
    node tests/visual/shots.mjs --flow chat-find      # Ctrl+F (and ⌘F on the Mac) opens it, Esc gives the focus back; a hit 1,500 rows up placed and painted; a hit in a closed group opens it; the terminal's own Ctrl+F
    node tests/visual/shots.mjs --flow chat-perf      # (phase 6) the page's budgets over a 5,000-item reset: first rows, scrolling, 기본 → 전부, find far up (numbers printed)
    node tests/visual/shots.mjs --flow chat-soak      # (phase 6) 20,280 streamed pushes: heap after gc, DOM nodes, blob: URLs, listeners (a few minutes; SOAK_ROUNDS=<n> for a shorter run)

    node tests/visual/shots.mjs --only chat-link,chat-link-work,chat-link-mac --check fit --check work --out <dir>   # link preview cards (phase 5): 링크 미리보기 seeded on, the lab's MDN card
    node tests/visual/shots.mjs --flow chat-preview-off --flow chat-preview   # off: no chat.preview, no card, no request; on: only rows drawn ask, blob: URLs revoked

  The `chat-off` baselines come from release 1.4.0's own build and harness: `git worktree add --detach <tmp> cff52ac`, link its
  `node_modules` to this checkout's, copy `tests/visual/.home/sprites`, `npx vite build` there, then
  `node tests/visual/shots.mjs --only session,session-work,session-mac --out <dir>/../00-before`; remove the link, then the worktree.
  Without them the flow fails (it never passes without comparing).
    node tests/visual/shots.mjs --help                          # every option and surface id

- `fixture.mjs` — the four lab sessions + a shell (and a twelve-session set), usage 46 % / 82 %, the game,
  and five past sessions for 이어하기 (one open in the app, one running elsewhere). `snapshotPlain` is the same
  with nobody waiting: the `widget-plain` surface (no question card), compared with the lab's widget.
- `fake-bridge.js` — `window.spawn` for the page (an update on offer with `shot.update`); records `move/close/rename/create/send/write` in `window.__CALLS__`,
  and the chat view's `chat.open/close/older/reload/agent`. `chat.open` answers with `shot.chat[id]` (a `reset`); `window.__CHAT_PUSH__(id, ops)` sends the next update.
  The answer cards' calls (`chat.answer`, answered from `__CHAT_SCRIPT__.answer`, else ok; `chat.visible`) are recorded too.
  The composer's calls (`chat.send/submit/interrupt/image/dropImage/files`) are recorded too (an image as its size and first
  bytes) and answered from `window.__CHAT_SCRIPT__` (`{ send, submit, interrupt, image, files }`: a value, or `'hang'` for an
  answer that never comes), else as main answers a send that goes through (`submit` refuses an echo other than `ok`).
  `window.__SCREEN__(id, name)` writes a fixture screen (`tests/fixtures/chat/screens/<name>.txt`) into that terminal's real
  xterm, rules as wide as its columns and long lines wrapped as Claude Code wraps them, so the page's `termText()` reads a
  real buffer (a terminal never fitted has xterm's 80 columns; since Task 5.2 the shown chat session's terminal fits once,
  warm under the chat, so it has the box's columns). `chat.redraw` (7-48) is recorded and answered from `__CHAT_SCRIPT__.redraw`,
  else ok. A flow may add its own init script (`openApp(…, { init })`, e.g. a page hidden while its terminals mount).
  The 변경 사항 panel's `chat.changes` / `chat.changeFile` (phase 5) are recorded and answered from `__CHAT_SCRIPT__.changes` /
  `.changeFile` when set, else from `shot.changes[id]` (`chatFixture.mjs changes()`: the real `electron/chatChanges.cjs` index over
  `changes.jsonl` and its sub-agent, each file's page re-read with the real `readEdit`).
  The link preview cards' `chat.preview` (phase 5) is recorded and answered from `__CHAT_SCRIPT__.preview`, else from
  `shot.previews[url]` (`chatFixture.mjs previews()`: the image's bytes a plain array in the shot, handed on as a `Uint8Array`
  as main does), else a made-up card for any `https://*.example/` link when `shot.previewAll` (chat-link-long), else
  `{ ok: false }`. `shot.settings` lays 설정's values over the defaults (`openApp(…, { settings })`, a surface's `appSettings`).
- `chatFixture.mjs` — the chat view's conversations (`chat`, `chat-long`, `chat-tools`, `chat-diff`, `chat-failed`, `chat-agent`,
  `chat-stream`, `chat-waiting`, `chat-banner`, `chat-empty`), built by the real `electron/chatItems.cjs` from the redacted
  transcript fixtures (`tests/fixtures/chat/`) and a few made-up lines in the same shape. A chat surface arms every Claude Code
  terminal (`TerminalInfo.chat`), picks 채팅 for the first session in the carry, and compares with `s2-chat-detail.png`
  (`chat-work`: `s2-work-chat.png`; 1100×720: `s2-chat-1100.png`).
- The repo's server runs on port 3397 with `SPAWN_HOME=tests/visual/.home` (git-ignored) only to serve `dist/` and
  the Pokémon pictures (fetched once, cached there). The page's WebSocket is answered with the fixture, never the server.
- playwright-core comes from `PLAYWRIGHT_CORE` (default: the spawn-promo copy in the user's Documents); the browser is its Chromium, else Edge, else Chrome (`SHOTS_BROWSER` = an executable overrides).
- Pages run at 2026-11-14 14:30 Seoul time, `ko-KR`, with a seeded `Math.random`: a rerun gives the same pictures.
- Exit code 0 only when every shot was written and every check passed. No Electron, nothing of the owner's is read.
