/**
 * server/merge.js — the cloud sync's union of two saved games: nothing caught
 * on either PC is lost, every individual is in the box once (a 1.5.4 copy's
 * party included), the box keeps its limit, and merging again changes nothing.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { mergeGames, sameGame } from '../server/merge.js'
import { BOX_LIMIT, createPokedex, monKey } from '../server/pokedex.js'

const DAY = 86_400_000
const T0 = Date.UTC(2026, 0, 1)

/** An individual as pokedex.js saves it */
function mon(uid: string, dex: number, at: number, extra: Record<string, any> = {}) {
  return { uid, dex, steps: 0, evos: 0, shiny: false, how: 'wild', place: '숲', at, gender: 'male', nature: 1, via: null, ball: 'poke-ball', metLevel: 10, workMs: 0, ...extra }
}

/** A saved game: party first, then box; caught/seen filled from the individuals */
function game(party: any[], box: any[] = [], extra: Record<string, any> = {}) {
  const mons: Record<string, any> = {}
  const caught: Record<string, any> = {}
  const seen: Record<string, number> = {}
  for (const m of [...party, ...box]) {
    mons[m.uid] = m
    const c = caught[m.dex]
    if (c) { c.count++; c.lastAt = Math.max(c.lastAt, m.at) } else caught[m.dex] = { count: 1, firstAt: m.at, lastAt: m.at, place: m.place, how: m.how, shiny: m.shiny, ball: m.ball }
    seen[m.dex] = (seen[m.dex] ?? 0) + 1
  }
  const nums = Object.keys(mons).map(u => Number(u.slice(1)))
  return {
    version: 2,
    caught, seen,
    trainer: { starter: 1, since: T0 },
    mons,
    party: party.map(m => m.uid),
    box: box.map(m => m.uid),
    assign: {}, projects: {},
    nextUid: (nums.length ? Math.max(...nums) : 0) + 1,
    encounters: 0, sinceLegend: 0, sinceMythical: 0,
    attendedOn: null,
    log: [],
    ...extra,
  }
}

/** The individuals as a set of comparable facts (uids can be renamed) */
const individuals = (g: any) => Object.values(g.mons).map((m: any) => `${m.dex}@${m.at}`).sort()

/** The invariants every merge result keeps */
function expectValid(g: any) {
  expect(g.party).toEqual([])
  expect(new Set(g.box).size).toBe(g.box.length)
  for (const u of g.box) expect(g.mons[u]).toBeTruthy()
  // every individual is in the box exactly once
  expect([...g.box].sort()).toEqual(Object.keys(g.mons).sort())
  expect(g.box.length).toBeLessThanOrEqual(BOX_LIMIT)
  for (const [u, m] of Object.entries<any>(g.mons)) expect(m.uid).toBe(u)
  for (const u of Object.values(g.assign)) expect(g.mons[u as string]).toBeTruthy()
  const n = Math.max(0, ...Object.keys(g.mons).map(u => Number(u.slice(1))))
  expect(g.nextUid).toBeGreaterThan(n)
}

// Two PCs of one trainer: they shared m1..m3 at the last sync, then each
// caught different Pokémon under the same next uids (m4, m5).
const shared = [mon('m1', 1, T0, { how: 'starter', steps: 50, workMs: 3_600_000 }), mon('m2', 10, T0 + 1), mon('m3', 16, T0 + 2)]
function twoPCs() {
  const a = game(shared.slice(0, 2), [shared[2], mon('m4', 19, T0 + DAY), mon('m5', 21, T0 + DAY + 5)], { encounters: 40, sinceLegend: 30 })
  const b = game(shared.slice(0, 2), [shared[2], mon('m4', 23, T0 + 2 * DAY)], { encounters: 55, sinceLegend: 3, attendedOn: '2026-01-03' })
  return { a: structuredClone(a), b: structuredClone(b) }
}

describe('mergeGames: individuals', () => {
  it('unions both PCs\' individuals; a uid both PCs used for different catches is kept by the earlier one, the other gets a fresh uid', () => {
    const { a, b } = twoPCs()
    const m = mergeGames(a, b)
    expectValid(m)
    expect(individuals(m)).toEqual([...individuals(a), '23@' + (T0 + 2 * DAY)].sort())
    // m4 was caught first on A: A's keeps it; B's m4 is renamed past both counters
    expect(m.mons.m4.dex).toBe(19)
    const renamed = Object.values<any>(m.mons).find(x => x.dex === 23)
    expect(renamed.uid).toBe('m6')
    expect(renamed.originUid).toBe('m4')
    expect(m.nextUid).toBe(7)
    expect(m.box).toContain('m6')
  })

  it('gives the same individuals and Pokédex whichever side is passed first, and leaves its inputs alone', () => {
    const { a, b } = twoPCs()
    const before = structuredClone([a, b])
    const ab = mergeGames(a, b)
    const ba = mergeGames(b, a)
    expect(ab.mons).toEqual(ba.mons)
    expect(ab.caught).toEqual(ba.caught)
    expect(ab.seen).toEqual(ba.seen)
    expect(ab.nextUid).toBe(ba.nextUid)
    expect([a, b]).toEqual(before)
  })

  it('the same individual on both sides keeps its furthest progress: higher level (work time), more steps, its evolution', () => {
    const base = mon('m1', 4, T0, { how: 'starter' })
    const a = game([{ ...base, steps: 300, workMs: 9 * 3_600_000 }])
    const b = game([{ ...base, dex: 5, evos: 1, steps: 200, workMs: 5 * 3_600_000, gender: null }])
    for (const m of [mergeGames(a, b), mergeGames(b, a)]) {
      expect(Object.keys(m.mons)).toEqual(['m1'])
      expect(m.mons.m1).toMatchObject({ dex: 5, evos: 1, steps: 300, workMs: 9 * 3_600_000, gender: 'male', at: T0 })
      expect(m.mons.m1.originUid).toBeUndefined()
    }
  })

  it('recognises an individual renamed by an earlier merge on the PC that still has it under its old uid', () => {
    const { a, b } = twoPCs()
    const cloud = mergeGames(a, b) // A synced: B's m4 is m6 in the cloud
    const onB = mergeGames(b, cloud) // B syncs later
    expectValid(onB)
    expect(individuals(onB)).toEqual(individuals(cloud))
    expect(onB.mons).toEqual(cloud.mons)
    // B's old party leads the box, and everything points at the merged uids
    expect(onB.party).toEqual([])
    expect(onB.box.slice(0, 2)).toEqual(['m1', 'm2'])
    expect(onB.box).toContain('m6')
    expect(onB.box).not.toContain(undefined)
  })
})

describe('mergeGames: no party', () => {
  it("a 1.5.4 copy's party joins the box; this PC's folded box keeps its order first", () => {
    const [m1, m2, m3] = [mon('m1', 1, T0), mon('m2', 10, T0 + 1), mon('m3', 16, T0 + 2)]
    const here = game([], [m3, m1, m2]) // 1.6.0: the party was folded into the box
    const old = game([mon('m4', 19, T0 + DAY), m1], [m2, m3, mon('m5', 21, T0 + 2 * DAY)]) // 1.5.4
    for (const m of [mergeGames(here, old), mergeGames(here, mergeGames(here, old))]) {
      expectValid(m)
      expect(m.box).toEqual(['m3', 'm1', 'm2', 'm4', 'm5'])
    }
    // the other way round: the 1.5.4 copy's party leads, then its box, then this one's
    const back = mergeGames(old, here)
    expectValid(back)
    expect(back.box).toEqual(['m4', 'm1', 'm2', 'm3', 'm5'])
    expect(back.mons).toEqual(mergeGames(here, old).mons)
  })

  it('both sides with a party (an old merge): both go to the box front, local first, each once', () => {
    const [m1, m2, m3] = [mon('m1', 1, T0), mon('m2', 10, T0 + 1), mon('m3', 16, T0 + 2)]
    const a = game([m1, m2], [m3, mon('m4', 19, T0 + 3)])
    // one of A's individuals is in neither list: it still joins, after the lists, by catch time
    a.mons.m7 = mon('m7', 25, T0 - 1)
    a.nextUid = 8
    const b = game([mon('m6', 23, T0 + DAY), m3, m1], [m2, mon('m5', 21, T0 + 4)])
    const m = mergeGames(a, b)
    expectValid(m)
    expect(m.box).toEqual(['m1', 'm2', 'm3', 'm4', 'm6', 'm5', 'm7'])
    const ba = mergeGames(b, a)
    expectValid(ba)
    expect(ba.box).toEqual(['m6', 'm3', 'm1', 'm2', 'm5', 'm4', 'm7'])
    expect(ba.mons).toEqual(m.mons)
  })

  it('a broken party is cleaned: no repeats, no missing uids; past six, the rest still join the box', () => {
    const mons = Array.from({ length: 8 }, (_, i) => mon(`m${i + 1}`, 10 + i, T0 + i))
    const a = game(mons.slice(0, 6), mons.slice(6))
    a.party = ['m1', 'm1', 'm99', 'm2', 'm3', 'm4', 'm5', 'm6', 'm7']
    a.box = ['m8']
    const m = mergeGames(a, game([mons[0]]))
    expectValid(m)
    expect(m.box).toEqual(['m1', 'm2', 'm3', 'm4', 'm5', 'm6', 'm8', 'm7'])
  })

  it('this PC\'s session assignments follow renamed uids and never point at nothing', () => {
    const { a, b } = twoPCs()
    b.party = ['m1', 'm4']
    b.box = ['m2', 'm3']
    b.assign = { s1: 'm4', s2: 'm77' }
    b.projects = { s1: 'proj' }
    const m = mergeGames(b, a)
    expectValid(m)
    expect(m.box.slice(0, 2)).toEqual(['m1', 'm6'])
    expect(m.assign).toEqual({ s1: 'm6' })
    expect(m.projects).toEqual({ s1: 'proj' })
  })

  it('a new PC signing in: every individual of both sides in the box, the older trainer kept', () => {
    const old = game([mon('m1', 7, T0, { how: 'starter', steps: 900, workMs: 50 * 3_600_000 }), mon('m2', 10, T0, { how: 'gift', steps: 20 })], [mon('m3', 16, T0 + DAY)])
    const freshSix = Array.from({ length: 6 }, (_, i) => mon(`m${i + 1}`, 19 + 2 * i, T0 + 30 * DAY, { how: i ? 'gift' : 'starter', place: '여행의 시작' }))
    const fresh = game([], freshSix, { trainer: { starter: 19, since: T0 + 30 * DAY } }) // 1.6.0: the gift is in the box
    const m = mergeGames(fresh, old)
    expectValid(m)
    expect(m.trainer).toEqual(old.trainer)
    expect(Object.keys(m.mons)).toHaveLength(9) // 3 old + the fresh six, all kept
    expect(m.box.map((u: string) => m.mons[u].dex)).toEqual([19, 21, 23, 25, 27, 29, 7, 10, 16])
    // and the old PC keeps its own order first when it merges the new PC's upload
    const back = mergeGames(old, m)
    expectValid(back)
    expect(back.box.map((u: string) => back.mons[u].dex)).toEqual([7, 10, 16, 19, 21, 23, 25, 27, 29])
    expect(back.mons).toEqual(m.mons)
  })

  it('outAt: the later copy wins', () => {
    const base = mon('m1', 4, T0, { how: 'starter' })
    // A's copy is further along (more steps), so it is the base; B's later outAt still wins
    const a = game([], [{ ...base, outAt: T0 + 5 * DAY, steps: 10 }])
    const b = game([], [{ ...base, outAt: T0 + 9 * DAY }])
    const none = game([], [base])
    for (const m of [mergeGames(a, b), mergeGames(b, a)]) expect(m.mons.m1.outAt).toBe(T0 + 9 * DAY)
    for (const m of [mergeGames(a, none), mergeGames(none, a)]) expect(m.mons.m1.outAt).toBe(T0 + 5 * DAY)
    expect(mergeGames(none, none).mons.m1.outAt).toBeUndefined()
    expect(mergeGames(a, b).mons).toEqual(mergeGames(b, a).mons)
  })
})

describe('mergeGames: box limit', () => {
  it("past BOX_LIMIT the newest catches go to the professor: kept in the Pokédex and the log, never a member of either side's party", () => {
    const party = [mon('m1', 1, T0)]
    const boxA = Array.from({ length: BOX_LIMIT - 3 }, (_, i) => mon(`m${i + 2}`, 10, T0 + 10 + i))
    // A (a 1.5.4 copy) has a party member newer than every catch but B's party member
    const aParty = mon('m1199', 149, T0 + 15 * DAY)
    const a = game([party[0], aParty], boxA)
    // B shares m1..m3, and has five newer catches of its own (uids A also used)
    // plus a party member that is the very newest
    const newer = Array.from({ length: 5 }, (_, i) => mon(`m${i + 4}`, 151, T0 + 10 * DAY + i))
    const bParty = mon('m9', 150, T0 + 20 * DAY)
    const b = game([party[0], bParty], [boxA[0], boxA[1], ...newer])
    const m = mergeGames(a, b)
    expectValid(m)
    expect(m.box).toHaveLength(BOX_LIMIT)
    // 2 + 1197 + 5 + 1 = 1205 individuals, the box holds 1200: five go
    expect(Object.keys(m.mons)).toHaveLength(BOX_LIMIT)
    const gone = m.log.filter((e: any) => e.kind === 'professor')
    expect(gone).toHaveLength(5)
    expect(gone.every((e: any) => e.id === 151 && e.toProfessor)).toBe(true)
    // both parties' members stay, though they are the newest of all
    expect(Object.values<any>(m.mons).some(x => x.dex === 150)).toBe(true)
    expect(Object.values<any>(m.mons).some(x => x.dex === 149)).toBe(true)
    expect(m.box.slice(0, 2)).toEqual(['m1', 'm1199'])
    // the species stays caught, its first catch kept
    expect(m.caught[151]).toMatchObject({ count: 5, firstAt: T0 + 10 * DAY })
    // and merging again sends no one else away
    const again = mergeGames(a, m)
    expect(again).toEqual(m)
  })
})

describe('mergeGames: box limit never evicts what this PC holds', () => {
  // A 1.5.4 PC with a full box and a party of six: 1206 individuals. The
  // party members are the oldest, so the newest catches are box members.
  const all = Array.from({ length: BOX_LIMIT + 6 }, (_, i) => mon(`m${i + 1}`, 10, T0 + i))
  const cloud154 = () => structuredClone(game(all.slice(0, 6), all.slice(6)))
  // The same PC on 1.6.0 after its load folded the party into the box
  const folded = () => structuredClone(game([], all))
  const professorLog = (g: any) => g.log.filter((e: any) => e.kind === 'professor')

  it('a folded 1206 against its 1.5.4 cloud copy (box 1200 + party 6) keeps all 1206, no one to the professor', () => {
    const m = mergeGames(folded(), cloud154())
    expect(Object.keys(m.mons)).toHaveLength(BOX_LIMIT + 6)
    expect(individuals(m)).toEqual(individuals(folded()))
    expect(m.box).toHaveLength(BOX_LIMIT + 6)
    expect(new Set(m.box).size).toBe(m.box.length)
    expect(m.party).toEqual([])
    expect(professorLog(m)).toEqual([])
  })

  it('a folded 1206 against itself keeps all 1206, no one to the professor', () => {
    const m = mergeGames(folded(), folded())
    expect(Object.keys(m.mons)).toHaveLength(BOX_LIMIT + 6)
    expect(individuals(m)).toEqual(individuals(folded()))
    expect(professorLog(m)).toEqual([])
    expect(sameGame(mergeGames(m, m), m)).toBe(true)
  })

  it('past the limit only individuals new to this PC go to the professor', () => {
    const extra = Array.from({ length: 3 }, (_, i) => mon(`m${BOX_LIMIT + 7 + i}`, 151, T0 + 30 * DAY + i))
    const other = structuredClone(game([], [...all, ...extra]))
    const m = mergeGames(folded(), other)
    expect(Object.keys(m.mons)).toHaveLength(BOX_LIMIT + 6)
    expect(individuals(m)).toEqual(individuals(folded()))
    expect(professorLog(m).map((e: any) => e.id)).toEqual([151, 151, 151])
    expect(m.caught[151]).toMatchObject({ count: 3 })
    // the merge stays pure and idempotent
    expect(mergeGames(folded(), other)).toEqual(m)
    expect(mergeGames(m, other)).toEqual(m)
  })

  it('1.5.4 save -> load (fold) -> sync with the 1.5.4 cloud copy -> sync with its own copy: the count never drops', () => {
    const dir = mkdtempSync(join(tmpdir(), 'merge-roundtrip-'))
    afterAll(() => rmSync(dir, { recursive: true, force: true }))
    const file = join(dir, 'pokedex.json')
    writeFileSync(file, JSON.stringify(cloud154()))
    const species = [{ id: 1, ko: '이상해씨', types: ['grass'], tier: 'rare', captureRate: 45, evolvesFrom: null }, { id: 10, ko: '캐터피', types: ['bug'], tier: 'common', captureRate: 255, evolvesFrom: null }]
    const dex = createPokedex({ file, species, broadcast: () => {}, random: () => 0.99, now: () => T0 + 60 * DAY })
    const count = () => Object.keys(dex.exportState().mons).length
    expect(count()).toBe(BOX_LIMIT + 6)
    expect(dex.exportState().party).toEqual([])
    // first sync on 1.6.0: the cloud still has the 1.5.4 copy
    const first = mergeGames(structuredClone(dex.exportState()), cloud154())
    expect(Object.keys(first.mons)).toHaveLength(BOX_LIMIT + 6)
    expect(dex.importState(first)).toBe(true)
    expect(count()).toBe(BOX_LIMIT + 6)
    // every later sync: the cloud has this PC's own folded copy
    const own = structuredClone(dex.exportState())
    const second = mergeGames(structuredClone(dex.exportState()), own)
    expect(Object.keys(second.mons)).toHaveLength(BOX_LIMIT + 6)
    expect(dex.importState(second)).toBe(true)
    expect(count()).toBe(BOX_LIMIT + 6)
    expect(professorLog(dex.exportState())).toEqual([])
    dex.flush()
  })
})

describe('mergeGames: Pokédex', () => {
  it('seen and caught are either side\'s; first catch is the earlier one (with its place), last the later; counts take the larger side; shiny is either', () => {
    const a = game([mon('m1', 1, T0)])
    const b = game([mon('m1', 1, T0)])
    a.caught = { 1: { count: 3, firstAt: T0 + 100, lastAt: T0 + 500, place: 'A숲', how: 'wild', shiny: false }, 4: { count: 1, firstAt: T0, lastAt: T0, place: 'A', shiny: false } }
    b.caught = { 1: { count: 2, firstAt: T0 + 50, lastAt: T0 + 900, place: 'B동굴', how: 'pity', shiny: true }, 7: { count: 1, firstAt: T0, lastAt: T0, place: 'B', shiny: false } }
    a.seen = { 1: 5, 4: 1, 25: 2 }
    b.seen = { 1: 3, 7: 1, 25: 4 }
    for (const m of [mergeGames(a, b), mergeGames(b, a)]) {
      expect(Object.keys(m.caught).sort()).toEqual(['1', '4', '7'])
      expect(m.caught[1]).toEqual({ count: 3, firstAt: T0 + 50, lastAt: T0 + 900, place: 'B동굴', how: 'pity', shiny: true })
      expect(m.seen).toEqual({ 1: 5, 4: 1, 7: 1, 25: 4 })
    }
  })

  it('counts are not added up: syncing the same catches again does not count them twice', () => {
    const { a, b } = twoPCs()
    const m1 = mergeGames(a, b)
    const m2 = mergeGames(m1, mergeGames(b, m1))
    expect(m2.caught).toEqual(m1.caught)
    expect(m2.seen).toEqual(m1.seen)
  })
})

describe('mergeGames: the other fields', () => {
  it('monotonic counters take the larger side; luck, projects and today\'s count stay this PC\'s; unknown fields keep this PC\'s value', () => {
    const { a, b } = twoPCs()
    Object.assign(a, { daily: { day: '2026-01-02', catches: 4 }, thrownAt: { s: 1 }, futureA: 'mine', both: 'local' })
    Object.assign(b, { daily: { day: '2026-01-03', catches: 9 }, futureB: 'theirs', both: 'remote', version: 2 })
    const m = mergeGames(a, b)
    expect(m.encounters).toBe(55)
    expect(m.attendedOn).toBe('2026-01-03')
    expect(m.sinceLegend).toBe(30)
    expect(m.daily).toEqual({ day: '2026-01-02', catches: 4 })
    expect(m.thrownAt).toEqual({ s: 1 })
    expect(m.futureA).toBe('mine')
    expect(m.futureB).toBe('theirs')
    expect(m.both).toBe('local')
    expect(m.version).toBe(2)
  })

  it('the log keeps both PCs\' events once, oldest first, with renamed uids', () => {
    const { a, b } = twoPCs()
    const common = { kind: 'catch', id: 16, uid: 'm3', at: T0 + 2 }
    a.log = [common, { kind: 'catch', id: 19, uid: 'm4', at: T0 + DAY }]
    b.log = [common, { kind: 'catch', id: 23, uid: 'm4', at: T0 + 2 * DAY }]
    const m = mergeGames(a, b)
    expect(m.log).toEqual([common, { kind: 'catch', id: 19, uid: 'm4', at: T0 + DAY }, { kind: 'catch', id: 23, uid: 'm6', at: T0 + 2 * DAY }])
  })

  it('ignores a side that is not a version-2 game', () => {
    const { a } = twoPCs()
    expect(mergeGames(a, null)).toEqual(a)
    expect(mergeGames(a, { version: 1, caught: { 999: {} } })).toEqual(a)
    expect(mergeGames(undefined, a)).toEqual(a)
  })
})

describe('mergeGames: idempotence', () => {
  it('merge(a, merge(a, b)) equals merge(a, b), and merging the result with either side again changes nothing', () => {
    const { a, b } = twoPCs()
    a.log = [{ kind: 'catch', id: 19, uid: 'm4', at: T0 + DAY }]
    b.log = [{ kind: 'catch', id: 23, uid: 'm4', at: T0 + 2 * DAY }]
    a.assign = { s: 'm2' }
    const ab = mergeGames(a, b)
    expect(mergeGames(a, ab)).toEqual(ab)
    expect(sameGame(mergeGames(ab, b), ab)).toBe(true)
    expect(sameGame(mergeGames(ab, ab), ab)).toBe(true)
    const ba = mergeGames(b, a)
    expect(mergeGames(b, ba)).toEqual(ba)
    // the two PCs converge on the same individuals after each syncs once
    expect(mergeGames(b, ab).mons).toEqual(ab.mons)
  })
})

describe('released individuals', () => {
  const p = [mon('m1', 4, T0), mon('m2', 7, T0 + 1)]
  const kept = mon('m3', 25, T0 + DAY)
  const letGo = mon('m4', 16, T0 + 2 * DAY)
  const before = game(p, [kept, letGo])
  // This PC let m4 go after the last upload: the cloud copy still has it
  const after = game(p, [kept], { released: { [monKey(letGo)]: T0 + 3 * DAY } })

  it('a release sticks: the copy uploaded before it does not bring the Pokémon back', () => {
    const merged = mergeGames(after, before)
    expectValid(merged)
    expect(individuals(merged)).toEqual(individuals(after))
    expect(merged.released).toEqual(after.released)
  })

  it('the other PC drops it too on its next sync, and the release is remembered on both', () => {
    const cloud = mergeGames(after, before) // what this PC uploads
    const other = mergeGames(before, cloud) // the other PC still had m4
    expectValid(other)
    expect(Object.values(other.mons).some((m: any) => m.dex === 16)).toBe(false)
    expect(other.released).toEqual(after.released)
  })

  it('stays idempotent and order-free with releases', () => {
    const once = mergeGames(after, before)
    expect(sameGame(mergeGames(after, once), once)).toBe(true)
    expect(individuals(mergeGames(before, after))).toEqual(individuals(once))
  })
})
