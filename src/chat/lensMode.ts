/**
 * The chat view's place in the app: who speaks in it (the session's Pokémon, or in
 * 업무 모드 a plain glyph and "에이전트"), and how a file named in it opens (the one
 * function that targets the 변경 사항 panel).
 */

import { bridge, type TerminalInfo, type WidgetMode } from '../desktop'
import { t } from '../i18n'
import { readCarry, writeCarry } from '../carry'

export type LensMode = 'chat' | 'terminal'

/**
 * Whether a session offers the 채팅 / 터미널 flip: only when main put the `chat` key on its terminal
 * (the feature on, a Claude Code session) and never in the widget. It works when the session was
 * launched with its hooks ('armed'); otherwise the reason it does not ('unarmed', 'version', 'starting').
 */
export function lensAvailability(term: TerminalInfo | undefined, mode: WidgetMode): { show: boolean; enabled: boolean; reason: null | 'unarmed' | 'version' | 'starting' | 'failed' } {
  const chat = term?.chat
  if (chat === undefined || mode === 'widget') return { show: false, enabled: false, reason: null }
  if (chat === 'armed') return { show: true, enabled: true, reason: null }
  return { show: true, enabled: false, reason: chat }
}

/** The view in effect: chat only when the session offers it, it works, and it was chosen */
export function effectiveMode(term: TerminalInfo | undefined, mode: WidgetMode, stored: LensMode): LensMode {
  const a = lensAvailability(term, mode)
  return a.show && a.enabled && stored === 'chat' ? 'chat' : 'terminal'
}

/** How many sessions' choices the carry keeps (the most recent) */
export const LENS_KEEP = 24

/** Each session's choice (session id -> chat / terminal); terminal when none */
export function readLensModes(): Record<string, LensMode> {
  const raw = readCarry().chatModes
  const out: Record<string, LensMode> = {}
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out
  for (const [k, v] of Object.entries(raw)) if (v === 'chat' || v === 'terminal') out[k] = v
  return out
}

/**
 * The one 채팅 / 터미널 choice for every session (the flip is the app's, not a session's).
 * Until it is chosen once: 채팅 when the most recent session's old choice was 채팅.
 */
export function readLensAll(): LensMode {
  const all = readCarry().chatModeAll
  if (all === 'chat' || all === 'terminal') return all
  const old = Object.values(readLensModes())
  return old.length && old[old.length - 1] === 'chat' ? 'chat' : 'terminal'
}
export function writeLensAll(m: LensMode): LensMode { writeCarry({ chatModeAll: m }); return m }

/** Keep a session's choice (it becomes the most recent; the oldest beyond LENS_KEEP go) */
export function writeLensMode(sessionId: string, m: LensMode): Record<string, LensMode> {
  const modes = readLensModes()
  delete modes[sessionId]
  modes[sessionId] = m
  const keys = Object.keys(modes)
  for (const k of keys.slice(0, Math.max(0, keys.length - LENS_KEEP))) delete modes[k]
  writeCarry({ chatModes: modes })
  return modes
}

/** sprite: the small icon (a turn's head); art: the large picture (the empty state) */
export interface ChatWho { picture: 'pokemon' | 'glyph'; sprite?: string; art?: string; name: string }

/** Who answers in the conversation: never a Pokémon picture or name in 업무 모드, nor while no Pokémon works the session */
export function chatWho(row: { name: string; sprite: string; art?: string; noPokemon?: boolean }, workMode: boolean): ChatWho {
  if (workMode || row.noPokemon) return { picture: 'glyph', name: t('에이전트') }
  return { picture: 'pokemon', sprite: row.sprite, ...(row.art ? { art: row.art } : {}), name: row.name || t('에이전트') }
}

/** A file named in the chat (a path chip, a diff's file): opened in the code editor at its line */
export function openFileFromChat(id: string, file: string, line?: number, col?: number): void {
  // from the chat: main opens it in the code editor, or shows it in its folder; it never runs it
  // (a terminal's Ctrl+click keeps its own way, unchanged). A UNC or device path is never sent
  // (markdown.ts isRemotePath; main refuses one too)
  if (/^[\\/]{2}/.test(file)) return
  bridge?.terminals.openPath(id, file, line, col, { from: 'chat' }).catch(() => {})
}

/** A link in the chat: opened by the app (main allows http and https only) */
export function openUrlFromChat(url: string): void {
  bridge?.terminals.openUrl(url).catch(() => {})
}

// ---- the focus: the conversation takes it only when the user just asked for it (a flip, a switch)

let focusAskedAt = 0
/** The user flipped to 채팅 or switched sessions: the chat view may take the focus once, soon */
export function askChatFocus(): void { focusAskedAt = Date.now() }
/** Taken once, within two seconds of the ask (a view drawn later on its own takes nothing) */
export function takeChatFocus(now = Date.now()): boolean {
  if (!focusAskedAt || now - focusAskedAt > 2000) return false
  focusAskedAt = 0
  return true
}

// ---- per-terminal page state, let go when the session goes (the chat modules register what they keep)

const forgetters = new Set<(id: string) => void>()
/** A chat module's per-terminal memory (scroll, open rows, sub-agent requests): called when the session goes */
export function onChatForget(fn: (id: string) => void): void { forgetters.add(fn) }
/** The session of terminal `id` is gone: every chat module lets go of what it kept for it */
export function forgetChatTerminal(id: string): void { for (const fn of forgetters) fn(id) }

