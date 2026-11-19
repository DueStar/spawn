/**
 * The hidden terminal's size (7-48, Task 5.2), the page's half: src/chat/termWarm.ts remembers how
 * each terminal's xterm first mounted (fitted while shown and visible, or replayed first), keeps the
 * shown chat session's terminal warm (active under the opaque chat pane, never focused) until it has
 * fitted once, and asks for one redraw only for a terminal that replayed first. Widget.tsx wires it
 * to the main TerminalView only, and only while the chat is shown (terminal mode: 1.4.0).
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { markRedrawAsked, mountedAs, noteMount, redrawAgain, redrawNeeded, settle, warmNeeded, warmWanted } from '../src/chat/termWarm'
import { forgetChatTerminal } from '../src/chat/lensMode'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
let n = 0
const fresh = () => `term-${++n}`

describe('termWarm: how a terminal first mounted, per page', () => {
  it('noteMount is first-call-wins: fitted-first only when active and visible', () => {
    const a = fresh()
    noteMount(a, { active: true, visible: true })
    noteMount(a, { active: false, visible: false })
    expect(mountedAs(a)).toBe('fitted-first')
    for (const [active, visible] of [[false, true], [true, false], [false, false]] as const) {
      const id = fresh()
      noteMount(id, { active, visible })
      noteMount(id, { active: true, visible: true })
      expect(mountedAs(id), `${active}/${visible}`).toBe('replayed-first')
    }
    expect(mountedAs(fresh())).toBeNull()
  })

  it('warmNeeded stays true until settle', () => {
    const a = fresh()
    expect(warmNeeded(a)).toBe(true)
    noteMount(a, { active: false, visible: true })
    expect(warmNeeded(a)).toBe(true)
    expect(warmNeeded(a)).toBe(true)
    settle(a)
    expect(warmNeeded(a)).toBe(false)
    settle(a)
    expect(warmNeeded(a)).toBe(false)
    expect(warmNeeded(fresh())).toBe(true)
  })

  it('redrawNeeded: only for replayed-first, and only once (a refusal that may pass later asks again)', () => {
    const fitted = fresh()
    noteMount(fitted, { active: true, visible: true })
    settle(fitted)
    expect(redrawNeeded(fitted)).toBe(false)
    const unknown = fresh()
    expect(redrawNeeded(unknown)).toBe(false)
    const replayed = fresh()
    noteMount(replayed, { active: false, visible: true })
    expect(redrawNeeded(replayed)).toBe(true)
    markRedrawAsked(replayed)
    expect(redrawNeeded(replayed)).toBe(false)
    redrawAgain(replayed)
    expect(redrawNeeded(replayed)).toBe(true)
    markRedrawAsked(replayed)
    expect(redrawNeeded(replayed)).toBe(false)
    // redrawAgain never makes a fitted-first terminal ask
    redrawAgain(fitted)
    expect(redrawNeeded(fitted)).toBe(false)
  })

  it('(review) warmWanted: a frame is needed only to settle, or in chat for a redraw still wanted', () => {
    const fitted = 'ww-fitted', replayed = 'ww-replayed'
    noteMount(fitted, { active: true, visible: true })
    noteMount(replayed, { active: false, visible: true })
    expect(warmWanted(fitted, false)).toBe(true)
    expect(warmWanted(fitted, true)).toBe(true)
    settle(fitted)
    expect(warmWanted(fitted, false)).toBe(false)
    expect(warmWanted(fitted, true)).toBe(false)
    settle(replayed)
    // terminal mode, settled: nothing; in chat: the redraw it still wants, until asked
    expect(warmWanted(replayed, false)).toBe(false)
    expect(warmWanted(replayed, true)).toBe(true)
    markRedrawAsked(replayed)
    expect(warmWanted(replayed, true)).toBe(false)
    // a terminal never noted (the chat not offered for it): only its settling, never a redraw
    expect(warmWanted('ww-never', true)).toBe(true)
    settle('ww-never')
    expect(warmWanted('ww-never', true)).toBe(false)
  })

  it('onChatForget (the terminal gone) clears everything about it', () => {
    const a = fresh()
    noteMount(a, { active: false, visible: false })
    settle(a)
    markRedrawAsked(a)
    forgetChatTerminal(a)
    expect(mountedAs(a)).toBeNull()
    expect(warmNeeded(a)).toBe(true)
    expect(redrawNeeded(a)).toBe(false)
    noteMount(a, { active: true, visible: true })
    expect(mountedAs(a)).toBe('fitted-first')
  })
})

describe('Widget.tsx: warm only for the main TerminalView of the shown chat session', () => {
  const src = readFileSync(join(ROOT, 'src', 'Widget.tsx'), 'utf8')
  const TODAY = "view === 'terminal' && shown?.sessionId === r.sessionId && !(r.sessionId === shown?.sessionId && lensMode === 'chat')"

  it('warm needs the chat shown, the session view, this session, and a terminal not settled yet', () => {
    const warm = /const warm = ([^\n]+)/.exec(src)?.[1] ?? ''
    for (const part of ["lensMode === 'chat'", "view === 'terminal'", 'r.sessionId === shown?.sessionId', 'warmNeeded(r.terminal.id)']) expect(warm, part).toContain(part)
    expect(src.match(/const warm = /g)).toHaveLength(1)
  })

  it("the main TerminalView: active={today's expression || warm} and focus={warm ? false : undefined}; the mount noted with the same active", () => {
    const main = /<TerminalView key=\{r\.terminal\.id\}[^\n]*\/>/.exec(src)?.[0] ?? ''
    // (2026-11-19, the split view: outside it the expression is today's; in it each pane's terminal in its own box)
    expect(src).toContain(`: (${TODAY}) || warm`)
    expect(src.match(/const active = /g)).toHaveLength(1)
    expect(main).toBe('<TerminalView key={r.terminal.id} term={r.terminal} active={active} focus={warm || (split && r.sessionId !== shown?.sessionId) ? false : undefined} slot={pane >= 0 ? paneStyle(pane, paneSids.length, fracs) : undefined} />')
    expect(src).toContain("noteMount(r.terminal.id, { active, visible: document.visibilityState === 'visible' })")
    expect(src.indexOf('noteMount(r.terminal.id')).toBeLessThan(src.indexOf('<TerminalView key={r.terminal.id}'))
  })

  it('(review) with the chat not offered nothing of termWarm runs: noteMount only for a terminal that offers the chat; warm reads warmNeeded only in chat', () => {
    // the mount is noted only where this terminal offers the chat (the feature on, Claude Code, a window)
    expect(src).toContain("if (lensAvailability(r.terminal, mode).show) noteMount(r.terminal.id, { active, visible: document.visibilityState === 'visible' })")
    expect(src.match(/noteMount\(/g)).toHaveLength(1)
    // warm: lensMode === 'chat' first, so warmNeeded is never called while the chat is not shown
    const warm = /const warm = ([^\n]+)/.exec(src)?.[1] ?? ''
    expect(warm.startsWith("lensMode === 'chat' && ")).toBe(true)
    // useWarm gets no terminal unless the shown session offers the chat (its effect returns before any frame)
    expect(src).toMatch(/const warmTerm = view === 'terminal' && lens\.show \? shown\?\.terminal\?\.id : undefined/)
    expect(src).toMatch(/useWarm\(warmTerm, !!warmTerm, lensMode === 'chat'\)/)
  })

  it('(review) useWarm asks for no frame when nothing is left to do (settled, and no redraw wanted in chat)', () => {
    const warm = readFileSync(join(ROOT, 'src', 'chat', 'termWarm.ts'), 'utf8')
    const effect = warm.slice(warm.indexOf('export function useWarm'))
    const guard = effect.indexOf('if (!id || !on || !warmWanted(id, chat)) return')
    expect(guard).toBeGreaterThan(0)
    expect(guard).toBeLessThan(effect.indexOf('requestAnimationFrame('))
  })

  it('the widget\'s question card is untouched: no warm, no focus prop', () => {
    expect(src).toContain('<TerminalView key={`ask-${askRow.terminal.id}`} term={askRow.terminal} active />')
    expect(src.match(/focus=\{warm \|\| \(split && r\.sessionId !== shown\?\.sessionId\) \? false : undefined\}/g)).toHaveLength(1)
    expect(src.match(/<TerminalView /g)).toHaveLength(2)
  })

  it('useWarm runs only while the session view shows a session that offers the chat, and asks for a redraw only in chat', () => {
    const call = /useWarm\(([^\n]+)\)/.exec(src)?.[1] ?? ''
    expect(call).toContain("lensMode === 'chat'")
    expect(src).toMatch(/const warmTerm = view === 'terminal' && lens\.show \? shown\?\.terminal\?\.id : undefined/)
  })

  it('the chat pane is opaque (also while ChatView loads), so a warm terminal never shows', () => {
    const css = readFileSync(join(ROOT, 'src', 'styles', 'widget-expanded.css'), 'utf8')
    expect(css).toMatch(/\.w-chat-pane \{[^}]*background: var\(--bg\)/)
  })

  it('termWarm asks main through chat.redraw only, and only from useWarm', () => {
    const warm = readFileSync(join(ROOT, 'src', 'chat', 'termWarm.ts'), 'utf8')
    expect(warm.match(/chat\.redraw\(/g)).toHaveLength(1)
    expect(warm).not.toMatch(/terminals\.(write|resize|send)|typeForChat/)
    expect(src).not.toMatch(/chat\.redraw\(/)
  })
})
