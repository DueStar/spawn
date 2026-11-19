/**
 * What a key does in the chat composer, as a pure decision the composer's
 * onKeyDown acts on. While an IME composes (Korean, Japanese, Chinese: the browser's
 * `isComposing`, `keyCode 229`, or between compositionstart and compositionend) every key
 * belongs to the IME: Enter never sends half a syllable, Esc never stops the work,
 * Backspace never deletes anything but the syllable. Nothing here is a global shortcut.
 */

export interface KeyLike {
  key: string
  code?: string
  shiftKey: boolean
  ctrlKey: boolean
  metaKey: boolean
  altKey: boolean
  isComposing?: boolean
  keyCode?: number
}

export interface KeyState {
  /** between compositionstart and compositionend (createImeTracker) */
  composing: boolean
  /** Claude works (멈추기 is offered) */
  working: boolean
  /** the @ menu is open */
  menuOpen: boolean
  /** a mention is being typed (its menu may still be loading): Esc closes it, never stops the work */
  mentionOpen?: boolean
  /** an image is shown large */
  lightbox: boolean
}

export type KeyAction = 'send' | 'stop' | 'menu-up' | 'menu-down' | 'menu-pick' | 'menu-close' | 'lightbox-close' | null

const plain = (e: KeyLike) => !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey

export function keyAction(e: KeyLike, s: KeyState): KeyAction {
  if (s.composing || e.isComposing === true || e.keyCode === 229) return null
  if (s.lightbox) return e.key === 'Escape' ? 'lightbox-close' : null
  if (s.menuOpen && plain(e)) {
    if (e.key === 'ArrowUp') return 'menu-up'
    if (e.key === 'ArrowDown') return 'menu-down'
    if (e.key === 'Enter' || e.key === 'Tab') return 'menu-pick'
    if (e.key === 'Escape') return 'menu-close'
  }
  if (e.key === 'Enter') return plain(e) ? 'send' : null
  if (e.key === 'Escape' && s.mentionOpen) return plain(e) ? 'menu-close' : null
  if (e.key === 'Escape') return s.working && plain(e) ? 'stop' : null
  return null
}

/**
 * A key inside an answer card, heard only by the card's own onKeyDown (the focus is in the
 * card): the arrows move between its buttons. Nothing here answers: an answer is a click, or Enter /
 * Space on the focused button itself (the button's own behaviour). No digit shortcut, no global key.
 */
export function cardKey(e: KeyLike, composing: boolean): 'next' | 'prev' | null {
  if (composing || e.isComposing === true || e.keyCode === 229 || !plain(e)) return null
  if (e.key === 'ArrowRight' || e.key === 'ArrowDown') return 'next'
  if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') return 'prev'
  return null
}

/** compositionstart / compositionend / blur: whether an IME composes now (losing the focus ends it) */
export function createImeTracker() {
  let on = false
  return {
    start() { on = true },
    end() { on = false },
    blur() { on = false },
    composing() { return on },
  }
}

/**
 * The @ mention being typed at the caret: an @ at the start or after whitespace, the letters
 * after it up to the caret (no whitespace, no second @); null otherwise
 */
export function mentionAt(value: string, caret: number): { start: number; query: string } | null {
  let i = caret
  while (i > 0 && !/\s/.test(value[i - 1])) i--
  const token = value.slice(i, caret)
  if (!token.startsWith('@') || token.indexOf('@', 1) >= 0) return null
  return { start: i, query: token.slice(1) }
}
