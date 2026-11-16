# Chat View, Phase 2: the Read-only Lens — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Claude Code session can be shown as a conversation. The user's messages, the assistant's prose as safe markdown, collapsed tool rows, diffs, a provisional streaming bubble, the working state, the "새 메시지 N개" pill, an empty state and a read-failed banner are drawn from the session transcript plus a few chat hooks. A 채팅 / 터미널 flip sits in the session header, and the real terminal stays mounted and keeps working exactly as today. The feature is opt-in (설정 › 세션 "채팅으로 보기 (미리보기)", off) behind the `electron/features.json` flag `chatView`. With it off the app behaves as 1.4.0. Input still goes through the terminal or the side panel's send box.

**Architecture:** The main process gains a small HTTP endpoint (`electron/chatHooks.cjs`, 127.0.0.1, ephemeral port, per-run token in the URL path). Claude Code's HTTP hooks reach that endpoint. The hook entries are added to and removed from the same generated `--settings` file the game's hooks use (`writeSessionSettings`), so `~/.claude/settings.json` is never touched. All reading and state live in one `worker_threads` worker (`electron/chatWorker.cjs` hosting the pure-ish core `electron/chatLens.cjs`), so a multi-hundred-MB transcript can never block the main process. The core tails the transcript (`chatTail.cjs`: incremental offsets, tail first, older pages on demand, an append-only guard), turns lines into items (`chatSchema.cjs` checks and classifies, `chatItems.cjs` builds items, tool pairing and diffs), and folds in hook events (running → done, permission waits, a provisional bubble from `MessageDisplay`, a canary, banners). It emits one event model, `ChatUpdate { id, rev, ops }`, over IPC (`chat:update`). The page keeps a per-session store (`src/chat/store.ts`), derives display rows with pure functions (`src/chat/rows.ts`), and renders them in a virtualised `ChatView` beside the untouched `TerminalPanel`. `electron/chatHost.cjs` owns the lifecycle: enable, disable, drain, the version gate, the worker and the IPC handlers. `main.cjs` changes by a few lines only.

**Tech Stack:** Electron 33 main (CommonJS, `worker_threads`, `http`), React 18 + TypeScript + Vite, plain CSS on the 차분하게 2 tokens, vitest (node environment: pure functions, temp-dir IO, a real worker, a real 127.0.0.1 socket, source checks), the screenshot harness `tests/visual/shots.mjs` (playwright-core from outside the repo, fake bridge). **No new runtime dependency.** The markdown renderer is written here: see Task 12 for why a library was rejected.

**Spec:** `docs/superpowers/specs/2026-11-13-chat-view-design.md`. This plan covers Phase 2 only ("Read-only lens"). It also uses the sections "How it works", "The chat view's parts", Constraints and Anti-goals. What was verified against the real Claude Code 2.1.323 is in `spike/spawn-chat-view-spike-keep/chat-lens/FINDINGS.md`, with its scripts and `runs/` (samples-r2/r4/sub.txt, `r*/events.jsonl` with full hook bodies). `spike/chat-lens/` holds the spike's `node_modules` and a copy of `runs/`. **The spike folders are untracked and stay out of the repo.** Nothing is copied from them except the redacted fixtures written in Task 2. Reference look: the design lab `~/Documents/spawn-site-lab/calm-lab/` (`app.css` "chat view" section lines 159–335 and the "v3" block, `app.js` `convoHtml` / `bannerHtml` / `emptyHtml`, `tokens.css` 차분하게 2 block, `shots-v5/s2-chat-*.png`, `s2-work-chat.png`, `s2-size-*-chat.png`). Open the lab files; do not guess a value.

## Global Constraints

- Work only in the worktree `~/Documents/spawn-chat-view` (branch `chat-view`, at release 1.4.0 + this plan). Never push. Never build an installer. Never run the real `claude`. Never read or write `~/.claude` (tests set `CLAUDE_CONFIG_DIR` to a temp dir), `~/.spawn`, `%APPDATA%\spawn`, `%APPDATA%\spawn-dev`, or the owner's running app. Never start Electron in this plan except through vitest's plain Node, which loads `.cjs` modules without Electron.
- **Off means 1.4.0.** When `features.json` `chatView` is false or the setting `session.chatView` is false at start: no chat hook entries are written (`session-settings.json` is byte-identical to 1.4.0's, pinned by a test), no socket listens, no worker starts, no transcript is read, `TerminalInfo` objects carry no new key, and the session header and the view area render exactly as now. Turning the setting off at runtime removes the entries for new sessions at once, stops the worker at once, and closes the endpoint once no session launched with the entries is still running (Task 10, "drain"). The only lasting trace is the stored `session.chatView: false` key in the app's own `settings.json`. That is a deliberate decision (see Decisions).
- **Claude Code sessions only.** The plain shell and other tools (hidden by `otherTools`) never get chat hooks, a lens or a flip. Widget mode (`mode-widget`) never shows the chat view. It is a window/fullscreen session view only.
- **The app sends nothing on the user's behalf.** No `/model`, `/config` or any other text is written to a pty by any chat code in this phase. A source guard (Task 17) checks that `electron/chat*.cjs`, `src/chat/**` and `src/components/chat/**` / `ChatView.tsx` never call `terminals.write`, `terminals.send`, `sendInstruction` or `pty.write`. The user's Claude settings are never edited. Hook entries live only in the app-generated `--settings` file. Credentials are never read: the lens reads only `*.jsonl` files whose real path is inside `<CLAUDE_CONFIG_DIR or ~/.claude>/projects/` (Task 7).
- **Wrong or stale is the worst failure.** Whenever the mapping, the schema, the canary, the version or the append-only guard is in doubt, the lens shows the banner (이 세션을 채팅으로 읽지 못하고 있어요 · 터미널로 보기 · 다시 읽기) over a dimmed conversation. It never guesses a session from a folder name.
- **The terminal is untouched.** `src/components/TerminalPanel.tsx`, `src/keys.ts`, `src/termFont.ts`, `src/textSize.ts` and every `isComposing` path are not edited. The flip only changes the `active` prop the existing `TerminalView` already takes, which is the same mechanism as switching to another session and back today. The terminal keeps receiving output while the chat is shown.
- **`server/` behaviour unchanged.** No file under `server/` or `hooks/` is edited. `hooks/spawn-hook.cjs` `callKey` is *required* by the worker, not changed. The update zip name, signing, `scripts/release*.mjs` and `electron/updater*.cjs` are untouched. `package.json` and the lock file do not change.
- **Long sessions:** the main process never parses transcript lines (the worker does). The worker reads the tail first (bounded bytes), older pages only on request, yields between chunks, skips bookkeeping lines without parsing them, and caps what it stores and sends (Task 4 `CAPS`). The page virtualises the list and keeps at most 4000 items per session. Nothing chat-related goes to localStorage except the per-session 채팅/터미널 choice inside the existing `spawn-carry` (session ids only, at most 24 entries).
- **Look (차분하게 2):** follow the seven principles and `src/styles/tokens.css`. Only Pokémon art is vivid. Yellow is never used in this phase: there is no send button yet, and the flip's selection is `--sel-bg`. Status is a dot plus quiet words. Hairlines, not fills (the lab's user bubble on `--card-2` and the banner's amber 38 % border are the lab's own exceptions). Weights 400/500, 600 only for markdown headings. Radii 3/4/6/8. **No `var()` in `font-family`**: literal stacks whose first face is bundled (`tests/fonts.test.ts`). Prose is `'W Pretendard', 'Pretendard Variable', 'Malgun Gothic', 'Apple SD Gothic Neo', 'Hiragino Sans', system-ui, sans-serif`. Code is `'Monaspace Neon Var', Consolas, 'SF Mono', Menlo, monospace` with `--w-mono`. Nothing new animates (no caret blink, no bob). Contrast is body ≥ 4.5:1 and secondary ≥ 3:1 on every background used, diff rows included. Hit areas are ≥ 22px.
- **업무 모드** (`html.work-mode`, `useWorkMode()`): no Pokémon picture, name, ball, "HP" or step count anywhere in the chat. The assistant is "에이전트" with the neutral glyph. Toggling it causes no layout jump: the turn head keeps its 22px picture box, the empty state its picture box.
- **Text size:** every chat size reads `--t-prose`, `--t-ui`, `--t-meta`, `--t-micro`, `--t-code`, `--t-head` (they follow the four steps of `src/textSize.ts`). There are no fixed px font sizes in `chat.css` except the 13px `가`-style exceptions listed in Task 14 (none expected).
- **macOS:** the same code. Paths come from `CLAUDE_CONFIG_DIR` or `~/.claude/projects`. Tooltips name keys through `modCombo()` / `modLabel()`. `.is-mac` rules are not touched. Nothing new is a window drag region (`-webkit-app-region: no-drag` on the flip).
- **ko / en / ja for every string**: Korean is the key (`t('…')`). New chat strings go in a new `src/locales/chat.ts` registered in `src/locales/index.ts`. The settings row goes in `src/locales/settings.ts`.
- **Windows first;** the owner's daily terminal workflow and Korean IME must not change in any way, on or off.
- Green before every commit, from Git Bash in the worktree: `npx vitest run`, `npx tsc --noEmit -p .`, `npx vite build`. UI tasks also run the harness checks they name.
- Commits are small, one per task (or per step that says "Commit"). Each message ends with the trailer line `Claude-Session: https://claude.ai/code/session_01LECh1AuSxY28Be3QgsqBWD`.
- **Out of scope (leave the seams named in "Seams for Phases 3–5"):** the composer and any sending, queue strip, 멈추기 (Esc), "고쳐 달라고 하기", "다시 보내기", suggested prompts, permission/question/plan buttons, the 변경 사항 panel, link preview cards, turn summary, wild-Pokémon rows, density levels, find, image thumbnails, todo chip, syntax colouring, a keyboard shortcut for the flip, and making chat the default view.

## Review Focus

These are ordered by how likely each is to hurt the user, most likely first. Each has its check in the owning task.

1. **A wrong or stale conversation.** This covers a `/clear` (new id, new file), a resumed session, two terminals, a transcript that stops growing, a rewritten file, a format change in a new Claude Code, and a hook for a session the lens cannot place. Each must end in the right conversation or in the banner, never in someone else's text. → Tasks 7, 8 (mapping table tests, canary with fake timers, rewrite guard, stall timer), Task 15 (`--flow chat-banner`).
2. **The owner's terminal workflow changes.** Off must equal 1.4.0. On, the flip must keep the pty, the scroll position, the WebGL renderer cycle, the focus return and the Korean IME exactly as a session switch does today. `TerminalPanel.tsx` is never edited. → Task 1 (off = identical), Task 9 (settings file byte-identical), Task 15 (`--flow chat-flip`), Task 17 (guards).
3. **Claude Code waits on us.** `MessageDisplay` makes Claude Code wait for each batch's hook, and every chat hook is synchronous. The endpoint must answer before doing any work, answer even while draining, and never hold. A dead worker must not slow a hook. → Task 9 (answer-time test < 50 ms under a stalled consumer), Task 10 (worker crash → endpoint still answers).
4. **A long session freezes the app.** A 300 MB transcript must not block main or the page: work stays in the worker, the tail comes first, pages are bounded, lines are capped, the page list is virtual. → Task 6 (bytes-read and event-loop-lag tests), Task 16 (`chat-long` DOM-count check).
5. **An unknown Claude Code rejects the settings file** and with it the game's hooks. A version that does not know `MessageDisplay` or `type: "http"` hooks could refuse the whole `--settings` file. → Task 10 (version gate before arming: never add chat entries for a version older than the verified range or one that cannot be read; a version newer than the range is armed with a quiet note, the canary as the safety net — the owner's ruling of 2026-11-15. The verdict is cached with the binary sessions run and re-checked in the background when Claude Code changes).
6. **Markdown turns into HTML or a link escapes.** There must be no `dangerouslySetInnerHTML`, no raw HTML, no `javascript:` link, no remote image load. Links open only through `terminals.openUrl` (http/https in main). → Task 12, Task 17 (source guard).

Also covered, though not in the six: 업무 모드 wording in every new string (Task 17), a permission wait never inside a collapsed group (Task 11), text sizes and en/ja fit (Task 17).

---

## File map

| File | After this plan |
|---|---|
| `electron/features.json`, `electron/features.cjs`, `src/features.ts` | + flag `chatView` (false until Task 18); `CHAT_VIEW` (main also honours `SPAWN_CHAT_VIEW=1`, the page `VITE_SPAWN_CHAT_VIEW=1`, both for development only) |
| `electron/settings.cjs`, `src/settingsStore.ts`, `src/desktop.ts` | + `session.chatView: false` |
| `electron/chatSchema.cjs` (new) | Line classification, schema checks, the noise prefix test, supported Claude Code versions |
| `electron/chatItems.cjs` (new) | Transcript line → items; tool pairing; whitelisted tool input; capped output; diffs; notices |
| `electron/chatTail.cjs` (new) | One transcript file: incremental read, partial lines, append-only guard, tail first, older pages |
| `electron/chatLens.cjs` (new) | The core: terminals ↔ conversations, transcript resolution, hooks → live state, provisional bubble, canary, banners, version, sub-agent files; emits `ChatUpdate` |
| `electron/chatWorker.cjs` (new) | `worker_threads` entry: `chatLens` with real fs and timers; message protocol |
| `electron/chatHooks.cjs` (new) | `CHAT_HOOK_EVENTS`, `chatHookEntries()`, the 127.0.0.1 endpoint (token, caps, answer-first, drain) |
| `electron/chatHost.cjs` (new) | Lifecycle (enable / disable / drain / version gate / ready), worker, `chat:*` IPC handlers |
| `electron/terminals.cjs` | `writeSessionSettings(…, chat)` appends chat groups; manager option `chat`; `t.chatArmed`; `info().chat` only when on |
| `electron/prereqs.cjs` | exports `claudeVersion` (unchanged behaviour) |
| `electron/main.cjs` | ~15 lines: build the host, pass `chat` to the terminal manager, react to the setting, await `ready()` before creating a terminal while on, close on quit |
| `electron/preload.cjs` | + `chat: { open, close, older, reload, agent, onUpdate }` |
| `src/chat/types.ts` (new) | The event model (below), shared by the page; main mirrors it in JSDoc |
| `src/chat/store.ts` (new) | Per-terminal store: `applyUpdate`, sorted items, rev gaps, item cap; `useChat(id)` |
| `src/chat/rows.ts` (new) | Items → display rows: days, turn heads, read/search groups, sub-agent nesting, the never-collapse rule, unread counting |
| `src/chat/markdown.ts` (new) | Safe markdown → a small AST (no HTML anywhere) |
| `src/chat/toolLabel.ts` (new) | Tool → icon, label key, detail; work-mode words |
| `src/chat/virtual.ts` (new) | Visible range, prepend anchoring, stick-to-bottom |
| `src/chat/lensMode.ts` (new) | Per-session 채팅/터미널 choice (carry), availability and its reason |
| `src/components/ChatView.tsx` (new, lazy) | The view: list, turn heads, states, pill, empty, banner |
| `src/components/chat/*.tsx` (new) | `Markdown`, `CodeBlock`, `ToolRow`, `ToolGroup`, `AgentGroup`, `DiffBlock`, `UserMessage`, `ChatBanner`, `ChatList` |
| `src/components/SessionHeader.tsx` | + optional `lens` prop: the 채팅 / 터미널 flip (absent → markup identical) |
| `src/Widget.tsx` | Lazy `ChatView` for the shown session in chat mode; `TerminalView active` also requires terminal mode |
| `src/carry.ts` | + `chatModes?: Record<string, 'chat' \| 'terminal'>` |
| `src/styles/tokens.css` | + `--read-w: 840px; --add-bg: rgba(116, 214, 139, 0.07); --del-bg: rgba(255, 100, 100, 0.07)` |
| `src/styles/chat.css` (new) | Chat styles (imported by `ChatView.tsx` only) |
| `src/locales/chat.ts` (new), `src/locales/index.ts`, `src/locales/settings.ts` | Strings |
| `tests/fixtures/chat/*` (new) | Redacted transcripts and hook sequences |
| `tests/visual/chatFixture.mjs` (new), `shots.mjs`, `fake-bridge.js`, `README.md` | Chat surfaces and flows |
| `tests/chat-*.test.ts` (new); `features`, `settings`, `terminals`, `tokens`, `work-mode` tests (edited) | See tasks |

## The event model (main → page)

`src/chat/types.ts` writes exactly this. `electron/chatItems.cjs` and `chatLens.cjs` carry the same shapes as JSDoc `@typedef`s, and `tests/chat-items.test.ts` validates real outputs against a runtime checker built from these field lists.

```ts
/** One item of a conversation. `order` sorts them: a main-transcript line's byte offset; LIVE_BASE + n for
 *  hook-only items not yet in the transcript; LIVE_ORDER for the provisional bubble. A sub-agent's items carry
 *  `parent` (the Agent tool row's id) and their own file's offsets. The page ignores kinds it does not know. */
export const LIVE_BASE = 2 ** 52
export const LIVE_ORDER = Number.MAX_SAFE_INTEGER
export interface ItemBase { id: string; order: number; at: number | null; parent?: string }
export interface UserItem extends ItemBase { kind: 'user'; text: string; images: number; truncated?: boolean }
export interface TextItem extends ItemBase { kind: 'text'; text: string; partial?: boolean; truncated?: boolean }
export type ToolState = 'running' | 'done' | 'failed' | 'rejected' | 'interrupted' | 'unknown'
export interface ToolItem extends ItemBase {
  kind: 'tool'; tool: string | null; input: ToolInput; state: ToolState
  waiting?: 'permission' | 'question' | 'plan'          // answered in the terminal in this phase
  output?: ToolOutput; diff?: DiffBlock; durationMs?: number
  agentId?: string; agentTools?: number                  // Agent/Task rows: the sub-agent and its tool count so far
}
export interface ToolInput {   // a whitelisted, capped excerpt (Task 4) — never the whole input
  file?: string; command?: string; description?: string; pattern?: string; path?: string; url?: string
  query?: string; question?: string; options?: string[]; plan?: string; todos?: { done: number; total: number }
  agentType?: string; server?: string; mcpTool?: string
}
export interface ToolOutput { text: string; lines: number; truncated: boolean; error: boolean }
export interface DiffBlock { file: string; kind: 'edit' | 'create' | 'write'; added: number; removed: number; hunks: DiffHunk[]; hidden: number }
export interface DiffHunk { oldStart: number; newStart: number; lines: DiffLine[] }
export interface DiffLine { t: '+' | '-' | ' '; old: number | null; new: number | null; text: string }
export interface NoticeItem extends ItemBase { kind: 'notice'; notice: 'interrupted' | 'command' | 'compact' | 'agent-done' | 'unknown-block' | 'model'; text?: string }
export interface TurnEndItem extends ItemBase { kind: 'turn-end'; durationMs: number }
export interface LiveItem extends ItemBase { kind: 'live'; text: string }
export type ChatItem = UserItem | TextItem | ToolItem | NoticeItem | TurnEndItem | LiveItem

export type BannerReason = 'schema' | 'canary' | 'missing' | 'stalled' | 'rewrite' | 'version' | 'mapping' | 'worker'
export interface LensStatus {
  state: 'starting' | 'idle' | 'working' | 'waiting' | 'ended'
  since: number | null                 // working / waiting since (ms epoch)
  label: 'compact' | null              // what the work is, when known
  banner: { reason: BannerReason; detail?: string } | null
  note: 'new-version' | null           // a Claude Code newer than the verified range
  version: string | null
  hasOlder: boolean                    // older items exist before the first one sent
  empty: boolean                       // no transcript yet (a new session)
}
export type ChatOp =
  | { op: 'reset'; items: ChatItem[]; status: LensStatus }
  | { op: 'upsert'; items: ChatItem[] }     // insert or replace by id (a later field set wins whole)
  | { op: 'remove'; ids: string[] }
  | { op: 'status'; status: LensStatus }
export interface ChatUpdate { id: string /* terminal id */; rev: number; ops: ChatOp[] }
```

Rules: `rev` grows by one per update per terminal. The page applies an update only when `rev === last + 1` (or the update starts with `reset`). On a gap it calls `chat.resync(id)`, which answers with a `reset` of the view as it is, banners kept (`chat.reload` is only the banner's 다시 읽기: it re-reads and re-judges). Main numbers every terminal's updates, also the status-only ones of views not open, so the page follows each terminal's rev from its first update. `reset` replaces everything. `upsert` of an existing id replaces that item whole, so main always sends complete items. Items are kept sorted by `(order, id)`.

### IPC

| Name | Kind | Payload → answer |
|---|---|---|
| `chat:open` | invoke | `id` → `{ ok: true } \| { ok: false, reason: 'off' \| 'not-claude' \| 'unarmed' \| 'version' }`; a `reset` follows on `chat:update` |
| `chat:close` | send | `id` → the worker stops tailing it after 60 s of no `open` (flipping back within a minute costs nothing) |
| `chat:older` | invoke | `id` → `{ ok, loaded: number }`; items arrive as `upsert`, `status.hasOlder` updated |
| `chat:reload` | invoke | `id` → `{ ok }`; a fresh read, banner cleared and re-evaluated; a `reset` follows (다시 읽기) |
| `chat:resync` | invoke | `id` → `{ ok }`; the view sent again as it is (a `reset`, banners kept): the answer to a rev gap |
| `chat:agent` | invoke | `{ id, toolId }` → `{ ok }`; the sub-agent's items arrive as `upsert` with `parent: toolId` |
| `chat:update` | event | `ChatUpdate` |

Every handler goes through main's existing `guard` (`fromOurWindow`). Updates go to `widgetWin` only (`sendToWindows`).

### Worker protocol (main ↔ `chatWorker.cjs`)

main → worker: `{ t: 'init', claudeDir, userDataDir }`, `{ t: 'terminals', list: [{ id, cwd, armed, status }] }`, `{ t: 'hook', event, raw, at }` (the body's bytes, size-capped and transferred; parsed in the worker, so main never holds a parsed body — review M13), `{ t: 'resync', id, req }`, `{ t: 'open' | 'close' | 'older' | 'reload', id }`, `{ t: 'agent', id, toolId }`.
worker → main: `{ t: 'update', update: ChatUpdate }`, `{ t: 'log', level, msg }` (to `electron/logs.cjs`; never transcript text).

### Seams for Phases 3–5 (leave them clean; do not build them)

- **Phase 3, composer:** `ChatView` has a `footer?: React.ReactNode` slot, rendered after the list (nothing in Phase 2). IPC names reserved: `chat:send`, `chat:interrupt`. The `queue-operation` lines are classified `queue` and skipped (Task 3), and a later `queued` item kind slots into `rows.ts`. The working line has a reserved right-hand slot for 멈추기. Failed tool rows have a reserved action slot for "고쳐 달라고 하기". The empty state has a reserved block for suggested prompts. User items carry `images: n` and will gain thumbnails.
- **Phase 4, buttons:** `chatHooks.cjs` `onHook(event, body)` may later return `{ hold: Promise<object> }`. In Phase 2 it never does, and the endpoint answers before calling it. `PermissionRequest` is already subscribed passively and pairs to its call with `callKey` (Task 7). That gives `waiting: 'permission'`, and a later `permission` item kind with `chat:answer` replaces the "터미널에서 답해 주세요" line. `AskUserQuestion` and `ExitPlanMode` rows already show their question/plan read-only, never collapsed.
- **Phase 5:** `DiffBlock` is complete per edit (file, hunks, counts), so the 변경 사항 panel aggregates `tool.diff` by file in the page. The file name in `DiffBlock`'s header calls one function `openFileFromChat(id, file, line)`, which Phase 5 retargets. The markdown AST marks every link node, so a `chat:preview` card slots in after the paragraph. `turn-end` items feed a turn summary. `rows.ts` `buildRows(items, opts)` takes `opts.extra` (time-stamped timeline entries, empty in Phase 2) for wild-Pokémon rows, and `opts.density` (only `'default'` now).

---

## Visual verification (one method for the whole plan)

The harness of Phase 1 (`tests/visual/shots.mjs`, see `tests/visual/README.md`) gains chat surfaces in Task 14 and chat flows in Tasks 15–16. The fixture conversation is built **by the real `electron/chatItems.cjs`** from the redacted fixtures (`tests/visual/chatFixture.mjs` requires it through `createRequire`), so the screenshots exercise the real parser. The fake bridge's `chat` member answers `open` with a `reset` from the fixture and records every call in `window.__CALLS__` (`chat.open`, `chat.close`, `chat.older`, `chat.reload`, `chat.agent`). A flow can push further updates with `window.__CHAT_PUSH__(id, ops)`.

**Every UI task ends with these steps** ("the visual steps"):
1. `npx vite build`
2. `node tests/visual/shots.mjs --out "~/Documents/spawn-portfolio/_inbox/chat-2/<NN-task>/" --only <surfaces>`
3. Open each PNG with the Read tool. Compare it with the lab shot named in the task (`calm-lab/shots-v5/`). A difference that is not in "Decisions" and not out of scope (composer, header tools, queue strip, link card, wild row, turn foot) is a defect: fix it, or report it with the shot.
4. Run the checks and flows the task names (`--check fit`, `--check work`, `--flow …`). They exit non-zero on failure.

Lab references: `chat` → `s2-chat-detail.png` (the conversation column only: ignore the composer, the queue strip, the header tools, the link card, the wild row and the turn foot); `chat-work` → `s2-work-chat.png`; `chat-small` / `chat-xlarge` → `s2-size-smallest-chat.png` / `s2-size-largest-chat.png`; `chat` at 1100×720 → `s2-chat-1100.png`. The banner and empty state have no shot: use `app.css` lines 632–649 and `app.js` `bannerHtml` / `emptyHtml`.

---

### Task 1: The flag and the setting (off), nothing else

This task leaves the app identical whatever the setting, because nothing reads the setting yet.

**Files:**
- Modify: `electron/features.json` (+ `"chatView": false` and its `//` note), `electron/features.cjs` (+ `CHAT_VIEW`), `src/features.ts` (+ `CHAT_VIEW`, `chatViewOn`), `electron/settings.cjs` (`session.chatView: false`), `src/settingsStore.ts` (`DEFAULT_SETTINGS`), `src/desktop.ts` (`AppSettings.session.chatView: boolean`), `src/components/SettingsView.tsx` (one `Toggle` in 세션, rendered only when `CHAT_VIEW`), `src/locales/settings.ts`, `tests/visual/fake-bridge.js` (settings default gains `chatView: false`)
- Test: `tests/features.test.ts`, `tests/settings.test.ts`

**Interfaces:**
- `electron/features.cjs`: `CHAT_VIEW = FEATURES.chatView === true || process.env.SPAWN_CHAT_VIEW === '1'` (the env is for development runs and tests; say so in the comment).
- `src/features.ts`: `export const CHAT_VIEW: boolean = FEATURES.chatView === true || import.meta.env?.VITE_SPAWN_CHAT_VIEW === '1'` and `export function chatViewOn(s: { session: { chatView: boolean } }, flag = CHAT_VIEW): boolean { return flag && s.session.chatView === true }`.
- Settings row (세션, after `시작할 때 세션 다시 열기`): `Toggle` label `채팅으로 보기 (미리보기)`, hint `Claude Code 세션을 대화처럼 볼 수 있어요. 터미널은 그대로 돌아가고, 세션 머리의 채팅 · 터미널로 바꿔 봐요. 켠 뒤에 여는 세션부터 돼요`.

- [ ] **Step 1: Failing tests.** `tests/features.test.ts`: `features.json` has `chatView === false`; `chatViewOn({ session: { chatView: true } }, false) === false`; `(…, true) === true`; `chatViewOn({ session: { chatView: false } }, true) === false`. `tests/settings.test.ts`: `sanitize(null).session.chatView === false`; `{ session: { chatView: 'yes' } }` → false; `true` kept; `applyPatch` toggles it. Source check: `SettingsView.tsx` renders `t('채팅으로 보기 (미리보기)')` only inside a `CHAT_VIEW &&` expression. Locale check: the label and hint have en and ja. Run `npx vitest run tests/features.test.ts tests/settings.test.ts`: FAIL.
- [ ] **Step 2: Implement.** Strings: `채팅으로 보기 (미리보기)` → View sessions as chat (preview) / セッションをチャットで表示(プレビュー). The hint → "Shows a Claude Code session as a conversation. The terminal keeps running; switch with Chat · Terminal in the session header. Works for sessions opened after you turn it on." / "Claude Code のセッションを会話として表示します。ターミナルはそのまま動き、セッション見出しのチャット・ターミナルで切り替えます。オンにした後に開くセッションから使えます。"
- [ ] **Step 3: Run** the suite, `tsc` and build: PASS. Also run `node tests/visual/shots.mjs --only settings --check fit`, which must exit 0 (the row is hidden: flag false).
- [ ] **Step 4: Commit:** `chat view: the feature flag and the 설정 switch, both off`.

### Task 2: Redacted fixtures and the redaction guard

There is no product code in this task. The fixtures are **hand-written** from the shapes in the spike's `runs/samples-r2.txt`, `samples-r4.txt`, `samples-sub.txt` and the full hook bodies in `runs/r1|r2|r4/events.jsonl`. Keep every key the samples show, in the same nesting. Replace every value that is not structural:
- paths → `C:\\Users\\user\\work\\demo` (Windows) or `/Users/user/work/demo` (the Mac fixture)
- ids → fresh `00000000-0000-4000-8000-0000000000NN` UUIDs and `toolu_fixtureNN` / `msg_fixtureNN`
- prompts and answers → harmless text (rivers, `add`/`sub`/`mul`, the Greek-letter table)
- base64 → a 16×16 PNG of at most 200 characters
- `credential_org`, `session-owner`, `atis-latch`, `api-request*`, `cost-state`, `serverClassifierContext`, `prompt_snapshot` → one line each with every value replaced by `"REDACTED"` (they exist to prove they are dropped)

**Files:**
- Create in `tests/fixtures/chat/`:
  - `basic.jsonl`: bookkeeping lines (`mode`, `permission-mode`, `file-history-snapshot`, attachments `environment`, `skill_listing` (shortened), `date`, `credential_org`), a string user prompt, `last-prompt`, `ai-title`, a thinking line (empty), an assistant text with a markdown table and a numbered list, `system/stop_hook_summary`, `system/turn_duration`
  - `tools.jsonl`: Read + `toolUseResult.file`; Grep and Glob; a Bash ok (`stdout`); a Bash failed (`is_error: true`); an Edit that fails ("String to replace not found") and then succeeds with `structuredPatch` + `originalFile`; a Write create (`type: "create"`, `structuredPatch: []`); a `hook_permission_decision` attachment; `permissionDecision` fields on results
  - `interrupt.jsonl`: an assistant text with `stop_reason: null`, then `[Request interrupted by user]`; a rejected tool (`toolUseResult: "User rejected tool use"`, `is_error: true`), then `[Request interrupted by user for tool use]`
  - `agent.jsonl` and `agent/subagents/agent-afixture01.jsonl` (+ `.meta.json`; tests copy this folder to `<project>/<conversation id>/subagents/`, the layout of FINDINGS §1): an `Agent` tool_use, its `async_launched` result with `agentId`, sidechain lines `isSidechain: true` (a PowerShell tool + result), a later task-notification user line
  - `ask-plan.jsonl`: AskUserQuestion tool_use + result with `questions/answers`; a Write into `plans/`; ExitPlanMode with `plan`; `plan_mode_exit` attachment
  - `image.jsonl`: user `[text, image{base64}]` with `imagePasteIds`, the meta line `[Image: source: …]`, an `attachment:file` image
  - `commands.jsonl`: a slash command user line with `<command-name>` / `<local-command-stdout>`, a `system/local_command` line, a `queue-operation` enqueue, a `<system-reminder>` meta string
  - `bad.jsonl`: one line that is not JSON, a user line without `message`, a tool_use without `id`, an unknown content block type `{"type":"hologram"}`, an unknown top-level type
  - `hooks-tools.jsonl`: one hook body per line (`{ "at": <ms from 0>, "event": …, "body": … }`) from r2: UserPromptSubmit → PreToolUse(Edit) → PermissionRequest(Edit, no `tool_use_id`) → PostToolUse(Edit with `tool_response.structuredPatch`) → PreToolUse(Bash) → PostToolUseFailure(Bash) → Stop (`last_assistant_message`)
  - `hooks-stream.jsonl`: from r1/r4: UserPromptSubmit, `MessageDisplay` ×3 (`index` 0..2, `final` on the last, `message_id` that does **not** match the transcript's), Stop; and a second turn interrupted (MessageDisplay ×1, no final, no Stop)
  - `hooks-agent.jsonl`: PreToolUse(Agent), SubagentStart (`agent_id`, `agent_type`), PreToolUse with `agent_id`, PostToolUse with `agent_id`, SubagentStop (`agent_transcript_path`), PostToolUse(Agent)
  - `mac/basic.jsonl`: `basic.jsonl` with `/Users/user/...` paths
- Create: `tests/chat-fixtures.test.ts`

- [ ] **Step 1: Write `tests/chat-fixtures.test.ts`** before the fixtures, so it fails on an empty folder. For every file under `tests/fixtures/chat/` (recursive):
  - (a) each non-empty line of a `.jsonl` except the one deliberate bad line in `bad.jsonl` parses as JSON
  - (b) no match for `/DueStar|spawn-promo|chat-spike|AppData\\\\Local\\\\Temp\\\\claude|msg_011|toolu_01[A-Za-z0-9]{20}|sk-ant|@[a-z0-9-]+\.[a-z]{2,}|Bearer /i`, nor for the machine owner's user name (read at run time, never written down), nor for a private string known only by its SHA-256 (no private value is ever written into a tracked file)
  - (c) every Windows path starts `C:\\Users\\user\\` and every POSIX home path `/Users/user/`
  - (d) no string value longer than 4000 characters, and no base64 run longer than 200
  - (e) the attachment kinds listed above appear only with `"REDACTED"` values
  - (f) `hooks-*.jsonl` lines have `at`, `event`, `body`, and `body.hook_event_name === event`
  
  Run it: FAIL (folder missing).
- [ ] **Step 2: Write the fixtures** as listed. Run the test: PASS.
- [ ] **Step 3: Commit:** `test: redacted transcript and hook fixtures for the chat lens, with a redaction guard`.

### Task 3: Classify and check transcript lines; supported versions (`electron/chatSchema.cjs`)

**Files:**
- Create: `electron/chatSchema.cjs`, `tests/chat-schema.test.ts`

**Interfaces:**
- `NOISE_TYPES`: `file-history-snapshot`, `file-history-delta`, `queue-operation`, `last-prompt`, `ai-title`, `tools-used`, `cost-state`, `mode`, `permission-mode`, `session-owner`, `atis-latch`, `api-request`, `api-request-shape`, `api-request-blob`, `custom-title`, `summary`.
- `quickSkip(raw: string): boolean` is true when the line's first 64 characters match `^\{"type":"(<NOISE_TYPES>)"`, or when the first 256 characters contain `"attachment":{"type":"`. In Phase 2 no attachment kind is kept; the seam is an empty `KEEP_ATTACHMENTS` set. It never parses.
- `classify(obj): 'user' | 'assistant' | 'system' | 'attachment' | 'noise' | 'unknown'`.
- `checkLine(obj): null | { hard: boolean; problem: string }`:
  - hard: `user`/`assistant` without a string `uuid`, without an object `message`, or without `message.content` of string or array; a `tool_use` block without string `id` and `name`; a `tool_result` without string `tool_use_id`; a `text` block whose `text` is not a string
  - soft: an unknown top-level `type`; an unknown content block `type` (known: `text`, `tool_use`, `tool_result`, `thinking`, `redacted_thinking`, `image`, `document`); `system` without `subtype`
- `SUPPORTED = { min: '2.1.323', below: '2.2.0' }`. The comment names FINDINGS.md and says how to widen it: rerun the spike scripts on the new version first.
- `versionVerdict(v: string | null | undefined): 'ok' | 'new' | 'old' | 'unknown'` parses `^(\d+)\.(\d+)\.(\d+)` anywhere in the string (`claude --version` prints `2.1.323 (Claude Code)`). The result is `ok` for `min ≤ v < below`, `new` for `v ≥ below`, `old` for `v < min`, and `unknown` when nothing parses.

- [ ] **Step 1: Failing tests** with the fixtures:
  - every line of `basic.jsonl` classifies, and the noise ones are `quickSkip` true without a parse (spy: `JSON.parse` not called for them)
  - all lines of `tools.jsonl` pass `checkLine`
  - `bad.jsonl` gives exactly: one parse failure (handled by the caller, see Task 6), two hard problems, two soft problems
  - `versionVerdict`: `'2.1.323 (Claude Code)'` → ok; `'2.1.400'` → ok; `'2.2.0'` → new; `'3.0.1'` → new; `'2.1.300'` → old; `''`, `null`, `'claude'` → unknown
  
  Run it: FAIL.
- [ ] **Step 2: Implement.** Run it: PASS.
- [ ] **Step 3: Commit:** `chat lens: classify and check transcript lines; the verified Claude Code range`.

### Task 4: Transcript lines → items (`electron/chatItems.cjs`)

**Files:**
- Create: `electron/chatItems.cjs`, `tests/chat-items.test.ts`

**Interfaces:**
- `CAPS = { text: 200_000, output: 8_000, outputLines: 200, command: 2_000, plan: 20_000, field: 400, diffLines: 600 }`.
- `createItemBuilder({ cwd?: string, caps = CAPS })` returns `{ line(obj, order): ChatItem[]; tool(id): ToolItem | undefined }`. It is stateful only for pairing: a map of tool items by id, so a `tool_result` updates the row its `tool_use` made. A result whose tool_use was never seen (it is in an older page) makes a `tool` item with `tool: null` and `state` from the result. When the tool_use arrives later, the builder merges the two, and `order` becomes the tool_use's.
- Mapping:
  - **`user` lines.**
    - A string or text-block content, not `isMeta`, not `isSidechain`, gives a `user` item. `images` counts the image blocks; the base64 is never copied.
    - Text starting `[Request interrupted by user` gives a `notice: 'interrupted'`.
    - `<command-name>…</command-name>` gives `notice: 'command'` with the command text (for example `/clear`). `<local-command-stdout>` is dropped.
    - `<task-notification>` gives `notice: 'agent-done'`.
    - `<system-reminder>`, `isMeta` and `turnCompanion` lines give nothing.
    - `tool_result` blocks update their tool. A result whose `is_error` is true or whose `toolUseResult` is `"User rejected tool use"` sets `failed` or `rejected`. Otherwise the state is `done`.
  - **`assistant` lines.**
    - A `text` block gives a `text` item, with `partial: true` when `stop_reason === null`. Several text blocks in one line get ids `<uuid>:<n>`.
    - `tool_use` gives a `tool` item, `state: 'running'` until its result.
    - `thinking` and `redacted_thinking` give nothing in Phase 2 (the seam is density).
    - An unknown block gives a `notice: 'unknown-block'`.
  - **`system` lines.** `turn_duration` gives `turn-end`. `compact_boundary` (and anything with `subtype` containing `compact`) gives `notice: 'compact'`. `local_command` gives `notice: 'command'`. Everything else gives nothing.
  - **`toolInput(name, input)`** whitelists by tool:
    - `Read`, `Write`, `Edit`, `MultiEdit`, `NotebookEdit` → `file` (relative to `cwd` when inside it)
    - `Bash`, `PowerShell` → `command` (capped), `description`
    - `Grep` → `pattern`, `path`
    - `Glob` → `pattern`
    - `WebFetch` → `url`
    - `WebSearch` → `query`
    - `Agent`, `Task` → `description`, `agentType`
    - `AskUserQuestion` → `question` (the first), `options` (labels, at most 6)
    - `ExitPlanMode` → `plan` (capped)
    - `TodoWrite` → `todos` counts
    - `mcp__<server>__<tool>` → `server`, `mcpTool`
    - anything else → `{}`
    
    Every string is capped at `CAPS.field` unless named otherwise.
  - **`toolOutput(content, toolUseResult)`**: text from the result's string content, or from its text blocks, capped at `CAPS.output` characters and `CAPS.outputLines` lines. `truncated` and `lines` (the full count) say what was cut, and `error` mirrors `is_error`. A `Read` result keeps only `{ lines: numLines }` and an empty text, since a whole file is never sent.
  - Every item gets `at = Date.parse(timestamp)` or null. Sidechain lines (`isSidechain`) are built only when the builder was made with `{ parent }` (Task 8). Otherwise they are skipped.

- [ ] **Step 1: Failing tests** over the fixtures:
  - `basic` gives one user item, one text item containing the table, and one turn-end of 13909 ms; nothing from noise lines; no item's JSON contains `REDACTED`, `credential` or `base64`
  - `tools`: Read row `done` with `input.file` relative and an empty output; Grep/Glob rows; Bash ok `done` with output `42`; Bash failed `failed` with `error: true`; the first Edit `failed`, the second `done`; Write `done`
  - `interrupt`: the text is `partial`, an `interrupted` notice, the rejected tool is `rejected`
  - `commands`: a `command` notice reading `/clear`; nothing from the queue line or the reminder
  - `image`: the user item has `images: 1`
  - pairing across pages: feeding the result line before its tool_use line yields one item whose final `order` is the tool_use's offset and whose `tool` is the name
  - caps: a 1 MB Bash stdout becomes ≤ 8000 characters with `truncated: true` and the right `lines`
  - shape: every produced item passes the runtime checker built from the field lists in `src/chat/types.ts` (a small hand-written validator in the test)
  
  Run it: FAIL.
- [ ] **Step 2: Implement.** Run it: PASS.
- [ ] **Step 3: Commit:** `chat lens: transcript lines become conversation items, tool rows paired, output capped`.

### Task 5: Diffs from `structuredPatch`

**Files:**
- Modify: `electron/chatItems.cjs` (+ `buildDiff`, used by the builder for successful `Edit` / `MultiEdit` / `Write` results)
- Create: `tests/chat-diff.test.ts`

**Interfaces:**
- `buildDiff(toolUseResult, { cwd, maxLines = CAPS.diffLines }): DiffBlock | null`:
  - **Edit-like** (`structuredPatch` is a non-empty array whose every hunk has numeric `oldStart/oldLines/newStart/newLines` and a string-array `lines`): `kind: 'edit'`. Each line's first character gives `t`. Old and new line numbers are counted from the hunk starts. `added` and `removed` count every `+` and `-` line (all of them, also beyond the cap). Lines beyond `maxLines` are dropped and counted in `hidden`.
  - **`type: 'create'`** with a string `content`: `kind: 'create'`, every line `+`, numbered from 1, the same cap.
  - **Write over an existing file** (`type: 'update'` with a valid `structuredPatch`): `kind: 'write'`, as edit.
  - **Anything else** (no patch, an empty patch on a non-create, malformed hunks): `null`. The row then shows no counts, and nothing is invented. This covers the unverified `MultiEdit` and Write-over-existing shapes, which are tested only for not crashing and for null-or-valid.
  - `file` is relative to `cwd` when inside it, with forward slashes. No disk read, ever: `originalFile` is not used for display in Phase 2.

- [ ] **Step 1: Failing tests:**
  - the `tools.jsonl` Edit gives `{ kind: 'edit', added: 4, removed: 1, hunks: [ { oldStart: 6, newStart: 6, … } ] }` with the line numbers as the fixture hunk implies
  - the Write create gives `kind: 'create'` with `added` = the content's line count
  - an 800-line create gives `hidden: 200` with `added: 800`
  - malformed hunks (missing `lines`, a non-numeric `oldStart`) give `null`
  - a `structuredPatch: []` without `type: 'create'` gives `null`
  - the source of `buildDiff` contains no `fs.` and no `readFile`
  
  Run it: FAIL.
- [ ] **Step 2: Implement** and attach `diff` to the tool item when non-null. Run it: PASS.
- [ ] **Step 3: Commit:** `chat lens: diff blocks and +N −N from the transcript's structuredPatch, no disk reads`.

### Task 6: The tailer (`electron/chatTail.cjs`)

**Files:**
- Create: `electron/chatTail.cjs`, `tests/chat-tail.test.ts`

**Interfaces:**
- `splitLines(buf: Buffer, carry: Buffer): { lines: { text: string; offset: number }[]; carry: Buffer }` is pure. It splits on `\n`, keeps an incomplete last line in `carry`, and works with UTF-8 multi-byte characters across chunk edges (split on the byte `0x0a` only, then decode each whole line).
- `createTail(file, { fs = require('fs').promises, chunk = 1 << 20, yieldEvery = 2 << 20, guardBytes = 64 << 10 })` returns:
  - `readTail({ want, maxBytes = 16 << 20, keep }): Promise<{ lines, startOffset, endOffset, atStart }>`. It reads backwards in `chunk`s from the end until `keep(text)` (a cheap pre-filter: `!quickSkip(text)`) has accepted `want` lines, or `maxBytes` were read, or the file start is reached. A partial last line (no trailing `\n`) is not returned. It is picked up by `readNew`.
  - `readNew(): Promise<{ lines, rewritten: boolean }>` reads from `endOffset` to the current size.
  - `readOlder({ want, maxBytes = 4 << 20, keep })` reads backwards from `startOffset`.
  - `state(): { startOffset, endOffset, size }`.
- **Append-only guard.** Keep `head` (sha1 of the first `min(guardBytes, size)` bytes) and `edge` (sha1 of the `guardBytes` before `endOffset`). Before each `readNew`, `fs.stat`: if the size shrank, or the re-read `head` or `edge` differs, return `{ rewritten: true }` and reset nothing itself (the lens decides: banner `rewrite` + a fresh read).
- All IO is `fs.promises` with an open `FileHandle` per read. Each `yieldEvery` bytes processed, the tailer does `await new Promise(r => setImmediate(r))`. No `readFileSync`, no whole-file read.

- [ ] **Step 1: Failing tests** in a temp dir:
  - `splitLines`: Korean text split mid-character across two buffers reassembles exactly, and the offsets are byte offsets
  - `readTail` on a file of 300 short lines with `want: 50` returns the last 50 in order with correct offsets, and an injected counting `fs` shows it read ≤ 2 chunks
  - append 3 lines plus half a line: `readNew` returns 3; completing the half returns 1 more
  - truncate the file, or overwrite its first bytes with the same length: `readNew` → `rewritten: true`
  - `readOlder` walks back to the start, with `atStart` true at the end, and no line is returned twice
  - **performance:** a synthetic 64 MB transcript (lines repeated from `tools.jsonl`, plus 1 MB lines) built in `os.tmpdir()`. `readTail({ want: 150 })` reads ≤ 16 MB (counting fs). While it runs, a `setInterval(…, 5)` in the same process never sees a gap > 100 ms. The file is removed after.
  
  Run it: FAIL.
- [ ] **Step 2: Implement.** Run it: PASS.
- [ ] **Step 3: Commit:** `chat lens: a transcript tailer that reads the end first, appends incrementally and notices a rewrite`.

### Task 7: The lens core I: terminals, transcripts, hooks, the live bubble (`electron/chatLens.cjs`)

**Files:**
- Create: `electron/chatLens.cjs`, `tests/chat-lens.test.ts`

**Interfaces:**
- `createLens({ claudeDir, userDataDir, fs, now = Date.now, timers = { setTimeout, clearTimeout, setInterval, clearInterval }, emit: (u: ChatUpdate) => void, callKey })` returns `{ setTerminals(list), hook(event, body, at), open(id), close(id), older(id), reload(id), agent(id, toolId), dispose() }`.
- Pure helpers, exported for tests:
  - **`conversationOf(terminal, readLink)`** = `readLink(terminal.id) || terminal.id`. `readLink` reads `<userDataDir>/session-links/<id>` (the file the game hook writes at every SessionStart; read-only here).
  - **`terminalFor(sessionId, terminals, current, readLink)`** returns the one armed terminal whose `current` conversation equals `sessionId`. Otherwise it re-reads the link files of the armed terminals and returns the one whose link equals it, otherwise the one whose id equals it, otherwise **null**. When two terminals match, it returns null and marks both `mapping` (banner). It never matches by `cwd`.
  - **`transcriptAllowed(p, claudeDir)`**: the real path (via `fs.realpath`, async) ends in `.jsonl` and lies inside `realpath(claudeDir)/projects/`. Otherwise false.
  - **`findTranscript(conversationId, claudeDir)`**: the hook's `transcript_path` is preferred when allowed. Otherwise the code scans `projects/*/<id>.jsonl` (as `hasTranscript` in `terminals.cjs` does). It never builds the folder name from `cwd`.
  - **`liveMatches(live: string, text: string)`**: both normalised (CRLF → LF, trailing whitespace trimmed per line, then trimmed whole) and true when `text.startsWith(live.slice(0, 200))` or `live.startsWith(text.slice(0, 200))` with ≥ 20 matching characters, or when they are equal.
- State per terminal: `current` conversation id, transcript path, tail, builder, items (only for the loaded range), `pending` tool rows by `tool_use_id`, `calls` (callKey → tool_use_id for the running main-thread calls), `live` (MessageDisplay text by `message_id`), status, `rev`, `open` flag.
- Hooks (each body checked: `session_id` a string; ignored otherwise; mapped with `terminalFor`; ignored when null):
  - `UserPromptSubmit` → status `working` with `since = at`, the `current` conversation updated, and the transcript path re-resolved when `transcript_path` differs (a `/clear` or a resume). On a different path the lens resets that terminal's view to the new file with a `reset`.
  - `PreToolUse` → when no item exists for `tool_use_id`, a `tool` item with `order = LIVE_BASE + n`, `state: 'running'`, input from `toolInput`, and `calls[callKey(tool_name, tool_input)] = tool_use_id`. `AskUserQuestion` → `waiting: 'question'`. `ExitPlanMode` → `waiting: 'plan'`. With `agent_id` (a sub-agent's tool) it does not make a row: it increments `agentTools` on the Agent row paired to that agent id (the pairing is in Task 8).
  - `PermissionRequest` (no `tool_use_id`) → the tool id from `calls[callKey(tool_name, tool_input)]` gets `waiting: 'permission'` and the status becomes `waiting`. With no match, the status alone becomes `waiting` and no row is guessed.
  - `PostToolUse` → `state: 'done'` and `durationMs`; `waiting` cleared. `PostToolUseFailure` → `failed`. Both remove the `calls` entry.
  - `MessageDisplay` → append `delta` to `live[message_id]` in `index` order (buffer out-of-order indexes until the gap fills). Emit or replace one `live` item `id: 'live:' + message_id`, `order: LIVE_ORDER`.
  - `Stop` / `StopFailure` → status `idle`; running rows without a result stay `running` until the transcript says otherwise (Task 8 decides at the canary). `PreCompact` → `label: 'compact'`; `PostCompact` → `label: null`.
- Transcript lines feed the builder. When a `text` item arrives and some live item `liveMatches` it, the lens sends `remove` for the live id in the same update as the `upsert` of the text. When a `tool_use` line arrives for a hook-made row, the row is upserted with its real `order` (the same id).
- `open(id)`: resolve the transcript. If there is none yet, emit `reset` with `status.empty: true` and watch: poll every 500 ms for `projects/*/<conversation>.jsonl`, and also re-resolve on each hook for this terminal. Otherwise `readTail({ want: 150 })`, then `reset` with the items and `hasOlder: !atStart`. Then follow with `readNew` on `fs.watch` of the file, plus a stat poll: 250 ms while `working`/`waiting`, 1000 ms while idle. A hook for this terminal also triggers a read 50 ms later.
- `close(id)` drops the tail and items after 60 s without a new `open`. Hook-derived status keeps being tracked (it is cheap).

- [ ] **Step 1: Failing tests** (fake timers, a temp `claudeDir` with `projects/C--Users-user-work-demo/`, the fixtures copied into it, `emit` collecting updates):
  - **mapping table:**
    - session id = terminal id → that terminal
    - session id = a link file's content → that terminal
    - after the link file changes (a `/clear`) → the same terminal, and a `reset` for the new file when `UserPromptSubmit` names the new `transcript_path`
    - an unknown id → null and no update
    - two terminals linked to the same id → null for both and the banner `mapping` on the open one
    - a `transcript_path` pointing at `claudeDir/settings.json` or `../../x.jsonl` → refused (`transcriptAllowed` false) and never read (spy on `fs`)
  - **hooks replay** of `hooks-tools.jsonl` against `tools.jsonl`: PreToolUse makes a running row before any transcript line; PermissionRequest marks that row `waiting: 'permission'` and the status `waiting`; PostToolUse makes it `done`; the transcript tool_use then moves it to its file order with the same id; PostToolUseFailure makes the Bash row `failed`
  - **live bubble** (`hooks-stream.jsonl` + `basic.jsonl` text): three MessageDisplay batches give one `live` item whose text is the concatenation; the transcript text line then removes it in the same update as the upsert; the second, interrupted turn's live text is replaced by the `partial` text line
  - **revs** increase by one per update; no update is emitted for a terminal that is not open, except `status`
  
  Run it: FAIL.
- [ ] **Step 2: Implement.** Run it: PASS.
- [ ] **Step 3: Commit:** `chat lens: map hooks to the right session, tool rows live from hooks, a provisional bubble from MessageDisplay`.

### Task 8: The lens core II: canary, banners, version, rewrite, stall, sub-agents

**Files:**
- Modify: `electron/chatLens.cjs`
- Create: `tests/chat-canary.test.ts`

**Interfaces and rules** (each a banner `reason`; the banner text is in Task 14):
- **canary.** On `Stop` with a non-empty `last_assistant_message`: within 3000 ms the transcript must hold a `text` item of this turn (after the turn's user item) for which `liveMatches(last_assistant_message, item.text)` holds. Otherwise the banner is `canary`. With an empty `last_assistant_message` (a tool-only turn), the check is that the transcript grew after the turn's `UserPromptSubmit`.
- **missing.** After a `UserPromptSubmit` for an open terminal, no transcript file is found (or none grew) within 5000 ms.
- **stalled.** Hook tool events keep arriving (≥ 3 PreToolUse/PostToolUse) while the transcript has not grown for 30 000 ms.
- **schema.** Any hard `checkLine` problem, or a complete line that is not JSON, in what was read. Or soft problems on more than half of the last 200 kept lines.
- **rewrite.** `readNew` reports `rewritten`. The lens shows the banner and stops following until `reload`.
- **version.** The first `user`/`assistant` line with a `version` field, or the version the host gave at arm time (Task 10), whose `versionVerdict` is `old` gives this banner. When it is `new`, the status gets `note: 'new-version'` and no banner.
- **worker.** This one is set by the host, not here (Task 10).
- Clearing: `canary`, `missing` and `stalled` clear when a later turn's canary passes. `schema`, `rewrite`, `version` and `mapping` stay until `reload(id)`, which drops the tail, re-reads from the tail and re-evaluates. The banner never hides the items: the page dims them.
- **Interrupt.** Text items marked `partial` and an `interrupted` notice turn the turn's running rows into `interrupted`, and the status goes `idle`. No Stop comes after Esc, so the canary is not armed.
- **Sub-agents.**
  - On `SubagentStart` (`agent_id`), pair `agent_id` with the single running Agent/Task row that has no `agentId` yet. When there are several, do not pair: count the tools on the status only, never on a guessed row.
  - The transcript's Agent tool_result `toolUseResult.agentId` also sets `agentId` (authoritative).
  - `agent(id, toolId)` reads the sidechain file: `SubagentStop`'s `agent_transcript_path` when allowed, else `<dirname(transcript)>/<conversation>/subagents/agent-<agentId>.jsonl` when allowed. It uses a builder made with `{ parent: toolId }` and at most 200 items, and sends them as `upsert`. With no file, it sends nothing and logs once.

- [ ] **Step 1: Failing tests** with fake timers:
  - Stop + matching text at +250 ms → no banner
  - Stop + no text by +3000 ms → `canary`; a later turn whose canary passes → banner cleared
  - Stop with `last_assistant_message` "A" but the transcript has "B" → `canary`
  - UserPromptSubmit and no file for 5000 ms → `missing`
  - 3 PreToolUse over 31 s with a frozen file → `stalled`
  - `bad.jsonl` → `schema`
  - rewriting the file → `rewrite`, and nothing more is read until `reload`
  - a line with `version: '2.1.200'` → `version`; `'2.3.0'` → `note: 'new-version'` with no banner
  - the interrupted fixture → rows `interrupted`, status `idle`, no canary armed
  - sub-agent: `hooks-agent.jsonl` pairs `agent_id` to the Agent row, and `agentTools` counts 1; two running Agent rows → no pairing; `agent()` on `agent.jsonl` returns the sidechain PowerShell row with `parent` set; a `agent_transcript_path` outside `projects/` → not read
  
  Run it: FAIL.
- [ ] **Step 2: Implement.** Run it, plus Task 7's tests: PASS.
- [ ] **Step 3: Commit:** `chat lens: the canary and the read-failed reasons; sub-agent rows from their own transcript`.

### Task 9: The hook endpoint and the installer (`electron/chatHooks.cjs`, `electron/terminals.cjs`)

**Files:**
- Create: `electron/chatHooks.cjs`, `tests/chat-hooks.test.ts`
- Modify: `electron/terminals.cjs`
- Test: `tests/terminals.test.ts`

**Interfaces:**
- `CHAT_HOOK_EVENTS = ['UserPromptSubmit', 'PreToolUse', 'PermissionRequest', 'PostToolUse', 'PostToolUseFailure', 'MessageDisplay', 'Stop', 'StopFailure', 'SubagentStart', 'SubagentStop', 'PreCompact', 'PostCompact']`. There is no `SessionStart`/`SessionEnd`: they accept only command hooks (FINDINGS §2), and the game's own hook already writes the link file on SessionStart.
- `chatHookEntries({ port, token })` builds, for each event, `{ hooks: [{ type: 'http', url: 'http://127.0.0.1:<port>/chat/<token>/<Event>', timeout: event === 'MessageDisplay' ? 3 : 5 }] }`. There are no `headers` and no `allowedEnvVars`: the header auth is untested (FINDINGS "Not tested"), and an unknown key could make Claude Code refuse the whole file.
- `writeSessionSettings(repoRoot, dir, runtime = process.execPath, chat = null)`: with `chat` null the file is **byte-identical** to 1.4.0. With `chat = chatHookEntries(...)`, each chat entry is **appended** as a separate matcher group after the game's group (`hooks[e] = [gameGroup, chatGroup]`). `MessageDisplay` gets `[chatGroup]` alone. The game's groups keep their position and bytes. The builder is pure (`sessionSettingsJson(repoRoot, runtime, chat)` returns the string), and `writeSessionSettings` writes it.
- `createTerminalManager({ …, chat = { state: () => ({ on: false }) } })` where `state()` returns `{ on: false } | { on: true; hooks: object | null; reason?: 'version' | 'starting'; version?: string | null }`:
  - `settings()` rewrites the file whenever `JSON.stringify(state().hooks ?? null)` differs from what was last written (a toggle at runtime). This is also how the entries are **removed** when the feature goes off.
  - `create()` sets `t.chatArmed = adapter.id === 'claude' && !!state().hooks` at launch.
  - `info(t)` adds `chat: t.chatArmed ? 'armed' : (state().reason ?? 'unarmed')` **only when** `state().on && t.adapter.id === 'claude'`. The key is absent otherwise.
  - `refreshSettings()` is exported for the host to call on a toggle.
- `createChatEndpoint({ onHook, maxBody = 2 << 20, log })` returns `{ listen(): Promise<{ port, token }>, setDraining(on: boolean), close(): Promise<void> }`:
  - It listens on `127.0.0.1` port 0. The token is 24 random bytes in hex, made once per endpoint. Only `POST /chat/<token>/<Event>` with `Event` in `CHAT_HOOK_EVENTS` is accepted, with the token compared using `crypto.timingSafeEqual`.
  - It refuses (403, no body) when an `Origin` header is present or `Host` is not `127.0.0.1:<port>`. A wrong path or token gets 404.
  - It reads the body up to `maxBody`. Over the cap it stops reading and passes `{ oversize: true }` instead.
  - **It answers `200` with an empty body as soon as the body has been read, before parsing, before `onHook`.** Then it parses and calls `onHook(event, body, Date.now())` in a `setImmediate`, inside try/catch. A body that is not JSON is dropped. Draining: it answers 200 and does not call `onHook`.
  - `close()` stops listening and destroys open sockets.

- [ ] **Step 1: Failing tests.**
  - `tests/terminals.test.ts`:
    - **(off = 1.4.0)** `sessionSettingsJson(REPO, 'C:\\Program Files\\spawn\\spawn.exe', null)` equals an inline expected string. Capture it from the *current* `writeSessionSettings` **before changing anything** (the tree is at 1.4.0 here): write it to a temp dir, then paste the file's content as a literal with a comment saying so. Repo-root-dependent parts become `${REPO_SLASHED}` interpolations.
    - with chat entries: every game group is unchanged at index 0, the chat group is at index 1, `MessageDisplay` has one group, and `JSON.parse` round-trips
    - **idempotence:** writing twice with the same chat gives the same bytes; writing with chat and then with `null` gives the 1.4.0 bytes again
    - a manager with `chat.state()` `{ on: false }` lists terminals with no `chat` key (deep-equal to today's `info`)
    - with `{ on: true, hooks }`: a Claude terminal is `chat: 'armed'` and a shell has no key
    - a toggle between two `create()` calls rewrites the file, and the first terminal stays `armed` while the second follows the new state
  - `tests/chat-hooks.test.ts` (a real socket):
    - the right token gives 200 and `onHook` is called once with the parsed body
    - a wrong token gives 404, `GET` 404, an `Origin` header 403, a wrong `Host` 403
    - 3 MB gives 200 with `onHook` receiving `{ oversize: true }`
    - **answer-first:** with an `onHook` that blocks for 500 ms (busy loop inside the `setImmediate`), the response for the first of two concurrent posts arrives in < 50 ms
    - draining answers 200 without calling `onHook`
    - the URL in `chatHookEntries` contains no `$`, and every entry has exactly the keys `type`, `url`, `timeout`
  
  Run them: FAIL.
- [ ] **Step 2: Implement.** Run them: PASS. The existing `terminals.test.ts` tests stay green unchanged.
- [ ] **Step 3: Commit:** `chat lens: a 127.0.0.1 hook endpoint that answers first; chat hooks added to and removed from the session settings`.

### Task 10: The host: worker, IPC, main wiring, version gate, drain

After this task the whole back end works when the feature is on (test with `SPAWN_CHAT_VIEW=1` only in vitest; never start Electron). With the flag false, main never constructs the endpoint or the worker.

**Files:**
- Create: `electron/chatWorker.cjs`, `electron/chatHost.cjs`, `tests/chat-host.test.ts`, `tests/chat-worker.test.ts`
- Modify: `electron/main.cjs`, `electron/preload.cjs`, `electron/prereqs.cjs` (export `claudeVersion` only), `src/desktop.ts` (`chat` bridge types, `TerminalInfo.chat?: 'armed' | 'unarmed' | 'version' | 'starting'`)

**Interfaces:**
- **`chatWorker.cjs`** (worker entry): `parentPort.on('message', …)` per the protocol. It builds `createLens({ claudeDir: process.env.CLAUDE_CONFIG_DIR || ~/.claude, userDataDir, fs: real, emit: u => parentPort.postMessage({ t: 'update', update: u }), callKey: require('../hooks/spawn-hook.cjs').callKey })`. Uncaught errors are posted as `{ t: 'log', level: 'error' }`, and the worker exits non-zero.
- **`chatHost.cjs`**: `createChatHost({ terminals, send, userDataDir, claudeVersion, makeWorker = (file) => new Worker(file), makeEndpoint = createChatEndpoint, log, now })` returns:
  - `enable(): Promise<void>`:
    1. Probe the version with `claudeVersion` (a 5 s cap; the binary sessions run; a verdict cached with that binary is used at once and checked again in the background). If the verdict is `old` or `unknown`, the state is `{ on: true, hooks: null, reason: 'version', version }`, nothing listens, and there is no worker.
    2. Otherwise start the endpoint (or reuse a draining one with its port and token), start the worker, and set the state `{ on: true, hooks: chatHookEntries(...), version }`.
    3. Call `terminals.refreshSettings()`.
    
    While this runs, the state is `{ on: true, hooks: null, reason: 'starting' }`.
  - `disable()`: the state becomes `{ on: false }`, then `terminals.refreshSettings()`, `worker.terminate()` and `endpoint.setDraining(true)`. Nothing is sent to the page: it drops its chat views on its own when `TerminalInfo.chat` disappears from the next list (Task 15). The endpoint closes once `terminals.list()` has no running armed terminal (checked on every list change).
  - `ready(): Promise<void>` resolves when `enable` has finished, or at once when off. Main awaits it (bounded at 3 s) in `terminals:create` **only while on**, so restored sessions start armed.
  - `state()` is the value passed to the terminal manager's `chat.state`.
  - `onTerminals(list)` forwards to the worker and checks drain.
  - `registerIpc(ipcMain, guard)` registers the table in "IPC": `open` answers `off` / `not-claude` / `unarmed` / `version` from the list and the state without touching the worker.
  - `close()` is called at quit after the sessions have ended.
  - **Worker crash.** On `exit` with a non-zero code, every open terminal gets a `status` with banner `worker`. The worker is restarted at most twice per run, with 1 s backoff. The endpoint keeps answering throughout, because it never depends on the worker.
- **`main.cjs`** changes, all guarded so that off is identical:
  - `const { CHAT_VIEW } = require('./features.cjs')`.
  - Build `chatHost` lazily only when `CHAT_VIEW` is true.
  - Pass `chat: { state: () => chatHost?.state() ?? { on: false } }` to `createTerminalManager`.
  - After the window loads, `if (CHAT_VIEW && appSettings().session.chatView) chatHost.enable()`.
  - In `changeSettings`, when `next.session.chatView !== before.session.chatView && CHAT_VIEW`, call `enable()` or `disable()`.
  - In the `terminals:create` handler, `if (chatHost?.state().on) await Promise.race([chatHost.ready(), sleep(3000)])` before `terminals.create`.
  - `sendToWindows` is reused for `chat:update`.
  - `chatHost?.close()` runs in the quit sequence's `finally` before `stopServer()`.
  - The terminal list broadcast also calls `chatHost?.onTerminals(list)`: wrap the `send` passed to the manager, so that a `terminals:list` message also goes to the host.
- **`preload.cjs`**: `chat: { open: id => invoke('chat:open', String(id)), close: id => send('chat:close', String(id)), older: id => invoke('chat:older', String(id)), reload: id => invoke('chat:reload', String(id)), agent: (id, toolId) => invoke('chat:agent', { id: String(id), toolId: String(toolId) }), onUpdate: fn => on('chat:update', fn) }`.

- [ ] **Step 1: Failing tests.**
  - `tests/chat-host.test.ts` (fake worker, fake endpoint, fake terminals, fake `claudeVersion`):
    - **off:** `state()` is `{ on: false }`, and `makeWorker` / `makeEndpoint` are never called
    - **enable with `2.1.323`:** state `on` with hooks, `refreshSettings` called, one worker, one endpoint
    - **enable with `2.0.9`:** `reason: 'version'`, no endpoint, no worker
    - **`claudeVersion` hanging:** after 5 s `reason: 'version'` (`unknown`)
    - **disable while an armed terminal runs:** the worker is terminated, the endpoint is draining and not closed; when the list shows it exited, the endpoint closes
    - **enable again while draining:** the same port and token
    - **worker exit code 1:** an open terminal gets banner `worker` and the worker restarts; after a third crash there is no restart
    - **IPC:** `chat:open` for a shell → `not-claude`, for an unarmed Claude terminal → `unarmed`
  - `tests/chat-worker.test.ts`: a **real worker** (`new Worker('electron/chatWorker.cjs')`) with `CLAUDE_CONFIG_DIR` set to a temp dir holding `tools.jsonl`. `terminals` + `open` gives a `reset` with the fixture's items; posting `hooks-tools.jsonl` bodies gives the expected `upsert`s; `terminate()` is clean.
  - Source checks on `main.cjs`:
    - `createChatHost(` appears only inside a `CHAT_VIEW` condition
    - `chatHost.enable()` only behind `session.chatView`
    - `await` on `ready()` only behind `state().on`
    - `chatWorker`, `http.createServer` and `chatHookEntries` do not appear in `main.cjs` (they live in the host)
  
  Run them: FAIL.
- [ ] **Step 2: Implement.** Run the suite and `tsc`: PASS. The existing `prereqs.test.ts` stays green.
- [ ] **Step 3: Commit:** `chat lens: the host — a worker for reading, the hook endpoint, a version gate, drain on off — wired into main behind the flag`.

### Task 11: The page's model: types, store, rows (`src/chat/*`)

**Files:**
- Create: `src/chat/types.ts` (the event model, verbatim), `src/chat/store.ts`, `src/chat/rows.ts`, `tests/chat-store.test.ts`, `tests/chat-rows.test.ts`

**Interfaces:**
- **`store.ts`:**
  - `interface ChatState { rev: number; items: ChatItem[]; status: LensStatus | null }`
  - `applyUpdate(s: ChatState, u: ChatUpdate, cap = 4000): { state: ChatState; gap: boolean }` is pure. A `rev` gap (not `reset`) leaves the state unchanged with `gap: true`.
  - `upsert` replaces an item by id or inserts it keeping `(order, id)` order (binary search).
  - Over `cap`, the oldest items are dropped and `status.hasOlder` is set true.
  - `useChat(id: string | null): ChatState` is a `useSyncExternalStore` over one module-level `Map` fed by `bridge.chat.onUpdate`. It calls `bridge.chat.open(id)` on first subscribe and `bridge.chat.close(id)` when the last subscriber leaves. On `gap` it calls `bridge.chat.resync(id)` (review I5).
- **`rows.ts`:** `buildRows(items: ChatItem[], opts: { density?: 'default'; extra?: unknown[]; dayLabel: (at: number) => string }): Row[]` with
  ```ts
  type Row =
    | { row: 'day'; key: string; label: string }
    | { row: 'user'; key: string; item: UserItem }
    | { row: 'turn-head'; key: string; at: number | null }
    | { row: 'text'; key: string; item: TextItem }
    | { row: 'tool'; key: string; item: ToolItem; children: ToolItem[] }
    | { row: 'group'; key: string; items: ToolItem[]; files: number; searches: number }
    | { row: 'notice'; key: string; item: NoticeItem }
    | { row: 'live'; key: string; item: LiveItem }
  ```
  - A `turn-head` comes before the first assistant item after each `user` item, or at the start of the list when it begins mid-turn.
  - A `day` row comes before the first item of each calendar day (local time).
  - Items with a `parent` never make their own rows. They go in `children` of the row whose item id is `parent`.
  - `turn-end` makes no row in Phase 2 (the summary seam).
  - **Grouping:** consecutive tool items in the same turn whose `tool` is `Read`, `Glob`, `Grep`, `LS` or `NotebookRead` and whose state is `done` become one `group` (`files` = Read count, `searches` = Glob + Grep count). A single such item stays a `tool` row.
  - **Never collapsed:** a tool with `waiting` set, with state `failed` or `running`, or named `AskUserQuestion` or `ExitPlanMode`, is never inside a group, and it breaks a run.
  - `unreadAfter(prev: Row[], next: Row[]): number` counts the rows of kind `user`, `text`, `tool`, `group` and `notice` whose key is in `next` after the last key of `prev` and not in `prev`. (The page adds it to the pill while the user is scrolled up.)

- [ ] **Step 1: Failing tests:**
  - `applyUpdate`: reset → upsert → remove in order; an out-of-order upsert re-sorts; a gap reports `gap` and leaves the state alone; replacing a `live` item by a text keeps one row; the cap of 5 over 8 items keeps the newest 5 and sets `hasOlder`
  - `buildRows` over items built (in the test) from `tools.jsonl` through `electron/chatItems.cjs`: Read + Grep + Glob become one group (1 file, 2 searches); the failed Bash is its own row; a `waiting: 'permission'` Read is never grouped (the anti-goal, as a test); sub-agent items nest under their Agent row; one turn-head per turn; a day row at the date change
  - `unreadAfter`: two new texts → 2; a changed existing row → 0
  
  Run them: FAIL.
- [ ] **Step 2: Implement.** Run them, plus `tsc`: PASS.
- [ ] **Step 3: Commit:** `chat view: the page's store and rows (groups, nesting, a permission wait never collapsed)`.

### Task 12: Safe markdown (`src/chat/markdown.ts`, `src/components/chat/Markdown.tsx`, `CodeBlock.tsx`)

**Decision: no library.** `markdown-it` 14 (MIT, ≈ 100 KB minified, `html: false` escapes raw HTML) and `marked` (MIT, ≈ 40 KB) both produce an **HTML string**, which would need `dangerouslySetInnerHTML` plus a sanitiser. `react-markdown` + `remark-gfm` (MIT, no HTML path) pulls in the unified/micromark tree (≈ 40 packages, ≈ 45 KB gzipped). A small parser to a typed AST, rendered by React as text nodes, has **no HTML path at all**. Its subset is bounded by what Claude Code prints and is tested against real answers. It is ≈ 400 lines.

**Interfaces:**
- `parseMarkdown(src: string): Block[]` is pure:
  - Blocks: `heading{level 1–4, inline}`, `para{inline}`, `list{ordered, start, items: Block[][]}` (nesting by indentation ≥ 2 spaces, up to 4 levels), `code{lang, text}` (``` and ~~~ fences; an unclosed fence runs to the end, which matters for the live bubble), `table{align[], head: Inline[][], rows: Inline[][][]}` (GFM pipes, the alignment row required, a ragged row padded), `quote{blocks}`, `hr`.
  - Inline: `text`, `code`, `strong`, `em`, `del`, `link{href, children}`, `autolink` (bare `https?://…` with trailing `.,;:)` trimmed), `path{file, line?, col?}` (a token like `src/a/b.ts:18` or `C:\x\y.ts:3:7`, with a known source-file extension, outside code spans), `br`.
  - Raw HTML (`<div>`, `<img …>`, `<script>`) stays **literal text**. Images `![alt](url)` become a `link` whose text is `alt` (no image is ever loaded). A link `href` whose scheme is not `http`, `https` or `mailto` becomes plain text.
  - Input is capped at 200 000 characters, and the work is linear: no regex with nested quantifiers over the whole input.
- `<Markdown blocks={…} onLink={url => …} onPath={(file, line, col) => …} />` renders React elements only. Tables are wrapped in `.tbl-wrap` (horizontal scroll). Links are `<a href="#">` with `onClick` → `onLink`, and `title` = the URL. Paths are `.fchip` buttons → `onPath`. Nowhere is there `dangerouslySetInnerHTML`, `innerHTML` or `eval`.
- `<CodeBlock lang text />`: a head with the language name (`--t-meta`), a 복사 button (`navigator.clipboard.writeText`, then 복사했어요 for 1.5 s, or 복사하지 못했어요), and `<pre>`. There is no colouring (Decision).
- The page wiring: `onLink` → `bridge.terminals.openUrl(url)` (main allows http/https only). `onPath` → `openFileFromChat(id, file, line, col)` in `src/chat/lensMode.ts`, which calls `bridge.terminals.openPath(id, …)` (the Phase 5 seam).

- [ ] **Step 1: Failing tests** (`tests/chat-markdown.test.ts`):
  - the Greek-letter table from `basic.jsonl` parses to a table with 2 columns and 3 rows
  - a numbered list of 30 lines
  - nested bullets (3 levels)
  - a fenced `ts` code block, and an unclosed fence
  - `**bold** _em_ ~~del~~ \`code\``
  - `[MDN](https://developer.mozilla.org/x)` → a link
  - `[x](javascript:alert(1))` → text `[x](javascript:alert(1))`
  - `<img src=x onerror=alert(1)>` → literal text
  - `![a](https://e.x/i.png)` → a link with text `a`
  - a bare `https://example.com/a).` → an autolink `https://example.com/a`
  - `src/app/cart/LoginButton.tsx:18` → a path with line 18, but not inside backticks
  - Korean prose with `**강조**` mid-word
  - a 200 000-character pathological input (`*` × 100 000) parses in < 200 ms
  - source guard: no file under `src/chat/` or `src/components/chat/` contains `dangerouslySetInnerHTML`, `innerHTML` or `eval(`
  
  Run it: FAIL.
- [ ] **Step 2: Implement** the parser, `Markdown.tsx` and `CodeBlock.tsx`. Strings: `복사` (Copy / コピー, if it is not already in the locale; otherwise reuse it) · `복사했어요` → Copied / コピーしました · `복사하지 못했어요` → Couldn't copy / コピーできませんでした · `코드 복사` → Copy code / コードをコピー. Run it, plus `tsc`: PASS.
- [ ] **Step 3: Commit:** `chat view: a small safe markdown renderer (tables, lists, code with copy, links via the app), no HTML path`.

### Task 13: Tool rows, read groups, the diff block, the sub-agent group

**Files:**
- Create: `src/chat/toolLabel.ts`, `src/components/chat/ToolRow.tsx`, `ToolGroup.tsx`, `AgentGroup.tsx`, `DiffBlock.tsx`, `tests/chat-tool-label.test.ts`
- Modify: `src/locales/chat.ts` (create it here if Task 12 did not), `src/locales/index.ts`

**Interfaces:**
- `toolLabel(item: ToolItem): { icon: 'file' | 'search' | 'run' | 'edit' | 'agent' | 'web' | 'todo' | 'question' | 'plan' | 'tool'; label: string /* a Korean key */; vars?: Record<string, string | number>; detail: string; mono: boolean }`. The labels:

  | Tool | Label (ko key) | Detail |
  |---|---|---|
  | Read | `파일 읽음` | file |
  | Grep | `검색` | `"pattern"` · path |
  | Glob | `파일 찾기` | pattern |
  | Bash/PowerShell | `명령 실행` / `명령 실행 실패` / `명령을 멈췄어요` | description or command |
  | Edit/MultiEdit | `파일 수정` | file |
  | Write | `새 파일` (create) / `파일 저장` | file |
  | Agent/Task | `보조 에이전트` | description |
  | WebFetch | `웹 페이지 읽음` | url host |
  | WebSearch | `웹 검색` | query |
  | TodoWrite | `할 일 정리` | `{done}/{total}` |
  | AskUserQuestion | `질문` | question |
  | ExitPlanMode | `계획` | first line of plan |
  | mcp | `{server} · {tool}` | none |
  | other | the tool name as is | none |

  `rejected` → `거절됨` on the meta side. `interrupted` → `멈춤`. `unknown` → no meta.
- `groupLabel(files, searches)`: `파일 {n}개 읽음`, `검색 {n}회`, or both joined with ` · `.
- **`ToolRow`** (lab `.tl`): one line, the chevron, icon, label, detail (mono when `mono`) and meta on the right.
  - Meta:
    - running: a dot `--green` + `실행 중`
    - waiting: a dot `--amber` + `터미널에서 답해 주세요` and a `터미널로 보기` button (`onTerminal`)
    - failed: the label and icon in `--red-text`
    - `durationMs` when ≥ 1 s
  - The body opens on click and shows `output.text` in mono, line-clamped by its own scroll (max-height 320px) with `출력이 길어서 앞부분만 보여요 ({lines}줄)` when truncated.
  - A failed row starts closed but shows its first error line in the detail. The "고쳐 달라고 하기" slot stays empty.
  - `AskUserQuestion` shows the question and options as a quiet list, always open. `ExitPlanMode` shows the plan through `<Markdown>`, always open. Both carry `질문 · 터미널에서 답해 주세요` / `계획 · 터미널에서 답해 주세요` while waiting, and `답함` after.
- **`ToolGroup`**: one row, chevron + label. The body lists each file (read lines when known) and each pattern.
- **`AgentGroup`**: the Agent row shows the label + description + `도구 {n}개` (from `agentTools` or the children's count) + the state. Opening it for the first time calls `bridge.chat.agent(id, item.id)` once, then renders its `children` as `ToolRow`s and their texts as `.sub-result` prose.
- **`DiffBlock`** (lab `.edit`): a head with the file chip (→ `openFileFromChat`), counts `+{added}` in `--green` and `−{removed}` in `--red-text` (mono, `--t-meta`), and the kind word for create. The body shows the first 8 lines with a `{n}줄 더 보기` toggle. Lines are a grid `36px 16px minmax(0, 1fr)`; add rows on `--add-bg` with `--ink`, del rows on `--del-bg` with `--ink-2`; numbers in `--ink-3`. `hidden > 0` adds a last line `{n}줄은 터미널에서 보세요`. An Edit whose `diff` is null renders as a plain `ToolRow`.
- Strings (ko → en / ja), all in `src/locales/chat.ts`:
  - `파일 읽음` Read / 読み込み
  - `검색` Search / 検索
  - `파일 찾기` Find files / ファイル検索
  - `명령 실행` Ran a command / コマンド実行
  - `명령 실행 실패` Command failed / コマンド失敗
  - `명령을 멈췄어요` Command stopped / コマンドを停止
  - `파일 수정` Edited / 編集
  - `새 파일` New file / 新規ファイル
  - `파일 저장` Saved / 保存
  - `보조 에이전트` Sub-agent / サブエージェント
  - `웹 페이지 읽음` Read a web page / ウェブページを読み込み
  - `웹 검색` Web search / ウェブ検索
  - `할 일 정리` Updated to-dos / ToDo を整理
  - `질문` Question / 質問
  - `계획` Plan / 計画
  - `실행 중` Running / 実行中
  - `거절됨` Rejected / 拒否
  - `멈춤` Stopped / 停止
  - `답함` Answered / 回答済み
  - `터미널에서 답해 주세요` Answer it in the terminal / ターミナルで答えてください
  - `질문 · 터미널에서 답해 주세요` Question · answer it in the terminal / 質問・ターミナルで答えてください
  - `계획 · 터미널에서 답해 주세요` Plan · answer it in the terminal / 計画・ターミナルで答えてください
  - `터미널로 보기` Show terminal / ターミナルで見る
  - `파일 {n}개 읽음` Read {n} files / {n}個のファイルを読み込み
  - `검색 {n}회` {n} searches / 検索 {n}回
  - `도구 {n}개` {n} tools / ツール {n}個
  - `출력이 길어서 앞부분만 보여요 ({lines}줄)` Long output: showing the start ({lines} lines) / 出力が長いため先頭のみ表示({lines}行)
  - `{n}줄 더 보기` Show {n} more lines / あと{n}行表示
  - `{n}줄은 터미널에서 보세요` {n} more lines in the terminal / 残り{n}行はターミナルで

- [ ] **Step 1: Failing tests** (`tests/chat-tool-label.test.ts`):
  - every row of the table above, for items built from the fixtures
  - `groupLabel(3, 2)` in ko / en / ja (through `DICTS`)
  - every new key has en and ja
  - none of the new strings in any language matches `GAME`. Move the regex unchanged from `tests/work-mode.test.ts` into `tests/helpers.ts` as `GAME_WORDS`, and have both test files import it. Never import one test file from another: its suites would run twice.
  
  Run it: FAIL.
- [ ] **Step 2: Implement** the label module and the components. Run the suite, `tsc` and build: PASS (the components are not mounted yet).
- [ ] **Step 3: Commit:** `chat view: tool rows, read groups, diff blocks and the sub-agent group`.

### Task 14: `ChatView`: the list, turns, states, styles, harness surfaces

**Files:**
- Create: `src/chat/virtual.ts`, `src/components/ChatView.tsx`, `src/components/chat/ChatList.tsx`, `UserMessage.tsx`, `ChatBanner.tsx`, `src/styles/chat.css`, `tests/chat-virtual.test.ts`, `tests/visual/chatFixture.mjs`
- Modify: `src/styles/tokens.css` (+ `--read-w`, `--add-bg`, `--del-bg`), `tests/tokens.test.ts`, `src/locales/chat.ts`, `tests/visual/fake-bridge.js` (+ `chat`), `tests/visual/shots.mjs` (+ surfaces), `tests/visual/README.md`

**Interfaces:**
- **`virtual.ts`:**
  - `visibleRange({ heights: (number | undefined)[], estimate: number, scrollTop: number, viewport: number, overscan = 600 }): { start: number; end: number; padTop: number; padBottom: number }`, where an unmeasured row counts as `estimate`
  - `prependAnchor(oldHeights, newHeights, added: number): number`, the scrollTop delta that keeps the first visible row still when `added` rows arrive above it
  - `atBottom(scrollTop, scrollHeight, clientHeight, slack = 160): boolean`, the lab's 160px
- **`ChatView` props:** `{ term: TerminalInfo; who: { picture: 'pokemon' | 'glyph'; sprite?: string; name: string }; project: string; branch: string | null; onTerminal(): void; footer?: React.ReactNode }`. `who` comes from `chatWho(row, workMode)` in `src/chat/lensMode.ts`: in work mode it is `{ picture: 'glyph', name: t('에이전트') }`, otherwise the session's Pokémon sprite and name. It is tested against `GAME`.
- **Layout** (lab `.chat`, `.convo`, `.convo-inner`): a column on `--bg`, the scroller `.chat-scroll` (8px scrollbar, thumb white 8 %, `scrollbar-gutter: stable`, `tabIndex={-1}`, focused when the view opens), an inner column `max-width: var(--read-w)`, padding `28px 32px 20px` (16px sides under 900px wide), gap 10px.
  - `ChatList` measures each rendered row with one `ResizeObserver`, keeps heights by row key, renders `visibleRange` with top and bottom padding, sticks to the bottom while `atBottom` (new rows scroll into view), and keeps the scroll position per terminal in a module `Map` (restored on remount).
  - Near the top (`scrollTop < 400`) with `status.hasOlder`, it calls `bridge.chat.older(id)` once until the next update, and anchors with `prependAnchor`.
- **Rows:**
  - user (lab `.msg-user` / `.bubble`): right-aligned, max 78 %, `--card-2`, radius `--r-l`, prose `--t-prose`/1.6, `white-space: pre-wrap`; `이미지 {n}` as a hairline chip above when `images > 0`; the time under it in `--t-micro` `--ink-3`.
  - turn-head (lab `.turn-head`): a 22px picture box (the sprite, or in 업무 모드 the `TerminalIcon` glyph in the same box), the name `--w-name` `--ink-2`, `· {time}` `--ink-3`.
  - text: `.prose` via `<Markdown>`, `--t-prose`, line height 1.7; `partial` texts end with a quiet `(멈춤)`.
  - tool, group, agent and diff: Task 13. A tool row with `diff` renders `DiffBlock` in place of the row.
  - notice: one quiet line `--t-ui` `--ink-3`: `요청을 멈췄어요`, `{command} 실행`, `대화를 정리했어요`, `보조 에이전트가 끝났어요`, `여기서 보여 줄 수 없는 내용이 있어요 · 터미널로 보기`.
  - day: centred `--t-meta` `--ink-3`.
  - live: `.prose` in `--ink-2` with the label `작성 중` (`--t-micro`). There is no caret and no animation.
- **Working line** (lab `.status`), after the list:
  - 'working': the 22px picture box, `{name}{iga} 일하는 중 · {elapsed}` (elapsed from `since`, updated each second in a text node only; `label: 'compact'` → `{name}{iga} 대화를 정리하는 중 · {elapsed}`)
  - 'waiting': an amber dot and `{name}{iga} 허락을 기다려요 · 터미널에서 답해 주세요` + a `터미널로 보기` button
  - 'idle' / 'ended': nothing
  
  The right-hand slot for 멈추기 is reserved and empty. The line keeps a fixed min-height of 34px whether shown or not, so nothing jumps when work starts.
- **"새 메시지 N개" pill** (lab `.jump`): it shows when not `atBottom` and the unread count is > 0, centred 42px above the bottom of the scroller, at the lab's values except radius `--r-l` (calm: no 999px pills). Clicking it smooth-scrolls to the bottom and resets the count. It has `aria-live="polite"`.
- **Empty state** (`status.empty`, lab `.empty` without suggestions): the 96px picture box (64px glyph in 업무 모드, with the same box height so there is no jump), `{name}{iga} 기다리고 있어요` (the key exists), `project · branch` in `--t-meta`, and the hint `지시는 지금처럼 터미널이나 왼쪽 입력란에서 보내면 돼요. 대화가 여기에 보여요`. The suggested-prompts block is reserved and empty.
- **Banner** (lab `.banner`, `app.css` 632–638): sticky at the top of the view, `max-width: var(--read-w)`, an amber 38 % border, `--card`, radius `--r-l`. The icon, the title `이 세션을 채팅으로 읽지 못하고 있어요`, a reason line, a `터미널로 보기` button (solid `--ink` on `--accent-ink`, as the lab's `.btn.solid`) and `다시 읽기` (a hairline; it calls `bridge.chat.reload`). The conversation under it is at opacity 0.45. Reason lines (ko → en / ja):
  - `schema`: `세션 기록의 모양이 예상과 달라요. 작업은 터미널에서 그대로 진행 중이에요` → The session record doesn't look as expected. The work goes on in the terminal as usual. / セッション記録の形式が想定と違います。作業はターミナルでそのまま続いています。
  - `canary`: `방금 끝난 답이 세션 기록에서 보이지 않아요` → The answer that just finished isn't in the session record. / 今終わった回答がセッション記録に見当たりません。
  - `missing`: `세션 기록 파일을 찾지 못했어요` → Couldn't find the session record. / セッション記録が見つかりません。
  - `stalled`: `세션 기록이 30초 넘게 갱신되지 않아요` → The session record hasn't updated for over 30 seconds. / セッション記録が30秒以上更新されていません。
  - `rewrite`: `세션 기록이 다시 쓰였어요. 다시 읽으면 처음부터 맞춰 볼게요` → The session record was rewritten. Read again to start over. / セッション記録が書き換えられました。もう一度読むと最初から合わせます。
  - `version`: `이 Claude Code 버전({version})은 채팅 보기에서 확인하지 않았어요` → This Claude Code version ({version}) hasn't been checked with the chat view. / この Claude Code のバージョン({version})はチャット表示で確認していません。
  - `mapping`: `어느 세션의 기록인지 확실하지 않아요` → It isn't clear which session this record belongs to. / どのセッションの記録か確かではありません。
  - `worker`: `채팅을 읽는 부분이 멈췄어요` → The part that reads the chat stopped. / チャットを読む部分が停止しました。
  
  `note: 'new-version'` shows one quiet line under the session header: `확인하지 않은 Claude Code 버전({version})이에요. 이상하면 터미널로 보세요` → An unchecked Claude Code version ({version}). If something looks wrong, use the terminal. / 未確認の Claude Code バージョン({version})です。おかしければターミナルで見てください。
- **Other strings:**
  - `새 메시지 {n}개` → {n} new messages / 新しいメッセージ {n}件
  - `{name}{iga} 일하는 중 · {time}` → {name} is working · {time} / {name}が作業中 · {time}
  - `{name}{iga} 대화를 정리하는 중 · {time}` → {name} is compacting the conversation · {time} / {name}が会話を整理中 · {time}
  - `{name}{iga} 허락을 기다려요 · 터미널에서 답해 주세요` → {name} is waiting for permission · answer it in the terminal / {name}が許可を待っています・ターミナルで答えてください
  - `작성 중` → Writing… / 作成中
  - `(멈춤)` → (stopped) / (停止)
  - `이미지 {n}` → Image {n} / 画像 {n}
  - `에이전트` → Agent / エージェント
  - `요청을 멈췄어요` → Request interrupted / リクエストを中断しました
  - `{command} 실행` → Ran {command} / {command} を実行
  - `대화를 정리했어요` → Conversation compacted / 会話を整理しました
  - `보조 에이전트가 끝났어요` → A sub-agent finished / サブエージェントが完了しました
  - `여기서 보여 줄 수 없는 내용이 있어요` → Some content can't be shown here / ここでは表示できない内容があります
  - `다시 읽기` → Read again / もう一度読む
  - `이 세션을 채팅으로 읽지 못하고 있어요` → Can't read this session as chat right now / このセッションをチャットとして読み取れていません
  - `지시는 지금처럼 …` → "Send instructions as you do now, in the terminal or the box on the left. The conversation shows here." / "指示はこれまでどおりターミナルか左の入力欄から送れます。会話はここに表示されます。"
  - `이전 대화 불러오는 중…` → Loading earlier messages… / 以前の会話を読み込み中…
- **Tokens:** add to `:root` in `tokens.css`: `--read-w: 840px; --add-bg: rgba(116, 214, 139, 0.07); --del-bg: rgba(255, 100, 100, 0.07);` (the lab's 차분하게 2 block).
- **Harness:**
  - `chatFixture.mjs` builds, through `createRequire(import.meta.url)('../../electron/chatItems.cjs')`, a `reset` per fixture conversation: `chat` (basic + tools + a long markdown answer in the lab's shape: heading, paragraph with code and a file path, a 4-row table, a numbered list, a code block, a link), `chat-long` (2000 items, repeated), `chat-tools`, `chat-diff`, `chat-failed`, `chat-agent`, `chat-stream` (status working + a live item), `chat-waiting` (a `waiting: 'permission'` row + status waiting), `chat-banner` (banner `canary`), `chat-empty`.
  - The fake bridge: `chat.open(id)` records the call and dispatches `shot.chat[id]` to the `onUpdate` listeners on the next tick. `older`, `reload`, `agent` and `close` record calls. `window.__CHAT_PUSH__(id, ops)` dispatches the next rev.
  - Surfaces: the session view with the first fixture terminal `chat: 'armed'` and `spawn-carry` `chatModes: { <id>: 'chat' }`, one surface per fixture name above. `chat` and `chat-banner` are added to `WORK` and `chat` to `MAC`. `--text small|xlarge` and `--lang en|ja` already exist.

- [ ] **Step 1: Failing tests:**
  - `tests/chat-virtual.test.ts`:
    - 1000 rows of 40px, scrollTop 20 000, viewport 800 → start/end around rows 485–535 with the right padding
    - unmeasured rows use the estimate
    - `prependAnchor` keeps the first visible row's offset
    - `atBottom` with 159 vs 161 px left
  - `tests/tokens.test.ts`: the three new tokens' values; `--ink` on `--term-bg` composited with `--add-bg` ≥ 4.5; `--ink-2` on `--term-bg` + `--del-bg` ≥ 3
  - a source check that `chat.css` has no `var(` inside `font-family`, no `#f2c94c` or `var(--accent)` (no yellow in Phase 2), only weights 380/400/500/600 (600 only in `.prose h1–h4`), only radii from the tokens, no `animation`, and every `font-size` a `var(--t-…)` or `calc(var(--t-…)…)`
  - `chatWho` in work mode does not match `GAME`
  
  Run them: FAIL.
- [ ] **Step 2: Implement** `virtual.ts`, the components and `chat.css` (imported only by `ChatView.tsx`), then the fixture, the bridge and the surface definitions. The session-view shots of those surfaces are taken in Task 15, once `Widget.tsx` mounts the view. `ChatView` takes an optional `state?: ChatState` prop that bypasses `useChat` (for the QA page only). This task's visual check is a new section "채팅" in `src/QaPage.tsx`, which renders `ChatView` with a static `ChatState` (a small inline items array, no bridge), plus one banner variant and one empty variant.
- [ ] **Step 3: Run** the suite, `tsc` and build: PASS. Visual steps for `qa` (the 채팅 section) against `s2-chat-detail.png`, `app.css` 159–335 and 632–654. Checklist:
  - the user bubble is right-aligned on `--card-2`
  - the turn head carries the picture once
  - the table, list, code with 복사 and the link are underlined grey
  - the tool rows are one line each
  - the read group reads `파일 3개 읽음` / `검색 2회`
  - the diff shows `+4 −1` with tinted rows
  - the failed row is red
  - the waiting row is amber with 터미널로 보기
  - the pill is centred above the bottom
  - the banner is amber-edged with the conversation dimmed
  - the empty state shows no suggestions
  - nothing is yellow
- [ ] **Step 4: Commit:** `chat view: the conversation view — virtual list, turns, working line, live bubble, pill, empty state and banner`.

### Task 15: The 채팅 / 터미널 flip; `Widget.tsx` wiring; flows

**Files:**
- Create: `src/chat/lensMode.ts` (if not yet, with `chatWho` and `openFileFromChat` from Tasks 12 and 14), `tests/chat-lens-mode.test.ts`
- Modify: `src/components/SessionHeader.tsx`, `src/Widget.tsx`, `src/carry.ts`, `src/styles/widget-expanded.css` (the flip's rules beside `.w-sess-head*`), `src/locales/chat.ts`, `tests/visual/shots.mjs` (flows), `tests/visual/README.md`

**Interfaces:**
- **`lensMode.ts`:**
  - `lensAvailability(term: TerminalInfo | undefined, mode: 'widget' | 'window' | 'fullscreen'): { show: boolean; enabled: boolean; reason: null | 'unarmed' | 'version' | 'starting' }`. `show` is `term?.chat !== undefined && mode !== 'widget'`. `enabled` is `term.chat === 'armed'`. The reason is otherwise the `chat` value.
  - `readLensMode(id): 'chat' | 'terminal'` (carry `chatModes[id]`, default `'terminal'`) and `writeLensMode(id, m)` (prunes to the 24 most recent).
  - `effectiveMode(term, mode, stored)` is `'chat'` only when available and enabled and stored `'chat'`.
- **`SessionHeader`** gets an optional `lens?: { mode: 'chat' | 'terminal'; enabled: boolean; reason: string | null; onMode(m: 'chat' | 'terminal'): void }`. With it absent the markup is unchanged (a test renders the component with `react-dom/server` `renderToStaticMarkup` without `lens` and compares it with the markup before this task, captured in Step 1).
  - With it present, a `role="group"` `aria-label={t('보기 방식')}` segmented pair sits before the ×: `채팅` (a chat-bubble icon) and `터미널` (`TerminalIcon`), each with `aria-pressed`, `--t-ui`/400, `--ink-3`, padding `4px 8px`, radius `--r-s`, hover `var(--hover)`, the chosen one on `var(--sel-bg)` with `--ink`, a hairline box around the pair, a height ≥ 24px, and `-webkit-app-region: no-drag`.
  - When `enabled` is false, `채팅` is `aria-disabled` and its `title` is the reason:
    - `unarmed` → `이 세션은 채팅 보기를 켜기 전에 열렸어요. 다시 열면 채팅으로 볼 수 있어요` (This session was opened before the chat view was on. Reopen it to see it as chat. / このセッションはチャット表示をオンにする前に開かれました。開き直すとチャットで見られます。)
    - `version` → `이 Claude Code 버전에서는 아직 채팅 보기를 쓸 수 없어요` (The chat view isn't available for this Claude Code version yet. / この Claude Code のバージョンではまだチャット表示を使えません。)
    - `starting` → `채팅 보기를 준비하는 중이에요` (Getting the chat view ready… / チャット表示を準備中…)
  - Strings: `채팅` Chat / チャット · `터미널` (existing key, or add Terminal / ターミナル) · `보기 방식` View / 表示方法.
- **`Widget.tsx`:**
  - `const lensMode = effectiveMode(shown?.terminal, mode, readLensMode(shown.sessionId))`, kept in state and updated by `onMode` (`writeLensMode`).
  - `SessionHeader` gets `lens` only when `lensAvailability(...).show`.
  - `TerminalView active={view === 'terminal' && shown?.sessionId === r.sessionId && !(r === shown && lensMode === 'chat')}`. Every TerminalView stays mounted exactly as today.
  - When `lensMode === 'chat'` and `view === 'terminal'`, a lazy `<ChatView …/>` renders for `shown` inside `.w-term-body` (a sibling of the terminals, absolutely filling it). `onTerminal` = `onMode('terminal')`.
  - When `shown.terminal.chat` disappears (the feature turned off) or the session closes, the effective mode becomes terminal and the ChatView unmounts. Its `useChat` unsubscribe sends `chat:close`.
- No keyboard shortcut is added. The app's capture-phase handler is not changed.

- [ ] **Step 1: Failing tests** (`tests/chat-lens-mode.test.ts`):
  - `lensAvailability`: no `chat` key → `show: false`; widget mode → `show: false`; `'armed'` → enabled; `'unarmed'` → show, not enabled, reason
  - `effectiveMode` never returns `chat` for a shell or an unarmed terminal
  - `readLensMode` defaults to terminal, and the carry prunes at 24
  - the `SessionHeader` static markup without `lens` equals the captured string. Use `react-dom/server` `renderToStaticMarkup`, and capture the string before editing the component. If `t()` needs the settings store in node, `vi.mock('../src/i18n', () => ({ t: (k: string) => k }))`.
  - a source check that `Widget.tsx` still imports `TerminalView` the same way and renders one `TerminalView` per terminal regardless of `lensMode`
  
  Run it: FAIL.
- [ ] **Step 2: Implement.** Run the suite, `tsc` and build: PASS.
- [ ] **Step 3: Flows in `shots.mjs`:**
  - `--flow chat-flip`:
    1. Open `session` with terminal 1 armed and its fake transcript of 200 lines. Scroll its xterm viewport to the middle and record `.xterm-viewport.scrollTop` and the count of `.xterm` elements.
    2. Click `채팅`: the ChatView is visible, `__CALLS__` has `chat.open` with id 1 and no `close`/`create`/`write`, and the `.xterm` count is unchanged.
    3. Push terminal data through the fake `onData` while in chat.
    4. Click `터미널`: the same xterm element is visible again, `scrollTop` equals the recorded value (or is at the bottom when the pushed data moved it, as today's session switch does: assert the same rule as switching to session 2 and back), the pushed text is present in the buffer, and focus is inside the terminal (`document.activeElement.closest('.term-view')`).
    5. Switch to session 2 and back: terminal mode is kept per session. Reload the page: the mode for terminal 1 is restored from carry.
  - `--flow chat-banner`: open `chat-banner`. The banner is visible and the conversation has opacity 0.45. Click `다시 읽기` → `chat.reload` is called once. Click `터미널로 보기` → the terminal is active and the header shows 터미널 pressed. 
  - `--flow chat-unarmed`: terminal 2 `chat: 'unarmed'` → `채팅` is `aria-disabled` with the reason title, and clicking it changes nothing.
  - `--flow chat-off`: terminals with no `chat` key → no `[aria-label="보기 방식"]` in the document, and the `session` shot equals the Task 1 shot pixel for pixel. The session view is unchanged when off.
- [ ] **Step 4: Visual steps** for `chat`, `chat-tools`, `chat-diff`, `chat-failed`, `chat-agent`, `chat-stream`, `chat-waiting`, `chat-banner`, `chat-empty` at 1440×900 and 1100×720, with `--check fit`. Checklist against `s2-chat-detail.png`: the reading column is 840px max and centred; the header shows `채팅 · 터미널` with 채팅 pressed in grey; the rest is as Task 14's list.
- [ ] **Step 5: Commit:** `chat view: the 채팅 / 터미널 flip in the session header; the terminal stays mounted`.

### Task 16: Long sessions: older pages, the item cap, performance checks

**Files:**
- Modify: `src/components/chat/ChatList.tsx`, `src/chat/store.ts` (the cap on the page is already in Task 11; here the older-load glue), `electron/chatLens.cjs` (`older`: `readOlder` + builder + `upsert`; `hasOlder`), `tests/chat-lens.test.ts`, `tests/visual/shots.mjs` (`--flow chat-long`), `tests/visual/chatFixture.mjs`

- [ ] **Step 1: Failing tests.**
  - `chat-lens.test.ts`: a 20 000-turn synthetic transcript (≈ 60 MB, built in tmp from fixture lines with fresh uuids and offsets).
    - `open` sends a `reset` with ≤ 150 renderable items and `hasOlder: true`, reading ≤ 16 MB (counting fs)
    - three `older` calls each add ≤ 150 items, all with smaller `order`s, and no duplicate ids
    - a tool_result whose tool_use is only in the next older page becomes one item after that page loads
    - memory: after `close` + 60 s (fake timers) the terminal's items map is empty
  - the harness `--flow chat-long` on `chat-long` (2000 items):
    - the number of `.chat-row` elements in the DOM is ≤ 300 at the bottom, in the middle (scrolled) and at the top
    - scrolling to the top calls `chat.older` exactly once until the next push
    - pushing 150 older items with `__CHAT_PUSH__` keeps the first visible row within 2px of where it was
    - pushing 3 new items at the end while scrolled up shows `새 메시지 3개`, and clicking it lands at the bottom with the pill gone
    - frame time: `performance.now()` around 30 scroll steps of 400px stays under 16 ms on average (report the number; fail only above 50 ms)
  
  Run them: FAIL where not implemented.
- [ ] **Step 2: Implement** the older paging in the lens and the list. Run the tests and the flow: PASS.
- [ ] **Step 3: Commit:** `chat view: long sessions — older pages on demand, a capped page, measured`.

### Task 17: Sweep: 업무 모드, text sizes, en / ja, Mac, accessibility, guards

**Files:**
- Modify: whatever the sweep finds in `src/styles/chat.css`, `src/components/chat/*`, `src/locales/chat.ts`
- Test: `tests/work-mode.test.ts`, `tests/chat-ui.test.ts` (new: guards), `tests/mac-window.test.ts`

- [ ] **Step 1: Guards (failing first):**
  - `tests/chat-ui.test.ts`:
    - (a) no file in `electron/chat*.cjs`, `src/chat/`, `src/components/chat/` or `src/components/ChatView.tsx` contains `terminals.write`, `terminals.send`, `sendInstruction`, `.write(` on a pty, `'/model`, `'/config` or `settings.json`
    - (b) `electron/chat*.cjs` never names `.credentials`, `settings.json` or `oauth`
    - (c) no `dangerouslySetInnerHTML`, `innerHTML` or `eval(` (repeating Task 12's guard over the whole set)
    - (d) every key in `src/locales/chat.ts` en has a ja and the reverse
    
    The untouched files are checked by a command, not a permanent test, because main keeps being merged into this branch. Run `git diff --exit-code <base> -- src/components/TerminalPanel.tsx src/keys.ts src/termFont.ts src/textSize.ts server hooks scripts electron/updater.cjs electron/updateRunner.cjs package.json package-lock.json`. The base is `cff52ac`, or the last merged main commit if main was merged since. It must print nothing.
  - `tests/work-mode.test.ts`: no string in `src/locales/chat.ts` (ko key, en, ja) matches `GAME_WORDS`. Every chat string can show in 업무 모드, so all of them must be neutral; the Pokémon's name enters only through `{name}`.
  - `tests/mac-window.test.ts`: the flip's selector carries `-webkit-app-region: no-drag`.
- [ ] **Step 2: Run them.** Fix what they find.
- [ ] **Step 3: Harness sweep:**
  - `node tests/visual/shots.mjs --only chat,chat-work,chat-banner,chat-banner-work,chat-empty,chat-mac --check fit --check work`
  - the same with `--text small` and `--text xlarge`, each at 1100×720 (compare with `s2-size-smallest-chat.png` / `s2-size-largest-chat.png`)
  - `--lang en` and `--lang ja` for `chat`, `chat-banner`, `chat-waiting`, `chat-empty`, with `--check fit` (no clipped label in the flip, the banner buttons, the tool rows' meta, the pill)
  - `--flow hit-areas`, extended to measure the flip's two buttons, the tool row heads, the group heads, the 복사 buttons, the pill and the banner buttons: each ≥ 22px in both directions
  - `--flow keyboard`, extended: Tab reaches the flip, Enter flips, and Tab inside the chat reaches the tool rows (they are `<button>`s with `aria-expanded`) and the links; the banner is `role="status"`; the pill `aria-live="polite"`
- [ ] **Step 4: Run everything:** the suite, `tsc`, build, all chat flows and checks, and the `git diff --exit-code` command from Step 1.
- [ ] **Step 5: Commit:** `test: guards for the chat lens (sends nothing, reads no credentials, no HTML), work mode, sizes, languages`.

### Task 18: The flag on for the test build; hand-off; insight log; final QA

**Files:**
- Modify: `electron/features.json` (`"chatView": true`; the setting stays off by default), `tests/features.test.ts` (expect `true`), `CHANGELOG.md` (an "Unreleased" entry in the file's style), `docs/HANDOFF.md` (a short section)

- [ ] **Step 1: The full run:**
  - `npx vitest run && npx tsc --noEmit -p . && npx vite build`
  - `node tests/visual/shots.mjs --out "~/Documents/spawn-portfolio/_inbox/chat-2/18-final/" --only chat,chat-long,chat-tools,chat-diff,chat-failed,chat-agent,chat-stream,chat-waiting,chat-banner,chat-empty,chat-work,chat-mac,session,settings --check fit --check work --flow chat-flip --flow chat-banner --flow chat-unarmed --flow chat-off --flow chat-long --flow tabs-gone --flow text-size`
  - read every shot, and write `NOTES.txt` beside them: per surface, "matches" or the difference with its reason
  - the `settings` shot now shows the 채팅으로 보기 row, off
- [ ] **Step 2: Off is still 1.4.0.** With the setting off: `--flow chat-off` passes, and the `session-settings.json` test from Task 9 passes.
- [ ] **Step 3: Insight log.** Use the `insight-log` skill: one entry (the lens over a real terminal, not a re-implementation; the canary and banner as the answer to "wrong conversation is the worst failure") with the before shot (`session`) and the after shots (`chat`, `chat-banner`), and the screen archive into `~/Documents/spawn-portfolio`.
- [ ] **Step 4: Hand-off notes** in `docs/HANDOFF.md`:
  - **(a)** What only a real build can show. The owner should try these with the setting on:
    - a real Claude Code session of a few turns, with tools and an edit
    - `/clear`, then a new prompt (the view follows the new file)
    - reopening the app (sessions restore armed)
    - a resumed session from 이어하기
    - a sub-agent
    - Esc during an answer
    - a permission prompt (the chat says 터미널에서 답해 주세요, and the terminal dialog works as before)
    - a long existing session (open it in chat: the tail shows first, scrolling up loads more, the app stays responsive)
    - turning the setting off mid-session (the terminal keeps working; no hook errors appear in the TUI; the endpoint closes after that session ends)
    - the Korean IME in the terminal after flipping chat → terminal several times
    - the side panel's send box while the chat is open
    - a Mac
  - **(b)** What is version-fragile and where it is contained (copy "Risks" below).
  - **(c)** Phase 3 starts at the seams listed in the plan.
- [ ] **Step 5: Commit:** `chat view: on in features.json for the test build (the setting stays off); changelog and hand-off`. Report to the controller that Phase 2 is ready for a local test build. Do not build an installer, do not push.

---

## Decisions made in this plan (owner may overrule)

1. **Hooks via the generated `--settings` file only** (the same `writeSessionSettings` the game uses), as separate matcher groups appended after the game's. They are rewritten from the setting on every start and on every toggle, which makes them idempotent, survives updates (nothing stale persists), and removes them when off. `~/.claude/settings.json` is never touched.
2. **The token is in the URL path**, not a header. The HTTP-hook header auth was not tested, and an unknown key (`headers`, `allowedEnvVars`) could make Claude Code reject the whole settings file, the game's hooks included. The token is per app run and lives in the user's own app-data file.
3. **Terminal ↔ conversation mapping** uses the terminal id, the game hook's `session-links` file, and nothing else. It never uses the folder. Ambiguity → banner.
4. **Sessions opened before the setting was turned on are not armed** (the flip says why). Whether Claude Code hot-reloads a changed `--settings` file is unknown, so the plan never relies on it. While on, `terminals:create` waits up to 3 s for the host so that restored sessions start armed.
5. **Version gate before arming:** chat entries are written only when `claude --version` is in `2.1.323 ≤ v < 2.2.0` (verified) or newer (`new`: armed, with a quiet note and the canary as the safety net). Older or unreadable versions are never armed. The transcript's own `version` field is checked again per session.
6. **Turning off at runtime drains:** new sessions get no entries at once and the worker stops at once, but the endpoint keeps answering 200 until the last armed session exits. Whether a dead endpoint shows hook errors in the TUI is untested, and this keeps the owner's running sessions clean.
7. **A worker thread** does all reading and parsing, so the main process cannot be blocked by a big transcript. The endpoint stays in main and answers before dispatching, so a stalled or crashed worker never delays Claude Code.
8. **Own markdown renderer, no dependency** (Task 12). There is no syntax colouring in Phase 2 (calm; a seam via `lang`), and remote images are never loaded (privacy).
9. **Passive `PermissionRequest`, `AskUserQuestion`, `ExitPlanMode`:** shown read-only with "터미널에서 답해 주세요" and 터미널로 보기, never collapsed, never held.
10. **Nothing new animates** (no caret blink, no Pokémon bob), consistent with Phase 1. The pill uses radius `--r-l`, not the lab's 999px.
11. **No keyboard shortcut for the flip** in Phase 2, so the key map stays exactly as it is.
12. **Widget mode never shows the chat.**
13. **Image thumbnails are deferred to Phase 3:** a user message shows `이미지 n` only. No base64 crosses IPC.
14. **`settings.json` gains `session.chatView: false`** when saved. That is the only trace of the feature when off. A stored preference is needed, and splitting the defaults by flag would add a code path for nothing.
15. **`features.json` `chatView` stays false until Task 18,** then true for the owner's test build, with the setting off by default. The development overrides `SPAWN_CHAT_VIEW` / `VITE_SPAWN_CHAT_VIEW` exist for tests and the harness only.

## Risks: what from FINDINGS.md is version-fragile, and how the plan contains it

| Fragile (FINDINGS) | Containment |
|---|---|
| The transcript format is internal, noisy and large (§1, risk 1) | `checkLine` on every kept line; hard problems → banner `schema`; soft problems counted with a 50 % threshold; unknown blocks shown as a notice; the canary on every turn; tail-first reading with noise skipped unparsed (Tasks 3, 6, 8) |
| One line per content block; `message.id` shared; thinking empty | The builder keys items by line `uuid` (+ block index), never by `message.id` (Task 4) |
| Append-only (observed over ~500 KB) | Head and edge hashes per read; a rewrite → banner `rewrite`, nothing more read until 다시 읽기 (Task 6) |
| `/clear` makes a new id and file; resume behaviour not fully known | The hook's `transcript_path` is preferred (allowed only under `projects/`); the link file; ambiguity → banner `mapping`; `missing` after 5 s (Tasks 7, 8) |
| `MessageDisplay` batching, `message_id` not matching the transcript, no `final` after Esc | Matching by text prefix within the turn, never by id; the bubble is cosmetic and always replaced or left under a banner; the endpoint answers at once with a 3 s timeout (Tasks 7, 9) |
| `PermissionRequest` has no `tool_use_id` | `callKey` from the game hook pairs it; no match → status only, never a guessed row (Task 7) |
| HTTP hooks and new events (`MessageDisplay`) exist only in recent versions; the HTTP header auth and a dead endpoint are untested | Version gate before arming; token in the path; no unknown keys in entries; drain instead of closing while armed sessions run (Tasks 9, 10) |
| Edit/Write payloads verified, MultiEdit and Write-over-existing not | `buildDiff` returns null for any shape it does not recognise: no counts, never invented (Task 5) |
| Sub-agent files and the `async_launched` result | `agentId` from the result or a unique `SubagentStart` only; sidechain path allowed-checked; nothing on doubt (Task 8) |
| The interrupt and queue wording (`[Request interrupted by user`) | Matched by prefix; a turn that never ends falls back to the transcript's `turn_duration` / a later prompt; the canary is not armed after Esc (Tasks 4, 8) |
| Hook payload fields change | Each body checked for the fields used; missing fields → the event ignored (the transcript still drives the view, the canary still guards) (Task 7) |

Other risks: a fixture missing a real shape (mitigated by keeping every key from the samples and by the soft-unknown counters; the owner's test build is the real check), and `fs.watch` flakiness on network drives (the stat poll is always on while open).

## Self-review notes

**Spec coverage (Phase 2 and the owner's brief → task):**
- transcript tailer → 6, 7, 16
- chat hook endpoint (127.0.0.1, token, not through `server/`) → 9, 10
- IPC → 10
- user messages → 4, 14
- assistant prose as safe markdown (tables, lists, headings, code with copy, links) → 12
- collapsed tool rows (running → done from hooks, grouped reads/searches, failed rows, nested sub-agent group) → 4, 7, 8, 11, 13
- diff blocks with `+N −N` → 5, 13
- provisional streaming bubble → 7, 14
- working state → 7, 14
- "새 메시지 N개" pill → 11, 14, 16
- empty state → 14
- read-failed banner with 터미널로 보기 (schema checks, canary, supported version) → 3, 8, 10, 14, 15
- the flip with the terminal kept mounted → 15
- off = 1.4.0 → 1, 9, 10, 15 (`chat-off`)
- Claude only → 9, 15
- no config commands, no credentials → 7, 17
- hooks added and removed by the game's installer, idempotent, surviving updates → 9
- long sessions → 6, 10, 16
- work mode → 13, 14, 17
- text size → 14, 17
- Mac → 2 (fixture), 14 (surface), 17
- ko/en/ja → each task's strings, 17
- tests as listed in the brief → 2–17

**Not mapped, on purpose:** everything in "Out of scope" (Phases 3–5), with the seams named above. The spec's density levels, find and turn summary are Phase 5. The default view setting is Phase 6.

**Type consistency check:**
- the `ChatItem`/`ChatOp`/`ChatUpdate`/`LensStatus` names are the same in `src/chat/types.ts` (Task 11), the JSDoc in `electron/chatItems.cjs` / `chatLens.cjs` (Tasks 4, 7), the store (11), the rows (11) and the harness fixture (14)
- `TerminalInfo.chat` values `'armed' | 'unarmed' | 'version' | 'starting'` are produced in Task 9 (`info`), typed in Task 10, and consumed in Task 15 (`lensAvailability`)
- the IPC names in the table are the ones in `preload.cjs` (10), `chatHost.registerIpc` (10), `store.ts` (11) and the fake bridge (14)
- `CAPS` (Task 4) is the only source of limits
- `LIVE_BASE` / `LIVE_ORDER` are used by the lens (7) and assumed by the store's sort (11)
- `callKey` is required from `hooks/spawn-hook.cjs` unchanged (7, 10)

**Judgment calls a reviewer should know:** the worker thread (Decision 7), the own markdown parser (8), not arming pre-existing sessions (4), and draining instead of closing (6). The QA-page section in Task 14 exists so that the view can be checked before it is wired. The flag stays false until the last task, so every intermediate commit is a 1.4.0-equivalent app.

**Open questions for the owner (none blocks Tasks 1–13):**
1. Accept `2.1.323 ≤ v < 2.2.0` as "verified", with newer versions armed under a quiet note? Or should newer versions stay unarmed until re-verified with the spike scripts?
2. Sessions opened before turning the setting on cannot be shown as chat until reopened. Acceptable for the preview?
3. No keyboard shortcut for 채팅 / 터미널 in this phase. Want one (and which key) for Phase 3?
