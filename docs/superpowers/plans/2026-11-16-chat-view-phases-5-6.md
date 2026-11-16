# Chat View, Phases 5 and 6: the Changes Panel, Previews, and Hardening — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Phase 5 (Tasks 5.1–5.12) is finished, reviewed and tried on a real session before Phase 6 (Tasks 6.1–6.11) starts.

**Goal, Phase 5.** The chat view gets the rest of what the lab shows. A **변경 사항** panel on the right lists every file this conversation changed (a tree with `+N −N`) and shows the selected file's diffs, built only from what the transcript recorded. Http(s) links in assistant prose can get a **link preview card**, fetched by the app under strict rules, and **off unless the user turns it on**. Each finished turn ends in a quiet **turn summary** (duration · tools · files changed · 걸음, plus the answer's copy action). **Wild-Pokémon rows** appear where they happened, from the game's own events. A **density** control (기본 / 생각 포함 / 전부) and an in-conversation **find** (Ctrl/⌘+F) work over the store, not the DOM. And the open defect of 7-48 is fixed without editing `TerminalPanel.tsx`: after a widget ↔ window swap or a reload, the hidden terminal of a session shown as chat gets its real size, so the composer reads the prompt row again.

**Goal, Phase 6.** The feature holds up: measured budgets for a 5,000-item conversation, a 300 MB transcript and an hour of streaming; a clear story for a Claude Code newer than the verified range; complete and fitting en/ja; a keyboard-only and screen-reader pass; a privacy pass; failure drills; the Mac variants; the portfolio records and screen archive of Phases 2–6; the docs and a short help text in 설정; and a final whole-branch review. **The feature stays a preview**: `features.json` `chatView` stays true in this branch, 설정 › 세션 › 채팅으로 보기 stays off by default, and nothing in this plan merges, pushes or releases.

**Both phases** stay behind the flag and the setting. With either off, and whenever a session's terminal is the shown view, the app behaves as release 1.4.0. The only difference in the terminal view is the 채팅 · 터미널 flip that Phase 2 already added.

**Architecture.**

*The changes panel reads the whole conversation, not the page's window of it.* The page keeps at most 4000 items and loads older pages only on demand, so a panel built from the page's items would undercount a long session. That would be wrong information. The worker (Phase 2's lens) therefore keeps a **change index** per open view (`electron/chatChanges.cjs`). It scans the current transcript once, forward, in the background, with yields; it parses only lines that can hold an edit, and it follows live lines through the lens's own `ingest`. It also scans the sub-agents' own transcripts. The index holds counts and byte offsets only, never diff text. When the user selects a file, the worker re-reads the result lines at those offsets (guarded like the tailer) and rebuilds each edit's diff with Phase 2's `buildDiff`. Edits of one file are shown **in order, never merged**: composing patches would need file contents the transcript does not hold. A missing or cut patch is said, never filled. A summary (`status.changes`) feeds the header's `+N −N`.

*Link previews are fetched by the chat worker, never by the page and never in main's own thread.* `electron/linkFetch.cjs` is the policy and the transport. It allows only http/https on ports 80/443, rejects userinfo and local names, resolves DNS first, checks every address against a `net.BlockList` of private, loopback, link-local, CGNAT, metadata and special ranges (IPv4 and IPv6, mapped and embedded forms included), and then connects to the checked address through a pinned `lookup`, so a DNS rebind cannot slip in. Redirects are handled by hand, at most 3, each one re-checked. It sends no cookies, no referrer and no credentials, with a fixed neutral user agent. It enforces time, size and decompression caps. It reads meta tags with a small tolerant scanner (no DOM, nothing executed). For an image it checks the magic bytes, reads the dimensions from the header, and caps pixels and bytes. `electron/linkPreview.cjs` adds the bounded memory cache, the concurrency and the queue. The page gets `{ title, description, site, image bytes }` and shows the image from a `blob:` URL it made itself (decoded in the sandboxed renderer), never a remote `src`. Previews are opt-in (`session.linkPreviews`, off).

*The hidden terminal's size (7-48) is fixed in `Widget.tsx` and main, not in `TerminalPanel.tsx`.* `TerminalView` fits only while it is shown (`active`) and the document is visible. A session shown as chat therefore mounts its terminal hidden: the replay is written at xterm's default 80×24, and the pty, still at its real size, never makes Claude Code redraw. **Warm mount** gives the shown chat session's `TerminalView` `active` (with `focus={false}`) under the opaque chat pane until it has fitted once while visible, then hands it back. That is the same first fit the on-screen terminal gets in 1.4.0, before the replay arrives. In the remaining case (the terminal was first mounted hidden: a background session at page load, or a window built hidden before a widget → window swap), the page asks main for **one redraw nudge**: the pty is resized to `rows − 1` and, 150 ms later, back to `rows`. That is the same thing the trials did to recover ("창 크기를 조금 바꾸기", 7-48 and 7-49). It writes no byte to the pty's input. See "The hidden terminal's size" below.

*Turn summaries, wild rows, density and find are page work over the store.* `rows.ts` gains row kinds (`foot`, `wild`, `thinking`), a density option and the `extra` timeline its Phase 2 seam reserved. Steps come from two reads of the game server's existing read-only `GET /pokedex` that bracket a turn. A step count is shown only when the two reads prove it exact. Wild rows come from the `catch` / `flee` events the page already receives (`DexState.log` / `today`). Find searches plain text extracted from the items. It scrolls with `ChatList.scrollToKey`, opens the collapsed row a match lies in, and paints matches with the CSS Custom Highlight API, so no markup is rewritten.

**Tech Stack:** as Phases 2–4. Electron 33 main and the chat worker (CommonJS, `worker_threads`, `http`, `https`, `dns`, `net.BlockList`, `zlib`), React 18 + TypeScript + Vite, plain CSS on the 차분하게 2 tokens, vitest (node: pure functions, temp-dir IO, a real worker, real 127.0.0.1 sockets, fake timers, source checks), the harness `tests/visual/shots.mjs`. **No new runtime dependency** (Decision 1).

**Spec and inputs:** `docs/superpowers/specs/2026-11-13-chat-view-design.md` (Phases 5 and 6; "The chat view's parts"; link preview cards; Constraints; Anti-goals). The Phase 2 plan `docs/superpowers/plans/2026-11-15-chat-view-phase-2.md` (event model, IPC, worker protocol, "Seams for Phases 3–5", Decision 10 "nothing new animates"). The Phase 3–4 plan `docs/superpowers/plans/2026-11-15-chat-view-phases-3-4.md` ("Seams for Phase 5", the send and hold tables, the trial set-up). `docs/HANDOFF.md` 7-46 … 7-49 (7-48 "아직 이상한 것": the 80×24 defect; 7-49 ①). The reviews' seams: `.superpowers/sdd/2026-11-15-chat-view-phase-2/review-11-17.md` "Seams for the next phases" (find searches the store and needs `scrollToKey`; density needs a per-density `ESTIMATE` / `tight` table; link cards need stable block keys: `blockKeys` exists now), `review-1-10.md` I3 (the diff truncation flag the panel relies on, now `DiffBlock.truncated` / `hidden`), `review-phase-4.md`. The spike's `spike/spawn-chat-view-spike-keep/chat-lens/FINDINGS.md` §1 ("Thinking text is empty"; one line per content block). The spike stays untracked. The look: `~/Documents/spawn-site-lab/calm-lab/`: `shots-v5/s2-chat-panel.png` (changes panel, link card, turn foot, wild row, header controls), `s2-chat-detail.png`, `s2-chat-1100.png`, `s2-work-chat.png`, `s2-size-*-chat.png`; `app.css` 223–230 (`.og`), 232–235 (`.think`, density), 253–254 (`전부` opens rows), 264–274 (`.wild`, its one animation), 382–402 (menus, `.dens`, `.chg`), 417–440 (`.changes`, tree, diff), 453–454 (narrow: side folds to the rail with the panel on), 564–573 (tight; reduced motion), 660–663 (`.turn-foot`, `.tf-copy`), 769–779 (`.rz` resize handles), 800 (업무 모드 hides `.wild`, `.turn-foot .steps`); `app.js` 261–268 (density menu, changes button), 386–401 (og card, turn foot, wild row), 490–501 (`changesHtml`), 610–640 (widths 260–560 / 240–420, remembered; `narrow` < 1240, `tight` < 1200). Open the lab files; do not guess a value.

## Global Constraints

The constraints of Phases 2–4 hold unless a line below changes them. The ones repeated here are the ones each task must check again.

- Work only in the worktree `~/Documents/spawn-chat-view` (branch `chat-view`). Never push, never merge, never release, never build an installer. Never read or write `~/.claude` (tests set `CLAUDE_CONFIG_DIR` to a temp dir), `~/.spawn`, `%APPDATA%\spawn`, `%APPDATA%\spawn-dev` or the owner's running app. The real `claude` runs only in the two trial tasks (5.12, 6.10), each with the controller's go-ahead and in an isolated copy. The owner's PC is never put to sleep, its clock is never changed, and its disk is never filled.
- **Off means 1.4.0.** With `chatView` false or the setting off: no chat hook entries (`session-settings.json` byte-identical, pinned), no endpoint, no worker, no index, no preview fetch, no `GET /pokedex` from the chat, no `chat:redraw`, and no new key in `TerminalInfo`. The terminal view of a session (the flip on 터미널) is 1.4.0 apart from Phase 2's flip: the density, changes and find controls exist only while the chat is shown, and the panel lives inside the chat's own pane, so the terminal's box never changes because of them (`--flow chat-changes-terminal`).
- **Wrong or stale information is the worst failure.** The changes panel never shows a line the transcript did not contain and never merges edits. An edit whose patch is missing says so (`이 수정의 내용은 기록에 없어요`), and one cut by a cap says so (`잘림`, `{n}줄은 터미널에서 보세요`). File totals are labelled as sums of edits. Files changed by commands (Bash, PowerShell, a formatter, git) are not in the transcript's edits, and the panel says so in a fixed line. A turn summary never shows a count it cannot know: it omits counts for a turn whose start is not loaded, and it omits steps unless two reads bracket the turn exactly. A wild row appears only for an event the server reported for this session within this conversation's time.
- **Link previews are opt-in and safe by construction.** Every rule in "Link preview policy" is a hard requirement with its own test, and each SSRF case named by the controller has a test. Fetching happens only in the chat worker. Nothing is fetched while the setting is off, for a link in code, tool output, a user message, a live bubble or a partial answer, or for a row not rendered. Every failure is silent: the plain link stays. Caches live in memory only. The test-only loopback switch is read only when `!app.isPackaged` (source-guarded).
- **The chat sends only what the user wrote.** The Phase 3 send rules (`src/chat/send.ts`, `chatHost.cjs` `send` / `submit` / `interrupt`, `chatInput.cjs`) and the Phase 4 answer rules (`chatHolds.cjs`, `chat:answer`, `src/chat/answer.ts`) are not edited. The new `chat:redraw` resizes; it never writes to a pty. A guard pins that `terminals.redrawForChat` is called only from `chatHost.cjs` `redraw`, and that it calls only `pty.resize`.
- **The terminal is untouched.** `src/components/TerminalPanel.tsx`, `src/keys.ts`, `src/termFont.ts`, `src/textSize.ts`, `server/`, `hooks/`, `scripts/`, the updater and signing files, `package.json` and the lock file are not edited. `src/termMetrics.ts` gains one read-only function (`termSize`). `GET /pokedex` is an existing read-only route, used as it is.
- **Look (차분하게 2).** Hairlines, not fills; weights 400/500; radii 3/4/6/8; literal font stacks; every size from `--t-*`; contrast ≥ 4.5:1 body and ≥ 3:1 secondary on every background used. **Yellow stays in the send button only**: the selected file, the density choice and the current find match use `--sel-bg`-style greys. The **only new colour and the only new motion** are the wild-Pokémon row (Pokémon art, a ball, the tier colour of a rare one, and one entry animation for a row that arrives while the view is open) and the turn summary's step count (the paw glyph). Both live in `src/styles/chat-game.css`, so `chat.css` keeps its "no animation" guard. Every animation stops under `prefers-reduced-motion`.
- **업무 모드:** no wild rows, no steps, no Pokémon picture or name anywhere new. "에이전트" and the neutral glyph. The game words live in a new `src/locales/chatGame.ts`, which `tests/work-mode.test.ts` keeps out of anything rendered in work mode. `src/locales/chat.ts` stays free of `GAME_WORDS`.
- **Text size:** every new size reads `--t-prose`, `--t-ui`, `--t-meta`, `--t-micro`, `--t-code`.
- **ko / en / ja for every string.** Neutral strings go in `src/locales/chat.ts`, game strings in `src/locales/chatGame.ts`, settings in `src/locales/settings.ts`.
- **macOS:** the same code. Keys go through `appShortcut` (⌘F) and tooltips through `modCombo()`. No new window drag region: `-webkit-app-region: no-drag` on the header's new controls and on the panel's resize handle.
- **Accessibility:** every control has a name; the panel's tree is `role="tree"` with arrow keys; the resize handle is `role="separator"` with `aria-valuenow`/min/max and ←/→/Home; find is `role="search"`, its count `aria-live="polite"`; hit areas ≥ 22px; DOM order is visual order (header controls → list → answer surface → composer → panel).
- **Memory and storage:** new localStorage keys are only `spawn-chat-density`, `spawn-changes-w` and `spawn-changes-open`. Each holds a word or a number, never transcript text. Per-session page state (the selected file, step samples, the wild rows seen, find) lives in memory and is let go through `onChatForget`.
- Green before every commit, from Git Bash in the worktree: `npx vitest run`, `npx tsc --noEmit -p .`, `npx vite build`. UI tasks also run the harness checks they name.
- One commit per task (or per step that says "Commit"). Each message ends with the trailer line `Claude-Session: https://claude.ai/code/session_01LECh1AuSxY28Be3QgsqBWD`.
- **Out of scope (seams kept):** the todo chip ("할 일 3/5"), the `/` menu, "다시 보내기", "고쳐 달라고 하기", suggested prompts, syntax colouring, git status in the panel ("커밋 안 함": nothing the app reads knows it), favicons in link cards, plan answers, making chat the default view, merging to main.

## Review Focus

Ordered by how likely each is to hurt the user, most likely first. Each has its check in the owning task.

**Phase 5**
1. **The changes panel shows something the conversation did not contain**: merged edits, a missing patch drawn as empty, a file changed by a command shown as unchanged, an undercount in a long session, a stale re-read after a rewrite. → Tasks 5.3 (index tests: order, missing, cut, failed edits excluded, sub-agents, offsets re-read and checked, the whole file scanned), 5.4 (the words, the fixed Bash line, `chat-changes-*` flows).
2. **A link preview reaches something it must not**, or tells a site something while off. → Task 5.9 (every SSRF case, caps, redirects, bombs; no request at all when refused) and Task 5.10 (off = no IPC, no fetch; only rendered prose links; the loopback switch guarded).
3. **The 7-48 fix disturbs the terminal**: focus stolen, a visible flash, an extra resize while the terminal is shown, a nudge while the user types or a send is in flight. → Task 5.2 (`termWarm` tests, `redrawForChat` tests with fake timers, `--flow chat-reload-size`, `--flow chat-off`), trial 5.12.
4. **A turn summary or a wild row says something untrue**: steps of the wrong turn, counts of a half-loaded turn, an event of another session. → Tasks 5.6, 5.7.
5. **Find or density breaks the virtual list**: jumps, a lost anchor, focus lost, the permission wait folded. → Tasks 5.5, 5.8.

**Phase 6**
1. **A long session is slow or grows without bound.** → Task 6.1 (budgets, perf suite, soak).
2. **A newer Claude Code silently changes what the chat shows.** → Task 6.2.
3. **Something private leaks to a log, a dump, storage or disk.** → Task 6.5.
4. **A failure strands the user** (worker gone, file gone, disk full, sleep with a hold open). → Task 6.6.

---

## File map

| File | After this plan |
|---|---|
| `src/chat/types.ts` | + `ThinkingItem`, `ChangeSummary`, `ChangeFile`, `ChangeEdit`, `LinkCardData`, `LensStatus.changes` |
| `electron/chatItems.cjs` | `thinking` / `redacted_thinking` blocks → `thinking` items (text capped, often empty; `durationMs` from the line's `thinkingDurationMs`) |
| `electron/chatChanges.cjs` (new) | The change index (pure), the forward scan, the re-read of one edit by offset |
| `electron/chatLens.cjs`, `electron/chatWorker.cjs` | Index per open view; `changes`, `change-file`; `status.changes`; the preview service hosted in the worker |
| `electron/linkFetch.cjs` (new) | URL and address policy, pinned-address fetch, redirects, caps, decompression, meta reader, image sniff and dimensions (pure over injected `resolve` / `request` / timers) |
| `electron/linkPreview.cjs` (new) | Card and image caches (memory, bounded), concurrency, queue, per-host limit, the on/off switch |
| `electron/chatHost.cjs` | `chat:changes`, `chat:change-file`, `chat:preview`, `chat:redraw`; `previewsOn()`; preview policy to the worker |
| `electron/terminals.cjs` | `redrawForChat(id)`: the one-row resize nudge (resize only) |
| `electron/main.cjs` | ~6 lines inside the existing `CHAT_VIEW` / `chatHost` guards: `redrawForChat` and `previewsOn` passed to the host; the loopback test switch behind `!app.isPackaged` |
| `electron/preload.cjs`, `src/desktop.ts` | + `chat.changes`, `changeFile`, `preview`, `redraw` |
| `electron/settings.cjs`, `src/settingsStore.ts`, `src/desktop.ts`, `src/components/SettingsView.tsx`, `src/locales/settings.ts` | + `session.linkPreviews: false`; the row; Phase 6: the 채팅 보기 help text |
| `src/termMetrics.ts` | + `termSize(id): { cols, rows } \| null` (read-only) |
| `src/chat/termWarm.ts` (new) | Which terminals must be warmed and which need one redraw (pure, per page) |
| `src/chat/rows.ts` | Density; `thinking`, `foot`, `wild` rows; `extra`; per-density `ESTIMATE` / `TIGHT` |
| `src/chat/density.ts` (new) | The three levels, remembered; initial open state per level |
| `src/chat/changes.ts` (new) | `useChanges(id)`, `fileTree(files)`, selection memory |
| `src/changesWidth.ts` (new) | The panel's width (260–560, default 320), remembered; `autoFold`; `canOpen` |
| `src/chat/steps.ts` (new) | Step samples from `GET /pokedex` and the exact-bracket rule |
| `src/chat/wild.ts` (new) | `catch` / `flee` events of this session → timeline entries |
| `src/chat/find.ts` (new) | Plain text of items, matches, the row each lies in, what to open |
| `src/chat/preview.ts` (new) | The page's card cache and blob URLs (bounded, revoked) |
| `src/components/chat/ChangesPanel.tsx`, `DensityMenu.tsx`, `TurnFoot.tsx`, `WildRow.tsx`, `ThinkingRow.tsx`, `FindBar.tsx`, `LinkCard.tsx` (new) | The new surfaces |
| `src/components/chat/Markdown.tsx` | + optional `afterBlock(block, key)` render slot (link cards) |
| `src/components/chat/DiffBlock.tsx` | The `+N −N` chip becomes a button that opens the panel at that edit (the file name still opens the editor) |
| `src/components/chat/context.ts` | + `openChanges`, `density`, `stepsFor`, `setRowOpen` (from outside a row: find) |
| `src/components/chat/ChatList.tsx` | `estimate` / `tight` from the density table; `scrollToKey` returns when placed (find) |
| `src/components/ChatView.tsx` | Density, wild rows, foot, find bar, Ctrl/⌘+F, previews in text rows; the per-row copy moves into the foot |
| `src/components/SessionHeader.tsx` | + optional `chatTools` slot before the flip (absent → markup identical) |
| `src/Widget.tsx` | Warm mount and the redraw ask; the panel's open state, width, selection; auto-fold; the header's chat tools |
| `src/styles/chat.css`, `src/styles/chat-game.css` (new), `src/styles/widget-expanded.css` (`.w-chat-pane` background, panel offsets) | Styles |
| `src/locales/chat.ts`, `src/locales/chatGame.ts` (new), `src/locales/index.ts` | Strings |
| `tests/fixtures/chat/changes.jsonl`, `changes-agent/…`, `thinking.jsonl`, `turns.jsonl`, `tests/fixtures/chat/preview/*` (html, images), `tests/fixtures/chat/dex-events.json` (new) | Redacted, hand-written fixtures |
| `tests/*.test.ts` (new and edited), `tests/visual/*` | See tasks |

## The event model: additions (main → page)

`src/chat/types.ts` gains exactly this. `electron/chatItems.cjs` / `chatChanges.cjs` mirror it in JSDoc, and `tests/chat-items.test.ts`'s runtime checker learns the new fields.

```ts
/** A thinking block (shown from 생각 포함). Claude Code 2.1.32x writes its text empty (FINDINGS §1): `text` is ''
 *  then, and the row says the content is not in the record; `durationMs` from the line's thinkingDurationMs. */
export interface ThinkingItem extends ItemBase { kind: 'thinking'; text: string; durationMs?: number; redacted?: boolean; truncated?: boolean }
export type ChatItem = UserItem | TextItem | ToolItem | NoticeItem | TurnEndItem | LiveItem | ThinkingItem

/** The conversation's file changes as the worker's index has them (status.changes; `v` grows with every change) */
export interface ChangeSummary {
  v: number
  state: 'scanning' | 'ready' | 'partial' | 'gone'   // partial: the scan stopped at a cap; gone: the transcript went
  files: number; edits: number
  added: number; removed: number                      // sums over the edits whose counts are known
  unknown: number                                     // edits whose patch the record does not hold
}
export interface ChangeFile {
  file: string                 // relative to the session folder with forward slashes, else as recorded
  outside: boolean             // not inside the session folder
  created: boolean             // its first known edit made it (Write create)
  edits: number; added: number; removed: number; unknown: number
  cut: boolean                 // an edit was cut by a cap (counts still whole)
  agent: boolean               // a sub-agent made at least one of its edits
  last: number                 // the order of its latest edit (sorting, "recent first")
}
export interface ChangeEdit {
  toolId: string; order: number; at: number | null
  agentId?: string                                    // a sub-agent's edit
  kind: 'edit' | 'create' | 'write' | 'notebook'
  added: number | null; removed: number | null        // null: the record holds no patch for it
  state: 'ok' | 'missing' | 'stale'                   // stale: the line at its offset is not what was indexed
  diff?: DiffBlock                                    // only in chat:change-file answers, rebuilt from the transcript line
}
export interface LinkCardData {
  url: string                  // the link as written (what a click opens)
  site: string                 // og:site_name, else the link's host (Unicode, punycode beside when not ASCII)
  via: string | null           // the final host when a redirect left the link's host
  title: string; description: string
  image: { bytes: Uint8Array; type: 'png' | 'jpeg' | 'webp'; width: number; height: number } | null
}
export interface LensStatus { /* … Phases 2–4 … */ changes?: ChangeSummary }
```

Rows (`src/chat/rows.ts`) gain:

```ts
  | { row: 'thinking'; key: string; item: ThinkingItem }                  // only from 생각 포함
  | { row: 'foot'; key: string; item: TurnEndItem; tools: number | null; files: number | null; texts: TextItem[]; whole: boolean }
  | { row: 'wild'; key: string; entry: WildEntry }                        // from opts.extra; never in 업무 모드
```

## IPC: additions

| Name | Kind | Payload → answer |
|---|---|---|
| `chat:changes` | invoke | `id` → `{ ok: true, summary: ChangeSummary, files: ChangeFile[], agentsUnread: number } \| { ok: false }` |
| `chat:change-file` | invoke | `{ id, file, before?: number }` → `{ ok: true, file: ChangeFile, edits: ChangeEdit[], more: number } \| { ok: false, reason: 'unknown' \| 'gone' }`; at most 20 edits with bodies, newest last; `more` older ones |
| `chat:preview` | invoke | `{ url }` → `{ ok: true, card: LinkCardData } \| { ok: false }` (no reason: failures are silent); `{ ok: false }` at once, with nothing fetched, while previews are off |
| `chat:redraw` | invoke | `id` → `{ ok: true } \| { ok: false, reason: 'off' \| 'not-shown' \| 'unarmed' \| 'no-session' \| 'sending' \| 'recent' }` |

All go through `guard` and are registered by `chatHost.registerIpc` (which exists only when `CHAT_VIEW`).

## Worker protocol: additions

main → worker: `{ t: 'init', …, preview: { allowLoopback: boolean } }`; `{ t: 'changes', id, req }`; `{ t: 'change-file', id, file, before, req }`; `{ t: 'preview', url, req }`; `{ t: 'previews', on: boolean }` (off: caches emptied, queue dropped).
worker → main: `{ t: 'reply', req, result }` as today. A preview's image bytes are transferred, not copied.

## The hidden terminal's size (5g): what is done, and why it is safe

**Cause (7-48).** `TerminalView` fits only when its box has a width and `document.visibilityState === 'visible'` (`TerminalPanel.tsx` `doFit`). A session shown as chat mounts its terminal with `active` false (`display: none`). Its replay (`terminals.buffer`) is written into xterm's default 80×24. The pty keeps its real size, so no resize reaches Claude Code and it never redraws. `termText()` then reads a garbled prompt box, and the composer refuses ("확인하지 못했어요"), which is safe but stuck. Flipping to 터미널 fits xterm to the pty's same size, so nothing redraws there either. Only a size change does.

**Fix, part 1 (page): warm mount.** `src/chat/termWarm.ts` remembers, per terminal and per page, how its `TerminalView` first mounted: `fitted-first` (active while the document was visible) or `replayed-first` (anything else). While a session is the shown chat and its terminal has not been **settled** (active for two animation frames while visible, with `termSize(id)` readable), `Widget.tsx` renders its `TerminalView` with `active` and `focus={false}`. The terminal sits under `.w-chat-pane`, which now has the opaque `--bg` background, also while `ChatView` is still loading. Mounted this way, the terminal does exactly what the on-screen terminal does in 1.4.0: `doFit()` runs in the mount effect before the replay's IPC answer arrives, so the replay lands at the real size. Once settled, `active` goes back to false. xterm keeps its fitted size while hidden. In terminal mode nothing changes (`warm` is false).

**Fix, part 2 (main): one redraw nudge, only for `replayed-first`.** When a settled terminal was `replayed-first`, the page calls `chat.redraw(id)` once. `chatHost.redraw` checks the following, in order, and otherwise refuses without doing anything:
- on;
- the terminal is running, Claude Code and armed;
- it is the `visibleId` of the page that said so (`visibleFrom`), and the window is visible;
- no chat send is in flight for it;
- no nudge for it in the last 10 s.

Then `terminals.redrawForChat(id)` calls `pty.resize(cols, rows − 1)` (rows ≥ 6; else `rows + 1`) and, 150 ms later, `pty.resize(cols, rows)`. The restore is skipped when a real `terminals:resize` changed the size in between. The manager's `t.cols` / `t.rows` follow each step.

**Why it cannot disturb the user's typing.** A resize is not input. Not one byte reaches the pty's stdin, so nothing is typed, the prompt row's text and Claude Code's input state are kept, and the ledger (Phase 3) is untouched. The terminal being nudged is hidden and not focused, so no keystroke can interleave with it. The nudge is refused while a chat send is in flight. A send that starts during the 150 ms is protected by Phase 3's unchanged echo check: a half-drawn screen gives `pending` or `mismatch`, so there is no Enter, and the composer says where the text is.

**Why it cannot disturb the terminal's content.** What Claude Code draws after a size change is what it draws on every window resize and on every side-panel drag in 1.4.0 (`TerminalPanel.tsx`: "Each size Claude Code receives also makes it redraw its whole screen"). The trials recovered the 7-48 state in exactly this way (7-48, 7-49 ①: 터미널로 보기 → 창 크기를 조금 바꾸기). The final size is the size the terminal gets when shown, so the later flip to 터미널 causes no further resize. Scrollback above Claude Code's screen is xterm's own. The residual effect is one extra redraw in the scrollback, the same as a one-row window drag (named in Risks, checked in trial 5.12).

**If either part proves unsound** (trial 5.12 shows a flash, a stolen focus, or a scrollback the owner finds worse than the defect), the fallback is **an owner decision, not a task**. The smallest `TerminalPanel.tsx` change would be: in the mount effect, when `active` is false and `term.cols` / `term.rows` are known (two new optional fields in `TerminalInfo`), call `xterm.resize(cols, rows)` before the replay is requested. That is about 3 lines, and with it neither warm mount nor the nudge is needed.

## Link preview policy (each line is a test in Task 5.9)

| Rule | Detail |
|---|---|
| Scheme | `http:` / `https:` only (`file:`, `ftp:`, `data:`, `javascript:`, `blob:`, anything else refused before any lookup) |
| URL shape | Parsed by WHATWG `URL`; ≤ 2048 chars; no userinfo (`user:pass@`); port 80 or 443 only (the scheme's default or explicit). `https → http` downgrade on redirect refused |
| Names | Refused lexically: `localhost`, `*.localhost`, `*.local`, `*.internal`, `*.home.arpa`, `*.lan`, a single-label name (no dot), a trailing-dot local form |
| IP forms | The host as WHATWG normalises it (decimal `2130706433`, hex `0x7f.1`, octal `0177.0.0.1`, short `127.1` all become `127.0.0.1`), then the address check |
| Address check | `net.BlockList`: IPv4 0/8, 10/8, 100.64/10 (CGNAT), 127/8, 169.254/16 (link-local, 169.254.169.254 metadata), 172.16/12, 192.0.0/24, 192.0.2/24, 192.88.99/24, 192.168/16, 198.18/15, 198.51.100/24, 203.0.113/24, 224/4, 240/4, 255.255.255.255; IPv6 ::/128, ::1/128, ::ffff:0:0/96 (mapped: the IPv4 checked), 64:ff9b::/96 and 64:ff9b:1::/48 (NAT64), 100::/64, 2001::/23 (incl. Teredo 2001::/32), 2001:db8::/32, 2002::/16 (6to4), fc00::/7 (ULA, incl. fd00:ec2::254), fe80::/10, fec0::/10, ff00::/8 |
| DNS | `dns.promises.lookup(host, { all: true, verbatim: true })`, 2 s; **every** address must pass (one private address refuses the name); the request connects to the first passing address through a pinned `lookup` callback (no second resolution: DNS-rebinding safe); TLS `servername` = the host, certificate checked as usual |
| Redirects | Manual; 301/302/303/307/308 with a `Location`; ≤ 3 hops; each hop goes through every rule again (scheme, port, name, DNS, addresses) |
| Request | `GET`; headers exactly `User-Agent: Mozilla/5.0 (compatible; link-preview)`, `Accept: text/html,application/xhtml+xml;q=0.9,image/*;q=0.8`, `Accept-Encoding: gzip, deflate, br`; no `Cookie`, `Referer`, `Authorization`, `Accept-Language`, `Origin`; `agent: false` (no shared pool, no keep-alive) |
| Response | Status 200 only after redirects; HTML needs `text/html` or `application/xhtml+xml`; an image is judged by its bytes, not its header; `Set-Cookie` ignored |
| Time | DNS 2 s; connect + headers 4 s; idle 2 s between chunks; 6 s for the whole fetch including redirects; then the socket is destroyed |
| Size | Compressed bytes read ≤ 1 MB (HTML) / 2 MB (image); decompressed HTML ≤ 512 KB and reading stops at `</head>` or `<body`; `zlib` streams with an output counter (a gzip, deflate or brotli bomb ends at the cap) |
| HTML | `readMeta(html)`: a linear tag scanner (no DOM, nothing executed), skipping comments, `<script>`, `<style>`, `<noscript>`, `<template>` bodies; reads `<meta property|name=… content=…>` (og:title, og:description, og:site_name, og:image, og:image:secure_url, twitter:title / description / image, description) and `<title>`; charset from the header, else `<meta charset>` / `http-equiv`, else UTF-8, decoded with `TextDecoder` (unknown → UTF-8); entities decoded (numeric + a fixed named set); control, bidi and zero-width characters removed; whitespace collapsed; caps title 200, description 400, site 80 |
| Image | Only from `og:image` / `twitter:image`, resolved against the final page URL, then fetched through every rule above; magic bytes PNG, JPEG, WebP only (GIF, animated PNG `acTL`, animated WebP, SVG, anything else: no image); width and height read from the header (PNG IHDR, JPEG SOFn within the first 64 KB, WebP VP8/VP8L/VP8X); each side ≤ 4096 and ≤ 12 MP, else no image; ≤ 2 MB; bytes go to the page, which decodes them in the sandboxed renderer from a `blob:` URL |
| Load | ≤ 3 fetches at once, ≤ 1 per host, queue ≤ 24 (the oldest dropped); the same URL in flight is shared |
| Cache | Memory only: 200 cards (success 24 h, failure 30 min), images ≤ 16 MB total (LRU); emptied when previews go off, the worker stops, or the app quits; the page's own cache ≤ 120 cards with its `blob:` URLs revoked on eviction and when the view goes |
| Which links | `link` / `autolink` nodes of a finished assistant `text` item (not `partial`, not `live`, not a sub-agent child), the first 3 distinct URLs per item, each card after the block holding it, requested only while that row is rendered |
| Logs | Never the URL, host or page text: `link preview: refused (address)`, `… timeout`, `… too large`, counted, once per kind per minute |
| Test switch | `allowLoopback` (127.0.0.0/8 and ::1 only, any port) exists only through main's `!app.isPackaged && process.env.SPAWN_PREVIEW_LOOPBACK === '1'` |

---

## Visual verification (one method for both phases)

As in Phases 2–4. UI tasks end with "the visual steps":
1. `npx vite build`
2. `node tests/visual/shots.mjs --out "~/Documents/spawn-portfolio/_inbox/chat-5/<NN-task>/" --only <surfaces>` (Phase 6: `_inbox/chat-6/`)
3. Open each PNG with the Read tool and compare it with the lab shot the task names. A difference that is neither in "Decisions" nor out of scope is a defect: fix it, or report it with the shot.
4. Run the checks and flows the task names (`--check fit`, `--check work`, `--flow …`). They exit non-zero on failure.

The fake bridge learns `chat.changes`, `changeFile`, `preview`, `redraw` (recorded in `__CALLS__`, answered from `shot.changes` / `shot.previews` / `__CHAT_SCRIPT__`). Flows that need steps route `**/pokedex` with playwright's `page.route` to a fixture. Lab reference for every Phase 5 surface: `s2-chat-panel.png` (1440×900) and `s2-chat-1100.png`.

---

# Phase 5

### Task 5.1: Fixtures for Phase 5

No product code. Hand-written and redacted, in the shapes of the existing fixtures and of the real lines the trials saw (`tests/fixtures/chat/real-*`, `pasted.jsonl`). Paths are `C:\\Users\\user\\work\\demo`. Text is harmless (rivers, `add` / `mul`).

**Files:**
- Create in `tests/fixtures/chat/`:
  - `changes.jsonl`: three Edits of `src/math.js` (each with `structuredPatch`, the second with two hunks 30 lines apart), a Write create of `src/util.js`, a Write `type: "update"` of `README.md` with a patch, an Edit with `type: "update"`-less result and **no** `structuredPatch` (missing), an Edit whose new line is 5,000 characters (cut), a failed Edit (`is_error`), a rejected Edit, an Edit of a file outside the folder (`C:\\Users\\user\\other\\x.txt`), a NotebookEdit result without a patch, an Agent call whose result has `agentId: "afixture02"`, `system/turn_duration` ×2.
  - `changes-agent/subagents/agent-afixture02.jsonl`: a sidechain Edit of `src/math.js` with a patch.
  - `thinking.jsonl`: assistant `thinking` blocks with `"thinking": ""` and `thinkingDurationMs`, one `redacted_thinking`, one with non-empty thinking text (a future shape), each followed by text.
  - `turns.jsonl`: two full turns (user → tools → text → `turn_duration`), a third turn interrupted (no `turn_duration`), and a queued prompt (`queued_command` attachment) taken mid-turn.
  - `dex-events.json`: a `DexState.log` excerpt: `catch` (newSpecies, ball `great-ball`, level 6) and `flee` for session `s-1`, a `catch` for `s-2`, a `levelup` and an `evolve` for `s-1`, a `catch` with `attendance: true`, and timestamps that fall before, inside and after the `turns.jsonl` times.
  - `preview/`: `og-basic.html` (og + twitter tags), `og-entities.html` (entities, nested quotes, attributes without quotes, upper-case tags), `og-euckr.html` (EUC-KR bytes, charset in a meta), `og-late.html` (meta after 600 KB of head: only the `<title>` before the cap counts), `og-script.html` (a `<meta>` inside `<script>` and a comment: both ignored), `og-bidi.html` (U+202E and zero-width characters in the title), `tiny.png`, `tiny.jpg`, `tiny.webp`, `anim.png` (an `acTL` chunk), `tiny.gif`, `huge-dims.png` (an IHDR of 30000×30000 and a few bytes), `fake.png` (HTML with a `.png` name).
- Modify `tests/chat-fixtures.test.ts`: `.html` and `.json` files are scanned like `.jsonl` (owner names, private digests, paths only `C:\\Users\\user\\` / `/Users/user/`); binary fixtures are listed by name with their SHA-256 in the test (no surprise binary); `dex-events.json` holds no `via.prompt` text other than `null`.

- [ ] **Step 1: Failing test:** the fixture test lists the new names and fails on the missing files.
- [ ] **Step 2: Write the fixtures.** Run `npx vitest run tests/chat-fixtures.test.ts`: PASS.
- [ ] **Step 3: Commit:** `test: redacted fixtures for the changes panel, thinking, turns, wild rows and link previews`.

### Task 5.2: The hidden terminal's size (7-48) — warm mount and one redraw

This comes first: it unblocks the composer after a swap or reload, and each later trial depends on it.

**Files:**
- Modify: `src/termMetrics.ts` (+ `termSize`), `src/Widget.tsx`, `src/styles/widget-expanded.css` (`.w-chat-pane { background: var(--bg) }`), `electron/terminals.cjs` (+ `redrawForChat`), `electron/chatHost.cjs` (+ `redraw`, IPC), `electron/main.cjs` (pass `redrawForChat` into the host's `terminals`), `electron/preload.cjs`, `src/desktop.ts`, `tests/visual/fake-bridge.js` (`chat.redraw` recorded; `terminals.resize` already recorded), `tests/visual/shots.mjs` (`--flow chat-reload-size`), `tests/visual/README.md`
- Create: `src/chat/termWarm.ts`, `tests/chat-term-warm.test.ts`, `tests/chat-redraw.test.ts`

**Interfaces:**
- `termSize(id): { cols: number; rows: number } | null`: the registered reader's `cols` / `rows`, or null.
- `termWarm.ts` (pure, module state per page, let go through `onChatForget`):
  - `noteMount(id, { active, visible })`: the first call per id records `fitted-first` when both are true, else `replayed-first`.
  - `warmNeeded(id): boolean`: true until `settle(id)`.
  - `settle(id)`; `redrawNeeded(id)`: `replayed-first` and not asked yet; `markRedrawAsked(id)`.
  - `useWarm(id, on)`: a hook. While `on` and the document is visible, after two `requestAnimationFrame`s with `termSize(id)` not null, it calls `settle(id)` and then, if `redrawNeeded(id)`, `bridge.chat.redraw(id)` once.
- `Widget.tsx`:
  - `const warm = lensMode === 'chat' && view === 'terminal' && r.sessionId === shown?.sessionId && warmNeeded(r.terminal.id)`.
  - `<TerminalView … active={<today's expression> || warm} focus={warm ? false : undefined} />`, and `noteMount` at the first render of each `TerminalView` (the `active` and `document.visibilityState` it mounts with). Nothing else about the terminal changes. In terminal mode `warm` is always false.
- `terminals.redrawForChat(id, { timers })`: only for a running, armed Claude Code terminal with a known size. It calls `pty.resize(cols, rows − 1)` (or `rows + 1` when `rows < 6`), then after 150 ms `pty.resize(cols, rows)` unless `t.cols` / `t.rows` changed meanwhile. It returns true when the first step was taken. Nothing else: no write.
- `chatHost.redraw(id, from)`: the checks in "The hidden terminal's size", then `terminals.redrawForChat(id)`. The last nudge time per id is kept (10 s).

- [ ] **Step 1: Failing tests.**
  - `tests/chat-term-warm.test.ts`:
    - `noteMount` is first-call-wins
    - `warmNeeded` stays true until `settle`
    - `redrawNeeded` is true only for `replayed-first` and only once
    - `onChatForget` clears
    - a source check that `Widget.tsx` passes `active={… || warm}` and `focus={warm ? false : undefined}` only to the main `TerminalView` (not the widget's question card), and that `warm` contains `lensMode === 'chat'`
  - `tests/chat-redraw.test.ts` (fake timers, fake pty):
    - resize calls are exactly `(c, r−1)` then `(c, r)` after 150 ms
    - a real resize in between skips the restore
    - `rows 5` → `(c, 6)` then `(c, 5)`
    - a shell, an unarmed or an exited terminal → no call
    - `chatHost.redraw` refuses with `not-shown` for another visible id, `sending` with a send in flight, `recent` within 10 s, `off` when off
    - **source guard**: `redrawForChat` names `pty.resize` and no `write`, and is called only from `chatHost.cjs` `redraw`; `chat:redraw` is registered in `registerIpc` only
  - `tests/terminals.test.ts`: the off case is unchanged (`redrawForChat` exists but is never called by anything off).

  Run them: FAIL.
- [ ] **Step 2: Implement.** Run the suite, `tsc`, build: PASS.
- [ ] **Step 3: `--flow chat-reload-size`** (the README already notes that a never-fitted terminal has xterm's 80 columns):
  1. Terminal 1 in chat, its fake buffer a 120-column screen. After load: `termSize('1').cols !== 80`, `document.activeElement` was never inside `.term-view` (sampled every frame for 1 s), `__SCREEN__('1', 'idle-empty')` then a composer send reaches `chat.send` (not refused), and no `chat.redraw` (fitted first).
  2. Reload the page: the same.
  3. Start with session 2 (mounted hidden, the background), switch to it in chat: `chat.redraw` once with `'2'`, and no second one on the next switch.
  4. Flip to 터미널: the `terminals.resize` calls after the flip equal those 1.4.0 makes on a session switch (recorded and compared).
  5. Start the page with `document.visibilityState` forced hidden until 500 ms (the swap's hidden window): the shown chat session is `replayed-first` → one `chat.redraw`.
  6. Terminal mode only: no `chat.redraw` call, ever.

  Also run `--flow chat-off`, `--flow chat-flip`, `--flow chat-send`, `--flow chat-compose-focus` (unchanged results).
- [ ] **Step 4: Commit:** `chat view: the hidden terminal gets its real size — warm mount under the chat, one redraw for a terminal that replayed first (7-48)`.

### Task 5.3: The change index in the worker (`electron/chatChanges.cjs`)

Back end only. Nothing is drawn yet; `status.changes` is ignored by the page until Task 5.4.

**Files:**
- Create: `electron/chatChanges.cjs`, `tests/chat-changes.test.ts`
- Modify: `electron/chatLens.cjs` (index per open view, fed by the scan and by `ingest`; dropped with the view, on `reload`, on a conversation switch, on `rewrite`), `electron/chatWorker.cjs` (`changes`, `change-file`), `electron/chatHost.cjs` (IPC), `electron/preload.cjs`, `src/desktop.ts`, `src/chat/types.ts`

**Interfaces:**
- `CHANGE_CAPS = { files: 2000, editsPerFile: 500, calls: 5000, scanBytes: 1 << 30, agents: 50, agentBytes: 64 << 20, bodyEdits: 20, bodyLines: 4000, lineBytes: 32 << 20 }`.
- `createChangeIndex({ cwd, caps })` returns `{ line(obj, offset, src?), summary(), files(), editsOf(file, before?), reset() }`:
  - `tool_use` blocks named Edit / MultiEdit / Write / NotebookEdit are remembered by id: tool and file. The file key is relative with forward slashes, compared without case on Windows.
  - A `tool_result` for a remembered call, or one whose `toolUseResult` has a `filePath` with a patch or `type: 'create'` (a call not seen), is judged:
    - rejected, `is_error`, or `interrupted` → no entry (nothing changed)
    - `buildDiff(r)` non-null → `state: 'ok'`, with `added` / `removed` from it and `cut` when `truncated` or `hidden > 0`
    - otherwise → `state: 'missing'`, counts null
  - Each entry keeps `{ toolId, order: offset, at, agentId?, kind, added, removed, state, src: { file: 'main' | agentId, offset } }`, never a diff. The same `toolId` again replaces its entry (idempotent).
  - Over a cap: the oldest edits of a file go first, the summary becomes `partial`, and the edit counts stay true for what is kept.
- `scanChanges(path, index, { fs, until, yieldEvery = 2 << 20, maxBytes, signal })`: forward, 1 MB chunks, `splitLines`, `quickSkip` first. A line is parsed only if it contains `"toolUseResult"` or `"tool_use"` with one of the four names. It yields every 2 MB and stops at `until` (the tail's `endOffset` when the scan began; later lines come through `ingest`) or at `maxBytes` (→ `partial`).
- `readEdit(path, ref, { fs, guard })`: reads the line at `ref.offset` (bounded by `lineBytes`), parses it, and checks that the tool_result's `tool_use_id === ref.toolId`. Then `buildDiff(r, { cwd, maxLines: CAPS.diffLines })`; a mismatch gives `stale`. The tailer's head/edge hashes are checked first; a changed file gives `stale` for every edit and the lens's `rewrite` path.
- Lens: on `open` (after the reset), `t.changes = createChangeIndex(...)`, `summary.state = 'scanning'`, and the scan runs **outside** the per-terminal `enqueue` (its own file handle, its own loop), so hooks and `readNew` never wait for it. Then each Agent result's `agentId` with an allowed `subagents/agent-<id>.jsonl` is scanned (≤ 50 files, ≤ 64 MB each, re-scanned from its last offset on `SubagentStop` and on each `changes` request). An unreadable one adds to `agentsUnread`. `status.changes` is set and flushed with `v + 1` at most every 500 ms. `ENOENT` gives `state: 'gone'`.
- `changes(id)` → `{ ok, summary, files, agentsUnread }`. `changeFile(id, file, before)` → the newest 20 edits (or the 20 before `before`), each with its diff from `readEdit`, plus `more`. The total lines across the returned diffs are ≤ `bodyLines`: past it, edits come without `diff`, and the page shows them collapsed and fetches them alone.

- [ ] **Step 1: Failing tests** (`tests/chat-changes.test.ts`, temp `claudeDir` as in `chat-lens.test.ts`):
  - `changes.jsonl` gives files `src/math.js` (3 main edits + 1 agent edit after the agent scan, in order), `src/util.js` `created`, `README.md` `write`, the folder-outside file `outside: true`, the missing edit `state: 'missing'` with null counts and `unknown: 1` in the summary, the 5,000-character edit `cut`, and no entry for the failed or rejected edit
  - the summary's `added` / `removed` equal the sums of the known edits
  - `editsOf('src/math.js')` is in transcript order; `readEdit` of each gives the same `DiffBlock` that `chatItems` gives that row (deep-equal)
  - **never merged**: the two-hunk edit keeps two hunks; nothing in `chatChanges.cjs` composes hunks (source check: no `oldStart +` arithmetic across entries)
  - **no disk read of a project file**: a spy `fs` sees only the transcript and `subagents/*.jsonl` paths; the source has no `originalFile`
  - stale: overwrite the line at an indexed offset (same length) → `readEdit` gives `stale`, and the lens shows `rewrite`
  - **whole conversation**: a synthetic 40 MB transcript with 600 edits, `open` loading only the tail: `summary.edits === 600` once `ready`, while the page's reset held ≤ 150 items; a `PreToolUse` hook posted during the scan is emitted within 250 ms (fake clock: the scan yields)
  - caps: 2,100 files → `partial` with 2,000; an `agentId` path outside `projects/` is never read
  - idempotence: a live `ingest` of a line the scan already counted does not double it

  Run it: FAIL.
- [ ] **Step 2: Implement.** Run it, the lens tests and the worker test: PASS.
- [ ] **Step 3: Commit:** `chat lens: a change index over the whole conversation — counts and offsets only, each edit re-read from the transcript, never merged`.

### Task 5.4: The 변경 사항 panel

**Files:**
- Create: `src/changesWidth.ts`, `src/chat/changes.ts`, `src/components/chat/ChangesPanel.tsx`, `tests/changes-width.test.ts`, `tests/chat-changes-ui.test.ts`
- Modify: `src/components/SessionHeader.tsx` (+ `chatTools` slot), `src/Widget.tsx`, `src/components/ChatView.tsx` (context `openChanges`), `src/components/chat/context.ts`, `src/components/chat/DiffBlock.tsx` (the counts chip → button), `src/styles/chat.css`, `src/styles/widget-expanded.css`, `src/locales/chat.ts`, `tests/visual/fake-bridge.js`, `tests/visual/chatFixture.mjs` (`changes` built by the real `chatChanges.cjs` from `changes.jsonl`), `tests/visual/shots.mjs`, `tests/visual/README.md`

**Interfaces:**
- `changesWidth.ts`:
  - `CH_MIN = 260`, `CH_MAX = 560`, `CH_DEFAULT = 320`, `CH_TIGHT = 288` (window < 1200 with no remembered width), `CH_KEY = 'spawn-changes-w'`, `OPEN_KEY = 'spawn-changes-open'`, `CONVO_FIT = 620`, `CONVO_FLOOR = 400`, `RAIL_W = 56`
  - `clampChangesWidth(px, room)` keeps the conversation ≥ `CONVO_FLOOR`
  - `autoFold({ winW, sideW, chW, open, chat, userHidden })` is true when `chat && open && !userHidden && winW < sideW + chW + CONVO_FIT` (at the defaults 300 + 320 + 620 = 1240, the lab's `narrow`)
  - `canOpen({ winW })` is false when even folded `winW − RAIL_W − CH_MIN < CONVO_FLOOR`
  - `readChangesWidth` / `writeChangesWidth` / `readOpen` / `writeOpen` (try/catch, as `sideWidth.ts`)
- `changes.ts`:
  - `useChanges(id, open)` calls `bridge.chat.changes(id)` when the panel opens and again when `status.changes.v` changes (300 ms debounce, never while closed)
  - `useChangeFile(id, file, v)` calls `bridge.chat.changeFile` likewise
  - `fileTree(files)` → folders, then files, alphabetical; single-child folders joined (`src/app/account`); files outside the folder under one group `세션 폴더 밖`
  - the selection per terminal in memory (`onChatForget`)
- `Widget.tsx`:
  - `changesOpen` (remembered), `chW` (remembered)
  - `foldNow = autoFold(...)`; the left panel renders as the rail when `sideHidden || foldNow` (`sideHidden` is **not** written by the auto-fold, so the panel comes back by itself)
  - the panel renders only when `lensMode === 'chat' && view === 'terminal' && mode !== 'widget' && changesOpen && canOpen`
  - it sits inside `.w-term-body` as an absolutely positioned right column of width `chW`, and `.w-chat-pane` gets `right: chW` (CSS variable `--ch-w`); the terminals' boxes never move
  - `SessionHeader` gets `chatTools` only in chat mode: the density menu (Task 5.5) and the changes button
- **`ChangesPanel`** (lab `.changes`, `app.css` 417–440, `app.js` 490–501):
  - a resize handle on its left edge: `role="separator"`, `aria-orientation="vertical"`, `aria-label="변경 사항 패널 폭"`, drag, double-click and Home for the default, ←/→ 16px, the `SideResize` pattern
  - head: `변경 사항`, the total `+N −N` (tooltip `수정 {n}번의 줄 수를 더한 값이에요`), `×` (`변경 사항 닫기`)
  - sub-line: `파일 {n}개 · 수정 {m}번`, or `변경 사항을 모으는 중…`, or the partial note
  - tree (`role="tree"`, `aria-label="파일 목록"`, ↑↓ moves, → / ← open and close folders, Home / End, Enter selects): rows 26px, the file name, `새 파일`, `일부 모름` when `unknown > 0`, `+N −N`; the selected row gets `aria-selected` and `--sel-bg`
  - diff area: a sticky head with the file, its counts and `편집기에서 열기` (→ `openFileFromChat`)
  - one section per edit in order: a quiet head `수정 {n} · {time} · +a −r` (`새 파일` for a create, `보조 에이전트의 수정` for an agent's), its hunks with the Phase 2 diff grid, `⋯ {n}줄 그대로` between hunks (computed from the hunk starts of the same edit only), `잘림` and `{n}줄은 터미널에서 보세요` as in `DiffBlock`, `이 수정의 내용은 기록에 없어요 · 터미널에서 보세요` for `missing`, `기록이 바뀌어서 이 수정을 다시 읽지 못했어요 · 다시 읽기` for `stale`, and `이전 수정 {n}번 더 보기` for `more`
  - empty: `이 대화에서 바뀐 파일이 아직 없어요`
  - the fixed foot line: `Edit·Write로 바꾼 것만 보여요. 명령으로 바꾼 파일은 터미널에서 확인해 주세요`; `보조 에이전트 {n}개의 변경은 읽지 못했어요` when `agentsUnread > 0`
- **The header's changes button** (lab `.chg`): the panel icon + `+N −N` from `status.changes` (icon only while scanning or with no edits); `aria-pressed` = open; disabled with the title `창이 좁아서 변경 사항을 열 수 없어요` when `!canOpen`.
- **`DiffBlock`**: the counts become a `<button className="chat-counts">` with `title={t('변경 사항 보기')}` → `openChanges({ file: diff.file, toolId: item.id })`. The panel opens, selects the file and scrolls that edit's section into view. The file name still opens the editor (Decision 7).
- Strings (ko → en / ja):
  - `변경 사항` Changes / 変更
  - `변경 사항 보기` Show changes / 変更を表示
  - `변경 사항 닫기` Close changes / 変更を閉じる
  - `파일 {n}개 · 수정 {m}번` {n} files · {m} edits / ファイル{n}個・編集{m}回
  - `변경 사항을 모으는 중…` Gathering changes… / 変更を集めています…
  - `기록이 너무 길어서 앞부분의 변경은 다 모으지 못했어요` The record is too long: some early changes weren't gathered / 記録が長すぎるため、前半の変更をすべては集められませんでした
  - `이 대화에서 바뀐 파일이 아직 없어요` No files changed in this conversation yet / この会話で変更されたファイルはまだありません
  - `Edit·Write로 바꾼 것만 보여요. 명령으로 바꾼 파일은 터미널에서 확인해 주세요` Only changes made with Edit and Write show here. Check files changed by commands in the terminal. / Edit・Writeによる変更だけを表示します。コマンドで変えたファイルはターミナルで確認してください
  - `세션 폴더 밖` Outside the session folder / セッションフォルダーの外
  - `수정 {n}` Edit {n} / 編集 {n}
  - `보조 에이전트의 수정` A sub-agent's edit / サブエージェントの編集
  - `일부 모름` Partly unknown / 一部不明
  - `수정 {n}번의 줄 수를 더한 값이에요` The lines of {n} edits added together / {n}回の編集の行数の合計です
  - `⋯ {n}줄 그대로` ⋯ {n} lines unchanged / ⋯ {n}行そのまま
  - `이 수정의 내용은 기록에 없어요 · 터미널에서 보세요` This edit's content isn't in the record · see the terminal / この編集の内容は記録にありません・ターミナルで見てください
  - `기록이 바뀌어서 이 수정을 다시 읽지 못했어요` The record changed, so this edit couldn't be read again / 記録が変わったため、この編集を読み直せませんでした
  - `이전 수정 {n}번 더 보기` Show {n} earlier edits / 以前の編集をあと{n}件表示
  - `보조 에이전트 {n}개의 변경은 읽지 못했어요` Couldn't read the changes of {n} sub-agents / サブエージェント{n}個の変更を読めませんでした
  - `편집기에서 열기` Open in editor / エディターで開く
  - `창이 좁아서 변경 사항을 열 수 없어요` The window is too narrow for the changes panel / ウィンドウが狭いため変更を開けません
  - `변경 사항 패널 폭` Changes panel width / 変更パネルの幅
  - `파일 목록` Files / ファイル一覧
  - `끌어서 폭 조절 · 두 번 누르면 기본` Drag to resize · double-click for the default / ドラッグで幅を調整・ダブルクリックで既定

- [ ] **Step 1: Failing tests.**
  - `tests/changes-width.test.ts`:
    - `clampChangesWidth` limits
    - `autoFold` true at 1239 / false at 1240 with the defaults; false when not chat, not open, or the user folded it already
    - `canOpen` false at 700 and true at 720
    - read / write with a throwing storage
  - `tests/chat-changes-ui.test.ts`:
    - `fileTree` over `changes.jsonl`'s files (joined folders, the outside group, order)
    - the `SessionHeader` static markup without `chatTools` equals the captured string (captured before editing)
    - a source check that `Widget.tsx` never writes `spawn-side-hidden` from `autoFold`
    - every new key has en and ja and no `GAME_WORDS`
  - `tests/tokens.test.ts`: `--ink-2` on `--side-bg` + `--add-bg` / `--del-bg` ≥ 3:1 (the panel's diff rows); the selected tree row on `--sel-bg` ≥ 4.5:1

  Run them: FAIL.
- [ ] **Step 2: Implement.** Run the suite, `tsc`, build: PASS.
- [ ] **Step 3: Harness.**
  - Surfaces:
    - `chat-changes` (panel open on `src/math.js`, compare `s2-chat-panel.png`)
    - `chat-changes-missing` (the missing edit selected)
    - `chat-changes-empty`
    - `chat-changes-1100` (auto-folded to the rail, compare `s2-chat-1100.png` and `app.css` 453)
    - add `chat-changes` to `WORK` and `MAC`
  - Flows:
    - `--flow chat-changes`: the diff chip opens the panel at that edit; the tree's keys; resize by drag / keys / double-click, remembered across a reload; the header button toggles and is pressed
    - `--flow chat-changes-fold`: at 1200 wide, opening folds the left panel to the rail; closing or widening brings it back; `spawn-side-hidden` is unchanged
    - `--flow chat-changes-terminal`: with the panel open, flip to 터미널; `.term-view`'s rect equals the rect recorded before the panel was ever opened; no `terminals.resize` call caused by the panel; no panel and no chat tools in the header
    - `--flow chat-changes-widget`: widget mode shows no panel
  - Visual steps for the surfaces with `--check fit --check work`.
- [ ] **Step 4: Commit:** `chat view: the 변경 사항 panel — files and their edits in order from the transcript, resizable, the left panel folding when narrow`.

### Task 5.5: Thinking items and density (기본 / 생각 포함 / 전부)

**Files:**
- Create: `src/chat/density.ts`, `src/components/chat/DensityMenu.tsx`, `src/components/chat/ThinkingRow.tsx`, `tests/chat-density.test.ts`
- Modify: `electron/chatItems.cjs` (thinking items), `src/chat/types.ts`, `src/chat/rows.ts`, `src/components/ChatView.tsx`, `src/components/chat/ChatList.tsx` (`estimate` / `tight` props), `src/components/chat/context.ts` (`density`), `src/components/chat/ToolRow.tsx`, `ToolGroup.tsx`, `AgentGroup.tsx` (initial open from the density), `src/Widget.tsx` (the menu in `chatTools`), `src/styles/chat.css`, `src/locales/chat.ts`, `tests/chat-items.test.ts`, `tests/visual/*`

**Interfaces:**
- `chatItems.cjs`: a `thinking` block gives `{ kind: 'thinking', text: cut(block.thinking ?? '', caps.text), durationMs: line.thinkingDurationMs if it is a finite number ≥ 0 }`. `redacted_thinking` gives `text: ''`, `redacted: true`. Ids follow the line's block rule. The canary, the live-bubble matching and the outbox ignore the kind (they look at `text` only).
- `density.ts`:
  - `type Density = 'default' | 'thinking' | 'all'`
  - `readDensity()` / `writeDensity()` (key `spawn-chat-density`; a bad value → `default`), `useDensity()`
  - `ESTIMATE: Record<Density, number> = { default: 44, thinking: 48, all: 140 }`, `TIGHT = { default: true, thinking: true, all: false }`
  - `initialOpen(density, kind: 'tool' | 'group' | 'agent' | 'diff')`: `all` → true, else false
- `rows.ts`:
  - `opts.density`: `default` drops `thinking` items without breaking a read group or adding a turn head; `thinking` and `all` make a `thinking` row (it breaks a group; it can begin a turn head)
  - the never-collapsed rule is unchanged in every density: waiting, failed, running, AskUserQuestion and ExitPlanMode rows are never in a group
  - `sameRow` learns the new rows
- `ChatList` takes `estimate` and `tight` from the table. On a density change the heights map is kept and the anchor holds the first row in view.
- `DensityMenu` (lab `.dens` + menu, `app.js` 261–265): the button shows the eye glyph and the level's name with a chevron (`aria-haspopup="menu"`, `aria-expanded`). The menu has three `menuitemradio`s with their one-line hints, ↓↑ Home End, Esc and Tab close, and the focus returns to the button (the text-size menu's pattern).
- `ThinkingRow` (lab `.think`): a left hairline, `생각 · {time}` in `--t-meta`, then the text in `--ink-3`, or `생각한 내용은 기록에 남지 않았어요` when empty.
- Strings:
  - `보기 정도` Detail / 表示の詳しさ (button `aria-label`)
  - `기본#density` Default / 基本 (the key carries a sense, as `보통#text-size` does, read with `tSense`)
  - `도구는 한 줄 요약, 실패와 질문은 늘 펼침` Tools in one line; failures and questions always shown / ツールは1行に要約、失敗と質問は常に表示
  - `생각 포함` With thinking / 思考を含む
  - `답하기 전에 생각한 내용도 보기` Also show the thinking before each answer / 回答前の思考も表示
  - `전부` Everything / すべて
  - `읽은 파일과 출력까지 모두 펼치기` Open every file read and every output / 読んだファイルと出力まですべて展開
  - `생각 · {time}` Thinking · {time} / 思考・{time}
  - `생각한 내용은 기록에 남지 않았어요` The thinking itself isn't in the record / 思考の内容は記録に残っていません

- [ ] **Step 1: Failing tests** (`tests/chat-density.test.ts`, `tests/chat-items.test.ts`):
  - `thinking.jsonl` gives thinking items with `durationMs`, empty text, `redacted`, and the one non-empty text
  - `buildRows` over `tools.jsonl` + `thinking.jsonl`: `default` gives the Phase 2 rows exactly (deep-equal to a snapshot taken before the change); `thinking` adds the rows; a `waiting: 'permission'` read is ungrouped in all three
  - the density read/write fallbacks
  - `ESTIMATE` and `TIGHT` have every level
  - a source check that `ChatList.tsx` has no literal `44` left
  - strings: en/ja present, no `GAME_WORDS`

  Run: FAIL.
- [ ] **Step 2: Implement.** PASS.
- [ ] **Step 3: Harness.** Surfaces `chat-thinking` and `chat-all` (density seeded). Flow `--flow chat-density`:
  - the menu by keyboard; the choice is remembered over a reload
  - switching to `전부` with `chat-long`: ≤ 300 `.chat-row` in the DOM, the first visible row within 2px, settled in ≤ 300 ms
  - the waiting row in `chat-waiting` stays a row of its own in each level

  Visual steps (`--check fit --check work`; the lab's `.think` and `app.css` 253–254).
- [ ] **Step 4: Commit:** `chat view: density — 기본, 생각 포함 (with what the record holds of it), 전부; a per-level estimate for the virtual list`.

### Task 5.6: The turn summary

**Files:**
- Create: `src/chat/steps.ts`, `src/components/chat/TurnFoot.tsx`, `tests/chat-foot.test.ts`, `tests/chat-steps.test.ts`
- Modify: `src/chat/rows.ts` (`foot` rows), `src/components/ChatView.tsx` (the per-row 답 복사 goes from text rows that are followed by a foot; the steps ledger), `src/components/chat/context.ts` (`stepsFor`), `src/styles/chat.css`, `src/styles/chat-game.css` (new: `.chat-steps`), `src/locales/chat.ts`, `src/locales/chatGame.ts` (new), `src/locales/index.ts`, `tests/work-mode.test.ts`, `tests/visual/*`

**Interfaces:**
- `rows.ts`: a `turn-end` item gives `{ row: 'foot', key: 'foot:' + id, item, tools, files, texts, whole }`.
  - `whole` is true only when the turn's opening user item (or the conversation's start with `!hasOlder`) is among the items.
  - When whole: `tools` = main-thread tool items of the turn; `files` = distinct files of the turn's diffs; `texts` = the turn's main-thread text items. Otherwise `tools` and `files` are null.
  - The foot ends the turn (as `turn-end` did).
- `steps.ts`: `createStepLedger({ fetchDex = () => fetch(`${serverHttpBase()}/pokedex`).then(r => r.json()), now, timers })`:
  - `onWorking(sessionId)` (the lens status goes idle/starting → working) takes a **start sample** `{ at, uid: assign[sessionId], steps: mons[uid].steps }`, marked unused.
  - `onTurnEnd(sessionId, turnEndId, statusAfter)` (a `turn-end` item that arrived live, not in a reset) takes an **end sample** 1500 ms later, only if the status is then not `working`.
  - The turn's steps are `end.steps − start.steps` only when there is an unused start sample of the same session, the same `uid` at both, and no other `turn-end` of that session between them. The start sample is then marked used. Otherwise null.
  - Results by `turnEndId` in memory (≤ 500 per session, `onChatForget`). A failed fetch gives null. Nothing in 업무 모드 (the ledger is not created).
- `TurnFoot` (lab `.turn-foot`, `app.css` 660–663):
  - `{duration}` from `formatDuration`
  - when whole: `도구 {n}회`, and `파일 {n}개 바꿈` if > 0
  - when steps ≠ null and not work mode: the paw glyph + `{n}걸음` with the title `이 턴 동안 {name}{iga} 걸은 걸음`
  - the `답 복사` button (the Phase 2 `CopyButton`), copying `texts` joined by a blank line and saying when any was cut
- Text rows followed by a foot lose their own copy button. Rows of a turn with no foot (running, interrupted, no `turn_duration`) keep theirs (Decision 10).
- Strings: `도구 {n}회` {n} tool calls / ツール{n}回 · `파일 {n}개 바꿈` {n} files changed / ファイル{n}個を変更. In `chatGame.ts`: `{n}걸음` {n} steps / {n}歩 · `이 턴 동안 {name}{iga} 걸은 걸음` Steps {name} took this turn / このターンに{name}が歩いた歩数.

- [ ] **Step 1: Failing tests:**
  - `tests/chat-foot.test.ts` over `turns.jsonl`:
    - two feet with the right durations, tools and files
    - the interrupted turn has no foot and keeps its text row's copy
    - a reset whose items begin mid-turn gives `whole: false` and null counts
    - the queued prompt taken mid-turn does not split the turn
  - `tests/chat-steps.test.ts` (fake fetch, fake timers):
    - start 10 → end 18 gives 8
    - a uid swap gives null
    - two turns under one working period (queued) give null for the second
    - an end sample taken while working again gives null
    - a fetch error gives null
    - a reset's `turn-end` (history) gives null
    - work mode: no fetch at all
  - `tests/work-mode.test.ts`:
    - `chatGame.ts` strings are used only by components rendered under `!workMode` (source check: `TurnFoot`'s steps span and `WildRow` behind a `workMode` guard)
    - `chat.ts` still has no `GAME_WORDS`

  Run: FAIL.
- [ ] **Step 2: Implement.** PASS.
- [ ] **Step 3: Harness.** The fixture conversation gains feet. `page.route('**/pokedex', …)` serves two samples. Surfaces `chat-foot`, `chat-foot-work` (no steps).
  - `--flow chat-foot`: the copy writes the turn's text (clipboard stub); a live turn-end shows `8걸음` after 1.5 s; a reload shows no steps for the old turns
  - visual steps against `s2-chat-panel.png`'s foot line
- [ ] **Step 4: Commit:** `chat view: a quiet foot per finished turn — time, tools, files changed, steps when they can be known, the answer's copy`.

### Task 5.7: Wild-Pokémon rows

**Files:**
- Create: `src/chat/wild.ts`, `src/components/chat/WildRow.tsx`, `tests/chat-wild.test.ts`
- Modify: `src/chat/rows.ts` (`extra` → `wild` rows), `src/components/ChatView.tsx` (`usePokedex()` → entries, not in work mode), `src/styles/chat-game.css`, `src/locales/chatGame.ts`, `tests/tokens.test.ts`, `tests/visual/*`

**Interfaces:**
- `wildEntries(events: DexEvent[], sessionId, { from, to }): WildEntry[]`:
  - `catch` and `flee` only, with `e.sessionId === sessionId` and `from ≤ at ≤ to`
  - `from` is the first item's `at` when `!hasOlder`, else the first loaded item's `at`; `to` is now
  - deduplicated by `${kind}:${at}:${id}` across `log` and `today`; ≤ 200, the newest
  - fields: `key`, `at`, `kind`, `dex`, `shiny`, `tier`, `level`, `newSpecies`, `ball` (never `via` or a prompt)
- `rows.ts`: an entry goes before the first main-thread item whose `at` is later. It flushes a group (it is never inside one). It makes no day row and no turn head, and does not count as unread.
- `WildRow` (lab `.wild`, `app.css` 264–272):
  - the 34px sprite (`spriteUrl(dex, shiny)`), `야생의 {name}{iga} 나타났다`, `→`
  - a catch: the ball icon (`ballUrl`) + `잡았다 · Lv.{n}` and the hairline tag `새로 등록` when `newSpecies`
  - a flee: `놓쳤다`
  - a shiny one: `색이 다른`
  - a rare-or-above tier: its name in its tier colour (`TIER_LABEL`)
  - `role="note"`, read as one sentence
  - **Lively (principle 7):** a row whose key was not present when the view mounted gets the class `appear` once: the lab's `wildIn` 0.5 s, in `chat-game.css`, `animation: none` under reduced motion
- Strings in `chatGame.ts`:
  - `야생의 {name}{iga} 나타났다` A wild {name} appeared / 野生の{name}が現れた
  - `잡았다` Caught / 捕まえた
  - `놓쳤다` Got away / 逃げられた
  - `새로 등록` New entry / 新規登録
  - `색이 다른` Shiny / 色違い

- [ ] **Step 1: Failing tests** (`tests/chat-wild.test.ts` with `dex-events.json` + `turns.jsonl`):
  - only `s-1`'s catch and flee, inside the window, appear, each between the right items
  - the `s-2` catch, the levelup, the evolve and the out-of-window events do not
  - never inside a group
  - work mode: `ChatView` passes no `extra` (source check)
  - `tests/tokens.test.ts`: `chat-game.css`'s one animation stops under reduced motion; `chat.css` still has none

  Run: FAIL.
- [ ] **Step 2: Implement.** PASS.
- [ ] **Step 3: Harness.** Surface `chat-wild` (compare the lab row). `--flow chat-wild`:
  - pushing a `pokedex` message with a new catch for the shown session adds one row with `appear`
  - a reload shows it without `appear`
  - `-work` has no `.chat-wild`
  - `--check work` passes
- [ ] **Step 4: Commit:** `chat view: wild Pokémon in the flow where they met — caught or got away, from the game's own events, never in 업무 모드`.

### Task 5.8: Find in the conversation

**Files:**
- Create: `src/chat/find.ts`, `src/components/chat/FindBar.tsx`, `tests/chat-find.test.ts`
- Modify: `src/components/ChatView.tsx`, `src/components/chat/ChatList.tsx` (`scrollToKey(key, { align: 'center' })` resolves after placement), `src/components/chat/context.ts` (`setRowOpen(id, key, open)` exported for code outside a row), `src/styles/chat.css`, `src/locales/chat.ts`, `tests/visual/*`

**Interfaces:**
- `plainOf(item, density)`, cached in a `WeakMap` by item identity:
  - user text
  - a text item's plain text from its markdown AST (inline code and code blocks included, link text included, no markup)
  - a tool's label detail (`command`, `file`, `pattern`, `query`, `url`, `description`), its `output.text`, its diff lines
  - a notice's words
  - a thinking item's text only in `thinking` / `all`
- `findMatches(items, rows, query, density, limit = 1000)`:
  - query and text are both NFC-normalised and compared with `toLocaleLowerCase()`
  - returns `{ itemId, rowKey, field, start, end }[]` in row order, plus `more: boolean`
  - `rowKey` is the row the item is drawn in (a group's member → the group's key; a sub-agent child → its Agent row's key)
- `openFor(match)` lists the open keys that make it visible: the group key, the tool id, `${id}:diff` past the preview lines, and the Agent row.
- `FindBar` (`role="search"`, the terminal's `.term-search` place and size, calm colours):
  - an input (`찾을 말`), the count `{i}/{n}` / `결과 없음` / `{n}개 넘음` (`aria-live="polite"`), `이전 결과` / `다음 결과` / `찾기 닫기`
  - Enter = next, Shift+Enter = previous, Esc = close and give the focus back to where it was
  - with `status.hasOlder`: `불러온 대화에서만 찾아요`
  - typing is debounced 120 ms; the IME's composition is never interrupted (no search while `isComposing`)
- Ctrl/⌘+F: `ChatView` adds a window `keydown` listener (bubble phase) while mounted. On `appShortcut(e) === 'find'`, not composing and not inside `.term-view`, it calls `preventDefault()` and opens the bar (or selects its text). `src/keys.ts` is not edited, and Widget's capture handler already lets `find` through.
- Painting: after each navigation and each render, the mounted rows' text nodes are scanned for the query (DOM read only) and `CSS.highlights.set('chat-find', …)` / `('chat-find-now', …)` are set. `::highlight(chat-find)` is white 12 %, and `::highlight(chat-find-now)` white 28 % with `--ink`. No yellow. Without `CSS.highlights`, the current row gets an outline instead.
- Navigation: `setRowOpen` for `openFor(match)`, then `scrollToKey(rowKey, { align: 'center' })` (auto under reduced motion).
- Strings:
  - `대화에서 찾기` Find in conversation / 会話内を検索
  - `찾을 말` Find / 検索
  - `결과 없음` No results / 結果なし
  - `{n}개 넘음` More than {n} / {n}件以上
  - `이전 결과` Previous / 前へ
  - `다음 결과` Next / 次へ
  - `찾기 닫기` Close find / 検索を閉じる
  - `불러온 대화에서만 찾아요` Searching only what is loaded / 読み込んだ会話だけを検索します

- [ ] **Step 1: Failing tests** (`tests/chat-find.test.ts`):
  - Korean query `강` over a Korean answer; case-insensitive Latin
  - a hit inside a group's Grep pattern maps to the group's row and `openFor` names the group and the tool
  - a hit in an output past 8 lines opens the row
  - a hit in a diff's 20th line opens `:diff`
  - markdown `**bold**` matches `bold` but not `**`
  - thinking only in `thinking` / `all`
  - limit 1000 → `more`
  - a source check that `ChatView.tsx` reads `appShortcut` and that `src/keys.ts` is untouched (`git diff --exit-code` in the sweep)

  Run: FAIL.
- [ ] **Step 2: Implement.** PASS.
- [ ] **Step 3: Harness.** `--flow chat-find`:
  - Ctrl+F in chat opens the bar with the focus in it; Ctrl+F in the terminal opens the terminal's own bar
  - a query over `chat-long` with a hit 1,500 rows up: Enter scrolls there, the row is mounted, `::highlight` holds the range, and the count says `1/…`
  - a hit inside a closed group opens it
  - Esc closes and returns the focus
  - ⌘F in the `-mac` run

  Surface `chat-find` with `--check fit` (also `--lang en|ja`).
- [ ] **Step 4: Commit:** `chat view: find in the conversation — over the store, opening what is folded, painted without touching the markup`.

### Task 5.9: Link previews I — the safe fetcher (`electron/linkFetch.cjs`)

No UI. Everything in "Link preview policy" is implemented and tested here.

**Files:**
- Create: `electron/linkFetch.cjs`, `tests/link-fetch.test.ts`

**Interfaces:**
- `checkUrl(raw, { allowLoopback })` → `{ ok: true, url } | { ok: false, why: 'scheme' | 'shape' | 'userinfo' | 'port' | 'name' | 'address' }`
- `addressAllowed(ip, family, { allowLoopback })`, built on a module-level `net.BlockList`
- `resolveAllowed(host, { resolve = dns.promises.lookup, timeoutMs, allowLoopback })` → `{ ok, address, family } | { ok: false }`
- `fetchLimited(url, { kind: 'html' | 'image', request = { http, https }, resolve, timers, allowLoopback, caps })` → `{ ok: true, finalUrl, bytes, type } | { ok: false, why }`. Pinned `lookup`, manual redirects, the headers exactly as listed, `agent: false`, the time and size caps, `zlib` streams with counters.
- `readMeta(html)` → `{ title, description, site, image }` (pure)
- `decodeHtml(bytes, contentType)` (charset rules, pure)
- `sniffImage(bytes)` → `{ type, width, height, animated } | null` (pure)
- `previewOf(url, deps)` → `LinkCardData | null`: the composition. A page without a title and without a description gives null.

- [ ] **Step 1: Failing tests** (`tests/link-fetch.test.ts`). Fake `resolve` and a spy `request` for every refusal: **the spy is never called** when a rule refuses. Real 127.0.0.1 servers (`allowLoopback: true`, a fake resolver mapping `site.test` to 127.0.0.1) for the transport cases.
  - **Schemes and shapes:**
    - `file:///C:/x`, `ftp://a.b/`, `data:text/html,x`, `javascript:alert(1)`, `blob:…` → `scheme`
    - `http://user:pw@example.com` → `userinfo`
    - `http://example.com:8080` → `port`
    - a 3,000-character URL → `shape`
  - **Local names:** `http://localhost`, `http://LOCALHOST.`, `http://a.localhost`, `http://printer.local`, `http://db.internal`, `http://intranet` → `name`.
  - **Addresses:**
    - `http://127.0.0.1`, `http://[::1]`, `http://169.254.169.254/latest/meta-data`, `http://10.0.0.1`, `http://192.168.1.1`, `http://172.16.0.1`, `http://100.64.0.1`, `http://0.0.0.0` → `address`
    - `http://[fe80::1]`, `http://[fc00::1]`, `http://[fd00:ec2::254]`, `http://[::ffff:127.0.0.1]`, `http://[::ffff:7f00:1]`, `http://[64:ff9b::a00:1]`, `http://[2002:a00:1::]` → `address`
    - **decimal / hex / octal / short forms**: `http://2130706433`, `http://0x7f000001`, `http://0x7f.1`, `http://0177.0.0.1`, `http://127.1`, `http://017700000001` → `address`
  - **DNS:**
    - a public name resolving to `10.0.0.5` → refused, with no connection
    - a name resolving to `[93.184.216.34, 127.0.0.1]` → refused (every address must pass)
    - the resolver called once per hop: a resolver that answers public then private on the second call is never asked twice (rebinding)
    - the connection goes to the pinned address (the server sees it; the `Host` header is the name)
  - **Redirects:**
    - to `http://169.254.169.254/` → refused at the hop, with no second connection
    - to `http://localhost:3000` → refused
    - a chain of 4 → refused at the 4th
    - https → http → refused
    - a relative `Location` resolved and re-checked
  - **Headers:** the server records exactly the listed headers (no `cookie`, `referer`, `authorization`, `accept-language`, `origin`); a `Set-Cookie` from hop 1 is not sent to hop 2.
  - **Caps:**
    - a **1 GB body** (a streaming server writing forever): ends at 1 MB read, socket destroyed, < 1.5 s
    - a **slow body** (1 byte / 500 ms): ends at the 2 s idle or the 6 s total
    - slow headers: 4 s
    - a **gzip bomb** (1 MB of gzip expanding to 1 GB): the inflater stops at 512 KB output, the process RSS grows < 50 MB
    - the same for deflate and brotli
    - `Content-Encoding: gzip` with garbage → refused
  - **Images:**
    - `tiny.png` / `tiny.jpg` / `tiny.webp` → sniffed with the right dimensions
    - `tiny.gif`, `anim.png` (acTL), an animated WebP (VP8X flag) → no image
    - `huge-dims.png` (30000×30000) → no image, decided from the header before any decode
    - `fake.png` (HTML) → no image
    - a 3 MB PNG → refused at 2 MB
    - an `image/png` header over SVG text → no image
  - **HTML:**
    - `og-basic.html` → title, description, site, image URL
    - `og-entities.html` → decoded, collapsed
    - `og-euckr.html` → correct Korean
    - `og-late.html` → only what lies before the cap
    - `og-script.html` → the meta inside `<script>` and the comment ignored
    - `og-bidi.html` → U+202E and zero-width characters removed
    - a 512 KB head with no `</head>` → stops at the cap
    - `readMeta` over 1 MB of `<<<<` runs in < 50 ms (linear)
  - **Content types:** `application/json` for a page → refused; status 404 / 500 → refused.
  - **Guards:**
    - source: `linkFetch.cjs` never names `cookie`, `referer`, `localStorage`, `session`, `net.request` (Electron's network stack carries the app's cookies and is not used)
    - it requires only `http`, `https`, `dns`, `net`, `zlib`, `url`

  Run: FAIL.
- [ ] **Step 2: Implement.** PASS.
- [ ] **Step 3: Commit:** `chat view: a link-preview fetcher that resolves first, connects only to public addresses it checked, and stops at every cap`.

### Task 5.10: Link previews II — the setting, the worker, the cards

**Files:**
- Create: `electron/linkPreview.cjs`, `src/chat/preview.ts`, `src/components/chat/LinkCard.tsx`, `tests/link-preview.test.ts`
- Modify: `electron/settings.cjs`, `src/settingsStore.ts`, `src/desktop.ts`, `src/components/SettingsView.tsx`, `src/locales/settings.ts`, `electron/chatWorker.cjs` (the service, the `preview` and `previews` messages, the `init` policy), `electron/chatHost.cjs` (`chat:preview`, `previewsOn`, `previews` on toggle), `electron/main.cjs` (`previewsOn` and the guarded loopback switch), `electron/preload.cjs`, `src/components/chat/Markdown.tsx` (`afterBlock`), `src/components/ChatView.tsx` (`TextRow` passes `afterBlock` when previews are on and the item is finished), `src/styles/chat.css`, `src/locales/chat.ts`, `tests/settings.test.ts`, `tests/visual/*`

**Interfaces:**
- Setting: `session.linkPreviews: false` (sanitised to a boolean). The 설정 row, shown only when `CHAT_VIEW`, sits under 채팅으로 보기 and is disabled while that is off:
  - label `링크 미리보기 (채팅)` Link previews (chat) / リンクプレビュー(チャット)
  - hint `채팅에 나온 링크의 제목과 그림을 가져와 보여 줘요. 가져올 때 그 사이트는 누군가 그 링크를 열었다는 걸 알 수 있어요. 내 PC나 사내망 주소는 가져오지 않아요` → "Shows the title and picture of links in the chat. Fetching one tells that site someone looked at it. Addresses on this PC or a private network are never fetched." / "チャットに出たリンクのタイトルと画像を表示します。取得すると、そのサイトには誰かがリンクを開いたことが伝わります。このPCや社内ネットワークのアドレスは取得しません。"
- `linkPreview.cjs`: `createPreviewService({ fetchCard = previewOf, now, caps })` returns `{ get(url): Promise<LinkCardData | null>, setOn(on), clear() }` with the cache, load and queue rules from the policy.
- `chatHost`:
  - `chat:preview` returns `{ ok: false }` at once unless `previewsOn()` (CHAT_VIEW, chatView on, linkPreviews on) and the URL passes `safeHref`-equivalent checks in main (≤ 2048, http/https). It then asks the worker and transfers the image bytes to the page.
  - On a change of the setting, `{ t: 'previews', on }` goes to the worker.
- main: `preview: { allowLoopback: !app.isPackaged && process.env.SPAWN_PREVIEW_LOOPBACK === '1' }` in the host's options, passed to the worker's `init`.
- `preview.ts`: `usePreview(url, on)` → `LinkCardData & { src: string } | null`. The page cache holds ≤ 120 cards; a `blob:` URL is made per image and revoked on eviction, when previews go off, and on `onChatForget`. Requests are made only by a mounted `LinkCard`.
- `Markdown`: `afterBlock?: (block: Block, key: string) => React.ReactNode`, rendered after a top-level block (stable keys: `blockKeys`).
- `TextRow`: when `useSettings().session.linkPreviews` is on, the item is not `partial`, and it has no `parent`, the first 3 distinct links of the item go to the blocks that hold them.
- `LinkCard` (lab `.og`, `app.css` 223–230):
  - a hairline box, max 480px
  - site line (`--t-meta`, `--ink-3`): a neutral globe glyph, `site`, and `→ {via}` when a redirect left the host
  - title (`--t-ui`, 500, one line)
  - description (two lines, `--ink-2`)
  - the 104×68 image at the right when present
  - the whole card is one `<a href="#">` → `openUrlFromChat(card.url)`, named by the title with the URL in its `title`
  - it renders nothing until the card arrives, and nothing on failure: the plain link above stays
  - `aria-label` `링크 미리보기: {title}` Link preview: {title} / リンクプレビュー:{title}

- [ ] **Step 1: Failing tests:**
  - `tests/link-preview.test.ts`:
    - the cache: the same URL in flight → one fetch; 201 cards → the oldest goes; a failure is cached 30 min (fake clock); 17 MB of images → LRU under 16 MB
    - load: 30 URLs → ≤ 3 at once, ≤ 1 per host, ≤ 24 queued
    - `setOn(false)` empties every cache and drops the queue
  - `tests/settings.test.ts`: `linkPreviews` sanitising and default false.
  - source checks:
    - the page never calls `fetch(` for a preview, and no `<img src={card…url}>`: `LinkCard`'s `img` `src` comes only from `URL.createObjectURL`
    - `chat:preview` returns before any worker message when off (a host test with a worker spy)
    - the loopback env name appears only in `main.cjs`, inside `!app.isPackaged &&`
    - previews are requested only by `LinkCard` (mounted rows)
  - a ChatView test (`react-dom/server` over a fixed state):
    - no `LinkCard` for user messages, tool output, code blocks, a partial text or a live bubble
    - at most 3 per item

  Run: FAIL.
- [ ] **Step 2: Implement.** PASS.
- [ ] **Step 3: Harness.** Fake `chat.preview` answers from `shot.previews` (a tiny PNG's bytes).
  - Surface `chat-link` (compare the lab's card in `s2-chat-panel.png`), with `-work` and `-mac`.
  - `--flow chat-preview-off`: setting off → no `chat.preview` call at all over the whole `chat` conversation.
  - `--flow chat-preview`: on → calls only for rendered rows; scrolling 1,000 rows down adds calls only for rows that mounted; the blob URLs are revoked when the view goes (counted).

  `--check fit --lang en|ja`.
- [ ] **Step 4: Commit:** `chat view: link preview cards, opt-in — fetched by the chat worker under the preview policy, shown from memory`.

### Task 5.11: Sweep and hand-off for Phase 5

- [ ] **Step 1: Guards** (`tests/chat-ui.test.ts`, failing first where new):
  - `src/styles/chat-game.css` holds every new animation, and `chat.css` none
  - `--accent` still only in `.chat-send`
  - the new localStorage keys are exactly the three listed
  - no file under `electron/chat*.cjs`, `electron/link*.cjs`, `src/chat/`, `src/components/chat/` logs a URL, a file name or item text (source check over the `log(` / `console.` calls' template literals: only fixed words and numbers)
  - `package.json` and the lock file are unchanged
- [ ] **Step 2: Run everything**, output to `_inbox/chat-5/11-final/`:
  - the suite, `tsc`, build
  - all surfaces with `--check fit --check work`
  - the chat surfaces with `--text small|xlarge` and `--lang en|ja`
  - every flow (old and new; `chat-off` pixel-equal to 1.4.0's shots)
  - `NOTES.txt` and `run.log` beside the shots
- [ ] **Step 3: Untouched files:** `git diff --exit-code 5d1a2bf -- src/components/TerminalPanel.tsx src/keys.ts src/termFont.ts src/textSize.ts server hooks scripts electron/updater.cjs electron/updateRunner.cjs package.json package-lock.json` prints nothing (or use the last merged main commit as the base).
- [ ] **Step 4:** `CHANGELOG.md` "Unreleased" (ko / en / ja in the file's style): the changes panel, link previews (off by default, and why), turn summaries, wild rows, density, find, and the terminal size after a swap. `docs/HANDOFF.md`: a new entry 7-50 in the style of 7-48 / 7-49. It covers what each part is; how the index works; the preview policy in short; the 7-48 fix and what remains of it; the known limits (Bash-changed files not shown, edits never merged, steps only when exact, thinking text empty in 2.1.32x, find only over what is loaded); and what only a real build shows (Task 5.12 and the owner's own checks).
- [ ] **Step 5: Insight log** (`insight-log` skill), one entry: "변경 사항은 기록이 말한 만큼만" — why the panel shows edits in order and says what it does not know, instead of a tidy merged diff, with the `chat-changes` and `chat-changes-missing` shots. A second entry when the trial confirms 5g: "숨은 터미널을 한 번만 보여 주기" (the before: the 7-48 garbled-terminal crop from `_inbox/chat-phase-3/real-trial/`).
- [ ] **Step 6: Commit:** `chat view: sweep, guards, changelog and hand-off for Phase 5`.

### Task 5.12: Real-session trial (Phase 5)

**Only with the controller's go-ahead.** The set-up is the one used in 7-47 … 7-49:
- a copy of the app in the scratchpad (electron, hooks, server, dist; `node_modules` linked; `server/cloud-config.json` left out), with its own `SPAWN_HOME`, userData and `SPAWN_REGISTRY_DIR`
- server port 3393; the window off screen with `showInactive`; CDP 9341 and the main inspector 9342
- a throwaway git folder with three files
- the SHA-256 of `~/.claude/settings.json` before and after (must be equal)
- the copy only is patched to log pty resizes, `chat:redraw`, the previews' request lines (host and status only), and the worker's index timings to `trial.jsonl`
- the test transcripts, `file-history`, `session-env`, `metrics/cost-snapshots` entries of the trial sessions, the copy and its temp folders are removed at the end

Link previews are tried only against a local test server the trial starts on 127.0.0.1 (serving `og-basic.html`, `tiny.png`, a redirect to 169.254.169.254, a 1 GB stream), with `SPAWN_PREVIEW_LOOPBACK=1` (an unpackaged copy), plus two well-known public pages (`https://developer.mozilla.org/en-US/docs/Web/API/URL/URL`, `https://www.rust-lang.org/`).

Checklist (each with its evidence):
- [ ] **5g:**
  - with a session shown as chat: widget → window → the composer sends at once (`trial.jsonl`: one `chat:redraw` with resizes `r−1 → r`, or none when fitted first); the terminal looks right after the flip (crop)
  - a page reload (CDP `Page.reload`) → sends; no redraw
  - after the reload, a background session switched to in chat → one redraw, and sends
  - typing in the terminal right after a redraw works; the prompt row's text is kept across it (text typed into the terminal before the swap is still there after)
  - the scrollback after a redraw (crop; note any duplicated screen)
- [ ] **Changes:**
  - prompts that make Claude edit one file three times, create one, overwrite one with Write, and change one with a Bash `echo >>`
  - the panel shows the three edits in order, the new file, the write, and not the Bash one, with the fixed line
  - the counts equal `git diff --numstat` for files edited once (record, for files edited several times, that the sums differ from git's net count and that the label says so)
  - the diff chip opens the panel at its edit
  - a sub-agent's edit appears with its label
  - `/clear` → the panel moves to the new conversation (empty)
- [ ] **Density:** 생각 포함 shows `생각 · …` rows with the "not in the record" line (note whether 2.1.325 writes any thinking text); 전부 opens everything; the permission card is unaffected.
- [ ] **Turn summary:** durations match the TUI's; tools and files; steps after a turn (compare with the dex's step count before and after, read from `GET /pokedex` by hand).
- [ ] **Wild rows:** whenever an encounter happens during the trial, it shows in the flow at the right place (if none happens, say so; the harness flow stands in).
- [ ] **Find:** a word from an early answer, with the conversation scrolled to the bottom; a word inside a folded read group.
- [ ] **Previews:**
  - off: an answer with three links causes no request on the local server's log
  - on: the card from `og-basic.html`; the redirect to 169.254.169.254 and the 1 GB stream fail silently (server log: one request each, the stream's socket closed within 1.5 s)
  - the two public pages show cards
  - nothing in `spawn.log` names a URL
- [ ] **Off:** the setting off mid-session → the panel, the controls and the cards go; the terminal and the side box are 1.4.0.
- [ ] **Fixes:** each finding gets a redacted fixture and a failing test first, then the fix, as separate commits. `docs/HANDOFF.md` 7-50 gets what the trial showed. Commit: `chat view: what the real session showed for Phase 5 (<Claude Code version>)`.

---

# Phase 6

### Task 6.1: Performance budgets and long-session tests

**Budgets** (each pinned by the test named; a perf test prints its number and fails only past the budget):

| Measure | Budget | Test |
|---|---|---|
| `buildRows` over 4,000 items (each density) | ≤ 25 ms | `tests/chat-perf.test.ts` |
| `findMatches` over 4,000 items, 1- and 6-character queries | ≤ 40 ms | same |
| Page: a 5,000-item reset (4,000 kept, `더 이전 대화는 터미널에서 보세요` at the top) → first rows painted | ≤ 300 ms | `--flow chat-perf` |
| Scroll, 30 steps of 400px | average frame ≤ 16 ms (fail > 50) | same |
| Density `default → all` over 4,000 items | settled ≤ 300 ms, ≤ 300 rows in the DOM | same |
| Find navigation to a hit 3,000 rows up | placed ≤ 200 ms | same |
| 300 MB transcript, `open` | main loop lag ≤ 50 ms; the worker's `reset` ≤ 2 s; ≤ 16 MB read | `tests/chat-perf-big.test.ts` (`SPAWN_PERF=1`) |
| 300 MB transcript, change scan | ≤ 20 s; worker heap growth ≤ 120 MB; a hook during the scan emitted ≤ 250 ms | same |
| One hour of streaming in the lens (fake clock: 600 turns, MessageDisplay every 200 ms, 3 tools a turn) | heap growth after `gc()` ≤ 25 MB; every per-terminal map bounded (`items ≤ 4000`, `live` empty between turns, `streams`, `calls`, `logged`, `asks ≤ 16`, the index under its caps) | `tests/chat-soak.test.ts` (`SPAWN_PERF=1`, `--expose-gc`) |
| One hour of streaming in the page (20,000 pushes: text, tools, live bubbles, wild events, previews) | JS heap growth after `gc` ≤ 40 MB; DOM nodes ≤ 1.2× the start; live `blob:` URLs ≤ 64; listeners not growing | `--flow chat-soak` (Chromium with `--js-flags=--expose-gc`, heap via CDP `Runtime.getHeapUsage`) |
| Previews: 200 links scrolled through | ≤ 3 fetches at once; page cache ≤ 120 | `tests/link-preview.test.ts`, `--flow chat-preview` |

**Files:** Create `tests/chat-perf.test.ts`, `tests/chat-perf-big.test.ts`, `tests/chat-soak.test.ts`, `tests/helpers.ts` additions (a synthetic transcript writer: fresh uuids, real line shapes from the fixtures, 1 MB `originalFile` lines every 50 edits; a free-disk check that skips with a message under 2 GB free); modify `tests/visual/shots.mjs` (`--flow chat-perf`, `--flow chat-soak`), `package.json` **not** touched (the big suites run with `SPAWN_PERF=1 npx vitest run tests/chat-perf-big.test.ts tests/chat-soak.test.ts` and `NODE_OPTIONS=--expose-gc`).

- [ ] **Step 1:** Write the tests and flows; run them. The ones over budget are FAIL; record every number in `.superpowers/sdd/<date>-chat-view-phase-6/perf.md` (create the folder).
- [ ] **Step 2:** Fix what exceeds a budget (one commit per cause, each with the measure before and after in its message). Usual suspects to look at first: the `WeakMap` caches of `plainOf` and markdown, `sameRow` for the new rows, the index's per-file arrays, the page's blob URLs.
- [ ] **Step 3:** Run them all again: PASS. Commit: `test: performance budgets for long chat sessions — 5,000 items, a 300 MB transcript, an hour of streaming`.

### Task 6.2: The version canary and a Claude Code newer than the verified range

**Files:** Modify `src/components/ChatView.tsx` (the note's `자세히`), `src/locales/chat.ts`, `tests/chat-host.test.ts`, `tests/chat-canary.test.ts`, `tests/visual/*`, `docs/HANDOFF.md`.

What already holds (Phases 2–4): `versionVerdict`; arming for `ok` and `new`; the `new-version` note; holds only for `ok`; re-probing every 5 minutes with the binary stamp; releasing holds when the version leaves the range.

- [ ] **Step 1: Failing tests (the matrix).** For each verdict `ok` / `new` / `old` / `unknown`, at enable time and after a mid-run change of the binary:
  - hook entries for new sessions
  - sessions already armed keep their entries
  - holds (only `ok`)
  - the composer (on for `ok` / `new`)
  - the changes index (on whenever armed)
  - previews (unaffected by the version)
  - the banner or note on open views
  - a transcript line whose `version` is older than `min` → `version` banner; newer → note only
  - one `info` log line per newly seen version, with no transcript text
- [ ] **Step 2: The note, actionable.** `확인하지 않은 Claude Code 버전({version})이에요. 이상하면 터미널로 보세요` gains `자세히` (Details / 詳細), which opens 설정 › 세션 at the 채팅 보기 help (Task 6.8) and says, in one more line, what is off for such a version: `이 버전에서는 허락·질문 버튼이 꺼지고 터미널에서 답해요` → "With this version, permission and question buttons are off; answer in the terminal." / "このバージョンでは許可・質問ボタンはオフになり、ターミナルで答えます。"
  - Surface `chat-new-version` (`--check fit`, `--lang en|ja`).
- [ ] **Step 3: Re-verifying a new version** goes into `docs/HANDOFF.md` (a numbered procedure under the 7-51 entry):
  1. run the spike scripts in `spike/spawn-chat-view-spike-keep/chat-lens/` (untracked) against the new `claude` with a throwaway `CLAUDE_CONFIG_DIR` and folder
  2. compare with FINDINGS §1 (lines), §2 (hooks and events), §4 (permission holds), §5 (questions), §6 (input), §7 (images)
  3. run the three trial checklists (7-47, 7-48, 7-49) and Task 5.12's
  4. add redacted fixtures for any new shape
  5. only then widen `SUPPORTED.below` in `electron/chatSchema.cjs` with its test
- [ ] **Step 4: Commit:** `chat view: a newer Claude Code — every part's behaviour pinned, a note that says what is off, how to re-verify`.

### Task 6.3: en / ja completeness and length

- [ ] **Step 1: Tests** (`tests/chat-ui.test.ts`):
  - every Korean literal passed to `t(` in the chat code is a key in `chat.ts`, `chatGame.ts` or an older locale
  - every key has en and ja, the same set both ways, none empty, none equal to the Korean (unless allowed: `Lv.{n}`, `{i}/{n}`)
  - placeholders match across languages (`{name}`, `{n}`, `{time}`, …)
  - `{iga}`-style particles appear only in Korean
- [ ] **Step 2: Fit.** All chat surfaces (Phases 2–5) with `--lang en` and `--lang ja` at `--text small|normal|xlarge`, `--check fit`, at 1440×900 and 1100×720. Every clip is fixed by layout, not by cutting words. Header controls may fold to icons at narrow widths, the way the view bar does (`barLevel`), with their names kept as `aria-label`.
- [ ] **Step 3: A reading pass** by the implementer: every en / ja string read in place on its shot. The wording follows the app's existing voice (short, plain; ja です/ます; no machine-literal Korean order). Changes are listed in `NOTES.txt`.
- [ ] **Step 4: Commit:** `chat view: en and ja complete, checked in place at every text size`.

### Task 6.4: Accessibility

- [ ] **Step 1: `--flow chat-a11y-walk` (keyboard only, from a fresh load):**
  - Tab reaches, in visual order, the flip, the density menu, the changes button, the list's controls (tool rows, groups, diff chips, link cards, the foot's copy, `위 내용 더 보기` sentinels), the answer surface, the composer, then the panel (resize handle, tree, `편집기에서 열기`)
  - each one works with Enter / Space / arrows as specified
  - Esc closes the menus, find and the lightbox with the focus returned
  - Ctrl/⌘+F works from every one of them
  - the focus is never lost to `body`, and never lands in a hidden `.term-view` (the warm terminal included)
- [ ] **Step 2: Names.** Through a CDP accessibility snapshot of each chat surface: every button, link, menu item, tree item, separator and input has a non-empty accessible name; the tree items have `aria-level` / `aria-expanded` / `aria-selected`; the find count and the "새 메시지" pill are live regions; the wild row reads as one sentence (game words absent in `-work`).
- [ ] **Step 3: Contrast.** `tests/tokens.test.ts` computes every new pair on every background used: the find highlights over prose and over diff rows, the link card's description, the foot, the thinking text, the panel's tree and diff rows, the selected file.
- [ ] **Step 4: Reduced motion.** With `prefers-reduced-motion: reduce` emulated: no animation runs (`getAnimations()` empty after a wild row arrives), and every scroll the chat starts (pill, find, diff chip → panel) is `auto`.
- [ ] **Step 5: Hit areas.** `--flow hit-areas` extended to every new control: ≥ 22px in both directions.
- [ ] **Step 6:** Fix what fails. Commit: `chat view: keyboard-only, names, contrast and reduced motion over every chat control`.

### Task 6.5: Privacy

- [ ] **Step 1: Tests and checks** (`tests/chat-privacy.test.ts`):
  - **Logs:** every `log(` / `console.*` call in `electron/chat*.cjs`, `electron/link*.cjs`, `electron/chatWorker.cjs` passes only fixed words, error codes and numbers (an AST-free source check: no template literal interpolating `text`, `prompt`, `url`, `href`, `file`, `path`, `title`, `body`, `command`, `content`). A run of the worker test with every fixture records the posted `{ t: 'log' }` messages, and none contains a fixture string longer than 6 characters.
  - **Crash dumps:** `crashReporter` is not started anywhere (source check), and the app writes no minidump folder of its own. If a later main merge adds one, this test fails and asks for a decision.
  - **localStorage:** a harness run through every chat flow, then a dump of `localStorage`: only the known keys, each a word, a number or the carry's id-only `chatModes`, with no fixture string in any value.
  - **Temp files:** after the image flows and a session close, the instance's image folder is gone. Link previews write no file (source check: `linkFetch.cjs` / `linkPreview.cjs` require no `fs`).
  - **The link-card cache:** memory only. It is emptied when the setting goes off (a host test), the worker stops, and on quit. The page's blob URLs are revoked (counted in `--flow chat-preview`).
  - **Requests:** previews send no app-identifying header beyond the fixed UA, and no request is made while off (Task 5.10's flow, re-run).
  - **The steps read:** `GET /pokedex` carries no token and no session text, and is made only while chat is shown and not in work mode.
- [ ] **Step 2:** Fix what fails. Commit: `chat view: privacy — nothing from a conversation in logs, storage or files; previews leave nothing behind`.

### Task 6.6: Failure drills

Each drill is a test (fake timers, a real worker, real sockets as needed) plus, where marked "trial", a check in Task 6.10 on the isolated copy. Drills that would touch the owner's machine (sleep, the clock, a full disk) are only simulated.

- [ ] **Worker killed:** `worker.terminate()` mid-scan and mid-hold → the open views show `worker`, the holds are released (`gone` for a late answer), the index state is lost and rebuilt after the restart, the composer refuses nothing new because of it, and the preview queue is dropped. A third crash → no restart, with the banner kept. (trial)
- [ ] **Endpoint port unavailable:** `makeEndpoint().listen()` rejects (`EADDRINUSE` / `EACCES`) → state `{ on: true, hooks: null, reason: 'starting' }` is never left hanging: within 3 s the reason becomes `unarmed` with a log line, `terminals:create` does not wait past 3 s, and enabling again later works. Add the reason word if the flip lacks it (`채팅 보기를 준비하지 못했어요` → Couldn't get the chat view ready / チャット表示を準備できませんでした).
- [ ] **Transcript deleted mid-session:** the file removed while open → `missing`; the changes summary `gone` (the panel says `세션 기록 파일을 찾지 못했어요` and keeps no stale list); the composer's Phase 3 behaviour unchanged; a later prompt that re-creates the file → the next turn's canary passes and the banner clears; `다시 읽기` works. (trial)
- [ ] **Disk full for temp images:** the image store's write fails with `ENOSPC` (an fs stub) → `chat:image` answers a refusal, no partial file is left (the `wx` file removed), the composer says `이미지를 저장하지 못했어요` (add it if missing; Couldn't save the image / 画像を保存できませんでした), and the next image works once space is back.
- [ ] **Clock change:** with `now` jumping −1 h and +1 h in the lens, the host and the page:
  - no banner flaps
  - the working line never shows a negative time (clamped at 0)
  - the hold timers (monotonic `setTimeout`) are unaffected
  - `clickAccepted` keeps using the monotonic clock
  - day lines follow the new date
  - step samples refuse a bracket whose end is before its start
  - wild-entry windows use `max(from, …)`
- [ ] **Sleep / resume with a hold open:** fake timers jump 2 hours in one step with a hold open → the hold is released by its own timer as `timeout` on the first tick, exactly once; a late `chat:answer` gets `gone`; the endpoint's response to a socket the client closed meanwhile is dropped without a throw; the card says `답할 시간이 지나 …`. A real sleep goes on the owner's checklist only.
- [ ] **Commit** (one per drill that needed a fix, test first): `chat view: <drill> — <what now happens>`. Then `test: failure drills for the chat view`.

### Task 6.7: Mac pass

- [ ] **Step 1:** Add every new surface to `MAC` in `shots.mjs` (`chat-changes`, `chat-thinking`, `chat-foot`, `chat-wild`, `chat-find`, `chat-link`, `chat-new-version`). Run them with `--check fit` and compare with the Windows shots.
  - The traffic-light inset: the panel and the header controls clear it.
  - The panel can open from 960px wide with the side panel at the Mac's 300px minimum, and folds below that.
- [ ] **Step 2:** `tests/mac-window.test.ts`: the new header controls, the panel and its resize handle carry `-webkit-app-region: no-drag`; ⌘F reaches find through `appShortcut`; the tooltips name keys through `modCombo`.
- [ ] **Step 3:** Fix what fails. Commit: `chat view: the Mac variants of the Phase 5 surfaces`.

### Task 6.8: Docs and the 채팅 보기 help text

- [ ] **Step 1: Help text in 설정 › 세션**, under 채팅으로 보기: a collapsible `채팅 보기란?` (What is the chat view? / チャット表示とは?) with five short lines (ko → en / ja in `settings.ts`), shown only when `CHAT_VIEW`:
  1. `세션은 그대로 터미널에서 돌아가고, 채팅은 같은 세션을 대화로 보여 줘요` / The session still runs in the terminal; the chat shows the same session as a conversation / セッションはそのままターミナルで動き、チャットは同じセッションを会話として表示します
  2. `보낸 말은 터미널 입력란에 그대로 들어가요. 확실하지 않으면 보내지 않고 알려 줘요` / What you send goes into the terminal's prompt. When the app isn't sure, it doesn't send and tells you / 送った内容はターミナルの入力欄に入ります。確かでないときは送らずにお知らせします
  3. `변경 사항은 기록에 남은 수정만 보여 줘요. 명령으로 바꾼 파일은 터미널에서 확인해 주세요` / The changes panel shows only edits in the record. Check files changed by commands in the terminal / 変更パネルは記録にある編集だけを表示します。コマンドで変えたファイルはターミナルで確認してください
  4. `링크 미리보기는 켜야만 가져와요. 가져올 때 그 사이트는 누군가 링크를 열었다는 걸 알 수 있어요` / Link previews are fetched only when turned on; fetching tells that site someone looked / リンクプレビューはオンのときだけ取得します。取得するとそのサイトに伝わります
  5. `확인하지 않은 Claude Code 버전에서는 버튼이 꺼지고, 이상하면 터미널로 보면 돼요` / With an unchecked Claude Code version the buttons are off; if something looks wrong, use the terminal / 未確認のClaude Codeバージョンではボタンがオフになります。おかしければターミナルで見てください

  It contains no game word (work-mode test). Surface `settings` with it open (`--check fit --check work --lang en|ja`).
- [ ] **Step 2:** `CHANGELOG.md` "Unreleased" completed for Phase 6 (ko / en / ja).
- [ ] **Step 3:** `docs/HANDOFF.md` entry 7-51 (the style of 7-49):
  - the budgets and their measured numbers
  - the version procedure (Task 6.2)
  - the drills and their outcomes
  - the privacy pass
  - what remains a preview and why
  - the owner's checklist (a real Korean IME in the composer and in find; a real sleep with a card open; the clock changing across midnight; a Mac; a slow PC; a week of daily use with the setting on)
  - the squash requirement before any merge (7-47)
  - update section 8's 채팅 보기 line
- [ ] **Step 4: Commit:** `docs: the chat view's help in 설정, changelog and hand-off for Phase 6`.

### Task 6.9: Insight-log records and the screen archive (Phases 2–6)

Follow `~/.claude/skills/insight-log/SKILL.md` (entries, `INDEX.md`, the `screens/` archive naming, `_inbox` captures). The portfolio is `~/Documents/spawn-portfolio`; nothing goes into the repository.

- [ ] **Step 1: Audit** `INDEX.md` against the phases.
  - Present: `2026-11-13-chat-view-as-a-lens` (design), `2026-11-15-typed-then-enter-after-echo` (Phase 3), `2026-11-15-first-answer-wins` and `2026-11-15-what-allow-approves` (Phase 4), and Phase 5's from Task 5.11.
  - For each phase without an entry for its main insight, write one from its plan's Decisions, its trial notes in HANDOFF and its `_inbox/chat-*` shots. Phase 2: "wrong is worse than missing: the canary and the banner"; Phase 6: "a preview that asks first, and budgets that are measured".
  - Mark any reconstructed "before" plainly.
- [ ] **Step 2: Screen archive.** For each phase, the dated shots of the chat's main surfaces from its final harness folder go into `screens/` under the skill's naming (date of the phase's final run, screen name, size, language). Covered: the session view in 채팅 and 터미널, `-work`, `-mac`, the composer, the cards, the changes panel, the foot, the wild row, the link card, find. Take any missing one again from the current build only when the phase's own run did not keep it, and say so in the archive's note.
- [ ] **Step 3:** No commit in the repository (the portfolio is outside it). Report the entries and the archive count to the controller.

### Task 6.10: Real-session trial (Phase 6)

**Only with the controller's go-ahead.** The set-up of Task 5.12. Drill hooks are patched into **the trial copy only**, never into the repository: a main-inspector function that terminates the chat worker, one that makes the next endpoint `listen` fail, one that makes image writes fail with `ENOSPC`.

Checklist:
- [ ] **One hour of streaming without a model:** a script writes a synthetic transcript (the fixtures' shapes, fresh ids) and posts the matching hook bodies to the copy's endpoint for 60 minutes, at the pace of a busy session. The session is a real terminal running a harmless `node` loop that prints, so no `claude` is used. Every 5 minutes, CDP heap usage of the renderer, `process.memoryUsage()` of main, and the worker's `resourceUsage` are recorded. Pass: the Task 6.1 budgets for growth.
- [ ] **A real session of a few turns**, done after the soak: all Phase 2–5 parts still work (one prompt each: tools, an edit, a permission card, a question, a link with previews on).
- [ ] **Drills:** worker terminated during a turn (the banner, the restart, then answers work); the endpoint failing at enable (the flip says so; enabling again works); transcript removed mid-session (`missing`, the panel `gone`, recovery); `ENOSPC` on an image (the refusal words, no file left).
- [ ] **The version note:** the copy's version cache is set to a newer version (by editing the copy's `chat-version.json`) → the note, holds off, the composer on.
- [ ] **Off:** off = 1.4.0 at the end (`session-settings.json` compared with the 1.4.0 bytes; the side box).
- [ ] **Fixes** as in Task 5.12. Commit: `chat view: what the hardening trial showed (<Claude Code version>)`.

### Task 6.11: Final whole-branch review

Dispatch a reviewer that has **not** seen this plan's reasoning (superpowers:requesting-code-review), with the diff `git diff cff52ac...chat-view` (release 1.4.0 → the branch; or the last merged main commit as the base, with main's own changes excluded) and this checklist. The reviewer's report goes to `.superpowers/sdd/<date>-chat-view-phase-6/final-review.md`. Every Critical and Important finding gets a failing test and a fix before the controller is told the branch is ready for the owner's test build.

Checklist:
1. **Off = 1.4.0:**
   - `session-settings.json` byte-identical (test)
   - `chat-off` pixel-equal
   - no worker, endpoint, fetch or `GET /pokedex` when off
   - `TerminalInfo` without `chat`
   - the side box and the quick-answer row as in 1.4.0
2. **The terminal view = 1.4.0** apart from the flip:
   - `git diff --exit-code` over `TerminalPanel.tsx`, `keys.ts`, `termFont.ts`, `textSize.ts`, `server/`, `hooks/`, `scripts/`, the updater and signing files, `package.json`, the lock file
   - `chat-changes-terminal`
   - `chat-reload-size` step 6
3. **Writes to a pty:**
   - only `typeForChat` in `send` / `submit` / `interrupt`
   - resizes only in `redrawForChat` from `redraw`
   - no configuration command
   - no settings file written (guards)
4. **Answers:** built only in `chatHolds.cjs`, `destination: "session"` forced, holds bounded and released on every path (guards, property test).
5. **Wrong information:**
   - banners for every doubt
   - the panel never merges and says what it lacks
   - the foot and steps only when exact
   - wild rows only for this session and conversation window
6. **Previews:** every policy row has a test, and the reviewer adds any SSRF case they think is missing. Off by default; the loopback switch unreachable in a packaged build.
7. **Privacy:** Task 6.5's checks pass, re-run.
8. **Look:**
   - yellow only on send
   - motion only in `chat-game.css`, stopped under reduced motion
   - weights, radii, sizes from tokens
   - contrast tests
   - work mode with no game word (`--check work`)
9. **Long sessions:** Task 6.1's budgets re-run on the final tree.
10. **en / ja / a11y / Mac:** Tasks 6.3, 6.4 and 6.7 re-run.
11. **No new runtime dependency;** no native module.
12. **History:**
    - the personal strings in three early commits (7-47) still require a squash before any public merge, and the report repeats it
    - no secret in the tree (the fixture guard over everything)
13. **Not done here:** no merge, no push, no release, no installer.

- [ ] **Commit** the fixes (one per finding, test first) and, last, `docs: final review of the chat view branch — findings and fixes` (HANDOFF line pointing at the report).

---

## Decisions made in this plan (the owner may overrule)

1. **No new runtime dependency.** DNS, address ranges (`net.BlockList`), decompression (`zlib`) and HTTP are Node built-ins. The meta reader (~150 lines) and the image header reader (~120 lines) are written here: an HTML parser library (parse5 or htmlparser2, MIT, 100–300 KB) would bring a DOM-shaped surface the cards do not need, and an image library (sharp) has a native build, which is ruled out. Electron's `net.request` is not used because it shares the app's session (cookies, proxy, cache).
2. **5g without `TerminalPanel.tsx`:** warm mount under an opaque chat pane, plus one `rows − 1 → rows` resize nudge, only for a terminal whose first mount replayed before it fitted (see the section above for why it is safe). The fallback, a 3-line `TerminalPanel.tsx` change, is an owner decision if the trial disagrees.
3. **The changes panel reads a worker-side index of the whole conversation** (the main transcript and its sub-agents' files). It holds counts and offsets, not text. Each edit is re-read from the transcript when shown and checked against its tool id.
4. **Edits are shown in order and never merged.** A merged view would have to invent the intermediate file contents. File totals are sums of edits, labelled as such.
5. **Files changed by commands are not guessed.** One fixed line says that only Edit / Write changes are listed. There is no git status ("커밋 안 함" is left out: nothing the app reads knows it).
6. **The panel exists only while the chat is shown**, inside the chat's own pane. The header's density and changes controls also exist only then, so the terminal's box never moves. The left panel's auto-fold is derived, never stored. Its threshold equals the lab's 1240px at the default widths. Width 260–560 (default 320; 288 in a window under 1200 with nothing remembered). The open state is remembered globally; the selected file is remembered per session in memory.
7. **In a diff block, the `+N −N` chip opens the panel at that edit, and the file name keeps opening the editor**, as the trials used it. Phase 2's seam said `openFileFromChat` would be retargeted; this plan adds a second target instead.
8. **Link previews live in the chat worker** (not main's thread, not the page), are opt-in (`session.linkPreviews`, off), use the policy table, and keep their caches in memory only. There are no favicons and no GIF, animated or SVG images. The image is decoded only in the sandboxed renderer, from bytes main checked. A card names the link's own host and shows `→ final host` when a redirect left it.
9. **Previews are requested only for rendered rows** (the virtual list), so opening a long old conversation does not contact hundreds of sites.
10. **The turn foot takes over the answer's copy** for turns that have a foot. A turn without `turn_duration` (running, interrupted) keeps the per-row copy. Counts are shown only for a turn whose start is loaded.
11. **Steps come from two reads of the existing `GET /pokedex`** that bracket a turn. They are shown only when exact (the same Pokémon, no other turn between, the end read taken while idle) and only for turns that ended while the view was open. The server publishes steps without a broadcast (`saveSoon`), so the page's dex state alone would be stale. No `server/` change.
12. **Wild rows** come from `catch` / `flee` events with this session's id inside the conversation's time window. The game words go in `src/locales/chatGame.ts`. The one entry animation goes in `src/styles/chat-game.css` and plays only for rows that arrive while the view is open. Phase 2's Decision 10 ("nothing new animates") gets this single exception, by principle 7.
13. **Thinking items are emitted** even though 2.1.32x writes them empty. 생각 포함 shows their duration and says the content is not in the record (FINDINGS §1), and shows the text if a later version writes it.
14. **Density is global and remembered** (`spawn-chat-density`), like the text size. `전부` opens rows by default without overriding a row the user closed. The virtual list's estimate and `tight` come from one table per level.
15. **Find searches plain text extracted from the store** (markdown removed), only in what is loaded (it says so), and paints with the CSS Custom Highlight API without a re-render. There is no yellow: the current match is a stronger grey. Ctrl/⌘+F comes through `appShortcut` in a `ChatView` listener; `keys.ts` is unchanged.
16. **The big performance suites run behind `SPAWN_PERF=1`** (with a free-disk check), so the everyday suite stays fast. They are run in Tasks 6.1, 6.10 and 6.11.
17. **Sleep, clock and full-disk drills are simulated**, never done on the owner's machine. Drill hooks for the trial live only in the trial copy.

## Risks

| Risk | What could go wrong | Containment |
|---|---|---|
| The redraw nudge's side effect (5g) | ConPTY / Claude Code repaint after `rows − 1 → rows` leaves one extra screenful in the scrollback; a send in the 150 ms window reads a half-drawn row | Only for `replayed-first` terminals, once, rate-limited; refused while a send is in flight; Phase 3's echo check withholds Enter on a half-drawn row; trial 5.12 checks the scrollback; the owner-decision fallback |
| Warm mount shows the terminal | A frame of terminal before the chat pane paints; the warm terminal's helper textarea takes a Tab | `.w-chat-pane` opaque even while `ChatView` loads; `focus={false}`; warm lasts two frames once visible; `chat-reload-size` samples the focus every frame |
| Detection of "replayed first" misses a case | A garbled terminal with no nudge (the 7-48 state, still safe: the composer refuses) | Any first mount not both active and visible counts; the trial covers swap, reload and background switch; the composer's refusal stays the safety net |
| Change scan on a huge transcript | Slow, or memory-heavy with multi-MB `originalFile` lines | Pre-filter by substring; parse only candidate lines; yields; a 1 GB cap → `partial`; offsets only in memory; the 6.1 budget |
| A rewritten transcript | A re-read edit no longer at its offset | Tool-id check per re-read → `stale`; the tail guard → `rewrite` banner; the index rebuilt on 다시 읽기 |
| Sub-agent files | A sub-agent's edits missing | Scanned from the allowed `subagents/` path; unreadable ones counted and said |
| SSRF through a path the tests did not imagine | A request to an internal address | Every address of every hop checked, pinned connection, ports 80/443 only, the reviewer asked to add cases (6.11); the setting off by default |
| Sites block the neutral UA, or serve no OG | Few cards | Silent failure by design; the plain link stays |
| Untrusted image bytes | A decoder bug | No decode in main or the worker; the header-only dimension check; decoding in the sandboxed renderer; PNG/JPEG/WebP only |
| `GET /pokedex` timing | A step credited after the end read | The end read 1.5 s after the turn's end line, idle only; otherwise null |
| Thinking text empty in 2.1.32x | 생각 포함 looks nearly empty | Durations and an honest line; the owner question below |
| CSS Custom Highlight API | Missing in an old engine | Electron 33 has it; a fallback outline on the current row |
| Clock skew between server events and transcript times | A wild row a few rows off | Both clocks are this machine's; placement is by time only, never inside a group |
| The page's 4,000-item cap | Find and feet limited to the loaded part | Said in the find bar; feet omit counts for partial turns; the panel does not depend on it |
| en / ja length in the header | Controls clipped at narrow widths | The view bar's fold-to-icons pattern; fit checks at every size |
| A newer Claude Code changes the transcript or hooks | Parts silently wrong | The Phase 2 canary and banners, holds off for `new`, the re-verify procedure, the version matrix tests |

## Self-review notes

**Brief → task:**
- (a) changes panel:
  - files, tree, `+N −N`: 5.3, 5.4
  - the selected file's diffs from `structuredPatch` only, in order, never invented: 5.3, Decisions 3–5
  - opened from the diff chip and the header: 5.4, Decision 7
  - resizable and remembered; auto-fold and return; 840px column; no terminal layout jump; no widget panel: 5.4, Decision 6
- (b) link previews: every policy row in 5.9; opt-in, worker, cache, which links, silent failure in 5.10; trial in 5.12
- (c) turn summary with steps and the copy moved: 5.6, Decisions 10–11
- (d) wild rows, lively, absent in work mode, no `server/` change: 5.7, Decision 12
- (e) density with the never-collapse rule, header control, remembered: 5.5, Decision 14
- (f) find over the store, Ctrl/⌘+F, count, `scrollToKey`, opening collapsed rows, `keys.ts` untouched: 5.8, Decision 15
- (g) 7-48: 5.2, the section "The hidden terminal's size", Decision 2
- Phase 6:
  - performance with budgets: 6.1
  - the version canary: 6.2
  - en/ja: 6.3
  - a11y: 6.4
  - privacy: 6.5
  - drills: 6.6
  - Mac: 6.7
  - docs and help: 6.8
  - insight log and archive: 6.9
  - trial: 6.10
  - final review: 6.11
- Trials at each phase's end: 5.12, 6.10. No merge, push or release anywhere.

**Type consistency:** `ThinkingItem`, `ChangeSummary`, `ChangeFile`, `ChangeEdit` and `LinkCardData` are defined once in `src/chat/types.ts`, mirrored in JSDoc in `chatItems.cjs` / `chatChanges.cjs` / `linkFetch.cjs`, and used under the same names in the host, the preload, `desktop.ts`, the page and the fake bridge. `CHANGE_CAPS` is the only source of the index's limits. The policy constants (`PREVIEW_CAPS`) live only in `linkFetch.cjs`. `ESTIMATE` / `TIGHT` live only in `density.ts`. The IPC names in the table match the preload (5.2, 5.3, 5.10) and the fake bridge.

**Every intermediate commit leaves the app working:**
- 5.1 adds fixtures only.
- 5.2 changes only how the chat-shown session's terminal mounts.
- 5.3 adds a back end the page ignores until 5.4.
- 5.5–5.8 each add one visible part behind the existing setting.
- 5.9 adds no UI.
- 5.10's cards appear only with the new setting on.
- Phase 6 tasks add tests, fixes and docs.

**Judgment calls a reviewer should know:** the warm mount and the nudge instead of a `TerminalPanel.tsx` edit (2); the worker index over the page's items (3); never merging edits (4); steps from `GET /pokedex` (11); one animation exception (12); previews in the worker with header-only image checks (8).

## Open questions for the owner (the recommended default in brackets; none blocks Tasks 5.1–5.4)

1. If trial 5.12 shows the redraw nudge leaving a duplicated screen in the terminal's scrollback, may `TerminalPanel.tsx` get the ~3-line exception (fit a hidden terminal to its session's last size before the replay) instead? [Yes, as a one-time owner-approved exception; until then, warm mount + nudge.]
2. Steps in the turn summary appear only for turns that ended while the chat was open, and only when exact. Is this acceptable, or should 걸음 be left out of the foot? [Keep, shown only when exact.]
3. Claude Code 2.1.32x writes thinking text empty, so 생각 포함 shows only "생각 · 6초" lines. Keep the level? [Keep; it shows text if a later version writes it.]
4. Should the changes panel include sub-agents' edits (marked as theirs)? [Yes.]
5. Wild rows: one short entry animation for an encounter that happens while you watch (principle 7), none for older ones. [Yes.]
6. Find highlights: grey instead of the terminal's yellow (calm rule: yellow is for the selection and send). [Grey.]
