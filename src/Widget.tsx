/**
 * Widget — the app. A transparent, always-on-top window with a bento of cards
 * (usage limits, launcher, Pokédex, the sessions, and a box to hand a
 * Pokémon its next instruction). As a window or full screen the same page grows
 * a terminal card beside it: one tab per Pokémon, the real Claude Code session,
 * and the Pokédex, box and log views.
 */

import React, { Suspense, lazy, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
// tokens.css before every other stylesheet: the design values they read
import './styles/tokens.css'
// terminal.css next: widget-expanded.css restyles the resume picker's frame
import './styles/terminal.css'
import './styles/widget.css'
import './styles/widget-expanded.css'
import './styles/pokedex.css'
import { useAgentSocket } from './hooks/useAgentSocket'
import { serverWsUrl } from './serverUrl'
import { dispatchMeters, useMeters, formatClockTime, formatResetDay, formatResetFull, usageTone, limitNow, type SessionStatus, type CodexWindow } from './meters'
import { hpTone, rowKeyAction, rowLabel, rowTooltip, sessionHeaderParts, setListMode, shellLabel, useListMode } from './sessionList'
import { sessionTools, shownCodexLimits } from './features'
import { bridge, useTerminals, type PastSession, type TerminalInfo, type WidgetMode, type UpdateState } from './desktop'
import { castSession, sessionArt, sessionName, sessionSprite, useTheme, spriteUrl, iconUrl, pokemonById } from './theme'
import { isHardNeedsYou } from './mainState'
import { cloudErrorText, dispatchCloud, useCloud } from './cloudStore'
import { dispatchPokedex, usePokedex, useViewed, levelOf, restingUids as restingOf, type Mon } from './pokedexStore'
import PatchNotes, { PatchNotesHistory } from './components/PatchNotes'
import SettingsView, { type Section as SettingsSection } from './components/SettingsView'
import FeedbackPin from './components/FeedbackPin'
import { changeSettings, useSettings, useWorkMode } from './settingsStore'
import { restorePicks } from './resting'
import { autoPartner, hideTitleKey, sessionLabel, sessionRowParts, shouldToast, viewIn, visibleViews, VIEWS, type View } from './workMode'
import { SwapPicker, ThrowPicker } from './components/PartyPickers'
import { LensSwitch, SessionHeader } from './components/SessionHeader'
import { useDragOrder } from './useDragOrder'
import { clampSideWidth, readSideWidth, sideMin, SIDE_DEFAULT, SIDE_MAX, writeSideWidth } from './sideWidth'
import { autoFold, canOpen, changesWidthFor, clampChangesWidth, CH_MAX, RAIL_W, readChangesWidth, readOpen, writeChangesWidth, writeOpen } from './changesWidth'
import { modeFromUrl, readCarry, writeCarry } from './carry'
import { askChatFocus, chatWho, effectiveMode, forgetChatTerminal, lensAvailability, readLensAll, writeLensAll, type LensMode } from './chat/lensMode'
import { closeTab, MAX_TABS, openTab, pruneTabs, showIn } from './sessionTabs'
import { panesFor, paneStyle } from './splitPanes'
import { noteMount, useWarm, warmNeeded } from './chat/termWarm'
import type { ComposerControl, ComposerHandle } from './components/chat/Composer'
import { ChatBoundary } from './components/ChatBoundary'
import { BoxIcon, SwapIcon, SidePanelIcon, TodayIcon, DexIcon, GearIcon, RankIcon, MinimizeIcon, MaximizeIcon, RestoreIcon, CloseIcon, FolderIcon, PlusIcon, PokeBall, SessionsIcon, UpdateIcon, RestartIcon, TerminalIcon, WidgetModeIcon } from './components/Icons'
// The views and the terminal (xterm) are their own chunks: the widget's first
// paint needs none of them. They are fetched right after it (preloadViews), so
// opening one later does not wait.
const loadTerminal = () => import('./components/TerminalPanel')
const loadDex = () => import('./components/PokedexView')
const loadBox = () => import('./components/BoxView')
const loadToday = () => import('./components/TodayLog')
const loadRank = () => import('./components/LeaderboardView')
const TerminalView = lazy(() => loadTerminal().then(m => ({ default: m.TerminalView })))
const ResumePicker = lazy(() => loadTerminal().then(m => ({ default: m.ResumePicker })))
const PokedexView = lazy(loadDex)
const BoxView = lazy(loadBox)
const TodayLog = lazy(loadToday)
const LeaderboardView = lazy(loadRank)
// The chat view (only while it is on, and only when a session is shown as chat: off, it never loads)
const ChatView = lazy(() => import('./components/ChatView'))
// the chat view's composer (Phase 3): loaded only with the chat view
const Composer = lazy(() => import('./components/chat/Composer'))
// the 변경 사항 panel and its header button (Phase 5): loaded only while the chat is shown
const loadChanges = () => import('./components/chat/ChangesPanel')
const ChangesPanel = lazy(loadChanges)
const ChangesButton = lazy(() => loadChanges().then(m => ({ default: m.ChangesButton })))
// 보기 정도 (기본 / 생각 포함 / 전부, Phase 5): in the header only while the chat is shown
const DensityMenu = lazy(() => import('./components/chat/DensityMenu'))
function preloadViews() {
  const go = () => { for (const load of [loadTerminal, loadDex, loadBox, loadToday, loadRank]) load().catch(() => {}) }
  if ('requestIdleCallback' in window) window.requestIdleCallback(go, { timeout: 2000 })
  else setTimeout(go, 500)
}
import { resetTextSize, stepTextSize, useTextStep } from './textSize'
import { bucketOf, nextSince, statusOrder, type Bucket } from './sessionOrder'
import { TextSizeControl } from './components/TextSizeControl'
import type { SessionInfo } from './types'
import { t, josa, nameOf, locale, lang } from './i18n'
import { appShortcut, wheelFontStep } from './keys'
import { isMac, modCombo, platformWord } from './platform'
import { termDim, termText } from './termMetrics'
import { promptRow, renameReady } from './chat/promptRow'


type Mood = 'working' | 'idle' | 'needs-you' | 'error' | 'ended'

/** The update's notes in the app's language: English, then Korean, when that language has none */
function updateNotes(u: { notes: string; notesEn?: string; notesJa?: string }): string {
  const l = lang()
  if (l === 'ja') return u.notesJa || u.notesEn || u.notes
  if (l === 'en') return u.notesEn || u.notes
  return u.notes
}

function moodOf(s: SessionInfo | undefined, t: TerminalInfo | undefined): Mood {
  if (t?.status === 'exited' || s?.state === 'ended') return 'ended'
  const m = s?.main
  if (!m) return 'idle'
  if (m.state === 'needs-you' && isHardNeedsYou(m.needsYou)) return 'needs-you'
  if (m.state === 'error') return 'error'
  if (m.state === 'working' || m.state === 'compacting' || m.state === 'waiting') return 'working'
  return 'idle'
}

/** A pending /rename is tried again at most this often (1.6.2: each try reads the terminal's last lines) */
const RENAME_RETRY_MS = 1000

const PREREQ_LABEL = {
  claude: { name: 'Claude Code', why: '포켓몬이 일할 Claude 세션' },
  git: { name: 'Git for Windows', why: 'Claude Code가 쓰는 Git Bash' },
} as const

const MOOD_LABEL: Record<Mood, string> = {
  working: '일하는 중', idle: '쉬는 중', 'needs-you': '확인 필요', error: '오류', ended: '종료',
}

interface Row {
  sessionId: string
  terminal?: TerminalInfo
  session?: SessionInfo
  meter?: SessionStatus
  mood: Mood
  name: string
  sprite: string
  project: string
  /** The git branch of the session's folder (null: not a repository) */
  branch?: string | null
  /** A plain shell tab: no AI, no Pokémon */
  shell?: boolean
  /** The trainer's name for the session */
  title: string | null
}

/**
 * A session's model, short: the status line's display name ("Opus 5.5"), else the id from its
 * start (claude-opus-5-5 -> "Opus 5.5"), else another tool's name; "Claude " and context notes trimmed
 */
function modelLabel(display?: string, id?: string): string {
  const name = (display ?? '').replace(/^Claude\s+/i, '').replace(/\s*\((\d+[KM])\s*context\)/i, ' $1').trim()
  if (name) return name
  const m = /claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?!\d)/i.exec(id ?? '')
  if (m) return `${m[1][0].toUpperCase()}${m[1].slice(1)} ${m[2]}${m[3] ? `.${m[3]}` : ''}`
  return (id ?? '').slice(0, 16)
}

/** A reset a day or more away: the date, or on its own day the time (meters.ts formatResetDay) */
const resetText = (epochSeconds: number): string => formatResetDay(epochSeconds)

/** What the header's update button does now (its label and tooltip; the button itself is an icon) */
const updateWord = (u: { status: string; progress?: number; needsFull?: boolean; error?: string | null }): string =>
  u.status === 'downloading' ? t('받는 중 {pct}%', { pct: Math.round((u.progress ?? 0) * 100) })
    : u.status === 'ready' ? t('재시작해서 적용')
    : u.needsFull ? t('새 버전 받기')
    : u.error ? t('업데이트 실패 · 다시 시도') : t('업데이트')

/** A token count, short: 124K, 1.2M */
function tokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1).replace(/\.0$/, '')}M`
  if (n >= 1000) return `${Math.round(n / 1000)}K`
  return String(Math.round(n))
}

function pct(n: number | null | undefined): string {
  return typeof n === 'number' ? String(Math.round(n)) : '—'
}

/** One limit row: label, bar, percent, when it resets (the bar grey, amber from 80 %, red from 90 %) */
const Limit: React.FC<{ label: string; value: number | null | undefined; reset: string | null; resetAt?: number | null }> = ({ label, value, reset, resetAt }) => (
  <div className={`w-limit tone-${usageTone(value)}${typeof value === 'number' ? '' : ' loading'}`}>
    <span className="w-label">{label}</span>
    <div className="w-bar" aria-hidden="true"><span style={{ width: `${typeof value === 'number' ? Math.max(2, Math.min(100, value)) : 0}%` }} /></div>
    <span className="w-limit-pct">{typeof value === 'number' ? <>{pct(value)}<small>%</small></> : <span className="w-limit-wait" />}</span>
    <span className="w-limit-reset" title={resetAt ? `${t('리셋 시각')} ${formatResetFull(resetAt)}` : t('리셋 시각')}>{reset ? `↻ ${reset}` : ''}</span>
  </div>
)

/** Bottom-right grip: a transparent window has no resizable frame on Windows */
const ResizeGrip: React.FC = () => {
  const start = useRef<{ x: number; y: number; w: number; h: number } | null>(null)
  const onDown = (e: React.PointerEvent) => {
    e.preventDefault()
    ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
    start.current = { x: e.screenX, y: e.screenY, w: window.outerWidth, h: window.outerHeight }
  }
  const onMove = (e: React.PointerEvent) => {
    const s = start.current
    if (!s) return
    bridge?.widget.resize(s.w + (e.screenX - s.x), s.h + (e.screenY - s.y))
  }
  const onUp = () => { start.current = null }
  return <div className="w-grip" onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} title={t('크기 조절')} aria-hidden="true" />
}

/**
 * The left panel's right edge (window and full screen): drag it for a width of 240–420px (300–420 on a Mac),
 * remembered (src/sideWidth.ts); double-click or Home for the default; ← / → 16px at a time.
 * The terminal keeps its size while the edge moves and fits once it rests (TerminalPanel).
 * While dragged the edge sets the app's --side-w itself (no re-render of the whole app per move);
 * the width is committed, and remembered, on release. A cancelled drag (the system took the
 * pointer) goes back to the width it started from, the one stored.
 */
const SideResize: React.FC<{ width: number; min: number; max: number; onWidth: (px: number | null, save: boolean) => void; onDragging: (on: boolean) => void }> = ({ width, min, max, onWidth, onDragging }) => {
  const left = useRef<number | null>(null)
  const app = useRef<HTMLElement | null>(null)
  const at = (e: React.PointerEvent) => e.clientX - (left.current ?? 0)
  const show = (px: number) => app.current?.style.setProperty('--side-w', `${px}px`)
  const onDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return
    e.preventDefault()
    e.currentTarget.setPointerCapture(e.pointerId)
    left.current = (e.currentTarget.parentElement as HTMLElement).getBoundingClientRect().left
    app.current = e.currentTarget.closest('.widget')
    onDragging(true)
  }
  const onMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (left.current === null) return
    const w = clampSideWidth(at(e), window.innerWidth, min)
    show(w)
    e.currentTarget.setAttribute('aria-valuenow', String(w))
  }
  const onUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if (left.current === null) return
    // Shown here too: a release on the width already kept changes no state, so React would leave
    // the last move's width on screen
    const w = clampSideWidth(at(e), window.innerWidth, min)
    show(w)
    e.currentTarget.setAttribute('aria-valuenow', String(w))
    onWidth(w, true)
    left.current = null
    onDragging(false)
  }
  const onCancel = (e: React.PointerEvent<HTMLDivElement>) => {
    if (left.current === null) return
    left.current = null
    show(width)
    e.currentTarget.setAttribute('aria-valuenow', String(width))
    onDragging(false)
  }
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') { e.preventDefault(); onWidth(width + (e.key === 'ArrowRight' ? 16 : -16), true) }
    else if (e.key === 'Home') { e.preventDefault(); onWidth(null, true) }
  }
  return (
    <div className="w-side-resize" role="separator" aria-orientation="vertical" tabIndex={0}
      aria-valuemin={min} aria-valuemax={max} aria-valuenow={width}
      title={t('끌어서 폭 조절 · 두 번 누르면 기본')} aria-label={t('왼쪽 패널 폭')}
      onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onCancel} onLostPointerCapture={onCancel}
      onDoubleClick={() => onWidth(null, true)} onKeyDown={onKey} />
  )
}

const Widget: React.FC = () => {
  // The session cast's version: the rows below draw each session as its Pokémon
  const castVersion = useTheme()
  useEffect(preloadViews, [])
  const meters = useMeters()
  const terminals = useTerminals()
  const onEvent = useCallback((e: Parameters<typeof dispatchMeters>[0]) => { dispatchMeters(e); dispatchPokedex(e as never); dispatchCloud(e as never) }, [])
  const { sessions, connected } = useAgentSocket({ onEvent, url: serverWsUrl() })

  const [update, setUpdate] = useState<UpdateState | null>(null)
  useEffect(() => {
    bridge?.update.get().then(setUpdate).catch(() => {})
    return bridge?.update.onState(setUpdate)
  }, [])
  // The one rename field open: in a list row or in the session header (never both)
  const [renaming, setRenaming] = useState<{ id: string; at: 'row' | 'header' } | null>(null)
  const renamingRef = useRef(renaming)
  const startRename = (id: string, at: 'row' | 'header') => { renamingRef.current = { id, at }; setRenaming({ id, at }) }
  // A rename opened from the keyboard (F2 on a row): Enter or Esc puts the focus back on that row
  const keyRename = useRef<string | null>(null)
  const backToRow = (sid: string) => {
    if (keyRename.current !== sid) return
    keyRename.current = null
    requestAnimationFrame(() => rowEls.current.get(sid)?.focus())
  }
  const [notesOpen, setNotesOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  // where 설정 opens when something other than its button opens it (the chat's version note: 세션, the 채팅 보기 help)
  const [settingsAt, setSettingsAt] = useState<{ section: SettingsSection; help?: boolean } | undefined>(undefined)
  const openChatHelp = useCallback(() => { setSettingsAt({ section: 'session', help: true }); setSettingsOpen(true) }, [])
  const [feedbackOpen, setFeedbackOpen] = useState(false)
  const closeFeedback = useCallback(() => setFeedbackOpen(false), [])
  // Read here so a settings change redraws the whole page (the privacy setting reaches every catch story)
  const settings = useSettings()
  // 업무 모드 (src/workMode.ts): nothing Pokémon on screen; the game goes on underneath
  const workMode = useWorkMode()
  const workModeRef = useRef(workMode)
  workModeRef.current = workMode
  useEffect(() => bridge?.settings?.onOpen(() => setSettingsOpen(true)), [])
  // A clicked notification: the Pokédex at that species (carried, since opening the window may swap pages)
  useEffect(() => bridge?.widget.onOpenDex(id => {
    if (workModeRef.current) return // no Pokédex in 업무 모드
    writeCarry({ dexPick: { id, at: Date.now() }, dexScroll: undefined })
    window.dispatchEvent(new CustomEvent('spawn:dex-pick', { detail: id }))
    setView('dex')
    setExpanded(true)
  }), [])
  // Ctrl+1–5 (⌘1–5 on macOS): 세션 / 도감 / 박스 / 기록 / 랭킹 (opens the window view from the widget too)
  // Ctrl+Alt+←/→ (⌘⌥←/→): the previous / next one (from the widget: opens the current one)
  // Ctrl+Tab, Ctrl+Shift+Tab / T / W (⌘⇧[ / ⌘⇧] / ⌘T / ⌘W): sessions (below). The map is src/keys.ts
  // Ctrl+Shift+H (⌘⇧H): 업무 모드 on and off (in 업무 모드 only the sessions view opens)
  useEffect(() => {
    const views = visibleViews(workMode)
    const onKey = (e: KeyboardEvent) => {
      const action = appShortcut(e)
      // Ctrl+= / Ctrl+- / Ctrl+0 (⌘ on macOS): the one text size, anywhere in the window. Taken here,
      // before the terminal's own handler sees it, so a press steps once
      if (action === 'fontUp' || action === 'fontDown' || action === 'fontReset') {
        e.preventDefault(); e.stopPropagation()
        if (action === 'fontReset') resetTextSize()
        else stepTextSize(action === 'fontUp' ? 1 : -1)
        return
      }
      if (action === 'workMode') {
        e.preventDefault(); e.stopPropagation()
        if (!e.repeat) void changeSettings({ app: { workMode: !workMode } })
        return
      }
      if (action === 'prevView' || action === 'nextView') {
        // Stopped here so the terminal and the dex grid do not also take the arrow
        e.preventDefault()
        e.stopPropagation()
        const step = !expanded ? 0 : action === 'nextView' ? 1 : -1
        setView(views[(views.indexOf(view) + step + views.length) % views.length])
        setExpanded(true)
        return
      }
      // Sessions, as in Windows Terminal: Ctrl+Tab / Ctrl+Shift+Tab next and previous, Ctrl+Shift+T
      // a new one, Ctrl+Shift+W close the one in view (Ctrl+T and Ctrl+W stay Claude Code's)
      if (action === 'prevTab' || action === 'nextTab') {
        e.preventDefault(); e.stopPropagation()
        const list = withTerminal.filter(r => r.terminal)
        if (!list.length) return
        const at = Math.max(0, list.findIndex(r => r.sessionId === shown?.sessionId))
        setTarget(list[(at + (action === 'prevTab' ? -1 : 1) + list.length) % list.length].sessionId)
        setView('terminal'); setExpanded(true)
        return
      }
      if (action === 'newTab' || action === 'closeTab') {
        e.preventDefault(); e.stopPropagation()
        if (action === 'newTab') void launch(false)
        else if (shown?.terminal) closeSession(shown)
        return
      }
      const n = ['view1', 'view2', 'view3', 'view4', 'view5'].indexOf(action ?? '')
      if (n < 0) return
      e.preventDefault()
      const want = VIEWS[n]
      if (!views.includes(want)) return // 업무 모드: Ctrl+2–5 (⌘2–5) do nothing
      setView(want)
      setExpanded(true)
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  })
  // Ctrl+wheel (⌘+wheel, or a trackpad pinch, on macOS): the text size anywhere in the window. Over
  // a terminal the terminal takes it first (TerminalPanel, the same step), so it steps once
  const widgetRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = widgetRef.current
    if (!el) return
    let lastPinchAt = 0
    const onWheel = (e: WheelEvent) => {
      if (e.defaultPrevented) return
      const size = wheelFontStep(e, Date.now(), lastPinchAt)
      if (!size) return
      e.preventDefault()
      lastPinchAt = size.pinchAt
      if (size.step) stepTextSize(size.step)
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [])
  // A new session name also becomes Claude Code's own name for it (/rename), sent when Claude is free
  const pendingRename = useRef(new Map<string, string>())
  const [mode, setModeState] = useState<WidgetMode>(modeFromUrl)
  const expanded = mode !== 'widget'
  const [viewState, setViewState] = useState<View>(() => readCarry().view ?? 'terminal')
  // 업무 모드 shows only the sessions: a hidden view gives way at once (no frame of it), and
  // is left for the sessions view for good (turning the mode off does not bring it back)
  const view = viewIn(viewState, workMode)
  // Noted for the carry at once: opening the window from the widget swaps pages before React re-renders
  const setView = (v: View) => { carried.current = { ...carried.current, view: v }; setViewState(v) }
  useEffect(() => { if (view !== viewState) setView(view) }, [view, viewState]) // eslint-disable-line react-hooks/exhaustive-deps
  const { state: dex, lastEvent } = usePokedex()
  const { isNew } = useViewed()
  const hasNew = Object.keys(dex?.caught ?? {}).some(id => isNew(Number(id)))
  // Catches, escapes, evolutions and level-ups pop up above every window (the ?toast window)
  useEffect(() => {
    if (!lastEvent || !bridge) return
    // (none in 업무 모드: the catch is in the Pokédex and the log, and is not replayed later)
    if (shouldToast(lastEvent, workModeRef.current)) bridge.toast.show(lastEvent)
  }, [lastEvent])
  useEffect(() => {
    bridge?.widget.getMode().then(setModeState).catch(() => {})
    return bridge?.widget.onMode((m) => setModeState(m))
  }, [])
  const flushBeforeSwap = useRef<() => void>(() => {})
  const setMode = (m: WidgetMode) => {
    flushBeforeSwap.current()
    setModeState(m)
    bridge?.widget.setMode(m)
  }
  // Opening a terminal or the dex widens the widget; an open window stays as it is
  const setExpanded = (flag: boolean) => {
    if (flag && expanded) return
    setMode(flag ? 'window' : 'widget')
  }

  // Each session folder's git branch: read again every 15 s (a checkout in the terminal shows up soon)
  const [branches, setBranches] = useState<Record<string, string | null>>({})
  const branchDirs = [...new Set(terminals.map(tm => sessions.find(s => s.id === tm.sessionId)?.cwd ?? tm.cwd).filter(Boolean))].sort().join('|')
  useEffect(() => {
    const b = bridge
    if (!b || !branchDirs) return
    let live = true
    const read = () => b.terminals.branches(branchDirs.split('|'))
      .then(got => { if (live) setBranches(prev => JSON.stringify(prev) === JSON.stringify(got) ? prev : got) })
      .catch(() => {})
    read()
    const timer = setInterval(read, 15_000)
    return () => { live = false; clearInterval(timer) }
  }, [branchDirs])

  const rows: Row[] = useMemo(() => {
    const ids = new Set<string>()
    for (const t of terminals) ids.add(t.sessionId)
    // Only the sessions this app runs: one left over from a closed app has no terminal to talk to
    return [...ids].map((sessionId) => {
      const terminal = terminals.find(t => t.sessionId === sessionId)
      const session = sessions.find(s => s.id === sessionId)
      const meter = meters.sessions.find(m => m.sessionId === sessionId)
      return {
        sessionId, terminal, session, meter,
        mood: moodOf(session, terminal),
        name: sessionName(sessionId, 'Claude'),
        title: terminal?.title ?? null,
        sprite: sessionSprite(sessionId),
        project: terminal?.project ?? session?.project ?? meter?.project ?? '',
        branch: branches[session?.cwd ?? terminal?.cwd ?? ''] ?? null,
        shell: terminal?.tool === 'shell',
      }
    }).filter(r => r.mood !== 'ended' || r.terminal)
  }, [terminals, sessions, meters, castVersion, branches])

  // A session that finishes its turn or starts waiting on the trainer while the app is behind:
  // a Windows notification and a flashing taskbar button (main skips it when the app is in front)
  const lastMood = useRef(new Map<string, Mood>())
  useEffect(() => {
    for (const r of rows) {
      const before = lastMood.current.get(r.sessionId)
      lastMood.current.set(r.sessionId, r.mood)
      if (!before || before === r.mood || !settings.notify.sessions || !r.terminal || r.shell) continue
      // 업무 모드: named by the session or its folder, never its Pokémon
      const name = sessionLabel({ ...r, noPokemon: noPokemon(r) }, workMode) ?? t('새 세션')
      if (r.mood === 'needs-you') bridge?.widget.alert(name, t('확인이 필요해요'))
      else if (before === 'working' && r.mood === 'idle') bridge?.widget.alert(name, t('일을 마쳤어요'))
    }
  }, [rows, settings.notify.sessions, workMode])

  // The left panel's order (2026-11-17): with 자동 정렬 (설정 › 세션, on by default) by what each session does —
  // 확인 필요 on top, then working in the order they started, then resting (the latest to rest first), then ended
  // (src/sessionOrder.ts). While the pointer is over the list the order holds still, so a row never moves under
  // a click; only a session that comes to need the user goes to the top at once. Off: the dragged order, as before.
  const autoSort = settings.session.autoSort !== false
  const orderInputs = rows.map(r => ({ id: r.sessionId, mood: r.mood, asking: r.terminal?.status === 'running' && !!r.terminal.asking }))
  const sinceRef = useRef(new Map<string, { b: Bucket; at: number }>())
  sinceRef.current = nextSince(sinceRef.current, orderInputs, Date.now())
  const [overList, setOverList] = useState(false)
  const heldOrder = useRef<string[] | null>(null)
  let listIds = rows.map(r => r.sessionId)
  if (autoSort) {
    const fresh = statusOrder(orderInputs, new Map([...sinceRef.current].map(([k, v]) => [k, v.at])))
    const held = heldOrder.current
    if (overList && held) {
      const kept = [...held.filter(id => fresh.includes(id)), ...fresh.filter(id => !held.includes(id))]
      const urgent = fresh.filter(id => bucketOf(orderInputs.find(o => o.id === id)!) === 0)
      listIds = [...urgent, ...kept.filter(id => !urgent.includes(id))]
    } else listIds = fresh
    heldOrder.current = listIds
  }
  // The rows reorder by dragging, like the tabs (the same order: terminals.move), while 자동 정렬 is off
  const rowById = new Map(rows.map(r => [r.sessionId, r]))
  const rowOrder = useDragOrder(listIds, 'y', (id, to) => {
    const term = rowById.get(id)?.terminal
    if (term) void bridge?.terminals.move(term.id, to)
  })

  const sendable = rows.filter(r => r.terminal && r.terminal.status === 'running')
  const isFree = (r: Row) => r.terminal?.status === 'running' && !r.terminal.asking && r.mood !== 'working' && r.mood !== 'needs-you'
  // (1.6.2) /rename is Claude Code's command: a shell or another tool would run it as typed
  const renames = (r: Row) => r.terminal?.tool === 'claude'
  const commitRename = (r: Row, value: string) => {
    if (!r.terminal) return
    const name = value.trim()
    if (name === (r.title ?? '')) return
    bridge?.terminals.rename(r.terminal.id, name)
    if (!name || !renames(r)) return
    if (isFree(r)) renameNow(r.terminal.id, name)
    else pendingRename.current.set(r.terminal.id, name)
  }
  // (the chat view's send between its text and its Enter refuses it, `busy`, and so does a key in that terminal in
  // the last 1.5 s, `typing`: the rename stays pending, never typed into that send or into the owner's text.
  // 1.6.2: and it is typed only into an empty prompt row, or one with only a dim suggestion, read right before)
  const renameNow = (id: string, name: string) => {
    if (!renameReady(promptRow(termText(id), termDim(id)))) {
      if (!pendingRename.current.has(id)) pendingRename.current.set(id, name)
      return
    }
    void bridge?.terminals.send(id, `/rename ${name}`).then(res => {
      if (res && !res.ok && (res.reason === 'busy' || res.reason === 'typing') && !pendingRename.current.has(id)) pendingRename.current.set(id, name)
    }, () => {})
  }
  // (a pending one is tried again at most once a second: each try reads the terminal's last lines, and the page
  // renders far more often than that)
  const renameTriedAt = useRef(new Map<string, number>())
  useEffect(() => {
    for (const r of rows) {
      const name = r.terminal && pendingRename.current.get(r.terminal.id)
      if (!name || !isFree(r)) continue
      const id = r.terminal!.id
      if (Date.now() - (renameTriedAt.current.get(id) ?? 0) < RENAME_RETRY_MS) continue
      renameTriedAt.current.set(id, Date.now())
      pendingRename.current.delete(id)
      renameNow(id, name)
    }
  })
  /**
   * Closes the rename field: with a value it commits (Enter, or the field losing focus), without
   * one it cancels (Esc). Once only: the field's blur as it goes away finds it already closed.
   */
  const endRename = (r: Row | undefined, value?: string) => {
    const cur = renamingRef.current
    if (!cur) return
    renamingRef.current = null
    setRenaming(null)
    if (r && value !== undefined && cur.id === r.sessionId) commitRename(r, value)
  }
  const withTerminal = rows.filter(r => r.terminal)
  const [target, setTarget] = useState<string | null>(() => readCarry().target ?? null)
  // Kept for the next window (a mode swap builds a new one) and the next start: the tab and
  // session, written at once, and flushed before a swap and when the page goes away
  const carried = useRef({ view, target })
  carried.current = { view, target }
  const flushCarry = useRef(() => writeCarry(carried.current)).current
  useEffect(() => { flushCarry() }, [view, target, flushCarry])
  useEffect(() => {
    window.addEventListener('pagehide', flushCarry)
    return () => window.removeEventListener('pagehide', flushCarry)
  }, [flushCarry])
  flushBeforeSwap.current = flushCarry
  const [note, setNote] = useState<string | null>(null)
  // A note goes away on its own after a few seconds
  useEffect(() => {
    if (!note) return
    const id = setTimeout(() => setNote(null), 7000)
    return () => clearTimeout(id)
  }, [note])
  const [picking, setPicking] = useState(false)
  const [closing, setClosing] = useState<string | null>(null)
  const [swapFor, setSwapFor] = useState<string | null>(null)
  const cloud = useCloud()
  const [accountOpen, setAccountOpen] = useState(false)
  const signIn = async () => {
    const r = await bridge?.cloud.signIn()
    setNote(r?.ok ? t('브라우저에서 Google 로그인을 마치면 여기로 돌아와요.') : t('로그인을 시작하지 못했어요 ({reason})', { reason: r?.reason ?? t('앱에서만 가능') }))
  }
  // What a session needs on this PC (electron/prereqs.cjs): Claude Code and Git
  type Prereqs = Awaited<ReturnType<NonNullable<typeof bridge>['env']['check']>>
  const [prereqs, setPrereqs] = useState<Prereqs | null>(null)
  const [checking, setChecking] = useState(false)
  const recheck = useCallback(async () => {
    if (!bridge) return
    setChecking(true)
    try { setPrereqs(await bridge.env.check()) } finally { setChecking(false) }
  }, [])
  useEffect(() => { recheck() }, [recheck])
  const missing = prereqs ? (Object.entries(prereqs) as [keyof Prereqs, Prereqs[keyof Prereqs]][]).filter(([, v]) => !v.ok) : []
  const monOf = (sessionId: string): Mon | undefined => {
    const uid = dex?.assign?.[sessionId]
    return uid ? dex?.mons?.[uid] : undefined
  }
  // Sessions whose throw is on its way (openSession): drawn with the Pokémon they were dressed in, not as Pokémon-less
  const pendingThrows = useRef<Set<string>>(new Set())
  /**
   * A session no Pokémon works yet: none rested when it opened, and the server sends it the next one
   * to rest. Drawn with the plain glyph (as in 업무 모드), no Lv and no swap
   */
  const noPokemon = (r: Row): boolean =>
    !!dex && !r.shell && !!r.terminal && r.mood !== 'ended' && !dex.assign?.[r.sessionId] && !pendingThrows.current.has(r.sessionId)
  // The top bar never scrolls and never clips the window buttons: when it runs out of room it
  // gives way a step at a time — 1: the view buttons drop their names (icons only); 2: the text
  // size folds to one 가 button (the same step menu); 3: the widget toggle goes (the tray and the
  // menu still reach the widget). Each step comes back once the bar is wide enough again for the
  // width it needed
  const viewBarRef = useRef<HTMLDivElement>(null)
  const [barLevel, setBarLevel] = useState(0)
  const neededWidth = useRef<number[]>([])
  const textStep = useTextStep()
  // What is in the bar: when it changes (the view, 업무 모드's one view, the text step and the
  // language the words are set in, the 도감 dot, the window's mode) the widths it needed before say
  // nothing, so they are dropped and the bar is measured again from the top
  const barContent = [expanded, mode, view, workMode, textStep, lang(), hasNew, update?.status ?? ''].join('|')
  const barContentSeen = useRef(barContent)
  useLayoutEffect(() => {
    const bar = viewBarRef.current
    if (barContentSeen.current !== barContent) {
      barContentSeen.current = barContent
      neededWidth.current = []
      if (barLevel !== 0) { setBarLevel(0); return }
    }
    if (!bar) return
    // The width its parts need: from the bar's left edge to the end of the last one (its margin and
    // the bar's own right padding included). Read from the parts' boxes, not scrollWidth, which
    // rounds and does not count a part that runs into the padding
    const measure = () => {
      const r = bar.getBoundingClientRect()
      let end = r.left
      for (const kid of bar.children) {
        const k = kid.getBoundingClientRect()
        if (k.width) end = Math.max(end, k.right + (parseFloat(getComputedStyle(kid).marginRight) || 0))
      }
      return { need: end - r.left + (parseFloat(getComputedStyle(bar).paddingRight) || 0), have: r.width }
    }
    const check = () => {
      const { need, have } = measure()
      if (need > have + 0.5) {
        if (barLevel < 3) { neededWidth.current[barLevel] = need; setBarLevel(barLevel + 1) }
      } else if (barLevel > 0 && have >= neededWidth.current[barLevel - 1] + 8) setBarLevel(barLevel - 1)
    }
    check()
    const ro = new ResizeObserver(check)
    ro.observe(bar)
    return () => ro.disconnect()
  }, [barLevel, barContent])
  const viewsCompact = barLevel >= 1
  // Window / fullscreen: the left panel folds away (remembered), leaving the terminal the whole width
  const [sideHidden, setSideHidden] = useState(() => { try { return localStorage.getItem('spawn-side-hidden') === '1' } catch { return false } })
  const toggleSide = () => setSideHidden(v => { const next = !v; try { localStorage.setItem('spawn-side-hidden', next ? '1' : '0') } catch {} ; return next })
  // Its width (src/sideWidth.ts): the remembered one, fitted to the window (the terminal keeps 320px)
  const [sideW, setSideW] = useState(() => { try { return readSideWidth(localStorage) } catch { return SIDE_DEFAULT } })
  const [winW, setWinW] = useState(() => window.innerWidth)
  useEffect(() => {
    const onResize = () => setWinW(window.innerWidth)
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])
  // (a Mac's narrowest is 300: its header sits 78px in, clear of the traffic lights)
  const sideLow = sideMin(isMac())
  const sideWidth = clampSideWidth(sideW, winW, sideLow)
  const sideMax = clampSideWidth(SIDE_MAX, winW, sideLow)
  const [sideDragging, setSideDragging] = useState(false)
  const setSideWidth = (px: number | null, save: boolean) => {
    if (px === null) { setSideW(SIDE_DEFAULT); writeSideWidth(null); return }
    const w = clampSideWidth(px, window.innerWidth, sideLow)
    setSideW(w)
    if (save) writeSideWidth(w)
  }
  const chosen = sendable.find(r => r.sessionId === target) ?? sendable[0]
  const shown = withTerminal.find(r => r.sessionId === target) ?? chosen ?? withTerminal[0]
  // The chat view (src/chat/lensMode.ts): 채팅 / 터미널, one choice for every session (2026-11-17; per session until
  // then), kept in the carry. Only a session whose terminal carries the chat key (the feature on, Claude Code) offers
  // it, never the widget; the terminal stays mounted either way and only its `active` follows the choice
  const [lensAll, setLensAll] = useState<LensMode>(readLensAll)
  const lens = lensAvailability(shown?.terminal, mode)
  const lensMode = effectiveMode(shown?.terminal, mode, lensAll)
  const lensSid = shown?.sessionId
  // The chat view takes the focus only on the user's own flip or session switch (never on its own mount:
  // a session restored in chat, a /clear, a first row arriving while the side panel is being typed into)
  // (a mark in lensMode.ts, not state: asking draws nothing again)
  const setLens = useCallback((m: LensMode) => { setLensAll(writeLensAll(m)); if (m === 'chat') askChatFocus() }, [])
  // The session tabs (src/sessionTabs.ts, 2026-11-17): up to three over the right side; the left list's click shows a
  // session in the tab in view, a session dropped on the right side (or Ctrl+clicked) gets a tab of its own
  const [tabs, setTabsState] = useState<string[]>(() => { const c = readCarry().tabs; return Array.isArray(c) ? c.filter(x => typeof x === 'string').slice(0, MAX_TABS) : [] })
  const setTabs = useCallback((next: string[]) => { setTabsState(next); writeCarry({ tabs: next }) }, [])
  const shownTab = useRef<string | null>(lensSid ?? null)
  useEffect(() => {
    if (!lensSid) return
    setTabsState(cur => { const next = showIn(cur, shownTab.current, lensSid); if (next !== cur) writeCarry({ tabs: next }); return next })
    shownTab.current = lensSid
  }, [lensSid])
  const aliveKey = withTerminal.map(r => r.sessionId).join('|')
  useEffect(() => {
    if (!withTerminal.length) return
    setTabsState(cur => { const next = pruneTabs(cur, new Set(withTerminal.map(r => r.sessionId))); if (next !== cur) writeCarry({ tabs: next }); return next })
  }, [aliveKey]) // eslint-disable-line react-hooks/exhaustive-deps
  const [tabNote, setTabNote] = useState<string | null>(null)
  useEffect(() => { if (!tabNote) return; const timer = setTimeout(() => setTabNote(null), 3000); return () => clearTimeout(timer) }, [tabNote])
  const openInTab = useCallback((sid: string) => {
    const r = openTab(tabs, sid)
    if (!r.ok) { setTabNote(t('{n}개까지 나란히 볼 수 있어요. 칸 하나를 닫고 다시 놓아 주세요', { n: MAX_TABS })); return }
    setTabs(r.tabs)
    shownTab.current = sid
    setTarget(sid)
    setView('terminal')
  }, [tabs, setTabs])
  const closeTabOf = useCallback((sid: string) => {
    const r = closeTab(tabs, lensSid, sid)
    setTabs(r.tabs)
    if (r.next) { shownTab.current = r.next; setTarget(r.next) }
  }, [tabs, lensSid, setTabs])
  // a session dragged from the left list over the right side: where it would go
  const [dropHint, setDropHint] = useState<string | null>(null)
  const SESSION_MIME = 'application/x-spawn-session'
  const toTerminal = useCallback(() => setLens('terminal'), [setLens])
  const lastShownSid = useRef(lensSid)
  // (a layout effect: it runs before the chat view's own effect, which takes the focus)
  useLayoutEffect(() => {
    if (lastShownSid.current && lensSid && lastShownSid.current !== lensSid) askChatFocus()
    lastShownSid.current = lensSid
  }, [lensSid])
  // 7-48 (src/chat/termWarm.ts): the shown session's terminal settles once it has fitted while visible
  // (until then, shown as chat, it stays active under the opaque chat pane); in chat, one that replayed
  // first asks main for one redraw. Only where the chat is offered; terminal mode asks nothing
  const warmTerm = view === 'terminal' && lens.show ? shown?.terminal?.id : undefined
  useWarm(warmTerm, !!warmTerm, lensMode === 'chat')
  // who answers, the same object while nothing about it changed (the chat's rows are not drawn again for nothing)
  const chatArt = shown ? sessionArt(shown.sessionId) : ''
  const shownNoMon = shown ? noPokemon(shown) : false
  const who = useMemo(() => chatWho({ name: shown?.name ?? '', sprite: shown?.sprite ?? '', art: chatArt, noPokemon: shownNoMon }, workMode), [shown?.name, shown?.sprite, chatArt, shownNoMon, workMode])
  // The composer under the chat (Phase 3): its handle (focus, 멈추기), and its control row from the side panel's own meters
  const composerRef = useRef<ComposerHandle | null>(null)
  const stopChat = useCallback(() => composerRef.current?.stop(), [])
  // The side panel's box while the chat is shown: a pointer to the composer, the same size (its text kept)
  const chatPointer = lensMode === 'chat' && view === 'terminal' && !!shown?.terminal
  // The 변경 사항 panel (Phase 5, src/changesWidth.ts): open or closed for every session (remembered), its width
  // remembered; it exists only while the chat of a window is shown, inside the chat's own area. While the left
  // panel, the conversation and the panel do not fit, the left panel shows as the rail: derived here on every
  // render, never stored (spawn-side-hidden is the user's own fold only), so it comes back by itself
  const [changesOpen, setChangesOpenState] = useState(() => { try { return readOpen(localStorage) } catch { return false } })
  const [chRemembered, setChRemembered] = useState<number | null>(() => { try { return readChangesWidth(localStorage) } catch { return null } })
  const [chTarget, setChTarget] = useState<{ file: string; toolId: string | null; n: number } | null>(null)
  const setChangesOpen = useCallback((open: boolean) => { setChangesOpenState(open); writeOpen(open); if (!open) setChTarget(null) }, [])
  const changesRoom = canOpen({ winW })
  const panelOn = lensMode === 'chat' && view === 'terminal' && mode !== 'widget' && changesOpen && canOpen({ winW }) && !!shown?.terminal
  const chBase = changesWidthFor(chRemembered, winW)
  const foldNow = expanded && autoFold({ winW, sideW: sideWidth, chW: Math.min(chBase, CH_MAX), open: changesOpen && changesRoom, chat: chatPointer, userHidden: sideHidden })
  const folded = sideHidden || foldNow
  // (the chat's area: the window less the left panel or the rail and the gaps)
  const chRoom = winW - (folded ? RAIL_W : sideWidth) - 12
  const chWidth = clampChangesWidth(chBase, chRoom)
  const chMax = clampChangesWidth(CH_MAX, chRoom)
  // The split view (src/splitPanes.ts, 2026-11-19): two or three open tabs side by side, each with its own header,
  // conversation and composer (or terminal); the 변경 사항 panel only without it
  const paneSids = view === 'terminal' && mode !== 'widget' ? panesFor(tabs.filter(sid => !!rowById.get(sid)?.terminal), shown?.sessionId, chRoom) : []
  const split = paneSids.length >= 2
  const chPanel = panelOn && !split
  // each pane's composer handle (멈추기, focus); the session in view uses composerRef (the side panel's pointer uses it)
  const paneRefs = useRef(new Map<string, React.MutableRefObject<ComposerHandle | null>>())
  const paneRef = (sid: string): React.MutableRefObject<ComposerHandle | null> => {
    if (sid === shown?.sessionId) return composerRef
    let r = paneRefs.current.get(sid)
    if (!r) { r = { current: null }; paneRefs.current.set(sid, r) }
    return r
  }
  const focusPane = (sid: string) => { if (sid !== shown?.sessionId) { shownTab.current = sid; setTarget(sid) } }
  const setChangesWidth = (px: number | null, save: boolean) => {
    if (px === null) { setChRemembered(null); writeChangesWidth(null); return }
    const w = clampChangesWidth(px, chRoom)
    setChRemembered(w)
    if (save) writeChangesWidth(w)
  }
  // a diff block's +N −N: the panel opens at that file and scrolls to that edit
  const openChangesAt = useCallback((p: { file: string; toolId: string }) => { setChangesOpen(true); setChTarget({ file: p.file, toolId: p.toolId, n: Date.now() }) }, [setChangesOpen])
  const toggleChanges = useCallback(() => setChangesOpen(!changesOpen), [changesOpen, setChangesOpen])
  // the rail's "unfold" (and its account button) while the panel folded it: the panel closes, so the left panel can come back
  const unfoldSide = () => { if (!sideHidden && foldNow) setChangesOpen(false); else toggleSide() }
  // a session gone: the chat's per-session memory (scroll, open rows) goes with it
  const chatSeen = useRef(new Set<string>())
  useEffect(() => {
    const now = new Set(terminals.map(t => t.id))
    for (const id of chatSeen.current) if (!now.has(id)) forgetChatTerminal(id)
    chatSeen.current = now
  }, [terminals])
  // The left list: 상세 or 간략 (src/sessionList.ts), and the open session's row kept in sight
  const listMode = useListMode()
  const compact = listMode === 'compact'
  const rowEls = useRef(new Map<string, HTMLElement>())
  // (also when the panel unfolds: a row picked from the rail while it was folded comes into sight)
  useEffect(() => {
    if (shown?.sessionId && !(expanded && folded)) rowEls.current.get(shown.sessionId)?.scrollIntoView({ block: 'nearest' })
  }, [shown?.sessionId, listMode, folded, expanded])
  // The header's rename field belongs to the session it opened on: another session shown (Ctrl+Tab,
  // the rail, a close) drops it, so it cannot come back stale with the first one
  useEffect(() => {
    const cur = renamingRef.current
    if (cur?.at === 'header' && cur.id !== shown?.sessionId) { renamingRef.current = null; setRenaming(null) }
  }, [shown?.sessionId])
  // In widget mode, the first session waiting on a question (its own output, or the hooks' needs-you)
  const askRow = expanded ? undefined : withTerminal.find(r => r.terminal?.status === 'running' && (r.terminal.asking || r.mood === 'needs-you'))

  // A new terminal becomes the one in front
  const lastCount = useRef(terminals.length)
  useEffect(() => {
    if (terminals.length > lastCount.current) setTarget(terminals[terminals.length - 1].sessionId)
    lastCount.current = terminals.length
  }, [terminals])

  // The last limits any session reported, kept by the server with no session open
  const lim = meters.limits
  const fiveHour = limitNow(lim?.fiveHour, lim?.fiveHourResetsAt)
  const sevenDay = limitNow(lim?.sevenDay, lim?.sevenDayResetsAt)
  // A window that has reset starts again at the next use: no reset time to show yet
  const fiveReset = fiveHour === 0 ? undefined : lim?.fiveHourResetsAt
  const sevenReset = sevenDay === 0 ? undefined : lim?.sevenDayResetsAt
  const claudeOpen = rows.some(r => r.terminal?.status === 'running' && (r.terminal.tool ?? 'claude') === 'claude')
  // the composer's control row: the shown session's model and context as its row shows them, the usage as the panel's
  const controlOf = (shown: Row | undefined): ComposerControl => {
    const used = shown?.meter?.context.used
    const size = shown?.meter?.context.size ?? null
    const left = typeof used === 'number' ? Math.max(0, Math.min(100, 100 - used)) : null
    const leftTokens = left !== null && size ? Math.round((size * left) / 100) : null
    const tip = left === null ? t('남은 컨텍스트')
      : leftTokens !== null ? t('남은 컨텍스트 {left} / {size} ({pct}%)', { left: tokens(leftTokens), size: tokens(size!), pct: Math.round(left) })
      : t('남은 컨텍스트 {pct}%', { pct: Math.round(left) })
    const barLabel = sessionRowParts({ title: shown?.title ?? null, name: shown?.name ?? '', project: shown?.project ?? '', level: null, helpers: 0, shell: false }, workMode).barLabel
    return {
      model: modelLabel(shown?.meter?.model, shown?.session?.model) || null,
      effort: shown?.meter?.effort ?? null,
      context: { left, tip, label: barLabel },
      usage: { ...(typeof fiveHour === 'number' ? { fiveHour } : {}), ...(typeof sevenDay === 'number' ? { weekly: sevenDay } : {}) },
    }
  }
  const chatControl = useMemo<ComposerControl>(() => controlOf(shown), [shown?.meter, shown?.session?.model, shown?.title, shown?.name, shown?.project, workMode, fiveHour, sevenDay, lang()]) // eslint-disable-line react-hooks/exhaustive-deps
  const showClaudeLimits = typeof fiveHour === 'number' || typeof sevenDay === 'number' || claudeOpen
  // Codex CLI's windows, labelled by their length (5 hours, a week on today's plans)
  // (none while other AI tools are switched off, src/features.ts: Claude's rows only)
  const codexLimits = shownCodexLimits(meters.codexLimits)
  const codexRows = ([['primary', codexLimits?.primary], ['secondary', codexLimits?.secondary]] as const)
    .filter((e): e is readonly ['primary' | 'secondary', CodexWindow] => !!e[1])
    .map(([key, w]) => {
      const value = limitNow(w.usedPercent, w.resetsAt ?? undefined)
      const m = w.windowMinutes ?? 0
      const day = 24 * 60
      const label = !m ? 'Codex' : m === 300 ? t('Codex 5시간') : m === 7 * day ? t('Codex 주간') : m >= 28 * day && m <= 31 * day ? t('Codex 월간')
        : m >= day ? t('Codex {d}일', { d: Math.round(m / day) }) : t('Codex {h}시간', { h: Math.max(1, Math.round(m / 60)) })
      const reset = value !== 0 && w.resetsAt ? (m > 24 * 60 ? resetText(w.resetsAt) : formatClockTime(w.resetsAt)) : null
      return { key, label, value, reset }
    })

  /** Where the next throw goes: a new session (optionally in a picked folder) or a resumed one */
  const [throwing, setThrowing] = useState<{ cwd?: string; resume?: PastSession } | null>(null)

  const launch = async (pick: boolean) => {
    if (!bridge) return
    if (missing.length) { setNote(t('먼저 위의 준비 카드에서 필요한 프로그램을 설치해주세요.')); return }
    let cwd: string | undefined
    if (pick) {
      const chosenDir = await bridge.terminals.pickFolder()
      if (!chosenDir) return
      cwd = chosenDir
    }
    sendOut({ cwd })
  }

  /**
   * Who goes with a new or resumed session: the trainer picks (ThrowPicker), or in 업무 모드
   * the app picks as a restored session does, with no Pokémon on screen (src/workMode.ts).
   * With nobody resting the session opens without one, and the server sends it the next to rest
   */
  const sendOut = (where: { cwd?: string; resume?: PastSession }) => {
    // (no picker to choose the AI tool: a new session takes the default one, a resumed one its own)
    const tool = where.resume ? undefined : sessionTools(settings.session).defaultTool
    const how = { ...where, ...(tool && tool !== 'claude' ? { tool } : {}) }
    if (!dex || !restingOf(dex).length) {
      void openSession(how, null)
      // (업무 모드: the session is open, which is all it needs to say)
      if (!workMode && dex) setNote(t('쉬고 있는 포켓몬이 없어서 포켓몬 없이 열었어요. 한 마리가 쉬게 되면 바로 함께해요.'))
      return
    }
    if (workMode) {
      void openSession(how, autoPartner(dex, where.resume ? dex.remembered?.[where.resume.id] : null))
      return
    }
    setThrowing(where)
  }

  /**
   * A new (or resumed) session. With a uid that Pokémon goes with it: the session is dressed in it
   * first (the tab must never show a bare Poké Ball) and held in pendingThrows until the throw is
   * answered. With null only the terminal opens; the session waits for the next Pokémon to rest.
   * `quiet` (the restore at startup): no terminal view and no note about the throw
   */
  const openSession = async (where: { cwd?: string; resume?: PastSession; tool?: string }, uid: string | null, quiet = false): Promise<void> => {
    setThrowing(null)
    if (!bridge) return
    const sessionId = where.resume?.id ?? crypto.randomUUID()
    const mon = uid ? dex?.mons?.[uid] : undefined
    if (mon) castSession(sessionId, mon.dex, mon.shiny)
    if (uid !== null) pendingThrows.current.add(sessionId)
    let opened: string | null = null
    try {
      const r = await bridge.terminals.create(where.resume ? { cwd: where.resume.cwd, resume: where.resume.id, ...(where.tool ? { tool: where.tool } : {}) } : { sessionId, ...(where.cwd ? { cwd: where.cwd } : {}), ...(where.tool ? { tool: where.tool } : {}) })
      if ('error' in r) { setNote(t('세션을 열 수 없어요: {error}', { error: r.error })); return }
      opened = r.sessionId
      if (uid !== null) {
        pendingThrows.current.add(r.sessionId)
        const thrown = await bridge.game.throw(r.sessionId, uid)
        // (업무 모드: the session is open, which is all it needs to say; these speak of the partner.
        // A quiet open is a restore at startup: the server gives it the next Pokémon, no note)
        if (!thrown.ok && !quiet && !workModeRef.current) setNote(thrown.reason === 'busy' ? t('세션은 열렸어요. 고른 파트너가 다른 세션에서 일하고 있어서 다른 파트너가 함께해요.') : thrown.reason === 'no-token' ? t('세션은 열렸어요. 서버와 연결되는 중이라 파트너는 잠시 뒤에 배정돼요.') : t('세션은 열렸지만 파트너를 배정하지 못했어요 ({reason})', { reason: thrown.reason ?? t('알 수 없는 이유') }))
      }
      setTarget(r.sessionId)
      if (where.resume && !quiet) { setView('terminal'); setExpanded(true) }
    } finally {
      pendingThrows.current.delete(sessionId)
      if (opened) pendingThrows.current.delete(opened)
    }
  }

  /** A plain shell tab (PowerShell): no Pokémon goes with it; at most MAX_SHELLS */
  const MAX_SHELLS = 3 // (past Chromium's ~16 WebGL contexts a terminal falls back to the DOM renderer: TerminalPanel's onContextLoss)
  /** A new shell; true when one opened (at the limit or on an error it leaves a note and says false) */
  const openShell = async (): Promise<boolean> => {
    if (!bridge) return false
    if (terminals.filter(tm => tm.tool === 'shell' && tm.status === 'running').length >= MAX_SHELLS) {
      setNote(t('셸은 {n}개까지 열 수 있어요.', { n: MAX_SHELLS }))
      return false
    }
    const r = await bridge.terminals.create({ tool: 'shell' })
    if ('error' in r) { setNote(t('세션을 열 수 없어요: {error}', { error: r.error })); return false }
    setTarget(r.sessionId)
    setView('terminal')
    return true
  }

  const resume = async (past: PastSession) => {
    setPicking(false)
    if (!bridge) return
    // The Pokémon that worked this session comes back with it, if it is resting
    const remembered = dex?.remembered?.[past.id]
    if (dex && remembered && restingOf(dex).includes(remembered)) { await openSession({ resume: past }, remembered); return }
    sendOut({ resume: past })
  }

  // The sessions open when the app last closed come back at start (설정 › 세션), every one of them:
  // each with the Pokémon that worked it when that one rests, else the next resting one no other
  // session remembers, else with none (it waits for the next to rest, as a new session does).
  // A Pokémon goes with one session only (src/resting.ts restorePicks)
  const restored = useRef(false)
  useEffect(() => {
    if (restored.current || !bridge || !dex) return
    restored.current = true
    void (async () => {
      const open = await bridge.terminals.restorable().catch(() => [])
      // A session coming back may hold its own Pokémon still (the last run's record): that one is not taken
      const back = new Set(open.map(s => s.sessionId))
      const held = Object.fromEntries(Object.entries(dex.assign ?? {}).filter(([sid]) => !back.has(sid)))
      const picks = restorePicks(
        open.filter(s => s.tool !== 'shell').map(s => ({ id: s.sessionId, remembered: dex.remembered?.[s.sessionId] })),
        restingOf({ ...dex, assign: held }),
      )
      for (const s of open) {
        // A shell tab comes back as a fresh shell in its folder, with no Pokémon
        if (s.tool === 'shell') { await bridge.terminals.create({ cwd: s.cwd, tool: 'shell' }); continue }
        const uid = picks.get(s.sessionId) ?? null
        // Every tab comes back under its own id (so with its Pokémon): Claude Code and Codex CLI
        // resume their conversation, another tool opens anew in the same folder
        await openSession({ resume: { id: s.sessionId, cwd: s.cwd } as PastSession, ...(s.tool && s.tool !== 'claude' ? { tool: s.tool } : {}) }, uid, true)
      }
    })()
  }, [dex]) // eslint-disable-line react-hooks/exhaustive-deps

  const closeSession = (r: Row) => {
    if (!r.terminal) return
    if (settings.session.confirmClose && closing !== r.sessionId) { setClosing(r.sessionId); return }
    setClosing(null)
    bridge?.terminals.close(r.terminal.id)
  }

  const openIds = new Set(terminals.filter(t => t.status === 'running').map(t => t.sessionId))

  const doSwap = async (sessionId: string, uid: string) => {
    setSwapFor(null)
    if (!bridge) return
    // Drawn as the new Pokémon at once; the server's update confirms it (or it goes back)
    const before = monOf(sessionId)
    const next = dex?.mons?.[uid]
    if (next) castSession(sessionId, next.dex, next.shiny)
    const r = await bridge.game.swap(sessionId, uid)
    if (!r.ok) {
      if (before) castSession(sessionId, before.dex, before.shiny)
      setNote(t('교체하지 못했어요 ({reason})', { reason: r.reason === 'busy' ? t('다른 세션에서 일하는 중') : r.reason ?? t('알 수 없음') }))
    }
  }

  // The header's profile (or 로그인): right of the logo, or in 업무 모드 in the logo's place
  const accountButton = cloud?.enabled && (cloud.user ? (
    <button className="w-account" onClick={() => setAccountOpen(!accountOpen)} title={`${cloud.user.email ?? ''}${cloud.lastSyncAt ? ` · ${t('{time} 동기화', { time: new Date(cloud.lastSyncAt).toLocaleTimeString(locale(), { hour: '2-digit', minute: '2-digit' }) })}` : ''}`}>
      {cloud.user.avatar ? <img src={cloud.user.avatar} alt="" referrerPolicy="no-referrer" /> : <span>{(cloud.user.name ?? cloud.user.email ?? '?').slice(0, 1)}</span>}
    </button>
  ) : (
    <button className="w-signin" onClick={signIn} title={workMode ? t('Google로 로그인') : t('Google 계정으로 로그인하면 여러 PC에서 도감이 동기화돼요')}>{t('로그인')}</button>
  ))

  // The update button, in the primary colour: in the right bar as a window, in the header as the widget
  const updateButton = update && (update.status === 'available' || update.status === 'downloading' || update.status === 'ready') ? (
    <button
      className={`w-update ${update.status}${update.status === 'available' && update.error ? ' failed' : ''}`}
      disabled={update.status === 'downloading'}
      aria-label={updateWord(update)}
      title={`${updateWord(update)} · ${update.current} → ${update.latest}${updateNotes(update) ? `

${updateNotes(update)}` : ''}${update.error ? `

${t('오류: {error}', { error: update.error })}` : ''}`}
      onClick={() => {
        if (update.needsFull) bridge?.env.openLink('release')
        else if (update.status === 'available') bridge?.update.install()
        else if (update.status === 'ready') bridge?.update.restart()
      }}
    >
      {/* an icon, so the header never squeezes the profile (1.6.1); the words are the tooltip's. A downloaded update
          (ready) is told apart from one to get (2026-11-19, the owner: the two looked the same): a restart arrow and 재시작 */}
      {update.status === 'ready' ? <><RestartIcon size={14} /><span className="w-update-word">{t('재시작')}</span></> : <UpdateIcon size={14} />}
    </button>
  ) : null

  return (
    <div ref={widgetRef} className={`widget${expanded ? ' expanded' : ''} mode-${mode}${expanded && folded ? ' side-hidden' : ''}${sideDragging ? ' resizing' : ''}`}
      style={expanded ? { '--side-w': `${sideWidth}px` } as React.CSSProperties : undefined}>
      {/* The left panel folded: only the essentials, in one column (logo, new session,
          folder, resume, the open sessions, usage, settings) */}
      {expanded && folded && (
        <nav className="w-rail" aria-label={t('왼쪽 패널 (접힘)')}>
          {/* 업무 모드: no ball, its slot kept empty (as the lab), so nothing below moves when the mode toggles */}
          {workMode ? <span className="w-rail-btn w-rail-brand w-rail-blank" aria-hidden="true" /> : (
            <button className="w-rail-btn w-rail-brand" onClick={() => setNotesOpen(true)} title={t('spawn {version} · 눌러서 패치노트 보기', { version: update?.current ?? '' })}>
              <PokeBall size={20} />
              <span className={`w-rail-conn${connected ? '' : ' off'}`} />
            </button>
          )}
          {/* The panel's own fold button: here to unfold it, in the panel's header to fold it */}
          <button className="w-rail-btn w-side-toggle" onClick={unfoldSide} title={t('왼쪽 패널 펼치기')} aria-label={t('왼쪽 패널 펼치기')} aria-pressed={false}><SidePanelIcon size={15} /></button>
          <span className="w-rail-sep" />
          <button className="w-rail-btn" onClick={() => launch(false)} title={t('새로운 세션 시작하기')} aria-label={t('새로운 세션 시작하기')}><PlusIcon size={16} /></button>
          <button className="w-rail-btn" onClick={() => launch(true)} title={t('다른 폴더에서 새 세션')} aria-label={t('다른 폴더에서 새 세션')}><FolderIcon /></button>
          <button className="w-rail-btn" onClick={() => setPicking(true)} title={t('예전 세션 골라서 이어하기')} aria-label={t('예전 세션 이어하기')}><SessionsIcon /></button>
          {/* A new shell, as the list header's >_ does while the panel is open */}
          <button className="w-rail-btn w-rail-newshell" onClick={() => { void openShell() }} title={t('셸 열기')} aria-label={t('셸 열기')}>&gt;_</button>
          <span className="w-rail-sep" />
          <div className="w-rail-sessions">
            {withTerminal.map(r => (
              <button key={r.sessionId}
                className={`w-rail-btn w-rail-session mood-${r.mood}${shown?.sessionId === r.sessionId && view === 'terminal' ? ' on' : ''}`}
                onClick={() => { setTarget(r.sessionId); setView('terminal') }}
                title={`${r.title ?? t('새 세션')} · ${t(MOOD_LABEL[r.mood])}`} aria-label={r.title ?? t('새 세션')}>
                {r.shell ? <span className="w-rail-shell" aria-hidden="true">&gt;_</span>
                  : workMode || noPokemon(r) ? <span className="w-rail-glyph" aria-hidden="true"><TerminalIcon size={18} /></span>
                  : <img src={r.sprite} alt="" draggable={false} />}
                <span className="w-rail-dot" />
              </button>
            ))}
          </div>
          {(() => {
            // Usage: two thin bars (Claude's 5 h and weekly, else Codex's first two), the numbers on hover
            const bars = showClaudeLimits
              ? [{ key: '5h', label: t('5시간'), value: fiveHour }, { key: '7d', label: t('주간'), value: sevenDay }]
              : codexRows.slice(0, 2).map(r => ({ key: r.key, label: r.label, value: r.value }))
            if (!bars.length) return null
            const title = bars.map(b => `${b.label} ${typeof b.value === 'number' ? `${Math.round(b.value)}%` : '—'}`).join(' · ')
            return (
              <div className="w-rail-usage" title={title} aria-label={title}>
                <div className="w-rail-bars">
                  {bars.map(b => {
                    const v = typeof b.value === 'number' ? Math.max(0, Math.min(100, b.value)) : 0
                    const tone = usageTone(v)
                    return <span key={b.key} className={`w-rail-bar${tone === 'ok' ? '' : ` ${tone}`}`}><i style={{ height: `${v}%` }} /></span>
                  })}
                </div>
              </div>
            )
          })()}
          <button className="w-rail-btn" onClick={() => setSettingsOpen(true)} title={t('설정')} aria-label={t('설정')}><GearIcon size={15} /></button>
          {/* The profile, as in the panel's header: it unfolds the panel onto the account card */}
          {cloud?.enabled && (cloud.user ? (
            <button className="w-rail-btn w-rail-account" onClick={() => { unfoldSide(); setAccountOpen(true) }} title={cloud.user.email ?? ''} aria-label={t('계정')}>
              <span className="w-account">{cloud.user.avatar ? <img src={cloud.user.avatar} alt="" referrerPolicy="no-referrer" /> : (cloud.user.name ?? cloud.user.email ?? '?').slice(0, 1)}</span>
            </button>
          ) : (
            <button className="w-rail-btn w-rail-signin" onClick={signIn} title={workMode ? t('Google로 로그인') : t('Google 계정으로 로그인하면 여러 PC에서 도감이 동기화돼요')}>{t('로그인')}</button>
          ))}
        </nav>
      )}
      <div className="w-side">
        <div className="w-bento">
          <header className="w-card w-head">
            {/* The ball, the same size and spot as the folded rail's so the logo stays put when the
                panel folds; it opens the patch notes (no wordmark beside it since 1.6.1, the owner's call) */}
            {/* 업무 모드: no ball and no wordmark; the profile takes their place on the left and the
                connection dot follows it (on a Mac the window's traffic lights would sit in this corner) */}
            {!workMode && <button className="w-brand" onClick={() => setNotesOpen(true)} title={t('spawn {version} · 눌러서 패치노트 보기', { version: update?.current ?? '' })} aria-label={t('spawn {version} · 눌러서 패치노트 보기', { version: update?.current ?? '' })}><PokeBall size={20} /></button>}
            {workMode && accountButton}
            <span className={`w-conn${connected ? '' : ' off'}`} title={connected ? t('연결됨') : t('서버 연결 끊김')} />
            {!workMode && accountButton}
            {/* As a window the update button sits in the right bar; the widget has no right side */}
            {!expanded && updateButton}
            <button className="w-icon" onClick={() => setSettingsOpen(true)} title={t('설정')} aria-label={t('설정')}><GearIcon size={14} /></button>
            {expanded && (
              <button className="w-icon w-side-toggle on" onClick={toggleSide} title={t('왼쪽 패널 접기')} aria-label={t('왼쪽 패널 접기')} aria-pressed={true}><SidePanelIcon size={14} /></button>
            )}
            {!expanded && (
              <button className="w-icon" onClick={() => setMode('window')} title={t('창 모드로 펼쳐서 터미널 보기')} aria-label={t('펼치기')}>⇤</button>
            )}
            {/* As a window the right side has its own minimize and close */}
            {!expanded && <button className="w-icon" onClick={() => bridge?.widget.hide()} title={t(hideTitleKey(workMode, isMac()), isMac() ? { tray: t(platformWord('tray', true)) } : undefined)} aria-label={t('숨기기')}>–</button>}
          </header>

          {accountOpen && cloud?.user && (
            <section className="w-card w-account-card">
              <div className="w-account-who">
                <b>{cloud.user.name ?? (workMode ? t('계정') : t('트레이너'))}</b>
                <span>{cloud.user.email}</span>
              </div>
              <div className="w-account-sync">
                {cloud.error ? <span className="tone-warn">{cloudErrorText(cloud.error)}</span>
                  : cloud.lastSyncAt ? t('마지막 동기화 · {time}', { time: new Date(cloud.lastSyncAt).toLocaleString(locale(), { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) })
                  : t('아직 저장 전이에요')}
              </div>
              <div className="w-account-actions">
                <button onClick={() => bridge?.cloud.sync()}>{t('지금 동기화')}</button>
                <button onClick={() => { setAccountOpen(false); bridge?.cloud.signOut() }}>{t('로그아웃')}</button>
              </div>
            </section>
          )}
          {cloud?.error && !cloud.user && <div className="w-card w-note-card">{cloudErrorText(cloud.error)}</div>}

          {missing.length > 0 && (
            <section className="w-card w-setup" role="alert">
              <div className="w-setup-title">{t('시작하기 전에 설치가 필요해요')}</div>
              <p className="w-setup-desc">{/* {again} is the bold button name */}
                {t('세션을 열려면 아래 프로그램이 필요해요. 설치한 뒤 {again}을 눌러주세요.').split('{again}').flatMap((s, i) => i ? [<b key={i}>{t('다시 확인')}</b>, s] : [s])}</p>
              {missing.map(([key]) => (
                <div key={key} className="w-setup-row">
                  <span className="w-setup-name">{key === 'git' && isMac() ? 'Git' : PREREQ_LABEL[key].name}</span>
                  <span className="w-setup-why">{key === 'git' && isMac() ? t('선택 사항이에요') : t(PREREQ_LABEL[key].why)}</span>
                  <button className="w-setup-go" onClick={() => bridge?.env.openLink(key)}>{t('설치 페이지')}</button>
                </div>
              ))}
              <button className="w-setup-again" onClick={recheck} disabled={checking}>{checking ? t('확인 중…') : t('다시 확인')}</button>
            </section>
          )}

          {/* The subscription's two limits: the only numbers that decide whether work can go on */}
          {/* Limits arrive with a session's status line: before any session there is nothing to wait for */}
          {/* Codex CLI's own limits (from its session log) get rows of their own; Claude's rows show
              once Claude has reported, or while a Claude session is open (they are on their way) */}
          {!showClaudeLimits && !codexRows.length ? (
            <section className="w-card w-limits idle">
              <span className="w-label">{t('사용량')}</span>
              <span className="w-limits-hint">{t('세션을 열면 5시간·주간 사용량을 볼 수 있어요')}</span>
            </section>
          ) : (
            <section className="w-card w-limits">
              {showClaudeLimits && <>
                <Limit label={t('5시간')} value={fiveHour} reset={fiveReset ? formatClockTime(fiveReset) : null} resetAt={fiveReset} />
                <Limit label={t('주간')} value={sevenDay} reset={sevenReset ? resetText(sevenReset) : null} resetAt={sevenReset} />
              </>}
              {codexRows.map(r => <Limit key={r.key} label={r.label} value={r.value} reset={r.reset} />)}
            </section>
          )}

          <section className="w-card w-launch">
            <button className="w-launch-main" onClick={() => launch(false)} title={t('문서 폴더에서 새 Claude 세션')}>
              <PlusIcon size={15} /><span className="w-launch-label">{t('새로운 세션 시작하기')}</span>
            </button>
            <button className="w-launch-alt" onClick={() => launch(true)} title={t('다른 폴더에서 새 세션')} aria-label={t('다른 폴더에서 새 세션')}><FolderIcon /></button>
            <button className="w-launch-alt" onClick={() => setPicking(true)} title={t('예전 세션 골라서 이어하기')} aria-label={t('예전 세션 이어하기')}><SessionsIcon /></button>
          </section>

          {/* 업무 모드: no Pokédex card (not drawn, so no pictures are fetched) */}
          {!workMode && <button className="w-card w-dex" onClick={() => { setView('dex'); setExpanded(true) }} title={t('도감 열기')}>
            <span className="w-label">{t('도감')}{hasNew && <span className="w-new-dot" aria-label={t('새로 잡은 포켓몬')} />}</span>
            <span className="w-dex-count"><b>{dex ? Object.keys(dex.caught).length : 0}</b><span> / {dex?.total ?? 1025}</span></span>
            <span className="w-dex-recent">
              {(dex?.log ?? []).filter(e => e.kind === 'catch').slice(-6).reverse().map((e, i) => (
                <img key={`${e.at}-${i}`} src={iconUrl(e.id)} alt={nameOf(pokemonById(e.id))} title={`${e.shiny ? '✨ ' : ''}${nameOf(pokemonById(e.id))}`} />
              ))}
            </span>
          </button>}

          <section className="w-card w-party">
            {/* The list's header: how many, 간략 / 상세, a new shell, a new session */}
            <div className="w-list-head">
              <span className="w-list-count">{t('세션 {n}', { n: rows.length })}</span>
              <span className="w-list-mode" role="group" aria-label={t('목록 보기')}>
                <button className={compact ? 'on' : ''} aria-pressed={compact} onClick={() => setListMode('compact')} title={t('한 줄씩 (많이 보기)')}>{t('간략')}</button>
                <button className={compact ? '' : 'on'} aria-pressed={!compact} onClick={() => setListMode('detail')} title={t('이름·상태·컨텍스트·모델까지')}>{t('상세')}</button>
              </span>
              <button className="w-list-btn w-list-shell" onClick={async () => { if (await openShell()) setExpanded(true) }}
                title={workMode ? t('셸 열기') : t('셸 열기 (포켓몬 없이 {shell})', { shell: shellLabel(rows) })} aria-label={t('셸 열기')}>&gt;_</button>
              <button className="w-list-btn" onClick={() => launch(false)} title={t('새로운 세션 시작하기')} aria-label={t('새로운 세션 시작하기')}><PlusIcon size={13} /></button>
            </div>
            {rows.length === 0 && <div className="w-empty">{t('새 세션을 열면 여기 나타나요')}</div>}
            <div className={`w-rows${compact ? ' compact' : ''}`} onPointerEnter={() => setOverList(true)} onPointerLeave={() => setOverList(false)}>
            {rowOrder.shown.map((sid, i) => {
              const r = rowById.get(sid)!
              const drag = rowOrder.bind(sid, i, !!r.terminal && !autoSort)
              const mon = monOf(r.sessionId)
              const parts = sessionRowParts({ title: r.title, name: r.name, project: r.project, level: mon ? levelOf(mon) : null, helpers: (dex?.helpers?.[r.sessionId] ?? []).length, noPokemon: noPokemon(r), shell: r.shell }, workMode)
              // What is left of the context window (the tick and the tooltip in 간략)
              const ctxUsed = r.meter?.context.used
              const ctxLeft = r.shell || typeof ctxUsed !== 'number' ? null : Math.max(0, Math.min(100, 100 - ctxUsed))
              const picture = parts.picture === 'shell' ? <span className="w-row-mon w-row-shell" aria-hidden="true">&gt;_</span>
                : parts.picture === 'glyph' ? <span className="w-row-mon w-row-glyph" aria-hidden="true"><TerminalIcon size={compact ? 14 : 18} /></span>
                : <img className="w-row-mon" src={r.sprite} alt="" />
              const nameEl = renaming?.id === r.sessionId && renaming.at === 'row' ? (
                <input
                  className="w-row-rename"
                  autoFocus
                  defaultValue={r.title ?? ''}
                  placeholder={t('새 세션')}
                  maxLength={40}
                  onClick={e => e.stopPropagation()}
                  onKeyDown={e => {
                    if (e.key === 'Enter' && !e.nativeEvent.isComposing) { endRename(r, e.currentTarget.value); backToRow(sid) }
                    if (e.key === 'Escape') { endRename(r); backToRow(sid) }
                  }}
                  onBlur={e => { keyRename.current = null; endRename(r, e.currentTarget.value) }}
                />
              ) : (
                <span
                  className="w-row-name"
                  title={!compact && r.terminal ? t('더블클릭해서 세션 이름 바꾸기') : undefined}
                  onDoubleClick={e => { if (!r.terminal) return; e.stopPropagation(); startRename(r.sessionId, 'row') }}
                >{r.title ?? t('새 세션')}</span>
              )
              // 확인 필요 is a button in 상세 (it opens the terminal); in 간략 a plain dot like the other
              // moods (hovered, the × takes its place, so a button there could not be pressed): the row's
              // own click opens the terminal instead
              const pill = r.mood === 'needs-you' && r.terminal && !r.shell && !compact ? (
                <button className="w-pill mood-needs-you as-button" onClick={e => { e.stopPropagation(); setTarget(r.sessionId); setView('terminal'); setExpanded(true) }} title={t('터미널에서 열기')}><i className="w-pill-dot" /><span className="w-pill-text">{t('확인 필요')}</span></button>
              ) : (
                <span className={`w-pill mood-${r.mood}`}><i className="w-pill-dot" /><span className="w-pill-text">{t(MOOD_LABEL[r.mood])}</span></span>
              )
              const closeBtn = r.terminal && (
                <button
                  className={`w-row-close${closing === r.sessionId ? ' confirm' : ''}`}
                  onClick={e => { e.stopPropagation(); closeSession(r) }}
                  onMouseLeave={() => closing === r.sessionId && setClosing(null)}
                  title={closing === r.sessionId ? t('한 번 더 누르면 세션을 닫아요') : t('세션 닫기')}
                  aria-label={t('세션 닫기')}
                >{closing === r.sessionId ? t('닫기') : '×'}</button>
              )
              // A row's click (and Enter / Space on it, focused from the keyboard): open its session
              const open = () => {
                if (!r.terminal) return
                setTarget(r.sessionId)
                if (expanded) setView('terminal')
                // 간략 in the widget: a session waiting on you opens its terminal, as 상세's 확인 필요 button does
                else if (compact && r.mood === 'needs-you' && !r.shell) { setView('terminal'); setExpanded(true) }
              }
              return (
              <div
                key={r.sessionId}
                ref={el => { drag.ref(el); if (el) rowEls.current.set(sid, el); else rowEls.current.delete(sid) }}
                style={rowOrder.style(sid, i)}
                onPointerDown={drag.onPointerDown}
                onPointerMove={drag.onPointerMove}
                onPointerUp={drag.onPointerUp}
                onPointerCancel={drag.onPointerCancel}
                className={`w-row${rowOrder.stateClass(sid)} mood-${r.mood}${r.terminal?.status === 'running' && r.terminal.asking ? ' asking' : ''}${shown?.sessionId === r.sessionId ? ' chosen' : ''}`}
                // (2026-11-17) dragged onto the right side, or Ctrl+clicked: the session opens in a tab of its own
                // (with 자동 정렬 on the rows do not reorder by dragging, so the drag is free for this)
                draggable={!!r.terminal && autoSort && expanded}
                onDragStart={e => { if (!r.terminal) return; e.dataTransfer.setData(SESSION_MIME, r.sessionId); e.dataTransfer.effectAllowed = 'copy' }}
                onDragEnd={() => setDropHint(null)}
                onClick={e => { if ((e.ctrlKey || e.metaKey) && r.terminal && expanded) { e.preventDefault(); openInTab(r.sessionId); return } rowOrder.click(open)() }}
                // The keyboard and screen readers: a row is a button (Tab reaches it, Enter / Space
                // open it, F2 renames it), the one in view is the current one, and its name says
                // the session's name and status (간략 shows only the status's dot)
                role={r.terminal ? 'button' : undefined}
                tabIndex={r.terminal ? 0 : undefined}
                aria-current={r.terminal && shown?.sessionId === r.sessionId ? 'true' : undefined}
                aria-label={rowLabel({ title: r.title, mood: MOOD_LABEL[r.mood], left: ctxLeft, barLabel: parts.barLabel }, t)}
                onKeyDown={e => {
                  if (e.target !== e.currentTarget || !r.terminal) return
                  const act = rowKeyAction(e.key, e.nativeEvent.isComposing)
                  if (!act) return
                  e.preventDefault()
                  if (act === 'open') open()
                  else { keyRename.current = sid; startRename(r.sessionId, 'row') }
                }}
                title={compact ? rowTooltip({ title: r.title, mood: MOOD_LABEL[r.mood], left: ctxLeft, barLabel: parts.barLabel, renamable: !!r.terminal }, t) : r.terminal ? t('눌러서 이 세션 열기') : undefined}
              >
                {compact ? (
                  // 간략: one line — picture, name, the context tick (colour only), the status dot;
                  // hovered, the × takes the dot's place. The rest is in the tooltip
                  <div className="w-row-head">
                    {picture}
                    <div className="w-row-line1">
                      {nameEl}
                      {!r.shell && <span className={`w-row-tick ${hpTone(ctxLeft)}`} aria-hidden="true" />}
                      <span className="w-row-state">{pill}{closeBtn}</span>
                    </div>
                  </div>
                ) : <>
                {/* Line 1: the session's name, the sub-agents' helpers and its status; line 2: Lv first, then folder,
                    AI tool and branch (the branch gives way first). The buttons float over
                    line 2's end on hover instead of holding space the name needs */}
                <div className="w-row-head">
                  {picture}
                  <div className="w-row-line1">
                    {nameEl}
                    {/* the sub-agents' helpers: on line 1, before the status, where the hover buttons (line 2's end)
                        never cover them (2026-11-17; they sat at line 2's end until then) */}
                    {parts.helpers && (
                      <span className="w-row-helpers" title={t('서브에이전트를 돕는 조력자 (박스에서 나와요)')}>
                        {dex!.helpers![r.sessionId].slice(0, 3).map(uid => { const h = dex!.mons[uid]; return h ? <img key={uid} src={iconUrl(h.dex)} alt={nameOf(pokemonById(h.dex))} title={`${t('조력자')} · ${nameOf(pokemonById(h.dex))} Lv.${levelOf(h)}`} /> : null })}
                        {dex!.helpers![r.sessionId].length > 3 && <small>+{dex!.helpers![r.sessionId].length - 3}</small>}
                      </span>
                    )}
                    {r.shell ? null : pill}
                  </div>
                  <div className="w-row-line2">
                    {parts.level !== null && <span className="w-row-lv" title={t('함께 일한 시간으로 레벨이 올라요 (처음엔 20분, 높은 레벨은 60분마다)')}>Lv.{parts.level}</span>}
                    <span className="w-row-meta">
                      {parts.label && <span className="w-row-project">{parts.label}</span>}
                      {r.terminal?.tool && r.terminal.tool !== 'claude' && <span className="w-row-tool" title={t('이 세션에서 도는 AI 도구')}>{r.terminal.toolName}</span>}
                      {r.branch && <span className="w-row-branch" title={t('git 브랜치')}>{r.branch}</span>}
                    </span>
                    {(r.terminal || monOf(r.sessionId)) && (
                      <span className="w-row-tools">
                        {r.terminal && renaming?.id !== r.sessionId && (
                          <button className="w-row-edit" onClick={e => { e.stopPropagation(); startRename(r.sessionId, 'row') }} title={t('세션 이름 바꾸기')} aria-label={t('세션 이름 바꾸기')}>✎</button>
                        )}
                        {parts.swap && (
                          <button className="w-row-swap" onClick={e => { e.stopPropagation(); setSwapFor(r.sessionId) }} title={t('교체: 이 세션에서 일할 포켓몬을 바꿔요')} aria-label={t('교체')}><SwapIcon size={13} /></button>
                        )}
                        {closeBtn}
                      </span>
                    )}
                  </div>
                </div>
                {!r.shell && <div className="w-row-bottom">
                  {(() => {
                    // The context window as the session's HP: what is left, draining like a Pokémon's
                    // (green, amber at half and under, red at a fifth and under: hpTone); the number is the tokens left.
                    // 업무 모드: the same bar, labelled 컨텍스트
                    const used = r.meter?.context.used
                    const size = r.meter?.context.size ?? null
                    const left = typeof used === 'number' ? Math.max(0, Math.min(100, 100 - used)) : null
                    const leftTokens = left !== null && size ? Math.round((size * left) / 100) : null
                    const tip = left === null ? t('남은 컨텍스트')
                      : leftTokens !== null ? t('남은 컨텍스트 {left} / {size} ({pct}%)', { left: tokens(leftTokens), size: tokens(size!), pct: Math.round(left) })
                      : t('남은 컨텍스트 {pct}%', { pct: Math.round(left) })
                    const m = modelLabel(r.meter?.model, r.session?.model)
                    return <>
                      <span className="w-hp-label" aria-hidden="true">{parts.barLabel === 'HP' ? 'HP' : t(parts.barLabel)}</span>
                      <div className={`w-ctx w-hp ${hpTone(left)}`} title={tip} role="meter" aria-valuenow={left ?? 100} aria-valuemin={0} aria-valuemax={100} aria-label={tip}>
                        <span style={{ width: `${left ?? 100}%` }} />
                      </div>
                      {/* (fixed columns, always there: every row's HP bar the same length whatever its model or number, 2026-11-17) */}
                      <span className="w-row-model" title={m ? r.meter?.modelId ?? r.session?.model : undefined}>{m ?? ''}</span>
                      <span className="w-row-num" title={tip}>{leftTokens !== null ? tokens(leftTokens) : left !== null ? `${Math.round(left)}%` : '—'}</span>
                    </>
                  })()}
                </div>}
                {/* Window mode: a session waiting on the trainer while its terminal is not in view
                    says so in its row (its Pokémon hops). A permission is answered right here; a
                    question with choices opens its terminal, where the choices can be read. No
                    terminal in the row: one that narrow resized the session and squeezed its dialog */}
                {expanded && r.terminal?.status === 'running' && (r.terminal.asking || r.mood === 'needs-you')
                  && !(view === 'terminal' && shown?.sessionId === r.sessionId) && (() => {
                  const ny = r.session?.main?.needsYou
                  const permission = r.mood === 'needs-you' && ny?.kind === 'permission'
                  const what = permission
                    ? [ny?.toolName, ny?.summary].filter(Boolean).join(' · ') || t('도구를 써도 될지 물어요')
                    : ny?.message || t('질문에 답을 기다려요')
                  const open = () => { setTarget(r.sessionId); setView('terminal') }
                  return (
                    <div className="w-row-ask" onClick={e => e.stopPropagation()}>
                      <div className="w-row-ask-what" title={what}>{what}</div>
                      <div className="w-row-ask-actions">
                        {permission && <>
                          <button className="w-ask-quick yes" onClick={() => bridge?.terminals.write(r.terminal!.id, '\r')} title={t('허용해요 (Enter)')}>{t('허용 (Enter)')}</button>
                          <button className="w-ask-quick" onClick={() => bridge?.terminals.write(r.terminal!.id, '\x1b')} title={t('거절하거나 그만둬요 (Esc)')}>{t('거절 (Esc)')}</button>
                        </>}
                        <button className={`w-ask-quick${permission ? ' quiet' : ' yes'}`} onClick={open}>{permission ? t('터미널에서 보기') : t('터미널에서 답하기')}</button>
                      </div>
                    </div>
                  )
                })()}
                </>}
              </div>
            ) })}
            </div>
          </section>

          {/* A question Claude Code cannot go on without (folder trust, a permission):
              in widget mode its terminal opens right here, small, until it is answered */}
          {askRow?.terminal && (
            <section className="w-card w-ask" role="alert">
              <div className="w-ask-head">
                <span className="w-ask-dot" />
                <b>{sessionLabel({ ...askRow, noPokemon: noPokemon(askRow) }, workMode) ?? t('새 세션')}</b>
                <span>{t('의 확인이 필요해요')}</span>
                <button className="w-ask-open" onClick={() => { setTarget(askRow.sessionId); setView('terminal'); setMode('window') }} title={t('창 모드로 펼쳐서 보기')}>{t('펼치기')}</button>
              </div>
              <div className="w-ask-term">
                <Suspense fallback={null}><TerminalView key={`ask-${askRow.terminal.id}`} term={askRow.terminal} active /></Suspense>
              </div>
              <div className="w-ask-hint">{t('↑↓로 고르고 Enter, 그만두려면 Esc')}</div>
            </section>
          )}

          {/* A note (a launch that failed, the login started): its own card at the panel's foot */}
          {note && (
            <section className="w-card w-compose">
              <div className="w-note" role="status" onClick={() => setNote(null)} title={t('눌러서 닫기')}>{note}</div>
            </section>
          )}
        </div>
        {expanded && !folded && <SideResize width={sideWidth} min={sideLow} max={sideMax} onWidth={setSideWidth} onDragging={setSideDragging} />}
      </div>

      {expanded && (
        <section className="w-card w-term">
          <div className="w-term-tabs" ref={viewBarRef}>
            {/* The views: icon and name, the names dropped only while the bar is too narrow for them */}
            <div className={`w-view-switch w-view-tabs${viewsCompact ? ' w-view-icons' : ''}`}>
              <button className={`${viewsCompact ? 'icon-only' : ''}${view === 'terminal' ? ' on' : ''}`} onClick={() => setView('terminal')} title={t('세션 ({key})', { key: modCombo('1') })} aria-label={t('세션')}><TerminalIcon size={14} />{!viewsCompact && t('세션')}</button>
              {/* 업무 모드: the sessions view alone (src/workMode.ts visibleViews) */}
              {!workMode && <>
              <button className={`${viewsCompact ? 'icon-only' : ''}${view === 'dex' ? ' on' : ''}`} onClick={() => setView('dex')} title={t('도감 ({key})', { key: modCombo('2') })} aria-label={t('도감')}><DexIcon size={14} />{!viewsCompact && t('도감')}{hasNew && <span className="w-new-dot" aria-label={t('새로 잡은 포켓몬')} />}</button>
              <button className={`${viewsCompact ? 'icon-only' : ''}${view === 'box' ? ' on' : ''}`} onClick={() => setView('box')} title={t('박스 ({key})', { key: modCombo('3') })} aria-label={t('박스')}><BoxIcon size={14} />{!viewsCompact && t('박스')}</button>
              <button className={`${viewsCompact ? 'icon-only' : ''}${view === 'today' ? ' on' : ''}`} onClick={() => setView('today')} title={t('기록 ({key})', { key: modCombo('4') })} aria-label={t('기록')}><TodayIcon size={14} />{!viewsCompact && t('기록')}</button>
              <button className={`${viewsCompact ? 'icon-only' : ''}${view === 'rank' ? ' on' : ''}`} onClick={() => setView('rank')} title={t('랭킹 ({key})', { key: modCombo('5') })} aria-label={t('랭킹')}><RankIcon size={14} />{!viewsCompact && t('랭킹')}</button>
              </>}
            </div>
            <span className="w-term-spacer" />
            {/* the split view: 보기 정도 and 채팅 · 터미널 are the app's, not a pane's, so they sit here once (the pane
                headers keep their names readable) */}
            {split && lens.show && (
              <div className="w-split-tools">
                {lensMode === 'chat' && <Suspense fallback={null}><DensityMenu /></Suspense>}
                <LensSwitch lens={{ mode: lensMode, enabled: lens.enabled, reason: lens.reason, onMode: setLens }} />
              </div>
            )}
            {updateButton}
            {/* The widget on and off: here it turns the widget on (the widget's ⇤ turns it off again); left of the text size.
                The last thing to give way in a narrow window (the tray reaches the widget too) */}
            {barLevel < 3 && <button className="w-icon w-widget-toggle" onClick={() => setMode('widget')} title={t('위젯으로 작게 (항상 위)')} aria-label={t('위젯 모드 켜기')}><WidgetModeIcon size={15} /></button>}
            {/* The one text size (src/textSize.ts): lists, panels and the terminal together, on every view;
                folded to one 가 button when the bar is narrow */}
            <TextSizeControl compact={barLevel >= 2} />
            {/* As Windows users know them: minimize, maximize/restore (window ↔ full screen), close */}
            <div className="w-win-controls">
              <button className="w-icon" onClick={() => bridge?.widget.minimize()} title={t('최소화')} aria-label={t('최소화')}><MinimizeIcon size={14} /></button>
              {mode === 'fullscreen'
                ? <button className="w-icon" onClick={() => setMode('window')} title={t('창 모드로')} aria-label={t('창 모드로')}><RestoreIcon size={14} /></button>
                : <button className="w-icon" onClick={() => setMode('fullscreen')} title={t('전체화면')} aria-label={t('전체화면')}><MaximizeIcon size={14} /></button>}
              <button className="w-icon w-win-close" onClick={() => bridge?.widget.hide()} title={isMac() ? t('닫기 ({tray} 아이콘을 누르면 다시 열려요. 세션은 계속 돌아가요)', { tray: t(platformWord('tray', true)) }) : t('닫기 (트레이 아이콘을 누르면 다시 열려요. 세션은 계속 돌아가요)')} aria-label={t('닫기')}><CloseIcon size={14} /></button>
            </div>
          </div>
          {/* Which session is open (the left list or the rail switches them): its picture, name,
              branch and project; rename and close here too. The bar keeps its height with none */}
          {view === 'terminal' && split && (
            <div className="w-sess-bar split">
              {paneSids.map(sid => {
                const r = rowById.get(sid)!
                const on = sid === shown?.sessionId
                return (
                  <div key={sid} className={`w-pane-head${on ? ' on' : ''}`} onPointerDown={() => focusPane(sid)}>
                    <SessionHeader
                      parts={sessionHeaderParts({ ...r, noPokemon: noPokemon(r) }, workMode)}
                      sprite={r.sprite}
                      cwd={r.session?.cwd ?? r.terminal?.cwd}
                      renaming={renaming?.id === sid && renaming.at === 'header'}
                      onRenameStart={() => startRename(sid, 'header')}
                      onRenameCommit={value => endRename(r, value)}
                      onRenameCancel={() => endRename(r)}
                      closing={false}
                      onClose={() => closeTabOf(sid)}
                      onCloseCancel={() => {}}
                      paneClose
                    />
                  </div>
                )
              })}
            </div>
          )}
          {view === 'terminal' && !split && (
            <div className="w-sess-bar">
              {shown?.terminal && (
                <SessionHeader
                  parts={sessionHeaderParts({ ...shown, noPokemon: noPokemon(shown) }, workMode)}
                  sprite={shown.sprite}
                  cwd={shown.session?.cwd ?? shown.terminal.cwd}
                  renaming={renaming?.id === shown.sessionId && renaming.at === 'header'}
                  onRenameStart={() => startRename(shown.sessionId, 'header')}
                  onRenameCommit={value => endRename(shown, value)}
                  onRenameCancel={() => endRename(shown)}
                  closing={closing === shown.sessionId}
                  onClose={() => closeSession(shown)}
                  onCloseCancel={() => setClosing(null)}
                  lens={lens.show ? { mode: lensMode, enabled: lens.enabled, reason: lens.reason, onMode: setLens } : undefined}
                  // the chat's own tools, only while the chat is shown: 보기 정도, then 변경 사항
                  tabs={tabs.length >= 2 ? tabs.map(sid => {
                    const r = rowById.get(sid)
                    const p = r ? sessionHeaderParts({ ...r, noPokemon: noPokemon(r) }, workMode) : null
                    return { sid, name: p?.name ?? t('새 세션'), sprite: r?.sprite ?? '', picture: p?.picture ?? 'glyph', title: r?.project, mood: r?.mood }
                  }) : undefined}
                  activeTab={shown.sessionId}
                  onTab={sid => { shownTab.current = sid; setTarget(sid) }}
                  onTabClose={closeTabOf}
                  chatTools={lensMode === 'chat' && lens.show ? (
                    <Suspense fallback={null}>
                      <DensityMenu />
                      <ChangesButton id={shown.terminal.id} open={changesOpen} enabled={changesRoom} onToggle={toggleChanges} />
                    </Suspense>
                  ) : undefined}
                />
              )}
            </div>
          )}
          <Suspense fallback={null}>
            {view === 'dex' && <div className="w-dex-body"><PokedexView /></div>}
            {view === 'box' && <div className="w-dex-body"><BoxView /></div>}
            {view === 'today' && <div className="w-dex-body"><TodayLog /></div>}
            {view === 'rank' && <div className="w-dex-body"><LeaderboardView /></div>}
          </Suspense>
          {/* (the 변경 사항 panel's width for the chat pane and the panel; folded for it, the terminals keep the box they
              had with the left panel open: --fold-pad, so a terminal fitted under the chat gets the size it will be shown at) */}
          <div className="w-term-body" style={{ display: view === 'terminal' ? undefined : 'none', ...(chPanel ? { '--ch-w': `${chWidth}px` } : {}), ...(foldNow ? { '--fold-pad': `${Math.max(0, sideWidth - RAIL_W)}px` } : {}) } as React.CSSProperties}
            // a session dragged from the left list: where it would go, said while it is over the right side
            onDragOver={e => {
              if (!e.dataTransfer.types.includes(SESSION_MIME)) return
              e.preventDefault()
              e.dataTransfer.dropEffect = 'copy'
              const hint = tabs.length < MAX_TABS ? t('놓으면 옆에 나란히 열려요 ({n}/{max})', { n: tabs.length + 1, max: MAX_TABS }) : t('나란히 볼 칸이 가득 찼어요 ({max}/{max})', { max: MAX_TABS })
              if (hint !== dropHint) setDropHint(hint)
            }}
            onPointerDownCapture={split ? e => {
              const box = e.currentTarget.getBoundingClientRect()
              const i = Math.floor(((e.clientX - box.left) / Math.max(1, box.width)) * paneSids.length)
              const sid = paneSids[Math.max(0, Math.min(paneSids.length - 1, i))]
              if (sid) focusPane(sid)
            } : undefined}
            onDragLeave={e => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDropHint(null) }}
            onDrop={e => {
              const sid = e.dataTransfer.getData(SESSION_MIME)
              if (!sid) return
              e.preventDefault()
              setDropHint(null)
              openInTab(sid)
            }}>
            {dropHint && <div className={`w-tab-drop${tabs.length >= MAX_TABS ? ' full' : ''}`} aria-hidden="true"><span>{dropHint}</span></div>}
            {tabNote && <div className="w-tab-note" role="status">{tabNote}</div>}
            {withTerminal.length === 0 && (
              <div className="w-term-empty">
                <p>{t('아직 터미널이 없어요')}</p>
                <button className="w-launch-main" onClick={() => launch(false)}><PlusIcon size={15} /> {t('새로운 세션 시작하기')}</button>
                <button className="w-launch-alt wide" onClick={() => setPicking(true)}><SessionsIcon /> {t('예전 세션 이어하기')}</button>
              </div>
            )}
            <Suspense fallback={null}>
              {withTerminal.map(r => {
                if (!r.terminal) return null
                // 7-48: the shown chat session's terminal is active, never focused, under the opaque chat pane
                // until it has fitted once (src/chat/termWarm.ts); in terminal mode `warm` is always false
                const warm = lensMode === 'chat' && view === 'terminal' && r.sessionId === shown?.sessionId && warmNeeded(r.terminal.id)
                const pane = split ? paneSids.indexOf(r.sessionId) : -1
                const active = split
                  ? (view === 'terminal' && pane >= 0 && effectiveMode(r.terminal, mode, lensAll) === 'terminal') || warm
                  : (view === 'terminal' && shown?.sessionId === r.sessionId && !(r.sessionId === shown?.sessionId && lensMode === 'chat')) || warm
                // (first render only: whether its xterm fits before the replay arrives; only where this terminal
                // offers the chat, so with the chat off nothing of termWarm runs)
                if (lensAvailability(r.terminal, mode).show) noteMount(r.terminal.id, { active, visible: document.visibilityState === 'visible' })
                return <TerminalView key={r.terminal.id} term={r.terminal} active={active} focus={warm || (split && r.sessionId !== shown?.sessionId) ? false : undefined} slot={pane >= 0 ? paneStyle(pane, paneSids.length) : undefined} />
              })}
            </Suspense>
            {split && paneSids.map((sid, i) => {
              const r = rowById.get(sid)
              if (!r?.terminal || effectiveMode(r.terminal, mode, lensAll) !== 'chat') return null
              const ref = paneRef(sid)
              const paneWho = sid === shown?.sessionId ? who : chatWho({ name: r.name ?? '', sprite: r.sprite ?? '', art: sessionArt(sid), noPokemon: noPokemon(r) }, workMode)
              const onTerm = () => { focusPane(sid); toTerminal() }
              return (
                <div key={sid} className={`w-chat-pane split${sid === shown?.sessionId ? ' on' : ''}`} style={{ ...paneStyle(i, paneSids.length), right: 'auto' }} onPointerDownCapture={() => focusPane(sid)}>
                  <ChatBoundary key={r.terminal.id} onTerminal={onTerm}>
                    <Suspense fallback={null}>
                      <ChatView
                        key={r.terminal.id}
                        term={r.terminal}
                        who={paneWho}
                        project={r.project}
                        branch={r.branch ?? null}
                        onTerminal={onTerm}
                        onStop={() => ref.current?.stop()}
                        workMode={workMode}
                        onHelp={openChatHelp}
                        footer={<Suspense fallback={null}><Composer key={r.terminal.id} term={r.terminal} who={paneWho} onTerminal={onTerm} control={sid === shown?.sessionId ? chatControl : controlOf(r)} focusRef={ref} /></Suspense>}
                      />
                    </Suspense>
                  </ChatBoundary>
                </div>
              )
            })}
            {split && <div className="w-pane-lines" aria-hidden="true">{paneSids.slice(1).map((sid, i) => <i key={sid} style={{ left: paneStyle(i + 1, paneSids.length).left }} />)}</div>}
            {!split && lensMode === 'chat' && view === 'terminal' && shown?.terminal && (
              <div className="w-chat-pane">
                <ChatBoundary key={shown.terminal.id} onTerminal={toTerminal}>
                  <Suspense fallback={null}>
                    <ChatView
                      key={shown.terminal.id}
                      term={shown.terminal}
                      who={who}
                      project={shown.project}
                      branch={shown.branch ?? null}
                      onTerminal={toTerminal}
                      onStop={stopChat}
                      onChanges={changesRoom ? openChangesAt : undefined}
                      workMode={workMode}
                      onHelp={openChatHelp}
                      footer={<Suspense fallback={null}><Composer key={shown.terminal.id} term={shown.terminal} who={who} onTerminal={toTerminal} control={chatControl} focusRef={composerRef} /></Suspense>}
                    />
                  </Suspense>
                </ChatBoundary>
              </div>
            )}
            {/* 변경 사항 (Phase 5): the chat area's right column, after the conversation and its composer (DOM order = visual order) */}
            {chPanel && shown?.terminal && (
              <ChatBoundary key={`changes:${shown.terminal.id}`} onTerminal={toTerminal} where="w-ch-failed">
                {/* (while its code loads, its column is already the panel's grey: nothing under the chat shows through) */}
                <Suspense fallback={<div className="w-ch-wait" aria-hidden="true" />}>
                  <ChangesPanel key={shown.terminal.id} id={shown.terminal.id} width={chWidth} max={chMax} onWidth={setChangesWidth} onClose={() => setChangesOpen(false)} target={chTarget} />
                </Suspense>
              </ChatBoundary>
            )}
          </div>
        </section>
      )}

      {/* 업무 모드: no "who goes?" pickers (sendOut picks), no Pokémon beside past sessions, and
          the after-update notes wait until it is off (they may speak of the game) */}
      {swapFor && dex && !workMode && (
        <SwapPicker dex={dex} currentDex={monOf(swapFor)?.dex ?? 0} onPick={uid => doSwap(swapFor, uid)} onClose={() => setSwapFor(null)} />
      )}
      {picking && <Suspense fallback={null}><ResumePicker onPick={resume} onClose={() => setPicking(false)} openIds={openIds}
        monFor={workMode ? undefined : (sid) => { const uid = dex?.remembered?.[sid]; const m = uid ? dex?.mons?.[uid] : undefined; return m ? { src: spriteUrl(m.dex, m.shiny), name: nameOf(pokemonById(m.dex)) } : null }} /></Suspense>}
      {throwing && dex && !workMode && (
        <ThrowPicker dex={dex} resume={!!throwing.resume} tools={throwing.resume ? [] : sessionTools(settings.session).tools} defaultTool={sessionTools(settings.session).defaultTool}
          onPick={(uid, tool) => openSession({ ...throwing, ...(tool && tool !== 'claude' ? { tool } : {}) }, uid)} onClose={() => setThrowing(null)} />
      )}
      {!workMode && <PatchNotes />}
      {notesOpen && !workMode && <PatchNotesHistory onClose={() => setNotesOpen(false)} />}
      {feedbackOpen && <FeedbackPin view={expanded ? view : 'widget'} onClose={closeFeedback} />}
      {settingsOpen && <SettingsView at={settingsAt} onClose={() => { setSettingsOpen(false); setSettingsAt(undefined) }} version={update?.current} onFeedback={() => { setSettingsOpen(false); setSettingsAt(undefined); setFeedbackOpen(true) }} />}
      {mode === 'widget' && <ResizeGrip />}
    </div>
  )
}

export default Widget
