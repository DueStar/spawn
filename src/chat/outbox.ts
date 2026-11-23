/**
 * The chat composer's outbox: a provisional bubble for each message sent from this
 * page, until the session transcript's own user line replaces it (or Claude Code's queue strip
 * shows it while it holds the prompt). A prompt another plugin's hook blocked: the record's notice says so and
 * the bubble goes. One the record never shows stays as it is (no "not in the record yet": a slow hook of another
 * plugin held the line back almost every time, 2026-11-23) and goes once the session has been idle a while.
 *
 * It also keeps the thumbnails of images sent from this composer in this run (the page's own
 * blob URLs, at most 30 per terminal), moved to the user line they became. Older messages keep
 * the plain `이미지 n` chip: no image bytes ever come back from main.
 */

import { onChatForget } from './lensMode'
import { LIVE_BASE, PENDING_BASE, type ChatItem, type LensStatus, type NoticeItem, type UserItem } from './types'

export interface OutboxImage { token: string; url: string }
export interface OutboxEntry {
  local: string
  text: string
  images: OutboxImage[]
  /** queued: Claude Code holds it in its queue while it works (drawn faded, said as waiting) */
  state: 'sending' | 'sent' | 'unconfirmed' | 'queued'
  /** when it was written */
  at: number
  /** when Enter was accepted */
  sentAt?: number
  /** the largest transcript order the page had when it was sent: its user line comes after */
  baseline: number
}

export const UNCONFIRMED_MS = 8000
/** a bubble the record never showed goes after this long, with the session idle (spawn's MISSING_MS: 65 s) */
export const STALE_MS = 70_000
export const THUMBS_KEPT = 30

/** The largest order of the record (transcript lines; hook rows and bubbles aside), -1 for none */
export function baselineOf(items: readonly ChatItem[]): number {
  let max = -1
  for (const i of items) if (!i.parent && i.order < PENDING_BASE && i.order > max) max = i.order
  return max
}

/** The bubbles as user items, after every transcript line and before the new turn's hook rows */
export function pendingItems(entries: readonly OutboxEntry[]): UserItem[] {
  return entries.map((e, n) => ({ id: `pending:${e.local}`, order: PENDING_BASE + n, at: e.at, kind: 'user', text: e.text, images: e.images.length, pending: e.state, local: e.local }))
}

/** An image the app pasted (its own temp folder: `spawn-chat-<8 hex>`), quoted or not, and Claude Code's markers */
const APP_PATH = /"[^"]*spawn-chat-[0-9a-f]{8}[^"]*"|[^\s"]*spawn-chat-[0-9a-f]{8}[^\s"]*/g
const MARKER = /\[Image #\d+\]/g
const plainText = (s: string) => String(s ?? '').replace(APP_PATH, ' ').replace(MARKER, ' ').replace(/\s+/g, ' ').trim()

/** What was sent and what the record holds are the same message */
export function sentMatches(sent: string, text: string): boolean {
  const a = plainText(sent)
  const b = plainText(text)
  if (a === b) return true
  const pa = a.slice(0, 200)
  const pb = b.slice(0, 200)
  return (pa.length >= 20 && b.startsWith(pa)) || (pb.length >= 20 && a.startsWith(pb))
}

/** A row main shows from a prompt's UserPromptSubmit before its line is written (electron/chatLens.cjs showPrompt) */
export const isHookPrompt = (i: ChatItem): i is UserItem => i.kind === 'user' && !i.parent && !!i.pending && !i.local

/** Claude Code took this entry's text: main shows it from the hook */
const takenByHook = (e: OutboxEntry, items: readonly ChatItem[]) => items.some(i => isHookPrompt(i) && sentMatches(e.text, i.text))

/** The rows main shows from prompt hooks that an entry here stands for already (the page's own bubble shows instead) */
export function hookPromptsShown(entries: readonly OutboxEntry[], items: readonly ChatItem[]): Set<string> {
  const ids = new Set<string>()
  if (!entries.length) return ids
  for (const i of items) if (isHookPrompt(i) && entries.some(e => sentMatches(e.text, i.text))) ids.add(i.id)
  return ids
}

const record = (items: readonly ChatItem[]) => items.filter((i): i is UserItem => i.kind === 'user' && !i.parent && i.order < PENDING_BASE && !(i as UserItem).pending)

/**
 * Sent entries meet the record: one matched by a user line after its baseline is dropped (the
 * line replaces it, `itemId`); one Claude Code holds in its queue is dropped (`itemId: null`:
 * the strip shows it, its line comes later); one sent 8 s ago with neither is unconfirmed.
 */
export function reconcile(entries: readonly OutboxEntry[], items: readonly ChatItem[], status: LensStatus | null, now: number): { entries: OutboxEntry[]; matched: { local: string; itemId: string | null }[] } {
  const users = record(items)
  const taken = new Set<string>()
  // the record's word that a prompt was blocked: for the bubble with its words, else (its words mangled) the oldest one sent before it
  const blocks = items.filter((i): i is NoticeItem => i.kind === 'notice' && i.notice === 'prompt-blocked' && !i.parent && i.order < LIVE_BASE)
  const blockedFor = new Map<string, string>()
  for (const b of blocks) {
    const open = entries.filter(e => e.state !== 'sending' && b.order > e.baseline && ![...blockedFor.keys()].includes(e.local))
    const e = (b.text ? open.find(x => sentMatches(x.text, b.text!)) : undefined) ?? (b.text ? undefined : open[0])
    if (e) blockedFor.set(e.local, b.id)
  }
  const queued = status?.queued ?? []
  const out: OutboxEntry[] = []
  const matched: { local: string; itemId: string | null }[] = []
  for (const e of entries) {
    if (e.state === 'sending') { out.push(e); continue }
    if (blockedFor.has(e.local)) { matched.push({ local: e.local, itemId: null }); continue }
    const line = users.find(u => u.order > e.baseline && u.order < LIVE_BASE && !taken.has(u.id) && sentMatches(e.text, u.text))
    if (line) { taken.add(line.id); matched.push({ local: e.local, itemId: line.id }); continue }
    // held in Claude Code's queue: it stays in the conversation, faded, until its line comes (2026-11-23)
    if (queued.some(q => sentMatches(e.text, q.text))) { out.push(e.state === 'queued' ? e : { ...e, state: 'queued' }); continue }
    // Claude Code took it (main shows the prompt from its UserPromptSubmit): its line is only late (another
    // plugin's prompt hook holds it 6–12 s), so the bubble stays as it is, never 'unconfirmed' meanwhile
    if (takenByHook(e, items)) { out.push(e.state === 'unconfirmed' ? { ...e, state: 'sent' } : e); continue }
    // never in the record, and the session long idle: it went somewhere the record does not say (it goes quietly)
    if (now - (e.sentAt ?? e.at) >= STALE_MS && status?.state === 'idle') { matched.push({ local: e.local, itemId: null }); continue }
    out.push(e.state === 'unconfirmed' || e.state === 'queued' ? { ...e, state: 'sent' } : e)
  }
  return { entries: out, matched }
}

/** One terminal's outbox: its entries, the thumbnails of what it sent, subscribers (the page) */
export function createOutbox({ revoke = (url: string) => { try { URL.revokeObjectURL(url) } catch { /* not a page */ } } }: { revoke?: (url: string) => void } = {}) {
  let entries: OutboxEntry[] = []
  /** item id → its pictures, oldest first (insertion order) */
  const thumbs = new Map<string, string[]>()
  /** the pictures of messages Claude Code holds in its queue, until their line comes */
  let waiting: { text: string; urls: string[]; baseline: number }[] = []
  const subs = new Set<() => void>()
  const tell = () => { for (const fn of [...subs]) fn() }

  function keep(itemId: string, urls: string[]) {
    if (!urls.length) return
    thumbs.set(itemId, urls)
    while (thumbs.size > THUMBS_KEPT) {
      const [first, gone] = thumbs.entries().next().value as [string, string[]]
      thumbs.delete(first)
      gone.forEach(revoke)
    }
  }

  return {
    entries: () => entries,
    thumbs: (itemId: string) => thumbs.get(itemId) ?? [],
    subscribe(fn: () => void) { subs.add(fn); return () => { subs.delete(fn) } },
    add(e: OutboxEntry) { entries = [...entries, e]; tell() },
    mark(local: string, state: OutboxEntry['state'], at: number) {
      entries = entries.map(e => (e.local === local ? { ...e, state, sentAt: state === 'sent' ? at : e.sentAt } : e))
      tell()
    },
    /** a send that did not happen: the bubble goes, and its pictures unless the composer still shows them (revokeImages false) */
    remove(local: string, revokeImages = true) {
      const e = entries.find(x => x.local === local)
      if (!e) return
      entries = entries.filter(x => x !== e)
      if (revokeImages) e.images.forEach(i => revoke(i.url))
      tell()
    },
    /** the user's own dismissal of an unconfirmed bubble */
    dismiss(local: string) {
      const e = entries.find(x => x.local === local)
      if (!e) return
      entries = entries.filter(x => x !== e)
      e.images.forEach(i => revoke(i.url))
      tell()
    },
    /** the record (and the queue) moved on */
    sync(items: readonly ChatItem[], status: LensStatus | null, now: number) {
      let changed = false
      if (waiting.length) {
        const users = record(items)
        waiting = waiting.filter(w => {
          const line = users.find(u => u.order > w.baseline && u.order < LIVE_BASE && !thumbs.has(u.id) && sentMatches(w.text, u.text))
          if (!line) return true
          keep(line.id, w.urls)
          changed = true
          return false
        })
      }
      const r = reconcile(entries, items, status, now)
      for (const m of r.matched) {
        const e = entries.find(x => x.local === m.local)!
        const urls = e.images.map(i => i.url)
        if (m.itemId) keep(m.itemId, urls)
        else if (urls.length) waiting = [...waiting, { text: e.text, urls, baseline: e.baseline }].slice(-8)
      }
      if (r.matched.length || r.entries.some((e, i) => e !== entries[i]) || r.entries.length !== entries.length) { entries = r.entries; changed = true }
      if (changed) tell()
    },
    /** the terminal is gone: every picture freed */
    forget() {
      for (const e of entries) e.images.forEach(i => revoke(i.url))
      for (const urls of thumbs.values()) urls.forEach(revoke)
      for (const w of waiting) w.urls.forEach(revoke)
      entries = []
      thumbs.clear()
      waiting = []
      tell()
    },
  }
}

export type Outbox = ReturnType<typeof createOutbox>

/** The page's outboxes, one per terminal; a terminal gone takes its outbox (and every picture) with it */
const boxes = new Map<string, Outbox>()
export function outboxFor(id: string): Outbox {
  let box = boxes.get(id)
  if (!box) { box = createOutbox(); boxes.set(id, box) }
  return box
}
onChatForget(id => { boxes.get(id)?.forget(); boxes.delete(id) })
