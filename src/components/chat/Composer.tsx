/**
 * The chat composer (Phase 3; the lab's `composerHtml`): under the conversation of a Claude
 * Code session shown as 채팅, it sends what the user writes into that session's real
 * terminal (src/chat/send.ts: typed without Enter, Enter only after the echo; main checks
 * everything again). Multiline; Enter sends, Shift+Enter breaks the line; an IME's keys are
 * its own (src/chat/composerKeys.ts). Images by paste, drop or the + picker: main keeps the
 * file, the page shows a chip. Above the box, what Claude Code queued; under it, a quiet,
 * display-only control row.
 *
 * Whenever a send does not go, it says why and offers the terminal; nothing is retried. The
 * textarea is never `disabled` (that would blur it and cut a syllable): while a send runs it
 * is aria-busy and Enter waits; an ended session makes it read-only.
 *
 * The draft and the chips live per terminal in this module (they survive a flip, a session
 * switch and a remount; never on disk).
 */

import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { TerminalInfo } from '../../desktop'
import { bridge } from '../../desktop'
import { josa, t } from '../../i18n'
import { useWorkMode } from '../../settingsStore'
import { termDim, termText } from '../../termMetrics'
import { footerMode, promptRow, suggestionOf, type FooterMode } from '../../chat/promptRow'
import { parseDialog } from '../../chat/dialog'
import { switchMode } from '../../chat/modeSwitch'
import { clearPromptRow } from '../../chat/clearRow'
import { createImeTracker, keyAction, mentionAt } from '../../chat/composerKeys'
import { onChatForget, takeChatFocus, type ChatWho } from '../../chat/lensMode'
import { baselineOf, outboxFor } from '../../chat/outbox'
import { isCommandText, newSendId, sendDraft, type SendDeps } from '../../chat/send'
import { useChat, type ChatState } from '../../chat/store'
import { cardNote, shownCard } from '../../chat/answer'
import type { ImageRefusal, InterruptRefusal, SendRefusal, SubmitRefusal } from '../../chat/types'
import { ControlRow, type ComposerControl } from './ControlRow'
import { ImageChips, type Chip } from './ImageChips'
import { FileChips } from './FileChips'
import { withRefs } from '../../chat/mentions'
import { continueList } from '../../chat/lists'
import { QueueStrip } from './QueueStrip'
import { AtIcon, PlusIcon, SendUpIcon } from './ChatIcons'
import { MENU_ROWS, MentionMenu } from './MentionMenu'
import { useChatContext } from './context'
import { isTypingTarget } from './ChatList'

/** Where the card the composer waits behind stands (src/chat/answer.ts cardNote) */
type CardNote = ReturnType<typeof cardNote>

export type { ComposerControl } from './ControlRow'

/** What the view and the side panel may ask of the composer */
export interface ComposerHandle {
  /** take the focus (the user's own flip or switch); false when there is no textarea */
  focus(): boolean
  /** 멈추기: one Esc into the session while it works */
  stop(): void
  /** put text into the draft at the caret (never sends) */
  insertText(text: string): void
}

type ChatBridge = NonNullable<typeof bridge>['chat']
export interface ComposerDeps {
  chat: (Pick<ChatBridge, 'send' | 'submit' | 'interrupt' | 'image' | 'dropImage' | 'files'> & Partial<Pick<ChatBridge, 'stranded' | 'cycleMode' | 'dialogKey'>>) | null
  termText(id: string): string | null
  /** (1.6.2) the same lines' dim marks; absent: none (the ledger decides in main) */
  termDim?(id: string): string | null
  now(): number
  sleep(ms: number): Promise<void>
}

/** row: words left on the terminal's prompt row stopped the send; the note offers to take them or clear them (2026-11-17) */
export interface Note { key: string; vars?: Record<string, string | number>; terminal?: boolean; image?: true; row?: string }

export interface ComposerProps {
  term: TerminalInfo
  who: ChatWho
  onTerminal(): void
  control: ComposerControl
  focusRef?: React.MutableRefObject<ComposerHandle | null>
  /** a fixed conversation (the QA page); otherwise the session's own */
  state?: ChatState
  deps?: Partial<ComposerDeps>
  /** the QA page: a note already shown, a draft and chips already there */
  preview?: { note?: Note; text?: string; chips?: Chip[] }
}

const ESC_AFTER_MENU_MS = 600
/** how often the empty composer looks for Claude Code's next-prompt suggestion on the terminal's row */
const SUGGEST_POLL_MS = 700
const MAX_CHARS = 20_000
const MAX_IMAGES = 8
const MAX_MB = 10
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp'])

const drafts = new Map<string, string>()
const chipsOf = new Map<string, Chip[]>()
/** the permission modes each session's Shift+Tab cycle was seen to lack (the mode menu greys them) */
const lacksOf = new Map<string, Set<FooterMode>>()
/** the files picked from the @ menu, per session: badges, not text; sent as `@path` before the message */
const refsOf = new Map<string, string[]>()
const chipSeq = new Map<string, number>()
const revoke = (url: string) => { try { URL.revokeObjectURL(url) } catch { /* not a page */ } }
onChatForget(id => {
  drafts.delete(id)
  for (const c of chipsOf.get(id) ?? []) revoke(c.url)
  chipsOf.delete(id)
  refsOf.delete(id)
  chipSeq.delete(id)
})

const nameVars = (name: string) => ({ name, iga: josa(name, '이가') })

/** What the composer says for a send that did not go (`card`: where the card above it stands, review M8) */
/** The start of what is on the terminal's prompt row, for a note: one line, at most 24 characters */
function rowQuote(row: string): string {
  const one = row.replace(/\s+/g, ' ').trim()
  const cut = [...one]
  return cut.length > 24 ? `${cut.slice(0, 24).join('').trimEnd()}…` : one
}

function refusalNote(reason: SendRefusal | SubmitRefusal | InterruptRefusal, who: ChatWho, card: CardNote = null, row?: string): Note | null {
  switch (reason) {
    // a card above the composer waits for its answer (Phase 4): it points there when it can be answered
    // there, to the terminal when only the terminal can, and says so while an answer sent is being worked on
    case 'waiting':
      if (card === 'here') return { key: '{name}{iga} 답을 기다리고 있어요. 위 카드에서 먼저 답해 주세요', vars: nameVars(who.name) }
      if (card === 'sent') return { key: '보낸 답을 {name}{iga} 처리하는 중이에요. 끝나면 보낼 수 있어요', vars: nameVars(who.name), terminal: true }
      if (card === 'terminal') return { key: '{name}{iga} 답을 기다리고 있어요. 터미널에서 먼저 답해 주세요', vars: nameVars(who.name), terminal: true }
      return { key: '{name}{iga} 답을 기다리고 있어요. 먼저 답해 주세요', vars: nameVars(who.name), terminal: true }
    // (1.6.2) what is there, quoted: the terminal is hidden behind the chat, so the note shows it
    // (2026-11-17: the note offers to take those words into this box, or to clear them and send: never the terminal)
    case 'prompt-busy': case 'prompt-unknown': return row?.trim()
      ? { key: 'Claude Code 입력란에 쓰던 글이 남아 있어요: “{text}”', vars: { text: rowQuote(row) }, row }
      : reason === 'prompt-busy'
        ? { key: 'Claude Code 입력란에 쓰던 글이 남아 있어요', row: '' }
        : { key: 'Claude Code 입력란 상태를 알 수 없어요', row: '' }
    case 'sending': case 'duplicate': case 'not-in-flight': return { key: '앞의 메시지를 보내는 중이에요' }
    case 'no-session': return { key: '세션이 끝나서 보낼 수 없어요', terminal: true }
    case 'too-long': return { key: '너무 길어요 (최대 {n}자)', vars: { n: MAX_CHARS.toLocaleString() } }
    case 'images': return { key: '이미지를 붙이지 못했어요. 다시 붙여 주세요' }
    case 'not-working': return { key: '멈출 작업이 없어요' }
    case 'empty': case 'debounced': return null
    // screen, off, unarmed, not-claude, no-echo: the terminal's state is not certain
    default: return { key: '터미널이 지금 입력을 받을 수 있는지 확인하지 못했어요', terminal: true }
  }
}

/** (an image's refusal is marked so the next image that does attach clears it: never a "couldn't" beside a chip that is there) */
function imageNote(reason: ImageRefusal): Note {
  if (reason === 'type') return { key: 'PNG, JPEG, GIF, WebP 이미지만 붙일 수 있어요', image: true }
  if (reason === 'size') return { key: '이미지가 너무 커요 (최대 {n}MB)', vars: { n: MAX_MB }, image: true }
  if (reason === 'limit') return { key: '이 세션에 붙인 이미지가 너무 많아요. 새 세션에서 붙여 주세요', image: true }
  if (reason === 'io') return { key: '이미지를 저장하지 못했어요', image: true }
  return { key: '이미지를 붙이지 못했어요. 다시 붙여 주세요', image: true }
}

/**
 * The files a paste or a drop carries (a screenshot pasted comes as an item of kind file). A paste
 * that also carries text (cells copied from Excel or Sheets, text from Word or PowerPoint: the
 * clipboard holds a picture of it too) is the text only; the picture comes in when there is no text.
 */
export function filesOf(dt: DataTransfer | null, paste = false): File[] {
  if (!dt) return []
  if (paste) { try { if (dt.getData('text/plain').trim()) return [] } catch { /* no text */ } }
  const files = Array.from(dt.files ?? [])
  if (files.length) return files
  return Array.from(dt.items ?? []).filter(i => i.kind === 'file').map(i => i.getAsFile()).filter((f): f is File => !!f)
}

export const Composer: React.FC<ComposerProps> = ({ term, who, onTerminal, control, focusRef, state: fixed, deps, preview }) => {
  const id = term.id
  const ctx = useChatContext()
  const workMode = useWorkMode()
  const live = useChat(fixed ? null : id)
  const { status, items } = fixed ?? live
  const chat = deps?.chat !== undefined ? deps.chat : bridge?.chat ?? null
  const [text, setText] = useState(() => preview?.text ?? drafts.get(id) ?? '')
  const [chips, setChips] = useState<Chip[]>(() => preview?.chips ?? chipsOf.get(id) ?? [])
  const [refs, setRefs] = useState<string[]>(() => refsOf.get(id) ?? [])
  const [note, setNote] = useState<Note | null>(preview?.note ?? null)
  const [busy, setBusy] = useState(false)
  // shell mode: a `!` typed into the empty draft, as in Claude Code; the command is sent as `!command` (bash mode)
  const [shell, setShell] = useState(false)
  useEffect(() => { setShell(false) }, [id])
  const sending = useRef(false)
  const ta = useRef<HTMLTextAreaElement>(null)
  const picker = useRef<HTMLInputElement>(null)
  const ime = useMemo(() => createImeTracker(), [])
  const noteTimer = useRef<ReturnType<typeof setTimeout>>()
  useEffect(() => () => clearTimeout(noteTimer.current), [])
  const ended = term.status === 'exited'
  const working = status?.state === 'working'
  // the @ menu: the mention at the caret, its files (null: not asked yet), the row chosen; one dismissed stays shut
  const [mention, setMention] = useState<{ start: number; query: string } | null>(null)
  const [menuFiles, setMenuFiles] = useState<string[] | null>(null)
  const [sel, setSel] = useState(0)
  const dismissed = useRef<number | null>(null)
  const listId = `chat-mention-${id}`
  const menuOpen = !!mention && menuFiles !== null

  const setDraft = (v: string) => { drafts.set(id, v); setText(v) }
  const look = () => {
    const el = ta.current
    if (!el || ime.composing() || !chat) { setMention(null); return }
    const m = el.selectionStart === el.selectionEnd ? mentionAt(el.value, el.selectionStart ?? 0) : null
    if (!m || dismissed.current === m.start) { if (!m) dismissed.current = null; setMention(null); return }
    setMention(cur => (cur && cur.start === m.start && cur.query === m.query ? cur : m))
  }
  // the files for the mention's letters (a moment after the last one; the walk itself is main's, cached)
  useEffect(() => {
    if (!mention || !chat) { setMenuFiles(null); return }
    let live = true
    const timer = setTimeout(() => {
      chat.files({ id, query: mention.query }).then(r => { if (live) { setMenuFiles(r.ok ? r.files.slice(0, MENU_ROWS) : []); setSel(0) } }, () => { if (live) setMenuFiles([]) })
    }, 100)
    return () => { live = false; clearTimeout(timer) }
  }, [mention, chat, id])
  const pick = (i: number) => {
    const el = ta.current
    const f = menuFiles?.[i]
    if (!el || !mention || !f) return
    const caret = el.selectionStart ?? el.value.length
    // the typed `@query` leaves the text; the file becomes a badge (the owner's call, 2026-11-17)
    replaceRange(el, mention.start, caret, '')
    if (!refs.includes(f)) setRefList([...refs, f])
    setMention(null)
  }
  const menuClosedAt = useRef(-Infinity)
  const closeMenu = () => { if (mention) dismissed.current = mention.start; setMention(null); menuClosedAt.current = Date.now() }
  const setChipList = (l: Chip[]) => { chipsOf.set(id, l); setChips(l) }
  const setRefList = (l: string[]) => { refsOf.set(id, l); setRefs(l) }
  const say = (n: Note | null, ms?: number) => {
    clearTimeout(noteTimer.current)
    setNote(n)
    if (n && ms) noteTimer.current = setTimeout(() => setNote(null), ms)
  }

  // the box grows with the text from one line to 160px, then scrolls (measured, no animation). Measured on a
  // hidden twin of the field: collapsing the field itself to measure it would let the conversation above
  // spring back a line and leave its bottom
  const twin = useRef<HTMLTextAreaElement>(null)
  useLayoutEffect(() => {
    const el = ta.current
    const m = twin.current
    if (!el || !m) return
    m.style.width = `${el.offsetWidth}px`
    m.value = el.value
    const full = Math.max(m.scrollHeight, 22)
    const h = `${Math.min(full, 160)}px`
    if (el.style.height !== h) el.style.height = h
    el.style.overflowY = full > 160 ? 'auto' : 'hidden'
  })

  const depsFor = (): SendDeps => ({
    bridge: chat!,
    readScreen: deps?.termText ?? termText,
    // (an injected reader without marks reads without them; the page's own has them)
    readDim: deps ? deps.termDim : termDim,
    now: deps?.now ?? Date.now,
    sleep: deps?.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms))),
    outbox: outboxFor(id),
    newId: newSendId,
    status,
    baseline: baselineOf(items),
  })

  /** What the textarea holds now, with what was sent taken off its start (typed on during the send: kept) */
  const rest = (sent: string) => {
    const now = ta.current?.value ?? ''
    return now.startsWith(sent) ? now.slice(sent.length).replace(/^\s+/, '') : now
  }

  async function send() {
    if (sending.current || !chat) return
    const value = ta.current?.value ?? text
    if (!value.trim() && (shell || (!chips.length && !refs.length))) return
    if (ended) { say({ key: '세션이 끝나서 보낼 수 없어요', terminal: true }); return }
    if (value.length > MAX_CHARS) { say(refusalNote('too-long', who)); return }
    sending.current = true
    setBusy(true)
    say(null)
    const sentChips = chips
    const sentRefs = refs
    try {
      // (a `!` command goes alone: the pictures stay in the composer for the next message)
      const r = shell
        ? await sendDraft({ id, text: value, images: [], shell: true }, depsFor())
        : await sendDraft({ id, text: withRefs(sentRefs, value), images: sentChips.map(c => ({ token: c.token, url: c.url })) }, depsFor())
      if (r.ok && shell) {
        setDraft(rest(value))
        setShell(false)
      } else if (r.ok) {
        setDraft(rest(value))
        setChipList((chipsOf.get(id) ?? []).filter(c => !sentChips.includes(c)))
        setRefList((refsOf.get(id) ?? []).filter(f => !sentRefs.includes(f)))
        if (r.command) say({ key: '{command} 보냈어요. 터미널에 화면이 열렸다면 거기서 이어서 해 주세요', vars: { command: value.trim().split(/\s/)[0] }, terminal: true }, 6000)
      } else if (r.leftOnPrompt) {
        // the text is on the terminal's prompt row: sending it again would double it
        setDraft(rest(value))
        setChipList((chipsOf.get(id) ?? []).filter(c => !sentChips.includes(c)))
        say({ key: '보낸 글은 터미널 입력란에 남아 있어요. 터미널에서 Enter를 누르거나 지워 주세요', terminal: true })
      } else {
        // (a dialog on the terminal's screen: its card is right above, never the terminal)
        if (r.reason === 'screen' && parseDialog((deps?.termText ?? termText)(id))) say({ key: '{name}{iga} 고르기를 기다려요. 위 카드에서 먼저 골라 주세요', vars: nameVars(who.name) })
        else say(refusalNote(r.reason, who, cardNote(shownCard(status?.asks)), r.row))
      }
    } finally {
      sending.current = false
      setBusy(false)
    }
  }

  // ---- the control row's menus (2026-11-17): the model by `/model <alias>`, the mode by Shift+Tab until the footer shows it
  const [ctrlBusy, setCtrlBusy] = useState(false)
  const [modeShown, setModeShown] = useState<FooterMode | null>(null)
  const [lacks, setLacks] = useState<ReadonlySet<FooterMode>>(() => lacksOf.get(id) ?? new Set())
  // (the hooks' next word on the mode wins over what the footer showed)
  // the footer shows the mode the session is in now: read it once a second (the hooks only say it when they fire)
  useEffect(() => {
    if (fixed) return
    const readScreen = deps?.termText ?? termText
    const look = () => { const m = footerMode(readScreen(id)); if (m) setModeShown(cur => (cur === m ? cur : m)) }
    look()
    const timer = setInterval(look, 1000)
    return () => clearInterval(timer)
  }, [fixed, id, deps])
  useEffect(() => { setLacks(lacksOf.get(id) ?? new Set()) }, [id])

  async function changeModel(alias: string) {
    if (sending.current || !chat || ended) return
    sending.current = true
    setCtrlBusy(true)
    say(null)
    try {
      const r = await sendDraft({ id, text: `/model ${alias}`, images: [] }, depsFor())
      if (r.ok) {
        // Claude Code may ask first (switching mid-conversation clears the prompt cache): the dialog card asks then
        await new Promise(resolve => setTimeout(resolve, 600))
        if (!parseDialog((deps?.termText ?? termText)(id))) say({ key: alias === 'default' ? '모델을 기본값으로 바꿨어요' : '모델을 바꿨어요 · {model}', vars: { model: alias[0].toUpperCase() + alias.slice(1) } }, 4000)
      }
      else say(refusalNote(r.reason, who, cardNote(shownCard(status?.asks)), r.ok === false && 'row' in r ? r.row : undefined))
    } finally {
      sending.current = false
      setCtrlBusy(false)
    }
  }

  async function changeMode(target: FooterMode) {
    if (sending.current || !chat?.cycleMode || ended) return
    const press = chat.cycleMode
    sending.current = true
    setCtrlBusy(true)
    say(null)
    try {
      const readScreen = deps?.termText ?? termText
      const r = await switchMode(target, {
        read: () => readScreen(id),
        press: async () => { try { return (await press(id)).ok } catch { return false } },
        sleep: deps?.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms))),
      })
      if (r.mode) setModeShown(r.mode)
      if (r.ok) return
      if (r.reason === 'unreachable') {
        const next = new Set(lacksOf.get(id) ?? [])
        next.add(target)
        lacksOf.set(id, next)
        setLacks(next)
        say({ key: '이 세션에서는 이 모드를 고를 수 없어요. Claude Code를 이 모드로 시작해야 해요' }, 6000)
      } else say({ key: '지금은 모드를 바꾸지 못했어요. 잠시 뒤 다시 해 주세요' }, 5000)
    } finally {
      sending.current = false
      setCtrlBusy(false)
    }
  }

  /**
   * Words left on the terminal's prompt row (prompt-busy): cleared from here (src/chat/clearRow.ts), then either
   * brought into this box above what is written (take) or the message sent as it is (send)
   */
  async function takeRow(row: string, andSend: boolean) {
    if (sending.current || !chat?.dialogKey) return
    const key = chat.dialogKey
    sending.current = true
    setBusy(true)
    let cleared = false
    try {
      const readScreen = deps?.termText ?? termText
      const readDim = deps ? deps.termDim : termDim
      cleared = await clearPromptRow({
        read: () => ({ screen: readScreen(id), dim: readDim?.(id) ?? null }),
        key: async (k, n) => { try { return (await key({ id, key: k, ...(n ? { n } : {}) })).ok } catch { return false } },
        sleep: deps?.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms))),
      })
    } finally {
      sending.current = false
      setBusy(false)
    }
    if (!cleared) { say({ key: 'Claude Code 입력란을 비우지 못했어요. 잠시 뒤 다시 해 주세요' }, 5000); return }
    say(null)
    if (!andSend) {
      const cur = ta.current?.value ?? text
      setDraft(cur.trim() ? `${row}\n${cur}` : row)
      requestAnimationFrame(() => ta.current?.focus({ preventScroll: true }))
      return
    }
    void send()
  }

  async function stop() {
    if (!chat) return
    let r: Awaited<ReturnType<ChatBridge['interrupt']>>
    try { r = await chat.interrupt(id) } catch { r = { ok: false, reason: 'no-session' } }
    if (!r.ok) say(refusalNote(r.reason, who, cardNote(shownCard(status?.asks))), 5000)
  }

  async function attach(files: File[]) {
    if (!files.length) return
    const images = files.filter(f => IMAGE_TYPES.has(f.type))
    if (images.length < files.length) say({ key: 'PNG, JPEG, GIF, WebP 이미지만 붙일 수 있어요' })
    if (!images.length) return
    if (ended || !chat) { say({ key: '세션이 끝나서 보낼 수 없어요', terminal: true }); return }
    for (const f of images) {
      if ((chipsOf.get(id) ?? []).length >= MAX_IMAGES) { say({ key: '이미지는 한 번에 {n}장까지 보낼 수 있어요', vars: { n: MAX_IMAGES } }); break }
      if (f.size > MAX_MB << 20) { say(imageNote('size')); continue }
      let r: Awaited<ReturnType<ChatBridge['image']>>
      try { r = await chat.image({ id, bytes: new Uint8Array(await f.arrayBuffer()) }) } catch { r = { ok: false, reason: 'off' } }
      if (!r.ok) { say(imageNote(r.reason)); continue }
      const n = (chipSeq.get(id) ?? 0) + 1
      chipSeq.set(id, n)
      setChipList([...(chipsOf.get(id) ?? []), { token: r.token, url: URL.createObjectURL(f), n }])
      setNote(cur => (cur?.image ? null : cur))
    }
  }

  function removeChip(c: Chip) {
    chat?.dropImage({ id, token: c.token })
    revoke(c.url)
    setChipList((chipsOf.get(id) ?? []).filter(x => x.token !== c.token))
    ta.current?.focus({ preventScroll: true })
  }

  /**
   * Text put into the draft by the app (a mention picked, insertText) as the browser's own edit, so
   * Ctrl+Z / ⌘Z undoes it like typing (the textarea's input event updates the draft); a page with no
   * editing command sets the value instead
   */
  function replaceRange(el: HTMLTextAreaElement, start: number, end: number, s: string) {
    el.focus({ preventScroll: true })
    el.setSelectionRange(start, end)
    let done = false
    try { done = document.execCommand('insertText', false, s) } catch { done = false }
    if (!done || el.value.slice(start, start + s.length) !== s) {
      setDraft(el.value.slice(0, start) + s + el.value.slice(end))
      requestAnimationFrame(() => { el.focus({ preventScroll: true }); el.setSelectionRange(start + s.length, start + s.length) })
    }
  }

  function insertText(s: string) {
    const el = ta.current
    if (!el || ime.composing()) return
    const start = el.selectionStart ?? el.value.length
    const end = el.selectionEnd ?? start
    replaceRange(el, start, end, s)
  }

  // the view's handle: focus (Phase 2's focus rules decide when), 멈추기, insertText
  const handle = useRef<ComposerHandle>({ focus: () => false, stop: () => {}, insertText: () => {} })
  handle.current.focus = () => { const el = ta.current; if (!el) return false; el.focus({ preventScroll: true }); return true }
  handle.current.stop = () => { void stop() }
  handle.current.insertText = insertText
  useEffect(() => {
    if (!focusRef) return
    const h = handle.current
    focusRef.current = h
    return () => { if (focusRef.current === h) focusRef.current = null }
  }, [focusRef])

  // a send whose page went away before its Enter (a reload): its text may be on the terminal's prompt row; said once
  useEffect(() => {
    if (fixed || !chat?.stranded) return
    let live = true
    chat.stranded(id).then(r => { if (live && r?.stranded) say({ key: '보낸 글은 터미널 입력란에 남아 있어요. 터미널에서 Enter를 누르거나 지워 주세요', terminal: true }) }, () => {})
    return () => { live = false }
  }, [id, chat, fixed]) // eslint-disable-line react-hooks/exhaustive-deps

  // the user's own flip to 채팅 or switch of session (askChatFocus, at most 2 s ago): the composer takes the
  // focus once it is there — never from something being typed into (the side panel's box, a terminal in view)
  useEffect(() => {
    if (fixed || !takeChatFocus()) return
    if (isTypingTarget(document.activeElement)) return
    ta.current?.focus({ preventScroll: true })
  })

  // Claude Code's next-prompt suggestion (the dim text on the terminal's prompt row), shown as the placeholder
  // while the draft is empty; Tab or → takes it into the draft, never sends it (the owner's call, 2026-11-17)
  const [suggestion, setSuggestion] = useState<string | null>(null)
  const idleNow = status?.state === 'idle'
  useEffect(() => {
    if (fixed || ended || text || shell || !idleNow) { setSuggestion(null); return }
    const readScreen = deps?.termText ?? termText
    const readDim = deps ? deps.termDim : termDim
    const look = () => setSuggestion(suggestionOf(promptRow(readScreen(id), readDim?.(id) ?? null)))
    look()
    const timer = setInterval(look, SUGGEST_POLL_MS)
    return () => clearInterval(timer)
  }, [fixed, ended, text, shell, idleNow, id, deps])
  const canSend = !ended && (text.trim().length > 0 || (!shell && (chips.length > 0 || refs.length > 0)))
  const placeholder = shell ? t('실행할 명령…') : suggestion ?? (workMode ? t('에이전트에게 지시하기…') : t('{name}에게 지시하기…', { name: who.name }))

  return (
    <div className="chat-composer">
      <div className="chat-composer-in">
        <div className="chat-cnote" role="status">
          {note && <>
            <span>{t(note.key, note.vars)}</span>
            {note.row !== undefined && <>
              {note.row.trim() && <button type="button" className="chat-btn" disabled={busy} onClick={() => { void takeRow(note.row!, false) }}>{t('가져와서 이어 쓰기')}</button>}
              <button type="button" className="chat-btn" disabled={busy} onClick={() => { void takeRow(note.row!, true) }}>{t('지우고 보내기')}</button>
            </>}
            {note.terminal && <button type="button" className="chat-btn" onClick={onTerminal}>{t('터미널로 보기')}</button>}
          </>}
        </div>
        {menuOpen && <MentionMenu listId={listId} files={menuFiles!} sel={sel} onPick={pick} onHover={setSel} />}
        <QueueStrip status={status} />
        <div
          className={`chat-cbox${shell ? ' shell' : ''}`}
          onDragOver={e => { if (Array.from(e.dataTransfer?.types ?? []).includes('Files')) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy' } }}
          onDrop={e => { const files = filesOf(e.dataTransfer); if (files.length) { e.preventDefault(); void attach(files) } }}
        >
          {!shell && <FileChips files={refs} onRemove={f => setRefList(refs.filter(x => x !== f))} />}
          {!shell && <ImageChips chips={chips} onRemove={removeChip} onOpen={(c, from) => ctx.openImage?.(c.url, t('붙여넣은 이미지 {n}', { n: c.n }), from)} />}
          <textarea ref={twin} className="chat-input chat-input-twin" rows={1} readOnly tabIndex={-1} aria-hidden="true" defaultValue="" />
          <textarea
            ref={ta}
            className="chat-input"
            value={text}
            rows={1}
            spellCheck={false}
            placeholder={placeholder}
            aria-label={placeholder}
            aria-busy={busy || undefined}
            readOnly={ended}
            aria-disabled={ended || undefined}
            onChange={e => {
              // a `!` into the empty draft: shell mode (the mark is the badge, not part of the command)
              if (!shell && !text && e.target.value === '!' && chat) { setShell(true); setDraft(''); return }
              setDraft(e.target.value); look()
            }}
            onSelect={look}
            onCompositionStart={() => ime.start()}
            onCompositionEnd={() => { ime.end(); look() }}
            onBlur={() => { ime.blur(); setMention(null) }}
            aria-autocomplete="list"
            aria-controls={menuOpen ? listId : undefined}
            aria-activedescendant={menuOpen && menuFiles!.length ? `${listId}-${sel}` : undefined}
            onPaste={e => { const files = filesOf(e.clipboardData, true); if (files.length) void attach(files) }}
            onKeyDown={e => {
              const a = keyAction(
                { key: e.key, code: e.code, shiftKey: e.shiftKey, ctrlKey: e.ctrlKey, metaKey: e.metaKey, altKey: e.altKey, isComposing: e.nativeEvent.isComposing, keyCode: e.keyCode },
                // (Esc: a mention being typed counts as an open menu even while its files load, so the
                // Esc meant to close it never stops the work)
                { composing: ime.composing(), working, menuOpen, mentionOpen: !!mention, lightbox: !!ctx.lightbox },
              )
              const n = Math.min(menuFiles?.length ?? 0, MENU_ROWS)
              // Backspace on the empty draft leaves shell mode
              if (shell && e.key === 'Backspace' && !text && !ime.composing()) { e.preventDefault(); setShell(false); return }
              // Shift+Enter on a list line: the next item's mark comes with the new line (src/chat/lists.ts)
              if (e.key === 'Enter' && e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey && !shell && !menuOpen
                && !ime.composing() && !e.nativeEvent.isComposing && e.keyCode !== 229) {
                const el = e.currentTarget
                const edit = el.selectionStart === el.selectionEnd ? continueList(el.value, el.selectionStart ?? el.value.length) : null
                if (edit) { e.preventDefault(); replaceRange(el, edit.start, edit.end, edit.insert); return }
              }
              // the suggestion taken into the draft: Tab or →, plain, on an empty draft
              if (suggestion && !text && !menuOpen && !ime.composing() && !e.nativeEvent.isComposing && (e.key === 'Tab' || e.key === 'ArrowRight') && !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey) {
                e.preventDefault()
                insertText(suggestion)
                return
              }
              if (a === 'send') { e.preventDefault(); if (!busy) void send() }
              // (an Esc right after one that closed the @ menu is the same gesture: it never stops the work)
              else if (a === 'stop') { e.preventDefault(); if (Date.now() - menuClosedAt.current > ESC_AFTER_MENU_MS) void stop() }
              else if (a === 'menu-up') { e.preventDefault(); if (n) setSel(v => (v - 1 + n) % n) }
              else if (a === 'menu-down') { e.preventDefault(); if (n) setSel(v => (v + 1) % n) }
              else if (a === 'menu-pick') { e.preventDefault(); if (n) pick(sel); else closeMenu() }
              else if (a === 'menu-close') { e.preventDefault(); closeMenu() }
            }}
          />
          <div className="chat-cbar">
            {/* shell mode: its badge in place of + and @ (a command takes neither); a click leaves it */}
            {shell ? (
              <button type="button" className="chat-shell-badge" onClick={() => { setShell(false); ta.current?.focus({ preventScroll: true }) }}
                title={t('셸 모드 · 눌러서 나가기 (빈 칸에서 Backspace)')} aria-label={t('셸 모드 나가기')}>
                <b>!</b>{t('셸 모드')}
              </button>
            ) : <>
            <button type="button" className="chat-ib" onClick={() => picker.current?.click()} aria-label={t('이미지 붙이기')} title={t('이미지 붙이기')} disabled={ended}><PlusIcon /></button>
            {chat && (
              <button type="button" className="chat-ib" aria-label={t('파일 멘션')} title={t('파일 멘션')} disabled={ended}
                onClick={() => {
                  const el = ta.current
                  if (!el) return
                  const at = el.selectionStart ?? el.value.length
                  dismissed.current = null
                  insertText(at > 0 && !/\s/.test(el.value[at - 1]) ? ' @' : '@')
                  requestAnimationFrame(look)
                }}><AtIcon /></button>
            )}
            </>}
            <input ref={picker} className="chat-file" type="file" accept="image/png,image/jpeg,image/gif,image/webp" multiple tabIndex={-1} aria-hidden="true"
              onChange={e => { const files = Array.from(e.target.files ?? []); e.target.value = ''; void attach(files) }} />
            {suggestion && !text && <kbd className="chat-sugg-key" title={t('Tab으로 추천 문장 채우기')}>Tab</kbd>}
            <button
              type="button"
              className={`chat-send${canSend ? '' : ' empty'}`}
              onClick={() => { if (canSend && !busy) void send() }}
              aria-label={t('보내기')}
              title={t('보내기 (Enter)')}
              aria-disabled={!canSend || busy || undefined}
            ><SendUpIcon /></button>
          </div>
        </div>
        {shell ? <div className="chat-chint">{t('터미널에서 !로 실행하는 것과 같아요. 명령과 결과가 Claude의 대화에도 들어가요')}</div> : null}
        {!shell && isCommandText(text) && !chips.length ? <div className="chat-chint">{t('/로 시작하면 Claude Code 명령으로 보내요. 글자 그대로 보내려면 앞에 띄어쓰기를 넣어요')}</div> : null}
        <ControlRow control={control} mode={modeShown ?? status?.mode} actions={chat && !fixed ? {
          onModel: m => { void changeModel(m) },
          onMode: m => { void changeMode(m) },
          // (a model is a command: typed only on an idle prompt; a mode is a key: not while a card waits on it)
          modelWhy: ended ? '세션이 끝났어요' : status?.state === 'working' ? '일이 끝나면 바꿀 수 있어요' : status?.state === 'waiting' || (status?.asks?.length ?? 0) > 0 ? '먼저 아래 카드에 답해 주세요' : null,
          modeWhy: ended ? '세션이 끝났어요' : status?.state === 'waiting' || (status?.asks?.length ?? 0) > 0 ? '먼저 아래 카드에 답해 주세요' : !chat.cycleMode ? '이 버전에서는 바꿀 수 없어요' : null,
          unreachable: lacks,
          busy: ctrlBusy || busy,
        } : undefined} />
      </div>
    </div>
  )
}

export default Composer
