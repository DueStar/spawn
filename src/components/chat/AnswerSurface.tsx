/**
 * The answer surface (Phase 4): what the session waits on the user for, outside the virtual list,
 * between the conversation and the composer, in the reading column (the lab's `.card.ask`,
 * calm-lab app.css 296–309). It shows one card — the oldest that can be answered here, else the
 * oldest (src/chat/answer.ts shownCard) — and "{n}건 더 기다려요" when there are more.
 *
 * Never by itself: no button is focused, the focus is never moved here (a card appearing while the
 * user types in the composer leaves the focus and the composition where they are), and an answer is
 * a click on a button — pressed once the card had been painted a moment with the window in front
 * (src/chat/answer.ts clickAccepted: the time starts after paint and again whenever the window comes
 * back) — or Enter / Space on the focused button. The arrows move between a card's buttons while the
 * focus is in it; nothing else in the page hears a key for a card. A new card is announced once,
 * through the chat's one live region (ChatView's `announce`), without moving the focus.
 *
 * A card says only what main sent and what Claude Code did (its `state`: sent, timeout, terminal),
 * never what the click did; a refused answer says so and points to the terminal. The page sends a
 * choice only (chat:answer): main checks it and builds what goes to Claude Code.
 */

import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { josa, t } from '../../i18n'
import { cardKey } from '../../chat/composerKeys'
import { clickAccepted, lastWake, noteWake, shownCard, visibleText } from '../../chat/answer'
import type { ChatWho } from '../../chat/lensMode'
import type { AnswerChoice, AnswerRefusal, AskCard } from '../../chat/types'
import { PermissionCard, permissionTitle } from './PermissionCard'
import { QuestionCard } from './QuestionCard'
import { PlanCard } from './PlanCard'

export type AnswerFn = (p: { id: string; holdId: string; choice: AnswerChoice; option?: number; picks?: number[][]; other?: (string | null)[] }) => Promise<{ ok: true } | { ok: false; reason: AnswerRefusal }>

export const nameVars = (name: string) => ({ name, iga: josa(name, '이가') })

/**
 * What a card is waiting on locally: a choice sent and not yet told back, an answer main refused
 * (for good), or one refused only because the chat was not seen as shown that moment (`retry`: the
 * buttons stay, review I3)
 */
export interface CardLocal { busy: AnswerChoice | null; refused: boolean; retry?: boolean }

export interface CardProps {
  card: AskCard
  who: ChatWho
  local: CardLocal
  /** when this card was painted (Infinity until it is: a press before that is no answer) */
  shownAt(): number
  /**
   * option: one question's choice; picks: each question's chosen options (several questions, a multi-select);
   * other: each question's own words (its 직접 입력, Claude Code's "Other" row), null where none
   */
  onAnswer(choice: AnswerChoice, option?: number, picks?: number[][], other?: (string | null)[]): void
  onTerminal(): void
}

/**
 * Text from the request exactly: hidden characters as visible marks, a URL's non-ASCII host with its
 * ASCII form, in logical order (`.chat-exact`: no bidi reordering), never markdown. `ws`: tabs and
 * trailing spaces marked too (a diff line).
 */
export const Exact: React.FC<{ text: string; ws?: boolean }> = ({ text, ws = false }) => (
  <span className="chat-exact">{visibleText(text, { ws }).map((p, i) => (p.mark ? <span key={i} className="chat-cc">{p.text}</span> : p.ws ? <span key={i} className="chat-ws" aria-hidden="true">{p.text}</span> : <React.Fragment key={i}>{p.text}</React.Fragment>))}</span>
)

/**
 * A translated line with one value of the request in it, that value exact (a tool's name in a title,
 * a rule): the words around it from the dictionary, the value through Exact
 */
export const WithExact: React.FC<{ k: string; name: string; value: string; vars?: Record<string, string | number> }> = ({ k, name, value, vars = {} }) => {
  const MARK = '\u0001'
  const [before, after = ''] = t(k, { ...vars, [name]: MARK }).split(MARK)
  return <>{before}<Exact text={value} />{after}</>
}

/** A button that answers: a pointer press counts only once the card had been painted a moment (and the window in front); a key on it always */
export const AnswerButton: React.FC<{ shownAt(): number; disabled: boolean; className: string; title?: string; label?: string; describedBy?: string; onAnswer(): void; children: React.ReactNode }> = ({ shownAt, disabled, className, title, label, describedBy, onAnswer, children }) => {
  const downAt = useRef<number | null>(null)
  return (
    <button
      type="button" className={className} disabled={disabled} title={title} aria-label={label} aria-describedby={describedBy}
      onPointerDown={() => { downAt.current = performance.now() }}
      onClick={(e) => {
        const ok = clickAccepted({ detail: e.detail, downAt: downAt.current, shownAt: shownAt(), wokeAt: lastWake() })
        downAt.current = null
        if (ok) onAnswer()
      }}
    >{children}</button>
  )
}

/** A card's frame: the amber edge, its head (dot, title, kind), its body; the arrows move between its buttons */
export const CardShell: React.FC<{ title: React.ReactNode; label: string; kind: React.ReactNode; className?: string; children: React.ReactNode }> = ({ title, label, kind, className = '', children }) => (
  <div
    className={`chat-card ask${className ? ` ${className}` : ''}`} role="group" aria-label={label} tabIndex={0}
    onKeyDown={(e) => {
      // only while the focus is on one of this card's buttons (a scrolled box keeps its own arrows)
      const target = e.target as HTMLElement
      if (target.tagName !== 'BUTTON') return
      const move = cardKey({ key: e.key, shiftKey: e.shiftKey, ctrlKey: e.ctrlKey, metaKey: e.metaKey, altKey: e.altKey, isComposing: e.nativeEvent.isComposing, keyCode: e.keyCode }, false)
      if (!move) return
      e.preventDefault()
      const buttons = [...e.currentTarget.querySelectorAll<HTMLButtonElement>('button:not([disabled])')]
      const at = buttons.indexOf(target as HTMLButtonElement)
      if (at < 0 || !buttons.length) return
      buttons[(at + (move === 'next' ? 1 : -1) + buttons.length) % buttons.length].focus()
    }}
  >
    <div className="chat-card-head">
      <i className="chat-dot amber" aria-hidden="true" />
      <span className="chat-card-title">{title}</span>
      <span className="chat-card-kind">{kind}</span>
    </div>
    {children}
  </div>
)

/**
 * A box of its own scroll on a card, and whether it has been seen to its end (review I1): a box that
 * fits is seen at once; one that scrolls is seen once scrolled to its end. Measured again whenever the
 * box or its text changes size (a narrower window, a bigger text size).
 */
export function useSeenToEnd(ref: React.RefObject<HTMLElement>, onSeen: (seen: boolean) => void): { more: boolean; unseen: boolean } {
  const [st, setSt] = useState({ more: false, seen: false })
  const seen = useRef(false)
  const told = useRef<boolean | null>(null)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const check = () => {
      const over = el.scrollHeight > el.clientHeight + 1
      if (!over || el.scrollTop + el.clientHeight >= el.scrollHeight - 1) seen.current = true
      setSt(s => (s.more === over && s.seen === seen.current ? s : { more: over, seen: seen.current }))
      if (told.current !== seen.current) { told.current = seen.current; onSeen(seen.current) }
    }
    check()
    // (the box, and what is in it: a box at its max height grows no more, its text still does)
    const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(check) : null
    if (ro) { ro.observe(el); if (el.firstElementChild) ro.observe(el.firstElementChild) }
    el.addEventListener('scroll', check, { passive: true })
    return () => { ro?.disconnect(); el.removeEventListener('scroll', check) }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps
  return { more: st.more, unseen: st.more && !st.seen }
}

const SENT: Record<AnswerChoice, string> = {
  allow: '허용을 보냈어요 · 확인 중',
  always: '항상 허용을 보냈어요 · 확인 중',
  deny: '거부를 보냈어요 · 확인 중',
  option: '답을 보냈어요 · 확인 중',
  options: '답을 보냈어요 · 확인 중',
}

const CUT: Record<NonNullable<AskCard['cutWhy']>, string> = {
  long: '너무 길어서 여기서는 다 보여 줄 수 없어요 · 터미널에서 답해 주세요',
  fields: '여기서 다 보여 줄 수 없는 항목이 있어요 · 터미널에서 답해 주세요',
  unsure: '이미 있는 파일인지 확인하지 못했어요 · 터미널에서 답해 주세요',
}

/**
 * Where a card stands when it cannot be answered here (any more): what main said, and the terminal.
 * Null while it can be answered (the card draws its buttons).
 */
export function cardState(card: AskCard, local: CardLocal): { text: string; terminal: boolean } | null {
  if (card.state === 'sent') return { text: card.sent ? SENT[card.sent] : SENT.option, terminal: false }
  if (card.state === 'timeout') return { text: '답할 시간이 지나 터미널로 넘겼어요', terminal: true }
  if (local.refused) return { text: '보내지 못했어요 · 터미널에서 답해 주세요', terminal: true }
  if (card.cut) return { text: CUT[card.cutWhy ?? 'long'], terminal: true }
  if (card.state !== 'open' || !card.holdId) return { text: '터미널에서 답해 주세요', terminal: true }
  return null
}

/** The line in place of the buttons, the same height (nothing jumps) */
export const StateLine: React.FC<{ state: { text: string; terminal: boolean }; onTerminal(): void; solid?: boolean }> = ({ state, onTerminal, solid = false }) => (
  <div className="chat-card-acts">
    <span className="chat-card-state">{t(state.text)}</span>
    {state.terminal && <button type="button" className={`chat-btn${solid ? ' solid' : ''} chat-card-btn`} onClick={onTerminal}>{t('터미널에서 답하기')}</button>}
  </div>
)

/** The words a new card is announced with (once) */
function announcement(card: AskCard, who: ChatWho): string {
  const vars = nameVars(who.name)
  if (card.kind === 'permission') return t('{name}{iga} 허락을 기다려요: {what}', { ...vars, what: t(permissionTitle(card), { tool: card.tool }) })
  if (card.kind === 'question') return t('{name}{iga} 답을 기다려요: {what}', { ...vars, what: card.question?.text ?? '' })
  return t('{name}{iga} 답을 기다려요: {what}', { ...vars, what: t('계획을 확인해 주세요') })
}

const NO_LOCAL: CardLocal = { busy: null, refused: false }

export const AnswerSurface: React.FC<{ id: string; asks: AskCard[]; who: ChatWho; answer: AnswerFn; onTerminal(): void; announce?(text: string): void }> = ({ id, asks, who, answer, onTerminal, announce }) => {
  const card = shownCard(asks)
  const more = asks.length - 1
  // when each card was painted (by key), and what each is waiting on locally
  const shown = useRef(new Map<string, number>())
  const [local, setLocal] = useState<Record<string, CardLocal>>({})
  const keys = asks.map(a => a.key).join('\n')
  useEffect(() => {
    const live = new Set(keys ? keys.split('\n') : [])
    for (const k of [...shown.current.keys()]) if (!live.has(k)) shown.current.delete(k)
    setLocal(cur => {
      const next: Record<string, CardLocal> = {}
      let changed = false
      for (const [k, v] of Object.entries(cur)) { if (live.has(k)) next[k] = v; else changed = true }
      return changed ? next : cur
    })
  }, [keys])
  // the card's time starts once it is on the screen: after the layout, two frames later (review I2)
  const cardKeyNow = card?.key ?? null
  useLayoutEffect(() => {
    if (!cardKeyNow || shown.current.has(cardKeyNow)) return
    shown.current.set(cardKeyNow, Infinity)
    let b = 0
    const a = requestAnimationFrame(() => { b = requestAnimationFrame(() => { if (shown.current.get(cardKeyNow) === Infinity) shown.current.set(cardKeyNow, performance.now()) }) })
    return () => { cancelAnimationFrame(a); cancelAnimationFrame(b); if (shown.current.get(cardKeyNow) === Infinity) shown.current.delete(cardKeyNow) }
  }, [cardKeyNow])
  // the window coming back (focus, or the page visible again) arms every card again from then
  useEffect(() => {
    const wake = () => noteWake(performance.now())
    const seen = () => { if (document.visibilityState === 'visible') wake() }
    window.addEventListener('focus', wake)
    document.addEventListener('visibilitychange', seen)
    return () => { window.removeEventListener('focus', wake); document.removeEventListener('visibilitychange', seen) }
  }, [])

  // new cards, announced once each (several at once: one announcement), the focus left where it is
  const announced = useRef(new Set<string>())
  useEffect(() => {
    const said: string[] = []
    for (const a of asks) {
      if (announced.current.has(a.key)) continue
      announced.current.add(a.key)
      said.push(announcement(a, who))
    }
    if (said.length) announce?.(said.join(' · '))
  }, [keys]) // eslint-disable-line react-hooks/exhaustive-deps

  const mine = card ? local[card.key] ?? NO_LOCAL : NO_LOCAL
  const onAnswer = useMemo(() => (choice: AnswerChoice, option?: number, picks?: number[][], other?: (string | null)[]) => {
    if (!card || !card.holdId || card.state !== 'open' || mine.busy || mine.refused) return
    const key = card.key
    setLocal(cur => ({ ...cur, [key]: { busy: choice, refused: false } }))
    answer({ id, holdId: card.holdId, choice, ...(option !== undefined ? { option } : {}), ...(picks ? { picks } : {}), ...(other && other.some(w => w !== null) ? { other } : {}) }).then(
      // (refused only because this chat was not seen as shown that moment: the buttons stay, it may be pressed again)
      (r) => { if (!r.ok) setLocal(cur => ({ ...cur, [key]: r.reason === 'hidden' ? { busy: null, refused: false, retry: true } : { busy: null, refused: true } })) },
      () => setLocal(cur => ({ ...cur, [key]: { busy: null, refused: true } })),
    )
  }, [card, mine.busy, mine.refused, answer, id])

  if (!card) return null
  const shownAt = () => shown.current.get(card.key) ?? Infinity
  return (
    <div className="chat-answer">
      <div className="chat-answer-in">
        <React.Fragment key={card.key}>
          {card.kind === 'permission' && <PermissionCard card={card} who={who} local={mine} shownAt={shownAt} onAnswer={onAnswer} onTerminal={onTerminal} />}
          {card.kind === 'question' && <QuestionCard card={card} who={who} local={mine} shownAt={shownAt} onAnswer={onAnswer} onTerminal={onTerminal} />}
          {card.kind === 'plan' && <PlanCard card={card} who={who} local={mine} shownAt={shownAt} onAnswer={onAnswer} onTerminal={onTerminal} />}
        </React.Fragment>
        {more > 0 && <div className="chat-answer-more">{t('{n}건 더 기다려요', { n: more })}</div>}
      </div>
    </div>
  )
}

export default AnswerSurface
