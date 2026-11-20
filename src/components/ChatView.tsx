/**
 * ChatView — a Claude Code session shown as a conversation (a read-only lens).
 * The real terminal keeps running underneath; this view only reads. It draws the session's
 * transcript and chat hooks as the page's store has them (src/chat/store.ts): the user's
 * messages, the assistant's prose as safe markdown, one-line tool rows, diffs, a
 * provisional bubble while text streams, the working line, "새 메시지 N개" (or, while the
 * session waits on the user, "… 기다려요"), an empty state for a new session, and the
 * read-failed banner with 터미널로 보기.
 *
 * Who answers is `who` (src/chat/lensMode.ts chatWho): in 업무 모드 a glyph and "에이전트".
 * Nothing here sends anything to the terminal. `footer` is the composer's slot;
 * `state` bypasses the store (the QA page draws a fixed conversation). The view takes the
 * focus only right after the user's own flip or session switch (src/chat/lensMode.ts
 * askChatFocus), never from something being typed into.
 *
 * Ctrl/⌘+F opens find over the conversation as the store holds it (src/chat/find.ts,
 * src/components/chat/FindBar.tsx); in a terminal it stays the terminal's own find, as in 1.4.0.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import '../styles/chat.css'
// the game's lively bits in the chat (the turn summary's steps): drawn only outside 업무 모드
import '../styles/chat-game.css'
import type { TerminalInfo } from '../desktop'
import { bridge } from '../desktop'
import { Pictures } from './chat/Pictures'
import { picturePaths } from '../chat/pictures'
import { josa, locale, t, useLang } from '../i18n'
import { buildRows, footCopies, type Row } from '../chat/rows'
import { sameEntries, wildEntries, wildWindow, type WildEntry } from '../chat/wild'
import { usePokedex } from '../pokedexStore'
import { noteStepSession, stepLedgerFor } from '../chat/steps'
import { ESTIMATE, TIGHT, useDensity } from '../chat/density'
import { parseMarkdown, type Block } from '../chat/markdown'
import { cardLinks, dropPreviews, releasePreviews } from '../chat/preview'
import { useSettings } from '../settingsStore'
import { chatViewOn } from '../features'
import { ITEM_CAP, chatStore, useChat, type ChatState } from '../chat/store'
import { formatDuration } from '../chat/toolLabel'
import { openFileFromChat, openUrlFromChat, takeChatFocus, type ChatWho } from '../chat/lensMode'
import type { AskCard, ChatItem, LensStatus, LiveItem, NoticeItem, TextItem, ToolItem } from '../chat/types'
import { UNCONFIRMED_MS, hookPromptsShown, outboxFor, pendingItems, type OutboxEntry } from '../chat/outbox'
import { TerminalIcon } from './Icons'
import { ChatContext, useChatContext, type ChatContextValue } from './chat/context'
import { ChatList, scrollKey, type ChatListHandle } from './chat/ChatList'
import { ChatBanner } from './chat/ChatBanner'
import { CopyButton } from './chat/CodeBlock'
import { Markdown } from './chat/Markdown'
import { LinkCard } from './chat/LinkCard'
import { ToolEntry } from './chat/ToolRow'
import { ToolGroup } from './chat/ToolGroup'
import { ThinkingRow } from './chat/ThinkingRow'
import { ShellRow } from './chat/ShellRow'
import { TurnFoot } from './chat/TurnFoot'
import { WildRow } from './chat/WildRow'
import { UserMessage } from './chat/UserMessage'
import { Lightbox } from './chat/Lightbox'
import { AnswerSurface, type AnswerFn } from './chat/AnswerSurface'
import { DialogCard, useTermDialog } from './chat/DialogCard'
import { FullButton, FullView, type FullState } from './chat/FullView'
import { FindBar, useFind } from './chat/FindBar'
import { AgentPanel, AgentStrip, useAgentChips, useAgentWidth } from './chat/AgentPanel'
import { cardNote, screenDialogs, shownCard } from '../chat/answer'
import { noticeText, overlayOpen } from '../chat/find'
import { appShortcut } from '../keys'

export interface ChatViewProps {
  term: TerminalInfo
  who: ChatWho
  project: string
  branch: string | null
  /** Show this session's terminal (the flip, or a banner's 터미널로 보기) */
  onTerminal(): void
  /** The composer (src/components/chat/Composer.tsx), under the conversation */
  footer?: React.ReactNode
  /** 멈추기 in the working line's right slot (the composer's stop: one Esc into the session) */
  onStop?: () => void
  /** A fixed conversation instead of the session's (the QA page) */
  state?: ChatState
  /** A diff block's +N −N: the 변경 사항 panel at that file and edit (absent: no panel, the counts stay text) */
  onChanges?: (p: { file: string; toolId: string }) => void
  /** 업무 모드: nothing of the game (no step count, and no GET /pokedex for it) */
  workMode?: boolean
  /** The new-version note's 설정에서 더 보기: 설정 › 세션 with the 채팅 보기 help open */
  onHelp?: () => void
}

/**
 * A Claude Code newer than the verified range: the quiet note, with 자세히 for one more line on
 * what is off for such a version (the buttons' holds) and the way to the 채팅 보기 help in 설정
 */
const VersionNote: React.FC<{ version: string | null; onHelp?: () => void }> = ({ version, onHelp }) => {
  const [more, setMore] = useState(false)
  return (
    <div className="chat-note">
      {t('확인하지 않은 Claude Code 버전({version})이에요. 이상하면 터미널로 보세요', { version: version ?? '?' })}
      {' '}<button type="button" className="chat-link-btn" aria-expanded={more} onClick={() => setMore(m => !m)}>{t('자세히')}</button>
      {more && <div className="chat-note-more">
        {t('이 버전에서는 허락·질문 버튼이 꺼지고 터미널에서 답해요')}
        {onHelp && <>{' '}<button type="button" className="chat-link-btn" onClick={onHelp}>{t('설정에서 더 보기')}</button></>}
      </div>}
    </div>
  )
}

// ---------------------------------------------------------------- times

const clock = (at: number) => new Date(at).toLocaleTimeString(locale(), { hour: 'numeric', minute: '2-digit' })
function dayLabel(at: number): string {
  const d = new Date(at)
  const today = new Date()
  const start = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime()
  const days = Math.round((start(today) - start(d)) / 86_400_000)
  const date = days === 0 ? t('오늘') : days === 1 ? t('어제') : d.toLocaleDateString(locale(), { month: 'long', day: 'numeric', weekday: 'short' })
  return `${date} · ${clock(at)}`
}
const nameVars = (name: string) => ({ name, iga: josa(name, '이가') })
const todayKey = () => new Date().toDateString()

/** Today's date, as a key that changes at midnight (오늘 / 어제 move on with it) */
function useToday(): string {
  const [day, setDay] = useState(todayKey)
  useEffect(() => {
    const now = new Date()
    const next = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).getTime() - now.getTime() + 1000
    const timer = setTimeout(() => setDay(todayKey()), Math.min(next, 2 ** 31 - 1))
    return () => clearTimeout(timer)
  }, [day])
  return day
}

// ---------------------------------------------------------------- the picture of who answers

/** The session's Pokémon, or in 업무 모드 the glyph, in a box of one size (no jump when it toggles) */
const Picture: React.FC<{ who: ChatWho; size: 'head' | 'empty' }> = ({ who, size }) => (
  <span className={`chat-pic ${size}`} aria-hidden="true">
    {who.picture === 'pokemon' && who.sprite
      ? <img src={size === 'empty' ? who.art ?? who.sprite : who.sprite} alt="" draggable={false} />
      : <span className="chat-glyph"><TerminalIcon size={size === 'empty' ? 30 : 13} /></span>}
  </span>
)

// ---------------------------------------------------------------- rows

/** `copy` false: the turn's foot copies the answer; a turn with no foot keeps the row's own */
const TextRow: React.FC<{ item: TextItem; copy?: boolean }> = ({ item, copy = true }) => {
  const { onLink, onPath, previews } = useChatContext()
  const blocks = useMemo(() => parseMarkdown(item.text), [item.text])
  // link preview cards (opt-in): only for a finished answer of the main thread (never an interrupted one,
  // never a sub-agent's), its first 3 links, each after the block holding it (src/chat/preview.ts cardLinks)
  const cards = useMemo(() => (previews && !item.partial && !item.parent ? cardLinks(blocks) : null), [previews, item.partial, item.parent, blocks])
  const afterBlock = useMemo(() => (cards && cards.size
    ? (_b: Block, key: string) => cards.get(key)?.map(url => <LinkCard key={url} url={url} />)
    : undefined), [cards])
  return (
    <div className="chat-prose chat-text">
      <Markdown blocks={blocks} onLink={onLink} onPath={onPath} afterBlock={afterBlock} />
      {!item.partial && <Pictures paths={picturePaths(item)} />}
      {item.partial && <p className="chat-stopped">{t('(멈춤)')}</p>}
      {item.truncated && <p className="chat-cut">{t('글이 길어서 앞부분만 보여요')} <FullButton itemId={item.id} title={t('답 전체')} /></p>}
      {/* the whole answer as its markdown (a selection across rows the list unmounted would lose its start);
          an answer cut at the lens's cap says, once copied, that its cut part was not */}
      {copy && <div className="chat-text-acts"><CopyButton text={item.text} label={t('답 복사')} cut={item.truncated === true} /></div>}
    </div>
  )
}

const LiveRow: React.FC<{ item: LiveItem }> = ({ item }) => {
  const { onLink, onPath } = useChatContext()
  const blocks = useMemo(() => parseMarkdown(item.text), [item.text])
  return (
    <div className="chat-live">
      <span className="chat-live-label">{t('작성 중')}</span>
      <div className="chat-prose"><Markdown blocks={blocks} onLink={onLink} onPath={onPath} /></div>
    </div>
  )
}

const NoticeRow: React.FC<{ item: NoticeItem }> = ({ item }) => {
  const { onTerminal } = useChatContext()
  // a notice this page does not know is said as one it cannot show (never silently nothing); its words are
  // src/chat/find.ts NOTICE_WORDS (find searches them as they are said here)
  const { kind, text } = noticeText(item)
  if (!text) return null
  return (
    <div className="chat-notice">
      <span>{text}</span>
      {kind === 'unknown-block' && <>
        <span aria-hidden="true">·</span>
        <button type="button" className="chat-link-btn" onClick={onTerminal}>{t('터미널로 보기')}</button>
      </>}
    </div>
  )
}

function renderRow(row: Row, who: ChatWho, noCopy = false): React.ReactNode {
  switch (row.row) {
    case 'day': return <div className="chat-day">{row.label}</div>
    case 'user': return <UserMessage item={row.item} time={row.item.at !== null ? clock(row.item.at) : null} />
    case 'turn-head': return (
      <div className="chat-turn-head">
        <Picture who={who} size="head" />
        <b>{who.name}</b>
        {row.at !== null && <span>· {clock(row.at)}</span>}
      </div>
    )
    case 'text': return <TextRow item={row.item} copy={!noCopy} />
    case 'tool': return <ToolEntry item={row.item} children={row.children} />
    case 'group': return <ToolGroup groupKey={row.key} items={row.items} files={row.files} searches={row.searches} />
    case 'notice': return <NoticeRow item={row.item} />
    case 'live': return <LiveRow item={row.item} />
    case 'thinking': return <ThinkingRow item={row.item} />
    case 'shell': return <ShellRow item={row.item} time={row.item.at !== null ? clock(row.item.at) : null} />
    case 'foot': return <TurnFoot row={row} name={who.name} />
    case 'wild': return <WildRow rowKey={row.key} entry={row.entry} />
    default: return null
  }
}

const sameList = <T,>(a: T[], b: T[]) => a.length === b.length && a.every((x, i) => x === b[i])
/** Two rows draw the same: main replaces an item whole, so the items' identity says it */
export function sameRow(a: Row, b: Row): boolean {
  if (a.row !== b.row || a.key !== b.key) return false
  switch (a.row) {
    case 'day': return a.label === (b as typeof a).label
    case 'turn-head': return a.at === (b as typeof a).at
    case 'thinking': return a.item === (b as typeof a).item
    case 'wild': return sameEntries([a.entry], [(b as typeof a).entry])
    case 'tool': return a.item === (b as typeof a).item && sameList(a.children, (b as typeof a).children)
    case 'group': return sameList(a.items, (b as typeof a).items)
    case 'foot': {
      const o = b as typeof a
      return a.item === o.item && a.tools === o.tools && a.files === o.files && a.whole === o.whole && sameList(a.texts, o.texts)
    }
    default: return (a as { item: unknown }).item === (b as { item: unknown }).item
  }
}

/**
 * One row, drawn again only when its items changed (a streaming tick touches only the bubble) — or
 * when the language changes (it follows the language itself, as BoxView and TodayLog do)
 */
const RowView = React.memo(function RowView({ row, who, noCopy = false }: { row: Row; who: ChatWho; noCopy?: boolean }) {
  useLang()
  return <>{renderRow(row, who, noCopy)}</>
}, (p, n) => p.who === n.who && p.noCopy === n.noCopy && sameRow(p.row, n.row))

// ---------------------------------------------------------------- the working line

/** The time since `since`, rewritten each second in its own text node (nothing else re-renders) */
const Elapsed: React.FC<{ since: number | null }> = ({ since }) => {
  const el = useRef<HTMLSpanElement>(null)
  useEffect(() => {
    if (since === null) return
    const tick = () => {
      const d = formatDuration(Date.now() - since)
      if (el.current) el.current.textContent = t(d.text, d.vars)
    }
    tick()
    const timer = setInterval(tick, 1000)
    return () => clearInterval(timer)
  }, [since])
  return <span ref={el} aria-hidden="true" />
}

/** A sentence with {time} in it, the time as a live text node */
function withTime(key: string, vars: Record<string, string>, since: number | null): React.ReactNode {
  const MARK = '\u0001'
  const [before, after = ''] = t(key, { ...vars, time: MARK }).split(MARK)
  const say = t(key, { ...vars, time: '' }).replace(/\s*·\s*$/, '')
  return <><span className="chat-sr">{say}</span><span aria-hidden="true">{before}</span><Elapsed since={since} /><span aria-hidden="true">{after}</span></>
}

/** Working / waiting, at the end of the conversation; the same height when nothing is shown (no jump) */
const WorkingLine: React.FC<{ status: LensStatus | null; who: ChatWho; onTerminal(): void; onStop?: () => void; card?: AskCard['kind'] | 'dialog' | null }> = ({ status, who, onTerminal, onStop, card = null }) => {
  // (a card below waits on the user: the line says who waits, even while the hooks say working — a question)
  const state = card && status?.state === 'working' ? 'waiting' : status?.state
  const shown = state === 'working' || state === 'waiting'
  return (
    <div className={`chat-status${shown ? ` ${state}` : ''}`} role="status">
      {state === 'working' && <>
        <Picture who={who} size="head" />
        <span className="chat-status-text">{withTime(status!.label === 'compact' ? '{name}{iga} 대화를 정리하는 중 · {time}' : '{name}{iga} 일하는 중 · {time}', nameVars(who.name), status!.since)}</span>
      </>}
      {/* (a card below says where to answer: this line only says who waits) */}
      {state === 'waiting' && card && <>
        <i className="chat-dot amber" aria-hidden="true" />
        <span className="chat-status-text">{t(card === 'permission' ? '{name}{iga} 허락을 기다려요' : card === 'dialog' ? '{name}{iga} 고르기를 기다려요 · 아래 카드에서 골라 주세요' : '{name}{iga} 답을 기다려요', nameVars(who.name))}</span>
      </>}
      {state === 'waiting' && !card && <>
        <i className="chat-dot amber" aria-hidden="true" />
        <span className="chat-status-text">{t('{name}{iga} 허락을 기다려요 · 터미널에서 답해 주세요', nameVars(who.name))}</span>
        <button type="button" className="chat-btn" onClick={onTerminal}>{t('터미널로 보기')}</button>
      </>}
      {/* 멈추기 (the composer's): only while the session works and waits on nobody */}
      {/* (not while a card waits: Esc would answer what it asks) */}
      {state === 'working' && onStop && !card && (
        <button type="button" className="chat-btn chat-stop" onClick={onStop} title={t('멈추기')}>{t('멈추기')} <kbd>Esc</kbd></button>
      )}
    </div>
  )
}

// ---------------------------------------------------------------- waits on the user

const AGENT_TOOLS = new Set(['Agent', 'Task'])
export interface Wait { kind: 'permission' | 'question' | 'plan'; key: string | null; agents: string[] }

/**
 * Whether the session waits on the user, and where: a row marked `waiting` (a sub-agent's row: its
 * Agent row), else — the status says waiting with no row of its own — a sub-agent's permission
 * (`status.waitingAgent`): that sub-agent's Agent row (all running Agent rows when it cannot be told
 * which); the main thread's own wait the lens could not pair: the bottom (the working line), with no
 * Agent row blamed for it.
 */
export function findWait(items: ChatItem[], status: LensStatus | null): Wait | null {
  let found: ToolItem | null = null
  for (const it of items) if (it.kind === 'tool' && it.waiting) found = it
  if (found) {
    const key = found.parent ?? found.id
    return { kind: found.waiting!, key, agents: found.parent ? [found.parent] : [] }
  }
  if (status?.state !== 'waiting') return null
  if (!status.waitingAgent) return { kind: 'permission', key: null, agents: [] }
  const running = items.filter((i): i is ToolItem => i.kind === 'tool' && !i.parent && AGENT_TOOLS.has(i.tool ?? '') && i.state === 'running')
  const own = running.filter(i => i.agentId === status.waitingAgent)
  const agents = (own.length ? own : running).map(i => i.id)
  return { kind: 'permission', key: agents.length ? agents[agents.length - 1] : null, agents }
}

// ---------------------------------------------------------------- the empty and loading states

const ChatEmpty: React.FC<{ who: ChatWho; project: string; branch: string | null }> = ({ who, project, branch }) => (
  <div className="chat-empty">
    <Picture who={who} size="empty" />
    <div className="chat-empty-title">{t('{name}{iga} 기다리고 있어요', nameVars(who.name))}</div>
    <div className="chat-empty-sub">{[project, branch].filter(Boolean).join(' · ')}</div>
    {/* a later phase puts suggested prompts here */}
    <div className="chat-empty-hint">{t('아래 입력란에 지시를 적어 보내요. 대화가 여기에 보여요')}</div>
  </div>
)

/** Nothing heard yet: after a moment a quiet word, never a blank pane */
const ChatLoading: React.FC = () => {
  const [late, setLate] = useState(false)
  useEffect(() => { const timer = setTimeout(() => setLate(true), 300); return () => clearTimeout(timer) }, [])
  return <div className="chat-loading" role="status">{late ? t('불러오는 중…') : ''}</div>
}

// ---------------------------------------------------------------- the view

/** How long one announcement stays before the next one (a screen reader reads a change, not a stack of them) */
const ANNOUNCE_MS = 1500
/** how long an answered card keeps the screen's dialogs unread (the dialog that answer closed may still be drawn) */
const SENT_SETTLE_MS = 1500

/**
 * The chat's live region: mounted with the view, so the first card is heard; what comes
 * while one is being read waits its turn instead of replacing it
 */
function useAnnouncer(): [string, (text: string) => void] {
  const [say, setSay] = useState('')
  const queue = useRef<string[]>([])
  const busy = useRef(false)
  const timer = useRef<ReturnType<typeof setTimeout>>()
  useEffect(() => () => clearTimeout(timer.current), [])
  const next = useCallback(() => {
    const text = queue.current.shift()
    if (text === undefined) { busy.current = false; return }
    busy.current = true
    setSay(text)
    timer.current = setTimeout(next, ANNOUNCE_MS)
  }, [])
  const announce = useCallback((text: string) => {
    if (!text) return
    queue.current.push(text)
    if (!busy.current) next()
  }, [next])
  return [say, announce]
}

// ---------------------------------------------------------------- the wild Pokémon met

const NO_WILD: WildEntry[] = []
const WILD_ALL = { from: -Infinity, to: Infinity }

/**
 * The wild Pokémon session `sid` met within this conversation's time (none when `sid` is null: 업무 모드, the QA page),
 * from the page's own game state (DexState.log and .today; nothing fetched). The list keeps its identity while what it
 * draws is the same, so the rows are not rebuilt on every game message.
 *
 * `wildNew(rowKey)`: the meeting was not in the game's state when this view first had it for this session (it happened
 * while the view was open) and its animation has not played yet (`wildPlayed`). One that was there at the view's
 * mount, after a reload, or after a switch back to the session, never animates.
 */
function useWild(sid: string | null, items: ChatItem[]) {
  const { state: dex } = usePokedex()
  const kept = useRef<WildEntry[]>(NO_WILD)
  const wild = useMemo(() => {
    const win = sid && dex ? wildWindow(items, Date.now()) : null
    const next = win && dex && sid ? wildEntries([...(dex.log ?? []), ...(dex.today ?? [])], sid, win) : NO_WILD
    if (!sameEntries(kept.current, next)) kept.current = next.length ? next : NO_WILD
    return kept.current
  }, [sid, dex, items])
  // what the game's state held for this session when the view first had both (keys, any time)
  const base = useRef<{ sid: string; keys: Set<string> } | null>(null)
  const played = useRef(new Set<string>())
  if (sid && dex && base.current?.sid !== sid) {
    base.current = { sid, keys: new Set(wildEntries([...(dex.log ?? []), ...(dex.today ?? [])], sid, WILD_ALL).map(e => e.key)) }
    played.current = new Set()
  }
  const wildNew = useCallback((rowKey: string) => {
    const key = rowKey.replace(/^wild:/, '')
    return !!base.current && !base.current.keys.has(key) && !played.current.has(key)
  }, [])
  const wildPlayed = useCallback((rowKey: string) => { played.current.add(rowKey.replace(/^wild:/, '')) }, [])
  return { wild, wildNew, wildPlayed }
}

const NO_ENTRIES: OutboxEntry[] = []
const NO_ASKS: AskCard[] = []
const noSub = () => () => {}
/** The QA page's cards answer nothing: a click stays 보내는 중… */
const qaAnswer: AnswerFn = () => new Promise(() => {})
const bridgeAnswer: AnswerFn = (p) => bridge?.chat.answer(p) ?? Promise.resolve({ ok: false, reason: 'off' })

export const ChatView: React.FC<ChatViewProps> = ({ term, who, project, branch, onTerminal, footer, onStop, state: fixed, onChanges, workMode = false, onHelp }) => {
  const lang = useLang()
  const today = useToday()
  const live = useChat(fixed ? null : term.id)
  const state = fixed ?? live
  const status = state.status
  const id = term.id
  // the composer's provisional bubbles (src/chat/outbox.ts), after the record, until its line replaces them
  const box = fixed ? null : outboxFor(id)
  const entries = useSyncExternalStore(box ? box.subscribe : noSub, () => (box ? box.entries() : NO_ENTRIES), () => NO_ENTRIES)
  const items = useMemo(() => {
    if (!entries.length) return state.items
    // (a prompt main shows from its hook that one of these bubbles stands for: only the bubble, never both)
    const shown = hookPromptsShown(entries, state.items)
    const all = [...(shown.size ? state.items.filter(i => !shown.has(i.id)) : state.items), ...pendingItems(entries)]
    return all.sort((a, b) => a.order - b.order || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  }, [state.items, entries])
  useEffect(() => {
    if (!box) return
    box.sync(state.items, status, Date.now())
    // a bubble sent and not in the record: said so once its time is up
    const sent = box.entries().filter(e => e.state === 'sent')
    if (!sent.length) return
    const due = Math.min(...sent.map(e => (e.sentAt ?? e.at) + UNCONFIRMED_MS)) - Date.now()
    const timer = setTimeout(() => box.sync(state.items, status, Date.now()), Math.max(0, due) + 20)
    return () => clearTimeout(timer)
  }, [box, state.items, status, entries])
  // how much is drawn (기본 / 생각 포함 / 전부, the header's menu): one level for the app, remembered
  const density = useDensity()
  // (older items not loaded: the first turn's start is not known, so its foot gives no counts)
  const hasOlder = !!status?.hasOlder
  // the game's parts (the steps, the wild Pokémon): only for a session shown as chat outside 업무 모드; none on the QA page
  const game = !workMode && !fixed
  const sid = term.sessionId
  // the wild Pokémon this session met within this conversation's time (src/chat/wild.ts), from the page's own game state
  const { wild, wildNew, wildPlayed } = useWild(game ? sid : null, items)
  const rows = useMemo(() => buildRows(items, { dayLabel, density, hasOlder, extra: wild }), [items, lang, today, density, hasOlder, wild]) // eslint-disable-line react-hooks/exhaustive-deps
  // the text rows whose copy a turn's foot took over
  const footed = useMemo(() => footCopies(rows), [rows])
  // the turn summary's steps (src/chat/steps.ts)
  const ledger = stepLedgerFor(game)
  useEffect(() => {
    if (!ledger || !sid) return
    noteStepSession(id, sid)
    // a turn end that arrived live (never one of a reset or an older page) brackets the turn's steps
    const off = chatStore.onAppended((tid, added) => {
      if (tid !== id) return
      for (const it of added) if (it.kind === 'turn-end') ledger.onTurnEnd(sid, it.id, () => chatStore.get(id).status?.state ?? null)
    })
    return () => { off(); ledger.stop(sid) }
  }, [ledger, id, sid])
  // a start sample when the session goes to work (idle / starting → working); a view opened mid-turn takes none
  const stateNow = status?.state ?? null
  const lastState = useRef<{ sid: string; state: LensStatus['state'] | null } | null>(null)
  useEffect(() => {
    const before = lastState.current?.sid === sid ? lastState.current.state : null
    lastState.current = { sid, state: stateNow }
    if (ledger && sid && stateNow === 'working' && (before === 'idle' || before === 'starting')) ledger.onWorking(sid)
  }, [ledger, sid, stateNow])
  // a picture shown large (the composer's chips, a sent message's thumbnails)
  // (owned: a URL made for the Lightbox alone, revoked when it closes: a thumbnail's own can go with its row)
  const [shown, setShown] = useState<{ images: { url: string; caption: string }[]; index: number; from: HTMLElement | null; owned?: boolean } | null>(null)
  const openImages = useCallback((images: { url: string; caption: string }[], index: number, from: HTMLElement | null, owned = false) => {
    if (images.length) setShown({ images, index, from, owned })
  }, [])
  const openImage = useCallback((url: string, caption: string, from: HTMLElement | null) => setShown({ images: [{ url, caption }], index: 0, from }), [])
  const closeImage = useCallback(() => {
    setShown(cur => {
      if (cur?.owned) for (const im of cur.images) URL.revokeObjectURL(im.url)
      const from = cur?.from
      if (from) requestAnimationFrame(() => { if (from.isConnected) from.focus({ preventScroll: true }) })
      return null
    })
  }, [])
  // a picture the conversation names (electron/chatPictures.cjs), the same function while the session
  // is the same, so a thumbnail is read once, not again with every change of the view; none on the QA page
  const loadPicture = useMemo(() => (fixed || !bridge?.chat.localImage ? undefined
    : (p: string) => bridge!.chat.localImage!(id, p).then(r => (r.ok ? { type: r.type, bytes: r.bytes } : null))), [id, fixed])
  // a picture the user sent, read again from its message's transcript line (the same function for the session)
  const loadUserImage = useMemo(() => (fixed || !bridge?.chat.userImage ? undefined
    : (itemId: string, index: number) => bridge!.chat.userImage!(id, itemId, index).then(r => (r.ok ? { type: r.type, bytes: r.bytes } : null))), [id, fixed])
  // "전체 보기": one item read again whole (bridge.chat.full), shown over the view until closed
  const [full, setFull] = useState<FullState | null>(null)
  const openFull = useCallback((itemId: string, title: string) => {
    const read = fixed ? undefined : bridge?.chat.full
    if (!read) return
    setFull({ title, loading: true })
    read(id, itemId).then(
      r => setFull(cur => (cur && cur.title === title ? (r.ok ? { title, loading: false, text: r.text, md: r.md, truncated: r.truncated } : { title, loading: false, error: r.reason }) : cur)),
      () => setFull(cur => (cur ? { title, loading: false, error: 'gone' } : cur)),
    )
  }, [id, fixed])
  const thumbs = useCallback((itemId: string) => {
    if (!box) return []
    if (itemId.startsWith('pending:')) return entries.find(e => `pending:${e.local}` === itemId)?.images.map(i => i.url) ?? []
    return box.thumbs(itemId)
  }, [box, entries])
  // link preview cards: only with the flag, 채팅으로 보기 and 링크 미리보기 on (main checks the same again);
  // off, the page's cards and their blob: URLs go; this view's go when it goes (a flip, a switch, the chat closed)
  const settings = useSettings()
  const previews = chatViewOn(settings) && settings.session.linkPreviews === true
  useEffect(() => { if (!previews) dropPreviews() }, [previews])
  useEffect(() => () => releasePreviews(id), [id])
  const wait = useMemo(() => findWait(state.items, status), [state.items, status])
  // the card the surface shows: when it can be answered here, the waiting rows point to it
  const card = shownCard(status?.asks)
  const cardHere = cardNote(card) === 'here'
  const agentsKey = wait?.agents.join(',') ?? ''
  // the sub-agents at work (the strip above the composer) and the one the panel shows (its Agent row's id)
  const chips = useAgentChips(status, state.items)
  const [agentShown, setAgentShown] = useState<string | null>(null)
  useEffect(() => { setAgentShown(null) }, [id])
  const openAgent = useCallback((toolId: string) => setAgentShown(cur => (cur === toolId ? null : toolId)), [])
  const ctx = useMemo<ChatContextValue>(() => ({
    id,
    onTerminal,
    onLink: openUrlFromChat,
    onPath: (file, line, col) => openFileFromChat(id, file, line, col),
    loadAgent: toolId => (fixed ? Promise.resolve({ ok: true }) : bridge?.chat.agent(id, toolId) ?? Promise.resolve({ ok: false })),
    // a picture the conversation names (electron/chatPictures.cjs); none on the QA page
    loadPicture,
    loadUserImage,
    waitingAgents: agentsKey ? agentsKey.split(',') : [],
    openImage,
    openImages,
    lightbox: !!shown,
    ...(fixed ? {} : { openFull }),
    thumbs,
    cardHere,
    ...(onChanges && !fixed ? { openChanges: onChanges } : {}),
    density,
    workMode,
    ...(ledger ? { stepsFor: ledger.stepsFor, stepsSubscribe: ledger.subscribe } : {}),
    ...(game ? { wildNew, wildPlayed } : {}),
    previews,
    openAgent,
    agentShown,
  }), [id, onTerminal, fixed, loadPicture, loadUserImage, agentsKey, openImage, openImages, shown, openFull, thumbs, cardHere, onChanges, density, workMode, ledger, game, wildNew, wildPlayed, previews, openAgent, agentShown])
  const banner = status?.banner ?? null
  const reload = () => { if (!fixed) chatStore.reload(id) }
  const older = () => (fixed ? undefined : bridge?.chat.older(id))
  const empty = !!status?.empty && !items.length
  // At the page's item cap older pages stop (they would be dropped again at once): the terminal has them
  const atCap = state.items.length >= ITEM_CAP - 150
  const listRef = useRef<ChatListHandle>(null)
  // the user's own flip or switch (askChatFocus, at most 2 s ago): the composer takes the focus (its own
  // effect: it may load a moment later), or, with no composer, the list once it is there; never from
  // something being typed into (ChatList's and the composer's focus checks)
  useEffect(() => {
    if (!fixed && !footer && listRef.current && takeChatFocus()) listRef.current.focus()
  })
  // what waits on the user: the answer surface, in the amber pill's place while it shows a card
  const asks = status?.asks ?? NO_ASKS
  // a dialog on the terminal's screen that no card holds: its own card, answered from here
  const dialogKey = fixed ? undefined : bridge?.chat.dialogKey
  // (a card that can only be answered in the terminal — too long, a sub-agent's — gives way to the dialog its
  // terminal shows, read from the screen; one answerable here, or an answer on its way, keeps the screen untouched)
  // (also one timed out, or answered and still waiting on Claude Code a moment after: src/chat/answer.ts
  // screenDialogs — a dialog that follows an answer gets its card too)
  const sentKeys = asks.filter(a => a.state === 'sent').map(a => a.key).join('\n')
  const [sentSettled, setSentSettled] = useState(true)
  useEffect(() => {
    if (!sentKeys) { setSentSettled(true); return }
    setSentSettled(false)
    const timer = setTimeout(() => setSentSettled(true), SENT_SETTLE_MS)
    return () => clearTimeout(timer)
  }, [sentKeys])
  const termOnly = asks.length > 0 && screenDialogs(asks, sentSettled)
  const dialog = useTermDialog(id, !!dialogKey && (!asks.length || termOnly))
  const waiting = wait && !asks.length ? { text: t(wait.kind === 'permission' ? '{name}{iga} 허락을 기다려요' : '{name}{iga} 답을 기다려요', nameVars(who.name)), key: wait.key } : null
  // the chat's one live region: there before any card, announcements one after another
  const [say, announce] = useAnnouncer()
  // find in the conversation (src/chat/find.ts): over the store's items as they are drawn (only what is loaded)
  const rootRef = useRef<HTMLDivElement>(null)
  const agentFit = useAgentWidth(rootRef, agentShown !== null)
  const listFocus = useCallback(() => listRef.current?.focus(), [])
  const find = useFind({ id, items, rows, density, hasOlder, list: listRef, root: rootRef, listFocus })
  const openFind = find.openBar
  // Ctrl/⌘+F (src/keys.ts appShortcut: Widget's capture handler lets it through) opens the bar, while this view is
  // mounted: never mid-composition, never from a terminal (its own find bar, as in 1.4.0), and never while a dialog,
  // 설정 or the lightbox is open on top (the bar would open under it)
  useEffect(() => {
    const onFindKey = (e: KeyboardEvent) => {
      if (appShortcut(e) !== 'find' || e.isComposing || e.defaultPrevented) return
      const el = e.target instanceof Element ? e.target : null
      if (el?.closest?.('.term-view')) return
      if (overlayOpen(document)) return
      e.preventDefault()
      openFind()
    }
    window.addEventListener('keydown', onFindKey)
    return () => window.removeEventListener('keydown', onFindKey)
  }, [openFind])
  // main hears which session's chat is the shown view (a question is answered from here only while it is);
  // none once this view goes or the page is hidden (a flip, a session switch, another view, the widget mode)
  useEffect(() => {
    if (fixed || !bridge?.chat.visible) return
    const say = () => bridge?.chat.visible(document.visibilityState === 'visible' ? id : null)
    say()
    document.addEventListener('visibilitychange', say)
    return () => { document.removeEventListener('visibilitychange', say); bridge?.chat.visible(null) }
  }, [fixed, id])
  return (
    <ChatContext.Provider value={ctx}>
      <div ref={rootRef} className={`chat${banner ? ' has-banner' : ''}${agentShown ? (agentFit.over ? ' has-ag over' : ' has-ag') : ''}`} data-terminal={id}
        style={agentShown ? { '--ag-w': `${agentFit.width}px` } as React.CSSProperties : undefined}>
        {/* find (Ctrl/⌘+F): over the conversation's top right, where the terminal's own bar sits */}
        {find.bar && <FindBar {...find.bar} />}
        {status?.note === 'new-version' && <VersionNote version={status.version ?? null} onHelp={onHelp} />}
        {banner && <ChatBanner reason={banner.reason} version={status?.version ?? null} onTerminal={onTerminal} onReload={reload} />}
        {status === null && !items.length
          ? <ChatLoading />
          : empty
            ? <ChatEmpty who={who} project={project} branch={branch} />
            : (
              <ChatList
                ref={listRef}
                // (a tab launched again under the same id: another session, whose scroll starts afresh)
                key={scrollKey(term)}
                id={scrollKey(term)}
                rows={rows}
                rev={state.rev}
                hasOlder={!!status?.hasOlder && !atCap}
                olderCut={!!status?.hasOlder && atCap}
                onOlder={older}
                renderRow={row => <RowView row={row} who={who} noCopy={footed.has(row.key)} />}
                tail={<WorkingLine status={status} who={who} onTerminal={onTerminal} onStop={onStop} card={card?.kind ?? (dialog ? 'dialog' : null)} />}
                dim={!!banner}
                waiting={waiting}
                estimate={ESTIMATE[density]}
                tight={TIGHT[density]}
                findNow={find.findNow}
              />
            )}
        <AgentStrip chips={chips} waiting={status?.state === 'waiting' ? status.waitingAgent ?? null : null} shown={agentShown} onOpen={openAgent} />
        <div className="chat-sr" aria-live="assertive">{say}</div>
        {asks.length > 0 && !(termOnly && dialog) && <AnswerSurface id={id} asks={asks} who={who} answer={fixed ? qaAnswer : bridgeAnswer} onTerminal={onTerminal} announce={announce} />}
        {(!asks.length || termOnly) && dialog && dialogKey && <DialogCard id={id} dialog={dialog} dialogKey={dialogKey} />}
        {footer}
        {shown && <Lightbox images={shown.images} start={shown.index} onClose={closeImage} />}
        {full && <FullView state={full} onClose={() => setFull(null)} />}
        {agentShown && <AgentPanel key={agentShown} toolId={agentShown} items={state.items} status={status} chips={chips} width={agentFit.width} over={agentFit.over} onWidth={agentFit.onWidth} onClose={() => setAgentShown(null)} />}
      </div>
    </ChatContext.Provider>
  )
}

export default ChatView
