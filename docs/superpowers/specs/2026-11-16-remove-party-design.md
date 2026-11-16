# Remove the party (2026-11-16)

## Why

The owner: the app follows the main-series games too closely and it has become odd. "Party" goes as a system: the
left panel keeps the 도감 strip only, a session limit makes no sense, and 박스 no longer says 파티. The intro site follows.

## Goals

- No party anywhere a user sees it: no 파티 row in the side panel (window and widget), no party block or 파티 word in 박스,
  no "party is all out" helper idea (조력자 marker, its icon, its tooltip), no party wording in notes, pickers, settings,
  QA page, patch-note-like UI copy, the three locales, or the intro site (`Documents\spawn-site`, ko/en/ja).
- Starting or resuming a session: the picker (ThrowPicker) lists **every caught Pokémon that is not working now**
  (owner's choice, option 1), most recently worked first, with a name search. The same list feeds the session's
  교체 (SwapPicker).
- No session limit: no SESSION_LIMIT on the server, no `partyFull` / FULL_NOTE in the page, no 'full' refusal.
- Everything else about Pokémon stays: catching, the 도감, levels and evolution, 박스 (one grid, its sort and filters),
  랭킹, 기록, the first-run gift.

## Non-goals

- No change to catching, encounter rates, levels, evolution, the 도감 view, 기록, 랭킹 scoring.
- No change to the chat view, terminals, update flow, cloud sync protocol.
- No new feature beyond the picker's list and search.

## Anti-goals (a failure even if it "works")

- An old save, a cloud save written by 1.5.4, or a newer one read by an older app breaks or loses Pokémon.
- A session opens with no Pokémon because nothing is "in the party".
- 업무 모드 shows a Pokémon or a Pokémon word anywhere it does not today.

## Constraints

- **Saves and cloud stay compatible.** The `party` field stays in the save format and cloud merge (an older app
  reading a new save must still work); see "One collection" below for how the new app empties it.
- The first-run gift (starter + five companions) still happens; they simply are caught Pokémon.
- `throwBall(sessionId, uid)`: any owned Pokémon that is not working in another session may go out (no party
  check, no 'party-free', no 'full'). `ensureAssigned` (a session whose first event came with no throw): the resting
  Pokémon that worked most recently (`workMs`/last assignment time), else any resting one at random; never null
  while any Pokémon rests. If every caught Pokémon is working, the session goes without one (see Decided: auto-assign
  later, no catching meanwhile) — no refusal, no note in 업무 모드.
- 업무 모드's `autoPartner` follows the same rule as `ensureAssigned`.
- The box↔party exchange (`exchange`, drag onto a party slot, "trade places") goes from the UI; the server endpoint
  may stay but nothing calls it.
- Shell tabs keep their own MAX_SHELLS = 3 (WebGL contexts), unrelated to the party.
- 랭킹's partner choice: today its candidates are the party's six. New: the six most recently worked Pokémon
  (plus the current partner if it is not among them).
- Pickers with hundreds of Pokémon must stay fast: one virtualised or paged grid is the builder's call; a search box
  filters by name (in the shown language) as you type.

## Approaches considered

1. **Pick from every caught Pokémon (chosen by the owner).** The picker stays; its list becomes all resting caught
   Pokémon, recent first, with search. Closest to how the owner works today.
2. Automatic choice, no picker: a resting Pokémon goes out at once; change it with 교체. Rejected by the owner.
3. Keep `party` as a hidden "favourites" list for ordering. Rejected: brings the concept back under another name.

## Decided

- Option 1 above. Remove party UI everywhere, remove the session limit.
- **No resting Pokémon (owner, 2026-11-16):** a new session still opens, with no Pokémon (the row shows the plain glyph
  업무 모드 uses). As soon as a caught Pokémon rests (its session ends, one is caught, one is released from work),
  it is **assigned automatically** to the oldest Pokémon-less open session. A session with no Pokémon **meets and
  catches nothing**: no encounters, no wild rows, no catch events for it.

## Calls made in the plan's place (the owner may overrule)

- **One collection:** on first load the new app folds `state.party` into the front of `state.box` (order kept) and
  empties `state.party`; the first-run gift goes to the box. An older app reading such a save sees an empty party
  and still works (its helper path takes box Pokémon). `release`, `arrangeBox`, `swap` then work on every Pokémon alike.
  (This replaces "party stays exactly as stored" above.)
- **Resume keeps its shortcut:** a resumed or restored session takes the Pokémon it remembers when that one rests,
  with no picker, as today; otherwise the picker (resume) or the most recently worked resting one (restore).
- **Sub-agent helpers stay** (a box Pokémon helping a sub-agent: `helperFor`, the row's helpers, '조력자'): not a
  party feature. Their candidates are every resting Pokémon not out with a session.
- **Past release notes stay as written**; new CHANGELOG entries only. README (ko/en/ja) is rewritten where it
  describes the party or the session limit.

## Left to the builder

- Exact sort key for "recently worked" (last assignment time is preferred if stored; otherwise derive it).
- Grid sizing and virtualisation in the pickers; the search box's placement and empty state ("찾는 포켓몬이 없어요").
- Visual harness flows / unit tests that assert party UI: update or delete them to match.
- Site copy: rewrite sentences that mention the party or a 12-session limit so they read naturally without it.
- CHANGELOG (ko/en/ja) lines for the release.
