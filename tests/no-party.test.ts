/**
 * The guard for "one box, no party": no party word in any translation table or source file, none of the
 * removed names (the session limit, the party-full note, the box helper session, the exchange call), and the
 * server's pokedex no longer exports a session limit or a party size, nor answers with the party's reasons.
 * The kept compatibility pieces (desktop.ts's `exchange` type, the internal `.w-party` class) are allowed.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = join(__dirname, '..')
const SRC = join(ROOT, 'src')

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap(name => {
    const p = join(dir, name)
    return statSync(p).isDirectory() ? walk(p) : [p]
  })
}
const FILES = walk(SRC).map(p => ({ path: relative(ROOT, p).replace(/\\/g, '/'), text: readFileSync(p, 'utf8') }))
/** `.party` read off a value (`x.party`, `x?.party`, `a[0].party`, `f().party`); a class name like `.w-party` never has the dot right before `party` */
const PROP = /[\w?\])]\.party\b/
const CODE = FILES.filter(f => /\.(ts|tsx)$/.test(f.path))

describe('no party anywhere on the page', () => {
  it('no translation key or value names a party', async () => {
    const PARTY = /파티|\bparty\b|\bparties\b|手持ち/i
    const tables = FILES.filter(f => f.path.startsWith('src/locales/') && f.path !== 'src/locales/index.ts')
    expect(tables.length).toBeGreaterThan(3)
    const bad: string[] = []
    for (const f of tables) {
      const mod = (await import(join(ROOT, f.path))).default as Record<string, Record<string, string>>
      for (const [lang, table] of Object.entries(mod)) {
        for (const [k, v] of Object.entries(table)) if (PARTY.test(k) || PARTY.test(v)) bad.push(`${f.path} ${lang}: ${k} -> ${v}`)
      }
    }
    expect(bad).toEqual([])
  })

  it('no source file says 파티 or 手持ち', () => {
    expect(FILES.filter(f => /파티|手持ち/.test(f.text)).map(f => f.path)).toEqual([])
  })

  it('none of the removed names is left in the code', () => {
    const NAMES = ['partyFull', 'FULL_NOTE', 'freeSessionCount', 'freePartyCount', 'isHelperSession', 'HelperIcon', 'sessionLimit', 'partySize']
    const bad: string[] = []
    for (const f of FILES) for (const n of NAMES) if (f.text.includes(n)) bad.push(`${f.path}: ${n}`)
    // `.party` read as a property (the internal class `.w-party` is kept and does not count)
    for (const f of CODE) if (PROP.test(f.text)) bad.push(`${f.path}: .party`)
    // the exchange call (desktop.ts keeps the bridge's type for old saves' IPC)
    for (const f of FILES) if (f.path !== 'src/desktop.ts' && /\bexchange\(/.test(f.text)) bad.push(`${f.path}: exchange(`)
    expect(bad).toEqual([])
  })

  it('the regex for `.party` catches a property read and spares the class name', () => {
    const re = PROP
    expect(re.test('const p = state?.party ?? []')).toBe(true)
    expect(re.test('dex.party.length')).toBe(true)
    expect(re.test("page.locator('.w-party .w-row')")).toBe(false)
    expect(re.test('<div className="w-party">')).toBe(false)
    expect(re.test('.box-party, .box-party-row')).toBe(false)
    expect(re.test('state.party')).toBe(true)
  })

  it('the server exports no session limit or party size and has no party reasons', async () => {
    const src = readFileSync(join(ROOT, 'server', 'pokedex.js'), 'utf8')
    for (const s of ["'party-free'", "'full'", "'in-party'", "'not-in-party'"]) expect(src, s).not.toContain(s)
    expect(src).not.toMatch(/export\s+(const|function|let)\s+(SESSION_LIMIT|PARTY_SIZE)\b/)
    const mod = await import('../server/pokedex.js')
    expect(mod).not.toHaveProperty('SESSION_LIMIT')
    expect(mod).not.toHaveProperty('PARTY_SIZE')
  })
})
