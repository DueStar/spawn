/**
 * The right side gone black (2026-11-26): the left panel and the top bar drawn, nothing under them — no session
 * header, no chat, no terminal — on any session picked, until spawn was restarted. Not reproduced yet; this
 * watch writes one line to spawn.log when the page sees it, so the next time says which state it was in.
 *
 * Only fixed words and numbers: no session's name, folder or words (the log is shared when asking for help).
 */

export interface BlankState {
  view: string
  mode: string
  lensMode: string
  rows: number
  withTerminal: number
  /** the target picked is one with a terminal */
  targetHasTerm: boolean
  /** the session to show has a terminal */
  shownHasTerm: boolean
  split: boolean
  panes: number
}

export interface BlankDom {
  /** the session header bar's child elements (0: nothing drawn in it) */
  headKids: number
  chatPanes: number
  /** terminals shown (not hidden) under the right side */
  liveTerms: number
  body: { w: number; h: number } | null
  /** the class of what is on top at the right side's centre */
  topAt: string
}

/** Whether the right side is blank with sessions open; null when it is not */
export function blankLine(s: BlankState, d: BlankDom): string | null {
  if (s.view !== 'terminal' || s.mode === 'widget' || s.withTerminal === 0) return null
  if (d.headKids > 0 || d.chatPanes > 0 || d.liveTerms > 0) return null
  const body = d.body ? `${Math.round(d.body.w)}x${Math.round(d.body.h)}` : 'none'
  const top = d.topAt.replace(/[^\w\- ]/g, '').slice(0, 60) || 'none'
  return `right side blank: view ${s.view}, mode ${s.mode}, lens ${s.lensMode}, rows ${s.rows}, with terminal ${s.withTerminal}, `
    + `target has terminal ${s.targetHasTerm}, shown has terminal ${s.shownHasTerm}, split ${s.split}, panes ${s.panes}, `
    + `head ${d.headKids}, chat panes ${d.chatPanes}, live terminals ${d.liveTerms}, body ${body}, top ${top}`
}

/** The DOM half, read from the page (the right side's body is `.w-term-body`) */
export function readBlankDom(body: HTMLElement | null): BlankDom {
  const head = document.querySelector('.w-sess-bar')
  const chatPanes = document.querySelectorAll('.w-chat-pane').length
  let liveTerms = 0
  if (body) for (const el of Array.from(body.querySelectorAll('.xterm'))) {
    const r = (el as HTMLElement).getBoundingClientRect()
    if (r.width > 0 && r.height > 0 && getComputedStyle(el as HTMLElement).visibility !== 'hidden') liveTerms++
  }
  const box = body?.getBoundingClientRect() ?? null
  let topAt = 'none'
  if (box && box.width > 0 && box.height > 0) {
    const el = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2)
    topAt = el ? `${el.tagName.toLowerCase()} ${typeof el.className === 'string' ? el.className : ''}`.trim() : 'none'
  }
  return { headKids: head ? head.children.length : 0, chatPanes, liveTerms, body: box ? { w: box.width, h: box.height } : null, topAt }
}
