/**
 * The sub-agents beside the conversation (the terminal shows what a sub-agent is doing; so does the chat):
 *
 * - AgentStrip — above the composer, one quiet chip per sub-agent at work (background ones too, until they report
 *   back): what it was asked, its latest tool, how long. A chip that finishes says 끝남 a moment, then leaves; the
 *   strip folds away when none runs. Its words come from status.agents (the hooks), never from a poll.
 * - AgentPanel — a chip, or an Agent row's 열어 보기, opens the sub-agent's own conversation in a column on the
 *   chat's right (the 변경 사항 panel's pattern: drag its edge, double-click for the default, × or Esc closes). Its
 *   rows are the ones AgentGroup asks for (chat:agent, the sub-agent's own transcript), asked again only while it
 *   is open and only when the sub-agent moved on (at most once a second); it follows new rows while scrolled to
 *   the end.
 *
 * Pure parts: src/chat/agents.ts.
 */

import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { t } from '../../i18n'
import { parseMarkdown } from '../../chat/markdown'
import { formatDuration, toolLabel } from '../../chat/toolLabel'
import { CHIP_KEEP_MS, panelMoment, runningAgents, panelRows, presence, sameChips, type AgentChip, type PanelRow, type ShownChip } from '../../chat/agents'
import type { ChatItem, LensStatus, ToolItem } from '../../chat/types'
import { AgentIcon, CheckIcon, XIcon } from './ChatIcons'
import { useChatContext } from './context'
import { Markdown } from './Markdown'
import { ToolEntry } from './ToolRow'

/** Now, once a second while `on` (one timer for the strip, one for the panel's head) */
function useNow(on: boolean): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!on) return
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [on])
  return now
}

const since = (from: number, now: number) => { const d = formatDuration(now - from); return t(d.text, d.vars) }
const baseName = (p: string) => p.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? p

/** The chip's latest tool, short: 파일 읽음 · rows.ts */
function lastWords(last: AgentChip['last']): string {
  if (!last) return ''
  const lab = toolLabel({ id: '', order: 0, at: null, kind: 'tool', tool: last.tool, input: last.input, state: 'running' })
  const detail = lab.mono && lab.detail && (last.input.file || last.input.path) ? baseName(lab.detail) : lab.detail
  return [t(lab.label, lab.vars), detail].filter(Boolean).join(' · ')
}

const chipName = (c: Pick<AgentChip, 'title' | 'type'>) => c.title || c.type || t('보조 에이전트')

// ---------------------------------------------------------------- the strip

export const AgentStrip: React.FC<{ chips: AgentChip[]; waiting?: string | null; shown: string | null; onOpen(toolId: string): void }> = ({ chips, waiting = null, shown, onOpen }) => {
  // the chips as drawn: the running ones, and the ones that just finished (their 끝남, then their leave)
  const [list, setList] = useState<ShownChip[]>(() => presence([], chips, Date.now()))
  useEffect(() => {
    setList(prev => { const next = presence(prev, chips, Date.now()); return sameChips(prev, next) ? prev : next })
  }, [chips])
  // a finished chip goes when its time is up
  const nextGone = list.reduce((m, c) => (c.gone !== undefined ? Math.min(m, c.gone + CHIP_KEEP_MS) : m), Infinity)
  useEffect(() => {
    if (nextGone === Infinity) return
    // (by the timer, not by comparing clocks: the chips that went by then go)
    const went = nextGone - CHIP_KEEP_MS
    const timer = setTimeout(() => setList(prev => prev.filter(c => c.gone === undefined || c.gone > went)), Math.max(0, nextGone - Date.now()) + 16)
    return () => clearTimeout(timer)
  }, [nextGone])
  const on = list.length > 0
  const now = useNow(on)
  const running = list.filter(c => c.gone === undefined).length
  return (
    <div className={`chat-agents${on ? ' on' : ''}`} aria-hidden={on ? undefined : true}>
      <div className="chat-agents-clip">
        <div className="chat-agents-in" role="group" aria-label={t('일하는 보조 에이전트 {n}개', { n: running })}>
          {list.map(c => {
            const done = c.gone !== undefined
            const waits = !done && waiting === c.id
            const words = done ? t('끝남') : waits ? t('허락을 기다려요') : lastWords(c.last)
            const name = chipName(c)
            const tip = [name, c.type && c.type !== name ? c.type : '', c.background ? t('백그라운드') : '', t('도구 {n}개', { n: c.tools })].filter(Boolean).join(' · ')
            return (
              <button key={c.id} type="button" className={`chat-agent-chip${done ? ' gone' : ''}${waits ? ' wait' : ''}${shown && shown === c.toolId ? ' on' : ''}`}
                disabled={!c.toolId} aria-pressed={shown !== null && shown === c.toolId} title={c.toolId ? tip : `${tip} · ${t('기록을 아직 찾는 중이에요')}`}
                onClick={() => { if (c.toolId) onOpen(c.toolId) }}>
                <span className="chat-agent-mark" aria-hidden="true">{done ? <CheckIcon size={10} /> : <i />}</span>
                <span className="chat-agent-name">{name}</span>
                {words && <span className="chat-agent-last">{words}</span>}
                {!done && <span className="chat-agent-time">{since(c.since, now)}</span>}
              </button>
            )
          })}
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------- the panel's width

export const AG_MIN = 280
export const AG_MAX = 560
export const AG_DEFAULT = 380
/** The conversation keeps this beside the panel; with less room the panel lies over it */
export const AG_CONVO = 400

/** The panel's width in a chat `room` px wide, and whether it lies over the conversation (no room beside it) */
export function agentWidth(want: number | null, room: number): { width: number; over: boolean } {
  const w = Math.round(Math.max(AG_MIN, Math.min(want ?? AG_DEFAULT, AG_MAX)))
  if (room - AG_CONVO >= AG_MIN) return { width: Math.min(w, room - AG_CONVO), over: false }
  return { width: Math.max(240, Math.min(w, room - 24)), over: true }
}
/** The width the user dragged it to, kept for this run of the app (the chat keeps no more page storage) */
let keptWidth: number | null = null

/** The panel's left edge (the 변경 사항 panel's, for --ag-w on the chat): drag, double-click or Home for the default, ← → by 16 */
const AgentResize: React.FC<{ width: number; onWidth(px: number | null): void }> = ({ width, onWidth }) => {
  const right = useRef<number | null>(null)
  const root = useRef<HTMLElement | null>(null)
  const at = (e: React.PointerEvent) => Math.round(Math.max(AG_MIN, Math.min((right.current ?? 0) - e.clientX, AG_MAX)))
  const show = (px: number) => root.current?.style.setProperty('--ag-w', `${px}px`)
  const onDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return
    e.preventDefault()
    e.currentTarget.setPointerCapture(e.pointerId)
    right.current = (e.currentTarget.parentElement as HTMLElement).getBoundingClientRect().right
    root.current = e.currentTarget.closest('.chat')
    root.current?.classList.add('ag-resizing')
  }
  const end = () => { right.current = null; root.current?.classList.remove('ag-resizing') }
  const onMove = (e: React.PointerEvent) => { if (right.current !== null) show(at(e)) }
  const onUp = (e: React.PointerEvent) => { if (right.current === null) return; const w = at(e); end(); onWidth(w) }
  const onCancel = () => { if (right.current === null) return; show(width); end() }
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') { e.preventDefault(); onWidth(width + (e.key === 'ArrowLeft' ? 16 : -16)) }
    else if (e.key === 'Home') { e.preventDefault(); onWidth(null) }
  }
  return (
    <div className="chat-ch-rz chat-ag-rz" role="separator" aria-orientation="vertical" tabIndex={0}
      aria-valuemin={AG_MIN} aria-valuemax={AG_MAX} aria-valuenow={width}
      title={t('끌어서 폭 조절 · 두 번 누르면 기본')} aria-label={t('보조 에이전트 패널 폭')}
      onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onCancel} onLostPointerCapture={onCancel}
      onDoubleClick={() => onWidth(null)} onKeyDown={onKey} />
  )
}

/** The panel's width for the chat it sits in (`root`): the one dragged to (this run), fitted to the chat's width as it changes */
export function useAgentWidth(root: React.RefObject<HTMLElement>, open: boolean) {
  const [want, setWant] = useState<number | null>(keptWidth)
  const [room, setRoom] = useState(0)
  useLayoutEffect(() => {
    const el = root.current
    if (!open || !el) return
    setRoom(el.clientWidth)
    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(() => setRoom(el.clientWidth))
    ro.observe(el)
    return () => ro.disconnect()
  }, [open, root])
  const fit = agentWidth(want, room || 1200)
  const onWidth = useCallback((px: number | null) => {
    const v = px === null ? null : Math.round(Math.max(AG_MIN, Math.min(px, AG_MAX)))
    setWant(v)
    keptWidth = v
  }, [])
  return { ...fit, onWidth }
}

// ---------------------------------------------------------------- the panel

const PanelText: React.FC<{ text: string }> = ({ text }) => {
  const { onLink, onPath } = useChatContext()
  const blocks = useMemo(() => parseMarkdown(text), [text])
  return <div className="chat-prose chat-ag-text"><Markdown blocks={blocks} onLink={onLink} onPath={onPath} /></div>
}

const PanelRowView = React.memo(function PanelRowView({ row }: { row: PanelRow }) {
  if (row.kind === 'text') return <PanelText text={row.item.text} />
  return <ToolEntry item={row.item} />
}, (a, b) => a.row.item === b.row.item)

export interface AgentPanelProps {
  /** The Agent row it shows */
  toolId: string
  items: ChatItem[]
  status: LensStatus | null
  /** The running sub-agents (the strip's) */
  chips: AgentChip[]
  width: number
  over: boolean
  onWidth(px: number | null): void
  onClose(): void
}

export const AgentPanel: React.FC<AgentPanelProps> = ({ toolId, items, status, chips, width, over, onWidth, onClose }) => {
  const ctx = useChatContext()
  const row = useMemo(() => items.find((i): i is ToolItem => i.kind === 'tool' && i.id === toolId) ?? null, [items, toolId])
  const chip = chips.find(c => c.toolId === toolId) ?? (row?.agentId ? chips.find(c => c.id === row.agentId) ?? null : null)
  const rows = useMemo(() => panelRows(items, toolId), [items, toolId])
  const running = !!chip || row?.state === 'running'
  const now = useNow(running && !!chip)
  // asked again only when the sub-agent moved on, one request at a time, at most once a second
  const moment = panelMoment(row, chip)
  const [answer, setAnswer] = useState<'asking' | 'ok' | 'none'>('asking')
  // (busy: a request in flight or its second after; `again`: the sub-agent moved on meanwhile — asked once more after)
  const busy = useRef(false)
  const again = useRef(false)
  const alive = useRef(true)
  const askRef = useRef<() => void>(() => {})
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
  const loadAgent = ctx.loadAgent
  askRef.current = () => {
    if (!alive.current) return
    if (busy.current) { again.current = true; return }
    busy.current = true
    const started = Date.now()
    loadAgent(toolId).catch(() => ({ ok: false })).then(r => { if (alive.current) setAnswer(a => (r.ok || a === 'ok' ? 'ok' : 'none')) }).finally(() => {
      setTimeout(() => {
        busy.current = false
        if (again.current) { again.current = false; askRef.current() }
      }, Math.max(0, 1000 - (Date.now() - started)))
    })
  }
  useEffect(() => { askRef.current() }, [toolId, moment])
  useEffect(() => { setAnswer('asking') }, [toolId])
  // follows new rows while scrolled to the end (the user scrolled up: stays where they are)
  const body = useRef<HTMLDivElement>(null)
  const atEnd = useRef(true)
  const onScroll = () => { const el = body.current; if (el) atEnd.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48 }
  useLayoutEffect(() => {
    const el = body.current
    if (el && atEnd.current) el.scrollTop = el.scrollHeight
  }, [rows])
  useEffect(() => { atEnd.current = true }, [toolId])
  const close = () => {
    const back = document.querySelector<HTMLElement>(`.chat-agent-chip.on, .chat-agent[data-tool="${CSS.escape(toolId)}"] .chat-ag-open`)
    onClose()
    if (back) requestAnimationFrame(() => { if (back.isConnected) back.focus() })
  }
  const onKey = (e: React.KeyboardEvent) => { if (e.key === 'Escape' && !e.defaultPrevented) { e.preventDefault(); close() } }
  const name = chip ? chipName(chip) : row?.input.description || row?.input.agentType || t('보조 에이전트')
  const tools = Math.max(chip?.tools ?? 0, row?.agentTools ?? 0, rows.filter(r => r.kind === 'tool').length)
  const background = chip?.background || row?.input.background === true
  const waits = !!chip && status?.waitingAgent === chip.id
  const state = chip
    ? (waits ? t('허락을 기다려요') : t('일하는 중 · {time}', { time: since(chip.since, now) }))
    : row?.state === 'failed' ? t('실패') : row?.state === 'interrupted' ? t('멈춤') : row?.state === 'running' ? t('실행 중') : t('끝남')
  return (
    <aside className={`chat-ag-panel${over ? ' over' : ''}`} aria-label={t('보조 에이전트')} onKeyDown={onKey}>
      <AgentResize width={width} onWidth={onWidth} />
      <div className="chat-ch-head chat-ag-head">
        <span className="chat-tool-ico" aria-hidden="true"><AgentIcon /></span>
        <b title={name}>{name}</b>
        <span className="chat-ch-spacer" />
        <button type="button" className="chat-ch-x" onClick={close} title={t('보조 에이전트 닫기')} aria-label={t('보조 에이전트 닫기')}><XIcon size={12} /></button>
      </div>
      <div className="chat-ch-sub chat-ag-sub" role="status">
        <span className={`chat-ag-state${chip ? (waits ? ' wait' : ' run') : ''}`}><i aria-hidden="true" />{state}</span>
        {tools > 0 && <span>{t('도구 {n}개', { n: tools })}</span>}
        {background && <span>{t('백그라운드')}</span>}
      </div>
      <div className="chat-ag-body" ref={body} onScroll={onScroll}>
        {rows.map(r => <PanelRowView key={r.item.id} row={r} />)}
        {!rows.length && <p className="chat-ch-empty">{answer === 'asking' ? t('불러오는 중…') : running ? t('아직 기록이 없어요. 일을 시작하면 여기에 보여요') : t('이 보조 에이전트의 기록을 찾지 못했어요')}</p>}
      </div>
    </aside>
  )
}

/** The running chips for the view (the same list while what they draw is the same) */
export function useAgentChips(status: LensStatus | null, items: ChatItem[]): AgentChip[] {
  const kept = useRef<AgentChip[]>([])
  return useMemo(() => {
    const next = runningAgents(status, items)
    const same = next.length === kept.current.length && next.every((c, i) => {
      const k = kept.current[i]
      return k.id === c.id && k.toolId === c.toolId && k.title === c.title && k.tools === c.tools && k.last === c.last && k.since === c.since && k.background === c.background && k.type === c.type
    })
    if (!same) kept.current = next
    return kept.current
  }, [status, items])
}

