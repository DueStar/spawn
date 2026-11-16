/**
 * What the chat view's rows need from the view around them: the terminal they belong
 * to, how to show the terminal (터미널로 보기), how a link or a file opens, how a
 * sub-agent's rows are fetched, and which rows the user opened (kept outside the rows,
 * so a row that scrolls out of the virtual list and back keeps its state).
 */

import React, { useContext, useSyncExternalStore } from 'react'
import { onChatForget } from '../../chat/lensMode'
import type { Density } from '../../chat/density'

export interface ChatContextValue {
  /** The terminal (session) the conversation belongs to */
  id: string
  /** Show the terminal of this session (the 채팅 / 터미널 flip) */
  onTerminal(): void
  onLink(url: string): void
  onPath(file: string, line?: number, col?: number): void
  /** A sub-agent's rows, under its Agent row (they arrive as an update; the answer says whether it read them) */
  loadAgent(toolId: string): Promise<{ ok: boolean }>
  /** Agent rows whose sub-agent waits on the user (its own permission has no row of its own) */
  waitingAgents: string[]
  /** An image shown large over the view (the composer's chips, a sent message's thumbnails); the focus returns to from */
  openImage?(url: string, caption: string, from: HTMLElement | null): void
  /** Whether an image is shown large now */
  lightbox?: boolean
  /** The pictures of a message sent from this composer in this run (src/chat/outbox.ts), by its item id */
  thumbs?(itemId: string): string[]
  /** A card below the conversation can answer what a row waits on (Phase 4): the row points there, not to the terminal */
  cardHere?: boolean
  /** Open the 변경 사항 panel at this file and edit (a diff block's +N −N); absent: no panel here (the counts stay text) */
  openChanges?(p: { file: string; toolId: string }): void
  /** How much is drawn (src/chat/density.ts): rows start open in 전부 until the user chooses; absent: 기본 */
  density?: Density
  /** 업무 모드: nothing of the game is drawn (no steps) */
  workMode?: boolean
  /** A finished turn's steps (src/chat/steps.ts), by its turn-end item's id; absent (업무 모드, the QA page): none */
  stepsFor?(turnEndId: string): number | null
  /** Hears when a turn's steps become known */
  stepsSubscribe?(fn: () => void): () => void
  /** A wild row met while this view was open (its one entry animation, once); absent: none animates */
  wildNew?(rowKey: string): boolean
  /** That row's animation has played (a row scrolled out and back does not play it again) */
  wildPlayed?(rowKey: string): void
  /** Link preview cards are on (the flag, 채팅으로 보기 and 링크 미리보기): a finished answer's first links get one */
  previews?: boolean
}

const noop = () => {}
export const ChatContext = React.createContext<ChatContextValue>({ id: '', onTerminal: noop, onLink: noop, onPath: noop, loadAgent: () => Promise.resolve({ ok: false }), waitingAgents: [] })
export const useChatContext = () => useContext(ChatContext)

/** Rows the user opened or closed, per terminal (at most a few hundred kept) */
const opened = new Map<string, Map<string, boolean>>()
onChatForget(id => opened.delete(id))
/** The mounted rows hear a change (each reads only its own key: one that did not change does not draw again) */
const listeners = new Set<() => void>()
const subscribe = (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn) } }

/**
 * Open or close a row of terminal `id` by its open key (a tool's id, `group:<key>`, `<id>:diff`, an Agent row's id),
 * from inside the row (its own toggle) or from outside it (find opens what a match lies in). A row not mounted
 * reads it when it mounts.
 */
export function setRowOpen(id: string, key: string, open: boolean): void {
  let mine = opened.get(id)
  if (!mine) { mine = new Map(); opened.set(id, mine) }
  mine.delete(key)
  mine.set(key, open)
  if (mine.size > 400) mine.delete(mine.keys().next().value as string)
  for (const fn of [...listeners]) fn()
}

/** A row's open state that outlives the row's element; `initial` until the user chooses */
export function useRowOpen(key: string, initial = false): [boolean, (open: boolean) => void] {
  const { id } = useChatContext()
  const get = () => opened.get(id)?.get(key)
  const stored = useSyncExternalStore(subscribe, get, get)
  return [stored ?? initial, (v: boolean) => setRowOpen(id, key, v)]
}
