# Remove the Party Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The party goes. Every caught Pokémon lives in one collection (the 박스). A session goes out with any resting Pokémon, picked from a searchable recent-first list. There is no session limit. A session that opens while nobody rests gets the next Pokémon to rest. Saves and cloud copies from 1.5.4 keep working both ways.

**Architecture:** The server (`server/pokedex.js`) owns the rule. On load and on a synced game it folds `state.party` into the front of `state.box` and leaves `party: []` in the save. It stamps `mon.outAt` whenever a Pokémon goes out with a session, and it picks "the resting one that went out most recently" in one function. It keeps a per-run queue of Pokémon-less open sessions and hands them Pokémon as they come free. The page learns all of this from the existing `pokedex` broadcast. The page mirrors the same ordering in a small pure module (`src/resting.ts`) that the pickers, 업무 모드's `autoPartner` and 랭킹 use. The cloud merge (`server/merge.js`) stops keeping a party and keeps every individual in the box, under a cap that leaves room for a folded 1.5.4 party.

**Tech Stack:** Node ESM server (express), React 18 + TypeScript + Vite page, Electron main (CommonJS), vitest (node, `renderToStaticMarkup` for components, source checks), the harness `tests/visual/shots.mjs`.

**Spec:** `docs/superpowers/specs/2026-11-16-remove-party-design.md`. Its "Decided" and "Calls made in the plan's place" sections override its earlier lines: one collection, the resume shortcut kept, sub-agent helpers kept, past release notes untouched.

## Global Constraints

- Work on a branch `remove-party` made from `main` at this plan's commit. Never push, never merge, never release, never deploy the intro site. The owner runs the release command and says when the site goes up.
- **Never delete user data.** No path may drop an individual from `state.mons`, except the existing `release()` and the existing professor overflow in the merge (whose cap this plan raises). A 1.5.4 save, a 1.5.4 cloud copy, and a 1.6.0 save read by 1.5.4 all keep every Pokémon.
- **Saves stay compatible.** The `party` key stays in the save (always `[]` once 1.6.0 has loaded it) and in `merge.js`'s `HANDLED`. `/pokedex/exchange`, the `game:exchange` IPC, `preload.cjs` `exchange` and its `desktop.ts` type stay; nothing on the page calls them.
- **Sub-agent helpers stay as they are:** `helperFor`, `helpingUids`, `publicState().helpers`, the row's `.w-row-helpers` pictures and their `'조력자'` / `'서브에이전트를 돕는 조력자 (박스에서 나와요)'` titles. What goes is the other "helper": a session worked by a box Pokémon because the party was all out (`isHelperSession`, `helperSession` / `helperMark`, `.w-row-helper`, `HelperIcon`, its tooltip `'파티가 모두 일하는 중이라 박스의 포켓몬이 이 세션을 맡았어요'`).
- **Change only what was asked.** The look of every surface stays. Only the party's parts go, and the pickers' content changes. The `.w-party` class on the side panel's session-list card is kept: it is internal, and the harness selects `.w-party .w-row` in dozens of places. `MAX_SHELLS = 3` stays.
- **업무 모드:** no Pokémon picture, name or word anywhere it does not show one today. The Pokémon-less note is not shown in 업무 모드, and neither is any note about assignment. A Pokémon-less row looks exactly like a 업무 모드 row (the same `TerminalIcon` glyph).
- **ko / en / ja for every new string.** Korean keys go in `src/locales/widget.ts` or `src/locales/dex.ts` with `en` and `ja` values. A key no longer used anywhere is deleted from all three tables.
- Code, comments and commit messages are in English. Every commit message ends with the line `Claude-Session: https://claude.ai/code/session_01LECh1AuSxY28Be3QgsqBWD`.
- **This PC is low on memory.** Run single test files while working (`npx vitest run tests/<file>`). Run the whole suite once before each commit (`npx vitest run`; add `--maxWorkers=2` if the machine struggles). Run the harness in small batches: at most 3 surfaces per `--only`, and one `--flow` per run. Build once before a batch with `npx vite build`.
- Green before every commit: the task's own tests, `npx vitest run`, `npx tsc --noEmit -p .`. UI tasks also run `npx vite build` and the harness batches they name.

## Review Focus

1. **A Pokémon is lost or duplicated by the fold or a sync.** Cases: a 1.5.4 save with a party; a 1.5.4 cloud copy with a different PC's party; a full box (1200) plus a party of six; a fold run twice. Expected: every individual is in `box` exactly once, `party` is `[]`, nothing goes to the professor below `BOX_LIMIT + LEGACY_PARTY_SIZE`. Tests: Task 2 (fold on load and on `importState`, idempotent) and Task 4 (merge with a 1.5.4 copy, full-box edge).
2. **Two sessions share one Pokémon.** Cases: a resumed session whose remembered Pokémon works elsewhere; auto-assign racing a throw; the restore loop at start. Expected: a Pokémon works one session at a time, and the second session takes another one or waits. Tests: Task 2 (`ensureAssigned` with a remembered busy one), Task 3 (auto-assign skips a held throw), Task 7 (restore loop source check).
3. **A Pokémon-less session meets or catches something**, including steps it queued while Pokémon-less that fire after it gets one. Expected: no attendance, no wild encounter, no catch, no step queued while it has none. Test: Task 3.
4. **업무 모드 shows a Pokémon word through the new paths**: the Pokémon-less note, the auto-assigned sendout, the picker. Expected: no note, no picker, the glyph, and in 업무 모드 the row stays the same after auto-assign. Tests: Task 5 (`sessionRowParts` with `noPokemon` in both modes, `chatWho`) and Task 7 (`--check work` on `session-nomon-work`).
5. **The picker is slow or misses a name with 1,200 resting Pokémon, or in en/ja.** Expected: the first paint is at most `PICKER_PAGE` (120) cells, and the search matches the shown language's name and the dex number. Test: Task 6.

---

### Task 1: Timing tests that hold on the slow CI runner

Independent of the rest. The macos-15-intel runner (runs 43794277351, 43802524163) failed these:

| Test | CI result |
|---|---|
| findMatches, "rivers" **cold incl. rows** | 177 / 216 ms vs `budget(40)` = 160 (warm was 3.4 ms) |
| M10 growth | ×8.7 vs 8 (small input only 2.5 ms) |
| chat-tail 64 MB, worst stall | 107 / 130 ms vs 100 |
| chat-hooks "answers first" | 77 ms vs 50 |
| link-fetch br bomb | RSS growth vs 50 MB |

Local numbers stay exactly as strict as today. Only the CI branch of each check widens.

**Files:**
- Modify: `tests/timing.ts`
- Modify: `tests/chat-perf.test.ts:46-60`, `tests/chat-review-fixes.test.ts:66-78`, `tests/chat-tail.test.ts:197`, `tests/chat-hooks.test.ts:117-137`, `tests/link-fetch.test.ts:757-771`
- Test: `tests/timing.test.ts` (new)

**Interfaces:**
- Produces in `tests/timing.ts`:
  - `growthLimit(): number`: `GROWTH_LINEAR` when `STRICT`, else `GROWTH_LINEAR * 1.5` (12). This is still below quadratic's ×16.
  - `memoryBudget(bytes: number): number`: `bytes` when `STRICT`, else `bytes * CI_SLOWDOWN`.
  - Existing `budget`, `growth`, `STRICT`, `CI_SLOWDOWN` unchanged.

- [ ] **Step 1: Write the failing test** `tests/timing.test.ts`. Re-import the module with `vi.resetModules()` and `process.env` set as each case needs:
  - `CI` unset → `budget(40) === 40`, `growthLimit() === 8`, `memoryBudget(50 << 20) === 50 << 20`.
  - `CI=true` → `budget(40) === 160`, `growthLimit() === 12`, `memoryBudget(50 << 20) === 200 << 20`.
  - `CI=true`, `SPAWN_PERF=1` → strict values again.
  - `growthLimit()` is below 16 in every case.
- [ ] **Step 2: Run** `npx vitest run tests/timing.test.ts`. Expected: FAIL (`growthLimit` is not exported).
- [ ] **Step 3: Add `growthLimit` and `memoryBudget`** to `tests/timing.ts`. Explain each in its doc comment next to `budget`'s.
- [ ] **Step 4: Use them.**
  - `chat-perf`: warm stays `budget(40)`. Cold is `STRICT ? 40 : budget(25) + budget(40)` (the cold run includes `buildRows`, whose budget is 25). Comment why, and say what the console line prints.
  - `chat-review-fixes` M10: `toBeLessThan(growthLimit())`, keeping the `g.large < 1000` cap.
  - `chat-tail`: `expect(worst).toBeLessThan(budget(100))`.
  - `chat-hooks`: `toBeLessThan(budget(50))`. Comment that the handler blocks 500 ms, so 200 ms still proves the post is answered first.
  - `link-fetch`: `toBeLessThan(memoryBudget(50 << 20))`. Comment that the bomb is 1 GB inside, so 200 MB still proves the inflater stopped.
  - Rename the `it(...)` titles only where they state a number that is now CI-dependent, by adding "(×4 on CI)", as chat-perf's header comment already explains.
- [ ] **Step 5: Run** `npx vitest run tests/timing.test.ts tests/chat-perf.test.ts tests/chat-review-fixes.test.ts tests/chat-tail.test.ts tests/chat-hooks.test.ts tests/link-fetch.test.ts`, then again with `CI=true` set in Git Bash. Expected: PASS both times. Then run `npx vitest run` and `npx tsc --noEmit -p .`.
- [ ] **Step 6: Commit** `test: timing budgets that hold on the slow CI runner, strict locally`.

---

### Task 2: Server: one collection, no limit, "most recently out" rule

**Files:**
- Modify: `server/pokedex.js`: header comment 1-21, `PARTY_SIZE`/`SESSION_LIMIT` 34-40, `BOX_LIMIT` comment 41-47, `emptyState` 283, `upgradeMons` 309-322, `publicState` 444-476, `ensureTrainer` 559-577, `ensureAssigned` 579-594, `swap` 914-941, `throwBall` 943-970, `release` 1012-1029, `importState` 1040-1054
- Modify: `server/index.js:758,813,819` (comments only)
- Modify: `electron/main.cjs:343-356` (the `SPAWN_AUTOTEST` throw)
- Test: `tests/pokedex.test.ts` (update the party tests listed in Step 1; add the new ones)

**Interfaces:**
- Produces (exports of `server/pokedex.js`):
  - `LEGACY_PARTY_SIZE = 6`: the size of a party in saves from 1.5.4 and older. Used only to read and merge them. `PARTY_SIZE` and `SESSION_LIMIT` are removed.
  - `byRecentWork(uids: string[], mons: Record<string, {outAt?: number; workMs?: number}>): string[]`: a new array in this order: a defined `outAt`, larger first; then no `outAt`, by `workMs` larger first; then ties in input order (stable).
- Produces (state and behaviour):
  - `mon.outAt: number`: the time (ms) it last went out with a session. It is set by `throwBall`, by `ensureAssigned` when it assigns, by `swap` for the incoming one, and by Task 3's auto-assign. It is **not** set by `helperFor`.
  - On load and on `importState`, `upgradeMons` backfills a missing `outAt` from the newest `state.log` event of kind `sendout`, `swap` or `exchange` with that `uid`. With none, it stays absent.
  - `foldParty()` (internal) runs after `upgradeMons` on load and in `importState`. It puts `state.party`'s members that exist and are not already in `box` at the front of `state.box`, in order, sets `state.party = []`, and saves when it changed anything.
  - `pickResting(sessionId?: string): string | null` (internal). The resting uids are `state.box` members with a mon, not in `busyUids()` and not in `helpingUids()`, ordered by `byRecentWork`. If the first one has `outAt` or `workMs > 0`, it is the pick. Otherwise the pick is random among all resting (`random()`). `null` when none rests.
  - `ensureAssigned(sessionId)` keeps the remembered `state.assign[sessionId]` only if that mon exists and is not busy with **another** session. Otherwise it takes `pickResting()`. With none, it deletes `state.assign[sessionId]` and returns `{ uid: null, isNew: false }`.
  - `throwBall(sessionId, uid)`: any mon in `box` not busy elsewhere and not helping. It returns only `unknown-pokemon` or `busy`.
  - `swap(sessionId, uid)`: any mon in `box`, resting. Nobody moves within the box. It returns only `no-pokemon`, `unknown-pokemon`, `same` or `busy`.
  - `release(uid)`: there is no `in-party` reason any more.
  - `publicState()` has no `party`, `partySize` or `sessionLimit`.
  - `ensureTrainer()` puts the starter and its five companions into `state.box`, starter first.

- [ ] **Step 1: Update the tests whose subject is gone, and write the new ones** in `tests/pokedex.test.ts`.
  - Rewrite:
    - "starts the trainer … a party of six" → "a first run gifts six into the box, the starter first; the party stays empty". Assert `st.box` has length 6, `st.mons[st.box[0]].how === 'starter'`, `_state().party` equals `[]`, and `st.party`, `st.partySize` and `st.sessionLimit` are undefined.
    - "sends the starter … none past six" → "no session limit: 20 sessions each get a Pokémon while any rests". Seed 25 mons in the box, then send 20 `session_started` events. Assert 20 distinct `assign` values.
    - "an ended session hands its Pokémon back to the party" → "… back to rest". Same body.
    - "swaps in a resting party Pokémon, or a box one that trades places" → "swaps in any resting Pokémon; the box order does not change".
    - "throws a chosen party Pokémon" → "throws any resting Pokémon, and holds it".
    - "past the party of six, box Pokémon work sessions as helpers, up to the session limit": delete it. It is replaced by the limit test above.
    - "a helper session swaps its worker without moving anyone": delete it, since nothing is a helper session any more.
    - "releases a box Pokémon, never a party one" → "releases a resting Pokémon, never a working or helping one".
    - "the PC trades a box Pokémon with a resting party one …" → "exchange is refused: there is no party", with `reason: 'bad-request'`.
    - "a throw held by the last run does not keep the party busy" → keep the body, and change the title to "… does not keep a Pokémon busy".
  - Add:
    - `it('folds a 1.5.4 party into the front of the box, in order, once')`: write a v2 save `{ party: ['m1','m2'], box: ['m3'], mons: {m1,m2,m3} }` to the file, then `createPokedex`. Expect `_state().box` to equal `['m1','m2','m3']` and `party` to equal `[]`. Create a second dex on the same file: the box is unchanged (idempotent). A party member that is also in the box appears once.
    - `it('a synced game with a party is folded too')`: `importState({ version: 2, ..., party: ['m9'], box: ['m3'] })` gives a box starting `['m9','m3']`.
    - `it('outAt: stamped when a Pokémon goes out; backfilled from the log on load')`: use a moving clock (`let t`, as the evolution test does). Cover `throwBall`, the first event's assignment and `swap`. A save whose log holds `{kind:'sendout', uid:'m2', at:5}` loads with `mons.m2.outAt === 5`. A `helper` event does not set `outAt`.
    - `it('byRecentWork: outAt first, then workMs, then the given order')`: a table of 4 mons covering each tie.
    - `it('a session goes out with the resting one that went out most recently; never one working; random only when none has worked')`: two sessions; a remembered Pokémon busy in `s1` is not given to resumed `s2`, and `s2` takes the next resting one.
  - Every test that imported `PARTY_SIZE` or `SESSION_LIMIT` stops importing them.
- [ ] **Step 2: Run** `npx vitest run tests/pokedex.test.ts`. Expected: the new and rewritten cases FAIL.
- [ ] **Step 3: Implement the interfaces above** in `server/pokedex.js`. Rewrite the header comment and the `BOX_LIMIT` comment ("the box holds every Pokémon the trainer owns"). In `server/index.js`, change only comments: "hands its Pokémon back to rest", "Throw a resting Pokémon out with a session", and "kept for older pages; nothing calls it" on `/pokedex/exchange`.
- [ ] **Step 4: `electron/main.cjs` `SPAWN_AUTOTEST`:** remove the `http.get(/pokedex)` + throw block (343-356) and leave a one-line comment: the server sends the most recent resting Pokémon on the session's first event.
- [ ] **Step 5: Run** `npx vitest run tests/pokedex.test.ts`. Expected: PASS. Then `npx vitest run` and `npx tsc --noEmit -p .`. Two other places still use the removed export:
  - `server/merge.js` imports `PARTY_SIZE` for `cleanParty`. Switch it to `LEGACY_PARTY_SIZE` here; change nothing else (Task 4 changes the merge).
  - `tests/cloud-merge.test.ts` imports `PARTY_SIZE`. Switch its import too; Task 4 changes its assertions.

  If `tests/cloud.test.ts:90` fails because the synced game is now folded on import, set its expectation here: `party` equals `[]` and `m1` is `box[0]`.
- [ ] **Step 6: Commit** `feat(server): one collection — fold the party into the box, no session limit, most-recent-out pick`.

---

### Task 3: Server: Pokémon-less sessions meet nothing and get the next one to rest

**Files:**
- Modify: `server/pokedex.js`: `drainStep` 755-768, `tick` 775-796, `noteEvent` 871-912, `swap`, `importState`
- Test: `tests/pokedex.test.ts` (new `describe('a session with no Pokémon')`)

**Interfaces:**
- Consumes: `pickResting()`, `byRecentWork`, `mon.outAt` (Task 2).
- Produces (internal):
  - `hasPokemon(sessionId): boolean`: `state.assign[sessionId]` names an existing mon and `busyUids().get(uid) === sessionId`.
  - `waiting: Map<sessionId, since>`, per run. `noteEvent` adds a session when `ensureAssigned` returns no uid. The map's insertion order is the oldest-first order.
  - `assignWaiting(): boolean`. In order, for each waiting session: drop it if `!isActive(sid)`; drop it if it `hasPokemon` already; otherwise give it `pickResting()`, set `outAt`, `pushLog` a `sendout` event, `publish(event)`, and drop it. It stops at the first `null` pick. It returns whether it assigned any, and the caller `save()`s.
  - Call sites: `noteEvent`'s `session_ended` branch (after `dismissHelpers`); right after an encounter returns `kind === 'catch'` with a `uid` (in `noteEvent` and `tick`); after a successful `swap`; at the end of `importState`; and at the top of `tick()` when `waiting.size > 0`. The tick covers sessions the registry ended without a hook and helpers going back to rest.
- Behaviour:
  - For a session that `!hasPokemon`: `noteEvent` skips the attendance encounter and does **not** set `attendedOn`, so the next session with a Pokémon gets the day's attendance. It does not `queueStep` its tool calls, and `tick` does not queue its thinking steps. `drainStep` drops the session's queue and returns `null`.
  - The page learns of an auto-assign only through the existing `{ type: 'pokedex', state, event: { kind: 'sendout' } }` broadcast. `sendout` is in `LOG_HIDDEN` and is not a toast kind, so 기록 and 업무 모드 show nothing new.

- [ ] **Step 1: Write the failing tests** in `describe('a session with no Pokémon')`, with `isActive` driven by a `Set` of ended ids:
  - `it('opens with none when every Pokémon works, and meets nothing: no attendance, no wild, no queued step')`: 2 mons, sessions a, b, c. `c` has no assign. Run 50 `work('c')` events with `random` at 0 so any roll would hit. No `catch` or `flee` event has `sessionId === 'c'`, and `_state().attendedOn` is still unset when `c` was the day's first event.
  - `it('gets the next one to rest, oldest waiting first')`: sessions c then d wait. End `a`, and `c` gets `a`'s Pokémon while `d` still waits. End `b`, and `d` gets one. A `sendout` event with `sessionId: 'c'` was broadcast.
  - `it('a catch elsewhere goes straight to the waiting session')`: `a` catches (random queue forces a catch), and the new uid is `assign.c`.
  - `it('a swap frees one for the waiting session')`.
  - `it('a waiting session that ended is skipped')`.
  - `it('auto-assign never takes a Pokémon held by a throw')`: `throwBall('e', uid)` before `e`'s first event; that uid is not given to waiting `c`.
  - `it('steps from before it had a Pokémon are not met after')`: queue tool calls while Pokémon-less, assign, then `tick()`. Nothing is met for those steps.
- [ ] **Step 2: Run** `npx vitest run tests/pokedex.test.ts -t "no Pokémon"`. Expected: FAIL.
- [ ] **Step 3: Implement** the interfaces above.
- [ ] **Step 4: Run** `npx vitest run tests/pokedex.test.ts`. Expected: PASS. Then `npx vitest run` and `npx tsc --noEmit -p .`.
- [ ] **Step 5: Commit** `feat(server): a session with no Pokémon meets nothing and gets the next one to rest`.

---

### Task 4: Cloud merge without a party

**Files:**
- Modify: `server/merge.js`: header 9-13, import 23, `MON_MERGED_FIELDS` / `mergeMon` 99-128, `cleanParty` / `untouchedParty` 182-199, party and box block 307-347, output 363
- Test: `tests/cloud-merge.test.ts` (`expectValid` 51-62, `describe('mergeGames: party')` 127-176, box-limit 177-195), `tests/cloud.test.ts:82-90`

**Interfaces:**
- Consumes: `LEGACY_PARTY_SIZE`, `BOX_LIMIT` (Task 2).
- Produces: `mergeGames(local, remote)` returns `party: []` always. `box` is every individual once, in this order: local `party`, local `box`, remote `party`, remote `box`, then the rest by catch time. Both parties go through `cleanParty` (capped at `LEGACY_PARTY_SIZE`). The professor overflow starts only past `BOX_LIMIT + LEGACY_PARTY_SIZE`, and it never picks a member of either side's cleaned party. `outAt` is merged as the larger of the copies (it is added to `MON_MERGED_FIELDS`). `untouchedParty` and the new-PC party swap are removed. `HANDLED` still lists `party`. The merge stays pure, idempotent and symmetric on individuals.

- [ ] **Step 1: Update and add tests.**
  - `expectValid`: `g.party` equals `[]`. `[...g.box].sort()` equals the sorted keys of `g.mons`. `g.box.length <= BOX_LIMIT + LEGACY_PARTY_SIZE`.
  - `describe('mergeGames: party')` → `describe('mergeGames: no party')`:
    - `it("a 1.5.4 copy's party joins the box; this PC's folded box keeps its order first")`
    - `it('both sides with a party (an old merge): both go to the box front, local first, each once')`
    - `it('a new PC signing in: every individual of both sides in the box, the older trainer kept')`. This replaces the "gets the old team" test.
  - Box limit:
    - `it('a full box plus a 1.5.4 party of six: nothing goes to the professor')`: 1200 box + 6 party gives 1206 in the box and no `professor` log entry.
    - The existing professor test becomes "past BOX_LIMIT + LEGACY_PARTY_SIZE …".
  - `it('outAt: the later copy wins')`.
  - Keep the existing idempotence and symmetry tests green.
  - `tests/cloud.test.ts:90`: `expect(game.party).toEqual([])`, and `m1` is `game.box[0]`.
- [ ] **Step 2: Run** `npx vitest run tests/cloud-merge.test.ts tests/cloud.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the interface above in `server/merge.js`, with an updated header comment.
- [ ] **Step 4: Run** the two files. Expected: PASS. Then `npx vitest run` and `npx tsc --noEmit -p .`.
- [ ] **Step 5: Commit** `feat(cloud): merge keeps every Pokémon in the box, with room for a folded party`.

---

### Task 5: Page rules: resting order, auto partner, the Pokémon-less picture

**Files:**
- Create: `src/resting.ts`
- Modify: `src/pokedexStore.ts:84` (`DexEvent` kinds unchanged), `Mon` (add `outAt`), `DexState` 110-136, helpers 173-202, comment 158
- Modify: `src/workMode.ts:55-148` (`SessionRowInput`, `SessionRowParts`, `sessionRowParts`, `PartnerDex`, `autoPartner`)
- Modify: `src/sessionList.ts:113-133` (`sessionHeaderParts`)
- Modify: `src/chat/lensMode.ts:55-61` (`chatWho`)
- Test: `tests/resting.test.ts` (new), `tests/work-mode.test.ts:28,76-81,101-121`, `tests/session-list.test.ts`, `tests/chat-lens-mode.test.ts`

**Interfaces:**
- Produces `src/resting.ts` (pure, no imports from the store or React):
  - `interface WorkedMon { dex?: number; outAt?: number; workMs?: number }`
  - `interface RestingDex { box: string[]; mons: Record<string, WorkedMon | undefined>; assign?: Record<string, string>; helpers?: Record<string, string[]> }`
  - `byRecentWork(uids: string[], mons: RestingDex['mons']): string[]`: the same order as the server's `byRecentWork` (Task 2).
  - `restingUids(s: RestingDex): string[]`: `box` members with a mon, not in `assign` values or `helpers`, in `byRecentWork` order.
  - `pickResting(s: RestingDex, prefer?: string | null, random: () => number = Math.random): string | null`: `prefer` if it rests; else the first resting one if it has `outAt` or `workMs > 0`; else a random resting one; `null` when none rests.
  - `recentPartnerDex(s: RestingDex, current: number | null): number[]`: the distinct `dex` of the first 6 of `byRecentWork(s.box, s.mons)`, working ones included. `current` is appended when it is not among them.
- Produces in `src/pokedexStore.ts`:
  - `Mon.outAt?: number`.
  - `DexState` loses `party`, `partySize` and `sessionLimit`.
  - `freePartyCount`, `freeSessionCount`, `freeBoxUids` and `isHelperSession` are removed. Callers use `restingUids` (re-exported from `./resting`).
- Produces in `src/workMode.ts`:
  - `SessionRowInput` loses `helperSession` and gains `noPokemon?: boolean`.
  - `SessionRowParts` loses `helperMark`.
  - `sessionRowParts`: when `noPokemon` (outside 업무 모드) it gives `{ picture: 'glyph', level: null, label: row.project, helpers: row.helpers > 0, swap: false, barLabel: 'HP' }`. 업무 모드 is unchanged.
  - `autoPartner(dex: RestingDex, prefer?: string | null, random?: () => number): string | null` delegates to `pickResting`. `PartnerDex` is removed.
- Produces: `sessionHeaderParts(row & { noPokemon?: boolean }, workMode)` gives picture `'glyph'` when `noPokemon`. `chatWho(row & { noPokemon?: boolean }, workMode)` gives `{ picture: 'glyph', name: t('에이전트') }` when `noPokemon`.

- [ ] **Step 1: Capture the "before" pictures** for the portfolio entry (insight-log, Task 11). Run `npx vite build`. Then run `node tests/visual/shots.mjs --only session,box,throw --out tests/visual/.home/party-before`, and `--only swap,widget,qa` into the same folder.
- [ ] **Step 2: Write the failing tests.**
  - `tests/resting.test.ts`:
    - `byRecentWork` table, the same 4 cases as the server's test.
    - `restingUids` excludes `assign` values and `helpers`.
    - `pickResting`: `prefer` resting → prefer; `prefer` working → the most recent resting one; none worked → `random` picks (`() => 0.99` gives the last); none resting → `null`.
    - `recentPartnerDex`: 8 mons, two of one species → 6 distinct; `current` not among them is appended.
  - `tests/work-mode.test.ts`:
    - `ROW` loses `helperSession`.
    - Lines 76 and 81 lose `helperMark`.
    - New: `sessionRowParts({ ...ROW, noPokemon: true }, false)` equals `{ picture: 'glyph', level: null, label: 'todo-cli', helpers: true, swap: false, barLabel: 'HP' }`, and in 업무 모드 equals today's work-mode parts.
    - The `autoPartner` block becomes `box: ['a','b','c','x','y']`, with `mons` carrying `outAt` on `b` and `c` (`c` newer): `autoPartner(dex, 'c')` → `'c'`; `autoPartner(dex, 'a')` with `a` working → `'c'`; all working → `null`.
  - `tests/session-list.test.ts`: `sessionHeaderParts({ ..., noPokemon: true }, false).picture === 'glyph'`.
  - `tests/chat-lens-mode.test.ts`: `chatWho({ name: '피카츄', sprite: 'x', noPokemon: true }, false)` equals `{ picture: 'glyph', name: '에이전트' }` (with `t` mocked to the key).
- [ ] **Step 3: Run** `npx vitest run tests/resting.test.ts tests/work-mode.test.ts tests/session-list.test.ts tests/chat-lens-mode.test.ts`. Expected: FAIL.
- [ ] **Step 4: Implement** the interfaces above. `npx tsc --noEmit -p .` will list every page caller of the removed names (`Widget.tsx`, `PartyPickers.tsx`, `BoxView.tsx`, `PokedexView.tsx`, `LeaderboardView.tsx`). Leave them for Tasks 6-8, but keep the build compiling. Where a removed name is used, put in the minimal replacement now: `restingUids(dex)` for `freeBoxUids(dex)`, `false` for `isHelperSession(...)`, and `[]` for `dex.party`. Each of these stubs is replaced in its own task. Every stub line gets the comment `// Task N` so the reviewer can find it.
- [ ] **Step 5: Run** the four test files. Expected: PASS. Then `npx vitest run` and `npx tsc --noEmit -p .`.
- [ ] **Step 6: Commit** `feat(page): resting order, auto partner and the no-Pokémon picture as pure rules`.

---

### Task 6: The pickers: every resting Pokémon, recent first, with search

**Files:**
- Modify: `src/components/PartyPickers.tsx` (whole file; the name stays, the header comment changes)
- Modify: `src/styles/pokedex.css:12,279-293` (remove the `.w-swap-list` / `.w-swap-item` rules once unused; `.w-throw-hint`, `.w-swap-section`, `.w-swap-box` and `.w-swap-cell` stay)
- Modify: `src/locales/widget.ts` (keys below)
- Test: `tests/pickers.test.ts` (new)

**Interfaces:**
- Consumes: `restingUids` (Task 5), `nameOf`, `pokemonById`, `iconUrl`, `levelOf`.
- Produces:
  - `export const PICKER_PAGE = 120`.
  - `export function pickerList(dex: DexState, query: string): Mon[]`: `restingUids(dex)` mapped to mons. With a query, it is filtered by `nameOf(pokemonById(m.dex)).toLowerCase().includes(q)` or `String(m.dex) === q`, where `q` is the trimmed, lower-cased query.
  - `ThrowPicker` props are unchanged: `{ dex, resume, tools?, defaultTool?, onPick(uid, tool), onClose }`.
  - `SwapPicker` props are `{ dex, currentDex, onPick(uid), onClose }`. The `helper` prop is removed.
  - Both render one search input (`aria-label={t('이름 검색')}`, autofocused) and one `.w-swap-box` grid of `.w-swap-cell` buttons. Each cell has `aria-label` and `title` = `"{✦ }{name} Lv.{n}"`. The grid shows the first `PICKER_PAGE` matches and then a `t('더 보기')` button that shows `PICKER_PAGE` more. The empty states are `t('찾는 포켓몬이 없어요')` (a query) and `t('쉬고 있는 포켓몬이 없어요')` (none at all; SwapPicker only, because ThrowPicker never opens with none, see Task 7).
- Locale keys:
  - Add `'쉬고 있는 포켓몬이 없어요'`: en `'No Pokémon is resting'`, ja `'休んでいるポケモンがいません'`.
  - Remove, if unused after this task (grep first): `'파티'` (widget.ts; dex.ts is Task 8), `'고르면 지금 포켓몬과 자리를 바꿔요'`, `'고르면 이 세션을 맡는 포켓몬만 바뀌어요'`, `'파티가 모두 일하는 중이에요. 박스의 포켓몬이 조력자로 가요.'`, `'조력자로 일하는 중'`, `'파티에 쉬고 있는 포켓몬이 없어요. 박스에서 파티로 데려오면 교체할 수 있어요.'`, `'쉬는 중 · {steps}걸음'`, `'쉬는 중 · Lv.{level}'`.

- [ ] **Step 1: Write the failing tests** `tests/pickers.test.ts`. Use `renderToStaticMarkup` with `src/i18n`'s `t` mocked to the key, as `tests/chat-changes-ui.test.ts` does. Build a `DexState` of 300 box mons: two working (in `assign`), one helping (in `helpers`), and `outAt` on three.
  - `ThrowPicker` markup has exactly `PICKER_PAGE` `w-swap-cell` buttons and one `더 보기`. The first cell's label is the newest-`outAt` Pokémon. No working or helping uid appears. No markup contains `파티` or `조력자`.
  - `SwapPicker` with every mon working shows `쉬고 있는 포켓몬이 없어요` and no cell.
  - `pickerList(dex, '25')` finds dex 25 by number. With the language set to en (`tests/setup-language.ts`), `pickerList(dex, 'pika')` finds Pikachu and `'피카'` finds nothing.
  - A source check: `PartyPickers.tsx` has no `dex.party`, `partyOut` or `helper` prop.
- [ ] **Step 2: Run** `npx vitest run tests/pickers.test.ts`. Expected: FAIL.
- [ ] **Step 3: Rewrite the pickers** to the interface. Keep `Dialog`, the AI-tool radio group, the resume title and hint, and the classes the CSS already styles.
- [ ] **Step 4: Run** `npx vitest run tests/pickers.test.ts`. Expected: PASS. Then `npx vitest run` and `npx tsc --noEmit -p .`.
- [ ] **Step 5: Harness.** In `tests/visual/shots.mjs` `SURFACES`, set `throw` and `swap` `ready` to `'.w-swap-cell'`. Run `npx vite build`, then `node tests/visual/shots.mjs --only throw,swap --check fit`, then `--only throw,swap --lang en`, then `--lang ja`. Expected: exit 0. Look at the PNGs: one search field, one grid, no "파티" heading.
- [ ] **Step 6: Commit** `feat(pickers): pick from every resting Pokémon, recent first, with search`.

---

### Task 7: The side panel: no party row, no limit, sessions without a Pokémon

**Files:**
- Modify: `src/Widget.tsx`:
  - imports 26, 31-32
  - `monOf` / `partyFull` 529-534
  - `restingKey` / `restingUids` / `FULL_NOTE` 603-607
  - `throwing` / `busyUids` 740-742
  - `launch` / `sendOut` / `throwBall` 744-787
  - `MAX_SHELLS` comment 790
  - `resume` 805-813
  - restore loop 815-843
  - `doSwap` note 864
  - swap prefetch effect 867-875
  - rail `+` 907 and rail picture 919-921
  - list header `+` 1106
  - party head 1072-1096
  - row parts 1114-1120
  - helper mark 1229-1231
  - swap title 1238
  - `SessionHeader` picture 1361-1363
  - `SwapPicker` call 1450
  - the BoxView `resting` prop
  - header comment line 3
- Modify: `src/components/Icons.tsx:85-90` (remove `HelperIcon`)
- Modify: `src/styles/widget.css:263`, `src/styles/pokedex.css:265-273`, `src/styles/widget-expanded.css:387-388`
- Modify: `src/QaPage.tsx` (one Pokémon-less row in `QaRows`)
- Modify: `src/locales/widget.ts`
- Modify: `tests/visual/fixture.mjs:101-176`, `tests/visual/shots.mjs` (`SURFACES` + `session-nomon`)
- Test: `tests/widget-party.test.ts` (new, source checks)

**Interfaces:**
- Consumes: `restingUids`, `pickResting` / `autoPartner`, `sessionRowParts` / `sessionHeaderParts` / `chatWho` with `noPokemon` (Task 5); `ThrowPicker` / `SwapPicker` (Task 6); the server's auto-assign broadcast (Task 3).
- Produces in `Widget.tsx`:
  - `openSession(where: { cwd?: string; resume?: PastSession; tool?: string }, uid: string | null, quiet?: boolean): Promise<void>` replaces `throwBall`. With a uid it casts the session first, adds the session id to `pendingThrows` (a `useRef<Set<string>>`) until `bridge.game.throw` resolves, and keeps today's notes for a failed throw. With `null` it only creates the terminal.
  - `sendOut(where)`: if `!dex` or `restingUids(dex)` is empty → `openSession(where, null)`, plus, only outside 업무 모드 and only when `dex` is loaded, the note `t('쉬고 있는 포켓몬이 없어서 포켓몬 없이 열었어요. 한 마리가 쉬게 되면 바로 함께해요.')`. In 업무 모드 → `openSession(where, autoPartner(dex, remembered))`. Otherwise it opens `ThrowPicker`.
  - `resume(past)`: the remembered one if it is in `restingUids(dex)` → `openSession(..., remembered)`; else `sendOut({ resume })`.
  - Restore loop: for each restorable non-shell session, the uid is the remembered one if it rests and is unused, else the first unused of `restingUids(dex)`, else `null`. Every session reopens, with or without a Pokémon. There is no `limit` and no `break`.
  - `noPokemon(r)`: `!!dex && !r.shell && !!r.terminal && r.mood !== 'ended' && !dex.assign?.[r.sessionId] && !pendingThrows.current.has(r.sessionId)`. It is passed to `sessionRowParts`, `sessionHeaderParts` and `chatWho`, and the rail button uses the glyph for it as it does in 업무 모드.
  - Removed: `partyFull`, `FULL_NOTE`, every `.full` class and its title, the `w-party-head` block, `restingKey` / `restingUids` state, the swap prefetch effect, the `.w-row-helper` mark, and the `HelperIcon` import.
- Locale keys:
  - Add `'쉬고 있는 포켓몬이 없어서 포켓몬 없이 열었어요. 한 마리가 쉬게 되면 바로 함께해요.'`: en `'No Pokémon is resting, so the session opened without one. The next one to rest joins it.'`, ja `'休んでいるポケモンがいないので、ポケモンなしで開きました。休むポケモンが出たらすぐに加わります。'`.
  - Add `'교체: 이 세션에서 일할 포켓몬을 바꿔요'`: en `'Swap: change the Pokémon working this session'`, ja `'入れ替え: このセッションで働くポケモンを変えます'`. It replaces `'교체: 이 세션에서 일할 포켓몬을 바꿔요 (파티나 박스에서)'`.
  - Remove: `'세션을 최대 {n}개까지 열 수 있어요. …'`, `'파티가 모두 일하는 중이라 박스의 포켓몬이 이 세션을 맡았어요'`, `'파티 포켓몬만 교체할 수 있어요'`, `'파티의 포켓몬이 모두 일하는 중'` (if unused), `"{name} · 눌러서 '{session}' 세션의 포켓몬과 교체"`, `'{name} · 일하는 중'` and `'{name} · 쉬는 중'` (if unused).
  - Keep `'조력자'` and `'서브에이전트를 돕는 조력자 (박스에서 나와요)'`.
- Harness fixture: `dexState` gives `party: []` and `box: [...partyMons, ...boxMons]`. Each assigned mon gets an `outAt`. `partySize` and `sessionLimit` are dropped. A new option `noMon: n` leaves the last `n` sessions out of `assign`. The new surface `'session-nomon': { view: 'terminal', noMon: 1 }`, and its `-work` variant, follow how `twelve` reaches the fixture.

- [ ] **Step 1: Write the failing source checks** `tests/widget-party.test.ts`, reading `src/Widget.tsx` as text:
  - It has no `partyFull`, `FULL_NOTE`, `w-party-head`, `isHelperSession`, `HelperIcon`, `sessionLimit`, `partySize` or `dex.party`.
  - The restore loop has no `break` tied to a free Pokémon, and no `limit`.
  - `openSession(` is called with `null` in `sendOut`.
  - The Pokémon-less note is guarded by `!workMode`.
  - `src/components/Icons.tsx` has no `HelperIcon`.
  - `src/QaPage.tsx` has a row with `w-row-glyph`.
- [ ] **Step 2: Run** `npx vitest run tests/widget-party.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the interfaces above. Remove the CSS rules that only styled removed elements. Then look at the `.w-party` card's top in the `session` shot: the head used to sit above `.w-list-head`, and the card keeps its own padding.
- [ ] **Step 4: Run** `npx vitest run tests/widget-party.test.ts tests/work-mode.test.ts`. Expected: PASS. Then `npx vitest run` and `npx tsc --noEmit -p .`. `TerminalPanel.tsx` already falls back when a WebGL context is lost (`onContextLoss`), so more than 16 sessions keep working. Do not edit it.
- [ ] **Step 5: Harness, in batches.** First run `npx vite build`. Then:
  - `--only session,session-12,session-nomon --check fit`
  - `--only widget,widget-plain,qa --check fit`
  - `--only session-work,session-nomon-work,widget-work --check work`
  - `--flow tabs-gone`
  - `--flow hit-areas`
  - `--flow text-size`

  Expected: exit 0 each. In `session-nomon` the last row shows the terminal glyph, no Lv and no swap button, and it matches its `-work` twin.
- [ ] **Step 6: Commit** `feat(panel): no party row and no session limit; a session can wait for a Pokémon`.

---

### Task 8: 박스, 도감 and 랭킹 without the party, and a guard

**Files:**
- Modify: `src/components/BoxView.tsx` (header comment 1-9, props 38-39, state 49-54, `party` 57, `inParty` / `exchangeWith` / `exchange` 74-89, `inBox` / `locked` / `canDropOn` 92-99, `cell` 112-149, the party block 158-164, `위치` fact 197, actions 206-235)
- Modify: `src/components/PokedexView.tsx:136,273,282`
- Modify: `src/components/LeaderboardView.tsx:72-76,139`
- Modify: `src/styles/pokedex.css:340-344,379,393,410`
- Modify: `src/locales/dex.ts`
- Modify: `tests/visual/shots.mjs:5534` (drop `.box-party, .box-party-row` from the list)
- Test: `tests/no-party.test.ts` (new), `tests/box-view.test.ts` (new)

**Interfaces:**
- Consumes: `recentPartnerDex` (Task 5).
- Produces:
  - `BoxView` takes no props; it still exports `React.memo(BoxView)`.
  - Every box cell can be dragged within the box (when no filter is on). There is no drop onto a party slot, no `exchange` call, no `파티에 넣기` / `box-choose`, and the `resting` prop is gone.
  - The detail card shows `놓아주기` for every Pokémon that is not working. A working one shows no release button. A refused release still shows today's note.
  - `위치` reads `t('박스')` plus `` ` · ${t('일하는 중')}` `` while working.
  - `PokedexView`'s owned rows offer release when not working, and their sub-line starts with `t('박스')`.
  - The 박스 stat hint is `t('꽉 차면 새로 잡은 개체는 박사님께 가요')`.
  - `LeaderboardView`'s partner buttons come from `recentPartnerDex(state, profile?.partner ?? null)`. The default is `profile?.partner ?? that[0] ?? null`.
- Locale keys (`dex.ts`):
  - Add `'꽉 차면 새로 잡은 개체는 박사님께 가요'`: en `'When it’s full, new catches go to the Professor'`, ja `'いっぱいになると新しく捕まえたポケモンは博士に送られます'`.
  - Add `'끌어서 박스 안에서 옮기기'`: en `'Drag to move it in the Box'`, ja `'ドラッグでボックス内を移動'`.
  - Remove `'파티'`, `'파티에 넣었어요'`, `'끌어서 박스 안에서 옮기거나, 파티 칸에 놓아 교체'`, `'파티에 넣기'`, `'파티 포켓몬이에요. 세션을 열 때 몬스터볼로 던질 수 있어요.'`, `'파티 6마리 별도. 꽉 차면 새로 잡은 개체는 박사님께 가요'`, and `'누구와 바꿀까요? (일하는 포켓몬은 못 바꿔요)'` and `'바꾸지 못했어요 ({reason})'` if unused.

- [ ] **Step 1: Write the failing tests.**
  - `tests/no-party.test.ts`, the guard for the whole feature:
    - No key or value in any `src/locales/*.ts` table matches `/파티|\bparty\b|\bparties\b|手持ち/i`.
    - No file under `src/` contains `파티` or `手持ち`.
    - No file under `src/` contains `partyFull`, `FULL_NOTE`, `freeSessionCount`, `freePartyCount`, `isHelperSession`, `HelperIcon`, `sessionLimit`, `partySize`, `.party` (as a property read) or `exchange(` (except `src/desktop.ts`'s kept type).
    - `server/pokedex.js` exports neither `SESSION_LIMIT` nor `PARTY_SIZE`, and contains none of `'party-free'`, `'full'`, `'in-party'` or `'not-in-party'`.
  - `tests/box-view.test.ts`: `renderToStaticMarkup(<BoxView />)` with the store fed a `DexState` (via `dispatchPokedex`). Its markup has no `box-party` and no `파티`. With a picked working Pokémon there is no `놓아주기`. A source check confirms `BoxView.tsx` has no `exchange`.
  - `LeaderboardView`: a source check that it uses `recentPartnerDex` and has no `state?.party`.
- [ ] **Step 2: Run** `npx vitest run tests/no-party.test.ts tests/box-view.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the interfaces above, and remove the CSS for removed elements. In this task, also remove any `// Task N` stub left from Task 5.
- [ ] **Step 4: Run** the two files. Expected: PASS. Then `npx vitest run` and `npx tsc --noEmit -p .`.
- [ ] **Step 5: Harness, in batches.** First `npx vite build`. Then:
  - `--only box,dex,rank --check fit`
  - `--only box --lang en`
  - `--only box --lang ja`
  - `--only box --text xlarge`

  Expected: exit 0. The 박스 view starts with its toolbar, and there is no party strip.
- [ ] **Step 6: Commit** `feat(box): one box — no party strip, exchange or party wording; 랭킹 partners from recent work`.

---

### Task 9: README (ko / en / ja)

**Files:**
- Modify: `README.md:5,12,13,58,138`, `README.en.md:5,12,13,58,138`, `README.ja.md` (the same lines)

**Interfaces:** none (docs).

- [ ] **Step 1: Rewrite** each line that describes the party or the session limit, so it reads naturally without them:
  - Line 5: each session is worked by one of your Pokémon.
  - Line 12: on first launch you get six Pokémon: a starter plus five common ones, Lv.5.
  - Line 13: New session → pick any resting Pokémon (recent first, searchable). If none rests, the session opens without one and the next one to rest joins it.
  - Line 58: the box holds up to 1200, with sort, search, a shiny filter and release (no "swap with the party").
  - Line 138: "The whole game: box, Pokédex, log".
  - Keep each file's own voice. Change no other line.
- [ ] **Step 2: Check** with `grep -n -i "party\|파티\|手持ち\|12개\|12 sessions" README*.md`. Expected: no hits.
- [ ] **Step 3: Commit** `docs(readme): no party, no session limit`.

---

### Task 10: The intro site (outside the repo; not committed, not deployed)

`Documents\spawn-site` is not a git repository. It goes up to gh-pages separately, and only when the owner says so.

**Files:**
- Modify: `spawn-site/index.html:134-143` (the hero demo's `w-party-head`), `index.html:207-217` (the "세션마다 한 마리" section's `sess-party` card and its comment)
- Modify: `spawn-site/assets/js/main.js`:
  - 386 `slots`, 397-400 `PARTY` / `demo.party`, 421, 444
  - 454-458 `renderSlots`, 533-534 (the swap that rewrites the party), 577, 614, 642
  - 665 `PARTY_DEX` and 690 `party:`, 814 (the owned row's `app.party`)
  - 908-984 (the sessions section's slots and `renderSlots`)
  - 1023-1029 (the demo terminal's `"PARTY_SIZE"`, `"useParty"` and `src/Party.tsx`, renamed to neutral code names such as `"PAGE_SIZE"`, `"useSession"` and `src/Session.tsx`)
- Modify: `spawn-site/assets/js/i18n.js` (ko 50, 82, 139; en 256, 287, 344; ja 458, 489, 546)

**Interfaces:** none.

- [ ] **Step 1: Copy the site** to `Documents\spawn-site-backup-1.5.4` (a sibling folder; do not touch the existing `spawn-site-backup`).
- [ ] **Step 2: Edit.**
  - Remove both party strips and every `renderSlots` call. Keep each demo's session rows and their animation.
  - The owned rows always say `app.box`.
  - Delete the key `app.party` in all three languages.
  - `f1.lede`: ko `'새 세션을 열면 쉬고 있는 포켓몬 한 마리가 나와 그 세션을 맡아요.'`, en `'Open a new session and one of your resting Pokémon takes it on.'`, ja `'新しいセッションを開くと、休んでいるポケモンが1匹出てそのセッションを担当します。'`
  - `privacy.save.s`: ko `'박스, 도감, 기록이 모두 이 파일 하나에 있어요.'`, en `'Your Box, Pokédex and log all live in this one file.'`, ja `'ボックス、図鑑、記録はすべてこのファイルひとつにあります。'`
- [ ] **Step 3: Check.** Run `grep -n -i "party\|파티\|手持ち" index.html assets/js/*.js`; expected: no hits. Open `index.html` from disk in a browser (classic scripts, no module). Switch ko / en / ja and watch both demos run one full loop. There must be no console error and no empty strip where the party was.
- [ ] **Step 4: Do not commit or deploy.** Report the changed files and the backup path to the owner.

---

### Task 11: Release prep for 1.6.0 (no release command)

**Files:**
- Modify: `package.json`, `package-lock.json` (version)
- Modify: `CHANGELOG.md` (a new `### 1.6.0` at the top of each of the three sections: `## spawn`, `## spawn (English)`, `## spawn (日本語)`)
- Modify: `docs/HANDOFF.md` (the top note)

**Interfaces:** none.

- [ ] **Step 1: Bump the version.** Run `npm version 1.6.0 --no-git-tag-version`. Expected: `package.json` and both `package-lock.json` entries read `1.6.0`, and no tag is made.
- [ ] **Step 2: CHANGELOG.** Add above each `### 1.5.4`. Change no past entry.
  - ko:
    - `- 파티가 없어졌어요. 잡은 포켓몬은 모두 박스에 있어요. 파티에 있던 포켓몬은 박스 맨 앞으로 옮겨지고, 사라지는 포켓몬은 없어요.`
    - `- 새 세션을 열거나 이어할 때, 지금 쉬고 있는 포켓몬 모두에서 골라요. 최근에 일한 포켓몬이 먼저 나오고 이름으로 찾을 수 있어요. 교체도 같은 목록이에요.`
    - `- 한 번에 열 수 있는 세션 수(12개) 제한이 없어졌어요.`
    - `- 쉬는 포켓몬이 없어도 세션은 열려요. 포켓몬 없이 시작해서 아무것도 만나지 않다가, 한 마리가 쉬게 되면 가장 오래 기다린 세션부터 바로 함께해요.`
  - en:
    - `- The party is gone. Every Pokémon you have caught is in the Box. The ones that were in your party move to the front of the Box; none is lost.`
    - `- Opening or resuming a session, you pick from every Pokémon that is resting now: the most recently worked come first, and you can search by name. Swap uses the same list.`
    - `- There is no longer a limit of 12 open sessions.`
    - `- A session opens even when no Pokémon is resting. It starts without one and meets nothing; as soon as a Pokémon is free, it joins the session that has waited longest.`
  - ja:
    - `- 手持ちがなくなりました。捕まえたポケモンはすべてボックスにいます。手持ちにいたポケモンはボックスの先頭に移り、いなくなるポケモンはいません。`
    - `- セッションを開くときや再開するときは、いま休んでいるポケモン全員から選びます。最近働いたポケモンが先に並び、名前で探せます。入れ替えも同じ一覧です。`
    - `- 同時に開けるセッション数(12個)の上限がなくなりました。`
    - `- 休んでいるポケモンがいなくてもセッションは開きます。ポケモンなしで始まって何にも出会わず、ポケモンが1匹休むと、いちばん長く待っているセッションからすぐに加わります。`
- [ ] **Step 3: HANDOFF.** Add a new first line to the `> **새 세션은 여기부터**` note, in Korean like the rest of the file: "1.6.0(2026-11-16): 파티 없앰". Name the spec and this plan. Then state the four calls:
  - fold on load and sync, with `party: []` kept in the save;
  - `mon.outAt` with `byRecentWork` as the one rule (server `pokedex.js`, page `src/resting.ts`);
  - Pokémon-less sessions in `waiting`, auto-assigned oldest first, meeting nothing;
  - the merge cap `BOX_LIMIT + LEGACY_PARTY_SIZE`.

  Then: the exchange route and IPC are kept, and nothing calls them. Next: the owner runs the release, and the site (Task 10) goes up on the owner's word.
- [ ] **Step 4: Portfolio entry.** Use the `insight-log` skill for spawn (`Documents\spawn-portfolio`). The "before" is `tests/visual/.home/party-before` (Task 5 Step 1). For the "after", run `npx vite build`, then `node tests/visual/shots.mjs --only session,box,throw --out tests/visual/.home/party-after` and `--only swap,widget,session-nomon` into the same folder. The insight: the game's party made a work tool feel like a copy of the games, so a session cap was imposed for no work reason.
- [ ] **Step 5: Verify everything.** Run `npx vitest run`, `npx tsc --noEmit -p .` and `npx vite build`. Then `node -e "import('./scripts/dist-check.mjs').then(m => m.checkDist('dist'))"`. Run `npx vitest run tests/patch-notes.test.ts`; expected: the 1.6.0 notes parse in all three languages. Expected: all green.
- [ ] **Step 6: Commit** `release prep: 1.6.0 — no party, no session limit`. Stop here: do not run the release command, push, tag or deploy. Tell the owner it is ready for them.
