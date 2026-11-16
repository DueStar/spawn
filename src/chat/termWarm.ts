/**
 * The hidden terminal's size (7-48). A session shown as chat mounts its terminal hidden, so xterm
 * writes the replay at its own 80×24 while the pty keeps its real size: nothing makes Claude Code
 * redraw, and the composer reads a garbled prompt row ("확인하지 못했어요", safe but stuck).
 *
 *   warm mount   the shown chat session's TerminalView is given `active` (and no focus) under the
 *                opaque chat pane until it has been active for two frames while the page is
 *                visible ("settled"), then handed back. It fits as the on-screen terminal does in
 *                1.4.0, before the replay's answer arrives.
 *   one redraw   a terminal whose first mount was not both active and visible ("replayed-first":
 *                a background session at page load, a window built hidden for a widget → window
 *                swap) asks main once, after it settled, for one resize nudge (chat.redraw;
 *                electron/chatHost.cjs redraw decides, electron/terminals.cjs resizes the pty
 *                and never writes to it).
 *
 * Per page, in memory; a terminal gone is let go (onChatForget). TerminalPanel.tsx is not touched:
 * only Widget.tsx's `active` / `focus` for the main TerminalView follow this.
 */

import { useEffect, useState } from 'react'
import { bridge } from '../desktop'
import { termSize } from '../termMetrics'
import { onChatForget } from './lensMode'

type Mount = 'fitted-first' | 'replayed-first'

const mounts = new Map<string, Mount>()
const settled = new Set<string>()
const asked = new Set<string>()

/** The first render of a terminal's TerminalView on this page: how it mounts (later calls change nothing) */
export function noteMount(id: string, at: { active: boolean; visible: boolean }): void {
  if (mounts.has(id)) return
  mounts.set(id, at.active && at.visible ? 'fitted-first' : 'replayed-first')
}

/** How a terminal first mounted on this page (null: not noted) */
export function mountedAs(id: string): Mount | null { return mounts.get(id) ?? null }

/** Whether the shown chat session's terminal must still be kept active under the chat */
export function warmNeeded(id: string): boolean { return !settled.has(id) }

/** It has been active for two frames while visible: its xterm has its real size */
export function settle(id: string): void { settled.add(id) }

/** One redraw is wanted: the terminal replayed before it fitted, and none was asked for yet */
export function redrawNeeded(id: string): boolean { return mounts.get(id) === 'replayed-first' && !asked.has(id) }

export function markRedrawAsked(id: string): void { asked.add(id) }

/** Main refused for a reason that may pass (not shown yet, a send or a card open, a nudge just made) */
export function redrawAgain(id: string): void { asked.delete(id) }

/** Whether useWarm has anything to do: settle a terminal not settled yet, or (in chat) ask its one redraw */
export function warmWanted(id: string, chat: boolean): boolean { return warmNeeded(id) || (chat && redrawNeeded(id)) }

function forget(id: string): void { mounts.delete(id); settled.delete(id); asked.delete(id) }
onChatForget(forget)

/** Refusals that may pass while the chat stays shown: asked again a little later (bounded) */
const AGAIN = new Set(['not-shown', 'sending', 'waiting', 'recent'])
const AGAIN_MS = 2000
const AGAIN_MAX = 8

/**
 * While `on` (the session view shows this session's terminal, the chat offered for it) and the page is
 * visible: after two frames with the terminal readable, it is settled. Only while the chat is shown
 * (`chat`), a terminal that replayed first then asks main for its one redraw. In terminal mode nothing
 * is asked and nothing about the terminal changes (warm is never true there). Nothing left to do (settled, and
 * no redraw wanted in chat): no frame is asked for at all.
 */
export function useWarm(id: string | undefined, on: boolean, chat: boolean): void {
  const [, redraw] = useState(0)
  useEffect(() => {
    if (!id || !on || !warmWanted(id, chat)) return
    let gone = false
    let frame = 0
    let again: ReturnType<typeof setTimeout> | null = null
    let tries = 0
    let seen = 0
    const ask = () => {
      again = null
      if (gone || !chat || !redrawNeeded(id) || typeof bridge?.chat.redraw !== 'function') return
      markRedrawAsked(id)
      bridge.chat.redraw(id).then((r) => {
        if (!r || r.ok) return
        if (!AGAIN.has(r.reason)) return
        redrawAgain(id)
        if (!gone && tries++ < AGAIN_MAX) again = setTimeout(ask, AGAIN_MS)
      }, () => {})
    }
    const tick = () => {
      frame = 0
      if (gone) return
      seen = document.visibilityState === 'visible' && termSize(id) ? seen + 1 : 0
      if (seen >= 2) {
        const first = warmNeeded(id)
        settle(id)
        // (the warm terminal goes back to hidden: Widget reads warmNeeded again)
        if (first && chat) redraw(n => n + 1)
        ask()
        return
      }
      frame = requestAnimationFrame(tick)
    }
    frame = requestAnimationFrame(tick)
    return () => {
      gone = true
      if (frame) cancelAnimationFrame(frame)
      if (again) clearTimeout(again)
    }
  }, [id, on, chat])
}
