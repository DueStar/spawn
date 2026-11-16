/**
 * resting — which caught Pokémon rest, and in what order. Pure rules the page
 * shares (the pickers, 업무 모드's partner, 랭킹's partner choice); no store, no React.
 *
 * A Pokémon rests when it is in the box and neither works a session (`assign`)
 * nor helps a subagent (`helpers`). "Most recently worked first" is the server's
 * byRecentWork (server/pokedex.js), mirrored here: one that went out (`outAt`)
 * comes before one that never did, the later first; then by work time, the most
 * first; ties keep the given order.
 */

export interface WorkedMon { dex?: number; outAt?: number; workMs?: number }

export interface RestingDex {
  box: string[]
  mons: Record<string, WorkedMon | undefined>
  /** sessionId -> uid working it */
  assign?: Record<string, string>
  /** sessionId -> uids helping its subagents */
  helpers?: Record<string, string[]>
}

/** The given uids, most recently worked first (a new array; the same order as the server's) */
export function byRecentWork(uids: string[], mons: RestingDex['mons']): string[] {
  const outAt = (u: string) => { const t = mons?.[u]?.outAt; return typeof t === 'number' ? t : null }
  const workMs = (u: string) => { const w = mons?.[u]?.workMs; return typeof w === 'number' ? w : 0 }
  return uids
    .map((u, i) => ({ u, i, out: outAt(u), work: workMs(u) }))
    .sort((a, b) => {
      if (a.out !== null || b.out !== null) {
        if (a.out === null) return 1
        if (b.out === null) return -1
        if (a.out !== b.out) return b.out - a.out
      } else if (a.work !== b.work) return b.work - a.work
      return a.i - b.i
    })
    .map(x => x.u)
}

/** Box Pokémon not working a session and not helping a subagent, most recently worked first */
export function restingUids(s: RestingDex): string[] {
  const busy = new Set([...Object.values(s.assign ?? {}), ...Object.values(s.helpers ?? {}).flat()])
  return byRecentWork(s.box.filter(u => s.mons[u] && !busy.has(u)), s.mons)
}

/**
 * The Pokémon a session goes out with when nobody picks one (the server's
 * ensureAssigned rule): `prefer` if it rests; else the resting one that worked
 * most recently; when none has ever worked, a random resting one. null: none rests.
 */
export function pickResting(s: RestingDex, prefer?: string | null, random: () => number = Math.random): string | null {
  const resting = restingUids(s)
  if (!resting.length) return null
  if (prefer && resting.includes(prefer)) return prefer
  const first = s.mons[resting[0]]
  if (typeof first?.outAt === 'number' || (first?.workMs ?? 0) > 0) return resting[0]
  return resting[Math.min(resting.length - 1, Math.floor(random() * resting.length))]
}

/**
 * Who comes back with each session reopened at start: its remembered Pokémon when that one rests,
 * else the first resting one (most recently worked first) that no other session took or remembers,
 * else none (null: it waits for the next to rest). The remembered ones are reserved before any pick,
 * so an earlier session never takes the one a later session comes back with. A Pokémon goes with
 * one session only. `resting`: the resting uids, most recently worked first
 */
export function restorePicks(sessions: { id: string; remembered?: string | null }[], resting: string[]): Map<string, string | null> {
  const rests = new Set(resting)
  const reserved = new Set(sessions.map(s => s.remembered).filter((u): u is string => !!u && rests.has(u)))
  const used = new Set<string>()
  const picks = new Map<string, string | null>()
  for (const s of sessions) {
    const own = s.remembered && rests.has(s.remembered) && !used.has(s.remembered) ? s.remembered : null
    const uid = own ?? resting.find(u => !used.has(u) && !reserved.has(u)) ?? null
    if (uid) used.add(uid)
    picks.set(s.id, uid)
  }
  return picks
}

/** How many species 랭킹 offers as the partner */
export const PARTNER_CHOICES = 6

/**
 * 랭킹's partner choice: the species of the most recently worked Pokémon (working
 * ones included), six at most, each once; the current partner is added when it is
 * not among them.
 */
export function recentPartnerDex(s: RestingDex, current: number | null): number[] {
  const out: number[] = []
  for (const u of byRecentWork(s.box, s.mons)) {
    if (out.length >= PARTNER_CHOICES) break
    const d = s.mons[u]?.dex
    if (typeof d === 'number' && d > 0 && !out.includes(d)) out.push(d)
  }
  if (current !== null && !out.includes(current)) out.push(current)
  return out
}
