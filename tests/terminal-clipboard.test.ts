/**
 * The terminal's paste and copy keys (src/terminalClipboard.ts): one paste writes once.
 * Ctrl+V on Windows pasted twice: the app's own paste, and the browser's native paste event
 * (the key's default action, not stopped), which xterm pastes too. The fake browser below
 * runs that default action unless the key was prevented, as Chromium does.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { handleClipboardKey, type ClipboardIo } from '../src/terminalClipboard'
import { setPlatformForTest } from '../src/platform'

type Mods = { ctrl?: boolean; meta?: boolean; alt?: boolean; shift?: boolean }

function setup(clipboard: string, selection = '') {
  const writes: string[] = []
  let sel = selection
  const io: ClipboardIo = {
    hasSelection: () => sel !== '',
    getSelection: () => sel,
    clearSelection: () => { sel = '' },
    readText: async () => clipboard,
    writeText: async (t) => { clipboard = t },
    paste: (t) => writes.push(t),
    send: (d) => writes.push(d),
  }
  /** One keydown through the terminal's handler, then the browser's default (a native paste xterm takes) */
  const press = async (key: string, code: string, m: Mods = {}) => {
    let prevented = false
    const e = {
      key, code, ctrlKey: !!m.ctrl, metaKey: !!m.meta, altKey: !!m.alt, shiftKey: !!m.shift,
      preventDefault: () => { prevented = true },
    }
    handleClipboardKey(e, io)
    const nativePaste = !prevented && ((code === 'KeyV' && (m.ctrl || m.meta)) || (code === 'Insert' && m.shift))
    if (nativePaste) io.paste(clipboard) // (an empty clipboard too: xterm writes the empty text)
    await new Promise(r => setTimeout(r, 0))
  }
  return { writes, press, clip: () => clipboard }
}

afterEach(() => setPlatformForTest(null))

describe('terminal paste writes once', () => {
  it('Windows Ctrl+V: the text once, the native paste stopped', async () => {
    setPlatformForTest('win')
    const t = setup('hello')
    await t.press('v', 'KeyV', { ctrl: true })
    expect(t.writes).toEqual(['hello'])
  })

  it('Windows Ctrl+V on a Korean layout and with Caps Lock', async () => {
    setPlatformForTest('win')
    const t = setup('hello')
    await t.press('V', 'KeyV', { ctrl: true })
    expect(t.writes).toEqual(['hello'])
  })

  it('Windows Ctrl+V with no text (a screenshot): only the ^V key', async () => {
    setPlatformForTest('win')
    const t = setup('')
    await t.press('v', 'KeyV', { ctrl: true })
    expect(t.writes).toEqual(['\x16'])
  })

  it('Windows Ctrl+Shift+V and Shift+Insert: the browser pastes, once', async () => {
    setPlatformForTest('win')
    const t = setup('hello')
    await t.press('V', 'KeyV', { ctrl: true, shift: true })
    await t.press('Insert', 'Insert', { shift: true })
    expect(t.writes).toEqual(['hello', 'hello'])
  })

  it('macOS ⌘V: the text once', async () => {
    setPlatformForTest('mac')
    const t = setup('hello')
    await t.press('v', 'KeyV', { meta: true })
    expect(t.writes).toEqual(['hello'])
  })

  it('Ctrl+C with a selection copies it and stops the native copy; without one it is left alone', async () => {
    setPlatformForTest('win')
    const t = setup('', 'picked')
    await t.press('c', 'KeyC', { ctrl: true })
    expect(t.clip()).toBe('picked')
    expect(t.writes).toEqual([])
    let prevented = false
    const taken = handleClipboardKey({ key: 'c', code: 'KeyC', ctrlKey: true, metaKey: false, altKey: false, shiftKey: false, preventDefault: () => { prevented = true } }, {
      hasSelection: () => false, getSelection: () => '', clearSelection() {}, readText: async () => '', writeText: async () => {}, paste() {}, send() {},
    })
    expect([taken, prevented]).toEqual([false, false])
  })
})
