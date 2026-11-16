# Chat View, Phases 3 and 4: the Composer and the Answer Buttons — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Phase 3 (Tasks 3.1–3.13) is finished, reviewed and tried on a real session before Phase 4 (Tasks 4.1–4.9) starts.

**Goal, Phase 3 (the composer).** Under the conversation of a Claude Code session shown as 채팅, a composer sends what the user writes into that session's real terminal. It is multiline, Enter sends and Shift+Enter breaks the line, and the Korean and Japanese IMEs never send half a syllable. Images arrive by paste, drop or a picker. A strip shows what Claude Code itself has queued ("대기 중 N"). 멈추기 stops the work. A quiet control row shows the model, the permission mode, HP (컨텍스트 in 업무 모드) and usage, display only. The user's message appears at once as a provisional bubble that the transcript's line replaces. Whenever the terminal's state is not certain (a dialog open, text already on its prompt row, the session gone, the echo not seen) nothing is sent, or Enter is not pressed, and the composer says why and offers the terminal. While the chat is shown, the side panel's input box gives way to the composer without changing its size.

**Goal, Phase 4 (the buttons).** A permission request is answered from the chat with 허용, 항상 허용 (a session rule) or 거부, through a held `PermissionRequest` HTTP hook that races the terminal's own dialog safely: the first answer wins, the other side drops its pending state, there is never a second answer, and a timeout hands the decision back to the terminal. A multiple-choice question is answered from the chat by holding `PreToolUse` for `AskUserQuestion`, only while the chat is the visible view of that session. Plan approval stays a read-only card with 터미널에서 답하기. All of it lives in an answer surface outside the virtual list, impossible to miss, reachable by keyboard, never answering by itself and never for a session whose chat is not shown.

**Both phases** stay behind the existing `electron/features.json` flag `chatView` and the setting 설정 › 세션 › 채팅으로 보기 (미리보기) (`session.chatView`, off by default). With either off the app is release 1.4.0: no extra hooks, no held requests, no ledger, the side panel unchanged.

**Architecture.**

*Who knows what.* The page holds the only copy of each terminal's screen: the xterm buffer of its `TerminalView`. `src/termMetrics.ts` already keeps a reader per mounted terminal (registered by `TerminalPanel.tsx` for the Mac smoke run, in every run). A new read-only `termText(id)` there returns its last lines as text, so `TerminalPanel.tsx` is not edited. Main holds the pty and, per armed terminal, an **input ledger**: what may be on the prompt row since the last submit (`clean`, `dirty`, `submitted`, `unknown`), fed by keyboard writes, side-box sends, chat sends, Esc and the lens's `UserPromptSubmit`. The worker (the Phase 2 lens) holds the conversation. It adds the queue Claude Code itself keeps (the transcript's `queue-operation` lines and `queued_command` attachments), the permission mode (hook bodies' `permission_mode`), and the cards that wait on the user.

*Sending (Phase 3) is two calls with one id.* (1) The page reads the prompt row (`promptRow(termText(id))` → `empty` / `text` / `unknown`) and calls `chat:send`. Main checks the session (armed, running, not waiting on the user, no `PermissionRequest` in the last 2 s, no send in flight, the id new) and the screen verdict against the ledger. Then it **types the text without Enter**: one bracketed paste with a leading space when the first character would change its meaning, a single-line slash command typed as is, and each image path as a paste of its own. (2) The page watches the screen for the echo (≤ 1.5 s, longer with images) and calls `chat:submit` with what it saw. Main checks again and writes `\r` only when the echo is right and nothing changed. In every other case there is no Enter: the text stays on the terminal's prompt row and the composer says so, with 터미널로 보기. Nothing is ever retried. The page's outbox shows the message as a provisional bubble that the transcript's user line (or the queue strip) replaces. A bubble not confirmed in 8 s says so and stays.

*Images (Phase 3).* The page sends the bytes (`chat:image`). Main checks them by magic bytes and size, writes them under the app's own temp folder with a name it makes, and answers with an opaque token. `chat:send` turns tokens into paths, so the page never names a path. The files go when the session ends, when a chip is removed, and at every start.

*Holds (Phase 4).* A registry in main (`electron/chatHolds.cjs`) is a pure state machine over injected timers: `waiting-bind → open → answered | released | gone`, with exactly one response per request. The endpoint keeps answering every event first, as in Phase 2, except `PermissionRequest` and a new `AskUserQuestion` route: these open a hold, and the body goes to the worker at once with the hold's id. The worker **binds** the hold (to a terminal, a call key and the data an answer needs) or **passes** it (a plan, a session it cannot place, a shape not verified), and later reports **evidence** that the call was settled elsewhere. Main releases a hold (HTTP 200 with an empty body, which means "no decision": the terminal's dialog decides) on evidence, on timeout, on any keyboard input to that pty, when a question's chat is no longer visible, when the setting goes off, when the worker exits, at quit and when the client goes. `chat:answer` is accepted only for an open hold bound to the terminal whose chat is the visible view. Main builds the JSON from what the worker bound, so the page never builds an answer. Holds exist only for a Claude Code in the verified range. A newer one gets Phase 2's passive cards.

**Tech Stack:** as Phase 2. Electron 33 main (CommonJS, `worker_threads`, `http`), React 18 + TypeScript + Vite, plain CSS on the 차분하게 2 tokens, vitest (node environment: pure functions, temp-dir IO, a real worker, a real 127.0.0.1 socket, fake timers, source checks), the screenshot harness `tests/visual/shots.mjs`. **No new dependency.**

**Spec and inputs:** `docs/superpowers/specs/2026-11-13-chat-view-design.md` (Phases 3 and 4; "How it works": Input, Images, Permissions, Questions / plan approval; "The chat view's parts": the composer). The Phase 2 plan `docs/superpowers/plans/2026-11-15-chat-view-phase-2.md` (event model, IPC, worker protocol, seams). `docs/HANDOFF.md` 7-47 (the first real trial on Claude Code 2.1.325: prompts typed while Claude works are `queued_command` attachments; `/clear`; `/compact`). The spike: `spike/spawn-chat-view-spike-keep/chat-lens/FINDINGS.md` §4 (permissions), §5 (questions, plan mode), §6 (input), §7 (images), §9–10 (two views, robustness), with its `runs/*/events.jsonl` (hook bodies, held answers, `screen` records of the TUI). **The spike folders stay untracked; nothing is copied from them except hand-written, redacted fixtures.** The reviews' seams: `.superpowers/sdd/2026-11-15-chat-view-phase-2/review-11-17.md` "Seams for the next phases" and `rereview.md` §7. The look: `~/Documents/spawn-site-lab/calm-lab/` (`app.js` `composerHtml` and `askCard`, `app.css` lines 296–309 (`.card`, `.card.ask`, `.btn`), 337–371 (composer, queue, chips, editor, send, control row), 383–390 (menu), 665–668 (lightbox), `shots-v5/s2-chat-detail.png`, `s2-work-chat.png`, `s2-size-*-chat.png`). Open the lab files; do not guess a value.

## Global Constraints

Phase 2's constraints hold unless a line below changes them. The ones repeated here are the ones each task must re-check.

- Work only in the worktree `~/Documents/spawn-chat-view` (branch `chat-view`). Never push, never build an installer. Never read or write `~/.claude` (tests set `CLAUDE_CONFIG_DIR` to a temp dir), `~/.spawn`, `%APPDATA%\spawn`, `%APPDATA%\spawn-dev` or the owner's running app. The real `claude` runs only in the two trial tasks (3.13, 4.9), each with the controller's go-ahead and in an isolated copy.
- **Off means 1.4.0.** With `chatView` false or the setting off: no chat hook entries (`session-settings.json` byte-identical, pinned), no endpoint, no worker, no holds, no ledger calls (`write()` and `sendInstruction()` call nothing new), no image folder, no `TerminalInfo.chat`, the side panel's box and quick-answer row exactly as now. The terminal view of a session (the flip on 터미널) is also 1.4.0 for the side panel: its box sends through `terminals:send` as today.
- **The chat sends only what the user wrote and chose to send.** The chat code writes to a pty in exactly three ways, all in `electron/chatHost.cjs` through one terminal-manager method `typeForChat`: the typed text of a `chat:send` (no Enter), one `\r` in an accepted `chat:submit`, and one Esc in an accepted `chat:interrupt`. Nothing else. The app never types a slash command, a configuration command (`/model`, `/config`, `/login`, `/logout`, `/permissions` …) or a key the user did not ask for. It never edits Claude Code's settings. "항상 허용" uses only the hook's session-scoped `updatedPermissions` (`destination: "session"`). A source guard pins all of this (Tasks 3.4, 4.8).
- **A wrong, doubled or lost send is Phase 3's worst failure.** Never type into a pty whose state is unknown: a dialog open, no Claude Code prompt box on the screen, text already on the prompt row, the session not armed, exited, or waiting on the user. Never type twice for one send (a `sendId` is accepted once). Never press Enter without the echo. Never drop a message silently: every refusal and every unconfirmed send is said, with 터미널로 보기. **No automatic retry, anywhere.**
- **A wrong, silent or doubled permission answer is Phase 4's worst failure.** On any doubt the request is released with no decision and the terminal's dialog decides. 허용 / 항상 허용 / 거부 need a deliberate click, or a digit key while the card has the focus. No global shortcut. Enter in the composer never reaches a card. No button is focused by default. A card shows what Claude Code did (from hooks and the transcript), never what was clicked, as the outcome.
- **Held hooks never hang Claude Code.** Every hold is bounded (permission 300 s, question 300 s, unbound 2 s) and below its entry's own `timeout` (330 s). It is released on timeout, quit, setting off, worker exit, a client that goes, keyboard input to that session, and, for questions, the chat no longer being the visible view. Every other chat hook is still answered before it is read (Phase 2's answer-first test stays).
- **Images never leave the machine.** They are read by Claude Code from a local file the app wrote under its own temp folder (`<os temp>/spawn-chat-<instance>/<terminal id>/<random>.<ext>`), named by the app, deleted with the session, on chip removal and at start. No clipboard write or read by the app for images (the paste event's data is used; Alt+V and Ctrl+V into the pty are never sent). No upload, no base64 over IPC to the page from main.
- **Korean IME correctness is a hard requirement** in the composer: no send on a keydown while composing (`isComposing`, `keyCode 229`, or between `compositionstart` and `compositionend`); Backspace and Esc during composition belong to the IME; losing the focus mid-composition keeps the text; the textarea is never `disabled` while the user may type (that would blur it and cut the syllable); nothing takes the focus from an input (Phase 2's `isTypingTarget` rule). The terminal's own IME paths are not touched.
- **The terminal is untouched.** `src/components/TerminalPanel.tsx`, `src/keys.ts`, `src/termFont.ts`, `src/textSize.ts`, `server/`, `hooks/`, `scripts/`, the updater and signing files, `package.json` and the lock file are not edited. `src/termMetrics.ts` gains one read-only function.
- **Look (차분하게 2):** Phase 2's rules. Yellow (`--accent`) appears in exactly one new place: the send button. 멈추기 is ink, cards are amber-edged (`.card.ask`: amber 38 % border and a 2px amber left bar), the 허용 button is the lab's `.btn.solid` (ink on dark). Hairlines, weights 400/500, radii 3/4/6/8, literal font stacks (no `var()` in `font-family`), every size from `--t-*`. **Nothing new animates** (no caret blink, no spinner, no slide; hover colour changes only).
- **업무 모드:** "에이전트" and the neutral glyph; the placeholder `에이전트에게 지시하기…`; the control row says 컨텍스트, never HP; no new string in `src/locales/chat.ts` matches `GAME_WORDS` (`tests/helpers.ts`), and the HP label comes from the side panel's existing `barLabel` path.
- **Text size:** every new size reads `--t-prose`, `--t-ui`, `--t-meta`, `--t-micro`, `--t-code`.
- **ko / en / ja for every string.** New chat strings go in `src/locales/chat.ts`.
- **macOS:** the same code. Paste (⌘V) and drop come in as DOM events. Tooltips name keys through `modCombo()` / `modLabel()`. `src/keys.ts` is not edited. Nothing new is a window drag region.
- **Accessibility:** every control has a label; the composer owns the focus by Phase 2's focus rules (taken only after the user's own flip or session switch, never from an input); DOM order is visual order (list → answer surface → queue strip → chips → textarea → send → control row); refusals are `role="status"`; a new card is announced once (`aria-live="assertive"`, a visually hidden line) without moving the focus; hit areas ≥ 22px.
- Green before every commit, from Git Bash in the worktree: `npx vitest run`, `npx tsc --noEmit -p .`, `npx vite build`. UI tasks also run the harness checks they name.
- One commit per task (or per step that says "Commit"). Each message ends with the trailer line `Claude-Session: https://claude.ai/code/session_01LECh1AuSxY28Be3QgsqBWD`.
- **Out of scope (seams kept):** a `/` command menu (no safe source; Decision 5), "지금 보내기" and removing a queued prompt (Decision 7), "다시 보내기" on a user message, "고쳐 달라고 하기" on a failed row, suggested prompts in the empty state, thumbnails for images not sent from this composer in this run, changing the model or permission mode from the chat, answering a plan, answering a multi-select or multi-question `AskUserQuestion`, the 변경 사항 panel, link cards, density levels (the per-density table of `ESTIMATE` and `tight` the review named is Phase 5's), find.

## Review Focus

Ordered by how likely each is to hurt the user, most likely first. Each has its check in the owning task.

**Phase 3**
1. **A wrong, doubled or lost send.** A dialog appearing between the paste and Enter (Enter would answer it), a greyed suggestion taken for typed text or the reverse, a double click, a page that dies mid-send, a queued prompt, a long paste collapsed by Claude Code, an image that has not loaded. → Tasks 3.2 (row and echo parsers), 3.3 (encoding, ledger), 3.4 (send / submit state machine, property test: no `\r` ever without an accepted submit), 3.7 (orchestration), 3.11 (`chat-send*` flows), 3.13 (trial).
2. **The Korean IME and the focus.** → Tasks 3.7 (`composerKeys` sequences), 3.8 (never `disabled`), 3.9 (focus ownership), 3.11 (`chat-send-ime`, `chat-compose-focus`).
3. **Off is no longer 1.4.0, or the terminal changes.** → Tasks 3.4 (no `onInput` when off; `sendInstruction` bytes unchanged), 3.9 (side box pixel-equal in terminal mode), 3.11 (`chat-off`), 3.12 (the `git diff --exit-code` list).
4. **Images: a path the page chose, a file left behind, a non-image sent.** → Task 3.5.
5. **A strip or a bubble that lies** (a queue that is not Claude Code's, a bubble that never resolves and says nothing). → Tasks 3.6, 3.7.

**Phase 4**
1. **A wrong, silent or doubled answer.** A late click after the terminal answered, two holds with the same call key, a click on a card of a session not shown, Enter typed in the composer, a deny that is not a deny. → Tasks 4.2 (exactly-once property test), 4.4 (evidence), 4.5 (visibility, keyboard release), 4.6 (focused-card keys), 4.7 flows, 4.9 trial.
2. **Claude Code hangs on a hold.** → Tasks 4.2 (fake-timer bounds), 4.3 (real socket: released on timeout, quit, drain, abort; entry timeouts > holds), 4.5 (off, crash, quit, hidden).
3. **A settings file written.** → Tasks 4.2 (`destination: "session"` only), 4.8 (guard), 4.9 (trial: no file changed).
4. **The answer surface missed** (scrolled up, collapsed, in another session). → Tasks 4.6, 4.7.

---

## File map

| File | After this plan |
|---|---|
| `src/termMetrics.ts` | + `termText(id): string \| null` (read-only) |
| `src/chat/promptRow.ts` (new) | The prompt row of a Claude Code screen; the echo check |
| `electron/chatInput.cjs` (new) | Sanitising, the leading-space rule, slash commands, bracketed-paste framing, image pastes, the echo expectation, the input ledger (pure) |
| `electron/chatImages.cjs` (new) | Magic bytes, caps, the temp folder, save / path / drop / sweep |
| `electron/chatHolds.cjs` (new, Phase 4) | The hold registry and the answer bodies (pure over injected timers) |
| `electron/chatHooks.cjs` | Phase 4: hold routes in the endpoint; `chatHookEntries({ …, holds })` |
| `electron/chatHost.cjs` | `chat:send`, `chat:submit`, `chat:interrupt`, `chat:image`, `chat:image-drop`, `chat:files`; the ledgers; Phase 4: the holds, `chat:visible`, `chat:answer` |
| `electron/chatLens.cjs`, `chatSchema.cjs`, `chatWorker.cjs` | Queue from `queue-operation` lines, `status.mode`, the prompt signal; Phase 4: bind / pass / evidence, `status.asks` |
| `electron/terminals.cjs` | `typeForChat(id, data)`, `clearAsking(id)`, `chat.onInput` called from `write()` / `sendInstruction()` for armed sessions only; groups as arrays in `sessionSettingsJson` (null case byte-identical) |
| `electron/main.cjs` | ~10 lines: `chat.onInput`, the window's visibility to the host (Phase 4), all inside the existing `CHAT_VIEW` / `chatHost` guards |
| `electron/preload.cjs`, `src/desktop.ts` | + `chat.send`, `submit`, `interrupt`, `image`, `dropImage`, `files`, `visible`, `answer` |
| `src/chat/types.ts` | + `UserItem.pending`, `LensStatus.queued / queuedCount / mode / asks`, `AskCard` |
| `src/chat/outbox.ts` (new) | Provisional bubbles, reconciliation, sent-image thumbnails |
| `src/chat/send.ts` (new) | The page's send sequence (preflight, send, echo, submit) with injected bridge, screen and clock |
| `src/chat/composerKeys.ts` (new) | Key decisions for the composer and the cards, IME-safe (pure) |
| `src/components/chat/Composer.tsx`, `QueueStrip.tsx`, `ImageChips.tsx`, `Lightbox.tsx`, `ControlRow.tsx`, `MentionMenu.tsx` (new) | The composer |
| `src/components/chat/AnswerSurface.tsx`, `PermissionCard.tsx`, `QuestionCard.tsx`, `PlanCard.tsx` (new, Phase 4) | The answer surface |
| `src/components/ChatView.tsx` | The composer's focus; the answer surface between the list and the footer |
| `src/Widget.tsx` | `footer={<Composer…/>}`; the side box's pointer while the chat is shown |
| `src/styles/chat.css`, `src/styles/widget-expanded.css` | Composer, cards, pointer |
| `src/locales/chat.ts` | Strings |
| `src/QaPage.tsx` | Sections 채팅 › 입력란 and 채팅 › 답하기 |
| `tests/fixtures/chat/screens/*.txt`, `queue.jsonl`, `hooks-input.jsonl`, `hooks-permission.jsonl`, `hooks-question.jsonl`, `rejected.jsonl`, `answers/*.json` (new) | Redacted fixtures |
| `tests/chat-*.test.ts` (new and edited), `tests/terminals.test.ts`, `tests/chat-fixtures.test.ts`, `tests/chat-ui.test.ts`, `tests/work-mode.test.ts` | See tasks |
| `tests/visual/fake-bridge.js`, `shots.mjs`, `chatFixture.mjs`, `README.md` | Composer and card surfaces and flows |

## The event model: additions (main → page)

`src/chat/types.ts` gains exactly this. `electron/chatLens.cjs` mirrors it in JSDoc, and `tests/chat-items.test.ts`'s runtime checker learns the new fields.

```ts
/** A message from this composer not yet seen in the transcript (page-only: main never sends `pending`) */
export interface UserItem extends ItemBase {
  kind: 'user'; text: string; images: number; truncated?: boolean
  pending?: 'sending' | 'sent' | 'unconfirmed'; local?: string   // the outbox entry it stands for
}
export const PENDING_BASE = LIVE_BASE - 2 ** 32                   // after every transcript line, before the new turn's hook rows

export type PermissionMode = 'default' | 'acceptEdits' | 'plan' | 'auto' | 'bypassPermissions' | 'dontAsk'
export interface QueuedPrompt { text: string; truncated: boolean }

/** Something the session waits on the user for (Phase 4). `holdId` null: it can only be answered in the terminal */
export interface AskCard {
  key: string                                   // stable: the hold id, else 'ask:' + tool row id or call key
  holdId: string | null
  kind: 'permission' | 'question' | 'plan'
  toolId: string | null                         // the paired tool row, when known
  agent: boolean                                // a sub-agent's request
  tool: string                                  // tool name as Claude Code gave it
  input: ToolInput                              // the whitelisted excerpt (Phase 2's toolInput)
  diff?: DiffBlock                              // Edit / Write: what would change (capped)
  always: { rule: string } | null               // 항상 허용 offered: the rule it adds for this session
  question?: { text: string; header?: string; options: { label: string; description?: string }[] }
  state: 'open' | 'sent' | 'timeout' | 'terminal'
  sent?: 'allow' | 'always' | 'deny' | 'option'
  since: number
}

export interface LensStatus {
  // … Phase 2's fields, unchanged …
  queued?: QueuedPrompt[]                       // what Claude Code queued, oldest first (at most 3 sent)
  queuedCount?: number                          // all of them
  mode?: PermissionMode | null                  // the permission mode the hooks last reported
  asks?: AskCard[]                              // Phase 4: oldest first
}
```

## IPC: additions

| Name | Kind | Payload → answer |
|---|---|---|
| `chat:send` | invoke | `{ id, sendId, text, images: string[] /* tokens */, screen: 'empty' \| 'text' \| 'unknown' }` → `{ ok: true, expect: Expect, command: boolean } \| { ok: false, reason: SendRefusal }` |
| `chat:submit` | invoke | `{ id, sendId, echo: 'ok' \| 'mismatch' \| 'blocked' \| 'timeout' }` → `{ ok: true } \| { ok: false, reason: 'not-in-flight' \| 'no-echo' \| 'waiting' \| 'no-session' }` |
| `chat:interrupt` | invoke | `id` → `{ ok: true } \| { ok: false, reason: 'not-working' \| 'waiting' \| 'sending' \| 'debounced' \| 'no-session' }` |
| `chat:image` | invoke | `{ id, bytes: Uint8Array }` → `{ ok: true, token, type } \| { ok: false, reason: 'type' \| 'size' \| 'limit' \| 'off' }` |
| `chat:image-drop` | send | `{ id, token }` |
| `chat:files` | invoke | `{ id, query }` → `{ ok: true, files: string[] } \| { ok: false }` (Task 3.10) |
| `chat:visible` | send | `{ id: string \| null }` (Phase 4: the terminal whose chat is the shown view, or none) |
| `chat:answer` | invoke | `{ id, holdId, choice: 'allow' \| 'always' \| 'deny' \| 'option', option?: number }` → `{ ok: true } \| { ok: false, reason: 'gone' \| 'not-bound' \| 'other-session' \| 'hidden' \| 'invalid' \| 'not-answerable' }` |

`SendRefusal = 'off' | 'no-session' | 'not-claude' | 'unarmed' | 'duplicate' | 'sending' | 'waiting' | 'screen' | 'prompt-busy' | 'empty' | 'too-long' | 'images'`. `Expect = { head: string; images: number; long: boolean }`. Every handler goes through main's `guard`. All handlers are registered by `chatHost.registerIpc`, which exists only when `CHAT_VIEW` is true.

## Worker protocol: additions

main → worker: `{ t: 'hook', event, raw, at, hold?: string }` (a held request: its id); `{ t: 'hold-state', holdId, state: 'sent' | 'timeout' | 'terminal' | 'gone', choice? }`.
worker → main: `{ t: 'prompt', id }` (a `UserPromptSubmit` mapped to terminal `id`: the ledger's clean signal); `{ t: 'hold-bind', holdId, id, kind, key, data }`; `{ t: 'hold-pass', holdId, why }`; `{ t: 'hold-resolved', holdIds, why }`.

## The send, step by step (one `sendId`)

| Step | Where | What | On failure |
|---|---|---|---|
| 0 | page | Nothing to send (empty text, no image) → nothing happens. The session waits on the user (`status.state === 'waiting'` or an open card) → refuse locally with `waiting`. | note |
| 1 | page | `promptRow(termText(id))`. `unknown` → refuse locally with `screen` (no IPC). | note + 터미널로 보기 |
| 2 | page | Outbox entry `sending` (not for a slash command). `chat.send(…)`. | entry removed, note |
| 3 | main | Checks in order: on, terminal running, Claude, armed, `sendId` new (last 32 kept), nothing in flight (a chat send or a side-box send within its 200 ms), not waiting (the lens status main mirrors) and no `PermissionRequest` hook in the last 2 s, the screen verdict with the ledger (`mayType`), text after `sanitize` non-empty or images present, ≤ 20 000 characters, ≤ 8 tokens all known. Then the steps of `encodeSend` are written, spaced as they say; the ledger becomes `dirty`; the send is in flight (3 s). | `{ ok: false, reason }`, nothing written |
| 4 | page | Poll `echoState(termText(id), expect)` every 50 ms for 1500 ms (+ 500 per image). `blocked` (a dialog) or `mismatch` stop at once. | — |
| 5 | page | `chat.submit({ echo })`. | — |
| 6 | main | In flight with this `sendId`, `echo === 'ok'`, still running, not waiting, no `PermissionRequest` since step 3, and at least `minEnterMs` (150 + 250 per image) since the last typed step → write `\r`, ledger `submitted`, in flight cleared. Else no `\r`, ledger `dirty`, in flight cleared. | `{ ok: false, reason }`; the composer says the text is on the terminal's prompt row; the draft is cleared (sending it again would double it) |
| 7 | page | Outbox `sent`. Reconciled with the transcript's user line, a `queued_command`, or the queue strip; 8 s without → `unconfirmed` ("기록에서 아직 보이지 않아요 · 터미널로 보기"). | stays said |
| — | main | In flight for 3 s with no submit (a page that died) → cleared, no Enter, ledger `dirty`. `submitted` becomes `clean` on the worker's `prompt` for this terminal, or `unknown` after 5 s. | logged once |

## The hold, state by state (Phase 4)

| State | Entered by | Leaves to | Response |
|---|---|---|---|
| `waiting-bind` | `open()` from the endpoint | `open` (worker `hold-bind`, and for a question the chat of that terminal visible); `released` (worker `hold-pass`, 2 s unbound, a question whose chat is not visible) | none yet |
| `open` | bind | `answered` (an accepted `chat:answer`); `released` (timeout, evidence, keyboard input to that pty, question hidden, off, worker exit, version change, quit); `gone` (the client closed) | none yet |
| `answered` | — | — (final) | the answer JSON, once |
| `released` | — | — (final) | 200 with an empty body, once ("no decision") |
| `gone` | — | — (final) | none (no socket) |

A final state never changes and never responds again (`h.done`). Every transition is sent to the worker (`hold-state`), which updates the card.

## Seams for Phase 5 (leave them clean)

- The composer's `insertText(text)` handle exists (the `@` menu uses it), so "고쳐 달라고 하기" and "다시 보내기" can put text in the draft without sending.
- `chat:send` takes `text` and `images` only; a suggested prompt later calls the same `sendDraft`.
- `AskCard` is in `status`, not in items, so density levels never hide a card.
- The per-density table (`ESTIMATE`, `tight`) the review asked for stays Phase 5's; the composer and the surface sit outside the list and change no row height.

---

## Visual verification (one method for both phases)

As in Phase 2. UI tasks end with "the visual steps":
1. `npx vite build`
2. `node tests/visual/shots.mjs --out "~/Documents/spawn-portfolio/_inbox/chat-3/<NN-task>/" --only <surfaces>` (Phase 4: `_inbox/chat-4/`)
3. Open each PNG with the Read tool. Compare it with the lab shot named in the task. A difference that is not in "Decisions" and not out of scope is a defect: fix it, or report it with the shot.
4. Run the checks and flows the task names (`--check fit`, `--check work`, `--flow …`); they exit non-zero on failure.

The harness gets a **fake screen**: a flow writes a fixture screen from `tests/fixtures/chat/screens/` into the real xterm of the fake terminal through the fake bridge's `onData` (`\x1b[2J\x1b[H` first, lines joined by `\r\n`), so `termText()` reads a real buffer. Lab references: the composer → `s2-chat-detail.png` (bottom), `s2-work-chat.png`, `s2-size-smallest-chat.png`, `s2-size-largest-chat.png`; the cards → `app.js` `askCard()` and `app.css` 296–309 (no shot shows a card on its own: use the lab page with the permission state, `index.html`, as the reference and screenshot it once into the task's folder).

---

# Phase 3: the composer

### Task 3.1: Fixtures for input: screens, queue, hook bodies

No product code. The screens are **hand-written** from the shapes of the spike's `screen` records (`runs/r2`, `r4` `events.jsonl`, `what: "screen"`) and FINDINGS §6–7: the solid rule `─` (U+2500) above and below the prompt, the prompt mark `❯` (U+276F), continuation lines indented by two spaces, the footer under the lower rule (`  ⏸ manual mode on · ? for shortcuts`), the spinner line above the box while working (`✻ … · done …` after), and dialogs drawn with dashed rules `╌` (U+254C) and a `❯ 1. Yes` menu. Paths are `~\work\demo`; prompts are harmless text (rivers, `add` / `mul`). No ESC character in any screen.

**Files:**
- Create `tests/fixtures/chat/screens/` (100 columns unless named):
  - `idle-empty.txt` (the logo block, the effort line, the box with `❯` alone, the footer)
  - `idle-placeholder.txt` (`❯ Try "how does <filepath> work?"`, the first-run greyed hint)
  - `after-turn-suggestion.txt` (a finished turn, then `❯ Read it first, then add mul`: a greyed suggestion)
  - `typed.txt` (`❯ add a mul function`), `typed-multiline.txt` (three lines, the second and third indented by two spaces)
  - `working-empty.txt` (an answer streaming above, the spinner line, the box with `❯` alone)
  - `dialog-bash.txt` (the Bash permission dialog, four options, dashed rules, `Esc to cancel · Tab to amend`), `dialog-edit.txt` (a diff and three options), `dialog-plan.txt` (the plan approval menu), `dialog-trust.txt` (a folder-trust question with `❯ 1. Yes, proceed`), `dialog-question.txt` (an `AskUserQuestion` with two options)
  - `echo-plain.txt` (`❯ Without tools, name three rivers`), `echo-korean.txt` (`❯ 강 세 개만 알려 줘`), `echo-pasted.txt` (`❯ [Pasted text #1 +40 lines]`), `echo-image.txt` (`❯ what is in this picture? [Image #1]`), `echo-image-pending.txt` (the path still as text), `echo-after-suggestion.txt` (`❯ Read it first, then add mulWithout tools, …`: a paste that landed after a suggestion)
  - `narrow-wrap.txt` (40 columns: a long typed line wrapped inside the box), `bash-mode.txt` (`! ls` in the box), `no-box-shell.txt` (a shell prompt after Claude Code exited), `short.txt` (two lines)
- Create `tests/fixtures/chat/queue.jsonl`: an `enqueue`, a second `enqueue`, a `remove` with `reason: "absorbed_mid_turn"` (the 2.1.325 shape of `queued.jsonl`), its `queued_command` attachment, a `dequeue` (assumed shape: `operation` and `content`, as `enqueue`), an operation not known (`"operation": "shuffle"`), a user line that runs the second prompt as the next turn, `system/turn_duration`.
- Create `tests/fixtures/chat/hooks-input.jsonl`: `UserPromptSubmit` with `permission_mode` `default`, then `acceptEdits`, then a value not known (`"warp"`); a `PreToolUse` with `permission_mode: "plan"`.
- Modify `tests/chat-fixtures.test.ts`: `.txt` files are scanned too (owner names, private digests, paths only `~\work\demo` or `C:\Users\user\`); each screen line ≤ 200 characters; no `\x1b`; `hooks-*.jsonl` rules as before.

- [ ] **Step 1: Failing test:** the fixture test lists the new names and fails on the missing folder.
- [ ] **Step 2: Write the fixtures.** Run `npx vitest run tests/chat-fixtures.test.ts`: PASS.
- [ ] **Step 3: Commit:** `test: redacted terminal screens, queue lines and input hook bodies for the chat composer`.

### Task 3.2: Reading the prompt row (`src/chat/promptRow.ts`, `src/termMetrics.ts`)

**Files:**
- Modify: `src/termMetrics.ts` (+ `termText`)
- Create: `src/chat/promptRow.ts`, `tests/chat-prompt-row.test.ts`

**Interfaces:**
- `termText(id: string): string | null`: the registered reader's `text` (the last 80 buffer lines, right-trimmed, as `TerminalPanel` registers it), `null` when no reader is registered or it throws. Read-only; the comment says the composer reads the prompt row with it.
- `type RowVerdict = { kind: 'empty' } | { kind: 'text'; text: string } | { kind: 'unknown'; why: 'no-reader' | 'short' | 'dialog' | 'no-box' }`.
- `promptRow(screen: string | null): RowVerdict`:
  - `null` → `no-reader`; fewer than 3 non-empty lines → `short`.
  - Drop trailing empty lines. Look only at the last 24 lines.
  - **The box:** from the bottom, the last line `R2` that is a solid rule (`/^\s*─{20,}\s*$/`), then the nearest solid rule `R1` above it with 1–12 lines between. The first line between must match `/^❯(?: |$)/`; the others must be empty or start with two spaces. At most 4 lines below `R2` (the footer), none of them a menu line. Found → the content is the first line after `❯ ` plus the continuation lines without their two spaces, joined by `\n`, trimmed → `''` gives `empty`, else `text`.
  - **A dialog:** any of the last 24 lines matching `/^\s*❯\s*\d+\.\s/` (a numbered menu with the selection mark), or a dashed rule (`/╌{20,}/`) below the last solid rule → `dialog`. A dialog wins over a box found above it.
  - Anything else (a `!` bash-mode box, `>` instead of `❯`, a shell) → `no-box`. Only the verified shape counts as a box.
- `echoState(screen: string | null, expect: { head: string; images: number; long: boolean }): 'ok' | 'pending' | 'mismatch' | 'blocked'`:
  - `promptRow` is `unknown` with `dialog` → `blocked`; another `unknown` or `empty` → `pending`.
  - `text`: whitespace collapsed. When `expect.head` is non-empty, the text must **start with** it, or, when `expect.long`, start with `[Pasted text #`. Otherwise `mismatch` (something was there before the paste: a suggestion it appended to).
  - `expect.images > 0`: the text must hold `[Image #` that many times; fewer → `pending` (Claude Code reads the file first); a raw path still in the text after the deadline → the caller sends `timeout`.
  - Else `ok`.

- [ ] **Step 1: Failing tests** over every screen fixture:
  - `idle-empty`, `working-empty` → `empty`
  - `idle-placeholder`, `after-turn-suggestion`, `typed` → `text` with that text; `typed-multiline` → three lines joined by `\n`
  - every `dialog-*` → `unknown/dialog`; `bash-mode`, `no-box-shell` → `unknown/no-box`; `short` → `short`; `null` → `no-reader`
  - `narrow-wrap` → `text` with the continuation joined
  - `echoState`: `echo-plain` with head `Without tools, name thre` → `ok`; `echo-after-suggestion` with the same head → `mismatch`; `echo-pasted` with `long: true` → `ok`, with `long: false` → `mismatch`; `echo-image` with `images: 1` → `ok`; `echo-image-pending` → `pending`; `dialog-bash` → `blocked`; `idle-empty` → `pending`; `echo-korean` with head `강 세 개만 알려 줘` → `ok`
  - a 2 000-line synthetic screen parses in < 5 ms (only the last 24 lines are looked at)
  - `termText` returns `null` with no reader, and the reader's `text` with one (register a fake through `trackTermMetrics`)
  
  Run: FAIL.
- [ ] **Step 2: Implement.** Run: PASS, plus `tsc`.
- [ ] **Step 3: Commit:** `chat composer: read the terminal's prompt row and the echo of a send from the page's own screen`.

### Task 3.3: What is typed (`electron/chatInput.cjs`)

**Files:**
- Create: `electron/chatInput.cjs`, `tests/chat-input.test.ts`

**Interfaces** (all pure):
- `INPUT_CAPS = { chars: 20_000, images: 8 }`, `ENTER = '\r'`, `ESC = '\x1b'`, `PASTE_START = '\x1b[200~'`, `PASTE_END = '\x1b[201~'`. These constants are the only place the chat code spells Enter, Esc or the paste brackets.
- `sanitize(text): string`: CRLF and CR → LF; remove every C0 control except `\n` and `\t`, plus DEL and the C1 range (so no `\x1b[201~` can end a paste early); trim trailing whitespace of the whole; keep leading spaces (a leading space the user typed means "literally").
- `isCommand(text): boolean`: single line and `/^\/[A-Za-z][\w:.-]{0,63}(?:[ \t]|$)/`.
- `literalPrefix(text): '' | ' '`: `' '` when the first character is `!`, `#` or `@`, or it is `/` and `isCommand` is false; `''` otherwise (and when the text already starts with a space).
- `quotePath(p)`: `"p"` when it has whitespace, else `p` (as `TerminalPanel`'s drop does).
- `encodeSend({ text, images }: { text: string; images: string[] /* absolute paths */ }): { steps: { data: string; waitMs: number }[]; expect: { head: string; images: number; long: boolean }; command: boolean; minEnterMs: number }`:
  - A command (`isCommand`, no images): one step, the text **typed as is** (as the spike typed `/model`, `/clear`), `waitMs: 0`; `expect.head` is the text; `command: true`.
  - Otherwise: one step `PASTE_START + literalPrefix + text + PASTE_END` (skipped when the text is empty), then for each image a step `' ' + PASTE_START + quotePath(path) + PASTE_END` with `waitMs: 60` before it. `expect.head` = the first 24 characters of the prefixed text's first line with whitespace collapsed and the leading space dropped (the box shows `❯ ` + text); `expect.long` = the text has a newline or is over 200 characters; `expect.images` = the image count.
  - `minEnterMs = 150 + 250 × images` (FINDINGS §6: Enter 150 ms after the text worked every time; images need Claude Code to read the file).
- **The ledger:** `type Draft = 'clean' | 'dirty' | 'submitted' | 'unknown'` and `nextDraft(d: Draft, ev): Draft` with `ev`:
  - `{ via: 'keyboard', data, dialog }` (`dialog`: the lens says waiting or the terminal's `asking` flag is set: keys answer the dialog, not the prompt). With `dialog` → `d` unchanged. Otherwise the data is read token by token: printable text or a bracketed paste → `dirty`; `\r` → `dirty` becomes `submitted`, others unchanged; Backspace (`\x7f`, `\b`) → `clean` stays `clean`, else `unknown`; left / right / home / end sequences → unchanged; anything else (Esc alone, ↑ ↓ history, Tab which accepts a suggestion, Ctrl+C, Ctrl+U, an unknown sequence) → `unknown`.
  - `{ via: 'side', phase: 'typed' | 'enter' }` (the side box's `sendInstruction`) → `dirty` / `submitted`.
  - `{ via: 'chat', phase: 'typed' | 'enter' | 'aborted' }` → `dirty` / `submitted` / `dirty`.
  - `{ via: 'esc' }` → `unknown` (Esc may put queued prompts back into the input).
  - `{ via: 'prompt' }` (the lens heard `UserPromptSubmit`) → `submitted` and `clean` become `clean`; `dirty` stays `dirty`; `unknown` stays `unknown`.
  - `{ via: 'timeout' }` (5 s after `submitted`) → `unknown`.
- `mayType(screen: 'empty' | 'text' | 'unknown', d: Draft): boolean`: `empty` → true; `text` → `d === 'clean'` (then the text is a greyed suggestion, which a paste replaces; the echo check makes sure); `unknown` → false.

- [ ] **Step 1: Failing tests:**
  - `sanitize`: `'a\r\nb\rc'` → `'a\nb\nc'`; `'x\x1b[201~y'` → `'x[201~y'`; `'\u0007bell'` → `'bell'`; `'  keep lead  \n'` → `'  keep lead'`; Korean and emoji unchanged
  - `literalPrefix`: `!ls` → space; `#note` → space; `@README.md look` → space; `/compact` → `''`; `/usr/bin is slow` → `''` (command-shaped: passed through; the composer's hint says so); `/ path` → space; `//x` → space; `hello` → `''`; ` /compact` → `''`
  - `encodeSend` table: a plain line → one bracketed paste and the right head; three lines → one paste with the newlines inside (never one Enter per line), `long: true`; `/compact` → typed raw, `command: true`; `/compact\nmore` → not a command (pasted with a leading space); text + 2 images with a space in one path → three steps, the second path quoted, `minEnterMs` 650; images only → two image steps, `head: ''`
  - no step's data contains `\r` or `\n` outside a paste (a property test over 1 000 random strings with control characters, CR and the paste brackets)
  - `nextDraft` table: every row above, including `'1'` with `dialog: true` → unchanged; `'abc'` then `'\x7f\x7f\x7f'` → `unknown` (not counted back to clean); Tab on `clean` → `unknown`
  - `mayType` table
  
  Run: FAIL.
- [ ] **Step 2: Implement.** Run: PASS.
- [ ] **Step 3: Commit:** `chat composer: what is typed into the terminal — sanitised, bracketed, the leading-space rule, and the input ledger`.

### Task 3.4: The send path in main (`chat:send`, `chat:submit`, `chat:interrupt`)

After this task the back end can send. Nothing in the page calls it yet.

**Files:**
- Modify: `electron/terminals.cjs`, `electron/chatHost.cjs`, `electron/chatHooks.cjs` (the endpoint tells the host each event's name as it arrives, before reading: `onArrive(event)`), `electron/main.cjs`, `electron/preload.cjs`, `src/desktop.ts`
- Test: `tests/chat-send.test.ts` (new), `tests/terminals.test.ts`, `tests/chat-hooks.test.ts`, `tests/chat-ui.test.ts` (guard)

**Interfaces:**
- `terminals.cjs`:
  - `createTerminalManager({ …, chat = { state, onInput? } })`. In `write(id, data)` and in `sendInstruction(id, text)`, **only when `t.chatArmed` and `chat.onInput` is a function**, call `chat.onInput(id, data, 'keyboard')` / `chat.onInput(id, null, 'side', 'typed' | 'enter')` after the existing writes. The writes and their order and timing are unchanged.
  - `typeForChat(id, data): boolean`: the pty of a running, armed Claude Code terminal gets `data`; `false` otherwise. No other bookkeeping. `activity?.input()` as `write` does.
  - `clearAsking(id)`: `t.scan = ''`, and `asking` false with a list broadcast when it was true (what `write` does on Enter). Used by Phase 4 only.
- `chatHost.cjs` gains, per terminal, `{ draft: Draft, inFlight: { sendId, at, steps, lastStepAt, minEnterMs } | null, sendIds: string[] (last 32), sideUntil: number, lastEsc: number, submittedTimer }`, and globally `lastPermissionAt` (set by the endpoint's `onArrive('PermissionRequest')`).
  - `onInput(id, data, via, phase)` → `nextDraft`; a side `typed` also sets `sideUntil = now + 200`.
  - The worker's `{ t: 'prompt', id }` → `nextDraft(…, { via: 'prompt' })`.
  - `send({ id, sendId, text, images, screen })`: the checks and writes of "The send, step by step" step 3. The steps are written with `timers.setTimeout` per `waitMs`; the answer comes after the last step is written. Image tokens → paths through the image store (Task 3.5; until then any token → `images`).
  - `submit({ id, sendId, echo })`: step 6. The `\r` is `ENTER` from `chatInput.cjs`, written once, after `minEnterMs` since the last step (it waits the remainder, then re-checks).
  - `interrupt(id)`: armed, running, the mirrored status `working`, no card, nothing in flight, 1 s since the last → `typeForChat(id, ESC)`, ledger `nextDraft(…, { via: 'esc' })`.
  - The mirrored status is Phase 2's `statuses` map (filled by `forward`).
- `main.cjs`: `chat: { state: …, onInput: CHAT_VIEW ? (…a) => chatHost?.onInput(…a) : undefined }`.
- `preload.cjs`: `chat.send(p)`, `chat.submit(p)`, `chat.interrupt(id)` → `invoke('chat:send' | 'chat:submit' | 'chat:interrupt', …)` with plain objects (strings, string arrays, numbers only; anything else dropped).

- [ ] **Step 1: Failing tests** (`tests/chat-send.test.ts`: a fake terminal manager with a fake pty recording `{ data, at }`, fake timers, a host built with fakes):
  - **happy path:** `send` with screen `empty` → the pty got exactly `\x1b[200~hello\x1b[201~` and no `\r`; `submit` `ok` at +40 ms → `\r` once at ≥ +150 ms; the answer `{ ok: true }`
  - `sendId` used twice → `duplicate`, nothing written; a second `send` while in flight → `sending`; a `send` within 200 ms of a side-box send → `sending`
  - `submit` with `mismatch`, `blocked` or `timeout` → no `\r`; the draft `dirty`; then `send` with screen `text` → `prompt-busy`
  - a `PermissionRequest` arriving between `send` and `submit` → `submit` gives `waiting`, no `\r`
  - mirrored status `waiting` → `send` gives `waiting`, nothing written
  - exited → `no-session`; a shell → `not-claude`; not armed → `unarmed`; screen `unknown` → `screen`; screen `text` with the draft `clean` → typed; with `dirty` → `prompt-busy`
  - keyboard `'a'` then screen `text` → `prompt-busy`; keyboard `'\r'` → `submitted`; the worker's `prompt` → `clean`; 5 s without → `unknown`
  - **no Enter without a submit:** 500 seeded random sequences of send / submit (any echo) / keyboard / prompt / PermissionRequest / timer advances: every `\r` the chat path writes is preceded by an accepted `submit` with that send's id, and each `sendId` gives at most one `\r`
  - an in-flight send with no `submit` for 3 s → cleared, no `\r`, the draft `dirty`
  - `interrupt`: idle → `not-working`; working → one `\x1b`; again within 1 s → `debounced`; waiting → `waiting`
  - **off:** a manager with `chat: { state: () => ({ on: false }) }` (no `onInput`) and with `onInput` but an unarmed terminal: `onInput` never called; `write` and `sendInstruction` write the same bytes at the same times as before this task (a recorded 1.4.0 sequence pinned inline)
  - `tests/chat-hooks.test.ts`: `onArrive` is called with the event name before the response and never with a body
  - **guard** (`tests/chat-ui.test.ts` (a), rewritten): in `electron/chat*.cjs` the only terminal call is `terminals.typeForChat(` and it appears only in `chatHost.cjs`, in `send`, `submit` and `interrupt`; `ENTER`, `ESC`, `PASTE_START` are defined only in `chatInput.cjs`; no file in `electron/chat*.cjs`, `src/chat/`, `src/components/chat/` or `ChatView.tsx` contains `terminals.write`, `terminals.send`, `sendInstruction`, `pty.write`, `'\r'`, a `'/model`, `'/config`, `'/login`, `'/logout'` or `'/permissions` literal, or `settings.json`
  
  Run: FAIL.
- [ ] **Step 2: Implement.** Run the suite and `tsc`: PASS.
- [ ] **Step 3: Commit:** `chat composer: send, submit and stop in main — typed without Enter, Enter only after the echo, one send per id`.

### Task 3.5: Images in main (`electron/chatImages.cjs`)

**Files:**
- Create: `electron/chatImages.cjs`, `tests/chat-images.test.ts`
- Modify: `electron/chatHost.cjs` (`chat:image`, `chat:image-drop`; tokens in `send`; drop on session end; sweep at start), `electron/main.cjs` (the root folder), `electron/preload.cjs`, `src/desktop.ts`

**Interfaces:**
- `sniffImage(bytes: Uint8Array): 'png' | 'jpeg' | 'gif' | 'webp' | null`: PNG `89 50 4E 47 0D 0A 1A 0A`; JPEG `FF D8 FF`; GIF `47 49 46 38 (37|39) 61`; WebP `52 49 46 46 ?? ?? ?? ?? 57 45 42 50`. Nothing else (no SVG, no BMP, no HEIC: the formats Claude Code sends to the model).
- `IMAGE_CAPS = { bytes: 10 << 20, perSession: 64, sessionBytes: 256 << 20 }`.
- `imageRoot(tmpDir, userDataDir)`: `path.join(tmpDir, 'spawn-chat-' + sha1(userDataDir).slice(0, 8))` (one folder per app instance: a dev build and the trial copy never share it).
- `createImageStore({ root, fs = require('fs').promises, randomBytes = crypto.randomBytes, log })`:
  - `save(terminalId, bytes)`: `terminalId` must be a UUID; `bytes` a `Uint8Array` ≤ `IMAGE_CAPS.bytes` (`size`), sniffed (`type`), within the session's count and bytes (`limit`). It writes `<root>/<terminalId>/<24 hex>.<ext>` (`wx`, mode 0o600) and answers `{ ok: true, token, type }`.
  - `path(terminalId, token)`: only for a token matching `/^[0-9a-f]{24}$/` that this store saved for that terminal; the absolute path, else `null`.
  - `drop(terminalId, token)`, `dropSession(terminalId)` (the folder), `sweep()` (the whole root, at start).
- Host: the image store is built only with the host. `chat:image` answers `off` when the host is off. A terminal that leaves the list or exits (`onTerminals`) → `dropSession`. The host's constructor with `sweep: true` also sweeps the image root. `send` resolves each token with `path()`; an unknown token → `images`.
- `main.cjs`: `imageRoot(app.getPath('temp'), app.getPath('userData'))` passed to the host.

- [ ] **Step 1: Failing tests** (temp dirs):
  - the magic-byte table, including a PNG signature on 9 bytes only → `png` (the type is the signature's; Claude Code decodes), `<svg`, `GIF87` with a wrong tail, an `MZ` executable and an HTML file → `null`
  - 10 MB + 1 byte → `size`; the 65th image of a session → `limit`; a non-UUID terminal id → refused
  - the name is the store's own: `save` ignores any name, and `path()` of `'../x'`, of another terminal's token or of a made-up token → `null`
  - `dropSession` removes the folder; `sweep` removes leftovers of an earlier run; the root holds the instance hash
  - source checks: `chatImages.cjs` and `chatHost.cjs` never name `clipboard`; `chatImages.cjs` writes only under `root` (every `writeFile` / `open` takes a path built by `join(root, …)`)
  
  Run: FAIL.
- [ ] **Step 2: Implement.** Run: PASS.
- [ ] **Step 3: Commit:** `chat composer: pasted images saved by main under the app's own temp folder, checked by their bytes, gone with the session`.

### Task 3.6: The lens: what Claude Code queued, the permission mode, the prompt signal

**Files:**
- Modify: `electron/chatSchema.cjs` (`quickSkip` lets `queue-operation` lines through; `queueOp(obj)`), `electron/chatLens.cjs`, `electron/chatWorker.cjs` (`{ t: 'prompt', id }`), `src/chat/types.ts`
- Test: `tests/chat-queue.test.ts` (new), `tests/chat-lens.test.ts`, `tests/chat-schema.test.ts`

**Interfaces:**
- `queueOp(obj): { op: 'enqueue' | 'remove' | 'dequeue' | 'unknown'; text: string | null }` for a `type: "queue-operation"` line: `operation` `enqueue` (verified), `remove` (verified, 2.1.325), `dequeue` (assumed); anything else `unknown`. `text` from `content` (a string, capped at 400).
- Per terminal, `queue: { text, at }[]` (≤ 10):
  - `enqueue` → push. `remove` / `dequeue` → drop the first entry with the same text, or the first entry when the text is missing.
  - A `queued_command` attachment or a user item whose text matches an entry (`liveMatches`) → drop that entry.
  - `unknown` → clear, `logOnce`, and the strip stays empty until the next `enqueue`.
  - Idle (`Stop` / turn end) for 10 s with entries left and no new prompt → clear (a queue the lens lost track of says nothing rather than something old).
  - Only lines read live or in the tail first read; older pages never touch the queue.
- `status.queued` (the first 3, text capped at 200 with `truncated`) and `status.queuedCount`. Absent when empty (Phase 2's status shape is unchanged then).
- `status.mode`: the last hook body's `permission_mode` when it is one of `PermissionMode`; a value not known → `null`.
- `createLens({ …, onPrompt })`: `UserPromptSubmit` mapped to a terminal calls `onPrompt(id)`; the worker posts `{ t: 'prompt', id }`.

- [ ] **Step 1: Failing tests:**
  - `queue.jsonl`: after the two enqueues `queuedCount` is 2; after `remove` 1; the `queued_command` and the next turn's user line → 0; the `shuffle` line → cleared and nothing until the next enqueue; 10 s idle with one left → cleared
  - `queued.jsonl` (2.1.325) gives the same end state as Phase 2 (no regression: the queued prompt is a user item where it was taken in)
  - `hooks-input.jsonl`: `mode` `default` → `acceptEdits` → `null` → `plan`
  - `onPrompt` called once per `UserPromptSubmit` with the terminal id, never for an unmapped session
  - `quickSkip` is false for a `queue-operation` line and true for the other noise lines (no parse: the Phase 2 spy)
  
  Run: FAIL.
- [ ] **Step 2: Implement.** Run, plus the lens and worker suites: PASS.
- [ ] **Step 3: Commit:** `chat lens: what Claude Code queued, the permission mode, and a prompt signal for the composer`.

### Task 3.7: The page's send logic: keys, outbox, the sequence

**Files:**
- Create: `src/chat/composerKeys.ts`, `src/chat/outbox.ts`, `src/chat/send.ts`, `tests/chat-composer-keys.test.ts`, `tests/chat-outbox.test.ts`, `tests/chat-send-page.test.ts`

**Interfaces:**
- `composerKeys.ts`:
  - `keyAction(e: { key; code; shiftKey; ctrlKey; metaKey; altKey; isComposing; keyCode }, s: { composing: boolean; working: boolean; menuOpen: boolean; lightbox: boolean }): 'send' | 'stop' | 'menu-up' | 'menu-down' | 'menu-pick' | 'menu-close' | 'lightbox-close' | null`
    - composing (`s.composing || e.isComposing || e.keyCode === 229`) → `null` for every key (Enter, Esc, Backspace, arrows belong to the IME)
    - `lightbox` and Esc → `lightbox-close`
    - `menuOpen`: ↑ / ↓ / Enter or Tab / Esc → the menu actions
    - Enter with no modifier → `send`; Shift+Enter → `null` (the textarea's own newline); Ctrl / ⌘ / Alt + Enter → `null`
    - Esc with `working` → `stop`; otherwise `null`
  - `createImeTracker()` → `{ start(), end(), blur(), composing(): boolean }` (compositionstart / compositionend / blur; blur ends it).
- `outbox.ts`:
  - `type Entry = { local: string; text: string; images: { token: string; url: string }[]; state: 'sending' | 'sent' | 'unconfirmed'; at: number; baseline: number }` (`baseline`: the largest transcript `order` the page had when it was sent).
  - `pendingItems(entries): UserItem[]`: one item per entry, `order = PENDING_BASE + n`, `pending` = the state, `images` = the count, `text`.
  - `sentMatches(sent, text)`: both with `[Image #n]` and the app's temp paths removed, whitespace collapsed, trimmed; equal, or ≥ 20 characters with one starting with the other's first 200.
  - `reconcile(entries, items, status, now): { entries; matched: { local; itemId }[] }`: a `sent` entry matching a user item whose `order > baseline` → matched and dropped; matching an entry of `status.queued` → dropped (the strip shows it; the user item matches later and carries the thumbnails); `sent` for 8 s → `unconfirmed`; `unconfirmed` entries stay until matched or dismissed.
  - Per terminal, the store keeps `thumbs: Map<itemId, string[]>` (blob URLs, ≤ 30 per terminal, revoked when dropped and on `onChatForget`).
- `send.ts`: `sendDraft({ id, text, images, bridge, readScreen, now, sleep, outbox, status }): Promise<{ ok: true; command: boolean } | { ok: false; reason; leftOnPrompt: boolean }>`, the page's half of "The send, step by step": local refusals (`waiting`, `screen`), the outbox entry, `chat.send`, the echo poll, `chat.submit`. `leftOnPrompt` is true when `chat.send` succeeded and the submit did not.

- [ ] **Step 1: Failing tests:**
  - **IME sequences** (`keyAction` + the tracker, step by step):
    - Windows Korean: `compositionstart` → keydown Enter `keyCode 229 isComposing` → `null` → `compositionend` → keydown Enter `isComposing: false` → `send` once
    - macOS Korean: keydown Enter `isComposing: true` → `null`, no second keydown → nothing sent (the next Enter sends)
    - Japanese: Enter while converting → `null`; the next Enter → `send`
    - Backspace and Esc while composing → `null` (Esc never stops while composing, even with `working`)
    - blur while composing → `composing()` false after; the text is the textarea's (nothing dropped)
    - Shift+Enter → `null` (newline); Enter with ⌘ or Ctrl → `null`
  - **outbox:** a sent entry matched by a user item after the baseline → dropped, `matched` names the item; one before the baseline is not matched; `[Image #1]` text vs a sent text with a temp path → matched; a leading space added by the literal rule → matched; a queued strip entry → dropped; 8 s → `unconfirmed`
  - **sendDraft** with a fake bridge and scripted screens: happy path (one `send`, one `submit` with `ok`); a dialog screen → `screen`, no IPC; the echo `mismatch` → `submit` with `mismatch`, `leftOnPrompt: true`; images → the poll lasts up to 1.5 s + 500 ms each; a `send` refusal → the entry removed; a command → no outbox entry, `command: true`; two calls at once → the second refused locally (`sending`) without IPC
  
  Run: FAIL.
- [ ] **Step 2: Implement.** Run, plus `tsc`: PASS.
- [ ] **Step 3: Commit:** `chat composer: the page's send sequence, the provisional bubble and IME-safe keys`.

### Task 3.8: The composer (on the QA page)

**Files:**
- Create: `src/components/chat/Composer.tsx`, `QueueStrip.tsx`, `ImageChips.tsx`, `Lightbox.tsx`, `ControlRow.tsx`
- Modify: `src/styles/chat.css` (a "composer" section), `src/locales/chat.ts`, `src/QaPage.tsx` (section 채팅 › 입력란), `src/components/chat/UserMessage.tsx` (`pending` states, thumbnails), `tests/chat-ui.test.ts` (style rules), `tests/work-mode.test.ts`

**Interfaces:**
- `Composer({ term, who, status, onTerminal, control, focusRef, deps? })`. `control: { model: string | null; context: { left: number | null; tip: string; label: string /* 'HP' or 컨텍스트, from the side panel's barLabel */ }; usage: { fiveHour?: number; weekly?: number } }`. `deps` (the bridge, `termText`, the clock) are injectable for the QA page and tests.
- **Layout** (lab `composerHtml`, `app.css` 337–371): `.chat-composer` padding `0 32px 14px` (`0 16px 12px` under 900px), inner `max-width: var(--read-w)` centred. Inside:
  - the refusal / note line (`role="status"`, `--t-ui`, `--ink-2`, with a `터미널로 보기` hairline button when it concerns the terminal)
  - `QueueStrip` (lab `.queue`: 30px, hairline, top radius `--r-l`, a grey dot, `대기 중 {n}`, the first text ellipsised in `--ink-2`; no buttons — Decision 7; `aria-live="polite"`)
  - `.chat-cbox` (`--card`, hairline, radius `--r-l`, padding `8px 8px 8px 12px`, `:focus-within` border white 16 %):
    - `ImageChips` (lab `.ichip`: 30px, a 34×22 thumbnail, the name `붙여넣은 이미지 {n}`, × `빼기`; the thumbnail opens `Lightbox`)
    - a plain `<textarea>` (not contenteditable: Decision 14), `--t-prose` / 1.6, the literal Pretendard stack, auto-height from 1 to 8 lines (max 160px, then its own scroll; measured from `scrollHeight`, no animation), placeholder `{name}에게 지시하기…` (the existing key) or in 업무 모드 `에이전트에게 지시하기…`, `aria-label` the same, `spellCheck={false}`. **Never `disabled`**: while a send runs it is `aria-busy` and Enter is ignored; an ended session makes it `readOnly` with `aria-disabled`.
    - `.chat-cbar`: `+` (`이미지 붙이기`, a hidden `<input type="file" accept="image/png,image/jpeg,image/gif,image/webp" multiple>`), `@` (Task 3.10, absent until then), and the send button (lab `.send2`: 30px, radius `--r-m`, **`--accent` / `--accent-ink`**, the only yellow; `aria-label` `보내기`, `title` `보내기 (Enter)`; dimmed, not yellow, when there is nothing to send)
  - `ControlRow` (lab `.ctrl`, display only: spans, no chevrons, no menus): the model; the permission mode (`status.mode` label, hidden when null); a grow; the context meter (`control.context.label`, a 3px bar with the side panel's `hpTone` colours, the percentage); a hairline separator; usage `5시간 {pct}%` (and `주간 {pct}%` when known). Each has a `title`: `바꾸려면 터미널에서 해요`.
- **Behaviour:**
  - The draft lives per terminal in a module `Map` (it survives a flip, a session switch and a remount; not stored on disk).
  - Enter → `sendDraft`. On `ok` the draft and chips clear. On a refusal the draft stays, except `leftOnPrompt`, which clears it and says `보낸 글은 터미널 입력란에 남아 있어요. 터미널에서 Enter를 누르거나 지워 주세요`.
  - A command → a quiet note `{command} 보냈어요. 터미널에 화면이 열렸다면 거기서 이어서 해 주세요` with 터미널로 보기, for 6 s.
  - Text starting with `/`: a hint line under the box, `/로 시작하면 Claude Code 명령으로 보내요. 글자 그대로 보내려면 앞에 띄어쓰기를 넣어요`.
  - **Paste:** image files in `clipboardData.files` (or `items` of kind `file` with an `image/*` type) → `chat.image` each (≤ 8 per message, ≤ 10 MB checked first in the page), a chip with a blob URL; the event's text part (if any) pastes as usual. A paste with no image is left to the textarea. **Drop:** the same for image files; other files → `PNG, JPEG, GIF, WebP 이미지만 붙일 수 있어요`. Removing a chip → `chat.dropImage`.
  - **Esc** with `stop` → `chat.interrupt`. 멈추기 also sits in the working line's reserved right slot (Phase 2), a hairline ink button `멈추기` with `<kbd>Esc</kbd>`, shown only while `status.state === 'working'` and there is no card.
  - Refused before IPC while the session waits on the user: `{name}{iga} 답을 기다리고 있어요. 먼저 답해 주세요`.
- **UserMessage:** `pending: 'sending'` → under the bubble `보내는 중…`; `'sent'` → nothing extra; `'unconfirmed'` → `기록에서 아직 보이지 않아요` and 터미널로 보기 (`--ink-3`, no colour). Thumbnails from `thumbs` (34×22 hairline boxes, a click opens the lightbox); otherwise Phase 2's `이미지 {n}` chip.
- **Lightbox** (lab 665–668): a full-view overlay on `rgba(6, 7, 10, 0.8)`, the image at most `min(760px, 80vw)`, the caption, `role="dialog"` with `aria-modal`, focus on its close button, Esc / click closes and gives the focus back to what opened it.
- **Strings** (ko → en / ja):
  - `에이전트에게 지시하기…` → Give the agent an instruction… / エージェントに指示する…
  - `이미지 붙이기` → Attach an image / 画像を添付
  - `붙여넣은 이미지 {n}` → Pasted image {n} / 貼り付けた画像 {n}
  - `빼기` → Remove / 外す
  - `크게 보기` → View larger / 拡大表示
  - `대기 중 {n}` → {n} queued / 待機中 {n}
  - `지금 하는 일이 끝나면 이어서 보내요` → Sent after the current work / 今の作業が終わったら続けて送ります
  - `멈추기` → Stop / 停止
  - `보내는 중…` → Sending… / 送信中…
  - `기록에서 아직 보이지 않아요` → Not in the session record yet / まだセッション記録に見当たりません
  - `터미널이 지금 입력을 받을 수 있는지 확인하지 못했어요` → Couldn't confirm the terminal can take input now / ターミナルが入力を受け付けられるか確認できませんでした
  - `터미널 입력란에 쓰던 글이 있어요. 터미널에서 보내거나 지운 뒤 다시 보내 주세요` → There's text in the terminal's input. Send or clear it there, then try again / ターミナルの入力欄に書きかけの文があります。ターミナルで送るか消してから送ってください
  - `{name}{iga} 답을 기다리고 있어요. 먼저 답해 주세요` → {name} is waiting for your answer. Answer it first / {name}が回答を待っています。先に答えてください
  - `세션이 끝나서 보낼 수 없어요` → The session has ended / セッションが終了したため送れません
  - `앞의 메시지를 보내는 중이에요` → Still sending the previous message / 前のメッセージを送信中です
  - `보낸 글은 터미널 입력란에 남아 있어요. 터미널에서 Enter를 누르거나 지워 주세요` → Your text is in the terminal's input but wasn't sent. Press Enter there, or clear it / 文はターミナルの入力欄に残っています。ターミナルで Enter を押すか消してください
  - `너무 길어요 (최대 {n}자)` → Too long (up to {n} characters) / 長すぎます(最大 {n} 文字)
  - `이미지는 한 번에 {n}장까지 보낼 수 있어요` → Up to {n} images per message / 画像は一度に {n} 枚まで
  - `PNG, JPEG, GIF, WebP 이미지만 붙일 수 있어요` → Only PNG, JPEG, GIF or WebP images / PNG・JPEG・GIF・WebP の画像のみ
  - `이미지가 너무 커요 (최대 {n}MB)` → Image too large (up to {n} MB) / 画像が大きすぎます(最大 {n}MB)
  - `이 세션에 붙인 이미지가 너무 많아요. 새 세션에서 붙여 주세요` → Too many images in this session. Use a new session / このセッションの画像が多すぎます。新しいセッションで添付してください
  - `{command} 보냈어요. 터미널에 화면이 열렸다면 거기서 이어서 해 주세요` → Sent {command}. If it opened something in the terminal, continue there / {command} を送りました。ターミナルに画面が開いたらそちらで続けてください
  - `/로 시작하면 Claude Code 명령으로 보내요. 글자 그대로 보내려면 앞에 띄어쓰기를 넣어요` → Text starting with / goes as a Claude Code command. To send it as text, start with a space / / で始めると Claude Code のコマンドとして送ります。文字どおり送るには先頭に空白を入れます
  - `멈출 작업이 없어요` → Nothing to stop / 停止する作業がありません
  - `매번 확인` → Ask each time / 毎回確認 · `편집 자동 허용` → Auto-accept edits / 編集を自動許可 · `계획 모드` → Plan mode / 計画モード · `자동 모드` → Auto mode / 自動モード · `확인 없이 실행` → Bypass permissions / 確認なしで実行 · `묻지 않음` → Don't ask / 確認しない
  - `바꾸려면 터미널에서 해요` → Change it in the terminal / 変更はターミナルで
  - `5시간 {pct}%` / `주간 {pct}%`: reuse the side panel's keys if they exist, else add → 5h {pct}% / 5時間 {pct}% · Week {pct}% / 週間 {pct}%

- [ ] **Step 1: Failing tests:**
  - `tests/chat-ui.test.ts`: `chat.css` uses `--accent` only in the `.chat-send` rules; no `animation` or `transition` other than `color` / `background-color` / `border-color`; every `font-size` a `var(--t-…)`; the composer's `font-family` literal; no `<textarea` in `src/components/chat/` with a `disabled` prop; no `localStorage` in the new files; every new key has en and ja
  - `tests/work-mode.test.ts`: the new strings do not match `GAME_WORDS`; the work-mode placeholder key exists
  
  Run: FAIL.
- [ ] **Step 2: Implement** the components and styles. The QA page section shows, with fixed props and no bridge: an empty composer; a two-line draft with two image chips; a queue strip of 2; each refusal note; working (멈추기 in the line); an `unconfirmed` bubble; 업무 모드. Run the suite, `tsc` and build: PASS.
- [ ] **Step 3: Visual steps** for `qa` (the 입력란 section) against `s2-chat-detail.png` and `app.css` 337–371. Checklist: the box sits on `--card` with a hairline; the send button is the only yellow; chips are hairline; the queue strip is attached above the box; the control row is quiet grey; 멈추기 is ink; nothing moves.
- [ ] **Step 4: Commit:** `chat composer: the input box, image chips and lightbox, the queue strip, the quiet control row`.

### Task 3.9: The composer in the chat view; focus; the side panel's box

**Files:**
- Modify: `src/Widget.tsx`, `src/components/ChatView.tsx`, `src/components/chat/ChatList.tsx` (the list no longer takes the focus when a composer is there), `src/styles/widget-expanded.css`, `src/locales/chat.ts`
- Test: `tests/chat-lens-mode.test.ts`, harness flows in Task 3.11

**Interfaces and behaviour:**
- `Widget.tsx` passes `footer={<Composer … control={…} focusRef={composerRef} />}` to the `ChatView` it already renders in chat mode. `control` comes from `useMeters()` for the shown session (`modelLabel`, the context numbers and the `barLabel` the session row uses, the 5-hour / weekly limits).
- **Focus:** `ChatView`'s focus effect takes `takeChatFocus()` (the user's own flip or session switch, Phase 2) and focuses the composer's textarea when there is one, else the list as before. `isTypingTarget(document.activeElement)` still wins: nothing is taken from an input. A first row arriving, a reset or a new card never moves the focus.
- **The side panel's box while the chat is shown** (window or full screen, `view === 'terminal'`, the shown session in `chat`): the `w-compose` section keeps its exact size and place. Its `.w-input` shows, instead of the textarea and the send button, one quiet line `채팅 아래 입력란에서 보내요` and a hairline button `입력란으로` that focuses the composer. The box's own unsent text (`text`) is kept, untouched, and is there again on the flip to 터미널. The `note` line stays. In every other case (terminal shown, widget mode, the feature off) the section's markup is byte-for-byte as before.
- The empty state's hint becomes `아래 입력란에 지시를 적어 보내요. 대화가 여기에 보여요` (the old key goes from the chat locale).
- No new keyboard shortcut.
- Strings: `채팅 아래 입력란에서 보내요` → Send from the box under the chat / チャットの下の入力欄から送ります · `입력란으로` → To the input box / 入力欄へ · `아래 입력란에 지시를 적어 보내요. 대화가 여기에 보여요` → Write your instruction in the box below. The conversation shows here / 下の入力欄に指示を書いて送ってください。会話はここに表示されます

- [ ] **Step 1: Failing tests:** a source check that `Widget.tsx` renders the pointer only under `lensMode === 'chat' && view === 'terminal'`; that the `w-compose` section's terminal-mode JSX is unchanged (compare the block's text with the one before this task, captured in this step); that `ChatView` focuses the composer through `takeChatFocus` and `isTypingTarget`. Run: FAIL.
- [ ] **Step 2: Implement.** Run the suite, `tsc`, build: PASS.
- [ ] **Step 3: Visual steps** for `chat`, `chat-empty`, `chat-work` at 1440×900 and 1100×720 with `--check fit` against `s2-chat-detail.png`; `session` (terminal mode) must equal the Phase 2 shot pixel for pixel.
- [ ] **Step 4: Commit:** `chat composer: under the conversation, owning the focus; the side panel's box points to it while the chat is shown`.

### Task 3.10: `@` file mention inside the session's folder (cuttable)

The names come only from the session's own folder, read by main. If this task slips, it is cut: the `@` button is absent and Decision 6 says the mention is deferred. Typing `@path` by hand still works (Claude Code resolves it, FINDINGS §7).

**Files:**
- Create: `electron/chatFiles.cjs`, `src/components/chat/MentionMenu.tsx`, `tests/chat-files.test.ts`
- Modify: `electron/chatHost.cjs` (`chat:files`), `electron/preload.cjs`, `src/desktop.ts`, `src/components/chat/Composer.tsx`, `src/chat/composerKeys.ts` (menu keys already there), `src/locales/chat.ts`

**Interfaces:**
- `listFiles(cwd, query, { fs, now, budgetMs = 400, maxScan = 20_000, max = 50 })`: `realpath(cwd)` is the root. An async walk with `opendir`. Directories `.git`, `node_modules`, `.next`, `dist`, `build`, `out`, `target`, `.venv`, `venv`, `__pycache__`, `.cache` and every other dot-directory are skipped. **Symbolic links and junctions are never followed** (`Dirent.isSymbolicLink()`, and `lstat` on Windows for junctions). Each directory's real path must stay under the root. Names only: no file is opened. The match is fuzzy (the query's characters in order, case-insensitive), ranked by a basename hit, then by path length. The result is relative paths with forward slashes, without whitespace (a path with a space is left out: how Claude Code reads `@` with a space is not verified). The scan is cached per terminal for 30 s.
- Host: `chat:files` only for an armed terminal; its `cwd` from the terminal manager, never from the page.
- Composer: `@` typed at the start or after whitespace, not composing → `MentionMenu` (lab `.menu` `data-menu="mention"`, 300px, ≤ 8 rows, `role="listbox"`); ↑ / ↓, Enter or Tab picks (inserts `@path `), Esc closes it only. The `@` button opens it too.
- Strings: `파일` → Files / ファイル · `파일 멘션` → Mention a file / ファイルを指定 · `맞는 파일이 없어요` → No matching files / 一致するファイルがありません

- [ ] **Step 1: Failing tests** (a temp tree): containment (a symlink or junction to a folder outside is not listed; skip with a note where the platform cannot make one); skipped directories; 30 000 files stop at `maxScan` within the budget; ranking; no `readFile` / `open(` in `chatFiles.cjs` (source check). Run: FAIL.
- [ ] **Step 2: Implement.** Run: PASS.
- [ ] **Step 3: Commit:** `chat composer: @ mentions from the session's own folder (names only, no links followed)`.

### Task 3.11: Harness: composer surfaces and flows

**Files:**
- Modify: `tests/visual/fake-bridge.js` (`chat.send`, `submit`, `interrupt`, `image`, `dropImage`, `files`: recorded in `window.__CALLS__`, answers scripted by `window.__CHAT_SCRIPT__`; the fake screen writer `window.__SCREEN__(termId, name)`), `tests/visual/chatFixture.mjs`, `tests/visual/shots.mjs`, `tests/visual/README.md`

**Surfaces:** `chat-compose` (a two-line draft, two chips, a queue strip of 1, the control row), `chat-compose-fail` (the `prompt-busy` note), `chat-compose-pending` (a `sending` and an `unconfirmed` bubble), added to `WORK` and `MAC`; `--text small|xlarge` and `--lang en|ja` for each.

**Flows** (each exits non-zero on failure):
- `chat-send`: screen `idle-empty`; type `hello`, Enter → exactly one `chat.send` with `screen: 'empty'`; the flow writes `echo-plain` → exactly one `chat.submit` with `echo: 'ok'`; a `sending` bubble, then `sent`; pushing the transcript's user item leaves one user row.
- `chat-send-ime`: synthetic `compositionstart` / `input` (`안녕`) / keydown Enter with `isComposing: true` (and, where CDP has it, `Input.imeSetComposition`) → no call; `compositionend` then keydown Enter → one `chat.send` with `안녕`; Backspace during composition → no call; blur during composition → the draft kept; Esc during composition with status `working` → no `chat.interrupt`.
- `chat-send-multiline`: Shift+Enter twice → one `chat.send` whose text has two `\n`.
- `chat-send-double`: a double click on send and two Enters within 30 ms → one `chat.send`.
- `chat-send-refuse`: screen `dialog-bash` → Enter gives no `chat.send`, the note and 터미널로 보기 (which flips); the scripted `prompt-busy` → its note, the draft kept; status `waiting` → the local note, no call; the scripted echo never coming → `chat.submit` with `timeout`, the "남아 있어요" note, the draft cleared.
- `chat-queue`: a status with `queued` of 2 → `대기 중 2` and the first text; then none → the strip gone; no button in the strip.
- `chat-stop`: status `working` → 멈추기 in the working line; a click → one `chat.interrupt`; Esc in the composer (not composing) → one more; status `waiting` → no 멈추기.
- `chat-image`: a paste event with a 16×16 PNG `File` → one `chat.image` with its bytes, a chip; a click → the lightbox; Esc closes it and the focus is back on the chip; × → `chat.dropImage`; a drop of a `.txt` file → the type note and no call; a paste of text only → no `chat.image`.
- `chat-side-box`: in chat mode the side box shows the pointer and its height equals the terminal mode's (0px difference); text typed into the side box in terminal mode is still there after chat → terminal; `입력란으로` focuses the composer.
- `chat-compose-focus`: the flip to 채팅 puts the focus in the composer; with the side box focused (terminal mode of another session) and a reset pushed, the focus stays; a new card pushed (Phase 4 later) never moves it.
- `chat-compose-grow`: at the bottom, a draft growing from 1 to 6 lines keeps the list at the bottom (gap ≤ 2px) and the textarea scrolls past 8 lines.
- `chat-off`, extended: no `.chat-composer`, no pointer, and the side box as in the Phase 2 shot.
- `keyboard` and `hit-areas`, extended: Tab order list → queue strip → chips → textarea → `+` → send → control row; every composer control ≥ 22px.

- [ ] **Step 1: Write the flows** against the fake bridge. Run them: they pass on the work of Tasks 3.8–3.10, or fail with a named defect that is fixed in this task.
- [ ] **Step 2: Visual steps** for the new surfaces in `--check fit --check work`, both sizes, both languages.
- [ ] **Step 3: Commit:** `test(harness): the composer — send, IME, refusals, queue, stop, images, the side box, focus`.

### Task 3.12: Sweep and hand-off for Phase 3

- [ ] **Step 1: Run everything:** the suite, `tsc`, build; `node tests/visual/shots.mjs --out "~/Documents/spawn-portfolio/_inbox/chat-3/12-final/" --only chat,chat-compose,chat-compose-fail,chat-compose-pending,chat-empty,chat-work,chat-mac,session,settings --check fit --check work --flow chat-send --flow chat-send-ime --flow chat-send-multiline --flow chat-send-double --flow chat-send-refuse --flow chat-queue --flow chat-stop --flow chat-image --flow chat-side-box --flow chat-compose-focus --flow chat-compose-grow --flow chat-off --flow chat-flip --flow keyboard --flow hit-areas`, then `--text small`, `--text xlarge`, `--lang en`, `--lang ja` for the composer surfaces. Read every shot; `NOTES.txt` beside them.
- [ ] **Step 2: Untouched files:** `git diff --exit-code 5d1a2bf -- src/components/TerminalPanel.tsx src/keys.ts src/termFont.ts src/textSize.ts server hooks scripts electron/updater.cjs electron/updateRunner.cjs package.json package-lock.json` prints nothing (or the last merged main commit as the base).
- [ ] **Step 3:** `CHANGELOG.md` "Unreleased" (ko / en / ja in the file's style): the composer in the chat preview. `docs/HANDOFF.md`: a new entry for Phase 3 in the style of 7-47 — what it is, how a send works (two steps, the echo), the known limits (no `/` menu, the queue display only, no thumbnails for older messages), what only a real build can show (the trial list of Task 3.13 and the owner's own checks: a real Korean IME in the composer, a Mac, a slow PC).
- [ ] **Step 4: Insight log** (`insight-log` skill): one entry — "typed, then Enter only after the echo": why a chat over a real TUI cannot just write text and `\r` (a dialog can appear between them; a greyed suggestion looks like typed text), with the `chat-send-refuse` and `chat-compose` shots.
- [ ] **Step 5: Commit:** `chat composer: sweep, changelog and hand-off for Phase 3`.

### Task 3.13: Real-session trial (Phase 3)

**Only with the controller's go-ahead.** Set up as the 7-47 trial: a copy of the app in the scratchpad (electron, hooks, server, dist; `node_modules` linked; `server/cloud-config.json` left out), its own `SPAWN_HOME`, userData and `SPAWN_REGISTRY_DIR`, server port 3393, the window off screen with `showInactive`, driven over CDP 9341 and the main inspector 9342. A throwaway git folder with three files. Before and after: the SHA-256 of `~/.claude/settings.json` (must be equal) and a listing of the throwaway project's `.claude/` (must not gain a settings file). The owner's running app, `~/.spawn` and `%APPDATA%\spawn` are never touched. The test transcripts are removed at the end.

Checklist (each with its evidence: a cropped shot, the transcript line's shape, a log line):
- [ ] A one-line prompt from the composer: one user line in the transcript, the provisional bubble replaced, `spawn.log` with no `refused`.
- [ ] A three-line prompt: **one** user line holding the three lines (never three prompts).
- [ ] A 60-line paste: the terminal shows `[Pasted text #1 …]`; the echo is accepted; the transcript's user text is the whole text (or note what it holds and fix the matcher).
- [ ] `!echo hi`, `#note`, `@README.md what is this`: sent with a leading space. No bash mode, no memory write (the project's `CLAUDE.md` unchanged), the mention still attached.
- [ ] `/compact` from the composer: "정리하는 중", the command notice, no bubble. `/clear`: the view moves to the new conversation.
- [ ] After a turn with a greyed suggestion on the prompt row: a send works, and the transcript holds only the sent text.
- [ ] Text typed in the terminal without Enter, then the flip to 채팅: the send is refused with `prompt-busy`; after clearing it in the terminal, it works.
- [ ] A permission dialog open: the composer refuses (`waiting` or `screen`) and nothing is typed into the dialog.
- [ ] A prompt sent while Claude works: `대기 중 1`, then the user line where Claude Code took it in.
- [ ] 멈추기 during a long answer: interrupted (the partial text, 요청을 멈췄어요); a second click within a second does nothing.
- [ ] An image pasted into the composer (a generated PNG through a synthetic paste event): `[Image #1]` in the terminal, `images: 1` on the user item, the file under the instance's temp folder; closing the session removes the folder; the next start removes leftovers. One more with the temp root set to a folder with a space (the trial copy's `TMP`).
- [ ] The side box shows the pointer while the chat is shown, and sends as before in 터미널 mode.
- [ ] Turning the setting off mid-session: the composer goes with the chat; the side box is the 1.4.0 box.
- [ ] Timing on a slow machine: at least one send with CPU load (the echo is still accepted; otherwise note the timings).

- [ ] **Fixes:** each finding gets a redacted fixture and a failing test first, then the fix, as separate commits (as 95c7adf did). `docs/HANDOFF.md` gets what the trial showed. Commit: `chat composer: what the first real session showed (<Claude Code version>)`.

---

# Phase 4: the answer buttons

### Task 4.1: Fixtures for answers

**Files:**
- Create in `tests/fixtures/chat/`:
  - `hooks-permission.jsonl`: `PreToolUse(Bash)` → `PermissionRequest(Bash)` with `permission_suggestions: [{ type: "addRules", rules: [{ toolName: "Bash", ruleContent: "node -e \"console.log(6*7)\"" }], behavior: "allow", destination: "localSettings" }]` (the r2 shape) → `PostToolUse(Bash)`; `PermissionRequest(Edit)` with `[{ type: "setMode", mode: "acceptEdits", destination: "session" }]` and `old_string` / `new_string`; a sub-agent's `PermissionRequest(PowerShell)` with `agent_id` / `agent_type`; `PermissionRequest(ExitPlanMode)` with `plan` and `planFilePath` (`C:\Users\user\.claude\plans\demo-plan.md`); two identical `PermissionRequest(Bash)` (the same call key); a `PermissionRequest(AskUserQuestion)` (not seen in the spike: made to test the pass)
  - `hooks-question.jsonl`: `PreToolUse(AskUserQuestion)` with one question, two options, `multiSelect: false` (the r4 shape); one with `multiSelect: true`; one with two questions; `PostToolUse(AskUserQuestion)`
  - `rejected.jsonl`: a tool_use, its tool_result `is_error` with `toolUseResult: "User rejected tool use"`, then `[Request interrupted by user for tool use]`
  - `answers/allow.json`, `answers/always.json` (the session rule with the suggestion's rule, `destination: "session"`), `answers/deny.json`, `answers/question.json` (the r4 shape: `permissionDecision: "allow"`, `updatedInput: { questions, answers: { <question>: <label> } }`)
- Modify: `tests/chat-fixtures.test.ts` (the new files listed; `.json` files are scanned too).

- [ ] **Step 1:** Failing fixture test, then the fixtures. Run: PASS.
- [ ] **Step 2: Commit:** `test: redacted permission, question and answer fixtures for the chat's buttons`.

### Task 4.2: The hold registry and the answer bodies (`electron/chatHolds.cjs`)

**Files:**
- Create: `electron/chatHolds.cjs`, `tests/chat-holds.test.ts`

**Interfaces:**
- `HOLD = { permissionMs: 300_000, questionMs: 300_000, bindMs: 2_000, max: 16, entryMarginS: 30 }`.
- `createHolds({ timers, now, log, limits = HOLD, onChange })` returns:
  - `open(kind: 'permission' | 'question', respond: (body: string | null) => void): string | null`. It answers `null` when closed or at `max` (the endpoint then answers at once, as in Phase 2). The hold id is 12 random bytes in hex. The bind timer starts.
  - `bind(holdId, { id, key, data }): boolean` (from the worker). `data` is `{ rules: Rule[] }` for a permission or `{ questions: unknown[]; labels: string[] }` for a question. The hold timer replaces the bind timer.
  - `pass(holdId, why)`, `release(holdId, why)`, `releaseWhere(pred, why)`, `releaseAll(why)` → `respond(null)` once.
  - `gone(holdId)`: the client closed; no response.
  - `answer(holdId, { id, choice, option, visibleId, windowVisible }): { ok: true } | { ok: false, reason }`. It is accepted only when the hold is `open`, `h.id === id` (`other-session`), `visibleId === id && windowVisible` (`hidden`), the choice fits the kind (`invalid`), and, for `always`, the rules are non-empty (`not-answerable`). Then `respond(body)` once.
  - `get(holdId)`, `openFor(id)`, `close()` (`releaseAll('quit')`, refusing new holds).
  - `onChange({ holdId, id, state, why, choice })` on every transition.
- **The bodies**, built only here (pure, exported for tests):
  - `permissionBody('allow')` → `{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}`.
  - `permissionBody('always', rules)` → the same plus `"updatedPermissions":[{"type":"addRules","rules":<rules>,"behavior":"allow","destination":"session"}]`. `destination` is the literal `"session"`, whatever the suggestion said (`localSettings` in the spike).
  - `permissionBody('deny')` → `{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"deny","message":"The user denied this request."}}}` (`DENY_DECISION`, one constant; untested in the spike, so the trial checks it, Decision 18).
  - `questionBody(questions, label)` → `{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow","updatedInput":{"questions":<questions as received>,"answers":{"<question text>":"<label>"}}}}`.
  - `Rule = { toolName: string; ruleContent?: string }`, at most 4, each string ≤ 2000.

- [ ] **Step 1: Failing tests** (fake timers):
  - open → bind → `answer('allow')` → `respond` called once with the body equal to `answers/allow.json`; a later release does nothing
  - `always` equals `answers/always.json`, `destination` `session` even from a `localSettings` suggestion; `deny` equals `answers/deny.json`; the question body equals `answers/question.json`
  - 300 s with no answer → `respond(null)` once, `onChange` `released` / `timeout`; `answer` after it → `gone`
  - unbound for 2 s → released `unbound`; `pass` → released at once
  - `answer` with `visibleId` another terminal, or `windowVisible` false → `hidden` and no response; a hold of terminal A answered for B → `other-session`; `always` with no rules → `not-answerable`; an option out of range → `invalid`
  - the 17th open → `null`; `close()` releases every open hold once and the next `open` → `null`; `gone` → no response and the hold removed
  - **exactly once:** 2 000 seeded random sequences of open / bind / pass / answer (any choice, any visibility) / release / releaseAll / gone / timer advances. Every `respond` is called at most once. A non-null body is only ever sent through an accepted `answer`. Every hold ends in a final state when its timers have run.
  - source check: no `localSettings`, `userSettings`, `projectSettings` or `settings.json` in `chatHolds.cjs`; `updatedPermissions` appears once
  
  Run: FAIL.
- [ ] **Step 2: Implement.** Run: PASS.
- [ ] **Step 3: Commit:** `chat buttons: a hold registry that answers each request once — or hands it back to the terminal`.

### Task 4.3: The endpoint holds; the entries (`electron/chatHooks.cjs`, `electron/terminals.cjs`)

**Files:**
- Modify: `electron/chatHooks.cjs`, `electron/terminals.cjs` (`sessionSettingsJson`: a chat value may be an array of groups), `tests/chat-hooks.test.ts`, `tests/terminals.test.ts`

**Interfaces:**
- `HOLD_ROUTES = { PermissionRequest: 'permission', AskUserQuestion: 'question' }`. `AskUserQuestion` is a route name, not a Claude Code event: its body is a `PreToolUse` body, and `onHook` gets the event `PreToolUse`. The path check accepts `CHAT_HOOK_EVENTS` plus `AskUserQuestion`.
- `createChatEndpoint({ onHook, holds = null, requestTimeoutMs = 15_000, … })`: for a hold route with `holds` and not draining, once the body is read: `holdId = holds.open(kind, respond)`. A null id → answer at once (Phase 2). Otherwise no answer now; `onHook(event, raw, at, holdId)` in a `setImmediate` (the body unparsed, as now); `res.on('close')` before the response → `holds.gone(holdId)`. `respond(body)` writes `200` with `content-type: application/json` and the body, or `content-length: 0`. Every other request is answered first, exactly as in Phase 2.
- `chatHookEntries({ port, token, holds = false })`: with `holds` false, Phase 2's entries exactly (pinned). With `holds` true:
  - `PermissionRequest` → `{ hooks: [{ type: 'http', url: …/PermissionRequest, timeout: 330 }] }`
  - `PreToolUse` → `[{ hooks: [{ type: 'http', url: …/PreToolUse, timeout: 5 }] }, { matcher: 'AskUserQuestion', hooks: [{ type: 'http', url: …/AskUserQuestion, timeout: 330 }] }]`
  - The timeouts are `ceil(HOLD.*Ms / 1000) + HOLD.entryMarginS` (from `chatHolds.cjs`, never typed twice). The other events are as in Phase 2.
- `sessionSettingsJson(repoRoot, runtime, chat)`: `hooks[e] = [...(hooks[e] ?? []), ...[].concat(chat[e])]`. With `chat` null the text is 1.4.0's (the existing pin).

- [ ] **Step 1: Failing tests:**
  - real socket: a held `PermissionRequest` gets no response until `answer` → the client gets the JSON; `release` → an empty 200; the client aborting → `holds.gone` once; draining → an immediate 200 and no `open`; `holds` at its cap → an immediate 200; the `AskUserQuestion` route → `onHook('PreToolUse', …, holdId)`
  - a held response still arrives after `requestTimeoutMs` (set to 300 ms, held 800 ms): Node's request timeout does not cut a request whose body was read
  - Phase 2's answer-first test still passes for `PreToolUse` and `MessageDisplay` with a stalled consumer and a hold open
  - entries: with holds, the keys are only `matcher` / `hooks` and `type` / `url` / `timeout`; the timeouts are 330 and 5; with holds false, byte-equal to the Phase 2 output (pinned inline); `sessionSettingsJson` with an array round-trips; `null` → the 1.4.0 bytes
  
  Run: FAIL.
- [ ] **Step 2: Implement.** Run: PASS.
- [ ] **Step 3: Commit:** `chat buttons: the endpoint holds PermissionRequest and an AskUserQuestion route; their entries outlast the holds`.

### Task 4.4: The lens binds, passes and settles holds; cards in the status

**Files:**
- Modify: `electron/chatLens.cjs`, `electron/chatWorker.cjs`, `electron/chatItems.cjs` (`sessionRules`, `permissionDiff`), `src/chat/types.ts`
- Create: `tests/chat-asks.test.ts`

**Interfaces:**
- `lens.hook(event, body, at, holdId?)`:
  - **`PermissionRequest` with a hold:** the session is mapped to a terminal; none → `pass('unmapped')`. `ExitPlanMode` → `pass('plan')` and a `plan` card (`holdId: null`, `state: 'terminal'`). `AskUserQuestion` → `pass('question')` (the question goes through `PreToolUse`). Otherwise → `bind` with `key = callKey(tool_name, tool_input)` and `data.rules = sessionRules(permission_suggestions)`, and a `permission` card: the paired row (Phase 2's `calls` map) or null, `agent: typeof agent_id === 'string'`, `input = toolInput(…)`, `diff = permissionDiff(tool, input)`, `always = rules.length ? { rule: ruleLabel(rules) } : null`, `state: 'open'`.
  - **`PreToolUse` with a hold** (the `AskUserQuestion` route): exactly one question, `multiSelect !== true`, 2–6 options with string labels ≤ 200, a question ≤ 1000 characters, the `questions` JSON ≤ 64 KB → `bind` with `{ questions, labels }` and a `question` card. Anything else → `pass('shape')` and a read-only `question` card.
  - Phase 2's `waiting` marks are kept as they are.
- `sessionRules(suggestions)`: only `type === 'addRules'` entries with an array `rules` of `{ toolName: string, ruleContent?: string }`; deduplicated; at most 4; anything else (`setMode`, `addDirectories`, an unknown type) is not used (Decision 17).
- `permissionDiff(tool, input)`: `Edit` → a line diff of `old_string` → `new_string` (a small LCS, at most 400 × 400 lines, else null) as a `DiffBlock` capped at 40 lines; `Write` → a `create` block of the first 40 lines; anything else → none.
- **Evidence** → `{ t: 'hold-resolved', holdIds, why }` for every open card whose key matches (all of them when two share a key):
  - `PostToolUse` / `PostToolUseFailure` with the same call key, or for the paired row's id
  - the transcript's `tool_result` for the paired row
  - an `interrupted` notice
  - `Stop` / `StopFailure`
  - a new turn's `UserPromptSubmit` (not mid-turn)
  - the conversation switching
  - the terminal leaving the list
  
  The card is removed when its call settles; its row shows the outcome as in Phase 2.
- `{ t: 'hold-state' }` from main → the card's `state` (`sent` with `sent: choice`; `timeout`; `terminal` for every other release and for `gone`).
- `status.asks` lists the cards, oldest first.

- [ ] **Step 1: Failing tests** (replays):
  - the Bash request binds with the rule and `always` set; the Edit request binds with no rules (`always: null`) and a diff; the sub-agent's has `agent: true`; `ExitPlanMode` passes with a plan card; `AskUserQuestion` as a `PermissionRequest` passes; an unmapped session passes
  - the single-select question binds with its labels; multi-select and two questions pass with read-only cards
  - `PostToolUse(Bash)` → `hold-resolved` for that hold; the two same-key requests are both resolved by one `PostToolUse`; `rejected.jsonl` → resolved and the row `rejected`; `Stop` resolves everything open
  - `hold-state` `sent` / `timeout` / `terminal` change only the card's `state`
  - no card or answer data carries `localSettings` (the rules are passed on as rules only)
  
  Run: FAIL.
- [ ] **Step 2: Implement.** Run, plus the lens and worker suites: PASS.
- [ ] **Step 3: Commit:** `chat lens: permission and question cards, bound to their held request, settled by what Claude Code did`.

### Task 4.5: The host: holds, the worker, the page, visibility

**Files:**
- Modify: `electron/chatHost.cjs`, `electron/main.cjs` (the window's visibility, inside `if (chatHost)`), `electron/preload.cjs` (`chat.visible`, `chat.answer`), `src/desktop.ts`, `tests/chat-host.test.ts`

**Interfaces:**
- `apply(version)`: the holds are made only when `versionVerdict(version) === 'ok'`. The endpoint gets `holds` and the entries get `holds: true` only then; a `new` version gets Phase 2's passive entries and no holds (Decision 20).
- The worker's `hold-bind` → `holds.bind`. Then, for a `question`, when `visibleId !== id` or the window is not visible → `release('hidden')` at once (the terminal shows the question with only the bind's milliseconds of delay). `hold-pass` → `holds.pass`. `hold-resolved` → `holds.release(…, 'settled')`. `holds.onChange` → `hold-state` to the worker.
- `chat:visible { id }` from the page and `setWindowVisible(bool)` from main (`show` / `hide` / `minimize` / `restore` of the app window) → `releaseWhere(h => h.kind === 'question' && (h.id !== visibleId || !windowVisible), 'hidden')`. Permission holds are kept (the terminal shows its dialog anyway).
- `chat:answer { id, holdId, choice, option }` → `holds.answer(…, { visibleId, windowVisible })`. On `ok` → `terminals.clearAsking(id)` (the side panel's "확인 필요" goes, as when the terminal is answered with Enter).
- `onInput(id, …, 'keyboard')` → `releaseWhere(h => h.id === id, 'terminal')` (the user is answering in the terminal or the side panel's quick buttons: the chat steps back at once).
- `disable()` → `releaseAll('off')` before draining; the worker's exit → `releaseAll('worker')`; `close()` → `releaseAll('quit')` before the endpoint closes; a re-probe that leaves `ok` → `releaseAll('version')` and passive entries for new sessions.
- Composer interplay: `send` refuses with `waiting` while `holds.openFor(id)` is non-empty.

- [ ] **Step 1: Failing tests** (a fake worker, a fake endpoint around a real `createHolds`, fake timers):
  - a question bound while its chat is visible stays open; `chat:visible(null)` → released `hidden`; bound while not visible → released at once
  - minimise → questions released, permissions kept
  - keyboard input to that terminal → its holds released `terminal`; to another terminal → kept
  - `chat:answer` for a terminal that is not the visible one → `hidden`, no response; accepted → `clearAsking` called once
  - `disable`, worker exit, `close`: every open hold answered once with an empty body, before the endpoint closes
  - version `2.3.0` (`new`) → no holds, and the entries have no `matcher` and a 5 s `PermissionRequest`
  - `send` while a hold is open → `waiting`
  - source check: `main.cjs` calls `setWindowVisible` only inside `if (chatHost)`
  
  Run: FAIL.
- [ ] **Step 2: Implement.** Run the suite and `tsc`: PASS.
- [ ] **Step 3: Commit:** `chat buttons: holds wired to the reader and the page — answered only for the chat in view, released on everything else`.

### Task 4.6: The answer surface

**Files:**
- Create: `src/components/chat/AnswerSurface.tsx`, `PermissionCard.tsx`, `QuestionCard.tsx`, `PlanCard.tsx`, `tests/chat-answer-ui.test.ts`
- Modify: `src/components/ChatView.tsx` (the surface between the list and the footer; Phase 2's amber pill not shown while a card is), `src/chat/composerKeys.ts` (+ `cardKey`), `src/styles/chat.css`, `src/locales/chat.ts`, `src/QaPage.tsx` (section 채팅 › 답하기)

**Interfaces and behaviour:**
- `cardKey(e, card: { kind; choices: ('allow' | 'always' | 'deny')[]; options: number }): { choice; option? } | 'next' | 'prev' | null`. It is used **only** by the card's own `onKeyDown`, so it acts only while the focus is inside the card. Digits `1`–`3` map to 허용 / 항상 허용 / 거부 (`2` absent when there is no 항상 허용), `1`–`n` to a question's options; ← / → / ↑ / ↓ move between the buttons; composing → `null`.
- **`AnswerSurface({ asks, who, onAnswer, onTerminal })`**: outside the virtual list, above the composer, inside the reading column. It shows the oldest card; `{n}건 더 기다려요` when there are more. A visually hidden `aria-live="assertive"` line announces each new card once (`{name}{iga} 허락을 기다려요: {what}`). It never moves the focus. When a card is open, the composer's note says `먼저 답해 주세요` on Enter (Task 3.8).
- **Card** (lab `.card.ask`, `app.css` 296–309): a hairline card on `--card`, the amber 38 % border and the 2px amber left bar; `role="group"`, `aria-label` = its title, `tabIndex={0}` on the container (not on a button). The head: an amber dot, the title, the kind on the right (`권한 요청` / `질문` / `계획`).
  - **Permission:** the title by tool —
    - Bash / PowerShell `이 명령을 실행해도 될까요?` with `$ command` in mono and the description
    - Edit `이 파일을 고쳐도 될까요?` with the file chip and the `DiffBlock`
    - Write `새 파일을 만들어도 될까요?`
    - WebFetch `이 페이지를 읽어도 될까요?` with the URL
    - anything else `{tool} 도구를 써도 될까요?` with the input summary
    
    A sub-agent's request adds `보조 에이전트의 요청이에요`. The buttons are `허용 <kbd>1</kbd>` (`.btn.solid`), `항상 허용 <kbd>2</kbd>` (only with a rule; its `title` is `이 세션 동안 같은 요청은 묻지 않아요: {rule}`), `거부 <kbd>3</kbd>`, and the quiet hint `거부하면 {name}{iga} 다른 방법을 찾을 수 있어요`. A quiet `터미널에서 보기` is at the right.
  - **Question:** `header` as the kind's detail, the question, the options as `.btn`s with their descriptions under them (`1`…`n`), and `터미널에서 답하기`.
  - **Plan:** `계획을 확인해 주세요`, the plan's first 6 lines through `<Markdown>` with `더 보기` (in place, max-height 320px with its own scroll), and `터미널에서 답하기` (`.btn.solid`). There is no answer button (Decision on plan approval).
  - **States:**
    - `open`: the buttons
    - after a click, until the status says otherwise: the buttons disabled with `보내는 중…`
    - `sent`: `허용을 보냈어요 · 확인 중` / `항상 허용을 보냈어요 · 확인 중` / `거부를 보냈어요 · 확인 중` / `답을 보냈어요 · 확인 중`, with no buttons
    - `timeout`: `답할 시간이 지나 터미널로 넘겼어요` + `터미널에서 답하기`
    - `terminal` (or `holdId` null): `터미널에서 답해 주세요` + `터미널에서 답하기`
    - a refused `chat:answer`: `보내지 못했어요 · 터미널에서 답해 주세요`
- `ChatView`: `bridge.chat.visible(id)` on mount when it is the shown view and the document is visible, and `visible(null)` on unmount and on `visibilitychange` to hidden (`Widget` unmounts the view on the flip, a session switch, another view or the widget mode).
- **Strings** (ko → en / ja):
  - `이 명령을 실행해도 될까요?` → Allow this command? / このコマンドを実行してもいいですか?
  - `이 파일을 고쳐도 될까요?` → Allow this edit? / このファイルを編集してもいいですか?
  - `새 파일을 만들어도 될까요?` → Allow creating this file? / 新しいファイルを作成してもいいですか?
  - `이 페이지를 읽어도 될까요?` → Allow reading this page? / このページを読んでもいいですか?
  - `{tool} 도구를 써도 될까요?` → Allow {tool}? / {tool} を使ってもいいですか?
  - `권한 요청` → Permission / 権限リクエスト
  - `보조 에이전트의 요청이에요` → From a sub-agent / サブエージェントからのリクエストです
  - `허용` → Allow / 許可 · `항상 허용` → Always allow / 常に許可 · `거부` → Deny / 拒否
  - `이 세션 동안 같은 요청은 묻지 않아요: {rule}` → For this session, don't ask again for: {rule} / このセッション中は次を確認しません: {rule}
  - `거부하면 {name}{iga} 다른 방법을 찾을 수 있어요` → If you deny, {name} can try another way / 拒否すると{name}が別の方法を探せます
  - `허용을 보냈어요 · 확인 중` → Allowed · checking / 許可しました・確認中
  - `항상 허용을 보냈어요 · 확인 중` → Always allowed · checking / 常に許可しました・確認中
  - `거부를 보냈어요 · 확인 중` → Denied · checking / 拒否しました・確認中
  - `답을 보냈어요 · 확인 중` → Answered · checking / 回答しました・確認中
  - `답할 시간이 지나 터미널로 넘겼어요` → Timed out: answer it in the terminal / 時間切れのためターミナルで答えてください
  - `보내지 못했어요 · 터미널에서 답해 주세요` → Couldn't send · answer it in the terminal / 送信できませんでした・ターミナルで答えてください
  - `계획을 확인해 주세요` → Review the plan / 計画を確認してください
  - `{n}건 더 기다려요` → {n} more waiting / ほか {n} 件待機中
  - `{name}{iga} 허락을 기다려요: {what}` → {name} is waiting for permission: {what} / {name}が許可を待っています: {what}
  - `더 보기` → Show more / もっと見る
  - `터미널에서 보기`, `터미널에서 답하기`, `터미널에서 답해 주세요`, `질문`, `계획`, `보내는 중…`, `먼저 답해 주세요`: existing keys

- [ ] **Step 1: Failing tests** (`tests/chat-answer-ui.test.ts`):
  - `cardKey` table: digits with and without 항상 허용, arrows, composing → `null`
  - a source check that `cardKey` is called only from the cards' own `onKeyDown`, with no `window` / `document` `keydown` listener in the cards or the surface; no `autoFocus` and no `.focus()` on a card button
  - every new key in en and ja, none matching `GAME_WORDS`
  
  Run: FAIL.
- [ ] **Step 2: Implement.** The QA page section shows the Bash card, the Edit card with its diff, the sub-agent card, a question card, a plan card, a `sent` card, a `timeout` card, 업무 모드. Run the suite, `tsc`, build: PASS.
- [ ] **Step 3: Visual steps** for `qa` (답하기) against the lab's permission state and `app.css` 296–309. Checklist: the amber edge and bar; 허용 solid ink; no yellow on any card; the kbd hints quiet; the diff tinted as Phase 2's.
- [ ] **Step 4: Commit:** `chat buttons: the answer surface — permission, question and plan cards outside the list`.

### Task 4.7: Harness: the cards

**Files:** `tests/visual/fake-bridge.js` (`chat.answer`, `chat.visible` recorded; answers scripted), `chatFixture.mjs` (statuses with `asks`), `shots.mjs`, `README.md`

**Surfaces:** `chat-ask-bash`, `chat-ask-edit`, `chat-ask-agent`, `chat-ask-question`, `chat-ask-plan`, `chat-ask-timeout`, each in `WORK`, `MAC`, both text extremes and en / ja.

**Flows:**
- `chat-allow`: scrolled to the top of `chat-long`, a card pushed → visible without scrolling, the focus unchanged; Tab to the card, `1` → one `chat.answer` `{ choice: 'allow' }`; push `sent`, then no card → the surface gone.
- `chat-always`: the rule in the title; a click → `always`; a card without a rule has no 항상 허용 and `2` does nothing.
- `chat-deny`: `3` → `deny`.
- `chat-ask-enter`: the composer focused with a draft; a card pushed; Enter → zero `chat.answer` (and the composer's `먼저 답해 주세요`); digits typed in the composer → zero `chat.answer`.
- `chat-ask-timeout`: push `timeout` → no answer buttons; `터미널에서 답하기` flips to the terminal.
- `chat-ask-terminal-first`: the scripted `chat.answer` → `{ ok: false, reason: 'gone' }` → `보내지 못했어요 · 터미널에서 답해 주세요`; then the card removed by a push.
- `chat-question`: options as buttons; `2` → `{ choice: 'option', option: 1 }`; `chat.visible` called with the id at mount.
- `chat-question-hidden`: the flip to 터미널 → `chat.visible(null)`; back to 채팅 with the card `terminal` → read-only.
- `chat-plan`: no answer button; `터미널에서 답하기` flips.
- `chat-compose-focus` extended: a card pushed while typing (synthetic composition) → the focus and the composition stay.
- `keyboard`, `hit-areas` extended: the card is in the Tab order between the list and the composer; every button ≥ 22px.

- [ ] **Step 1:** Write the flows; run; fix what they find.
- [ ] **Step 2:** Visual steps for the surfaces.
- [ ] **Step 3: Commit:** `test(harness): the answer cards — allow, always, deny, timeout, terminal first, question, plan, focus`.

### Task 4.8: Sweep, guards, hand-off for Phase 4

- [ ] **Step 1: Guards** (`tests/chat-ui.test.ts`, failing first where new):
  - answer bodies are built only in `chatHolds.cjs`; no `hookSpecificOutput`, `permissionDecision` or `updatedPermissions` elsewhere in `electron/` or `src/`
  - no `localSettings`, `userSettings`, `projectSettings` in chat code
  - nothing in `src/` builds or sends a `behavior`
  - `chatHost.cjs` writes no file except through the image store and the version cache
  - `HOLD` is the only source of hold times and entry timeouts
- [ ] **Step 2: Run everything** as in Task 3.12, with the Phase 4 surfaces and flows; output to `_inbox/chat-4/08-final/`; `NOTES.txt`; the `git diff --exit-code` list.
- [ ] **Step 3:** `CHANGELOG.md` "Unreleased" and a `docs/HANDOFF.md` entry: how a hold works, the race rules, the limits (no plan answer, single-select questions only, no 항상 허용 for edits), and what only a real build shows (Task 4.9).
- [ ] **Step 4: Insight log:** "the first answer wins, and the chat never claims it was first" — the card shows Claude Code's outcome, not the click, with the `chat-allow` and `chat-ask-timeout` shots.
- [ ] **Step 5: Commit:** `chat buttons: sweep, guards, changelog and hand-off for Phase 4`.

### Task 4.9: Real-session trial (Phase 4)

**Only with the controller's go-ahead.** The same isolation as Task 3.13. A development-only override `SPAWN_CHAT_HOLD_S` (read only when `!app.isPackaged`, tested by a source check) shortens the holds for the timeout items.

Checklist:
- [ ] Bash permission → the card → 허용: the terminal dialog closes ("Allowed by PermissionRequest hook"), the row is `done`, the side panel's 확인 필요 goes.
- [ ] 항상 허용 on a Bash request: the next identical command asks nothing. **No settings file is created or changed**: the throwaway project's `.claude/settings.local.json` is absent before and after, and `~/.claude/settings.json` has the same SHA-256.
- [ ] 거부: the tool is denied and Claude goes on, and the terminal says so. **If the deny body is ignored or misread**, 거부 is replaced by `터미널에서 거부` (it flips) before Phase 4 ships, and Decision 18 is updated.
- [ ] The terminal answers first (flip, `1`): the hold is released by the keyboard rule, and the card is gone in under 1 s on return.
- [ ] Timeout (holds shortened to 20 s): the card says `답할 시간이 지나 …`, the terminal dialog still works, and there is no hook error in the TUI.
- [ ] A sub-agent's permission: the card says so and 허용 works.
- [ ] `AskUserQuestion` while the chat is shown: the card; answering → Claude goes on with that answer. While the terminal is shown: the terminal shows the question with no visible wait. The flip away while held → the terminal shows the question within 1 s.
- [ ] Plan mode: a read-only plan card; the terminal's plan dialog works as before; the `PermissionRequest` for `ExitPlanMode` is answered at once (`spawn.log` and timing).
- [ ] Turning the setting off with a hold open: released at once, the dialog still works. Quitting with a hold open: no stray process or port (as 7-47).
- [ ] The composer refuses while a card is open; after the answer it sends again.
- [ ] The game's hooks and the status line still work with the `matcher` group in the file (the session row's status, model, usage).
- [ ] **Fixes** as in Task 3.13. Commit: `chat buttons: what the first real session showed (<Claude Code version>)`.

---

## Decisions made in this plan (the owner may overrule)

1. **The prompt-row check reads the page's own terminal buffer.** `src/termMetrics.ts` already holds a reader per mounted terminal; a new read-only function exposes its text. `TerminalPanel.tsx` is not edited, and nothing headless is added (no dependency). A greyed suggestion cannot be told from typed text in text alone (the spike's screen after a turn shows `❯ Read it first, then add mul`, which the user never typed), so main's **input ledger** decides between the two, and the **echo** must start with the sent text before Enter.
2. **Bracketed paste for every non-command text, single-line or multi-line; Enter only after the echo, at least 150 ms later.** FINDINGS §6: text then `\r` 150 ms later worked every time, and bracketed paste keeps newlines as content (one prompt, never one per line). 1.4.0's side box already pastes multi-line text this way. A paste does not trigger the per-key `@` and `/` pop-ups that could swallow an Enter. Its known gap (special first characters are not escaped) is closed by Decision 3. A single-line slash command is typed raw, as the spike typed `/model` and `/clear`.
3. **The leading-space rule:** `!`, `#` and `@` at the start are always sent literally (no bash mode, no memory write from the chat). `/` followed by a command-shaped word passes through as the user's command, with a hint under the box; any other `/` start is literal.
4. **Two steps, one id, no retry.** `chat:send` types; `chat:submit` presses Enter. A send whose Enter is withheld leaves its text on the terminal's prompt row and clears the draft, so a second send cannot double it. The composer says where the text is.
5. **No `/` menu.** The spike shows no safe source for Claude Code's own command list: built-ins are in no file the lens reads, and the transcript's `skill_listing` attachment is model-facing, internal, written only after the first prompt, and not shown to be complete. Slash commands pass through as typed.
6. **`@` mention from the session's folder only** (names, no links followed, capped). It is the last composer task and can be cut without touching the rest.
7. **The queue strip is display only.** "지금 보내기" and "빼기" would need Claude Code's queue to be edited from outside (Esc behaviour around queued prompts is not verified), so they are deferred.
8. **멈추기 is one Esc, only while working with no card.** It is in the working line's reserved slot, and Esc in the composer works too when no IME composition, menu or lightbox is open, as Esc does in the terminal.
9. **Images:** copied by main to `<os temp>/spawn-chat-<instance>/<terminal id>/<random>.<ext>`. PNG, JPEG, GIF and WebP by magic bytes; ≤ 10 MB each, ≤ 8 per message, ≤ 64 or 256 MB per session. Deleted with the session, on chip removal and at start. The path is pasted on its own and quoted when it has whitespace, as the terminal's drop does. The clipboard is never written.
10. **Thumbnails** only for images sent from this composer in this run (the page's blob URLs). Older messages keep `이미지 n`; no base64 crosses IPC (Phase 2 Decision 13 stands).
11. **The side panel's box, while the chat is shown,** keeps its size and place and becomes a one-line pointer to the composer; its own text is kept for the flip back. It is 1.4.0 in every other case. This is one composer per session without a layout jump.
12. **The control row is display only:** the model, context and usage from the side panel's meters, and the permission mode from the hook bodies' `permission_mode` (hidden when unknown).
13. **Drafts live in memory** per terminal for the run, not on disk.
14. **A plain `<textarea>`,** not contenteditable: the IME behaviour is the browser's own, and there is no HTML path.
15. **Permissions are always held** (bounded), whether or not the chat is shown, because the terminal shows its own dialog at the same time and holding changes nothing for it. **Questions are held only while their chat is the visible view.** Plans are never held.
16. **The hold lives in main; the worker decides what it is.** Main never parses a body (review M13 stands): the worker binds, passes and settles.
17. **항상 허용 only from an `addRules` suggestion,** re-scoped to `destination: "session"`. `setMode` (the Edit case: "accept edits this session") is not offered in Phase 4 (not verified through the hook); the terminal still offers it.
18. **거부 is `{ behavior: "deny", message }` without `interrupt`.** Claude is told and may try another way, which is what the lab's hint says. The deny path through the hook is untested (FINDINGS "Not tested"), so the trial checks it, with a stated fallback.
19. **Questions are answered from the chat only in the verified shape:** one question, single select. Anything else is a read-only card and the terminal.
20. **Holds only for a Claude Code in the verified range (`ok`).** A newer version gets the composer (its checks fail safe) and Phase 2's passive cards.
21. **`AskUserQuestion` is held through a `matcher` group of its own**, so every other `PreToolUse` keeps its 5 s timeout and a frozen app can delay a question at most, never every tool call.
22. **Any keyboard input to a session's pty releases its holds.** The user is answering in the terminal (or with the side panel's quick buttons), and the chat steps back.
23. **The answer surface takes the amber pill's place while it shows a card.** Keys act only inside the focused card; no button is focused by default; the card shows Claude Code's outcome.
24. **After an accepted answer, `t.asking` is cleared** (`clearAsking`), as an Enter in the terminal clears it, so the side panel does not keep saying 확인 필요.
25. **A development-only override of the hold times** (`SPAWN_CHAT_HOLD_S`, never in a packaged build) exists for the trial's timeout item.

## Risks: what is version-fragile for input and held hooks, and how the plan contains it

| Fragile (FINDINGS §, trial) | What could go wrong | Containment |
|---|---|---|
| The prompt box's drawing: solid `─` rules, `❯`, two-space continuation, the footer (observed 2.1.323, 2.1.325) | A redesign makes every send refuse, or a dialog is read as a box | `promptRow` accepts only the verified shape; anything else is `unknown` → no send, 터미널로 보기. Dialog markers win. Screen fixtures pin the shapes (Tasks 3.1, 3.2) |
| Greyed suggestions and the first-run placeholder are drawn as text on the prompt row | Sends refused too often, or a paste appended to a suggestion | The ledger tells a suggestion from typed text; the echo must start with the sent head, else no Enter (Tasks 3.3, 3.4) |
| Bracketed paste does not escape `!` `/` `@` `#` (§6) | Shell mode, the command list, a memory write | The leading-space rule; `/` only when command-shaped (Task 3.3) |
| Enter 150 ms after the text (§6); long pastes shown as `[Pasted text #n +N lines]` | Enter lost, or pressed too early | Enter only after the echo and the minimum gap; `[Pasted text #` accepted only for long text; confirmation by `UserPromptSubmit` or the transcript; the `unconfirmed` bubble (Tasks 3.4, 3.7) |
| An image path pasted becomes `[Image #n]` (§7); a quoted path is unverified; the file is read asynchronously | An image missing from the prompt | The echo waits for every `[Image #`; else no Enter. The trial includes a path with a space (Task 3.13) |
| Typing while busy queues; `UserPromptSubmit` fires at enqueue (§6); `queue-operation` `enqueue` / `remove` and the `queued_command` attachment (2.1.325) | A strip showing a queue that is not Claude Code's | Unknown operations clear the strip; 10 s idle clears; the strip is display only (Task 3.6) |
| Esc interrupts (§6); it may put queued prompts back into the input (unverified) | A ledger that thinks the row is empty | Esc → `unknown`: only an empty-looking row lets a send through (Task 3.3) |
| A dialog appearing between the paste and Enter | Enter answers the dialog | Re-check before Enter: the lens not waiting, no `PermissionRequest` in 2 s, the echo still there. The residual window is milliseconds; it is named here and in the hand-off (Task 3.4) |
| `PermissionRequest` held: the terminal shows its dialog too; the first answer wins; a late answer is ignored; Claude Code does not close the connection when the terminal answers (§4, the spike's late deny) | A hold left open; a card that lies | Release on evidence, keyboard, timeout; late answers harmless by FINDINGS; cards show the outcome only from hooks and the transcript (Tasks 4.2, 4.4, 4.5) |
| A held HTTP hook at Claude Code's own `timeout` was never tested (default 600 s) | An error line in the TUI, or a decision taken | Every hold ends 30 s before its entry's timeout; the app always answers first (Tasks 4.2, 4.3) |
| `updatedPermissions` `addRules` / `session` works (§4); suggestions come with `destination: "localSettings"` | A settings file written | The destination is forced to `session` in the one place answers are built; guard; trial check (Tasks 4.2, 4.8, 4.9) |
| Deny through the hook is untested | Deny ignored or read wrongly | One constant; the trial; the stated fallback (Decision 18, Task 4.9) |
| `AskUserQuestion` held through `PreToolUse`: the terminal shows nothing meanwhile (§5); the answer shape is verified for one single-select question; a `matcher` group is new to these entries | The terminal looks stuck; a malformed answer | Held only while visible; released on flip, hide or minimise; 300 s; only the verified shape; holds only for `ok` versions; trial (Tasks 4.3–4.5, 4.9) |
| Whether a question also raises `PermissionRequest` (untested) | Two cards for one question | `PermissionRequest` for `AskUserQuestion` is passed (Task 4.4) |
| Plan approval from a hook (untested) | — | Never held; a read-only card (Task 4.4) |
| `permission_mode` in hook bodies | A wrong mode in the control row | A whitelist; unknown → hidden (Task 3.6) |
| The page's terminal reader (`termMetrics`) can be replaced by a second view of the same terminal (widget mode's question card) | No reader | No reader → `unknown` → no send; the chat is never in widget mode (Task 3.2) |
| All of the above were verified on 2.1.323–2.1.325 only | A new Claude Code changes a shape | Holds only in the verified range; the composer fails safe; each trial is re-run on a new version before the range is widened (Phase 2's `SUPPORTED` comment) |

Other risks: IME behaviour differs between Windows, macOS and the Japanese and Korean IMEs (unit sequences plus the owner's own check in the test build); `termText` runs the smoke reader's face checks on each poll (≤ 40 reads per send; measure in Task 3.11, and add a lighter registry entry only if it shows); a slow PC may need a longer echo window (the trial's CPU-load item).

## Self-review notes

**Brief → task:**
- multiline input, placeholder (work mode too), Enter / Shift+Enter, IME → 3.7, 3.8, 3.11
- sending into the pty as the spec says: the prompt row checked, the leading space, slash passthrough, multi-line as one prompt (bracketed paste, justified) → 3.2, 3.3, 3.4, Decisions 1–3
- the queued strip from the lens → 3.6, 3.8
- 멈추기 → 3.4, 3.8
- the `/` menu → Decision 5 (passthrough, said in the UI)
- `@` mention → 3.10, Decision 6
- images (temp file by main, cap, magic bytes, cleanup, no clipboard), chips, lightbox → 3.5, 3.8
- the optimistic bubble → 3.7, 3.8
- failure states (pty gone, a dialog, the prompt row not empty) → 3.4, 3.7, 3.8, 3.11
- the control row, display only → 3.8, Decision 12
- the side panel's box → 3.9, Decision 11
- permission cards with the held hook, 항상 허용 as a session rule, the race, the timeout, the entry's own timeout → 4.2–4.6
- questions by the spec's rule → 4.4, 4.5, Decisions 15, 19, 21
- plan approval read-only → 4.4, 4.6
- the surface outside the list, keyboard-reachable, never auto, never for a hidden view → 4.5, 4.6, 4.7
- off = 1.4.0 → 3.4, 3.9, 3.11, 4.3, 4.5
- tests: pure functions with fixtures, harness surfaces and flows → every task
- a real-session trial at the end of each phase → 3.13, 4.9

**Type consistency:** `Expect`, `SendRefusal`, `Draft`, `AskCard`, `PermissionMode`, `QueuedPrompt` are each defined once (`src/chat/types.ts`, `chatInput.cjs` JSDoc) and used under the same names in the host, the preload, `desktop.ts`, the page and the fake bridge. `HOLD` is the only source of hold times and entry timeouts. `ENTER`, `ESC` and the paste brackets are defined only in `chatInput.cjs`. The IPC names in the table match the preload (3.4, 3.5, 3.10, 4.5) and the fake bridge (3.11, 4.7).

**Judgment calls a reviewer should know:** the ledger plus the echo (Decision 1) instead of a headless emulator; always holding permissions (15); no `/` menu (5); the side box as a pointer (11); deny without `interrupt` (18); `setMode` not offered (17); holds only in the verified range (20).

**Every intermediate commit leaves the app working:** Tasks 3.1–3.8 add code no visible path calls (the QA page excepted); 3.9 makes the composer live behind the setting; 4.1–4.5 keep the cards passive until 4.6 draws them, and holds answer "no decision" in every path where nothing is drawn yet.

## Open questions for the owner (the recommended default in brackets; none blocks Phase 3's first tasks)

1. While the chat is shown, should the side panel's box become a one-line pointer to the composer (no layout jump), or disappear (the session list grows by its height on each flip)? [Pointer.]
2. Is a queue strip without "지금 보내기" / "빼기" acceptable for the preview? [Yes; revisit after a spike on Esc and the queue.]
3. How long should a permission card stay answerable before it hands back to the terminal (the terminal's dialog stays open throughout)? [5 minutes.]
4. Esc in the composer = 멈추기, as in the terminal? [Yes, only when not composing and no menu is open.]
5. Offer "이번 세션 동안 수정 모두 허용" (the `setMode acceptEdits` suggestion) as 항상 허용 for edits? [Not in Phase 4; after a spike verifies it.]
6. 거부: tell Claude and let it try another way, or stop the turn as the terminal's "No" does? [Tell Claude, without stopping.]
7. A `/` menu built from the skills the transcript lists, without the built-in commands? [No; keep the passthrough until there is a complete source.]
