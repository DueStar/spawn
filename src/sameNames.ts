/**
 * sameNames — telling apart sessions that carry the same name (2026-11-19, the owner's "two sessions named 'Spawn'").
 * Claude Code copies a /rename'd title onto the conversation a /clear starts, and two tabs can be given one name:
 * the name is kept and a quiet mark added where needed, never a session hidden for it.
 *
 * - `withDates` (the resume list, conversations spread over days): "Spawn · 11/18", then "Spawn · 11/18 14:05"
 *   when two are of one day, then a number.
 * - `numbered` (the open tabs, all of today): the first keeps its name, the next "Spawn (2)", "Spawn (3)".
 * Names that are unique come back as they are; a missing name stays missing (the caller shows its stand-in).
 */

const norm = (s: string) => s.trim().replace(/\s+/g, ' ').toLowerCase()

function groups(names: (string | null | undefined)[]): number[][] {
  const by = new Map<string, number[]>()
  names.forEach((n, i) => {
    if (!n || !n.trim()) return
    const k = norm(n)
    const g = by.get(k)
    if (g) g.push(i)
    else by.set(k, [i])
  })
  return [...by.values()].filter(g => g.length > 1)
}

const pad = (n: number) => String(n).padStart(2, '0')

/** Labels for `names` (same order): duplicates get the day of `stamps[i]` (ms), then its time, then a number */
export function withDates(names: (string | null | undefined)[], stamps: number[]): (string | null)[] {
  const out = names.map(n => (n ?? null))
  for (const g of groups(names)) {
    const day = (i: number) => { const d = new Date(stamps[i]); return `${d.getMonth() + 1}/${d.getDate()}` }
    const time = (i: number) => { const d = new Date(stamps[i]); return `${day(i)} ${pad(d.getHours())}:${pad(d.getMinutes())}` }
    const days = g.map(day)
    const marks = g.map((i, k) => (days.filter(x => x === days[k]).length > 1 ? time(i) : days[k]))
    const seen = new Map<string, number>()
    g.forEach((i, k) => {
      const clash = marks.filter(x => x === marks[k]).length > 1
      const n = (seen.get(marks[k]) ?? 0) + 1
      seen.set(marks[k], n)
      out[i] = `${names[i]!.trim()} · ${marks[k]}${clash && n > 1 ? ` (${n})` : ''}`
    })
  }
  return out
}

/** Labels for `names` (same order): the first of a name keeps it, the next ones get (2), (3)… */
export function numbered(names: (string | null | undefined)[]): (string | null)[] {
  const out = names.map(n => (n ?? null))
  for (const g of groups(names)) g.forEach((i, k) => { if (k) out[i] = `${names[i]!.trim()} (${k + 1})` })
  return out
}
