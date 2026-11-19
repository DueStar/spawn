/**
 * Wild Pokémon in the chat's flow: the game's own `catch` / `flee` events of this session that
 * happened inside this conversation's time, as entries the rows place where they met (src/chat/rows.ts `extra`).
 *
 * Only what the server reported: an event with this session's id (server/pokedex.js stamps each encounter with the
 * session that met it), of kind catch or flee, inside [from, to]: from the conversation's first stamped item (the
 * start when nothing is older; else the oldest loaded one) to now. Nothing is guessed from a prompt or a tool call: an
 * entry keeps the species, the result and what the catch card says of it, never `via` (the request text) or the place.
 * The events come from the page's own game state (`usePokedex()`: DexState.log and .today, which overlap), so the same
 * meeting is kept once. Pure: no fetch, no server change.
 */

import type { DexEvent, Tier } from '../pokedexStore'
import type { ChatItem } from './types'

export interface WildEntry {
  /** `${kind}:${at}:${dex}` — the same meeting in log and today is one entry */
  key: string
  at: number
  kind: 'catch' | 'flee'
  dex: number
  shiny: boolean
  tier: Tier | null
  level: number | null
  /** The first catch of its species (새로 등록) */
  newSpecies: boolean
  /** The ball it was caught in (server/balls.json id); null for a flee */
  ball: string | null
}

/** At most this many entries, the newest (the game's log holds a few hundred events) */
export const WILD_MAX = 200

const TIERS = new Set<Tier>(['common', 'rare', 'sub', 'legendary', 'mythical'])
const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n)

/** The conversation's time: its first stamped item to now; null while no item has a time */
export function wildWindow(items: ChatItem[], now: number): { from: number; to: number } | null {
  for (const it of items) if (finite(it.at)) return { from: it.at, to: now }
  return null
}

/** This session's catches and flees inside [from, to], oldest first, each once, the newest WILD_MAX */
export function wildEntries(events: DexEvent[], sessionId: string, { from, to }: { from: number; to: number }): WildEntry[] {
  const byKey = new Map<string, WildEntry>()
  for (const e of events) {
    if (!e || (e.kind !== 'catch' && e.kind !== 'flee')) continue
    if (typeof e.sessionId !== 'string' || e.sessionId !== sessionId) continue
    if (!finite(e.at) || !finite(e.id) || e.at < from || e.at > to) continue
    const key = `${e.kind}:${e.at}:${e.id}`
    if (byKey.has(key)) continue
    byKey.set(key, {
      key,
      at: e.at,
      kind: e.kind,
      dex: e.id,
      shiny: e.shiny === true,
      tier: e.tier && TIERS.has(e.tier) ? e.tier : null,
      level: finite(e.level) ? e.level : null,
      newSpecies: e.kind === 'catch' && e.newSpecies === true,
      ball: e.kind === 'catch' && typeof e.ball === 'string' ? e.ball : null,
    })
  }
  const out = [...byKey.values()].sort((a, b) => a.at - b.at || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
  return out.length > WILD_MAX ? out.slice(out.length - WILD_MAX) : out
}

/** Two lists of entries that draw the same (the game's state is sent whole on every event: most change nothing here) */
export function sameEntries(a: WildEntry[], b: WildEntry[]): boolean {
  return a.length === b.length && a.every((e, i) => e.key === b[i].key && e.shiny === b[i].shiny && e.tier === b[i].tier &&
    e.level === b[i].level && e.newSpecies === b[i].newSpecies && e.ball === b[i].ball)
}
