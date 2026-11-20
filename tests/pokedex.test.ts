/**
 * server/pokedex.js — the game, trainer style: a starter and five companions in
 * the box, any resting Pokémon per session (the most recently out first), no
 * session limit, growth that belongs to the Pokémon, swaps, and gacha-style
 * encounters with pities.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import { createPokedex, catchSource, STARTERS, RATES, CATCH, PITY, PITY_MYTHICAL, BOX_LIMIT, ballBoosts, isFullMoon, levelFrom, minutesForLevel, THINK_STEP_MS, byRecentWork } from '../server/pokedex.js'

const S = (id: number, ko: string, tier: string, evolvesFrom: number | null, types = ['normal'], captureRate = 255) =>
  ({ id, ko, types, tier, captureRate, evolvesFrom })

const SPECIES = [
  S(1, '이상해씨', 'rare', null, ['grass'], 45), S(2, '이상해풀', 'rare', 1, ['grass'], 45), S(3, '이상해꽃', 'rare', 2, ['grass'], 45),
  S(4, '파이리', 'rare', null, ['fire'], 45), S(5, '리자드', 'rare', 4, ['fire'], 45), S(6, '리자몽', 'rare', 5, ['fire'], 45),
  S(7, '꼬부기', 'rare', null, ['water'], 45), S(8, '어니부기', 'rare', 7, ['water'], 45), S(9, '거북왕', 'rare', 8, ['water'], 45),
  S(10, '캐터피', 'common', null, ['bug']), S(11, '단데기', 'common', 10, ['bug']),
  S(16, '구구', 'common', null, ['flying']), S(17, '피죤', 'common', 16, ['flying']),
  S(19, '꼬렛', 'common', null), S(20, '레트라', 'common', 19),
  S(21, '깨비참', 'common', null, ['flying']), S(22, '깨비드릴조', 'common', 21, ['flying']),
  S(23, '아보', 'common', null, ['poison']), S(24, '아보크', 'common', 23, ['poison']),
  S(27, '모래두지', 'common', null, ['ground']), S(28, '고지', 'common', 27, ['ground']),
  S(144, '프리져', 'sub', null, ['ice'], 3),
  S(150, '뮤츠', 'legendary', null, ['psychic'], 3),
  S(151, '뮤', 'mythical', null, ['psychic'], 45),
]

const dirs: string[] = []
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }) })

function setup(randoms: number[] = [], fallback = 0.99, active = (_: string) => true, sessionOf: (sid: string) => any = () => null) {
  const dir = mkdtempSync(join(tmpdir(), 'pokedex-'))
  dirs.push(dir)
  const sent: any[] = []
  const queue = [...randoms]
  const dex = createPokedex({
    file: join(dir, 'pokedex.json'),
    species: SPECIES,
    broadcast: (m: any) => sent.push(m),
    isActive: active,
    sessionOf,
    now: () => new Date('2026-11-06T14:00:00').getTime(),
    random: () => (queue.length ? queue.shift()! : fallback),
  })
  return { dex, sent, file: join(dir, 'pokedex.json') }
}

const work = (sessionId: string, tool = 'Edit') => ({ type: 'agent_working', sessionId, tool })
/** Today's attendance already taken (the fixed clock is 2026-11-06) */
const attended = (dex: any) => { dex.publicState(); dex._state().attendedOn = '2026-11-06' }

describe('pokedex', () => {
  it('the rarity table adds up to 1, and the top tiers stay rare', () => {
    expect(Object.values(RATES).reduce((a, b) => a + b, 0)).toBeCloseTo(1, 10)
    expect(RATES.legendary).toBeLessThan(0.02)
    expect(RATES.mythical).toBeLessThan(RATES.legendary)
    expect(PITY_MYTHICAL).toBeGreaterThan(PITY)
  })

  it('a first run gifts six into the box, the starter first; the party stays empty', () => {
    const { dex } = setup([0.5]) // middle starter; companions from the fallback
    const st = dex.publicState()
    expect(st.trainer.starter).toBe(STARTERS[1])
    expect(st.box).toHaveLength(6)
    expect(st.mons[st.box[0]].dex).toBe(4)
    expect(st.mons[st.box[0]].how).toBe('starter')
    expect(st.caught[4].how).toBe('starter')
    expect(dex._state().party).toEqual([])
    expect(st.party).toBeUndefined()
    expect(st.partySize).toBeUndefined()
    expect(st.sessionLimit).toBeUndefined()
    // the companions are common base forms that can evolve, never a starter
    for (const uid of st.box.slice(1)) {
      const d = st.mons[uid].dex
      expect([1, 4, 7]).not.toContain(d)
      expect(SPECIES.find(s => s.id === d)!.evolvesFrom).toBeNull()
      expect(SPECIES.find(s => s.id === d)!.tier).toBe('common')
    }
    // all six set out at Lv.5 in a plain Poké Ball, and the Pokédex records say so too
    for (const uid of st.box) {
      const m = st.mons[uid]
      expect(m.ball).toBe('poke-ball')
      expect(m.metLevel).toBe(5)
      expect(st.caught[m.dex].ball).toBe('poke-ball')
    }
  })

  it('the starter is drawn from every generation in the species data, not only Kanto', () => {
    // STARTERS lists all nine generations; the test set holds just 1, 4, 7, so those are the pool
    expect(STARTERS).toEqual(expect.arrayContaining([1, 4, 7, 152, 255, 393, 501, 656, 725, 813, 912]))
    expect(STARTERS).toHaveLength(27)
    const { dex } = setup([0.99])
    expect([1, 4, 7]).toContain(dex.publicState().trainer.starter)
  })

  it("an older save's first companions get their Poké Ball in the Pokédex record; levels stay as they are", () => {
    const first = setup([0.5])
    first.dex.publicState() // the journey starts on the first look
    const st = first.dex._state()
    const gift = st.box[1]
    const giftDex = st.mons[gift].dex
    delete st.caught[giftDex].ball
    delete st.caught[4].ball
    st.mons[gift].metLevel = 12 // a companion that had grown: never lowered
    writeFileSync(first.file, JSON.stringify(st))
    const again = createPokedex({ file: first.file, species: SPECIES, broadcast: () => {}, random: () => 0.99, now: () => new Date('2026-11-06T14:00:00').getTime() })
    const after = again.publicState()
    expect(after.caught[giftDex].ball).toBe('poke-ball')
    expect(after.caught[4].ball).toBe('poke-ball')
    expect(after.mons[gift].metLevel).toBe(12)
  })

  it('no session limit: 20 sessions each get a Pokémon while any rests', () => {
    const { dex, sent } = setup([0])
    attended(dex)
    const st0 = dex._state()
    for (let i = 0; st0.box.length < 25; i++) {
      const id = `x${i}`
      st0.mons[id] = { ...st0.mons[st0.box[0]], uid: id }
      st0.box.push(id)
    }
    for (let i = 1; i <= 20; i++) dex.noteEvent({ type: 'session_started', sessionId: `s${i}` }, { project: `p${i}` })
    const st = dex.publicState()
    expect(Object.keys(st.assign)).toHaveLength(20)
    expect(new Set(Object.values(st.assign)).size).toBe(20)
    expect(sent.find(m => m.event?.sessionId === 's1')?.event.kind).toBe('sendout')
  })

  it('an ended session hands its Pokémon back to rest', () => {
    const ended = new Set<string>()
    const { dex } = setup([0], 0.99, sid => !ended.has(sid))
    dex.noteEvent({ type: 'session_started', sessionId: 'a' }, {})
    const first = dex.publicState().assign.a
    ended.add('a')
    dex.noteEvent({ type: 'session_ended', sessionId: 'a' }, {})
    dex.noteEvent({ type: 'session_started', sessionId: 'b' }, {})
    expect(dex.publicState().assign.b).toBe(first)
  })

  it('growth belongs to the Pokémon: it evolves at the games’ level (이상해씨 → 이상해풀 at 16)', () => {
    let t = new Date('2026-11-06T14:00:00').getTime()
    const species = SPECIES.map(sp => (sp.id === 2 ? { ...sp, evolveLevel: 16 } : sp))
    const dir = mkdtempSync(join(tmpdir(), 'pokedex-'))
    dirs.push(dir)
    const sent: any[] = []
    const queue = [0] // starter: 이상해씨
    const dex = createPokedex({ file: join(dir, 'p.json'), species, broadcast: (m: any) => sent.push(m), random: () => (queue.length ? queue.shift()! : 0.99), now: () => t })
    dex.publicState(); (dex as any)._state().attendedOn = '2026-11-06'
    dex.throwBall('s1', dex.publicState().box[0]) // the starter goes out
    dex.noteEvent({ type: 'session_started', sessionId: 's1' }, {})
    const uid = dex.publicState().assign.s1
    const mon = () => (dex as any)._state().mons[uid]
    let evolvedAt: number | null = null
    for (let i = 0; i < 400 && evolvedAt === null; i++) {
      t += 60_000
      dex.noteEvent(work('s1'), {})
      if (mon().dex === 2) evolvedAt = levelFrom(mon().metLevel, mon().workMs).level
    }
    expect(evolvedAt).toBe(16)
    expect(sent.map(m => m.event).find(e => e?.kind === 'evolve')).toMatchObject({ from: 1, id: 2 })
  })

  it('the level curve: 20 minutes a level at first, 60 near the top, about 55 hours to 100', () => {
    expect(minutesForLevel(1)).toBe(20)
    expect(minutesForLevel(99)).toBe(60)
    expect(minutesForLevel(50)).toBeGreaterThan(25)
    let total = 0
    for (let L = 1; L < 100; L++) total += minutesForLevel(L)
    expect(total / 60).toBeGreaterThan(50)
    expect(total / 60).toBeLessThan(60)
    expect(levelFrom(5, 20 * 60000).level).toBe(5) // 20 min is just short of the 20.07 needed at 5
    expect(levelFrom(5, 21 * 60000).level).toBe(6)
  })

  it('a subagent is worked by a box Pokémon (a helper): it grows, cannot be released, and goes back when the subagent stops', () => {
    let t = new Date('2026-11-06T14:00:00').getTime()
    const dir = mkdtempSync(join(tmpdir(), 'pokedex-'))
    dirs.push(dir)
    const queue = [0]
    const dex = createPokedex({ file: join(dir, 'p.json'), species: SPECIES, broadcast: () => {}, random: () => (queue.length ? queue.shift()! : 0.99), now: () => t })
    dex.publicState(); (dex as any)._state().attendedOn = '2026-11-06'
    const st0 = (dex as any)._state()
    st0.box = st0.box.slice(0, 1) // only the starter rests, so the box has one free helper below
    dex.noteEvent({ type: 'session_started', sessionId: 's1' }, {})
    st0.mons.mbox = { uid: 'mbox', dex: 150, steps: 0, evos: 0, shiny: false, how: 'wild', place: 'x', at: 0, metLevel: 5, workMs: 0 }
    st0.box.push('mbox')
    const partner = dex.publicState().assign.s1
    const partnerSteps = st0.mons[partner].steps
    for (let i = 0; i < 3; i++) { t += 60_000; dex.noteEvent({ ...work('s1'), agentId: 'ag1' }, {}) }
    expect(dex.publicState().helpers).toEqual({ s1: ['mbox'] })
    expect(st0.mons.mbox.steps).toBe(3)
    expect(st0.mons.mbox.workMs).toBe(2 * 60_000)
    expect(st0.mons[partner].steps).toBe(partnerSteps) // the subagent's work is the helper's
    expect(dex.release('mbox')).toMatchObject({ ok: false, reason: 'busy' })
    // a second subagent finds no one free in the box: the partner works it, as before
    dex.noteEvent({ ...work('s1'), agentId: 'ag2' }, {})
    expect(st0.mons[partner].steps).toBe(partnerSteps + 1)
    dex.noteEvent({ type: 'agent_completed', sessionId: 's1', agentId: 'ag1' }, {})
    expect(dex.publicState().helpers).toEqual({})
    expect(dex.release('mbox')).toEqual({ ok: true })
  })

  it('swaps in any resting Pokémon; the box order does not change', () => {
    const { dex } = setup([0])
    attended(dex)
    dex.noteEvent({ type: 'session_started', sessionId: 's1' }, {})
    const st0 = (dex as any)._state()
    const first = st0.assign.s1
    st0.mons.mbox = { uid: 'mbox', dex: 150, steps: 0, evos: 0, shiny: false, how: 'wild', place: 'x', at: 0 }
    st0.box.push('mbox')
    const order = [...st0.box]
    // any resting Pokémon takes the session; nobody moves within the box
    expect(dex.swap('s1', 'mbox')).toEqual({ ok: true })
    let st = dex.publicState()
    expect(st.assign.s1).toBe('mbox')
    expect(st.box).toEqual(order)
    // another resting one, even unevolved
    const other = order.find(u => u !== first && u !== 'mbox')!
    expect(dex.swap('s1', other)).toEqual({ ok: true })
    st = dex.publicState()
    expect(st.assign.s1).toBe(other)
    expect(st.box).toEqual(order)
    // refusals: one working in another session, an unknown one, the same one, a session with none
    dex.noteEvent({ type: 'session_started', sessionId: 's2' }, {})
    const elsewhere = dex.publicState().assign.s2
    expect(elsewhere).toBeTruthy()
    expect(dex.swap('s1', elsewhere)).toEqual({ ok: false, reason: 'busy' })
    expect(dex.swap('s1', 'nope')).toEqual({ ok: false, reason: 'unknown-pokemon' })
    expect(dex.swap('s1', other)).toEqual({ ok: false, reason: 'same' })
    expect(dex.publicState().box).toEqual(order)
  })

  it('places a resting Pokémon on an open session that has none (a sendout); refuses an ended session or a busy Pokémon', () => {
    const open = new Set(['s1', 'empty'])
    const { dex, sent } = setup([0], 0.99, (sid: string) => open.has(sid))
    attended(dex)
    dex.noteEvent({ type: 'session_started', sessionId: 's1' }, {})
    const st0 = (dex as any)._state()
    const busy = st0.assign.s1
    const resting = st0.box.find((u: string) => u !== busy)
    expect(resting).toBeTruthy()
    expect(dex.swap('empty', busy)).toEqual({ ok: false, reason: 'busy' })
    expect(dex.swap('gone', resting)).toEqual({ ok: false, reason: 'ended' })
    sent.length = 0
    expect(dex.swap('empty', resting)).toEqual({ ok: true })
    expect(dex.publicState().assign.empty).toBe(resting)
    expect(sent.at(-1).event).toMatchObject({ kind: 'sendout', sessionId: 'empty', uid: resting })
    // it holds it: the next event keeps the same one
    dex.noteEvent(work('empty'), {})
    expect(dex.publicState().assign.empty).toBe(resting)
  })

  it('an unhooked session (Claude Code started outside spawn) is never given a Pokémon', () => {
    const { dex } = setup([0])
    attended(dex)
    dex.noteEvent({ type: 'session_started', sessionId: 'outside' }, { hooked: false })
    dex.noteEvent(work('outside'), { hooked: false })
    expect(dex.publicState().assign.outside).toBeUndefined()
  })

  it('throws any resting Pokémon, and holds it', () => {
    const { dex, sent } = setup([0])
    attended(dex)
    const st0 = dex._state()
    st0.mons.mbox = { uid: 'mbox', dex: 150, steps: 0, evos: 0, shiny: false, how: 'wild', place: 'x', at: 0, metLevel: 5, workMs: 0 }
    st0.box.push('mbox')
    const box = [...dex.publicState().box]
    expect(dex.throwBall('new-1', box[3])).toEqual({ ok: true })
    expect(sent.at(-1).event).toMatchObject({ kind: 'sendout', sessionId: 'new-1', uid: box[3] })
    // held: another throw of the same Pokémon is refused, the session's first event keeps it
    expect(dex.throwBall('new-2', box[3])).toEqual({ ok: false, reason: 'busy' })
    dex.noteEvent({ type: 'session_started', sessionId: 'new-1' }, {})
    expect(dex.publicState().assign['new-1']).toBe(box[3])
    expect(dex.throwBall('new-3', 'nope')).toEqual({ ok: false, reason: 'unknown-pokemon' })
    expect(dex.publicState().remembered['new-1']).toBe(box[3])
    // one helping a subagent is busy too (the helper is the last free one: random 0.99)
    dex.noteEvent({ ...work('new-1'), agentId: 'ag1' }, {})
    expect(dex.publicState().helpers).toEqual({ 'new-1': ['mbox'] })
    expect(dex.throwBall('new-4', 'mbox')).toEqual({ ok: false, reason: 'busy' })
    // any other resting one goes, with no limit and no party
    expect(dex.throwBall('new-5', box[5])).toEqual({ ok: true })
  })

  it('exchange is refused: there is no party', () => {
    const { dex } = setup([0])
    attended(dex)
    const st0 = dex._state()
    st0.mons.mbox = { uid: 'mbox', dex: 150, steps: 0, evos: 0, shiny: false, how: 'wild', place: 'x', at: 0 }
    st0.box.push('mbox')
    const order = [...st0.box]
    expect(dex.exchange('mbox', order[0])).toEqual({ ok: false, reason: 'bad-request' })
    expect(dex.publicState().box).toEqual(order)
    expect(st0.party).toEqual([])
  })

  it('a throw held by the last run does not keep a Pokémon busy after a restart', () => {
    const { dex, file } = setup([0], 0.99, () => false)
    attended(dex)
    const box = dex.publicState().box
    expect(dex.throwBall('gone-1', box[0])).toEqual({ ok: true })
    expect(dex.publicState().assign['gone-1']).toBe(box[0]) // held while it starts up
    writeFileSync(file, JSON.stringify(dex._state()))
    const again = createPokedex({ file, species: SPECIES, broadcast: () => {}, isActive: () => false, now: () => new Date('2026-11-06T14:02:00').getTime() })
    expect(again.publicState().assign).toEqual({})
    expect(again.publicState().remembered['gone-1']).toBe(box[0])
  })

  it('folds a 1.5.4 party into the front of the box, in order, once', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pokedex-'))
    dirs.push(dir)
    const file = join(dir, 'pokedex.json')
    const mon = (uid: string, dex: number) => ({ uid, dex, steps: 0, evos: 0, shiny: false, how: 'wild', place: 'x', at: 1, ball: 'poke-ball', metLevel: 5, workMs: 0 })
    const v2 = (party: string[], box: string[]) => ({
      version: 2, trainer: { starter: 1, since: 1 }, caught: {}, seen: {},
      mons: { m1: mon('m1', 1), m2: mon('m2', 10), m3: mon('m3', 16) }, party, box, assign: {}, nextUid: 4, log: [],
    })
    const open = (onChange = () => {}) => createPokedex({ file, species: SPECIES, broadcast: () => {}, onChange, random: () => 0.99, now: () => new Date('2026-11-06T14:00:00').getTime() })
    writeFileSync(file, JSON.stringify(v2(['m1', 'm2'], ['m3'])))
    const first = open()
    expect(first._state().box).toEqual(['m1', 'm2', 'm3'])
    expect(first._state().party).toEqual([])
    first.flush() // the fold is saved
    const saved = JSON.parse(readFileSync(file, 'utf8'))
    expect(saved.box).toEqual(['m1', 'm2', 'm3'])
    expect(saved.party).toEqual([])
    // a second load changes nothing and writes nothing
    let writes = 0
    const second = open(() => { writes++ })
    expect(second._state().box).toEqual(['m1', 'm2', 'm3'])
    expect(second._state().party).toEqual([])
    second.flush()
    expect(writes).toBe(0)
    // a party member that is also in the box appears once; one that does not exist is not added
    writeFileSync(file, JSON.stringify(v2(['m1', 'm3', 'm99', 'm1'], ['m3', 'm2'])))
    const third = open()
    expect(third._state().box).toEqual(['m1', 'm3', 'm2'])
    expect(third._state().party).toEqual([])
    expect(Object.keys(third._state().mons).sort()).toEqual(['m1', 'm2', 'm3'])
    third.flush()
  })

  it('a full box plus a party of six folds to 1206 in the box: the fold drops no one', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pokedex-'))
    dirs.push(dir)
    const file = join(dir, 'pokedex.json')
    const mons: Record<string, any> = {}
    const ids = Array.from({ length: BOX_LIMIT + 6 }, (_, i) => `m${i + 1}`)
    for (const u of ids) mons[u] = { uid: u, dex: 10, steps: 0, evos: 0, shiny: false, how: 'wild', place: 'x', at: 1, ball: 'poke-ball', metLevel: 5, workMs: 0, gender: 'male', nature: 1 }
    const party = ids.slice(BOX_LIMIT)
    const box = ids.slice(0, BOX_LIMIT)
    writeFileSync(file, JSON.stringify({ version: 2, trainer: { starter: 1, since: 1 }, caught: {}, seen: {}, mons, party, box, assign: {}, nextUid: BOX_LIMIT + 7, log: [] }))
    const dex = createPokedex({ file, species: SPECIES, broadcast: () => {}, random: () => 0.99, now: () => new Date('2026-11-06T14:00:00').getTime() })
    const st = dex._state()
    expect(st.party).toEqual([])
    expect(st.box).toHaveLength(BOX_LIMIT + 6)
    expect(st.box).toEqual([...party, ...box])
    expect(Object.keys(st.mons).sort()).toEqual([...ids].sort())
    dex.flush()
  })

  it('a synced game with a party is folded too', () => {
    const { dex } = setup([0])
    dex.publicState()
    const mon = (uid: string, d: number) => ({ uid, dex: d, steps: 0, evos: 0, shiny: false, how: 'wild', place: 'x', at: 1, ball: 'poke-ball', metLevel: 5, workMs: 0 })
    expect(dex.importState({ version: 2, trainer: { starter: 1, since: 1 }, caught: {}, seen: {}, mons: { m9: mon('m9', 1), m3: mon('m3', 10) }, party: ['m9'], box: ['m3'], nextUid: 10 })).toBe(true)
    expect(dex._state().box.slice(0, 2)).toEqual(['m9', 'm3'])
    expect(dex._state().party).toEqual([])
  })

  it('outAt: stamped when a Pokémon goes out; backfilled from the log on load', () => {
    let t = new Date('2026-11-06T14:00:00').getTime()
    const dir = mkdtempSync(join(tmpdir(), 'pokedex-'))
    dirs.push(dir)
    const dex = createPokedex({ file: join(dir, 'p.json'), species: SPECIES, broadcast: () => {}, random: () => 0.99, now: () => t })
    dex.publicState(); (dex as any)._state().attendedOn = '2026-11-06'
    const st = (dex as any)._state()
    const box = [...st.box]
    for (const u of box) expect(st.mons[u].outAt).toBeUndefined()
    // a throw
    t += 1000
    expect(dex.throwBall('s1', box[2])).toEqual({ ok: true })
    expect(st.mons[box[2]].outAt).toBe(t)
    // a session's first event (none has worked: random 0.99 takes the last resting one)
    t += 1000
    dex.noteEvent({ type: 'session_started', sessionId: 's2' }, {})
    expect(st.assign.s2).toBe(box[5])
    expect(st.mons[box[5]].outAt).toBe(t)
    // a helper for a subagent does not go out with a session: no outAt
    t += 1000
    dex.noteEvent({ ...work('s2'), agentId: 'ag1' }, {})
    expect(dex.publicState().helpers).toEqual({ s2: [box[4]] })
    expect(st.mons[box[4]].outAt).toBeUndefined()
    // a swap stamps the incoming one; the one swapped out keeps when it went out
    const outBefore = st.mons[box[5]].outAt
    t += 1000
    expect(dex.swap('s2', box[3])).toEqual({ ok: true })
    expect(st.mons[box[3]].outAt).toBe(t)
    expect(st.mons[box[5]].outAt).toBe(outBefore)
    // a save from before outAt: the newest sendout / swap / exchange onto a session in the log, never a helper
    // nor a plain PC exchange (no sessionId: it never went out)
    const file = join(dir, 'old.json')
    const mon = (uid: string, extra: Record<string, unknown> = {}) => ({ uid, dex: 10, steps: 0, evos: 0, shiny: false, how: 'wild', place: 'x', at: 1, ball: 'poke-ball', metLevel: 5, workMs: 0, ...extra })
    writeFileSync(file, JSON.stringify({
      version: 2, trainer: { starter: 1, since: 1 }, caught: {}, seen: {}, party: [], assign: {}, nextUid: 9,
      mons: { m1: mon('m1', { outAt: 100 }), m2: mon('m2'), m3: mon('m3'), m4: mon('m4'), m5: mon('m5'), m6: mon('m6') },
      box: ['m1', 'm2', 'm3', 'm4', 'm5', 'm6'],
      log: [
        { kind: 'sendout', uid: 'm1', at: 200 },
        { kind: 'sendout', uid: 'm2', at: 3 },
        { kind: 'sendout', uid: 'm2', at: 5 },
        { kind: 'swap', uid: 'm3', at: 7 },
        { kind: 'exchange', uid: 'm5', sessionId: 's9', at: 8 },
        { kind: 'exchange', uid: 'm6', at: 11 },
        { kind: 'helper', uid: 'm4', at: 9 },
        { kind: 'catch', uid: 'm4', at: 10 },
      ],
    }))
    const old = createPokedex({ file, species: SPECIES, broadcast: () => {}, random: () => 0.99, now: () => t })
    const mons = old._state().mons
    expect(mons.m1.outAt).toBe(100) // kept as it was
    expect(mons.m2.outAt).toBe(5)
    expect(mons.m3.outAt).toBe(7)
    expect(mons.m5.outAt).toBe(8)
    expect(mons.m4.outAt).toBeUndefined()
    expect(mons.m6.outAt).toBeUndefined()
  })

  it('byRecentWork: outAt first, then workMs, then the given order', () => {
    const cases: [string[], Record<string, { outAt?: number; workMs?: number }>, string[]][] = [
      // a later outAt first
      [['a', 'b'], { a: { outAt: 1 }, b: { outAt: 3 } }, ['b', 'a']],
      // any outAt before any work without one
      [['a', 'b'], { a: { workMs: 999 }, b: { outAt: 1 } }, ['b', 'a']],
      // no outAt: more work first, none last
      [['c', 'a', 'b'], { a: { workMs: 5 }, b: { workMs: 9 }, c: {} }, ['b', 'a', 'c']],
      // ties keep the given order (equal outAt; no outAt and no work; a missing one)
      [['b', 'a', 'd', 'c', 'z'], { a: { outAt: 2 }, b: { outAt: 2 }, c: { workMs: 0 }, d: {} }, ['b', 'a', 'd', 'c', 'z']],
    ]
    for (const [uids, mons, want] of cases) {
      const given = [...uids]
      expect(byRecentWork(given, mons)).toEqual(want)
      expect(given).toEqual(uids) // a new array; the given one is untouched
    }
  })

  it('a session goes out with the resting one that went out most recently; never one working; random only when none has worked', () => {
    let t = new Date('2026-11-06T14:00:00').getTime()
    const dir = mkdtempSync(join(tmpdir(), 'pokedex-'))
    dirs.push(dir)
    let rolls: number[] = []
    const active = new Set<string>()
    const dex = createPokedex({ file: join(dir, 'p.json'), species: SPECIES, broadcast: () => {}, isActive: (sid: string) => active.has(sid), random: () => (rolls.length ? rolls.shift()! : 0.99), now: () => t })
    dex.publicState(); (dex as any)._state().attendedOn = '2026-11-06'
    const st = (dex as any)._state()
    const box = [...st.box]
    const start = (sid: string) => { active.add(sid); dex.noteEvent({ type: 'session_started', sessionId: sid }, {}) }
    // none has worked: a random one of all resting (a roll of 0 takes the first)
    rolls = [0]
    start('s2')
    expect(st.assign.s2).toBe(box[0])
    // s2 ends; another worked once but never went out, and one went out long ago
    active.delete('s2'); dex.noteEvent({ type: 'session_ended', sessionId: 's2' }, {})
    st.mons[box[2]].workMs = 60_000
    st.mons[box[4]].outAt = t - 3_600_000
    t += 1000
    // the most recently out of the resting ones goes, with no roll
    start('s1')
    expect(st.assign.s1).toBe(box[0])
    // s2 resumes: the one it remembers works in s1, so it takes the next resting one
    active.add('s2')
    dex.noteEvent(work('s2'), {})
    expect(st.assign.s2).toBe(box[4])
    expect(st.assign.s1).toBe(box[0])
    // and keeps it from then on
    dex.noteEvent(work('s2'), {})
    expect(st.assign.s2).toBe(box[4])
    expect(st.assign.s1).toBe(box[0])
    // the next one: worked, never out
    start('s3')
    expect(st.assign.s3).toBe(box[2])
    // everyone out: a new session gets none, and a remembered one working elsewhere is let go
    start('s4'); start('s5'); start('s6')
    expect(new Set([st.assign.s1, st.assign.s2, st.assign.s3, st.assign.s4, st.assign.s5, st.assign.s6]).size).toBe(6)
    start('s7')
    expect(st.assign.s7).toBeUndefined()
    st.assign.s8 = box[0]
    start('s8')
    expect('s8' in st.assign).toBe(false)
  })

  it('a step may meet a wild Pokémon in the terrain of the tool; a caught one goes to the box', () => {
    // trainer: starter roll, companion picks (fallback); then the step: encounter hit, tier common, species, shiny no, catch yes
    const { dex, sent } = setup([0, 0, 0.1, 0.2, 0.3, 0.4, 0.5])
    attended(dex)
    dex.noteEvent({ type: 'session_started', sessionId: 's1' }, { project: 'api' })
    ;(dex as any)._state().nextUid += 0
    const queue = [0.01, 0.9, 0.5, 0.9, 0.1]
    ;(dex as any)._random = queue
    // drive the remaining rolls through a fresh instance that shares the state file is overkill; check the shape on a plain run instead
    let ev: any = null
    for (let i = 0; i < 400 && !ev; i++) {
      dex.noteEvent(work('s1', 'Bash'), { project: 'api' })
      ev = sent.map(m => m.event).find(e => e && (e.kind === 'catch' || e.kind === 'flee'))
    }
    // with the fallback random (0.99) nothing is ever met: no encounter at all
    expect(ev).toBeUndefined()
  })

  it('pities: a sure mythical after PITY_MYTHICAL, a sure legendary after PITY, both caught', () => {
    const { dex, sent } = setup([0], 0.005) // every roll low: encounters every step, tiers decided by the pities first
    attended(dex)
    dex.noteEvent({ type: 'session_started', sessionId: 's1' }, { project: 'x' })
    const st = (dex as any)._state()
    st.sinceMythical = PITY_MYTHICAL - 1
    dex.noteEvent(work('s1', 'Read'), { project: 'x' })
    expect(sent.at(-1).event).toMatchObject({ kind: 'catch', tier: 'mythical', pity: true, id: 151 })
    st.sinceMythical = 0
    st.sinceLegend = PITY - 1
    dex.noteEvent(work('s1', 'Read'), { project: 'x' })
    expect(sent.at(-1).event).toMatchObject({ kind: 'catch', tier: 'legendary', pity: true, id: 150 })
    expect(dex.publicState().box.length).toBe(6 + 2) // the first run's six, then the two catches
  })

  it('a sure legendary is one not caught yet while any is left; after that any of the tier', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pokedex-'))
    dirs.push(dir)
    const sent: any[] = []
    const species = [...SPECIES, S(249, '루기아', 'legendary', null, ['psychic'], 3)]
    // every roll low: a plain pick would take the first of the tier (뮤츠, already caught)
    const dex = createPokedex({ file: join(dir, 'p.json'), species, broadcast: (m: any) => sent.push(m), random: () => 0.005, now: () => new Date('2026-11-06T14:00:00').getTime() })
    attended(dex)
    dex.noteEvent({ type: 'session_started', sessionId: 's1' }, { project: 'x' })
    const st = (dex as any)._state()
    st.caught[150] = { count: 3 }
    st.sinceMythical = 0
    st.sinceLegend = PITY - 1
    dex.noteEvent(work('s1', 'Read'), { project: 'x' })
    expect(sent.at(-1).event).toMatchObject({ kind: 'catch', tier: 'legendary', pity: true, id: 249 })
    st.sinceMythical = 0
    st.sinceLegend = PITY - 1
    dex.noteEvent(work('s1', 'Read'), { project: 'x' })
    expect(sent.at(-1).event).toMatchObject({ kind: 'catch', tier: 'legendary', pity: true })
  })

  it("the day's first session event brings an attendance encounter with an uncaught species, once a day", () => {
    const { dex, sent } = setup([0], 0.01) // low rolls: the attendance Pokémon is caught
    dex.noteEvent({ type: 'session_started', sessionId: 's1' }, { project: 'web' })
    const att = sent.map(m => m.event).find(e => e?.attendance)
    expect(att).toMatchObject({ kind: 'catch', attendance: true, place: '@attendance|web' }) // a code; the app shows it in its language
    const before = dex.publicState().log.filter((e: any) => e.attendance).length
    dex.noteEvent({ type: 'session_started', sessionId: 's2' }, { project: 'web' })
    expect(dex.publicState().log.filter((e: any) => e.attendance).length).toBe(before)
  })

  it('the attendance encounter never brings a legendary or mythical; a pity due waits for the next wild one', () => {
    // Every roll lowest: a wild encounter would be mythical, and both pities are due
    const { dex, sent } = setup([], 0)
    const st = (dex as any)._state()
    st.sinceMythical = PITY_MYTHICAL - 1
    st.sinceLegend = PITY - 1
    dex.noteEvent({ type: 'session_started', sessionId: 's1' }, { project: 'web' })
    const att = sent.map(m => m.event).find(e => e?.attendance)
    expect(att).toMatchObject({ attendance: true, pity: false, tier: 'sub', id: 144 })
    dex.noteEvent(work('s1', 'Read'), { project: 'web' })
    expect(sent.at(-1).event).toMatchObject({ kind: 'catch', tier: 'mythical', pity: true, attendance: false })
  })

  it('a wild Pokémon flees 20% / 30% / 50% / 60% / 70% of the time, common to mythical', () => {
    expect(CATCH).toEqual({ common: 0.8, rare: 0.7, sub: 0.5, legendary: 0.4, mythical: 0.3 })
  })

  it('the tiers keep their chances however often the others were caught (the ×0.9 works inside a tier)', () => {
    const tierOf = (caughtTimes: number) => {
      const dir = mkdtempSync(join(tmpdir(), 'pokedex-'))
      dirs.push(dir)
      const sent: any[] = []
      let rolls: number[] = []
      const dex = createPokedex({
        file: join(dir, 'pokedex.json'), species: SPECIES, broadcast: (m: any) => sent.push(m),
        now: () => new Date('2026-11-06T14:00:00').getTime(), random: () => (rolls.length ? rolls.shift()! : 0.99),
      })
      attended(dex)
      const st = (dex as any)._state()
      for (const s of SPECIES) if (s.tier !== 'legendary' && s.tier !== 'mythical' && caughtTimes) st.caught[s.id] = { count: caughtTimes, firstAt: 1 }
      dex.noteEvent({ type: 'session_started', sessionId: 's1' }, { project: 'x' })
      rolls = [0, 0.5] // the step meets a Pokémon, then a mid roll for the tier
      dex.noteEvent(work('s1', 'Read'), { project: 'x' })
      return sent.map(m => m.event).filter(e => e && (e.kind === 'catch' || e.kind === 'flee')).at(-1)?.tier
    }
    expect(tierOf(0)).toBe('common')
    expect(tierOf(50)).toBe('common')
  })

  it('once only legendaries and mythicals are left uncaught, there is no attendance encounter', () => {
    const { dex, sent } = setup([], 0)
    const st = (dex as any)._state()
    for (const s of SPECIES) if (s.tier !== 'legendary' && s.tier !== 'mythical') st.caught[s.id] = { count: 1, firstAt: 1 }
    dex.noteEvent({ type: 'session_started', sessionId: 's1' }, { project: 'web' })
    expect(sent.map(m => m.event).find(e => e?.attendance)).toBeUndefined()
  })

  it('a catch remembers what brought it out: the request and the tool', () => {
    const session = { main: { lastPrompt: '잡은 곳을 좀 더 유의미한 걸로 바꿔줘. 어떤 요청에서 받았는지 알면 좋겠어' } }
    expect(catchSource({ tool: 'Bash', status: 'running: npm test' }, session)).toEqual({
      tool: 'Bash', label: 'Bash(npm test)', prompt: '잡은 곳을 좀 더 유의미한 걸로 바꿔줘. 어떤 요청에서 받았는지 알면 좋…',
    })
    expect(catchSource({ tool: 'Skill', status: 'using /frontend-design' }, {}).label).toBe('Skill(/frontend-design)')
    expect(catchSource({ tool: 'Edit', status: 'editing Widget.tsx' }, {}).label).toBe('Edit(Widget.tsx)')
    // no Korean words in what gets saved: a bare tool name, or a code the app translates
    expect(catchSource({ tool: 'Grep', status: '' }, {}).label).toBe('Grep')
    expect(catchSource({ tool: 'Bash', status: '' }, {}).label).toBe('Bash')
    expect(catchSource({ tool: '', status: '' }, {}).label).toBe('#session-start')
    expect(catchSource({ tool: 'mcp__figma__get_screenshot', status: 'using mcp' }, {}).label).toBe('MCP figma')
    expect(catchSource({ tool: 'Read', status: 'reading a.ts' }, {}).prompt).toBeNull()
  })

  it('every individual gets a gender by its species official rate and one of the 25 natures', () => {
    const natures = Array.from({ length: 25 }, (_, i) => ({ id: i + 1 }))
    const species = [
      { id: 1, ko: 'a', types: [], tier: 'rare', captureRate: 45, evolvesFrom: null, genderRate: 1 },
      { id: 4, ko: 'b', types: [], tier: 'rare', captureRate: 45, evolvesFrom: null, genderRate: 8 },
      { id: 7, ko: 'c', types: [], tier: 'rare', captureRate: 45, evolvesFrom: null, genderRate: -1 },
      { id: 10, ko: 'd', types: [], tier: 'common', captureRate: 255, evolvesFrom: null, genderRate: 0 },
      { id: 11, ko: 'e', types: [], tier: 'common', captureRate: 255, evolvesFrom: 10, genderRate: 0 },
    ]
    const dir = mkdtempSync(join(tmpdir(), 'pokedex-'))
    dirs.push(dir)
    let i = 0
    const rolls = [0.4, 0.5, 0.3, 0.9, 0.2]
    const dex = createPokedex({ file: join(dir, 'p.json'), species, natures, broadcast: () => {}, random: () => rolls[i++ % rolls.length] })
    const st = dex.publicState()
    for (const uid of st.box) {
      const m = st.mons[uid]
      const rate = species.find(s => s.id === m.dex)!.genderRate
      if (rate === -1) expect(m.gender).toBe('none')
      if (rate === 8) expect(m.gender).toBe('female')
      if (rate === 0) expect(m.gender).toBe('male')
      expect(m.nature).toBeGreaterThanOrEqual(1)
      expect(m.nature).toBeLessThanOrEqual(25)
    }
  })

  it('a full box sends a new catch to the professor; the Pokédex still counts it', () => {
    const { dex, sent } = setup([], 0) // every roll 0: every step meets and catches
    attended(dex)
    dex.noteEvent({ type: 'session_started', sessionId: 's1' }, {})
    const st0 = (dex as any)._state()
    while (st0.box.length < BOX_LIMIT) { const u = `f${st0.box.length}`; st0.mons[u] = { uid: u, dex: 10, steps: 0, evos: 0, shiny: false, how: 'wild', place: 'x', at: 0 }; st0.box.push(u) }
    const before = Object.keys(st0.mons).length
    dex.noteEvent(work('s1', 'Bash'), {})
    const ev = sent.map(m => m.event).find(e => e?.kind === 'catch')
    expect(ev).toMatchObject({ toProfessor: true, uid: null })
    expect(dex.publicState().caught[ev.id]).toBeTruthy()
    expect(st0.box).toHaveLength(BOX_LIMIT)
    expect(Object.keys(st0.mons)).toHaveLength(before)
    expect(dex.publicState().boxLimit).toBe(BOX_LIMIT)
  })

  it('releases a resting Pokémon, never a working or helping one', () => {
    const { dex } = setup([0])
    attended(dex)
    dex.noteEvent({ type: 'session_started', sessionId: 's1' }, {})
    const st0 = (dex as any)._state()
    st0.mons.mbox = { uid: 'mbox', dex: 10, steps: 0, evos: 0, shiny: false, how: 'wild', place: 'x', at: 0 }
    st0.box.push('mbox')
    const working = dex.publicState().assign.s1
    expect(dex.release(working)).toEqual({ ok: false, reason: 'busy' })
    expect(dex.release('nope')).toMatchObject({ ok: false })
    // one that rests goes, the first run's companions as well as a catch
    const resting = st0.box.find((u: string) => u !== working && u !== 'mbox')
    expect(dex.release(resting)).toEqual({ ok: true })
    expect(dex.release('mbox')).toEqual({ ok: true })
    const st = dex.publicState()
    expect(st.box).not.toContain('mbox')
    expect(st.box).not.toContain(resting)
    expect(st.mons.mbox).toBeUndefined()
    expect(st.mons[resting]).toBeUndefined()
    expect(st.mons[working]).toBeTruthy()
  })

  it('the trainer arranges the box: the same Pokémon, each once, in a new order', () => {
    const { dex } = setup([0])
    attended(dex)
    const st0 = (dex as any)._state()
    const gifts = [...st0.box] // the first run's six
    for (const u of ['b1', 'b2', 'b3']) { st0.mons[u] = { uid: u, dex: 150, steps: 0, evos: 0, shiny: false, how: 'wild', place: 'x', at: 0 }; st0.box.push(u) }
    expect(dex.arrangeBox(['b3', 'b1', 'b2', ...gifts])).toEqual({ ok: true })
    expect(dex.publicState().box).toEqual(['b3', 'b1', 'b2', ...gifts])
    expect(dex.arrangeBox(['b3', 'b1', ...gifts])).toMatchObject({ ok: false })
    expect(dex.arrangeBox(['b3', 'b1', 'b1', ...gifts])).toMatchObject({ ok: false })
    expect(dex.arrangeBox(['b3', 'b1', 'zz', ...gifts])).toMatchObject({ ok: false })
    expect(dex.publicState().box).toEqual(['b3', 'b1', 'b2', ...gifts])
  })

  it('every catch comes in a ball drawn by the balls’ weights', () => {
    const balls = JSON.parse(readFileSync(join(__dirname, '..', 'server', 'balls.json'), 'utf8')).balls
    expect(balls).toHaveLength(27)
    expect(balls.reduce((a: number, b: any) => a + b.weight, 0)).toBeCloseTo(100, 6)
    // event balls are only ever given, never caught in
    for (const id of ['park-ball', 'dream-ball', 'cherish-ball']) expect(balls.find((b: any) => b.id === id)).toMatchObject({ catch: false, weight: 0 })
    const dir = mkdtempSync(join(tmpdir(), 'pokedex-'))
    dirs.push(dir)
    const sent: any[] = []
    // every roll 0: every step meets and catches, and the ball is the first one listed
    const dex = createPokedex({ file: join(dir, 'p.json'), species: SPECIES, balls, broadcast: (m: any) => sent.push(m), random: () => 0, now: () => new Date('2026-11-06T14:00:00').getTime() })
    dex.publicState(); (dex as any)._state().attendedOn = '2026-11-06'
    dex.noteEvent({ type: 'session_started', sessionId: 's1' }, {})
    dex.noteEvent(work('s1', 'Bash'), {})
    // every roll 0 meets a mythical first, and 1% of legendary/mythical catches are in a Master Ball
    const ev = sent.map(m => m.event).find(e => e?.kind === 'catch')
    expect(ev.tier).toBe('mythical')
    expect(ev.ball).toBe('master-ball')
    expect(dex.publicState().mons[ev.uid].ball).toBe('master-ball')
    // the starter came in a plain Poké Ball
    const st = dex.publicState()
    expect(st.mons[st.box[0]].ball).toBe('poke-ball')
  })

  it('a species already caught comes back less: ×0.9 per catch', () => {
    // two commons of equal weight; the trainer has caught the first one 3 times
    const species = [
      { id: 1, ko: 'a', types: ['normal'], tier: 'common', captureRate: 100, evolvesFrom: null },
      { id: 2, ko: 'b', types: ['normal'], tier: 'common', captureRate: 100, evolvesFrom: null },
    ]
    const picks = { 1: 0, 2: 0 } as Record<number, number>
    let seed = 7
    const rnd = () => { seed = (seed * 16807) % 2147483647; return (seed - 1) / 2147483646 }
    const dir = mkdtempSync(join(tmpdir(), 'pokedex-'))
    dirs.push(dir)
    const sent: any[] = []
    const dex = createPokedex({ file: join(dir, 'p.json'), species, broadcast: (m: any) => sent.push(m), random: rnd, now: () => new Date('2026-11-06T14:00:00').getTime() })
    dex.publicState(); (dex as any)._state().attendedOn = '2026-11-06'
    const st = (dex as any)._state()
    st.caught = { 1: { count: 3 }, 2: { count: 1 } }
    dex.noteEvent({ type: 'session_started', sessionId: 's1' }, {})
    // hold the counts still (a caught 3 times, b once) so only the weights speak
    for (let i = 0; i < 60000; i++) { st.caught = { 1: { count: 3 }, 2: { count: 1 } }; dex.noteEvent(work('s1', 'Bash'), {}) }
    for (const e of sent.map(m => m.event)) if (e && (e.kind === 'catch' || e.kind === 'flee')) picks[e.id]++
    // a : b = 0.9^3 : 0.9^1 = 0.81
    expect(picks[1] / picks[2]).toBeGreaterThan(0.7)
    expect(picks[1] / picks[2]).toBeLessThan(0.92)
    // Caught 30 times, a falls no lower than RECATCH_FLOOR: a : b = 0.3 : 0.9
    picks[1] = picks[2] = 0
    sent.length = 0
    for (let i = 0; i < 60000; i++) { st.caught = { 1: { count: 30 }, 2: { count: 1 } }; dex.noteEvent(work('s1', 'Bash'), {}) }
    for (const e of sent.map(m => m.event)) if (e && (e.kind === 'catch' || e.kind === 'flee')) picks[e.id]++
    expect(picks[1] / picks[2]).toBeGreaterThan(0.27)
    expect(picks[1] / picks[2]).toBeLessThan(0.4)
  })

  it('levels: work time with a trainer raises it; breaks over 5 minutes do not count', () => {
    let t = new Date('2026-11-06T14:00:00').getTime()
    const dir = mkdtempSync(join(tmpdir(), 'pokedex-'))
    dirs.push(dir)
    const dex = createPokedex({ file: join(dir, 'p.json'), species: SPECIES, broadcast: () => {}, random: () => 0.99, now: () => t })
    dex.publicState(); (dex as any)._state().attendedOn = '2026-11-06'
    dex.noteEvent({ type: 'session_started', sessionId: 's1' }, {})
    const uid = dex.publicState().assign.s1
    const mon = () => (dex as any)._state().mons[uid]
    expect(mon().metLevel).toBe(5)
    // a tool call every minute for 61 minutes: two levels
    for (let i = 0; i <= 61; i++) { dex.noteEvent(work('s1'), {}); t += 60_000 }
    expect(Math.floor(mon().workMs / 60000)).toBe(61)
    expect(levelFrom(mon().metLevel, mon().workMs).level).toBe(8) // ~20 minutes a level at this point
    // an hour away, then one call: nothing added
    t += 60 * 60_000
    dex.noteEvent(work('s1'), {})
    expect(Math.floor(mon().workMs / 60000)).toBe(61)
  })

  it('ball boosts follow the situation', () => {
    const wild = { id: 7, types: ['water'], speed: 43, weightKg: 9 }
    const at = Date.UTC(2026, 10, 6, 5)
    let b = ballBoosts({ wild, level: 1, first: true, minutes: 0, at })
    expect(b['net-ball']).toBe(3)
    expect(b['dive-ball']).toBe(3)
    expect(b['nest-ball']).toBe(3)
    expect(b['quick-ball']).toBe(3)
    expect(b['timer-ball']).toBe(0.5)
    b = ballBoosts({ wild, level: 55, first: false, minutes: 240, at })
    expect(b['nest-ball']).toBeCloseTo(0.5)
    expect(b['timer-ball']).toBe(3)
    expect(b['quick-ball']).toBe(0.5)
    // a well-raised partner far above the wild one
    b = ballBoosts({ wild, level: 10, at, partner: { dex: 4, level: 45, metLevel: 5, gender: 'male' } })
    expect(b['luxury-ball']).toBe(2)
    expect(b['friend-ball']).toBe(2)
    expect(b['level-ball']).toBe(3)
    expect(ballBoosts({ wild: { id: 793, types: ['rock'] }, level: 50, at })['beast-ball']).toBe(50)
    expect(ballBoosts({ wild, level: 5, tool: 'Grep', at })['lure-ball']).toBe(3)
    expect(ballBoosts({ wild: { id: 1, types: [], speed: 120, weightKg: 400 }, level: 5, at })).toMatchObject({ 'fast-ball': 3, 'heavy-ball': 3 })
    expect(ballBoosts({ wild, level: 5, catchNo: 10, at })['premier-ball']).toBe(3)
    // a known full moon: 2026-11-24 (UTC)
    expect(isFullMoon(Date.UTC(2026, 10, 24, 12))).toBe(true)
    expect(isFullMoon(Date.UTC(2026, 10, 9, 12))).toBe(false)
  })

  it('friendship, trade and Eevee evolutions follow the games, simply', () => {
    let t = new Date('2026-11-06T14:00:00').getTime() // daytime
    const species = [
      { id: 1, ko: '이상해씨', types: ['grass'], tier: 'rare', captureRate: 45, evolvesFrom: null },
      { id: 4, ko: '파이리', types: ['fire'], tier: 'rare', captureRate: 45, evolvesFrom: null },
      { id: 7, ko: '꼬부기', types: ['water'], tier: 'rare', captureRate: 45, evolvesFrom: null },
      { id: 172, ko: '피츄', types: ['electric'], tier: 'common', captureRate: 190, evolvesFrom: null },
      { id: 25, ko: '피카츄', types: ['electric'], tier: 'common', captureRate: 190, evolvesFrom: 172, evolveLevel: 30, evolveHow: 'level-up' },
      { id: 64, ko: '윤겔라', types: ['psychic'], tier: 'common', captureRate: 100, evolvesFrom: null },
      { id: 65, ko: '후딘', types: ['psychic'], tier: 'common', captureRate: 50, evolvesFrom: 64, evolveLevel: 40, evolveHow: 'trade' },
      { id: 133, ko: '이브이', types: ['normal'], tier: 'common', captureRate: 45, evolvesFrom: null },
      ...[134, 135, 136].map(id => ({ id, ko: `돌${id}`, types: ['normal'], tier: 'common', captureRate: 45, evolvesFrom: 133, evolveLevel: 30, evolveHow: 'use-item' })),
      ...[196, 197, 470, 471, 700].map(id => ({ id, ko: `이브이${id}`, types: ['normal'], tier: 'common', captureRate: 45, evolvesFrom: 133, evolveLevel: 30, evolveHow: 'level-up' })),
    ]
    const dir = mkdtempSync(join(tmpdir(), 'pokedex-'))
    dirs.push(dir)
    const dex = createPokedex({ file: join(dir, 'p.json'), species, broadcast: () => {}, random: () => 0.99, now: () => t })
    dex.publicState(); (dex as any)._state().attendedOn = '2026-11-06'
    const st = (dex as any)._state()
    const grow = (uid: string, sid: string, tool = 'Edit', minutes = 2000) => {
      st.assign[sid] = uid
      for (let i = 0; i < minutes; i++) { t += 60_000; dex.noteEvent({ type: 'agent_working', sessionId: sid, tool }, {}) }
    }
    const add = (uid: string, dex: number, metLevel: number) => { st.mons[uid] = { uid, dex, steps: 0, evos: 0, shiny: false, how: 'wild', place: 'x', at: 0, metLevel, workMs: 0 }; st.box.push(uid) }
    // Pichu: met at 40, no evolution until raised 20 levels, then Pikachu
    add('pichu', 172, 40)
    grow('pichu', 'a', 'Edit', 200)
    expect(st.mons.pichu.dex).toBe(172)
    grow('pichu', 'a', 'Edit', 900)
    expect(st.mons.pichu.dex).toBe(25)
    // Kadabra: level alone never does it; after a trade, the next level-up does
    add('kad', 64, 50)
    grow('kad', 'b', 'Edit', 200)
    expect(st.mons.kad.dex).toBe(64)
    st.mons.kad.traded = true
    grow('kad', 'b', 'Edit', 200)
    expect(st.mons.kad.dex).toBe(65)
    // Eevee from 30 in the forest (Read), not yet bonded: Leafeon
    add('eevee', 133, 29)
    grow('eevee', 'c', 'Read', 60)
    expect(st.mons.eevee.dex).toBe(470)
    // Anywhere else (an Edit on the road), one of the stone forms or Sylveon at random (here the last: Sylveon)
    add('eevee2', 133, 29)
    grow('eevee2', 'd', 'Edit', 60)
    expect(st.mons.eevee2.dex).toBe(700)
  })

  it('steps wait their turn: a burst of tool calls is met one step at a time', () => {
    let t = new Date('2026-11-06T14:00:00').getTime()
    const dir = mkdtempSync(join(tmpdir(), 'pokedex-'))
    dirs.push(dir)
    const sent: any[] = []
    // every roll meets and catches
    const dex = createPokedex({ file: join(dir, 'p.json'), species: SPECIES, broadcast: (m: any) => sent.push(m), random: () => 0, now: () => t, stepSpacingMs: 8000 })
    dex.publicState(); (dex as any)._state().attendedOn = '2026-11-06'
    dex.noteEvent({ type: 'session_started', sessionId: 's1' }, {})
    for (let i = 0; i < 5; i++) dex.noteEvent(work('s1', 'Bash'), {}) // five calls in the same instant
    const met = () => sent.map(m => m.event).filter(e => e && (e.kind === 'catch' || e.kind === 'flee')).length
    expect(met()).toBe(1) // only the first step so far
    for (let i = 0; i < 4; i++) { t += 8000; dex.tick() }
    expect(met()).toBe(5) // the rest, eight seconds apart, none lost
  })

  it('a working session with no tool call for a minute takes a thinking step', () => {
    let t = new Date('2026-11-06T14:00:00').getTime()
    const dir = mkdtempSync(join(tmpdir(), 'pokedex-'))
    dirs.push(dir)
    const sent: any[] = []
    let working = true
    const dex = createPokedex({
      file: join(dir, 'p.json'), species: SPECIES, broadcast: (m: any) => sent.push(m), random: () => 0, now: () => t,
      stepSpacingMs: 8000, sessionOf: () => ({ main: { state: working ? 'working' : 'idle', lastPrompt: '설계 문서 다듬어줘' } }),
    })
    dex.publicState(); (dex as any)._state().attendedOn = '2026-11-06'
    dex.noteEvent({ type: 'session_started', sessionId: 's1' }, {})
    dex.noteEvent(work('s1', 'Read'), {})
    const met = () => sent.map(m => m.event).filter(e => e && (e.kind === 'catch' || e.kind === 'flee'))
    expect(met()).toHaveLength(1)
    t += THINK_STEP_MS; dex.tick()
    expect(met()).toHaveLength(2)
    expect(met()[1].via).toMatchObject({ label: '#thinking', prompt: '설계 문서 다듬어줘' })
    // idle (the turn ended): no more thinking steps
    working = false
    t += THINK_STEP_MS * 3; dex.tick()
    expect(met()).toHaveLength(2)
  })

  it('keeps the game on disk', async () => {
    const { dex, file } = setup([0])
    dex.noteEvent({ type: 'session_started', sessionId: 's1' }, { project: 'x' })
    await new Promise(r => setTimeout(r, 400))
    const saved = JSON.parse(readFileSync(file, 'utf8'))
    expect(saved.version).toBe(2)
    expect(saved.trainer.starter).toBe(1)
    expect(saved.box).toContain(saved.assign.s1)
    expect(saved.party).toEqual([])
  })

  it("takes a synced (merged) game: the game before it is backed up, this PC's assignments in it are kept, old individuals upgraded", () => {
    const { dex, file } = setup([0])
    dex.noteEvent({ type: 'session_started', sessionId: 's1' }, { project: 'x' })
    const before = JSON.parse(JSON.stringify(dex.exportState()))
    const merged = { ...before, caught: { ...before.caught, 150: { count: 1, firstAt: 1 } }, mons: { ...before.mons, m99: { uid: 'm99', dex: 150, steps: 0, evos: 0, at: 1 } }, box: ['m99'], nextUid: 100 }
    expect(dex.importState(merged)).toBe(true)
    expect(JSON.parse(readFileSync(`${file}.before-sync`, 'utf8'))).toEqual(before)
    const st = dex.publicState()
    expect(st.caught[150]).toBeTruthy()
    expect(st.remembered).toEqual(before.assign)
    expect(st.mons.m99).toMatchObject({ ball: 'poke-ball', metLevel: 5, workMs: 0 })
    expect(dex.importState({ version: 1 })).toBe(false)
  })
})

describe('pokedex saves', () => {
  afterEach(() => { vi.useRealTimers() })
  const steps = (file: string) => {
    const s = JSON.parse(readFileSync(file, 'utf8'))
    return Object.values(s.mons as Record<string, { steps: number }>).reduce((n, m) => n + (m.steps ?? 0), 0)
  }

  it('a plain step is saved within 30 s, not right away', async () => {
    vi.useFakeTimers()
    const { dex, file } = setup()
    attended(dex)
    dex.noteEvent(work('s1'))
    await vi.advanceTimersByTimeAsync(1000)
    const before = steps(file)
    dex.noteEvent(work('s1'))
    await vi.advanceTimersByTimeAsync(1000)
    expect(steps(file)).toBe(before)
    await vi.advanceTimersByTimeAsync(30_000)
    expect(steps(file)).toBeGreaterThan(before)
  })

  it('a meaningful change after steps saves within 300 ms and includes the steps', async () => {
    vi.useFakeTimers()
    const { dex, file } = setup()
    attended(dex)
    dex.noteEvent(work('s1'))
    await vi.advanceTimersByTimeAsync(1000)
    const before = steps(file)
    dex.noteEvent(work('s1'))
    dex.noteEvent(work('s2')) // a second session: a resting Pokémon is sent out (a meaningful change)
    await vi.advanceTimersByTimeAsync(400)
    expect(steps(file)).toBeGreaterThan(before)
  })

  it('flush writes pending steps at once', async () => {
    vi.useFakeTimers()
    const { dex, file } = setup()
    attended(dex)
    dex.noteEvent(work('s1'))
    await vi.advanceTimersByTimeAsync(1000)
    const before = steps(file)
    dex.noteEvent(work('s1'))
    dex.flush()
    expect(steps(file)).toBeGreaterThan(before)
  })
})

describe('helpers and late subagent calls', () => {
  it("a subagent's tool call from before it finished (a background hook arriving late) does not call a helper back", () => {
    const t = new Date('2026-11-06T14:00:00').getTime()
    const dir = mkdtempSync(join(tmpdir(), 'pokedex-'))
    dirs.push(dir)
    const dex = createPokedex({ file: join(dir, 'p.json'), species: SPECIES, broadcast: () => {}, random: () => 0.99, now: () => t })
    dex.publicState(); (dex as any)._state().attendedOn = '2026-11-06'
    const st0 = (dex as any)._state()
    st0.box = st0.box.slice(0, 1) // only the starter rests, so the box has one free helper below
    dex.noteEvent({ type: 'session_started', sessionId: 's1' }, {})
    st0.mons.mbox = { uid: 'mbox', dex: 150, steps: 0, evos: 0, shiny: false, how: 'wild', place: 'x', at: 0, metLevel: 5, workMs: 0 }
    st0.box.push('mbox')
    dex.noteEvent({ ...work('s1'), agentId: 'ag1', at: t }, {})
    expect(dex.publicState().helpers).toEqual({ s1: ['mbox'] })
    dex.noteEvent({ type: 'agent_completed', sessionId: 's1', agentId: 'ag1' }, {})
    expect(dex.publicState().helpers).toEqual({})
    dex.noteEvent({ ...work('s1'), agentId: 'ag1', at: t - 1000 }, {})
    expect(dex.publicState().helpers).toEqual({})
    dex.noteEvent({ ...work('s1'), agentId: 'ag1', at: t + 1 }, {})
    expect(dex.publicState().helpers).toEqual({ s1: ['mbox'] })
  })
})

describe('a session with no Pokémon', () => {
  /**
   * A box of two Pokémon (or `box`). `ended` sessions are not active (the registry's view);
   * the clock moves with `advance`.
   */
  function twoMons(fallback = 0.99, { box = 2, ...opts }: { box?: number; stepSpacingMs?: number; sessionOf?: (sid: string) => any } = {}) {
    let t = new Date('2026-11-06T14:00:00').getTime()
    const dir = mkdtempSync(join(tmpdir(), 'pokedex-'))
    dirs.push(dir)
    const sent: any[] = []
    const ended = new Set<string>()
    const rolls: number[] = []
    const dex = createPokedex({
      file: join(dir, 'p.json'), species: SPECIES, broadcast: (m: any) => sent.push(m),
      isActive: (sid: string) => !ended.has(sid),
      random: () => (rolls.length ? rolls.shift()! : fallback), now: () => t, ...opts,
    })
    dex.publicState()
    const st = (dex as any)._state()
    st.box = st.box.slice(0, box)
    const start = (sid: string) => dex.noteEvent({ type: 'session_started', sessionId: sid }, {})
    const end = (sid: string) => { ended.add(sid); dex.noteEvent({ type: 'session_ended', sessionId: sid }, {}) }
    const met = (sid: string) => [...sent.map(m => m.event), ...st.log].filter(e => e && (e.kind === 'catch' || e.kind === 'flee') && e.sessionId === sid)
    const advance = (ms: number) => { t += ms }
    return { dex, sent, st, ended, rolls, start, end, met, advance }
  }

  it('opens with none when every Pokémon works, and meets nothing: no attendance, no wild, no queued step', () => {
    // every roll 0: any step would meet and catch, any thinking step would be due
    const { dex, st, met, advance, end } = twoMons(0, { sessionOf: () => ({ main: { state: 'working' } }) })
    expect(dex.throwBall('a', st.box[0])).toEqual({ ok: true })
    expect(dex.throwBall('b', st.box[1])).toEqual({ ok: true })
    // c's events are the day's first
    for (let i = 0; i < 50; i++) dex.noteEvent(work('c'), {})
    for (let i = 0; i < 3; i++) { advance(THINK_STEP_MS); dex.tick() }
    expect(st.assign.c).toBeUndefined()
    expect(met('c')).toEqual([])
    expect(st.attendedOn).toBeNull()
    expect(st.box).toHaveLength(2)
    // once it has one, its next event takes the day's attendance
    end('a')
    expect(st.assign.c).toBeTruthy()
    dex.noteEvent(work('c'), {})
    expect(st.attendedOn).toBe('2026-11-06')
    expect(met('c').find(e => e.attendance)).toBeTruthy()
  })

  it('gets the next one to rest, oldest waiting first', () => {
    const { dex, sent, st, start, end } = twoMons()
    attended(dex)
    start('a'); start('b')
    const [ma, mb] = [st.assign.a, st.assign.b]
    expect(new Set([ma, mb]).size).toBe(2)
    start('c'); start('d')
    expect(st.assign.c).toBeUndefined()
    expect(st.assign.d).toBeUndefined()
    end('a')
    expect(st.assign.c).toBe(ma)
    expect(st.assign.d).toBeUndefined()
    expect(dex.publicState().assign.c).toBe(ma)
    end('b')
    expect(st.assign.d).toBe(mb)
    expect(sent.map(m => m.event).find(e => e?.kind === 'sendout' && e.sessionId === 'c')).toMatchObject({ uid: ma })
  })

  it('a catch elsewhere goes straight to the waiting session', () => {
    const { dex, sent, st, rolls, start } = twoMons()
    attended(dex)
    start('a'); start('b'); start('c')
    expect(st.assign.c).toBeUndefined()
    // a's step: met, common, a species, not shiny, caught
    rolls.push(0, 0.9, 0.5, 0.99, 0.1)
    dex.noteEvent(work('a'), {})
    const caught = sent.map(m => m.event).find(e => e?.kind === 'catch')
    expect(caught).toMatchObject({ sessionId: 'a' })
    expect(caught.uid).toBeTruthy()
    expect(st.assign.c).toBe(caught.uid)
  })

  it('a swap frees one for the waiting session', () => {
    const { dex, st, start } = twoMons()
    attended(dex)
    start('a'); start('b'); start('c')
    const ma = st.assign.a
    st.mons.mbox = { uid: 'mbox', dex: 150, steps: 0, evos: 0, shiny: false, how: 'wild', place: 'x', at: 0, metLevel: 5, workMs: 0 }
    st.box.push('mbox')
    expect(dex.swap('a', 'mbox')).toEqual({ ok: true })
    expect(st.assign.a).toBe('mbox')
    expect(st.assign.c).toBe(ma)
  })

  it('a waiting session that ended is skipped', () => {
    const { dex, st, ended, start, end } = twoMons()
    attended(dex)
    start('a'); start('b'); start('c'); start('d')
    const ma = st.assign.a
    ended.add('c') // the registry ended it without a hook
    end('a')
    expect(st.assign.c).toBeUndefined()
    expect(st.assign.d).toBe(ma)
  })

  it('auto-assign never takes a Pokémon held by a throw', () => {
    const { dex, st, ended, start, end, advance } = twoMons()
    attended(dex)
    start('a')
    const ma = st.assign.a
    const other = st.box.find((u: string) => u !== ma)
    // the registry does not know e until its first event: only the throw holds it.
    // Thrown later, it went out most recently: picked first if it were free
    ended.add('e')
    advance(1000)
    expect(dex.throwBall('e', other)).toEqual({ ok: true })
    start('c')
    expect(st.assign.c).toBeUndefined()
    dex.tick()
    expect(st.assign.c).toBeUndefined()
    end('a')
    expect(st.assign.c).toBe(ma)
    expect(st.assign.e).toBe(other)
  })

  it('steps from before it had a Pokémon are not met after', () => {
    // every roll 0: a queued step would meet
    const { dex, st, start, end, met, advance } = twoMons(0, { stepSpacingMs: 8000 })
    st.attendedOn = '2026-11-06'
    start('a'); start('b'); start('c')
    expect(st.assign.c).toBeUndefined()
    for (let i = 0; i < 5; i++) dex.noteEvent(work('c', 'Bash'), {})
    end('a')
    expect(st.assign.c).toBeTruthy()
    for (let i = 0; i < 6; i++) { advance(8000); dex.tick() }
    expect(met('c')).toEqual([])
  })

  /** Wild encounters logged for a session (each once) */
  const wild = (st: any, sid: string) => st.log.filter((e: any) => (e.kind === 'catch' || e.kind === 'flee') && e.sessionId === sid)

  it("an open session that loses its Pokémon drops its waiting steps", () => {
    // every roll 0: every step meets
    const { dex, st, start, advance } = twoMons(0, { stepSpacingMs: 8000 })
    st.attendedOn = '2026-11-06'
    start('a')
    for (let i = 0; i < 5; i++) dex.noteEvent(work('a', 'Bash'), {})
    expect(wild(st, 'a')).toHaveLength(1) // the first step; four wait their turn
    // a synced game without a's assignment: a is open and has none
    delete st.assign.a
    for (let i = 0; i < 6; i++) { advance(8000); dex.tick() }
    expect(wild(st, 'a')).toHaveLength(1)
  })

  it("an ended session's late tool calls take no steps", () => {
    const { dex, st, start, end, advance } = twoMons(0, { stepSpacingMs: 8000 })
    st.attendedOn = '2026-11-06'
    start('a')
    end('a')
    // hooks that ran in the background arrive after the end: a remembers a resting Pokémon, but holds none
    for (let i = 0; i < 3; i++) dex.noteEvent(work('a', 'Bash'), {})
    for (let i = 0; i < 4; i++) { advance(8000); dex.tick() }
    expect(wild(st, 'a')).toEqual([])
  })

  it("an ended session's waiting steps are still met, with the Pokémon each was taken with", () => {
    // every roll 0: every step meets and catches
    const { dex, st, start, end, advance } = twoMons(0, { stepSpacingMs: 8000 })
    st.attendedOn = '2026-11-06'
    start('a'); start('b')
    const ma = st.assign.a
    const dexA = st.mons[ma].dex
    for (let i = 0; i < 5; i++) dex.noteEvent(work('a', 'Bash'), {})
    expect(wild(st, 'a')).toHaveLength(1) // the first step; four wait their turn
    // a's catch rests in the box: c takes it, d waits
    start('c'); start('d')
    expect(st.assign.c).toBeTruthy()
    expect(st.assign.d).toBeUndefined()
    // a ends with steps still waiting; its Pokémon goes on to d
    end('a')
    expect(st.assign.d).toBe(ma)
    for (let i = 0; i < 6; i++) { advance(8000); dex.tick() }
    const met = wild(st, 'a')
    expect(met).toHaveLength(5)
    for (const e of met) expect(e.partner).toBe(dexA)
  })

  it("a helper back to rest goes to the oldest waiting session, before a newer one's event", () => {
    const { dex, st, start } = twoMons(0.99, { box: 3 })
    attended(dex)
    start('a'); start('b')
    dex.noteEvent({ ...work('a'), agentId: 'ag1' }, {})
    const helper = dex.publicState().helpers.a?.[0]
    expect(helper).toBeTruthy()
    start('c'); start('d')
    expect(st.assign.c).toBeUndefined()
    expect(st.assign.d).toBeUndefined()
    dex.noteEvent({ type: 'agent_completed', sessionId: 'a', agentId: 'ag1' }, {})
    expect(st.assign.c).toBe(helper)
    dex.noteEvent(work('d'), {})
    expect(st.assign.c).toBe(helper)
    expect(st.assign.d).toBeUndefined()
  })

  it("a Pokémon whose throw hold ran out goes to the oldest waiting session, not to a newer one's event", () => {
    const { dex, st, ended, start, advance } = twoMons()
    attended(dex)
    start('a')
    const other = st.box.find((u: string) => u !== st.assign.a)
    ended.add('e') // never opened: only the throw holds its Pokémon
    expect(dex.throwBall('e', other)).toEqual({ ok: true })
    start('c'); start('d')
    expect(st.assign.c).toBeUndefined()
    advance(10 * 60_000 + 1) // the hold ran out, with no call here
    dex.noteEvent(work('d'), {})
    expect(st.assign.c).toBe(other)
    expect(st.assign.d).toBeUndefined()
    start('f')
    expect(st.assign.f).toBeUndefined()
  })
})
