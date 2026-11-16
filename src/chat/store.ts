/**
 * The page's copy of each conversation the chat view shows (Phase 2, the read-only
 * lens). Main sends `ChatUpdate`s (src/chat/types.ts) over `chat:update`; they are
 * applied here in rev order. A gap (an update lost or out of order) leaves the copy
 * as it was and asks main to send the view again as it is (`chat.resync`, a `reset`
 * with the same banners; `chat.reload` is only the banner's 다시 읽기, which re-reads
 * and re-judges). Main numbers every terminal's updates, also the status-only ones of
 * views not open, so the rev of each terminal is followed from its first update.
 * Items stay sorted by (order, id); an upsert replaces an item whole.
 *
 * At most `cap` items are kept per terminal (the newest; `status.hasOlder` then
 * says there is more above). Nothing here goes to localStorage.
 */

import { useCallback, useSyncExternalStore } from 'react'
import { bridge } from '../desktop'
import { CHAT_VIEW } from '../features'
import { LIVE_BASE, type ChatItem, type ChatUpdate, type LensStatus } from './types'

export interface ChatState { rev: number; items: ChatItem[]; status: LensStatus | null }

/** The items a page keeps per terminal (the plan's "at most 4000 items per session") */
export const ITEM_CAP = 4000

export const EMPTY_CHAT: ChatState = Object.freeze({ rev: 0, items: Object.freeze([]) as unknown as ChatItem[], status: null }) as ChatState

/** (order, id): the sort of the conversation */
function before(a: ChatItem, b: ChatItem): boolean {
  return a.order < b.order || (a.order === b.order && a.id < b.id)
}
const compare = (a: ChatItem, b: ChatItem) => (before(a, b) ? -1 : before(b, a) ? 1 : 0)

/** Where `item` goes in a sorted list (binary search) */
function slot(list: ChatItem[], item: ChatItem): number {
  let lo = 0, hi = list.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (before(list[mid], item)) lo = mid + 1
    else hi = mid
  }
  return lo
}

/** The newest `cap` items: the oldest main items go first, each with its sub-agent's items */
function capItems(items: ChatItem[], cap: number): { items: ChatItem[]; dropped: boolean } {
  if (items.length <= cap) return { items, dropped: false }
  const children = new Map<string, number>()
  for (const it of items) if (it.parent) children.set(it.parent, (children.get(it.parent) ?? 0) + 1)
  const gone = new Set<string>()
  let left = items.length
  for (const it of items) {
    if (left <= cap) break
    if (it.parent) continue
    gone.add(it.id)
    left -= 1 + (children.get(it.id) ?? 0)
  }
  return { items: items.filter(it => !gone.has(it.id) && !(it.parent && gone.has(it.parent))), dropped: true }
}

/**
 * One update applied to a state (pure: the state given is not changed). A rev that
 * does not follow (and is not a reset) is a gap: the state comes back as it was.
 * An old rev (already applied) is dropped quietly.
 */
export function applyUpdate(s: ChatState, u: ChatUpdate, cap = ITEM_CAP): { state: ChatState; gap: boolean } {
  const resets = u.ops[0]?.op === 'reset'
  if (!resets) {
    if (u.rev <= s.rev) return { state: s, gap: false }
    if (u.rev !== s.rev + 1) return { state: s, gap: true }
  }
  let items = s.items
  let status = s.status
  let copied = false
  const own = () => { if (!copied) { items = items.slice(); copied = true } }
  for (const op of u.ops) {
    if (op.op === 'reset') {
      items = op.items.slice().sort(compare)
      copied = true
      status = op.status
    } else if (op.op === 'upsert') {
      own()
      for (const item of op.items) {
        const at = items.findIndex(x => x.id === item.id)
        if (at >= 0) items.splice(at, 1)
        items.splice(slot(items, item), 0, item)
      }
    } else if (op.op === 'remove') {
      const gone = new Set(op.ids)
      items = items.filter(x => !gone.has(x.id))
      copied = true
    } else if (op.op === 'status') {
      status = op.status
    }
  }
  const capped = capItems(items, cap)
  if (capped.dropped && status && !status.hasOlder) status = { ...status, hasOlder: true }
  return { state: { rev: u.rev, items: capped.items, status }, gap: false }
}

type ChatBridge = NonNullable<typeof bridge>['chat']

/** How many conversations stay in memory after their view closed (a flip back shows them at once) */
const KEEP_CLOSED = 6

/**
 * The page's conversations, fed by one `chat.onUpdate` listener. The first
 * subscriber of a terminal opens it (`chat.open`), the last one to leave closes
 * it (`chat.close`). Made per bridge so it can be tested without a page.
 */
/** Why the page put up a banner itself: main cannot answer (the reader gone), the version gate, a session not armed */
export type PageReason = 'worker' | 'version' | 'unarmed'

/**
 * What chat.open's refusal means on the page: 'version' the version gate; 'unarmed', 'off' or 'not-claude' (a
 * race: the flip should not have been there) the session is not armed; anything else the reader is gone
 */
export function openRefusal(reason: unknown): PageReason {
  if (reason === 'version') return 'version'
  if (reason === 'unarmed' || reason === 'off' || reason === 'not-claude') return 'unarmed'
  return 'worker'
}

/** A status the page makes itself, when main cannot answer (the reader gone): a banner, never a blank view */
export function pageStatus(cur: LensStatus | null, reason: PageReason): LensStatus {
  return { ...(cur ?? { state: 'idle', since: null, label: null, note: null, version: null, hasOlder: false, empty: false }), banner: { reason } }
}

export function createChatStore(chat: Pick<ChatBridge, 'open' | 'close' | 'resync' | 'onUpdate'> & Partial<Pick<ChatBridge, 'reload'>> | null | undefined, cap = ITEM_CAP) {
  const states = new Map<string, ChatState>()
  const subs = new Map<string, Set<() => void>>()
  /** The last rev of every terminal heard of (opened or not), so a view opened later has no false gap */
  const revs = new Map<string, number>()
  /** A resync asked for and not yet answered by a reset (one at a time) */
  const reloading = new Set<string>()
  /** Opened and not yet sent its reset: only statuses count (whatever their rev), and no gap is one */
  const awaiting = new Set<string>()
  const closedOrder: string[] = []
  let listening = false
  /** Who hears items that arrived live (onAppended) */
  const appendedFns = new Set<(id: string, items: ChatItem[]) => void>()

  /**
   * The transcript items an applied upsert added past the end of what was held: what arrived live, as it
   * happened. A reset (a load, a resync, 다시 읽기), an older page and an item replaced in place are history.
   */
  function appended(id: string, before: ChatItem[], u: ChatUpdate) {
    if (!appendedFns.size || u.ops.some(o => o.op === 'reset')) return
    let last = -Infinity
    const had = new Set<string>()
    for (const it of before) { had.add(it.id); if (it.order < LIVE_BASE && it.order > last) last = it.order }
    const added: ChatItem[] = []
    for (const op of u.ops) {
      if (op.op !== 'upsert') continue
      for (const it of op.items) if (it && !had.has(it.id) && it.order < LIVE_BASE && it.order > last) added.push(it)
    }
    if (added.length) appendedFns.forEach(fn => fn(id, added))
  }

  function onUpdate(u: ChatUpdate) {
    if (!u || typeof u.id !== 'string' || !Array.isArray(u.ops) || typeof u.rev !== 'number') return
    const open = subs.has(u.id)
    if (!open && !states.has(u.id)) {
      // not shown: only its rev is followed (its next open answers with a reset anyway)
      revs.set(u.id, Math.max(revs.get(u.id) ?? 0, u.rev))
      return
    }
    const cur = states.get(u.id) ?? { ...EMPTY_CHAT, rev: revs.get(u.id) ?? 0 }
    revs.set(u.id, Math.max(revs.get(u.id) ?? 0, u.rev))
    const resets = u.ops[0]?.op === 'reset'
    // the status alone (a status is whole: its rev does not matter), until the reset or after a gap
    const statusOnly = () => {
      const st = [...u.ops].reverse().find(o => o.op === 'status' || o.op === 'reset') as { status: LensStatus } | undefined
      if (!st) return
      states.set(u.id, { ...cur, rev: Math.max(cur.rev, u.rev), status: st.status })
      subs.get(u.id)?.forEach(fn => fn())
    }
    if (awaiting.has(u.id) && !resets) { statusOnly(); return }
    const { state, gap } = applyUpdate(cur, u, cap)
    if (gap) {
      statusOnly()
      if (open && !reloading.has(u.id) && chat) {
        reloading.add(u.id)
        chat.resync(u.id).then(r => { if (!r?.ok) unreadable(u.id) }, () => unreadable(u.id))
      }
      return
    }
    if (resets) { reloading.delete(u.id); awaiting.delete(u.id) }
    if (state === cur) return
    states.set(u.id, state)
    subs.get(u.id)?.forEach(fn => fn())
    appended(u.id, cur.items, u)
  }

  /** Main could not answer for this view (no reader): the view says so, with 터미널로 보기 */
  function unreadable(id: string, reason: PageReason = 'worker') {
    reloading.delete(id)
    if (!subs.has(id)) return
    const cur = states.get(id) ?? { ...EMPTY_CHAT, rev: revs.get(id) ?? 0 }
    states.set(id, { ...cur, status: pageStatus(cur.status, reason) })
    subs.get(id)?.forEach(fn => fn())
  }

  function listen() {
    if (listening || !chat) return
    listening = true
    chat.onUpdate(onUpdate)
  }

  // heard from the start (not from the first open): the revs of views not open are followed too
  listen()

  return {
    get(id: string | null): ChatState {
      return (id && states.get(id)) || EMPTY_CHAT
    },
    subscribe(id: string, fn: () => void): () => void {
      listen()
      let set = subs.get(id)
      const first = !set
      if (!set) { set = new Set(); subs.set(id, set) }
      set.add(fn)
      if (first && chat) {
        const i = closedOrder.indexOf(id)
        if (i >= 0) closedOrder.splice(i, 1)
        awaiting.add(id)
        chat.open(id).then(r => {
          if (r && r.ok === false) unreadable(id, openRefusal((r as { reason?: string }).reason))
        }, () => unreadable(id))
      }
      return () => {
        const s = subs.get(id)
        if (!s) return
        s.delete(fn)
        if (s.size) return
        subs.delete(id)
        reloading.delete(id)
        awaiting.delete(id)
        if (chat) chat.close(id)
        // keep the last few closed conversations; the next open sends a reset anyway
        closedOrder.push(id)
        while (closedOrder.length > KEEP_CLOSED) states.delete(closedOrder.shift()!)
      }
    },
    /** 다시 읽기: main reads the view again from the start; no answer is said as a banner */
    reload(id: string): void {
      if (!chat?.reload) return
      chat.reload(id).then(r => { if (!r?.ok) unreadable(id) }, () => unreadable(id))
    },
    /** For a test or the QA page: an update as if it came from main */
    dispatch: onUpdate,
    /** Items that arrived live, past the end of what a view held (the turn summary's steps: src/chat/steps.ts) */
    onAppended(fn: (id: string, items: ChatItem[]) => void): () => void {
      appendedFns.add(fn)
      return () => { appendedFns.delete(fn) }
    },
  }
}

/** The page's store (the desktop bridge; nothing in a plain browser) */
export const chatStore = createChatStore(CHAT_VIEW ? bridge?.chat ?? null : null)

/** One terminal's conversation; subscribing opens it in main, the last unsubscribe closes it */
export function useChat(id: string | null): ChatState {
  const subscribe = useCallback((cb: () => void) => (id ? chatStore.subscribe(id, cb) : () => {}), [id])
  const get = () => chatStore.get(id)
  return useSyncExternalStore(subscribe, get, get)
}
