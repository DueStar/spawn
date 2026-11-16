/**
 * Find in the conversation (Phase 5): the bar (the terminal's `.term-search` place and size, in the chat's calm
 * greys) and what it does. Ctrl/⌘+F opens it (ChatView's key listener).
 *
 *   - It searches the store (src/chat/find.ts), only what is loaded: while older items exist it says
 *     `불러온 대화에서만 찾아요`. Typing waits 120 ms and never searches mid-composition (an IME's syllable is never
 *     cut). The count `{i}/{n}` / `결과 없음` / `{i} · {n}개 넘음` is a polite live region.
 *   - Enter goes to the next match, Shift+Enter the previous (the first press: the match at or after the top of the
 *     view, the one the count names), wrapping. Going there opens what it lies in (a read group, a tool's output,
 *     a diff's lines past its preview, an Agent row: setRowOpen) and places its row in the middle of the view
 *     (ChatList scrollToKey; at once under reduced motion), then brings the match itself into view inside a tall row.
 *   - Esc closes it and gives the focus back to where it was.
 *   - Painting: the matches in the rows on screen are found in their text nodes (read only) and painted with the
 *     CSS Custom Highlight API ('chat-find', the current one 'chat-find-now': greys, src/styles/chat.css); no markup
 *     is rewritten, and only rows that hold a match of the store are looked at (the app's own words — a button, a
 *     time, a count — are passed over). Without the API, or when the current match is in a part the row does not
 *     draw as text (a command behind its description), the current row is outlined instead.
 *   - Per terminal, in memory (let go with the session: onChatForget): whether the bar is open and its query.
 */

import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { t } from '../../i18n'
import { modCombo } from '../../platform'
import { onChatForget } from '../../chat/lensMode'
import { FIND_LIMIT, findMatches, fold, foldQuery, openFor, placesIn, type FindMatch, type FindResult } from '../../chat/find'
import type { Density } from '../../chat/density'
import type { Row } from '../../chat/rows'
import type { ChatItem } from '../../chat/types'
import type { ChatListHandle } from './ChatList'
import { setRowOpen } from './context'

/** Typing settles this long before it is searched */
export const FIND_DEBOUNCE_MS = 120

const memory = new Map<string, { open: boolean; query: string }>()
onChatForget(id => memory.delete(id))

const NO_RESULT: FindResult = { matches: [], more: false }
const keyOf = (m: FindMatch) => `${m.itemId}\u0000${m.field}\u0000${m.start}`
const reducedMotion = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches

// ---------------------------------------------------------------- painting (DOM read only)

/** Text in a row that is the app's, not the conversation's: never painted */
const CHROME = [
  '.chat-copy', '.chat-text-acts', '.chat-code-head', '.chat-sr', '[aria-hidden="true"]', '.chat-time', '.chat-tool-meta',
  '.chat-tool-label', '.chat-diff-more', '.chat-counts', '.chat-diff-hidden', '.chat-diff-cut', '.chat-diff-kind', '.chat-tool-note',
  '.chat-cut', '.chat-stopped', '.chat-sub-label', '.chat-think-head', '.chat-think-none', '.chat-pending', '.chat-img-chip',
  '.chat-btn', '.chat-link-btn', '.chat-dl .no', '.chat-dl .sg', '.chat-ln > span:not(.hit)', '.chat-live-label',
].join(', ')
/** A text node's block: text in two blocks never runs together (a match never spans them, as in the store) */
const BLOCK = 'p, li, pre, td, th, h1, h2, h3, h4, blockquote, div, .chat-tool-detail, .chat-tool-err, .hit, .tx'

type Highlights = { set(name: string, h: unknown): void; delete(name: string): void }
const registry = (): Highlights | null => {
  const c = (globalThis as { CSS?: { highlights?: Highlights } }).CSS
  return c?.highlights && typeof (globalThis as { Highlight?: unknown }).Highlight === 'function' ? c.highlights : null
}
function clearPaint() {
  const reg = registry()
  if (!reg) return
  reg.delete('chat-find')
  reg.delete('chat-find-now')
}

/** The ranges where `q` (folded) is in a row's own text, in document order */
function rangesIn(row: HTMLElement, q: string): Range[] {
  const segs: { node: Text; at: number }[] = []
  let text = ''
  let block: Element | null = null
  const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT)
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const node = n as Text
    const parent = node.parentElement
    if (!parent || !node.data) continue
    const chrome = parent.closest(CHROME)
    if (chrome && row.contains(chrome)) continue
    const b = parent.closest(BLOCK)
    if (b !== block) { if (text) text += '\n'; block = b }
    segs.push({ node, at: text.length })
    text += node.data
  }
  if (!segs.length) return []
  const at = (pos: number, end: boolean): [Text, number] => {
    // the segment holding pos (an end may sit at a segment's very end)
    let lo = 0
    for (let k = 0; k < segs.length; k++) {
      const s = segs[k]
      if (end ? pos > s.at : pos >= s.at) lo = k
      else break
    }
    const s = segs[lo]
    return [s.node, Math.min(Math.max(0, pos - s.at), s.node.data.length)]
  }
  const out: Range[] = []
  for (const [start, end] of placesIn(text, q, fold(text))) {
    const r = document.createRange()
    const [sn, so] = at(start, false)
    const [en, eo] = at(end, true)
    try { r.setStart(sn, so); r.setEnd(en, eo) } catch { continue }
    if (!r.collapsed) out.push(r)
  }
  return out
}

/**
 * Paints the matches of the mounted rows; returns the current match's range (null: not on screen as text, or no
 * Highlight API — the row is outlined then)
 */
function paint(root: HTMLElement, result: FindResult, query: string, current: number | null): { now: Range | null; painted: boolean } {
  const reg = registry()
  const q = foldQuery(query)
  if (!reg || !q || !result.matches.length) { clearPaint(); return { now: null, painted: !!reg } }
  // the rows that hold a match, and the current match's place among its row's
  const holding = new Set(result.matches.map(m => m.rowKey))
  const cur = current !== null ? result.matches[current] ?? null : null
  let k = 0
  if (cur) for (let j = current! - 1; j >= 0 && result.matches[j].rowKey === cur.rowKey; j--) k++
  const all: Range[] = []
  let now: Range | null = null
  for (const row of root.querySelectorAll<HTMLElement>('.chat-rows > .chat-row[data-key]')) {
    const key = row.dataset.key!
    if (!holding.has(key)) continue
    const ranges = rangesIn(row, q)
    if (cur && key === cur.rowKey && ranges.length) now = ranges[Math.min(k, ranges.length - 1)]
    for (const r of ranges) if (r !== now) all.push(r)
  }
  const H = (globalThis as unknown as { Highlight: new (...r: Range[]) => unknown }).Highlight
  reg.set('chat-find', new H(...all))
  if (now) reg.set('chat-find-now', new H(now)); else reg.delete('chat-find-now')
  return { now, painted: true }
}

/** The key of the first row in view (the count's starting point) */
function firstInView(root: HTMLElement): string | null {
  const box = root.querySelector('.chat-scroll')?.getBoundingClientRect()
  if (!box) return null
  for (const row of root.querySelectorAll<HTMLElement>('.chat-rows > .chat-row[data-key]')) {
    if (row.getBoundingClientRect().bottom > box.top + 1) return row.dataset.key ?? null
  }
  return null
}

// ---------------------------------------------------------------- the state

export interface UseFind {
  open: boolean
  /** Ctrl/⌘+F: open the bar (or, open, select its text) */
  openBar(): void
  /** The row to outline (no Highlight API, or the match is not drawn as text) */
  findNow: string | null
  bar: FindBarProps | null
}

export function useFind(o: {
  id: string; items: ChatItem[]; rows: Row[]; density: Density; hasOlder: boolean
  list: React.RefObject<ChatListHandle>; root: React.RefObject<HTMLElement>; listFocus(): void
}): UseFind {
  const { id, items, rows, density, list, root } = o
  const saved = memory.get(id)
  const [open, setOpen] = useState(saved?.open ?? false)
  const [query, setQuery] = useState(saved?.query ?? '')
  // the current match: its index (the count), and the match itself (kept current across a new result)
  const [current, setCurrentState] = useState<number | null>(null)
  const currentRef = useRef<number | null>(null)
  const currentKey = useRef<string | null>(null)
  const setCurrent = (i: number | null, m: FindMatch | null) => { currentRef.current = i; currentKey.current = m ? keyOf(m) : null; setCurrentState(i) }
  /** The current match was gone to (Enter moves on from it); not yet: Enter goes to it */
  const visited = useRef(false)
  const [focusAsk, setFocusAsk] = useState(0)
  const [outline, setOutline] = useState<string | null>(null)
  const [placed, setPlaced] = useState(0)
  const reveal = useRef(false)
  const returnTo = useRef<Element | null>(null)
  const pending = useRef<1 | -1 | null>(null)
  const listFocus = useRef(o.listFocus)
  listFocus.current = o.listFocus
  useEffect(() => { memory.set(id, { open, query }) }, [id, open, query])

  const result = useMemo(() => (open ? findMatches(items, rows, query, density) : NO_RESULT), [open, items, rows, query, density])
  const resultRef = useRef(result)
  resultRef.current = result
  const rowsRef = useRef(rows)
  rowsRef.current = rows

  const go = useCallback((index: number) => {
    const m = resultRef.current.matches[index]
    if (!m) return
    visited.current = true
    setCurrent(index, m)
    for (const k of openFor(m)) setRowOpen(id, k, true)
    reveal.current = true
    void Promise.resolve(list.current?.scrollToKey(m.rowKey, { align: 'center' })).then(() => setPlaced(n => n + 1))
  }, [id, list]) // eslint-disable-line react-hooks/exhaustive-deps

  const step = useCallback((dir: 1 | -1) => {
    const n = resultRef.current.matches.length
    if (!n) return
    const cur = currentRef.current
    let at: number
    if (cur === null) at = dir > 0 ? 0 : n - 1
    else if (!visited.current) at = dir > 0 ? cur : (cur - 1 + n) % n
    else at = (cur + dir + n) % n
    go(at)
  }, [go])

  // a new result: the same match stays current; else the first at or after the top of the view (not gone to yet);
  // then an Enter that waited for this search goes on
  useLayoutEffect(() => {
    const ms = result.matches
    const same = currentKey.current ? ms.findIndex(m => keyOf(m) === currentKey.current) : -1
    if (!ms.length) setCurrent(null, null)
    else if (same >= 0) setCurrent(same, ms[same])
    else {
      visited.current = false
      const top = root.current ? firstInView(root.current) : null
      const order = new Map(rowsRef.current.map((r, i) => [r.key, i]))
      const from = top !== null ? order.get(top) ?? 0 : 0
      let at = ms.findIndex(m => (order.get(m.rowKey) ?? 0) >= from)
      if (at < 0) at = 0
      setCurrent(at, ms[at])
    }
    if (pending.current !== null) {
      const dir = pending.current
      pending.current = null
      step(dir)
    }
  }, [result]) // eslint-disable-line react-hooks/exhaustive-deps

  const openBar = useCallback(() => {
    if (!open) {
      const ae = document.activeElement
      returnTo.current = ae && ae !== document.body && !ae.closest('.chat-find') ? ae : null
      setOpen(true)
    }
    setFocusAsk(n => n + 1)
  }, [open])

  const close = useCallback(() => {
    setOpen(false)
    setOutline(null)
    clearPaint()
    const back = returnTo.current
    returnTo.current = null
    requestAnimationFrame(() => {
      if (back && back.isConnected && typeof (back as HTMLElement).focus === 'function') (back as HTMLElement).focus({ preventScroll: true })
      else listFocus.current()
    })
  }, [])

  // the painting: after each search, each move, and whenever the rows on screen change (scrolling, a row opening)
  useEffect(() => {
    const el = root.current
    if (!open || !el) { clearPaint(); return }
    let frame = 0
    const run = () => {
      frame = 0
      const { now, painted } = paint(el, result, query, current)
      const cur = current !== null ? result.matches[current] : null
      const mounted = cur ? !!el.querySelector(`.chat-rows > .chat-row[data-key="${CSS.escape(cur.rowKey)}"]`) : false
      setOutline(cur && mounted && (!painted || !now) ? cur.rowKey : null)
      // after a move: the match itself into view inside a tall row
      if (reveal.current && now) {
        reveal.current = false
        const box = el.querySelector('.chat-scroll') as HTMLElement | null
        const r = now.getBoundingClientRect()
        const v = box?.getBoundingClientRect()
        if (box && v && (r.top < v.top + 24 || r.bottom > v.bottom - 24)) {
          box.scrollTo({ top: box.scrollTop + r.top - v.top - (v.height - r.height) / 2, behavior: reducedMotion() ? 'auto' : 'smooth' })
        }
      }
    }
    const schedule = () => { if (!frame) frame = requestAnimationFrame(run) }
    schedule()
    const mo = new MutationObserver(muts => { if (muts.some(m => !(m.target as Element).closest?.('.chat-find') && !(m.target.parentElement?.closest('.chat-find')))) schedule() })
    mo.observe(el, { childList: true, subtree: true, characterData: true })
    return () => { mo.disconnect(); if (frame) cancelAnimationFrame(frame) }
  }, [open, result, query, current, placed, root])
  useEffect(() => () => clearPaint(), [])

  const bar: FindBarProps | null = open ? {
    query, focusAsk, hasOlder: o.hasOlder, result, current,
    onQuery: setQuery,
    // (the focus came into the bar from there: Esc gives it back there, also to a bar kept open across a flip)
    onEnter: from => { if (from !== document.body) returnTo.current = from },
    onStep: (dir, typed) => {
      if (typed !== undefined && typed !== query) { pending.current = dir; setQuery(typed) } else step(dir)
    },
    onClose: close,
  } : null
  return { open, openBar, findNow: open ? outline : null, bar }
}

// ---------------------------------------------------------------- the bar

export interface FindBarProps {
  query: string
  /** Changes when Ctrl/⌘+F asks for the focus (the text selected) */
  focusAsk: number
  hasOlder: boolean
  result: FindResult
  current: number | null
  onQuery(q: string): void
  /** The focus came into the bar from `from` (outside it) */
  onEnter(from: Element): void
  /** Enter / Shift+Enter, the arrows; `typed`: the field's text, searched first if it is not yet */
  onStep(dir: 1 | -1, typed?: string): void
  onClose(): void
}

export const FindBar: React.FC<FindBarProps> = ({ query, focusAsk, hasOlder, result, current, onQuery, onEnter, onStep, onClose }) => {
  const input = useRef<HTMLInputElement>(null)
  const [draft, setDraft] = useState(query)
  const timer = useRef<ReturnType<typeof setTimeout>>()
  /** An IME composition is going on (its events, besides the input's own isComposing) */
  const composing = useRef(false)
  useEffect(() => () => clearTimeout(timer.current), [])
  // (only when Ctrl/⌘+F asked: a bar kept open across a flip or a switch back never takes the focus by itself)
  useEffect(() => {
    const el = input.current
    if (!el || focusAsk === 0) return
    el.focus({ preventScroll: true })
    el.select()
  }, [focusAsk])
  const later = (v: string) => {
    clearTimeout(timer.current)
    timer.current = setTimeout(() => onQuery(v), FIND_DEBOUNCE_MS)
  }
  const n = result.matches.length
  const count = !foldQuery(query) ? '' : !n ? t('결과 없음')
    : result.more ? `${(current ?? 0) + 1} · ${t('{n}개 넘음', { n: FIND_LIMIT })}`
    : `${(current ?? 0) + 1}/${n}`
  return (
    <div className="chat-find" role="search" aria-label={t('대화에서 찾기')}
      onFocus={e => { const from = e.relatedTarget; if (from instanceof Element && !e.currentTarget.contains(from)) onEnter(from) }}>
      <div className="chat-find-main">
        <input
          ref={input}
          value={draft}
          placeholder={t('찾을 말')}
          aria-label={t('찾을 말')}
          title={`${t('대화에서 찾기')} (${modCombo('F')})`}
          spellCheck={false}
          onChange={e => {
            const v = e.target.value
            setDraft(v)
            // (an IME's syllable is never searched half-made: its end searches)
            if (!composing.current && !(e.nativeEvent as InputEvent).isComposing) later(v)
            else clearTimeout(timer.current)
          }}
          onCompositionStart={() => { composing.current = true; clearTimeout(timer.current) }}
          onCompositionEnd={e => { composing.current = false; later(e.currentTarget.value) }}
          onBlur={() => { composing.current = false }}
          onKeyDown={e => {
            if (composing.current || e.nativeEvent.isComposing || e.keyCode === 229) return
            if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); clearTimeout(timer.current); onClose() }
            else if (e.key === 'Enter') { e.preventDefault(); clearTimeout(timer.current); onStep(e.shiftKey ? -1 : 1, draft) }
          }}
        />
        <span className="chat-find-count" aria-live="polite">{count}</span>
        <button type="button" onClick={() => onStep(-1, draft)} disabled={!n && !foldQuery(draft)} title={`${t('이전 결과')} (Shift+Enter)`} aria-label={t('이전 결과')}>↑</button>
        <button type="button" onClick={() => onStep(1, draft)} disabled={!n && !foldQuery(draft)} title={`${t('다음 결과')} (Enter)`} aria-label={t('다음 결과')}>↓</button>
        <button type="button" onClick={onClose} title={`${t('찾기 닫기')} (Esc)`} aria-label={t('찾기 닫기')}>×</button>
      </div>
      {hasOlder && <div className="chat-find-note">{t('불러온 대화에서만 찾아요')}</div>}
    </div>
  )
}

export default FindBar
