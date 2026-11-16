/**
 * The side panel without a party (docs/superpowers/specs/2026-11-16-remove-party-design.md):
 * no party row and no session limit; with nobody resting a session opens without a
 * Pokémon (the plain glyph) and the server gives it the next one to rest. Source checks
 * on src/Widget.tsx (the page itself is shot by the harness: session-nomon).
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import DICTS from '../src/locales'

const SRC = join(__dirname, '..', 'src')
const read = (f: string) => readFileSync(join(SRC, f), 'utf8')
const widget = read('Widget.tsx')

/** The text of `const <name> = ...` up to the next line that starts a sibling declaration at the same indent */
function block(src: string, start: string, end: string): string {
  const i = src.indexOf(start)
  expect(i, start).toBeGreaterThan(-1)
  const j = src.indexOf(end, i + start.length)
  expect(j, end).toBeGreaterThan(-1)
  return src.slice(i, j)
}

const NOTE = '쉬고 있는 포켓몬이 없어서 포켓몬 없이 열었어요. 한 마리가 쉬게 되면 바로 함께해요.'
const SWAP_TITLE = '교체: 이 세션에서 일할 포켓몬을 바꿔요'

describe('the side panel has no party', () => {
  it('no party row, no full state, no limit, no helper session mark', () => {
    for (const gone of ['partyFull', 'FULL_NOTE', 'w-party-head', 'w-party-slots', 'w-party-mon', 'isHelperSession', 'HelperIcon', 'w-row-helper"', 'sessionLimit', 'partySize', 'dex.party', 'dex?.party', 'throwBall', 'Task 7']) {
      expect(widget, gone).not.toContain(gone)
    }
    // the session list's card keeps its class (the harness selects .w-party .w-row)
    expect(widget).toContain('className="w-card w-party"')
    // sub-agent helpers stay
    expect(widget).toContain('w-row-helpers')
  })

  it('HelperIcon is gone from the icons', () => {
    expect(read('components/Icons.tsx')).not.toContain('HelperIcon')
  })

  it('no CSS for the removed parts', () => {
    const css = ['styles/widget.css', 'styles/pokedex.css', 'styles/widget-expanded.css'].map(read).join('\n')
    for (const gone of ['.w-party-head', '.w-party-slots', '.w-party-mon', '.w-row-helper ', '.w-list-btn.full', '.w-rail-btn.full', '.w-launch-main.full']) {
      expect(css, gone).not.toContain(gone)
    }
    // the swap picker's empty state spans the grid
    expect(read('styles/pokedex.css')).toMatch(/\.w-swap-box \.resume-empty \{[^}]*grid-column: 1 \/ -1/)
  })
})

describe('sessions without a Pokémon', () => {
  it('the restore loop reopens every session: no break, no limit', () => {
    const loop = block(widget, 'const restored = useRef(false)', '}, [dex])')
    expect(loop).not.toMatch(/\bbreak\b/)
    expect(loop).not.toMatch(/\blimit\b/)
    expect(loop).toContain('openSession(')
    // the picks (src/resting.ts restorePicks): remembered ones reserved first, one session per Pokémon, else none
    expect(loop).toContain('restorePicks(')
    expect(loop).toMatch(/picks\.get\(s\.sessionId\) \?\? null/)
  })

  it("a restored session's throw is quiet: no partner note at startup", () => {
    const loop = block(widget, 'const restored = useRef(false)', '}, [dex])')
    // the restore loop opens each session quietly
    expect(loop).toMatch(/openSession\([\s\S]*,\s*uid,\s*true\)/)
    // and a quiet open leaves no note about the throw (the '고른 파트너가 다른 세션에서…' one among them)
    const open = block(widget, 'const openSession = ', 'const MAX_SHELLS')
    const at = open.indexOf("t('세션은 열렸어요. 고른 파트너가 다른 세션에서 일하고 있어서 다른 파트너가 함께해요.')")
    expect(at).toBeGreaterThan(-1)
    const line = open.slice(open.lastIndexOf('\n', at), at)
    expect(line).toMatch(/if \(!thrown\.ok && !quiet && !workModeRef\.current\) setNote\(/)
  })

  it('sendOut opens the session with no Pokémon when nobody rests', () => {
    const send = block(widget, 'const sendOut = ', 'const openSession = ')
    expect(send).toMatch(/restingOf\(dex\)/)
    expect(send).toMatch(/openSession\([^()]*,\s*null\)/)
    expect(send).toContain('autoPartner(')
    expect(send).toContain('setThrowing(')
  })

  it('the Pokémon-less note is never shown in 업무 모드', () => {
    const at = widget.indexOf(`t('${NOTE}')`)
    expect(at).toBeGreaterThan(-1)
    const line = widget.slice(widget.lastIndexOf('\n', at), at)
    expect(line).toMatch(/if \(!workMode && dex\) setNote\($/)
    // only once
    expect(widget.indexOf(NOTE, at + NOTE.length)).toBe(-1)
  })

  it('openSession casts first and holds the session in pendingThrows until the throw resolves', () => {
    const open = block(widget, 'const openSession = ', 'const MAX_SHELLS')
    expect(widget).toMatch(/const pendingThrows = useRef<Set<string>>\(new Set\(\)\)/)
    expect(open).toContain('if (uid !== null) pendingThrows.current.add(sessionId)')
    expect(open.indexOf('castSession(')).toBeLessThan(open.indexOf('bridge.terminals.create('))
    expect(open).toContain('pendingThrows.current.add(')
    expect(open).toMatch(/finally \{[^}]*pendingThrows\.current\.delete\(/)
  })

  it('resume keeps the remembered Pokémon when it rests, else sends out as a new session does', () => {
    const resume = block(widget, 'const resume = async', 'const restored = useRef(false)')
    expect(resume).toMatch(/restingOf\(dex\)\.includes\(remembered\)/)
    expect(resume).toContain('openSession(')
    expect(resume).toContain('sendOut({ resume: past })')
  })

  it('noPokemon reaches the row, the header, the chat and the rail', () => {
    expect(widget).toMatch(/const noPokemon = \(r: Row\)/)
    expect(widget).toMatch(/sessionRowParts\(\{[^}]*noPokemon: noPokemon\(r\)/)
    expect(widget).toMatch(/sessionHeaderParts\(\{ \.\.\.shown, noPokemon: noPokemon\(shown\) \}, workMode\)/)
    expect(widget).toMatch(/chatWho\(\{[^}]*noPokemon:/)
    expect(widget).toMatch(/workMode \|\| noPokemon\(r\) \? <span className="w-rail-glyph"/)
  })

  it('a Pokémon-less session is never named after a Pokémon in a notification or the ask card', () => {
    const calls = widget.match(/sessionLabel\([^)]*\)/g) ?? []
    expect(calls.length).toBe(2)
    for (const c of calls) expect(c, c).toMatch(/noPokemon: noPokemon\(/)
  })

  it('QaPage shows a Pokémon-less row', () => {
    expect(read('QaPage.tsx')).toContain('w-row-glyph')
  })
})

describe('words', () => {
  it('the new notes are in en and ja', () => {
    expect(DICTS.en[NOTE]).toBe('No Pokémon is resting, so the session opened without one. The next one to rest joins it.')
    expect(DICTS.ja[NOTE]).toBe('休んでいるポケモンがいないので、ポケモンなしで開きました。休むポケモンが出たらすぐに加わります。')
    expect(DICTS.en[SWAP_TITLE]).toBe('Swap: change the Pokémon working this session')
    expect(DICTS.ja[SWAP_TITLE]).toBe('入れ替え: このセッションで働くポケモンを変えます')
    expect(widget).toContain(`t('${SWAP_TITLE}')`)
  })

  it('the party words are gone', () => {
    const gone = [
      '세션을 최대 {n}개까지 열 수 있어요. 지금 연 세션 하나를 닫으면 새로 열 수 있어요.',
      '파티가 모두 일하는 중이라 박스의 포켓몬이 이 세션을 맡았어요',
      '파티 포켓몬만 교체할 수 있어요',
      '파티의 포켓몬이 모두 일하는 중',
      "{name} · 눌러서 '{session}' 세션의 포켓몬과 교체",
      '{name} · 일하는 중',
      '{name} · 쉬는 중',
      '교체: 이 세션에서 일할 포켓몬을 바꿔요 (파티나 박스에서)',
    ]
    const locale = read('locales/widget.ts')
    for (const k of gone) {
      expect(DICTS.en[k], k).toBeUndefined()
      expect(DICTS.ja[k], k).toBeUndefined()
      expect(locale, k).not.toContain(k)
      expect(widget, k).not.toContain(k)
    }
    // sub-agent helpers keep their words
    expect(DICTS.en['조력자']).toBeTruthy()
    expect(DICTS.en['서브에이전트를 돕는 조력자 (박스에서 나와요)']).toBeTruthy()
  })
})
