/**
 * The terminal's copy and paste keys (src/keys.ts clipboardAction), done once.
 *
 * A key the terminal takes here must also lose its default action, on every platform: on
 * Windows the browser's own Ctrl+V fires a native paste event on xterm's textarea, and xterm
 * pastes that too, so each Ctrl+V wrote the text twice (and an empty paste before the ^V of
 * a screenshot). On macOS the Edit menu would paste or copy the same key again.
 */

import { clipboardAction } from './keys'

type Key = Pick<KeyboardEvent, 'key' | 'code' | 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey' | 'preventDefault'>

export interface ClipboardIo {
  hasSelection(): boolean
  getSelection(): string
  clearSelection(): void
  readText(): Promise<string>
  writeText(text: string): Promise<void>
  /** Text into the terminal as a paste (xterm.paste: bracketed when the program asked) */
  paste(text: string): void
  /** Bytes straight to the session */
  send(data: string): void
}

/** Ctrl+V with no text on the clipboard (a screenshot): the key itself, Claude Code reads the image */
const CTRL_V = '\x16'

/** True when the key was copy or paste and is done (the terminal must not handle it) */
export function handleClipboardKey(e: Key, io: ClipboardIo): boolean {
  const clip = clipboardAction(e, io.hasSelection())
  if (!clip) return false
  e.preventDefault()
  if (clip === 'paste') {
    io.readText()
      .then((t) => { if (t) io.paste(t); else io.send(CTRL_V) })
      .catch(() => io.send(CTRL_V))
  } else {
    io.writeText(io.getSelection()).catch(() => {})
    io.clearSelection()
  }
  return true
}
