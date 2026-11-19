/**
 * The conversation's scroller: a virtual list, so a session of
 * thousands of rows mounts only the rows in view (and 600px around them). Each row is
 * measured by one ResizeObserver; an unmeasured row counts as an estimate.
 *
 *   - It sticks to the bottom by direction: any move up by the user (wheel, keys, touchpad,
 *     scrollbar) leaves the bottom at once; coming back down to within 160px of it sticks
 *     again. The view is only placed again when the content changed (rows, heights, size),
 *     never on a render the user's own scroll caused.
 *   - Scrolled up, the first row in view stays where it is, whatever loads above or grows
 *     (older pages, a row opened); a row the user opens or closes stays where it is. New rows
 *     below add to "새 메시지 N개"; a wait on the user (permission, question, plan) puts an
 *     amber "… 기다려요" in its place, jumping to the waiting row.
 *   - Near the top with older rows to fetch, it asks once (until the next update or answer).
 *   - Its scroll position is kept per terminal, so flipping back finds it where it was.
 *
 * The scroller is focusable (tabIndex -1); it takes the focus only when asked (the user's own
 * flip or session switch: `focus()` on the handle). Tab from it (or from outside) goes to the first
 * control in view, without moving the view; Tab then walks the rows' buttons and links, and at the
 * edge of what is mounted a sentinel scrolls on and hands the focus to the next control.
 */

import React, { forwardRef, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState } from 'react'
import { flushSync } from 'react-dom'
import { t } from '../../i18n'
import { unreadAfter, type Row } from '../../chat/rows'
import { onChatForget } from '../../chat/lensMode'
import { pruneToRows, visibleRange } from '../../chat/virtual'
import { DownIcon } from './ChatIcons'

/** Older rows are asked for this close to the top */
const OLDER_AT = 400
/** Coming back down to within this of the bottom sticks again */
const STICK_SLACK = 160

/** Where each terminal's conversation was scrolled (kept while the page lives; let go when the session goes) */
const memory = new Map<string, { top: number; bottom: boolean; anchor: { key: string; delta: number } | null }>()
onChatForget(id => { for (const k of [...memory.keys()]) if (k === id || k.startsWith(`${id}@`)) memory.delete(k) })

/**
 * The scroll memory's key for a terminal: its id and its launch (a tab launched again under the same id
 * is another session, whose conversation starts at its bottom, not where the last one was left)
 */
export function scrollKey(term: { id: string; createdAt?: number | null }): string {
  return `${term.id}@${typeof term.createdAt === 'number' ? term.createdAt : ''}`
}

const reducedMotion = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches

const TOOLISH = new Set<Row['row']>(['tool', 'group'])

/**
 * A row's ref callback (kept per key): it registers the row's element with the size observer. Made here, outside the
 * render, so it holds only what it names: made inside the render it held that render's whole scope (its rows, its
 * callbacks), and with a callback kept for every key ever drawn a long streaming session kept every rows array alive
 * (about 1 MB a turn in a soak test).
 */
function rowRef(key: string, elements: React.MutableRefObject<Map<string, HTMLElement>>, observer: React.MutableRefObject<ResizeObserver | null>) {
  return (el: HTMLElement | null) => {
    const old = elements.current.get(key)
    if (old && old !== el) { observer.current?.unobserve(old); elements.current.delete(key) }
    if (el) { elements.current.set(key, el); observer.current?.observe(el) }
  }
}
const FOCUSABLE = 'button:not([disabled]), a[href], [tabindex="0"]'

/** Typing or composing somewhere: the conversation never takes the focus from it */
export function isTypingTarget(el: Element | null): boolean {
  if (!el || el === document.body) return false
  // a terminal in view (a hidden one, put away by a switch, has let its focus go already)
  const term = el.closest('.term-view') as HTMLElement | null
  if (term) return term.getClientRects().length > 0
  const tag = el.tagName
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true
  return (el as HTMLElement).isContentEditable === true || !!el.closest('[contenteditable=""], [contenteditable="true"]')
}

export interface ChatListHandle {
  /** Take the focus (the user's own flip or switch), unless something is being typed into */
  focus(): void
  /**
   * Bring a row into view: near the top (the waiting pill), or with `align: 'center'` in the middle of the view (find),
   * placed again on the row's real height once it is drawn; resolves when it is placed (true) or cannot be (false).
   * Smooth for a short way, at once for a long one and under reduced motion.
   */
  scrollToKey(key: string, opts?: { align?: 'center' }): Promise<boolean>
}

export interface ChatListProps {
  /** The scroll memory's key: the terminal and its launch (scrollKey) */
  id: string
  rows: Row[]
  /** Changes with every update (the "once until the next update" of the older request) */
  rev: number
  hasOlder: boolean
  /** Older rows exist but the page holds all it may (ITEM_CAP): the top says to see them in the terminal */
  olderCut?: boolean
  /** Ask for older rows; the answer clears the loading line */
  onOlder(): Promise<unknown> | void
  renderRow(row: Row): React.ReactNode
  /** Under the rows, inside the scroll (the working line) */
  tail?: React.ReactNode
  /** The conversation is dimmed (the read-failed banner is up) */
  dim?: boolean
  /** A wait on the user: the pill's words and the row to jump to (null: the bottom) */
  waiting?: { text: string; key: string | null } | null
  /** A row's height before it is measured (the density's: src/chat/density.ts ESTIMATE) */
  estimate: number
  /** Runs of tool rows sit tight (the density's: src/chat/density.ts TIGHT) */
  tight: boolean
  /** The row of find's current match, outlined (only where the match itself cannot be painted) */
  findNow?: string | null
}

export const ChatList = forwardRef<ChatListHandle, ChatListProps>(function ChatList({ id, rows, rev, hasOlder, olderCut, onOlder, renderRow, tail, dim, waiting, estimate, tight, findNow = null }, handle) {
  const scroller = useRef<HTMLDivElement>(null)
  const list = useRef<HTMLDivElement>(null)
  const heights = useRef(new Map<string, number>())
  const [measured, setMeasured] = useState(0)
  const saved = memory.get(id)
  const [view, setView] = useState({ top: saved?.top ?? 0, height: 800 })
  const stick = useRef(saved ? saved.bottom : true)
  const lastTop = useRef(saved?.top ?? 0)
  const anchor = useRef<{ key: string; delta: number } | null>(saved?.anchor ?? null)
  const olderAsked = useRef(false)
  const [loadingOlder, setLoadingOlder] = useState(false)
  const [unread, setUnread] = useState(0)
  const [atEnd, setAtEnd] = useState(stick.current)
  const [announce, setAnnounce] = useState('')
  const prevRows = useRef<Row[]>(rows)
  const first = useRef(true)
  /** What the last placement was for: the rows, the measurements, the view's size (a change = place again) */
  const placed = useRef<{ rows: Row[] | null; measured: number; height: number; width: number }>({ rows: null, measured: -1, height: -1, width: -1 })
  /** The control in focus inside a row when the user last scrolled (if its row unmounts, the focus comes here) */
  const blurred = useRef<Element | null>(null)

  // ---- measuring: one observer for every rendered row
  const observer = useRef<ResizeObserver | null>(null)
  const elements = useRef(new Map<string, HTMLElement>())
  const refs = useRef(new Map<string, (el: HTMLElement | null) => void>())
  useEffect(() => {
    observer.current = new ResizeObserver(entries => {
      let changed = false
      for (const e of entries) {
        const el = e.target as HTMLElement
        const key = el.dataset.key
        if (!key || !el.isConnected) continue
        const h = Math.round((e.borderBoxSize?.[0]?.blockSize ?? el.getBoundingClientRect().height) * 10) / 10
        if (h > 0 && heights.current.get(key) !== h) { heights.current.set(key, h); changed = true }
      }
      if (changed) setMeasured(n => n + 1)
    })
    for (const el of elements.current.values()) observer.current.observe(el)
    return () => { observer.current?.disconnect(); observer.current = null }
  }, [])
  const refFor = (key: string) => {
    let fn = refs.current.get(key)
    if (!fn) {
      fn = rowRef(key, elements, observer)
      refs.current.set(key, fn)
    }
    return fn
  }
  // (a key no longer among the rows and not mounted: its callback and its measured height go, so both maps stay the
  // size of the rows; the layout pass above has already used the old rows' heights to hold the view across the change)
  useEffect(() => {
    pruneToRows(refs.current, rows, elements.current)
    pruneToRows(heights.current, rows, elements.current)
  }, [rows])

  // ---- the range in view
  const hs = rows.map(r => heights.current.get(r.key))
  const listTop = list.current?.offsetTop ?? 0
  const range = visibleRange({ heights: hs, estimate, scrollTop: view.top - listTop, viewport: view.height })
  /** A row's top in the scroll's content, on the heights known now */
  const yOf = (index: number) => {
    let y = list.current?.offsetTop ?? 0
    for (let k = 0; k < index; k++) y += heights.current.get(rows[k].key) ?? estimate
    return y
  }

  /** The first row in view and how far its top is above the view's top */
  const takeAnchor = useCallback((top: number) => {
    let y = list.current?.offsetTop ?? 0
    for (let i = 0; i < rows.length; i++) {
      const h = heights.current.get(rows[i].key) ?? estimate
      if (y + h > top) { anchor.current = { key: rows[i].key, delta: y - top }; return }
      y += h
    }
    anchor.current = null
  }, [rows, estimate])

  const askOlder = (top: number) => {
    if (hasOlder && top < OLDER_AT && !olderAsked.current) {
      olderAsked.current = true
      setLoadingOlder(true)
      Promise.resolve(onOlder()).catch(() => {}).finally(() => setLoadingOlder(false))
    }
  }

  const setStick = (on: boolean) => {
    stick.current = on
    setAtEnd(on)
    if (on) setUnread(0)
  }

  const onScroll = () => {
    const el = scroller.current
    if (!el) return
    const top = el.scrollTop
    const gap = el.scrollHeight - top - el.clientHeight
    // the control in focus, if it is in a row: should its row leave the mounted range, the focus stays here
    const ae = document.activeElement
    blurred.current = ae && ae !== el && el.contains(ae) ? ae : null
    // by direction: up leaves the bottom (unless still on it); down into the slack sticks again
    if (top < lastTop.current - 0.5) { if (stick.current !== gap <= 2) setStick(gap <= 2) }
    else if (gap <= STICK_SLACK && !stick.current) setStick(true)
    lastTop.current = top
    takeAnchor(top)
    memory.set(id, { top, bottom: stick.current, anchor: anchor.current })
    setView(v => (v.top === top && v.height === el.clientHeight ? v : { top, height: el.clientHeight }))
    askOlder(top)
  }

  /** A row the user opens or closes stays where it is (not the bottom, not the old anchor) */
  const onToggleCapture = (e: React.MouseEvent) => {
    const target = e.target as Element
    if (!target.closest?.('[aria-expanded]')) return
    const row = target.closest('.chat-row') as HTMLElement | null
    const el = scroller.current
    if (!row || !el || !row.dataset.key) return
    const i = rows.findIndex(r => r.key === row.dataset.key)
    if (i < 0) return
    anchor.current = { key: row.dataset.key, delta: yOf(i) - el.scrollTop }
    if (stick.current) setStick(false)
  }

  // ---- after every render: place the view again only when the content changed
  // (the rows just rendered are measured here first, so the view is placed on real heights; a chain
  // of corrections is cut after a few passes and finished on the next frame)
  const passes = useRef(0)
  useLayoutEffect(() => {
    const el = scroller.current
    if (!el) return
    let changed = false
    for (const [key, node] of elements.current) {
      if (!node.isConnected) continue
      const h = Math.round(node.getBoundingClientRect().height * 10) / 10
      if (h > 0 && heights.current.get(key) !== h) { heights.current.set(key, h); changed = true }
    }
    if (first.current) {
      first.current = false
      if (!stick.current && saved && !anchor.current) el.scrollTop = saved.top
    }
    const p = placed.current
    const contentChanged = changed || p.rows !== rows || p.measured !== measured || p.height !== el.clientHeight || p.width !== el.clientWidth
    placed.current = { rows, measured, height: el.clientHeight, width: el.clientWidth }
    if (contentChanged) {
      if (stick.current) {
        if (Math.abs(el.scrollHeight - el.clientHeight - el.scrollTop) > 1) el.scrollTop = el.scrollHeight
      } else if (anchor.current) {
        let i = rows.findIndex(r => r.key === anchor.current!.key)
        // the row the view held went (a density change took a thinking row, or the turn head keyed by it): the
        // next row that stayed holds the view, where it was on screen (the heights map is kept across the change)
        if (i < 0 && p.rows) {
          const before = p.rows
          let j = before.findIndex(r => r.key === anchor.current!.key)
          if (j >= 0) {
            const keys = new Map(rows.map((r, k) => [r.key, k]))
            let delta = anchor.current.delta
            for (; j < before.length; j++) {
              const k = keys.get(before[j].key)
              if (k !== undefined) { anchor.current = { key: before[j].key, delta }; i = k; break }
              delta += heights.current.get(before[j].key) ?? estimate
            }
          }
        }
        if (i >= 0) {
          const want = yOf(i) - anchor.current.delta
          if (Math.abs(el.scrollTop - want) > 1) el.scrollTop = want
        }
      }
      lastTop.current = el.scrollTop
    }
    // a focused control went with its row: the focus stays in the conversation (the keys keep scrolling)
    const gone = blurred.current
    if (gone && !gone.isConnected) {
      blurred.current = null
      if (!document.activeElement || document.activeElement === document.body) el.focus({ preventScroll: true })
    }
    const moved = el.clientHeight !== view.height || Math.abs(el.scrollTop - view.top) > 1
    if (!changed && !moved) { passes.current = 0; return }
    if (passes.current < 6) {
      passes.current++
      if (moved) setView({ top: el.scrollTop, height: el.clientHeight })
      else setMeasured(n => n + 1)
    } else {
      const frame = requestAnimationFrame(() => { passes.current = 0; setView({ top: el.scrollTop, height: el.clientHeight }); setMeasured(n => n + 1) })
      return () => cancelAnimationFrame(frame)
    }
  })

  /** The first control in a mounted row past row `from` (by posinset), in the direction of Tab */
  function nextFocusable(dir: 1 | -1, from: number): HTMLElement | null {
    const box = list.current
    if (!box) return null
    const items = [...box.querySelectorAll<HTMLElement>('.chat-row')].filter(r => (dir > 0 ? Number(r.getAttribute('aria-posinset')) > from : Number(r.getAttribute('aria-posinset')) < from))
    if (dir < 0) items.reverse()
    for (const r of items) {
      const all = [...r.querySelectorAll<HTMLElement>(FOCUSABLE)]
      const f = dir > 0 ? all[0] : all[all.length - 1]
      if (f) return f
    }
    return null
  }
  /** The first (dir 1) or last (dir -1) control of the mounted rows that is in view now (whole, else in part) */
  function controlInView(dir: 1 | -1): HTMLElement | null {
    const box = list.current
    const el = scroller.current
    if (!box || !el) return null
    const view = el.getBoundingClientRect()
    const all = [...box.querySelectorAll<HTMLElement>(`.chat-row ${FOCUSABLE}`)].filter(c => c.getClientRects().length > 0)
    if (dir < 0) all.reverse()
    const rect = (c: HTMLElement) => c.getBoundingClientRect()
    return all.find(c => { const r = rect(c); return r.top >= view.top - 1 && r.bottom <= view.bottom + 1 })
      ?? all.find(c => { const r = rect(c); return r.bottom > view.top && r.top < view.bottom })
      ?? null
  }

  /**
   * The next control outside the conversation's rows, in the direction of Tab (nothing in view to
   * take the focus: it moves on past the rows rather than scroll the view)
   */
  function pastRows(dir: 1 | -1): HTMLElement | null {
    const box = list.current
    if (!box) return null
    const all = [...document.querySelectorAll<HTMLElement>('button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]')]
      .filter(c => c.tabIndex >= 0 && !box.contains(c) && c.getClientRects().length > 0)
    const after = (c: HTMLElement) => !!(box.compareDocumentPosition(c) & Node.DOCUMENT_POSITION_FOLLOWING)
    return dir > 0 ? all.find(after) ?? null : [...all].reverse().find(c => !after(c)) ?? null
  }

  /**
   * Tab reached a sentinel at the edge of the mounted rows. Coming from a control in the rows next
   * to it (the user is walking the conversation): scroll on, draw the rows there at once
   * (flushSync), and hand the focus to the next control, all before the next key — so Tab walks
   * the whole conversation and the focus never falls to the page. Coming from anywhere else (the
   * scroller after a flip, the working line, outside): the first (or, going back, the last)
   * control in the rows now in view, with no scroll at all — the view, and its place at the
   * bottom, stay as they were.
   */
  const onSentinel = (dir: 1 | -1) => (e: React.FocusEvent<HTMLElement>) => {
    const el = scroller.current
    if (!el) return
    const came = e.relatedTarget instanceof HTMLElement ? e.relatedTarget : null
    const fromRow = came?.closest('.chat-row')
    // the top sentinel is reached going back from the rows below it, the bottom one going on from the rows above it
    const adjacent = !!fromRow && !!list.current?.contains(fromRow)
      && !!(e.currentTarget.compareDocumentPosition(fromRow) & (dir < 0 ? Node.DOCUMENT_POSITION_FOLLOWING : Node.DOCUMENT_POSITION_PRECEDING))
    if (!adjacent) {
      // which way the user is going: on (Tab, from before the sentinel: the scroller, the header) or back
      const on = !came || !!(came.compareDocumentPosition(e.currentTarget) & Node.DOCUMENT_POSITION_FOLLOWING)
      const next = controlInView(on ? 1 : -1) ?? pastRows(on ? 1 : -1)
      if (next) next.focus({ preventScroll: true })
      else el.focus({ preventScroll: true })
      return
    }
    const from = dir > 0 ? range.end : range.start + 1
    for (let k = 0; k < 12; k++) {
      const before = el.scrollTop
      el.scrollTop += dir * Math.max(200, el.clientHeight * 0.8)
      flushSync(() => setView({ top: el.scrollTop, height: el.clientHeight }))
      const next = nextFocusable(dir, from)
      if (next) { next.focus(); return }
      if (el.scrollTop === before) break // the end: nothing further to reach
    }
    el.focus({ preventScroll: true })
  }

  // ---- a new update: new rows below while scrolled up are unread; at the bottom a new answer is announced
  useEffect(() => {
    olderAsked.current = false
    setLoadingOlder(false)
  }, [rev])
  useEffect(() => {
    const prev = prevRows.current
    prevRows.current = rows
    if (prev === rows) return
    const n = unreadAfter(prev, rows)
    if (stick.current) {
      setUnread(0)
      const had = new Set(prev.map(r => r.key))
      if (prev.length && rows.some(r => r.row === 'text' && !had.has(r.key))) setAnnounce(a => (a.endsWith('​') ? t('새 답이 왔어요') : `${t('새 답이 왔어요')}​`))
    } else if (n) setUnread(u => u + n)
  }, [rows])

  // ---- the view's size follows the window; a new width or text step measures the rows again
  useEffect(() => {
    const el = scroller.current
    if (!el) return
    let width = el.clientWidth
    const forget = () => { heights.current.clear(); setMeasured(n => n + 1) }
    const ro = new ResizeObserver(() => {
      if (el.clientWidth !== width) { width = el.clientWidth; forget() }
      // at the bottom, the view stays there when it gets shorter (the composer's draft growing a line)
      if (stick.current && Math.abs(el.scrollHeight - el.clientHeight - el.scrollTop) > 1) { el.scrollTop = el.scrollHeight; lastTop.current = el.scrollTop }
      setView(v => (v.height === el.clientHeight ? v : { top: el.scrollTop, height: el.clientHeight }))
    })
    ro.observe(el)
    const mo = new MutationObserver(forget)
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] })
    return () => { ro.disconnect(); mo.disconnect() }
  }, [])

  const toBottom = () => {
    const el = scroller.current
    if (!el) return
    setStick(true)
    el.scrollTo({ top: el.scrollHeight, behavior: reducedMotion() ? 'auto' : 'smooth' })
  }

  // (the rows and the estimate of the latest render, for a placement that goes on over several frames)
  const latest = useRef({ rows, estimate })
  latest.current = { rows, estimate }

  const scrollToKey = (key: string, opts?: { align?: 'center' }): Promise<boolean> => {
    const el = scroller.current
    if (!el) return Promise.resolve(false)
    const i = rows.findIndex(r => r.key === key)
    if (!opts?.align) {
      if (i < 0) { toBottom(); return Promise.resolve(false) }
      const top = Math.max(0, yOf(i) - 48)
      anchor.current = { key, delta: yOf(i) - top }
      setStick(false)
      el.scrollTo({ top, behavior: reducedMotion() ? 'auto' : 'smooth' })
      return Promise.resolve(true)
    }
    if (i < 0) return Promise.resolve(false)
    // centred on the heights known now (an unmeasured row counts as the estimate) …
    const centre = (): number | null => {
      const { rows: now, estimate: est } = latest.current
      const k = now.findIndex(r => r.key === key)
      if (k < 0) return null
      let y = list.current?.offsetTop ?? 0
      for (let j = 0; j < k; j++) y += heights.current.get(now[j].key) ?? est
      const h = heights.current.get(key) ?? est
      return Math.max(0, y - Math.max(0, (el.clientHeight - h) / 2))
    }
    const top = centre() ?? 0
    const far = Math.abs(top - el.scrollTop) > el.clientHeight * 2
    anchor.current = { key, delta: yOf(i) - top }
    setStick(false)
    el.scrollTo({ top, behavior: far || reducedMotion() ? 'auto' : 'smooth' })
    // … then, once the scroll has come to rest and the row is drawn, on its real place (rows above it measured on the way)
    return new Promise<boolean>(resolve => {
      let frames = 0
      let still = 0
      let last = el.scrollTop
      const tick = () => {
        if (!el.isConnected) { resolve(false); return }
        frames++
        still = Math.abs(el.scrollTop - last) > 0.5 ? 0 : still + 1
        last = el.scrollTop
        if (still >= 2) {
          const node = elements.current.get(key)
          if (node?.isConnected) {
            const r = node.getBoundingClientRect()
            const v = el.getBoundingClientRect()
            const off = r.top - v.top - Math.max(0, (v.height - r.height) / 2)
            if (Math.abs(off) <= 2) { resolve(true); return }
            const before = el.scrollTop
            el.scrollTop = before + off
            // (at an end of the scroll: as near as it goes)
            if (Math.abs(el.scrollTop - before) < 0.5) { resolve(true); return }
          } else {
            const again = centre()
            if (again === null) { resolve(false); return }
            el.scrollTop = again
          }
          still = 0
          last = el.scrollTop
        }
        if (frames > 120) { resolve(!!elements.current.get(key)?.isConnected); return }
        requestAnimationFrame(tick)
      }
      requestAnimationFrame(tick)
    })
  }

  useImperativeHandle(handle, () => ({
    focus() {
      const el = scroller.current
      if (el && !isTypingTarget(document.activeElement)) el.focus({ preventScroll: true })
    },
    scrollToKey,
  }))

  const shown = rows.slice(range.start, range.end)
  return (
    <div className="chat-list">
      <div ref={scroller} className={`chat-scroll${dim ? ' dim' : ''}`} tabIndex={-1} onScroll={onScroll} role="region" aria-label={t('대화')}>
        <div className="chat-col">
          {hasOlder && <div className="chat-older" aria-live="polite">{loadingOlder ? t('이전 대화 불러오는 중…') : ''}</div>}
          {olderCut && <div className="chat-older">{t('더 이전 대화는 터미널에서 보세요')}</div>}
          <div ref={list} className="chat-rows" role="list" onClickCapture={onToggleCapture}>
            <div style={{ height: range.padTop }} aria-hidden="true" />
            {range.start > 0 && <div className="chat-sentinel chat-sr" tabIndex={0} onFocus={onSentinel(-1)}>{t('위 내용 더 보기')}</div>}
            {shown.map((row, j) => {
              const i = range.start + j
              const close = tight && TOOLISH.has(row.row) && !!rows[i + 1] && TOOLISH.has(rows[i + 1].row)
              return (
                <div key={row.key} ref={refFor(row.key)} data-key={row.key} className={`chat-row k-${row.row}${close ? ' tight' : ''}${findNow === row.key ? ' find-now' : ''}`}
                  role="listitem" aria-setsize={rows.length} aria-posinset={i + 1}>
                  {renderRow(row)}
                </div>
              )
            })}
            {range.end < rows.length && <div className="chat-sentinel chat-sr" tabIndex={0} onFocus={onSentinel(1)}>{t('아래 내용 더 보기')}</div>}
            <div style={{ height: range.padBottom }} aria-hidden="true" />
          </div>
          {tail}
        </div>
      </div>
      <div className="chat-sr" aria-live="polite">{announce}</div>
      <div className="chat-jump-live" aria-live="polite">
        {!atEnd && waiting ? (
          <button type="button" className="chat-jump wait" onClick={() => (waiting.key ? scrollToKey(waiting.key) : toBottom())}>
            <i className="chat-dot amber" aria-hidden="true" />{waiting.text}
          </button>
        ) : !atEnd && unread > 0 && (
          <button type="button" className="chat-jump" onClick={toBottom}>
            <DownIcon />{t('새 메시지 {n}개', { n: unread })}
          </button>
        )}
      </div>
    </div>
  )
})

export default ChatList
