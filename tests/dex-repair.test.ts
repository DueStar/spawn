/**
 * The Pokédex's own errors, mended on load and after a sync (server/pokedex.js repairDex): a starter of an
 * earlier start of the game with no Pokémon of its line here leaves caught and seen; a caught record without a ball
 * gets one; this trainer's starter and anything with a Pokémon here stay.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { createPokedex } from '../server/pokedex.js'

const S = (id: number, ko: string, evolvesFrom: number | null) => ({ id, ko, types: ['normal'], tier: 'rare', captureRate: 45, evolvesFrom })
const SPECIES = [S(4, '파이리', null), S(5, '리자드', 4), S(6, '리자몽', 5), S(7, '꼬부기', null), S(8, '어니부기', 7), S(866, '마임꽁꽁', null)]
const dirs: string[] = []
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }) })

const SINCE = 1_000_000
function game(extra: Record<string, unknown> = {}) {
  return {
    version: 2, trainer: { starter: 4, since: SINCE },
    caught: {
      4: { how: 'starter', count: 1, lastAt: SINCE + 1, ball: 'poke-ball' },
      7: { how: 'starter', count: 3, lastAt: SINCE - 500, ball: 'poke-ball' },
      866: { how: 'attendance', count: 1, lastAt: SINCE + 50 },
    },
    seen: { 4: 1, 7: 3, 866: 1 },
    mons: { m1: { uid: 'm1', dex: 6, how: 'starter', at: SINCE, ball: 'poke-ball' }, m2: { uid: 'm2', dex: 866, how: 'attendance', at: SINCE + 50, ball: 'great-ball' } },
    party: [], box: ['m1', 'm2'], assign: {}, projects: {}, nextUid: 3, encounters: 0, sinceLegend: 0, sinceMythical: 0, log: [], released: {},
    ...extra,
  }
}
function open(state: object) {
  const dir = mkdtempSync(join(tmpdir(), 'dex-repair-')); dirs.push(dir)
  const file = join(dir, 'pokedex.json')
  writeFileSync(file, JSON.stringify(state))
  return createPokedex({ file, species: SPECIES, broadcast: () => {} })
}

describe('repairDex', () => {
  it('drops a starter of an earlier start with nothing of its line here, caught and seen', () => {
    const s = open(game())._state()
    expect(s.caught[7]).toBeUndefined()
    expect(s.seen[7]).toBeUndefined()
    expect(s.caught[4]).toBeDefined()
  })

  it('keeps an earlier starter that has a Pokémon of its line here', () => {
    const g = game() as any
    g.mons.m3 = { uid: 'm3', dex: 8, how: 'wild', at: SINCE + 9, ball: 'net-ball' }
    expect(open(g)._state().caught[7]).toBeDefined()
  })

  it('gives a caught record without a ball the ball of its first Pokémon', () => {
    expect(open(game())._state().caught[866].ball).toBe('great-ball')
  })

  it('mends a synced game too', () => {
    const dex = open({ ...game(), caught: { 4: game().caught[4] }, seen: { 4: 1 } })
    dex.importState(game())
    expect(dex._state().caught[7]).toBeUndefined()
  })
})
