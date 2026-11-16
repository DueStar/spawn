/**
 * src/resting.ts: which caught Pokémon rest (not working a session, not helping a
 * subagent), the order "most recently worked first" (the same as the server's
 * byRecentWork), the one a session gets without a picker, and 랭킹's partner choice.
 */

import { describe, expect, it } from 'vitest'
import { byRecentWork, pickResting, recentPartnerDex, restorePicks, restingUids } from '../src/resting'

describe('byRecentWork', () => {
  it('outAt first, then workMs, then the given order (the same table as the server)', () => {
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
})

describe('restingUids', () => {
  it('box members with a mon, not working a session, not helping a subagent, most recent first', () => {
    const s = {
      box: ['a', 'b', 'c', 'd', 'gone', 'e'],
      mons: { a: {}, b: { outAt: 5 }, c: {}, d: { workMs: 3 }, e: { outAt: 9 } },
      assign: { s1: 'a' },
      helpers: { s1: ['c'] },
    }
    expect(restingUids(s)).toEqual(['e', 'b', 'd'])
  })

  it('none assigned or helping: every box member with a mon', () => {
    expect(restingUids({ box: ['a', 'b'], mons: { a: {}, b: {} } })).toEqual(['a', 'b'])
  })
})

describe('pickResting', () => {
  const s = {
    box: ['a', 'b', 'c', 'd'],
    mons: { a: {}, b: { outAt: 1 }, c: { outAt: 2 }, d: {} },
    assign: { s1: 'a' } as Record<string, string>,
  }

  it('prefer when it rests', () => {
    expect(pickResting(s, 'b')).toBe('b')
  })

  it('prefer working: the resting one that went out most recently', () => {
    expect(pickResting(s, 'a')).toBe('c')
    expect(pickResting(s)).toBe('c')
    expect(pickResting(s, null)).toBe('c')
  })

  it('one that only worked (no outAt) counts as worked', () => {
    expect(pickResting({ box: ['a', 'b'], mons: { a: {}, b: { workMs: 10 } } })).toBe('b')
  })

  it('none has worked: a random resting one', () => {
    const fresh = { box: ['a', 'b', 'c'], mons: { a: {}, b: {}, c: { workMs: 0 } } }
    expect(pickResting(fresh, null, () => 0.99)).toBe('c')
    expect(pickResting(fresh, null, () => 0)).toBe('a')
  })

  it('none resting: null', () => {
    expect(pickResting({ ...s, assign: { s1: 'a', s2: 'b', s3: 'c', s4: 'd' } }, 'a')).toBeNull()
    expect(pickResting({ box: [], mons: {} })).toBeNull()
  })
})

describe('restorePicks', () => {
  // resting, most recently worked first: X, then Y, then Z
  const R = ['X', 'Y', 'Z']

  it('a remembered Pokémon is kept for its own session even when an earlier one has none to pick', () => {
    const picks = restorePicks([{ id: 'A' }, { id: 'B', remembered: 'X' }], R)
    expect(picks.get('B')).toBe('X')
    expect(picks.get('A')).toBe('Y')
  })

  it('an earlier session with no usable remembered one waits when only the reserved one rests', () => {
    const picks = restorePicks([{ id: 'A', remembered: 'gone' }, { id: 'B', remembered: 'X' }], ['X'])
    expect(picks.get('B')).toBe('X')
    expect(picks.get('A')).toBeNull()
  })

  it('every session comes back: each Pokémon goes with one session; past the resting ones, none', () => {
    const picks = restorePicks([{ id: 'A', remembered: 'Z' }, { id: 'B' }, { id: 'C', remembered: 'Z' }, { id: 'D' }, { id: 'E' }], R)
    expect(picks.get('A')).toBe('Z')
    expect(picks.get('B')).toBe('X')
    expect(picks.get('C')).toBe('Y')
    expect(picks.get('D')).toBeNull()
    expect(picks.get('E')).toBeNull()
    expect(picks.size).toBe(5)
  })
})

describe('recentPartnerDex', () => {
  // 8 Pokémon; g shares a's species
  const s = {
    box: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'],
    mons: {
      a: { dex: 1, outAt: 80 }, b: { dex: 4, outAt: 70 }, c: { dex: 7, outAt: 60 }, d: { dex: 25, outAt: 50 },
      e: { dex: 133, workMs: 100 }, f: { dex: 150, workMs: 50 }, g: { dex: 1, outAt: 75 }, h: { dex: 152 },
    },
    assign: { s1: 'a' },
  }

  it('six distinct species, the most recently worked first, working ones included', () => {
    // byRecentWork: a(80) g(75, a's species again) b(70) c(60) d(50) e(work 100) f(work 50) h
    expect(recentPartnerDex(s, null)).toEqual([1, 4, 7, 25, 133, 150])
  })

  it('the current partner is appended when it is not among them', () => {
    expect(recentPartnerDex(s, 152)).toEqual([1, 4, 7, 25, 133, 150, 152])
    expect(recentPartnerDex(s, 4)).toEqual([1, 4, 7, 25, 133, 150])
  })

  it('fewer than six caught: all of them; none: just the current one', () => {
    expect(recentPartnerDex({ box: ['a', 'b'], mons: { a: { dex: 7 }, b: { dex: 7 } } }, null)).toEqual([7])
    expect(recentPartnerDex({ box: [], mons: {} }, 25)).toEqual([25])
  })
})
